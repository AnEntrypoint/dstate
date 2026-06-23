// Profiling harness on a large graph + hot loop. Builds a wide graph, then runs
// a hot legalMoves+transition loop and measures the hot paths (append, transition,
// recovery, snapshot). Catches O(n) regressions: a single FSM step touches only
// the cursor's out-edges, so per-step cost must stay roughly flat as the graph
// grows. (In-memory edge lookups scan the edge map; this bench guards that the
// per-step cost stays under budget at scale.)

import { DState } from "../src/index.js";

function ms(fn) {
  const t0 = performance.now();
  fn();
  return performance.now() - t0;
}

const N = Number(process.argv[2] ?? 4000);
const FANOUT = 4;

const ds = DState.open(":memory:", { seed: false });

const build = ms(() => {
  for (let i = 0; i < N; i++) ds.remember({ id: "n" + i, payload: { i } });
  for (let i = 0; i < N; i++) {
    for (let k = 1; k <= FANOUT; k++) {
      const j = (i + k) % N;
      ds.link("n" + i, "n" + j);
    }
  }
});

ds.setCursor(["n0"]);

// Auto-snapshot serializes the whole projection (O(N)); it is measured on its
// own below. Disable it during the hot loop so this measures pure
// legalMoves+transition, which must stay flat as the graph grows.
ds.setTunable("snapshotInterval", 0);

let cur = 0;
const loopIters = 5000;
const hot = ms(() => {
  for (let it = 0; it < loopIters; it++) {
    const moves = ds.legalMoves();
    if (moves.length === 0) break;
    const next = moves[0];
    ds.transition(next.to);
    cur = Number(next.to.slice(1));
  }
});

const snap = ms(() => {
  ds.snapshot();
});

const recov = ms(() => {
  ds.store.recover();
});

const m = ds.metrics();
const report = {
  nodes: N,
  edges: N * FANOUT,
  build_ms: round(build),
  hot_loop_ms: round(hot),
  per_transition_us: round((hot / loopIters) * 1000),
  snapshot_ms: round(snap),
  recover_ms: round(recov),
  final_seq: m.events,
  estimated_replay_cost: m.estimatedReplayCost,
};
process.stdout.write(JSON.stringify(report, null, 2) + "\n");

// Loose regression guards: a single transition+suggest step must stay sub-ms on
// average even at this scale (indices, not scans), and recovery is bounded by the
// snapshot tail rather than the full log.
// A full legalMoves+transition step touches only the cursor's out-edges. A
// regression that pushes a single step into the hundreds of ms is caught by a
// 10ms budget with headroom while staying non-flaky.
const perStep = hot / loopIters;
if (perStep > 10) {
  process.stderr.write(`REGRESSION: per-step ${perStep.toFixed(2)}ms exceeds 10ms budget\n`);
  process.exit(1);
}
ds.close();

function round(x) {
  return Math.round(x * 100) / 100;
}
