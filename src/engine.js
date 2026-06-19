// DState: the single object the agent (the only LLM in the loop) interacts with.
// It composes the store, graph, zones, enforcement, and intuition into one
// synchronous, Result-returning surface. The graph it builds IS its memory
// (node payloads), its policy (guards + enforcement + zones) and its intuition
// (edge stats feeding suggest) at once, and it can keep evolving that graph while
// it works. Evolve/validate/checkpoint/render/history live in sibling modules to
// keep this spine flat; they operate on this same instance.

import { existsSync, openSync, closeSync, unlinkSync, writeSync } from "node:fs";
import { Store } from "./store.js";
import { IdGen, isValidId } from "./ids.js";
import { ok, fail, DStateError } from "./errors.js";
import { DEFAULT_TUNABLES, validateTunable } from "./config.js";
import { compileGuard, evalGuard } from "./guard.js";
import { crossingInfo, boundaryMode, intraMode } from "./zone.js";
import { decide } from "./enforce.js";
import { rank } from "./intuition.js";
import { dependencyCycle, readyFrontier, topoSort, reachable, ancestors, descendants, depAdjacency, hasPath } from "./graph.js";
import { validate } from "./validate.js";
import { history } from "./history.js";

export class DState {
  constructor(filename, opts) {
    this.store = new Store(filename, opts);
    this.ids = this.store.ids;
    this.guardCache = new Map();
    this.tunablesCache = null;
    this.zoneMapCache = null;
    this.opCount = 0;
    this.lockPath = null;
    this.now = opts.now ?? (() => Date.now());
    this.rand = opts.rand ?? Math.random;
  }

  /** Open (or create) a store, recover, optionally lock and seed. */
  static open(filename = ":memory:", opts = {}) {
    const onDisk = filename !== ":memory:";
    if (onDisk && opts.lock !== false) {
      const lockPath = filename + ".lock";
      if (existsSync(lockPath)) {
        throw new DStateError("LockHeld", `another writer holds ${lockPath}`);
      }
    }
    const ds = new DState(filename, opts);
    ds.store.recover();
    if (onDisk && opts.lock !== false) {
      const lockPath = filename + ".lock";
      const fd = openSync(lockPath, "wx");
      writeSync(fd, String(process.pid ?? 0));
      closeSync(fd);
      ds.lockPath = lockPath;
    }
    if (opts.seed !== false && ds.store.allNodes().length === 0 && ds.store.lastSeq() === 0) {
      ds.bootstrap();
    }
    return ds;
  }

  close() {
    this.store.close();
    if (this.lockPath && existsSync(this.lockPath)) {
      try {
        unlinkSync(this.lockPath);
      } catch {
        /* lock already gone */
      }
    }
  }

  // ---- config ----------------------------------------------------------

  getTunables() {
    if (this.tunablesCache) return this.tunablesCache;
    const out = { ...DEFAULT_TUNABLES };
    for (const key of Object.keys(DEFAULT_TUNABLES)) {
      const v = this.store.getConfig(key);
      if (v !== undefined) out[key] = v;
    }
    this.tunablesCache = out;
    return out;
  }

  setTunable(key, value) {
    const v = validateTunable(key, value);
    if (!v.ok) return v;
    this.store.append({ type: "ConfigSet", payload: { key, value } });
    this.tunablesCache = null;
    return ok(this.getTunables());
  }

  /** Cached zone map; invalidated on any zone mutation. */
  zoneMap() {
    if (!this.zoneMapCache) {
      this.zoneMapCache = new Map(this.store.allZones().map((z) => [z.name, z]));
    }
    return this.zoneMapCache;
  }
  invalidateZones() {
    this.zoneMapCache = null;
  }
  /** Drop all in-memory caches; call after a store-level rebuild (rollback/recover). */
  invalidateCaches() {
    this.tunablesCache = null;
    this.zoneMapCache = null;
    this.guardCache.clear();
  }

  // ---- memory ----------------------------------------------------------

