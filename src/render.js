// Observability surfaces. render() is the per-turn live view the agent reads:
// cursor, ranked legal moves with enforcement/confidence, the ready frontier,
// recent rewards, open violations. ASCII only -- arrows are ->, no decorative
// glyphs -- so it drops cleanly into any text context. Mermaid/DOT exporters and
// metrics() round out inspection.

import { validate } from "./validate.js";

export function render(ds) {
  const lines = [];
  const cursor = ds.cursor();
  lines.push(`cursor: ${cursor.length ? cursor.join(", ") : "(none)"}`);

  const moves = ds.suggest();
  lines.push(`moves (${moves.length}):`);
  if (moves.length === 0) lines.push("  (none)");
  for (const m of moves) {
    lines.push(
      `  -> ${m.to} [${m.enforcement}] score=${m.score.toFixed(2)} conf=${m.confidence.toFixed(2)} visits=${m.visits} ema=${m.emaReward.toFixed(2)}`,
    );
  }

  const done = new Set(ds.store.allNodes().filter((n) => (ds.getStat("node", n.id)?.visits ?? 0) > 0).map((n) => n.id));
  const ready = ds.ready(done);
  lines.push(`ready: ${ready.length ? ready.join(", ") : "(none)"}`);

  const rewards = ds.store.readEvents({ type: "RewardApplied", limit: 3 });
  if (rewards.length) {
    lines.push("recent rewards:");
    for (const r of rewards) lines.push(`  ${r.payload.value} @ seq ${r.seq}`);
  }

  const v = validate(ds).violations.length;
  lines.push(`violations: ${v}`);
  lines.push(`seq: ${ds.store.lastSeq()}`);
  return lines.join("\n");
}

export function metrics(ds) {
  const nodes = ds.store.allNodes();
  const edges = ds.store.allEdges();
  const stats = ds.store.allStats();
  const edgeStats = stats.filter((s) => s.scopeKind === "edge");
  const hot = [...edgeStats].sort((a, b) => b.visits - a.visits).slice(0, 5).map((s) => ({ edge: s.scopeId, visits: s.visits }));
  const blocks = edgeStats.reduce((a, s) => a + s.blocks, 0);
  const soft = edgeStats.reduce((a, s) => a + s.softViolations, 0);
  const rewarded = stats.filter((s) => s.successes + s.failures > 0);
  const meanReward = rewarded.length ? rewarded.reduce((a, s) => a + s.emaReward, 0) / rewarded.length : 0;
  const lastSnap = ds.store.latestSnapshotId();
  const snapSeq = lastSnap ? ds.store.snapshotSeq(lastSnap) ?? 0 : 0;
  return {
    nodes: {
      total: nodes.length,
      active: nodes.filter((n) => n.status === "active").length,
      archived: nodes.filter((n) => n.status === "archived").length,
      deprecated: nodes.filter((n) => n.status === "deprecated").length,
    },
    edges: {
      transition: edges.filter((e) => e.kind === "transition").length,
      dependency: edges.filter((e) => e.kind === "dependency").length,
    },
    zones: ds.store.allZones().length,
    events: ds.store.lastSeq(),
    hotTransitions: hot,
    blocks,
    softViolations: soft,
    meanReward,
    estimatedReplayCost: ds.store.lastSeq() - snapSeq,
    // false means text recall ran on the LIKE fallback, not FTS5.
    ftsEnabled: ds.store.ftsEnabled,
  };
}

export function toMermaid(ds) {
  const lines = ["graph LR"];
  for (const n of ds.store.allNodes()) {
    if (n.status !== "active") continue;
    lines.push(`  ${safe(n.id)}["${ascii(n.label)}"]`);
  }
  for (const e of ds.store.allEdges()) {
    const arrow = e.kind === "dependency" ? "-.->" : "-->";
    const lbl = e.label ? `|${ascii(e.label)}|` : "";
    lines.push(`  ${safe(e.src)} ${arrow}${lbl} ${safe(e.dst)}`);
  }
  return lines.join("\n");
}

export function toDot(ds) {
  const lines = ["digraph adaptogen {"];
  for (const n of ds.store.allNodes()) {
    if (n.status !== "active") continue;
    lines.push(`  "${safe(n.id)}" [label="${ascii(n.label)}"];`);
  }
  for (const e of ds.store.allEdges()) {
    const style = e.kind === "dependency" ? " [style=dashed]" : "";
    lines.push(`  "${safe(e.src)}" -> "${safe(e.dst)}"${style};`);
  }
  lines.push("}");
  return lines.join("\n");
}

function safe(id) {
  return id.replace(/[^A-Za-z0-9_:.-]/g, "_");
}
function ascii(s) {
  // strip non-ASCII so rendered output never carries decorative glyphs
  return s.replace(/[^\x20-\x7E]/g, "").replace(/"/g, "'");
}
