// The event-sourced spine, in memory. `append` is the ONLY mutation path: it
// seals a draft into the log (seq, checksum, hash chain) and folds it into the
// projection, so the log and the materialized state can never disagree. The log
// is a plain seq-ordered array; the projection lives in Maps. Persistence is the
// portable JSON bundle (export/import) -- there is no database. Everything else
// here is read, replay, snapshot, recovery, integrity.

import {
  GENESIS_HASH,
  eventChecksum,
  eventHash,
  sha256,
} from "./hash.js";
import { IdGen } from "./ids.js";

export class Store {
  constructor(opts = {}) {
    this.now = opts.now ?? (() => Date.now());
    this.ids = opts.ids ?? new IdGen({ now: opts.now, rand: opts.rand });
    this.events = [];
    this.headSeq = 0;
    this.headHashValue = GENESIS_HASH;
    // Projection (a pure fold of the log).
    this.nodes = new Map();
    this.edges = new Map();
    this.zones = new Map();
    this.zoneMembers = new Map(); // zone -> Set<node>
    this.cursorSet = new Set();
    this.metaMap = new Map(); // cfg:* and other meta keys
    this.snapshots = new Map(); // id -> { seq, ts, data }
    this.checkpoints = new Map(); // name -> { seq, snapshotId, createdSeq }
  }

  // ---- head tracking ----------------------------------------------------

  lastSeq() {
    return this.headSeq;
  }
  headHash() {
    return this.headHashValue;
  }

  // ---- append (the only mutation path) ---------------------------------

  appendInternal(draft) {
    const seq = this.headSeq + 1;
    const ts = this.now();
    const id = this.ids.next("E");
    const checksum = eventChecksum(seq, draft.type, ts, draft.payload);
    const prevHash = this.headHashValue;
    const hash = eventHash(checksum, prevHash);
    const ev = { seq, id, type: draft.type, ts, payload: draft.payload, checksum, prevHash, hash };
    this.events.push(ev);
    this.applyEvent(ev);
    this.headSeq = seq;
    this.headHashValue = hash;
    return ev;
  }

  append(draft) {
    return this.appendInternal(draft);
  }

  /**
   * Append several drafts atomically; on any failure NONE are applied. With no
   * database transaction to lean on, we save the log length + head, and on a
   * throw truncate the log back and rebuild the projection as a pure fold from
   * the restored log -- an exact restore.
   */
  appendMany(drafts) {
    const savedLen = this.events.length;
    const savedHeadSeq = this.headSeq;
    const savedHeadHash = this.headHashValue;
    const out = [];
    try {
      for (const d of drafts) out.push(this.appendInternal(d));
      return out;
    } catch (e) {
      this.events.length = savedLen;
      this.headSeq = savedHeadSeq;
      this.headHashValue = savedHeadHash;
      this.rebuild();
      throw e;
    }
  }

  // ---- read ------------------------------------------------------------

  getEvent(seq) {
    return this.events.find((e) => e.seq === seq) ?? null;
  }

  readEvents(opts = {}) {
    const from = opts.fromSeq ?? 0;
    const to = opts.toSeq ?? Number.MAX_SAFE_INTEGER;
    let rows = this.events.filter((e) => e.seq >= from && e.seq <= to);
    if (opts.type) rows = rows.filter((e) => e.type === opts.type);
    // `limit` bounds the result to the most recent N events, returned in
    // chronological order. Keeps tail reads (recentTransitions/cleanStreak)
    // bounded instead of scanning the whole log.
    if (opts.limit != null && opts.limit >= 0) rows = rows.slice(-opts.limit);
    return rows.map(cloneEvent);
  }

  // ---- projection: apply one event -------------------------------------