  remember(input) {
    if (!isValidId(input.id)) return fail("InvalidInput", `invalid node id '${input.id}'`);
    const payload = input.payload ?? {};
    const size = JSON.stringify(payload).length;
    const max = this.getTunables().maxPayloadBytes;
    if (size > max) return fail("PayloadTooLarge", `payload ${size}B exceeds ${max}B`);
    const existing = this.store.getNode(input.id);
    if (input.expectVersion !== undefined && existing && existing.version !== input.expectVersion) {
      return fail("Conflict", `version mismatch: have ${existing.version}, expected ${input.expectVersion}`, {
        current: existing.version,
      });
    }
    this.store.append({
      type: "NodeUpserted",
      payload: {
        id: input.id,
        kind: input.kind ?? existing?.kind ?? "state",
        label: input.label ?? existing?.label ?? input.id,
        payload,
        tags: input.tags ?? existing?.tags ?? [],
        status: input.status ?? existing?.status ?? "active",
        embedding: input.embedding ?? existing?.embedding ?? null,
      },
    });
    this.tick();
    return ok(this.store.getNode(input.id));
  }

  getNode(id) {
    return this.store.getNode(id);
  }

  setStatus(id, status) {
    const node = this.store.getNode(id);
    if (!node) return fail("NotFound", `node ${id} not found`);
    this.store.append({ type: "NodeStatusChanged", payload: { id, status } });
    return ok(this.store.getNode(id));
  }
  archive(id) {
    return this.setStatus(id, "archived");
  }
  deprecate(id) {
    return this.setStatus(id, "deprecated");
  }

  recall(query = {}) {
    const db = this.store.db;
    const limit = Math.max(1, Math.min(query.limit ?? 50, 1000));
    if (query.id) {
      const n = this.store.getNode(query.id);
      return n ? [n] : [];
    }
    if (query.embedding) {
      // Similarity recall over nodes that carry an embedding. If none do, fall
      // through to text/structured recall -- the absence of an embedder degrades
      // silently rather than erroring.
      const q = query.embedding;
      const ranked = this.store
        .allNodes()
        .filter((n) => n.embedding && (!query.status || n.status === query.status) && (!query.kind || n.kind === query.kind))
        .map((n) => ({ n, score: cosine(q, n.embedding) }))
        .sort((a, b) => b.score - a.score)
        .slice(0, limit)
        .map((x) => x.n);
      if (ranked.length) return ranked;
    }
    if (query.text && this.store.ftsEnabled) {
      // Treat the whole query as a literal FTS5 phrase: wrap in double quotes and
      // double any embedded quote. This neutralizes every FTS operator char
      // (`;:*()-` etc.) so arbitrary agent text is a search, never a syntax error.
      const trimmed = query.text.trim();
      if (trimmed) {
        const phrase = `"${trimmed.replace(/"/g, '""')}"`;
        const rows = db
          .query(
            "SELECT f.id FROM nodes_fts f JOIN nodes n ON n.id = f.id WHERE nodes_fts MATCH ? " +
              (query.status ? "AND n.status = ? " : "") +
              "ORDER BY rank LIMIT ?",
          )
          .all(...(query.status ? [phrase, query.status, limit] : [phrase, limit]));
        return rows.map((r) => this.store.getNode(r.id)).filter(Boolean);
      }
    }
    const clauses = [];
    const params = [];
    if (query.kind) {
      clauses.push("kind = ?");
      params.push(query.kind);
    }
    if (query.status) {
      clauses.push("status = ?");
      params.push(query.status);
    }
    if (query.text) {
      clauses.push("(label LIKE ? OR payload LIKE ?)");
      const like = `%${query.text.replace(/[%_]/g, "")}%`;
      params.push(like, like);
    }
    if (query.tag) {
      // tags is a JSON array column; match the fully JSON-encoded element
      // (quotes included) so a tag containing quotes/backslashes still matches
      // exactly and "foo" does not match "foobar". Bound, so injection-safe.
      clauses.push("tags LIKE ? ESCAPE '\\'");
      const enc = JSON.stringify(query.tag).replace(/[%_\\]/g, "\\$&");
      params.push(`%${enc}%`);
    }
    const where = clauses.length ? "WHERE " + clauses.join(" AND ") : "";
    params.push(limit);
    const rows = db.query(`SELECT id FROM nodes ${where} ORDER BY id LIMIT ?`).all(...params);
    return rows.map((r) => this.store.getNode(r.id)).filter(Boolean);
  }

  // ---- edges -----------------------------------------------------------

