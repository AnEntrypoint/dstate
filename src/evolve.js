// Self-evolution: the structural edits the agent applies to its own graph.
// Everything routes through the engine's event-sourced verbs, so every evolution
// is replayable and reversible. These are pure structural transforms (split,
// merge, gc, migrate) -- there is no learned signal to mine.

import { ok, fail } from "./errors.js";
import { reachable } from "./graph.js";

/** Clone a node into newId and move the named out-edges onto the clone. */
export function splitState(ds, nodeId, newId, moveEdgeIds) {
  const node = ds.store.getNode(nodeId);
  if (!node) return fail("NotFound", `node ${nodeId} not found`);
  if (ds.store.getNode(newId)) return fail("DuplicateId", `node ${newId} already exists`);
  const created = ds.remember({ id: newId, kind: node.kind, label: `${node.label} (split)`, payload: { ...node.payload }, tags: node.tags });
  if (!created.ok) return created;
  for (const eid of moveEdgeIds) {
    const e = ds.store.getEdge(eid);
    if (!e || e.src !== nodeId) continue;
    ds.store.append({ type: "EdgeRemoved", payload: { id: eid } });
    ds.store.append({
      type: "EdgeUpserted",
      payload: { id: eid, src: newId, dst: e.dst, kind: e.kind, label: e.label, guard: e.guard, enforcement: e.enforcement, weight: e.weight },
    });
  }
  return ok({ from: nodeId, to: newId });
}

/** Rewire all of b's edges onto a, union payloads, archive b. */
export function mergeStates(ds, a, b) {
  const na = ds.store.getNode(a);
  const nb = ds.store.getNode(b);
  if (!na || !nb) return fail("NotFound", `merge needs both nodes`);
  ds.remember({ id: a, payload: { ...nb.payload, ...na.payload }, tags: [...new Set([...na.tags, ...nb.tags])] });
  for (const e of ds.store.outEdges(b)) {
    ds.store.append({ type: "EdgeRemoved", payload: { id: e.id } });
    if (e.dst !== a) {
      ds.store.append({ type: "EdgeUpserted", payload: { id: ds.ids.next("G"), src: a, dst: e.dst, kind: e.kind, label: e.label, guard: e.guard, enforcement: e.enforcement, weight: e.weight } });
    }
  }
  for (const e of ds.store.inEdges(b)) {
    ds.store.append({ type: "EdgeRemoved", payload: { id: e.id } });
    if (e.src !== a) {
      ds.store.append({ type: "EdgeUpserted", payload: { id: ds.ids.next("G"), src: e.src, dst: a, kind: e.kind, label: e.label, guard: e.guard, enforcement: e.enforcement, weight: e.weight } });
    }
  }
  const cur = ds.store.cursor();
  if (cur.includes(b)) {
    ds.store.append({ type: "CursorMoved", payload: { set: [...new Set(cur.map((c) => (c === b ? a : c)))] } });
  }
  ds.store.append({ type: "NodeStatusChanged", payload: { id: b, status: "deprecated" } });
  return ok({ into: a });
}

/** Deprecate active non-seed nodes unreachable from the cursor; prune their edges. */
export function gc(ds) {
  const live = new Set();
  for (const c of ds.store.cursor()) {
    live.add(c);
    for (const r of reachable(ds.store, c, "transition")) live.add(r);
  }
  const deprecated = [];
  let pruned = 0;
  for (const n of ds.store.allNodes()) {
    if (n.status !== "active") continue;
    if (live.has(n.id)) continue;
    if (n.tags.includes("seed")) continue;
    ds.store.append({ type: "NodeStatusChanged", payload: { id: n.id, status: "deprecated" } });
    deprecated.push(n.id);
    for (const e of [...ds.store.outEdges(n.id), ...ds.store.inEdges(n.id)]) {
      ds.store.append({ type: "EdgeRemoved", payload: { id: e.id } });
      pruned++;
    }
  }
  return { deprecated, prunedEdges: pruned };
}

/** Migrate every node of `kind` by applying `apply` to its payload. */
export function migrate(ds, kind, apply, toVersion = 0) {
  let count = 0;
  for (const n of ds.store.allNodes()) {
    if (n.kind !== kind) continue;
    let next;
    try {
      next = apply({ ...n.payload });
    } catch (e) {
      return fail("MigrationError", `migrate failed on ${n.id}: ${e.message}`);
    }
    ds.remember({ id: n.id, payload: next });
    count++;
  }
  ds.store.append({ type: "Migrated", payload: { kind, toVersion, migrated: count } });
  return ok({ migrated: count });
}
