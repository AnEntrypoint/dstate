// Durable checkpoints, rollback, and branching. A checkpoint pins a snapshot at
// a seq the agent can return to. rollback() restores the exact projection by
// trimming the log to the checkpoint and rebuilding. branch() forks the whole
// state into an isolated store so the agent can explore an alternative evolution
// without risking main; discard is just closing+removing the branch file.

import { existsSync, unlinkSync } from "node:fs";
import { ok, fail } from "./errors.js";
import { exportState, importState } from "./portability.js";

export function checkpoint(ds, name) {
  const id = ds.store.snapshot();
  const seq = ds.store.snapshotSeq(id);
  if (seq == null) return fail("NotFound", `snapshot ${id} vanished`);
  ds.store.append({ type: "CheckpointCreated", payload: { name, seq, snapshotId: id } });
  return ok({ seq });
}

export function listCheckpoints(ds) {
  return ds.store.db.query("SELECT name, seq FROM checkpoints ORDER BY seq").all().map((r) => ({ name: r.name, seq: r.seq }));
}

export function rollback(ds, name) {
  const cp = ds.store.db.query("SELECT seq FROM checkpoints WHERE name = ?").get(name);
  if (!cp) return fail("CheckpointNotFound", `checkpoint ${name} not found`);
  ds.store.truncateAfter(cp.seq);
  ds.store.rebuild();
  ds.invalidateCaches();
  return ok({ seq: cp.seq });
}

/** Fork the full state into an isolated store. Mutations there never touch main. */
export function branch(ds, filename) {
  if (filename !== ":memory:" && existsSync(filename)) {
    return fail("Conflict", `branch target ${filename} already exists`);
  }
  const child = importState(filename, exportState(ds));
  // Mark the fork point so merge() knows which branch events are new work.
  const forkSeq = child.store.lastSeq();
  child.store.append({ type: "ConfigSet", payload: { key: "__fork_seq", value: forkSeq } });
  return ok(child);
}

/**
 * Fast-forward merge: replay the branch's post-fork work onto main. This is a
 * union (replay branch events main does not have), not a 3-way reconcile -- a
 * deliberate, predictable primitive. Main keeps any work it did independently.
 */
export function merge(mainDs, branchDs) {
  const forkSeq = branchDs.store.getConfig("__fork_seq");
  if (forkSeq == null) return fail("Conflict", "branch has no fork marker");
  const tail = branchDs.store
    .readEvents({ fromSeq: forkSeq + 1 })
    .filter((e) => !(e.type === "ConfigSet" && e.payload.key === "__fork_seq") && e.type !== "SnapshotTaken" && e.type !== "CheckpointCreated");
  mainDs.store.appendMany(tail.map((e) => ({ type: e.type, payload: e.payload })));
  mainDs.invalidateCaches();
  return ok({ merged: tail.length });
}

/** Drop a branch store and its backing file. */
export function discard(branchDs) {
  const file = branchDs.store.db.filename;
  branchDs.close();
  if (file && file !== ":memory:" && existsSync(file)) {
    try {
      unlinkSync(file);
    } catch {
      /* already gone */
    }
  }
}
