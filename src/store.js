// The event-sourced spine. `append` is the ONLY mutation path: it seals a draft
// into the log (seq, checksum, hash chain) and folds it into the projection in
// one transaction, so the log and the materialized tables can never disagree.
// Everything else here is read, replay, snapshot, recovery, integrity.

import { openDatabase } from "./db.js";
import { createSchema, PROJECTION_TABLES } from "./schema.js";
import {
  GENESIS_HASH,
  eventChecksum,
  eventHash,
  canonicalize,
  sha256,
} from "./hash.js";
import { IdGen } from "./ids.js";

// The only stat columns bumpCounter may target -- an allow-list so the
// interpolated identifier can never be attacker- or bug-supplied.
const STAT_COUNTER_COLS = new Set(["successes", "failures", "blocks", "soft_violations"]);

export class Store {
  constructor(filename, opts = {}) {
    const { db, ftsEnabled } = openDatabase(filename);
    this.db = db;
    this.ftsEnabled = ftsEnabled;
    this.now = opts.now ?? (() => Date.now());
    this.ids = opts.ids ?? new IdGen({ now: opts.now, rand: opts.rand });
    this.headSeq = 0;
    this.headHashValue = GENESIS_HASH;
    createSchema(db, ftsEnabled);
    this.loadHead();
  }

  // ---- head tracking ----------------------------------------------------

