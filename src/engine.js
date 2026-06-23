// DState: the single object the agent (the only LLM in the loop) interacts with.
// It composes the in-memory store, graph, zones, and enforcement into one
// synchronous, Result-returning surface. The graph it builds IS its memory
// (node payloads) and its policy (guards + enforcement + zones) at once, and it
// can keep evolving that graph while it works. Evolve/validate/checkpoint/render/
// history live in sibling modules to keep this spine flat; they operate on this
// same instance. Persistence is a portable JSON bundle on disk, loaded on open
// and written on close/save -- there is no database and no learning.

import { existsSync, readFileSync, writeFileSync, renameSync, openSync, closeSync, unlinkSync, writeSync } from "node:fs";
import { Store } from "./store.js";
import { IdGen, isValidId } from "./ids.js";
import { ok, fail, DStateError } from "./errors.js";
import { DEFAULT_TUNABLES, validateTunable } from "./config.js";
import { compileGuard, evalGuard } from "./guard.js";
import { crossingInfo, boundaryMode, intraMode } from "./zone.js";
import { decide } from "./enforce.js";
import { dependencyCycle, readyFrontier, topoSort, reachable, ancestors, descendants, depAdjacency, hasPath } from "./graph.js";
import { validate } from "./validate.js";
import { history } from "./history.js";

export class DState {
  constructor(filename, opts) {
    this.filename = filename;
    this.store = new Store(opts);
    this.ids = this.store.ids;
    this.guardCache = new Map();
    this.tunablesCache = null;
    this.zoneMapCache = null;
    this.opCount = 0;
    this.lockPath = null;
    this.now = opts.now ?? (() => Date.now());
    this.rand = opts.rand ?? Math.random;
  }

