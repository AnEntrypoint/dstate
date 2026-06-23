// Portable export/import. State is project-resident, never platform-resident:
// the full history serializes to plain JSON (event drafts in order) and replays
// into a fresh store, reconstructing an identical projection and a fresh, valid
// hash chain. Storage-pointer events (snapshots/checkpoints) are omitted; they
// are local optimizations, not part of the portable truth. This same bundle is
// what DState writes to and reads from a JSON file on disk.

import { DState } from "./engine.js";

export const SCHEMA_VERSION = 2;

const SKIP = ["SnapshotTaken", "CheckpointCreated"];

export function exportState(ds) {
  return {
    schema_version: SCHEMA_VERSION,
    events: ds.store
      .readEvents()
      .filter((e) => !SKIP.includes(e.type))
      .map((e) => ({ type: e.type, payload: e.payload })),
  };
}

export function importState(filename, bundle, opts = {}) {
  const ds = DState.open(filename, { ...opts, seed: false, load: false });
  ds.store.appendMany(bundle.events.map((e) => ({ type: e.type, payload: e.payload })));
  return ds;
}