  link(from, to, opts = {}) {
    if (!this.store.getNode(from)) return fail("NotFound", `source node ${from} not found`);
    if (!this.store.getNode(to)) return fail("NotFound", `target node ${to} not found`);
    const kind = opts.kind ?? "transition";
    if (opts.weight != null && (typeof opts.weight !== "number" || !Number.isFinite(opts.weight) || opts.weight < 0)) {
      return fail("InvalidInput", `edge weight must be a finite number >= 0, got ${opts.weight}`);
    }
    if (opts.guard != null) {
      const compiled = this.compile(opts.guard);
      if (!compiled.ok) return compiled;
    }
    if (kind === "dependency") {
      const cyc = dependencyCycle(this.store, from, to);
      if (cyc) return fail("CycleRejected", `dependency ${from}->${to} would create cycle: ${cyc.join(" -> ")}`, { cycle: cyc });
    }
    const id = opts.id ?? this.ids.next("G");
    if (opts.id && !isValidId(opts.id)) return fail("InvalidInput", `invalid edge id '${opts.id}'`);
    this.store.append({
      type: "EdgeUpserted",
      payload: {
        id,
        src: from,
        dst: to,
        kind,
        label: opts.label ?? "",
        guard: opts.guard ?? null,
        enforcement: opts.enforcement ?? null,
        weight: opts.weight ?? 1,
      },
    });
    this.tick();
    return ok(this.store.getEdge(id));
  }

  /** depend(node, prereq): node depends on prereq (prereq must precede node). */
  depend(node, prereq, opts = {}) {
    return this.link(prereq, node, { ...opts, kind: "dependency" });
  }

  unlink(edgeId) {
    if (!this.store.getEdge(edgeId)) return fail("NotFound", `edge ${edgeId} not found`);
    this.store.append({ type: "EdgeRemoved", payload: { id: edgeId } });
    return ok(true);
  }

  setEnforcement(edgeId, mode) {
    if (!this.store.getEdge(edgeId)) return fail("NotFound", `edge ${edgeId} not found`);
    this.store.append({ type: "EnforcementChanged", payload: { scope: "edge", id: edgeId, mode } });
    return ok(this.store.getEdge(edgeId));
  }

  // ---- dag -------------------------------------------------------------

  ready(done = []) {
    return readyFrontier(this.store, new Set(done));
  }
  topo() {
    return topoSort(this.store);
  }
  reachable(from, kind = "transition") {
    return [...reachable(this.store, from, kind)];
  }
  ancestors(of, kind = "dependency") {
    return [...ancestors(this.store, of, kind)];
  }
  descendants(of, kind = "dependency") {
    return [...descendants(this.store, of, kind)];
  }

  // ---- cursor / fsm ----------------------------------------------------

  cursor() {
    return this.store.cursor();
  }

  setCursor(nodes) {
    for (const n of nodes) {
      const node = this.store.getNode(n);
      if (!node) return fail("NotFound", `node ${n} not found`);
      if (node.status !== "active") return fail("IllegalTransition", `node ${n} is ${node.status}`);
    }
    this.store.append({ type: "CursorMoved", payload: { set: nodes } });
    return ok(nodes);
  }

  /** All non-denied transitions out of the current cursor. */
  legalMoves(vars = {}) {
    const out = [];
    for (const from of this.store.cursor()) {
      for (const edge of this.store.outEdges(from, "transition")) {
        if (this.store.nodeStatus(edge.dst) !== "active") continue;
        const trace = this.decideTransition(edge, from, edge.dst, vars);
        if (trace.decision !== "deny") {
          out.push({ edgeId: edge.id, to: edge.dst, from, decision: trace.decision, enforcement: trace.effectiveEnforcement });
        }
      }
    }
    return out;
  }

  /** Dry-run the decision for a transition to `to` without mutating. */
  explainTransition(to, vars = {}) {
    const found = this.findEdgeTo(to);
    if (!found)
      return fail("IllegalTransition", `no transition edge from cursor to ${to}`, {
        hint: "check legalMoves()/suggest() for reachable targets",
      });
    return ok(this.decideTransition(found.edge, found.from, to, vars));
  }

