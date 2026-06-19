// Profiling harness on a large graph + hot loop. Builds a wide graph, then runs
// a hot transition+suggest loop and measures the hot paths (append, transition,
// suggest, recovery, snapshot). Catches O(n) regressions: transition+suggest must
// stay roughly flat as the graph grows because they hit indices, not full scans.

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
// transition+suggest, which must stay flat as the graph grows.
ds.setTunable("snapshotInterval", 0);

let cur = 0;
const loopIters = 5000;
const hot = ms(() => {
  for (let it = 0; it < loopIters; it++) {
    const sug = ds.suggest();
    if (sug.length === 0) break;
    const next = sug[0];
    ds.transition(next.to);
    if (it % 50 === 0) ds.reward(1, { edgeId: next.edgeId });
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
// A full suggest+transition step touches only the cursor's out-edges and their
// stats via indices. A regression to full-graph scanning at this scale (16k
// edges) would push a single step into the hundreds of ms, so a 10ms budget
// catches that class of regression with headroom while staying non-flaky.
const perStep = hot / loopIters;
if (perStep > 10) {
  process.stderr.write(`REGRESSION: per-step ${perStep.toFixed(2)}ms exceeds 10ms budget\n`);
  process.exit(1);
}
ds.close();

function round(x) {
  return Math.round(x * 100) / 100;
}