  /**
   * Open (or create) a store. `filename` is a JSON bundle path (':memory:' for
   * ephemeral). If the file exists and load !== false, its events are replayed
   * into the store; recovery then trims any torn trailing write. Optionally lock
   * and seed.
   */
  static open(filename = ":memory:", opts = {}) {
    const onDisk = filename !== ":memory:";
    if (onDisk && opts.lock !== false) {
      const lockPath = filename + ".lock";
      if (existsSync(lockPath)) {
        throw new DStateError("LockHeld", `another writer holds ${lockPath}`);
      }
    }
    const ds = new DState(filename, opts);
    if (onDisk && opts.load !== false && existsSync(filename)) {
      let bundle;
      try {
        bundle = JSON.parse(readFileSync(filename, "utf8"));
      } catch (e) {
        throw new DStateError("IntegrityBroken", `cannot parse store file ${filename}: ${e.message}`);
      }
      if (bundle && Array.isArray(bundle.events)) {
        for (const e of bundle.events) ds.store.appendInternal({ type: e.type, payload: e.payload });
      }
    }
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

  /**
   * Persist the full history to the JSON file atomically (temp + rename), so a
   * crash mid-write never corrupts the store. On-disk durability is snapshot-on-
   * save, not per-append: events since the last save are lost if the process
   * dies before save()/close().
   */
  save() {
    if (this.filename === ":memory:") return;
    const bundle = {
      schema_version: 2,
      events: this.store.readEvents().filter((e) => e.type !== "SnapshotTaken" && e.type !== "CheckpointCreated").map((e) => ({ type: e.type, payload: e.payload })),
    };
    const tmp = this.filename + ".tmp";
    writeFileSync(tmp, JSON.stringify(bundle));
    renameSync(tmp, this.filename);
  }

  close() {
    this.save();
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

  /**
   * Query nodes by exact field (id/kind/status/tag) and/or a case-insensitive
   * substring over label+payload (`text`). A plain in-memory filter -- not a
   * search engine, not ranked, no vectors.
   */
  recall(query = {}) {
    const limit = Math.max(1, Math.min(query.limit ?? 50, 1000));
    if (query.id) {
      const n = this.store.getNode(query.id);
      return n ? [n] : [];
    }
    const text = query.text ? query.text.toLowerCase() : null;
    const out = [];
    for (const n of this.store.allNodes()) {
      if (query.kind && n.kind !== query.kind) continue;
      if (query.status && n.status !== query.status) continue;
      if (query.tag && !n.tags.includes(query.tag)) continue;
      if (text) {
        const hay = `${n.label} ${JSON.stringify(n.payload)}`.toLowerCase();
        if (!hay.includes(text)) continue;
      }
      out.push(n);
    }
    out.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    return out.slice(0, limit);
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
        hint: "check legalMoves() for reachable targets",
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
        hint: "check legalMoves() for reachable targets, or link() an edge first",
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
    this.tick();
    return ok({ applied: true, soft_warned: trace.decision === "warn", from, to, edgeId: edge.id, trace });
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
    return decide({
      guard: { present: guardPresent, passed: guardPassed, ...(edge.guard ? { expr: edge.guard } : {}) },
      crossing: ci.crossing,
      ...(ci.left[0] ? { zoneFrom: ci.left[0] } : {}),
      ...(ci.entered[0] ? { zoneTo: ci.entered[0] } : {}),
      edgeEnforcement: edge.enforcement,
      boundaryEnforcement: boundary,
      intraEnforcement: intra,
      globalDefault: cfg.defaultEnforcement,
    });
  }

  guardContext(edge, from, to, vars) {
    const fromNode = from ? this.store.getNode(from) : null;
    const toNode = this.store.getNode(to);
    return Object.freeze({
      from: fromNode?.payload ?? {},
      to: toNode.payload,
      fromTags: fromNode?.tags ?? [],
      toTags: toNode.tags,
      fromKind: fromNode?.kind ?? null,
      toKind: toNode.kind,
      edge: { label: edge.label, weight: edge.weight },
      vars: vars ?? {},
    });
  }

  // ---- compose ---------------------------------------------------------

  /**
   * Build a whole workflow in one atomic call from a declarative spec, closing
   * the gap between an agent's mental plan and the graph. The spec is validated
   * in full against a dry projection BEFORE anything is written; on the first
   * problem it returns a single Result fail naming the offending item by index,
   * and NOT ONE event is appended (all-or-nothing -- there is never a partial
   * graph). On success every node/edge/dependency/zone/cursor is committed.
   *
   * spec: {
   *   nodes:       [ id | { id, kind?, label?, payload?, tags?, status? } ],
   *   transitions: [ [from, to, opts?] | { from, to, ...opts } ],   // FSM edges
   *   deps:        [ [node, prereq] | { node, prereq } ],           // DAG edges
   *   zones:       [ { name, members, intra?, boundary? } ],        // optional
   *   cursor:      [ id, ... ],                                     // optional
   * }
   * An endpoint id is valid if it already exists OR is declared in spec.nodes,
   * so a plan can wire fresh and pre-existing nodes together in one shot. This
   * is the vendoring surface: an agent ships its own FSM as a plain JSON spec.
   * Returns Result<{ nodes, transitions, deps, zones, cursor }> of what was made.
   */
  plan(spec = {}) {
    const nodes = spec.nodes ?? [];
    const transitions = spec.transitions ?? [];
    const deps = spec.deps ?? [];
    const zones = spec.zones ?? [];
    const cursor = spec.cursor ?? null;
    if (!Array.isArray(nodes) || !Array.isArray(transitions) || !Array.isArray(deps) || !Array.isArray(zones))
      return fail("InvalidInput", "plan: nodes, transitions, deps, and zones must be arrays");

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

    // 3. deps: endpoints resolve, and the WHOLE batch stays acyclic.
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

    // 4. zones: name valid, members resolve.
    const normZones = [];
    for (let i = 0; i < zones.length; i++) {
      const z = zones[i];
      if (!isValidId(z?.name)) return fail("InvalidInput", `plan.zones[${i}]: invalid zone name '${z?.name}'`);
      const members = z.members ?? [];
      if (!Array.isArray(members)) return fail("InvalidInput", `plan.zones[${i}]: members must be an array`);
      for (const m of members) if (!exists(m)) return fail("NotFound", `plan.zones[${i}]: member '${m}' is neither pre-existing nor declared in spec.nodes`);
      normZones.push({ name: z.name, members, intra: z.intra, boundary: z.boundary });
    }

    // 5. cursor: every member resolves and will be active after creation.
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

    // 6. Commit. Every step was validated above, so none of these can fail.
    const created = { nodes: [], transitions: [], deps: [], zones: [], cursor: null };
    for (const [id, input] of planned) {
      this.remember(input);
      created.nodes.push(id);
    }
    for (const t of normTrans) created.transitions.push(this.link(t.from, t.to, t.opts).value.id);
    for (const d of normDeps) created.deps.push(this.depend(d.node, d.prereq).value.id);
    for (const z of normZones) { this.defineZone(z.name, z.members, { intra: z.intra, boundary: z.boundary }); created.zones.push(z.name); }
    if (cursor != null) {
      this.setCursor(cursor);
      created.cursor = cursor;
    }
    return ok(created);
  }

  /**
   * One structured situational snapshot for a cold or returning agent: where the
   * cursor is, the legal moves it should consider, which moves are blocked and
   * why, the dependency-ready frontier, integrity/violation status, the recent
   * log, and the live config -- everything needed to decide the next action in a
   * single read. Pure read; mutates nothing.
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
    // `done` = nodes already visited per the transition log (cursor history).
    const done = new Set();
    for (const e of this.store.readEvents({ type: "TransitionTaken" })) done.add(e.payload.to);
    const report = validate(this);
    const legal = this.legalMoves(vars);
    return {
      cursor,
      legalMoves: legal,
      blocked,
      ready: readyFrontier(this.store, done),
      violations: report.violations.length,
      integrity_ok: report.ok,
      recent: history(this, { limit: 5 }),
      seq: this.store.lastSeq(),
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

  /**
   * Seed a minimal starter FSM so the agent grows from a base. This is just the
   * default vendorable spec applied via plan(); an agent supplies its own spec
   * to replace it (see examples/fsm.spec.json).
   */
  bootstrap() {
    this.plan(DEFAULT_SPEC);
    this.invalidateCaches();
  }
}

/** The default FSM, expressed as a vendorable plan() spec. */
export const DEFAULT_SPEC = {
  nodes: [
    { id: "idle", label: "waiting for work", tags: ["seed"] },
    { id: "working", label: "executing a task", tags: ["seed"] },
    { id: "verifying", label: "checking the result", tags: ["seed"] },
    { id: "done", label: "task complete", tags: ["seed"] },
  ],
  transitions: [
    ["idle", "working"],
    ["working", "verifying"],
    ["verifying", "done"],
    ["verifying", "working"],
    ["done", "idle"],
  ],
  zones: [{ name: "safe", members: ["idle", "working", "verifying", "done"], intra: "off", boundary: "hard" }],
  cursor: ["idle"],
};