  applyEvent(ev) {
    const p = ev.payload;
    switch (ev.type) {
      case "NodeUpserted":
        this.pNodeUpsert(p, ev.seq);
        break;
      case "NodeStatusChanged": {
        const n = this.nodes.get(p.id);
        if (n) { n.status = p.status; n.updatedSeq = ev.seq; }
        break;
      }
      case "EdgeUpserted":
        this.pEdgeUpsert(p, ev.seq);
        break;
      case "EdgeRemoved":
        this.edges.delete(p.id);
        break;
      case "ZoneDefined":
        this.pZoneDefine(p, ev.seq);
        break;
      case "ZoneMembership": {
        if (!this.zoneMembers.has(p.zone)) this.zoneMembers.set(p.zone, new Set());
        if (p.op === "add") this.zoneMembers.get(p.zone).add(p.node);
        else this.zoneMembers.get(p.zone).delete(p.node);
        break;
      }
      case "EnforcementChanged": {
        if (p.scope === "edge") { const e = this.edges.get(p.id); if (e) e.enforcement = p.mode; }
        else if (p.scope === "zone-intra") { const z = this.zones.get(p.id); if (z) z.intra = p.mode; }
        else if (p.scope === "zone-boundary") { const z = this.zones.get(p.id); if (z) z.boundary = p.mode; }
        break;
      }
      case "CursorMoved":
        this.cursorSet = new Set(p.set);
        break;
      case "TransitionTaken":
        if (p.from != null) this.cursorSet.delete(p.from);
        this.cursorSet.add(p.to);
        break;
      case "ConfigSet":
        this.metaMap.set("cfg:" + p.key, p.value);
        break;
      case "CheckpointCreated":
        this.checkpoints.set(p.name, { seq: p.seq, snapshotId: p.snapshotId, createdSeq: ev.seq });
        break;
      case "BlockedAttempt":
      case "SoftViolation":
      case "Migrated":
      case "SnapshotTaken":
        // Audit-only events: no projection effect.
        break;
    }
  }

  pNodeUpsert(p, seq) {
    const existing = this.nodes.get(p.id);
    const version = existing ? existing.version + 1 : 1;
    const createdSeq = existing ? existing.createdSeq : seq;
    this.nodes.set(p.id, {
      id: p.id,
      kind: p.kind,
      label: p.label,
      payload: p.payload ?? {},
      tags: p.tags ?? [],
      status: p.status ?? "active",
      version,
      createdSeq,
      updatedSeq: seq,
    });
  }

  pEdgeUpsert(p, seq) {
    const existing = this.edges.get(p.id);
    const version = existing ? existing.version + 1 : 1;
    const createdSeq = existing ? existing.createdSeq : seq;
    this.edges.set(p.id, {
      id: p.id,
      src: p.src,
      dst: p.dst,
      kind: p.kind,
      label: p.label ?? "",
      guard: p.guard ?? null,
      enforcement: p.enforcement ?? null,
      weight: p.weight ?? 1,
      version,
      createdSeq,
    });
  }

  pZoneDefine(p, seq) {
    const existing = this.zones.get(p.name);
    this.zones.set(p.name, {
      name: p.name,
      intra: p.intra ?? "soft",
      boundary: p.boundary ?? "hard",
      createdSeq: existing ? existing.createdSeq : seq,
    });
    this.zoneMembers.set(p.name, new Set(p.members ?? []));
  }

  // ---- replay / rebuild ------------------------------------------------

  clearProjection() {
    // Only the projection (a pure fold of the log) is cleared. Snapshots and
    // checkpoints are durable side tables, not projection -- a rollback trims the
    // log past a CheckpointCreated event but the checkpoint itself must survive
    // so it can be rolled back to again.
    this.nodes.clear();
    this.edges.clear();
    this.zones.clear();
    this.zoneMembers.clear();
    this.cursorSet = new Set();
    this.metaMap.clear();
  }

  /** Full rebuild from the entire log. Projection is a pure fold of events. */
  rebuild() {
    this.clearProjection();
    for (const ev of this.events) this.applyEvent(ev);
  }

  // ---- snapshot --------------------------------------------------------

  /** Capture the projection at the current head into the in-memory snapshot map. */
  snapshot() {
    const id = this.ids.next("S");
    const data = this.serializeProjection();
    this.snapshots.set(id, { seq: this.headSeq, ts: this.now(), data });
    this.append({ type: "SnapshotTaken", payload: { snapshotId: id, seq: this.headSeq } });
    return id;
  }

  serializeProjection() {
    return {
      nodes: [...this.nodes.values()].map(cloneJson),
      edges: [...this.edges.values()].map(cloneJson),
      zones: [...this.zones.values()].map(cloneJson),
      zoneMembers: [...this.zoneMembers.entries()].map(([zone, set]) => ({ zone, nodes: [...set] })),
      cursor: [...this.cursorSet],
      meta: [...this.metaMap.entries()].map(([key, value]) => ({ key, value })),
    };
  }

