// Observability surfaces. render() is the per-turn live view the agent reads:
// cursor, legal moves with enforcement, the ready frontier, open violations.
// ASCII only -- arrows are ->, no decorative glyphs -- so it drops cleanly into
// any text context. Mermaid/DOT exporters and metrics() round out inspection.

import { validate } from "./validate.js";

export function render(ds) {
  const lines = [];
  const cursor = ds.cursor();
  lines.push(`cursor: ${cursor.length ? cursor.join(", ") : "(none)"}`);

  const moves = ds.legalMoves();
  lines.push(`moves (${moves.length}):`);
  if (moves.length === 0) lines.push("  (none)");
  for (const m of moves) {
    lines.push(`  -> ${m.to} [${m.enforcement}] (${m.decision})`);
  }

  const done = new Set();
  for (const e of ds.store.readEvents({ type: "TransitionTaken" })) done.add(e.payload.to);
  const ready = ds.ready(done);
  lines.push(`ready: ${ready.length ? ready.join(", ") : "(none)"}`);

  const v = validate(ds).violations.length;
  lines.push(`violations: ${v}`);
  lines.push(`seq: ${ds.store.lastSeq()}`);
  return lines.join("\n");
}

export function metrics(ds) {
  const nodes = ds.store.allNodes();
  const edges = ds.store.allEdges();
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
    estimatedReplayCost: ds.store.lastSeq() - snapSeq,
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