  transition(to, vars = {}) {
    const dstStatus = this.store.nodeStatus(to);
    if (dstStatus == null) return fail("NotFound", `target node ${to} not found`);
    if (dstStatus !== "active") return fail("IllegalTransition", `target ${to} is ${dstStatus}`);
    const found = this.findEdgeTo(to);
    if (!found)
      return fail("IllegalTransition", `no transition edge from cursor [${this.store.cursor().join(",")}] to ${to}`, {
        hint: "check legalMoves()/suggest() for reachable targets, or link() an edge first",
      });
    const { edge, from } = found;
    const trace = this.decideTransition(edge, from, to, vars);
    if (trace.decision === "deny") {
      this.store.append({ type: "BlockedAttempt", payload: { edgeId: edge.id, from, to, reason: trace.reasons.join("; ") } });
      return ok({ applied: false, soft_warned: false, from, to, edgeId: edge.id, trace });
    }
    const drafts = [];
    if (trace.decision === "warn") {
      drafts.push({ type: "SoftViolation", payload: { edgeId: edge.id, reason: trace.reasons.join("; ") } });
    }
    drafts.push({ type: "TransitionTaken", payload: { edgeId: edge.id, from, to, clean: trace.decision === "allow" } });
    this.store.appendMany(drafts);
    if (trace.escalation.promoted) {
      this.store.append({ type: "EnforcementChanged", payload: { scope: "edge", id: edge.id, mode: "hard" } });
    } else if (trace.decision === "allow" && edge.enforcement === "hard") {
      // Auto-demotion: a hard edge used cleanly demotionCleanRuns times in a row
      // relaxes back to soft, so a one-off rough patch does not harden forever.
      const cfg = this.getTunables();
      if (cfg.demotionCleanRuns > 0 && this.cleanStreak(edge.id) >= cfg.demotionCleanRuns) {
        this.store.append({ type: "EnforcementChanged", payload: { scope: "edge", id: edge.id, mode: "soft" } });
      }
    }
    this.tick();
    return ok({ applied: true, soft_warned: trace.decision === "warn", from, to, edgeId: edge.id, trace });
  }

  /**
   * Consecutive clean transitions on an edge since its last violation. Pages the
   * log backward in bounded windows (newest first) and stops the moment the
   * streak resolves -- a warned/blocked use of the edge, the threshold being
   * reached, or the log running out -- so a recently-violated or frequently-used
   * edge resolves in one window instead of scanning the whole log every call.
   */
  cleanStreak(edgeId) {
    const WINDOW = 256;
    const enough = this.getTunables().demotionCleanRuns; // caller only needs streak >= this
    let streak = 0;
    let hi = this.store.lastSeq();
    while (hi >= 1) {
      const evs = this.store.readEvents({ toSeq: hi, limit: WINDOW });
      if (evs.length === 0) break;
      for (let i = evs.length - 1; i >= 0; i--) {
        const e = evs[i];
        const p = e.payload;
        if (p.edgeId !== edgeId) continue;
        if (e.type === "TransitionTaken") {
          if (p.clean === true) streak++;
          else return streak; // a warned transition ends the clean run
        } else if (e.type === "BlockedAttempt") {
          return streak;
        }
      }
      if (enough > 0 && streak >= enough) return streak;
      hi = evs[0].seq - 1; // page further back
    }
    return streak;
  }

  findEdgeTo(to) {
    for (const from of this.store.cursor()) {
      const edge = this.store.outEdges(from, "transition").find((e) => e.dst === to);
      if (edge) return { edge, from };
    }
    return null;
  }

  decideTransition(edge, from, to, vars) {
    const cfg = this.getTunables();
    const guardPresent = edge.guard != null;
    let guardPassed = true;
    if (guardPresent) {
      const compiled = this.compile(edge.guard);
      if (!compiled.ok) {
        guardPassed = false; // unparseable guard fails closed
      } else {
        guardPassed = evalGuard(compiled.value, this.guardContext(edge, from, to, vars));
      }
    }
    const srcZones = from ? this.store.zonesOf(from) : [];
    const dstZones = this.store.zonesOf(to);
    const ci = crossingInfo(srcZones, dstZones);
    const zoneMap = this.zoneMap();
    const boundary = boundaryMode(zoneMap, [...ci.left, ...ci.entered]);
    const intra = intraMode(zoneMap, ci.shared);
    const stat = this.store.getStat("edge", edge.id);
    return decide({
      guard: { present: guardPresent, passed: guardPassed, ...(edge.guard ? { expr: edge.guard } : {}) },
      crossing: ci.crossing,
      ...(ci.left[0] ? { zoneFrom: ci.left[0] } : {}),
      ...(ci.entered[0] ? { zoneTo: ci.entered[0] } : {}),
      edgeEnforcement: edge.enforcement,
      boundaryEnforcement: boundary,
      intraEnforcement: intra,
      globalDefault: cfg.defaultEnforcement,
      softViolations: stat?.softViolations ?? 0,
      escalationThreshold: cfg.escalationThreshold,
    });
  }