  loadSnapshot(id) {
    const snap = this.snapshots.get(id);
    if (!snap) return null;
    const data = snap.data;
    this.clearProjection();
    for (const n of data.nodes ?? []) this.nodes.set(n.id, cloneJson(n));
    for (const e of data.edges ?? []) this.edges.set(e.id, cloneJson(e));
    for (const z of data.zones ?? []) this.zones.set(z.name, cloneJson(z));
    for (const zm of data.zoneMembers ?? []) this.zoneMembers.set(zm.zone, new Set(zm.nodes));
    this.cursorSet = new Set(data.cursor ?? []);
    for (const m of data.meta ?? []) this.metaMap.set(m.key, m.value);
    return { seq: snap.seq };
  }

  latestSnapshotId() {
    let best = null;
    let bestSeq = -1;
    for (const [id, s] of this.snapshots) {
      if (s.seq > bestSeq || (s.seq === bestSeq && (best == null || id > best))) { best = id; bestSeq = s.seq; }
    }
    return best;
  }

  snapshotSeq(id) {
    const s = this.snapshots.get(id);
    return s ? s.seq : null;
  }

  // ---- recovery --------------------------------------------------------

  /**
   * Boot recovery. Verify the hash chain; if a break is found (a corrupted or
   * torn trailing write loaded from the JSON bundle) trim the log to the last
   * good seq. Then load the newest snapshot at/under that seq and replay the
   * tail. Returns the recovery report.
   */
  recover() {
    const integrity = this.verifyIntegrity();
    let trimmed = 0;
    if (!integrity.ok && integrity.firstBreakSeq != null) {
      const cut = integrity.firstBreakSeq - 1;
      const before = this.events.length;
      this.events = this.events.filter((e) => e.seq <= cut);
      trimmed = before - this.events.length;
      this.loadHeadFromLog();
    }
    let replayFrom = 1;
    let snapshotId = null;
    let snapSeq = -1;
    for (const [id, s] of this.snapshots) {
      if (s.seq <= this.headSeq && s.seq > snapSeq) { snapSeq = s.seq; snapshotId = id; }
    }
    if (snapshotId) {
      this.loadSnapshot(snapshotId);
      replayFrom = snapSeq + 1;
    } else {
      this.clearProjection();
    }
    for (const ev of this.events) if (ev.seq >= replayFrom) this.applyEvent(ev);
    return { lastGoodSeq: this.headSeq, trimmed, replayedFrom: replayFrom, snapshotId };
  }

  loadHeadFromLog() {
    if (this.events.length === 0) {
      this.headSeq = 0;
      this.headHashValue = GENESIS_HASH;
    } else {
      const last = this.events[this.events.length - 1];
      this.headSeq = last.seq;
      this.headHashValue = last.hash;
    }
  }

  /** Discard events after `seq` (used by rollback). Caller rebuilds projection. */
  truncateAfter(seq) {
    const before = this.events.length;
    this.events = this.events.filter((e) => e.seq <= seq);
    this.loadHeadFromLog();
    return before - this.events.length;
  }

  // ---- compaction ------------------------------------------------------

  /**
   * Snapshot, then prune events strictly before the snapshot seq minus the
   * retention window. Bounds replay cost while keeping `retain` recent events
   * for audit. The SnapshotTaken pointer is always kept so recovery can anchor.
   */
  compact(retain = 0) {
    const snapshotId = this.snapshot();
    const snapSeq = this.headSeq; // SnapshotTaken bumped head; snapshot captured prior state
    const cutoff = Math.max(0, snapSeq - retain - 1);
    const before = this.events.length;
    this.events = this.events.filter((e) => !(e.seq <= cutoff && e.type !== "SnapshotTaken"));
    return { snapshotId, pruned: before - this.events.length };
  }

  // ---- integrity -------------------------------------------------------

