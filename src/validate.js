// Invariant checking, repair, and storage integrity. validate() reports logical
// violations (cycles, dangling refs, cursor on a dead node, hash-chain breaks);
// repair() fixes the safe ones by emitting corrective events (or a rebuild for
// orphaned projection rows) and quarantines the rest. Nothing is silently
// mutated outside the event log.

import { topoSort } from "./graph.js";

export function verifyIntegrity(ds) {
  return ds.store.verifyIntegrity();
}

export function validate(ds) {
  const store = ds.store;
  const violations = [];
  const nodeIds = new Set(store.allNodes().map((n) => n.id));
  const edgeIds = new Set(store.allEdges().map((e) => e.id));

  if (topoSort(store).cyclic) {
    violations.push({ kind: "DagCycle", locus: "dependency-graph", detail: "dependency edges form a cycle", fixable: false });
  }

  for (const e of store.allEdges()) {
    if (!nodeIds.has(e.src) || !nodeIds.has(e.dst)) {
      violations.push({ kind: "DanglingEdge", locus: e.id, detail: `endpoint missing (${e.src}->${e.dst})`, fixable: true });
      continue;
    }
    if (e.kind === "transition") {
      const dst = store.getNode(e.dst);
      if (dst.status !== "active") {
        violations.push({ kind: "TransitionToDeadNode", locus: e.id, detail: `target ${e.dst} is ${dst.status}`, fixable: true });
      }
    } else if (e.kind === "dependency") {
      // A dependency edge runs prereq (src) -> dependent (dst). An active
      // dependent must not depend on a dead prereq: gc() can deprecate a prereq
      // out from under a still-live dependent, leaving a dangling dep.
      const src = store.getNode(e.src);
      const dst = store.getNode(e.dst);
      if (dst.status === "active" && src.status !== "active") {
        violations.push({ kind: "DependencyToDeadNode", locus: e.id, detail: `active ${e.dst} depends on ${src.status} ${e.src}`, fixable: true });
      }
    }
  }

  for (const c of store.cursor()) {
    const n = store.getNode(c);
    if (!n || n.status !== "active") {
      violations.push({ kind: "CursorOnDeadNode", locus: c, detail: `cursor on missing/dead node`, fixable: true });
    }
  }

  for (const s of store.allStats()) {
    const live = s.scopeKind === "node" ? nodeIds.has(s.scopeId) : edgeIds.has(s.scopeId);
    if (!live) violations.push({ kind: "OrphanStat", locus: `${s.scopeKind}:${s.scopeId}`, detail: `stat for missing ${s.scopeKind}`, fixable: true });
  }

  for (const m of store.allZoneMembers()) {
    if (!nodeIds.has(m.node)) {
      violations.push({ kind: "DanglingZoneMember", locus: `${m.zone}:${m.node}`, detail: `zone member node missing`, fixable: true });
    }
  }

  const integrity = store.verifyIntegrity();
  if (!integrity.ok) {
    violations.push({ kind: "HashChainBreak", locus: `seq:${integrity.firstBreakSeq}`, detail: integrity.detail ?? "chain break", fixable: false });
  }

  return { ok: violations.length === 0, violations };
}

export function repair(ds) {
  const store = ds.store;
  const report = validate(ds);
  const fixed = [];
  const quarantined = [];
  let needRebuild = false;

  for (const v of report.violations) {
    if (!v.fixable) {
      quarantined.push(v);
      continue;
    }
    switch (v.kind) {
      case "DanglingEdge":
      case "TransitionToDeadNode":
      case "DependencyToDeadNode":
        store.append({ type: "EdgeRemoved", payload: { id: v.locus } });
        fixed.push(v);
        break;
      case "CursorOnDeadNode": {
        const live = store.cursor().filter((c) => {
          const n = store.getNode(c);
          return n && n.status === "active";
        });
        store.append({ type: "CursorMoved", payload: { set: live } });
        fixed.push(v);
        break;
      }
      case "DanglingZoneMember": {
        const [zone, node] = v.locus.split(":");
        store.append({ type: "ZoneMembership", payload: { zone, node, op: "remove" } });
        fixed.push(v);
        break;
      }
      case "OrphanStat":
        needRebuild = true;
        fixed.push(v);
        break;
      default:
        quarantined.push(v);
    }
  }
  if (needRebuild) store.rebuild(); // regenerates stats purely from events, dropping orphans
  return { fixed, quarantined };
}