  guardContext(edge, from, to, vars) {
    const fromNode = from ? this.store.getNode(from) : null;
    const toNode = this.store.getNode(to);
    const stat = this.store.getStat("edge", edge.id);
    return Object.freeze({
      from: fromNode?.payload ?? {},
      to: toNode.payload,
      fromTags: fromNode?.tags ?? [],
      toTags: toNode.tags,
      fromKind: fromNode?.kind ?? null,
      toKind: toNode.kind,
      edge: { label: edge.label, weight: edge.weight },
      stat: {
        visits: stat?.visits ?? 0,
        emaReward: stat?.emaReward ?? 0,
        successes: stat?.successes ?? 0,
        failures: stat?.failures ?? 0,
      },
      vars: vars ?? {},
    });
  }

  // ---- intuition -------------------------------------------------------

  suggest(vars = {}) {
    const moves = this.legalMoves(vars);
    const stats = moves.map((m) => ({
      edgeId: m.edgeId,
      to: m.to,
      weight: this.store.getEdge(m.edgeId)?.weight ?? 1,
      enforcement: m.enforcement,
      stat: this.store.getStat("edge", m.edgeId),
    }));
    return rank(stats, this.getTunables(), this.store.lastSeq(), this.rand);
  }

  reward(value, opts = {}) {
    const alpha = this.getTunables().rewardAlpha;
    const scopes = [];
    if (opts.edgeId) {
      if (!this.store.getEdge(opts.edgeId))
        return fail("NotFound", `edge ${opts.edgeId} not found`, { hint: "pass an existing edgeId, or omit it to reward the last transition" });
      scopes.push({ kind: "edge", id: opts.edgeId, weight: 1 });
    } else {
      const depth = opts.trace ? opts.depth ?? 5 : 1;
      const recent = this.recentTransitions(depth);
      if (recent.length === 0)
        return fail("NotFound", "no recent transition to reward", { hint: "call transition()/step() first, or pass an explicit edgeId" });
      const lambda = opts.lambda ?? 0.6;
      recent.forEach((t, i) => {
        const w = opts.trace ? Math.pow(lambda, i) : 1;
        scopes.push({ kind: "edge", id: t.edgeId, weight: w });
        scopes.push({ kind: "node", id: t.to, weight: w });
      });
    }
    this.store.append({ type: "RewardApplied", payload: { scopes, value, alpha } });
    return ok({ scopes: scopes.length });
  }

  recentTransitions(n) {
    // Tail-read only the last n TransitionTaken events (index-bounded), not the
    // whole log, so reward({trace}) stays O(n) regardless of session length.
    const evs = this.store.readEvents({ type: "TransitionTaken", limit: n });
    return evs
      .reverse()
      .map((e) => ({ edgeId: e.payload.edgeId, to: e.payload.to, from: e.payload.from ?? null }));
  }

  getStat(kind, id) {
    return this.store.getStat(kind, id);
  }

  /** Whether text recall uses FTS5 (true) or the LIKE fallback (false). */
  ftsEnabled() {
    return this.store.ftsEnabled;
  }

