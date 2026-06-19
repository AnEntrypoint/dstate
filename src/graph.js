// Graph algorithms over the projection. Dependency edges (src = prerequisite,
// dst = dependent) form the DAG; transition edges form the FSM. All traversals
// are iterative so a deep graph cannot blow the call stack.

/** prereq -> [dependents]; following an edge goes prerequisite to dependent. */
export function depAdjacency(store) {
  const adj = new Map();
  for (const e of store.allEdges()) {
    if (e.kind !== "dependency") continue;
    if (!adj.has(e.src)) adj.set(e.src, []);
    adj.get(e.src).push(e.dst);
  }
  return adj;
}

/** Is there a directed path from `from` to `to` over the given adjacency? */
export function hasPath(adj, from, to) {
  if (from === to) return true;
  const seen = new Set([from]);
  const stack = [from];
  while (stack.length) {
    const cur = stack.pop();
    for (const next of adj.get(cur) ?? []) {
      if (next === to) return true;
      if (!seen.has(next)) {
        seen.add(next);
        stack.push(next);
      }
    }
  }
  return false;
}

/**
 * Would adding dependency prereq->dependent create a cycle? Yes iff dependent
 * can already reach prereq. Returns the offending path for the error message.
 */
export function dependencyCycle(store, prereq, dependent) {
  // A cycle would form iff `dependent` can already reach `prereq` over
  // dependency edges. Walk out-edges from the indexed projection directly
  // rather than materializing the whole adjacency every call -- the traversal
  // only touches nodes reachable from `dependent`, so adding a link stays cheap
  // even on a long chain.
  const prev = new Map();
  const seen = new Set([dependent]);
  const stack = [dependent];
  while (stack.length) {
    const cur = stack.pop();
    if (cur === prereq) {
      const path = [cur];
      let p = cur;
      while (prev.has(p)) {
        p = prev.get(p);
        path.unshift(p);
      }
      return [prereq, ...path];
    }
    for (const e of store.outEdges(cur, "dependency")) {
      if (!seen.has(e.dst)) {
        seen.add(e.dst);
        prev.set(e.dst, cur);
        stack.push(e.dst);
      }
    }
  }
  return null;
}

/** Kahn's algorithm topological sort of the dependency subgraph. */
export function topoSort(store) {
  const adj = depAdjacency(store);
  const indeg = new Map();
  const nodes = store.allNodes().map((n) => n.id);
  for (const n of nodes) indeg.set(n, 0);
  for (const [, dsts] of adj) for (const d of dsts) indeg.set(d, (indeg.get(d) ?? 0) + 1);
  const queue = [];
  for (const n of nodes) if ((indeg.get(n) ?? 0) === 0) queue.push(n);
  queue.sort(); // deterministic order among ready nodes
  const order = [];
  while (queue.length) {
    const cur = queue.shift();
    order.push(cur);
    const next = [];
    for (const d of adj.get(cur) ?? []) {
      indeg.set(d, (indeg.get(d) ?? 0) - 1);
      if ((indeg.get(d) ?? 0) === 0) next.push(d);
    }
    next.sort();
    for (const d of next) queue.push(d);
  }
  return { order, cyclic: order.length !== nodes.length };
}

/**
 * Ready frontier: active nodes not yet done whose every dependency prerequisite
 * (dependency in-edge sources) is in `done`.
 */
export function readyFrontier(store, done) {
  const out = [];
  for (const n of store.allNodes()) {
    if (n.status !== "active") continue;
    if (done.has(n.id)) continue;
    const prereqs = store.inEdges(n.id, "dependency").map((e) => e.src);
    if (prereqs.every((p) => done.has(p))) out.push(n.id);
  }
  return out.sort();
}

/** Reachable set from `from` over edges of `kind` (transition by default). */
export function reachable(store, from, kind = "transition") {
  const seen = new Set();
  const stack = [from];
  while (stack.length) {
    const cur = stack.pop();
    for (const e of store.outEdges(cur, kind)) {
      if (!seen.has(e.dst)) {
        seen.add(e.dst);
        stack.push(e.dst);
      }
    }
  }
  return seen;
}

export function descendants(store, from, kind = "dependency") {
  return reachable(store, from, kind);
}

export function ancestors(store, of, kind = "dependency") {
  const seen = new Set();
  const stack = [of];
  while (stack.length) {
    const cur = stack.pop();
    for (const e of store.inEdges(cur, kind)) {
      if (!seen.has(e.src)) {
        seen.add(e.src);
        stack.push(e.src);
      }
    }
  }
  return seen;
}