  loadHead() {
    const row = this.db
      .query("SELECT seq, hash FROM events ORDER BY seq DESC LIMIT 1")
      .get();
    if (row) {
      this.headSeq = row.seq;
      this.headHashValue = row.hash;
    } else {
      this.headSeq = 0;
      this.headHashValue = GENESIS_HASH;
    }
  }

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
    const ev = {
      seq,
      id,
      type: draft.type,
      ts,
      payload: draft.payload,
      checksum,
      prevHash,
      hash,
    };
    this.db.run(
      "INSERT INTO events(seq,id,type,ts,payload,checksum,prev_hash,hash) VALUES(?,?,?,?,?,?,?,?)",
      seq,
      id,
      ev.type,
      ts,
      canonicalize(ev.payload),
      checksum,
      prevHash,
      hash,
    );
    this.applyEvent(ev);
    this.headSeq = seq;
    this.headHashValue = hash;
    return ev;
  }

  append(draft) {
    let ev;
    const tx = this.db.transaction(() => {
      ev = this.appendInternal(draft);
    });
    tx();
    return ev;
  }

  /** Append several drafts atomically; on any failure none are applied. */
  appendMany(drafts) {
    const out = [];
    const tx = this.db.transaction(() => {
      for (const d of drafts) out.push(this.appendInternal(d));
    });
    tx();
    return out;
  }

  // ---- read ------------------------------------------------------------

  getEvent(seq) {
    const row = this.db
      .query("SELECT * FROM events WHERE seq = ?")
      .get(seq);
    return row ? this.rowToEvent(row) : null;
  }

  readEvents(opts = {}) {
    const from = opts.fromSeq ?? 0;
    const to = opts.toSeq ?? Number.MAX_SAFE_INTEGER;
    // `limit` bounds the scan to the most recent N events (ORDER BY seq DESC
    // LIMIT N), then re-sorts ascending so callers always get chronological
    // order. This keeps tail reads (recentTransitions/cleanStreak) O(N) on the
    // index instead of O(seq) over the whole log on long sessions. Without a
    // limit the behaviour is unchanged: the full range in ascending order.
    const limited = opts.limit != null && opts.limit >= 0;
    const order = limited ? "DESC" : "ASC";
    const tail = limited ? " LIMIT ?" : "";
    const params = opts.type ? [from, to, opts.type] : [from, to];
    if (limited) params.push(opts.limit);
    const sql = opts.type
      ? `SELECT * FROM events WHERE seq >= ? AND seq <= ? AND type = ? ORDER BY seq ${order}${tail}`
      : `SELECT * FROM events WHERE seq >= ? AND seq <= ? ORDER BY seq ${order}${tail}`;
    const rows = this.db.query(sql).all(...params);
    if (limited) rows.reverse();
    return rows.map((r) => this.rowToEvent(r));
  }

  rowToEvent(row) {
    return {
      seq: row.seq,
      id: row.id,
      type: row.type,
      ts: row.ts,
      payload: JSON.parse(row.payload),
      checksum: row.checksum,
      prevHash: row.prev_hash,
      hash: row.hash,
    };
  }

  // ---- projection: apply one event -------------------------------------

  applyEvent(ev) {
    const p = ev.payload;
    switch (ev.type) {
      case "NodeUpserted":
        this.pNodeUpsert(p, ev.seq);
        break;
      case "NodeStatusChanged":
        this.db.run("UPDATE nodes SET status = ?, updated_seq = ? WHERE id = ?", p.status, ev.seq, p.id);
        break;
      case "EdgeUpserted":
        this.pEdgeUpsert(p, ev.seq);
        break;
      case "EdgeRemoved":
        this.db.run("DELETE FROM edges WHERE id = ?", p.id);
        this.db.run("DELETE FROM stats WHERE scope_kind = 'edge' AND scope_id = ?", p.id);
        break;
      case "ZoneDefined":
        this.pZoneDefine(p, ev.seq);
        break;
      case "ZoneMembership":
        if (p.op === "add") this.db.run("INSERT OR IGNORE INTO zone_members(zone,node) VALUES(?,?)", p.zone, p.node);
        else this.db.run("DELETE FROM zone_members WHERE zone = ? AND node = ?", p.zone, p.node);
        break;
      case "EnforcementChanged":
        if (p.scope === "edge") this.db.run("UPDATE edges SET enforcement = ? WHERE id = ?", p.mode, p.id);
        else if (p.scope === "zone-intra") this.db.run("UPDATE zones SET intra = ? WHERE name = ?", p.mode, p.id);
        else if (p.scope === "zone-boundary") this.db.run("UPDATE zones SET boundary = ? WHERE name = ?", p.mode, p.id);
        break;
      case "CursorMoved":
        this.db.run("DELETE FROM cursor");
        for (const n of p.set) this.db.run("INSERT OR IGNORE INTO cursor(node) VALUES(?)", n);
        break;
      case "TransitionTaken":
        if (p.from != null) this.db.run("DELETE FROM cursor WHERE node = ?", p.from);
        this.db.run("INSERT OR IGNORE INTO cursor(node) VALUES(?)", p.to);
        this.bumpVisit("edge", p.edgeId, ev.seq);
        this.bumpVisit("node", p.to, ev.seq);
        break;
      case "BlockedAttempt":
        if (p.edgeId) this.bumpCounter("edge", p.edgeId, "blocks", ev.seq);
        break;
      case "SoftViolation":
        if (p.edgeId) this.bumpCounter("edge", p.edgeId, "soft_violations", ev.seq);
        break;
      case "RewardApplied":
        this.pReward(p, ev.seq);
        break;
      case "ConfigSet":
        this.db.run(
          "INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
          "cfg:" + p.key,
          JSON.stringify(p.value),
        );
        break;
      case "CheckpointCreated":
        this.db.run(
          "INSERT INTO checkpoints(name,seq,snapshot_id,created_seq) VALUES(?,?,?,?) " +
            "ON CONFLICT(name) DO UPDATE SET seq = excluded.seq, snapshot_id = excluded.snapshot_id, created_seq = excluded.created_seq",
          p.name,
          p.seq,
          p.snapshotId,
          ev.seq,
        );
        break;
      case "Migrated":
      case "SnapshotTaken":
        // No projection-table effect: handled via side tables at emit time.
        break;
    }
  }

  pNodeUpsert(p, seq) {
    const existing = this.db.query(
      "SELECT version, created_seq FROM nodes WHERE id = ?",
    ).get(p.id);
    const version = existing ? existing.version + 1 : 1;
    const createdSeq = existing ? existing.created_seq : seq;
    this.db.run(
      "INSERT INTO nodes(id,kind,label,payload,tags,status,version,created_seq,updated_seq,embedding) " +
        "VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET " +
        "kind=excluded.kind,label=excluded.label,payload=excluded.payload,tags=excluded.tags," +
        "status=excluded.status,version=excluded.version,updated_seq=excluded.updated_seq,embedding=excluded.embedding",
      p.id,
      p.kind,
      p.label,
      JSON.stringify(p.payload ?? {}),
      JSON.stringify(p.tags ?? []),
      p.status ?? "active",
      version,
      createdSeq,
      seq,
      p.embedding ? JSON.stringify(p.embedding) : null,
    );
    if (this.ftsEnabled) {
      this.db.run("DELETE FROM nodes_fts WHERE id = ?", p.id);
      const content = `${p.label} ${JSON.stringify(p.payload ?? {})} ${(p.tags ?? []).join(" ")}`;
      this.db.run("INSERT INTO nodes_fts(id, content) VALUES(?, ?)", p.id, content);
    }
  }

  pEdgeUpsert(p, seq) {
    const existing = this.db.query(
      "SELECT version, created_seq FROM edges WHERE id = ?",
    ).get(p.id);
    const version = existing ? existing.version + 1 : 1;
    const createdSeq = existing ? existing.created_seq : seq;
    this.db.run(
      "INSERT INTO edges(id,src,dst,kind,label,guard,enforcement,weight,version,created_seq) " +
        "VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET " +
        "src=excluded.src,dst=excluded.dst,kind=excluded.kind,label=excluded.label,guard=excluded.guard," +
        "enforcement=excluded.enforcement,weight=excluded.weight,version=excluded.version",
      p.id,
      p.src,
      p.dst,
      p.kind,
      p.label ?? "",
      p.guard ?? null,
      p.enforcement ?? null,
      p.weight ?? 1,
      version,
      createdSeq,
    );
  }

  pZoneDefine(p, seq) {
    this.db.run(
      "INSERT INTO zones(name,intra,boundary,created_seq) VALUES(?,?,?,?) " +
        "ON CONFLICT(name) DO UPDATE SET intra=excluded.intra, boundary=excluded.boundary",
      p.name,
      p.intra ?? "soft",
      p.boundary ?? "hard",
      seq,
    );
    this.db.run("DELETE FROM zone_members WHERE zone = ?", p.name);
    for (const n of p.members ?? []) {
      this.db.run("INSERT OR IGNORE INTO zone_members(zone,node) VALUES(?,?)", p.name, n);
    }
  }

  pReward(p, seq) {
    const alpha = p.alpha ?? 0.3;
    for (const sc of p.scopes) {
      const w = sc.weight ?? 1;
      const reward = p.value * w;
      this.ensureStat(sc.kind, sc.id);
      const s = this.db.query(
        "SELECT ema_reward FROM stats WHERE scope_kind = ? AND scope_id = ?",
      ).get(sc.kind, sc.id);
      const ema = s.ema_reward * (1 - alpha) + reward * alpha;
      const successCol = p.value >= 0 ? "successes" : "failures";
      this.db.run(
        `UPDATE stats SET ema_reward = ?, ${successCol} = ${successCol} + 1, last_seq = ? WHERE scope_kind = ? AND scope_id = ?`,
        ema,
        seq,
        sc.kind,
        sc.id,
      );
    }
  }

  ensureStat(kind, id) {
    this.db.run("INSERT OR IGNORE INTO stats(scope_kind, scope_id) VALUES(?,?)", kind, id);
  }
  bumpVisit(kind, id, seq) {
    this.ensureStat(kind, id);
    this.db.run(
      "UPDATE stats SET visits = visits + 1, last_seq = ? WHERE scope_kind = ? AND scope_id = ?",
      seq,
      kind,
      id,
    );
  }
  bumpCounter(kind, id, col, seq) {
    // `col` is a SQL identifier, not a bindable value, so it is interpolated.
    // Guard with an allow-list so no caller can ever inject (the column set is
    // fixed by the schema; an unknown column is an internal bug, so throw).
    if (!STAT_COUNTER_COLS.has(col)) throw new Error(`invalid stat counter column '${col}'`);
    this.ensureStat(kind, id);
    this.db.run(
      `UPDATE stats SET ${col} = ${col} + 1, last_seq = ? WHERE scope_kind = ? AND scope_id = ?`,
      seq,
      kind,
      id,
    );
  }

  // ---- replay / rebuild ------------------------------------------------

  clearProjection() {
    for (const t of PROJECTION_TABLES) this.db.run(`DELETE FROM ${t}`);
    if (this.ftsEnabled) this.db.run("DELETE FROM nodes_fts");
  }

  /** Full rebuild from the entire log. Projection is a pure fold of events. */
  rebuild() {
    const tx = this.db.transaction(() => {
      this.clearProjection();
      for (const ev of this.readEvents()) this.applyEvent(ev);
    });
    tx();
  }

  // ---- snapshot --------------------------------------------------------

  /** Capture the projection at the current head into the snapshots side table. */
  snapshot() {
    const id = this.ids.next("S");
    const data = this.serializeProjection();
    this.db.run(
      "INSERT INTO snapshots(id, seq, ts, data) VALUES(?,?,?,?)",
      id,
      this.headSeq,
      this.now(),
      JSON.stringify(data),
    );
    // Record a pointer event so the log notes a snapshot existed at this seq.
    this.append({ type: "SnapshotTaken", payload: { snapshotId: id, seq: this.headSeq } });
    return id;
  }

  serializeProjection() {
    const out = {};
    for (const t of PROJECTION_TABLES) {
      out[t] = this.db.query(`SELECT * FROM ${t}`).all();
    }
    return out;
  }

  loadSnapshot(id) {
    const row = this.db.query(
      "SELECT seq, data FROM snapshots WHERE id = ?",
    ).get(id);
    if (!row) return null;
    const data = JSON.parse(row.data);
    const tx = this.db.transaction(() => {
      this.clearProjection();
      for (const t of PROJECTION_TABLES) {
        for (const rec of data[t] ?? []) {
          const cols = Object.keys(rec);
          const placeholders = cols.map(() => "?").join(",");
          this.db.run(
            `INSERT INTO ${t}(${cols.join(",")}) VALUES(${placeholders})`,
            ...cols.map((c) => rec[c]),
          );
        }
      }
      if (this.ftsEnabled) {
        this.db.run("DELETE FROM nodes_fts");
        for (const n of this.db.query(
          "SELECT id,label,payload,tags FROM nodes",
        ).all()) {
          const content = `${n.label} ${n.payload} ${JSON.parse(n.tags).join(" ")}`;
          this.db.run("INSERT INTO nodes_fts(id, content) VALUES(?, ?)", n.id, content);
        }
      }
    });
    tx();
    return { seq: row.seq };
  }

  latestSnapshotId() {
    const row = this.db.query(
      "SELECT id FROM snapshots ORDER BY seq DESC, id DESC LIMIT 1",
    ).get();
    return row ? row.id : null;
  }

  // ---- recovery --------------------------------------------------------

  /**
   * Boot recovery. Verify the hash chain; if a break is found (a crash that
   * truncated or corrupted the trailing write) trim the log to the last good
   * seq. Then load the newest snapshot at/under that seq and replay the tail.
   * Returns the recovery report.
   */
  recover() {
    const integrity = this.verifyIntegrity();
    let trimmed = 0;
    if (!integrity.ok && integrity.firstBreakSeq != null) {
      const cut = integrity.firstBreakSeq - 1;
      const res = this.db.run("DELETE FROM events WHERE seq > ?", cut);
      trimmed = res.changes;
      this.loadHead();
    }
    // Pick newest snapshot whose seq <= head.
    const snapRow = this.db.query(
      "SELECT id, seq FROM snapshots WHERE seq <= ? ORDER BY seq DESC LIMIT 1",
    ).get(this.headSeq);
    let replayFrom = 1;
    let snapshotId = null;
    if (snapRow) {
      this.loadSnapshot(snapRow.id);
      replayFrom = snapRow.seq + 1;
      snapshotId = snapRow.id;
    } else {
      this.clearProjection();
    }
    const tail = this.readEvents({ fromSeq: replayFrom });
    const tx = this.db.transaction(() => {
      for (const ev of tail) this.applyEvent(ev);
    });
    tx();
    return { lastGoodSeq: this.headSeq, trimmed, replayedFrom: replayFrom, snapshotId };
  }

  /** Discard events after `seq` (used by rollback). Caller rebuilds projection. */
  truncateAfter(seq) {
    const res = this.db.run("DELETE FROM events WHERE seq > ?", seq);
    this.loadHead();
    return res.changes;
  }

  // ---- compaction ------------------------------------------------------

  /**
   * Snapshot, then prune events strictly before the snapshot seq minus the
   * retention window. Bounds both replay cost and disk while keeping `retain`
   * recent events for audit. Snapshots referenced by checkpoints are preserved.
   */
  compact(retain = 0) {
    const snapshotId = this.snapshot();
    const snapSeq = this.headSeq; // SnapshotTaken bumped head; snapshot captured prior state
    const cutoff = Math.max(0, snapSeq - retain - 1);
    // Keep any event at/after the oldest snapshot still needed for recovery.
    const res = this.db.run("DELETE FROM events WHERE seq <= ? AND type != 'SnapshotTaken'", cutoff);
    return { snapshotId, pruned: res.changes };
  }

  // ---- integrity -------------------------------------------------------

  verifyIntegrity() {
    const rows = this.db.query("SELECT * FROM events ORDER BY seq").all();
    let prevHash = GENESIS_HASH;
    let checked = 0;
    // Anchor on the first retained event. An uncompacted log starts at seq 1 and
    // its prev_hash must be GENESIS; a compacted log legitimately starts mid-chain
    // (the prefix was pruned under a snapshot), so we trust its stored prev_hash as
    // the anchor and verify continuity from there -- tampering within the retained
    // tail is still fully caught.
    let expectedSeq = null;
    for (const row of rows) {
      checked++;
      if (expectedSeq === null) {
        expectedSeq = row.seq;
        if (row.seq !== 1) prevHash = row.prev_hash;
      }
      if (row.seq !== expectedSeq) {
        return { ok: false, checkedEvents: checked, firstBreakSeq: row.seq, detail: `seq gap: expected ${expectedSeq}, got ${row.seq}` };
      }
      expectedSeq++;
      const payload = JSON.parse(row.payload);
      const checksum = eventChecksum(row.seq, row.type, row.ts, payload);
      if (checksum !== row.checksum) {
        return { ok: false, checkedEvents: checked, firstBreakSeq: row.seq, detail: `checksum mismatch at seq ${row.seq}` };
      }
      if (row.prev_hash !== prevHash) {
        return { ok: false, checkedEvents: checked, firstBreakSeq: row.seq, detail: `prev_hash mismatch at seq ${row.seq}` };
      }
      const hash = eventHash(checksum, prevHash);
      if (hash !== row.hash) {
        return { ok: false, checkedEvents: checked, firstBreakSeq: row.seq, detail: `hash mismatch at seq ${row.seq}` };
      }
      prevHash = row.hash;
    }
    return { ok: true, checkedEvents: checked, firstBreakSeq: null, detail: null };
  }

  // ---- config (meta cfg:* rows) ---------------------------------------

  getConfig(key) {
    const row = this.db.query("SELECT value FROM meta WHERE key = ?").get("cfg:" + key);
    return row ? JSON.parse(row.value) : undefined;
  }

  // ---- row readers -----------------------------------------------------

  getNode(id) {
    const r = this.db.query("SELECT * FROM nodes WHERE id = ?").get(id);
    return r ? rowToNode(r) : null;
  }
  /** Cheap status probe for hot paths: avoids parsing the full node row. */
  nodeStatus(id) {
    const r = this.db.query("SELECT status FROM nodes WHERE id = ?").get(id);
    return r ? r.status : null;
  }
  allNodes() {
    return this.db.query("SELECT * FROM nodes").all().map(rowToNode);
  }
  getEdge(id) {
    const r = this.db.query("SELECT * FROM edges WHERE id = ?").get(id);
    return r ? rowToEdge(r) : null;
  }
  allEdges() {
    return this.db.query("SELECT * FROM edges").all().map(rowToEdge);
  }
  outEdges(src, kind) {
    const rows = kind
      ? this.db.query("SELECT * FROM edges WHERE src = ? AND kind = ?").all(src, kind)
      : this.db.query("SELECT * FROM edges WHERE src = ?").all(src);
    return rows.map(rowToEdge);
  }
  inEdges(dst, kind) {
    const rows = kind
      ? this.db.query("SELECT * FROM edges WHERE dst = ? AND kind = ?").all(dst, kind)
      : this.db.query("SELECT * FROM edges WHERE dst = ?").all(dst);
    return rows.map(rowToEdge);
  }
  getZone(name) {
    const z = this.db.query("SELECT * FROM zones WHERE name = ?").get(name);
    if (!z) return null;
    const members = this.db.query("SELECT node FROM zone_members WHERE zone = ?").all(name).map((m) => m.node);
    return { name: z.name, intra: z.intra, boundary: z.boundary, members, createdSeq: z.created_seq };
  }
  allZones() {
    return this.db.query("SELECT name FROM zones").all().map((r) => this.getZone(r.name)).filter(Boolean);
  }
  zonesOf(node) {
    return this.db.query("SELECT zone FROM zone_members WHERE node = ?").all(node).map((r) => r.zone);
  }
  getStat(kind, id) {
    const r = this.db.query("SELECT * FROM stats WHERE scope_kind = ? AND scope_id = ?").get(kind, id);
    return r ? rowToStat(r) : null;
  }
  allStats() {
    return this.db.query("SELECT * FROM stats").all().map(rowToStat);
  }
  snapshotSeq(id) {
    const r = this.db.query("SELECT seq FROM snapshots WHERE id = ?").get(id);
    return r ? r.seq : null;
  }
  allZoneMembers() {
    return this.db.query("SELECT zone, node FROM zone_members").all().map((r) => ({ zone: r.zone, node: r.node }));
  }
  cursor() {
    return this.db.query("SELECT node FROM cursor").all().map((r) => r.node);
  }

  close() {
    this.db.close();
  }
}

// ---- row mappers --------------------------------------------------------

function rowToNode(r) {
  return {
    id: r.id,
    kind: r.kind,
    label: r.label,
    payload: JSON.parse(r.payload),
    tags: JSON.parse(r.tags),
    status: r.status,
    version: r.version,
    createdSeq: r.created_seq,
    updatedSeq: r.updated_seq,
    embedding: r.embedding ? JSON.parse(r.embedding) : null,
  };
}
function rowToEdge(r) {
  return {
    id: r.id,
    src: r.src,
    dst: r.dst,
    kind: r.kind,
    label: r.label,
    guard: r.guard,
    enforcement: r.enforcement,
    weight: r.weight,
    version: r.version,
    createdSeq: r.created_seq,
  };
}
function rowToStat(r) {
  return {
    scopeKind: r.scope_kind,
    scopeId: r.scope_id,
    visits: r.visits,
    successes: r.successes,
    failures: r.failures,
    softViolations: r.soft_violations,
    blocks: r.blocks,
    emaReward: r.ema_reward,
    lastSeq: r.last_seq,
  };
}

export { sha256 };