  /**
   * One-call agent loop: pick the top-ranked legal move (or `opts.to`), take it,
   * and -- if it applied and `opts.reward` was given -- reinforce that edge. The
   * tight suggest -> transition -> reward cycle in a single verb so an agent
   * advances its own state without hand-orchestrating three calls per tick.
   *
   * opts: { to?, vars?, reward? } -- `to` forces a target (else the suggestion
   * leader); `reward` is the value to apply on a successful move (omit to skip).
   * Returns Result<{ to, suggestion, applied, denied, soft_warned, outcome,
   * reward, done }>; `done` is true when no legal move remains afterward.
   */
  step(opts = {}) {
    const vars = opts.vars ?? {};
    if (this.store.cursor().length === 0)
      return fail("InvalidInput", "cursor is empty", { hint: "setCursor([...]) before stepping" });
    const ranked = this.suggest(vars);
    const suggestion = opts.to ? ranked.find((s) => s.to === opts.to) ?? null : ranked[0] ?? null;
    const target = opts.to ?? suggestion?.to;
    if (!target)
      return fail("NoMoves", "no legal move from the current cursor", {
        hint: "no enabled transition out of the cursor; link() a move, relax enforcement, or setCursor() elsewhere",
      });
    const res = this.transition(target, vars);
    if (!res.ok) return res;
    const outcome = res.value;
    let reward = null;
    if (outcome.applied && opts.reward != null) {
      const r = this.reward(opts.reward, { edgeId: outcome.edgeId });
      reward = r.ok ? r.value : null;
    }
    return ok({
      to: target,
      suggestion,
      applied: outcome.applied,
      denied: !outcome.applied,
      soft_warned: outcome.soft_warned,
      outcome,
      reward,
      done: this.legalMoves(vars).length === 0,
    });
  }

  // ---- compose ---------------------------------------------------------

  /**
   * Build a whole workflow in one atomic call from a declarative spec, closing
   * the gap between an agent's mental plan and the graph. The spec is validated
   * in full against a dry projection BEFORE anything is written; on the first
   * problem it returns a single Result fail naming the offending item by index,
   * and NOT ONE event is appended (all-or-nothing -- there is never a partial
   * graph). On success every node/edge/dependency/cursor is committed.
   *
   * spec: {
   *   nodes:       [ id | { id, kind?, label?, payload?, tags?, status? } ],
   *   transitions: [ [from, to, opts?] | { from, to, ...opts } ],   // FSM edges
   *   deps:        [ [node, prereq] | { node, prereq } ],           // DAG edges
   *   cursor:      [ id, ... ],                                     // optional
   * }
   * An endpoint id is valid if it already exists OR is declared in spec.nodes,
   * so a plan can wire fresh and pre-existing nodes together in one shot.
   * Returns Result<{ nodes, transitions, deps, cursor }> of what was created.
   */
  plan(spec = {}) {
    const nodes = spec.nodes ?? [];
    const transitions = spec.transitions ?? [];
    const deps = spec.deps ?? [];
    const cursor = spec.cursor ?? null;
    if (!Array.isArray(nodes) || !Array.isArray(transitions) || !Array.isArray(deps))
      return fail("InvalidInput", "plan: nodes, transitions, and deps must be arrays");

    // 1. nodes: id charset, in-spec uniqueness, payload size.
    const max = this.getTunables().maxPayloadBytes;
    const planned = new Map();
    for (let i = 0; i < nodes.length; i++) {
      const n = nodes[i];
      const input = typeof n === "string" ? { id: n } : n;
      const id = input?.id;
      if (!isValidId(id)) return fail("InvalidInput", `plan.nodes[${i}]: invalid node id '${id}'`);
      if (planned.has(id)) return fail("DuplicateId", `plan.nodes[${i}]: duplicate id '${id}' within the spec`);
      const payload = input.payload ?? {};
      if (JSON.stringify(payload).length > max) return fail("PayloadTooLarge", `plan.nodes[${i}] (${id}): payload exceeds ${max}B`);
      planned.set(id, input);
    }
    const exists = (id) => planned.has(id) || !!this.store.getNode(id);

    // 2. transitions: endpoints resolve, guard compiles, weight + id valid.
    const normTrans = [];
    for (let i = 0; i < transitions.length; i++) {
      const t = transitions[i];
      const from = Array.isArray(t) ? t[0] : t.from;
      const to = Array.isArray(t) ? t[1] : t.to;
      const opts = Array.isArray(t) ? t[2] ?? {} : t;
      if (!exists(from)) return fail("NotFound", `plan.transitions[${i}]: source '${from}' is neither pre-existing nor declared in spec.nodes`);
      if (!exists(to)) return fail("NotFound", `plan.transitions[${i}]: target '${to}' is neither pre-existing nor declared in spec.nodes`);
      if (opts.weight != null && (typeof opts.weight !== "number" || !Number.isFinite(opts.weight) || opts.weight < 0))
        return fail("InvalidInput", `plan.transitions[${i}]: weight must be a finite number >= 0, got ${opts.weight}`);
      if (opts.id != null && !isValidId(opts.id)) return fail("InvalidInput", `plan.transitions[${i}]: invalid edge id '${opts.id}'`);
      if (opts.guard != null) {
        const c = this.compile(opts.guard);
        if (!c.ok) return fail("GuardParseError", `plan.transitions[${i}]: ${c.error.message}`);
      }
      normTrans.push({ from, to, opts });
    }

    // 3. deps: endpoints resolve, and the WHOLE batch stays acyclic. Seed the
    // working adjacency with the committed dependency graph, then add each
    // proposed prereq->node edge only after checking node cannot already reach
    // prereq -- so a cycle closed by any edge in the batch is caught here.
    const depAdj = depAdjacency(this.store);
    const normDeps = [];
    for (let i = 0; i < deps.length; i++) {
      const d = deps[i];
      const node = Array.isArray(d) ? d[0] : d.node;
      const prereq = Array.isArray(d) ? d[1] : d.prereq;
      if (!exists(node)) return fail("NotFound", `plan.deps[${i}]: node '${node}' is neither pre-existing nor declared in spec.nodes`);
      if (!exists(prereq)) return fail("NotFound", `plan.deps[${i}]: prereq '${prereq}' is neither pre-existing nor declared in spec.nodes`);
      if (hasPath(depAdj, node, prereq))
        return fail("CycleRejected", `plan.deps[${i}]: dependency ${prereq}->${node} would create a cycle`, { edge: [prereq, node] });
      if (!depAdj.has(prereq)) depAdj.set(prereq, []);
      depAdj.get(prereq).push(node);
      normDeps.push({ node, prereq });
    }

    // 4. cursor: every member resolves and will be active after creation.
    if (cursor != null) {
      if (!Array.isArray(cursor)) return fail("InvalidInput", "plan.cursor must be an array of node ids");
      for (const id of cursor) {
        if (planned.has(id)) {
          const st = planned.get(id).status ?? "active";
          if (st !== "active") return fail("IllegalTransition", `plan.cursor: planned node '${id}' is ${st}`);
        } else {
          const n = this.store.getNode(id);
          if (!n) return fail("NotFound", `plan.cursor: node '${id}' not found`);
          if (n.status !== "active") return fail("IllegalTransition", `plan.cursor: node '${id}' is ${n.status}`);
        }
      }
    }

    // 5. Commit. Every step was validated above, so none of these can fail; a
    // dependency subset of an acyclic batch is itself acyclic, so each depend()
    // re-check passes. Nodes first, then edges that may reference them.
    const created = { nodes: [], transitions: [], deps: [], cursor: null };
    for (const [id, input] of planned) {
      this.remember(input);
      created.nodes.push(id);
    }
    for (const t of normTrans) created.transitions.push(this.link(t.from, t.to, t.opts).value.id);
    for (const d of normDeps) created.deps.push(this.depend(d.node, d.prereq).value.id);
    if (cursor != null) {
      this.setCursor(cursor);
      created.cursor = cursor;
    }
    return ok(created);
  }