  verifyIntegrity() {
    let prevHash = GENESIS_HASH;
    let checked = 0;
    // Anchor on the first retained event. An uncompacted log starts at seq 1 and
    // its prev_hash must be GENESIS; a compacted log legitimately starts mid-chain
    // (the prefix was pruned under a snapshot), so we trust its stored prevHash as
    // the anchor and verify continuity from there -- tampering within the retained
    // tail is still fully caught.
    let expectedSeq = null;
    for (const ev of this.events) {
      checked++;
      if (expectedSeq === null) {
        expectedSeq = ev.seq;
        if (ev.seq !== 1) prevHash = ev.prevHash;
      }
      if (ev.seq !== expectedSeq) {
        return { ok: false, checkedEvents: checked, firstBreakSeq: ev.seq, detail: `seq gap: expected ${expectedSeq}, got ${ev.seq}` };
      }
      expectedSeq++;
      const checksum = eventChecksum(ev.seq, ev.type, ev.ts, ev.payload);
      if (checksum !== ev.checksum) {
        return { ok: false, checkedEvents: checked, firstBreakSeq: ev.seq, detail: `checksum mismatch at seq ${ev.seq}` };
      }
      if (ev.prevHash !== prevHash) {
        return { ok: false, checkedEvents: checked, firstBreakSeq: ev.seq, detail: `prev_hash mismatch at seq ${ev.seq}` };
      }
      const hash = eventHash(checksum, prevHash);
      if (hash !== ev.hash) {
        return { ok: false, checkedEvents: checked, firstBreakSeq: ev.seq, detail: `hash mismatch at seq ${ev.seq}` };
      }
      prevHash = ev.hash;
    }
    return { ok: true, checkedEvents: checked, firstBreakSeq: null, detail: null };
  }

  // ---- config (cfg:* meta) --------------------------------------------

  getConfig(key) {
    const v = this.metaMap.get("cfg:" + key);
    return v === undefined ? undefined : v;
  }

  // ---- row readers -----------------------------------------------------

  getNode(id) {
    const n = this.nodes.get(id);
    return n ? cloneNode(n) : null;
  }
  /** Cheap status probe for hot paths. */
  nodeStatus(id) {
    const n = this.nodes.get(id);
    return n ? n.status : null;
  }
  allNodes() {
    return [...this.nodes.values()].map(cloneNode);
  }
  getEdge(id) {
    const e = this.edges.get(id);
    return e ? cloneEdge(e) : null;
  }
  allEdges() {
    return [...this.edges.values()].map(cloneEdge);
  }
  outEdges(src, kind) {
    const out = [];
    for (const e of this.edges.values()) {
      if (e.src !== src) continue;
      if (kind && e.kind !== kind) continue;
      out.push(cloneEdge(e));
    }
    return out;
  }
  inEdges(dst, kind) {
    const out = [];
    for (const e of this.edges.values()) {
      if (e.dst !== dst) continue;
      if (kind && e.kind !== kind) continue;
      out.push(cloneEdge(e));
    }
    return out;
  }
  getZone(name) {
    const z = this.zones.get(name);
    if (!z) return null;
    const members = [...(this.zoneMembers.get(name) ?? new Set())];
    return { name: z.name, intra: z.intra, boundary: z.boundary, members, createdSeq: z.createdSeq };
  }
  allZones() {
    return [...this.zones.keys()].map((name) => this.getZone(name)).filter(Boolean);
  }
  zonesOf(node) {
    const out = [];
    for (const [zone, set] of this.zoneMembers) if (set.has(node)) out.push(zone);
    return out;
  }
  allZoneMembers() {
    const out = [];
    for (const [zone, set] of this.zoneMembers) for (const node of set) out.push({ zone, node });
    return out;
  }
  cursor() {
    return [...this.cursorSet];
  }

  close() {
    // No resource to release; in-memory store. Persistence is handled by the
    // caller (DState.close writes the export bundle to disk).
  }
}

// ---- helpers ------------------------------------------------------------

function cloneEvent(e) {
  return { seq: e.seq, id: e.id, type: e.type, ts: e.ts, payload: cloneJson(e.payload), checksum: e.checksum, prevHash: e.prevHash, hash: e.hash };
}
function cloneNode(n) {
  return { id: n.id, kind: n.kind, label: n.label, payload: cloneJson(n.payload), tags: [...n.tags], status: n.status, version: n.version, createdSeq: n.createdSeq, updatedSeq: n.updatedSeq };
}
function cloneEdge(e) {
  return { id: e.id, src: e.src, dst: e.dst, kind: e.kind, label: e.label, guard: e.guard, enforcement: e.enforcement, weight: e.weight, version: e.version, createdSeq: e.createdSeq };
}
function cloneJson(v) {
  return v == null ? v : JSON.parse(JSON.stringify(v));
}

export { sha256 };