  /**
   * One structured situational snapshot for a cold or returning agent: where the
   * cursor is, the ranked moves it should consider, which moves are blocked and
   * why, the dependency-ready frontier, integrity/violation status, the recent
   * log, and the live config -- everything needed to decide the next action in a
   * single read, without stitching together suggest/legalMoves/ready/validate/
   * history by hand. Pure read; mutates nothing.
   */
  orient(vars = {}) {
    const cursor = this.cursor();
    const blocked = [];
    for (const from of cursor) {
      for (const edge of this.store.outEdges(from, "transition")) {
        if (this.store.nodeStatus(edge.dst) !== "active") continue;
        const trace = this.decideTransition(edge, from, edge.dst, vars);
        if (trace.decision === "deny") blocked.push({ edgeId: edge.id, to: edge.dst, from, reasons: trace.reasons });
      }
    }
    const done = new Set(this.store.allNodes().filter((n) => (this.store.getStat("node", n.id)?.visits ?? 0) > 0).map((n) => n.id));
    const report = validate(this);
    const legal = this.legalMoves(vars);
    return {
      cursor,
      suggestions: this.suggest(vars),
      legalMoves: legal,
      blocked,
      ready: readyFrontier(this.store, done),
      violations: report.violations.length,
      integrity_ok: report.ok,
      recent: history(this, { limit: 5 }),
      seq: this.store.lastSeq(),
      ftsEnabled: this.store.ftsEnabled,
      tunables: this.getTunables(),
      done: legal.length === 0,
    };
  }

  // ---- zones -----------------------------------------------------------

  defineZone(name, members, opts = {}) {
    if (!isValidId(name)) return fail("InvalidInput", `invalid zone name '${name}'`);
    for (const m of members) if (!this.store.getNode(m)) return fail("NotFound", `zone member ${m} not found`);
    this.store.append({
      type: "ZoneDefined",
      payload: { name, members, intra: opts.intra ?? "soft", boundary: opts.boundary ?? "hard" },
    });
    this.invalidateZones();
    this.tick();
    return ok(this.store.getZone(name));
  }

  addToZone(name, node) {
    if (!this.store.getZone(name)) return fail("ZoneNotFound", `zone ${name} not found`);
    if (!this.store.getNode(node)) return fail("NotFound", `node ${node} not found`);
    this.store.append({ type: "ZoneMembership", payload: { zone: name, node, op: "add" } });
    this.invalidateZones();
    return ok(this.store.getZone(name));
  }
  removeFromZone(name, node) {
    if (!this.store.getZone(name)) return fail("ZoneNotFound", `zone ${name} not found`);
    this.store.append({ type: "ZoneMembership", payload: { zone: name, node, op: "remove" } });
    this.invalidateZones();
    return ok(this.store.getZone(name));
  }
  zonesOf(node) {
    return this.store.zonesOf(node);
  }
  zones() {
    return this.store.allZones();
  }

  /**
   * Propose a safe zone: BFS reachable from `seed` over transition edges,
   * keeping nodes whose payload satisfies `predicate` (guard DSL). Returns the
   * member set for the agent to ratify via defineZone; does not mutate.
   */
  deriveZone(seed, predicate) {
    if (!this.store.getNode(seed)) return fail("NotFound", `seed ${seed} not found`);
    let guard = null;
    if (predicate) {
      const c = this.compile(predicate);
      if (!c.ok) return c;
      guard = c.value;
    }
    const all = [seed, ...reachable(this.store, seed, "transition")];
    const members = all.filter((id) => {
      const node = this.store.getNode(id);
      if (!node || node.status !== "active") return false;
      if (!guard) return true;
      return evalGuard(guard, { payload: node.payload, tags: node.tags, kind: node.kind });
    });
    return ok({ members: [...new Set(members)].sort() });
  }

  // ---- helpers ---------------------------------------------------------

  compile(expr) {
    let cached = this.guardCache.get(expr);
    if (!cached) {
      cached = compileGuard(expr);
      this.guardCache.set(expr, cached);
    }
    return cached;
  }

  tick() {
    this.opCount++;
    const interval = this.getTunables().snapshotInterval;
    if (interval > 0 && this.opCount % interval === 0) {
      this.store.snapshot();
    }
  }

  // ---- bootstrap -------------------------------------------------------

  /** Seed a minimal starter self-model so the agent grows from a base. */
  bootstrap() {
    const states = [
      ["idle", "waiting for work"],
      ["working", "executing a task"],
      ["verifying", "checking the result"],
      ["done", "task complete"],
    ];
    for (const [id, label] of states) {
      this.store.append({ type: "NodeUpserted", payload: { id, kind: "state", label, payload: {}, tags: ["seed"], status: "active", embedding: null } });
    }
    const edges = [
      ["idle", "working"],
      ["working", "verifying"],
      ["verifying", "done"],
      ["verifying", "working"],
      ["done", "idle"],
    ];
    for (const [from, to] of edges) {
      this.store.append({ type: "EdgeUpserted", payload: { id: this.ids.next("G"), src: from, dst: to, kind: "transition", label: "", guard: null, enforcement: null, weight: 1 } });
    }
    this.store.append({ type: "ZoneDefined", payload: { name: "safe", members: ["idle", "working", "verifying", "done"], intra: "off", boundary: "hard" } });
    this.store.append({ type: "CursorMoved", payload: { set: ["idle"] } });
    this.invalidateCaches();
  }
}

function cosine(a, b) {
  const n = Math.min(a.length, b.length);
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < n; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom === 0 ? 0 : dot / denom;
}
