// Single test file: the integration witness. One real on-disk JSON store driven
// through a full agent session that exercises the entire public API surface end to
// end -- memory, recall, error contract, dag, edges, zones, fsm/enforcement, guard
// DSL, tunables, evolve, checkpoint, durability, crash recovery, portability, and
// the vendorable plan() spec. Exits 0 only if every assertion holds. Real services,
// no mocks. Run: `bun test.js` (or `node test.js`). Hard ceiling: 200 lines.

import { DState, importState, compileGuard, evalGuard, DEFAULT_TUNABLES, MANIFEST } from "./src/index.js";
import { existsSync, rmSync, mkdirSync } from "node:fs";

let n = 0;
function ok(cond, msg) {
  n++;
  if (!cond) {
    console.error(`FAIL #${n}: ${msg}`);
    process.exit(1);
  }
}

const FILE = "./tmp/integration.json";
// ./tmp is gitignored, so it is absent on a fresh clone and in CI; create it
// before any store opens or the atomic temp+rename save has no directory to write into.
mkdirSync("./tmp", { recursive: true });
function cleanup() {
  for (const s of ["", ".tmp", ".lock"]) {
    try { if (existsSync(FILE + s)) rmSync(FILE + s, { force: true }); } catch { /* temp file */ }
  }
}
cleanup();

// ---- memory: remember / recall (id, text, tag, kind) / status --------------
let ds = DState.open(FILE, { seed: false, lock: true });
for (const id of ["scout", "build", "review", "ship", "abort"]) ds.remember({ id, kind: "state", payload: {} });
ds.remember({ id: "doc", kind: "note", payload: { body: "hello world" }, tags: ['a"b'] });
ok(ds.getNode("doc").payload.body === "hello world", "remember/getNode round-trips payload");
ok(ds.recall({ id: "doc" })[0].id === "doc", "recall by id");
ok(ds.recall({ text: "HELLO" }).some((x) => x.id === "doc"), "recall by case-insensitive substring");
ok(ds.recall({ tag: 'a"b' }).some((x) => x.id === "doc"), "recall by tag containing a quote");
ok(ds.recall({ kind: "note" }).length === 1, "recall filtered by kind");
ds.archive("doc");
ok(ds.getNode("doc").status === "archived", "archive sets status");
ok(ds.deprecate("abort").ok && ds.getNode("abort").status === "deprecated", "deprecate sets status");

// ---- error contract: every agent-facing failure is a typed Result ----------
ok(!ds.remember({ id: "bad id!" }).ok, "invalid node id rejected");
ok(ds.remember({ id: "x", payload: { v: 0 } }).ok, "valid id accepted");
const conflict = ds.remember({ id: "x", expectVersion: 999, payload: { v: 1 } });
ok(!conflict.ok && conflict.error.code === "Conflict", "version mismatch -> Conflict");
ds.setTunable("maxPayloadBytes", 64);
ok(ds.remember({ id: "big", payload: { s: "x".repeat(100) } }).error.code === "PayloadTooLarge", "oversized payload rejected");
ds.setTunable("maxPayloadBytes", DEFAULT_TUNABLES.maxPayloadBytes);
ok(ds.getNode("nope") === null, "getNode(missing) -> null");
ok(ds.setStatus("nope", "archived").error.code === "NotFound", "setStatus(missing) -> NotFound");

// ---- dag: depend / topo / ready frontier / ancestors+descendants / cycle ----
ds.depend("build", "scout"); ds.depend("review", "build"); ds.depend("ship", "review");
ok(!ds.topo().cyclic, "dependency dag is acyclic");
ok(ds.ready([]).includes("scout"), "scout is the initial ready frontier");
ok(ds.ready(["scout"]).includes("build"), "build is ready once scout is done");
ok(ds.ancestors("ship").includes("scout"), "ancestors reach the root");
ok(ds.descendants("scout").includes("ship"), "descendants reach the leaf");
const cyc = ds.depend("scout", "ship");
ok(!cyc.ok && cyc.error.code === "CycleRejected", "cyclic dependency rejected");

// ---- edges: link / guard+enforcement / weight validation / unlink ----------
ds.link("scout", "build"); ds.link("build", "review");
const shipEdge = ds.link("review", "ship", { guard: "vars.approved == true", enforcement: "hard" });
ds.link("review", "build");
ok(shipEdge.ok, "guarded hard edge created");
ok(!ds.link("scout", "build", { weight: -1 }).ok, "negative edge weight rejected");
const tmp = ds.link("scout", "review");
ok(ds.unlink(tmp.value.id).ok, "unlink removes an edge");
ok(ds.unlink("G-nope").error.code === "NotFound", "unlink(missing) -> NotFound");

// ---- zones: define / membership / deriveZone / ZoneNotFound ----------------
ds.defineZone("inner", ["scout", "build", "review"], { intra: "off", boundary: "soft" });
ok(ds.zonesOf("build").includes("inner"), "zonesOf reports membership");
ds.addToZone("inner", "ship"); ds.removeFromZone("inner", "ship");
ok(!ds.zonesOf("ship").includes("inner"), "add then remove zone membership");
ok(ds.deriveZone("scout").value.members.includes("build"), "deriveZone proposes reachable members");
ok(ds.addToZone("no-zone", "scout").error.code === "ZoneNotFound", "addToZone missing zone -> ZoneNotFound");

// ---- fsm: cursor / legalMoves / explain / allow+deny+warn transitions ------
ds.setCursor(["scout"]);
ok(ds.setCursor(["nope"]).error.code === "NotFound", "setCursor(missing) -> NotFound");
ok(ds.legalMoves().some((m) => m.to === "build"), "legalMoves lists build");
ok(ds.transition("build").value.applied, "scout->build applies (allow)");
ok(ds.transition("review").value.applied, "build->review applies");
ok(ds.explainTransition("ship").value.decision === "deny", "explain: unapproved ship denies");
ok(ds.transition("zzz").error.code === "NotFound", "transition to missing node -> NotFound");
const blocked = ds.transition("ship");
ok(!blocked.value.applied && !blocked.value.soft_warned && ds.cursor()[0] === "review", "unapproved ship hard-blocked, cursor holds");
const ship = ds.transition("ship", { approved: true });
ok(ship.value.applied && ship.value.soft_warned, "approved ship crosses soft boundary: warns + applies");

// ---- guard DSL: compile / eval / prototype-pollution rejection -------------
ok(compileGuard("vars.x > 1").ok, "guard compiles");
ok(!compileGuard("vars.x >").ok, "malformed guard -> parse error");
ok(evalGuard(compileGuard("vars.x == 2").value, { vars: { x: 2 } }) === true, "guard evaluates a true comparison");
ok(compileGuard("vars.__proto__ == 1").error.code === "GuardParseError", "guard compile rejects a __proto__ path");
ok(evalGuard(compileGuard("vars.missing == 1").value, { vars: {} }) === false, "missing guard key reads undefined -> comparison false");
ok(!compileGuard("vars.x == '\\q'").ok, "guard string rejects an unknown escape (only \\\\ \\\" \\' n r t)");

// ---- tunables: set persists / invalid rejected -----------------------------
ok(ds.setTunable("snapshotInterval", 50).ok && ds.getTunables().snapshotInterval === 50, "setTunable persists a knob");
ok(!ds.setTunable("bogusKnob", 1).ok, "unknown tunable rejected");
ok(!ds.setTunable("ucbC", 2).ok, "removed intuition tunable rejected as unknown");

// ---- checkpoint / rollback (exact projection restore) ----------------------
ds.setCursor(["review"]); ds.checkpoint("cp1");
ds.transition("build");
ok(ds.cursor()[0] === "build", "cursor diverged after the checkpoint");
ds.rollback("cp1");
ok(ds.cursor()[0] === "review", "rollback restored the cursor to review");
ok(ds.verifyIntegrity().ok, "hash-chain integrity intact after rollback");
ok(ds.rollback("nope").error.code === "CheckpointNotFound", "rollback(missing) -> CheckpointNotFound");
ok(ds.listCheckpoints().some((c) => c.name === "cp1"), "listCheckpoints returns named checkpoints");

// ---- evolve: mergeStates / splitState / migrate / gc ----------------------
const em = DState.open(":memory:", { seed: false });
for (const id of ["p", "q", "r"]) em.remember({ id, kind: "state", payload: {} });
em.link("p", "q"); em.setCursor(["q"]);
const mg = em.mergeStates("p", "q");
ok(mg.ok && em.getNode("q").status === "deprecated" && !em.cursor().includes("q"), "mergeStates deprecates b and moves cursor");
ok(em.mergeStates("p", "nope").error.code === "NotFound", "mergeStates missing node -> NotFound");
em.remember({ id: "s", kind: "state", payload: {} }); const seid = em.link("p", "s").value.id;
ok(em.splitState("p", "p2", [seid]).ok && em.getNode("p2") !== null, "splitState clones a node");
ok(em.migrate("state", () => { throw new Error("oops"); }).error.code === "MigrationError", "migrate throw -> MigrationError");
ok(em.migrate("state", (p) => ({ ...p, v: 1 })).ok, "migrate transforms all nodes of kind");
const gcR = em.gc(); ok(typeof gcR.deprecated === "object" && em.validate().ok, "gc returns deprecated list, leaves valid"); em.close();

// ---- observability: history / render / metrics / toDot --------------------
ok(ds.history({ type: "TransitionTaken", limit: 1 })[0]?.summary.includes("->"), "history returns annotated events");
ok(ds.render().startsWith("cursor:") && ds.metrics().nodes.total > 0 && ds.toDot().startsWith("digraph"), "render/metrics/toDot surface ok");

// ---- compose/vendoring: plan() atomic bulk builder + orient() snapshot ------
const pb = DState.open(":memory:", { seed: false });
ok(pb.plan({}).value.nodes.length === 0, "plan with an empty spec creates nothing");
ok(pb.plan({ nodes: ["a", { id: "b", payload: { k: 1 } }, "c"], transitions: [["a", "b"], ["b", "c", { guard: "vars.go == true" }]], deps: [["b", "a"], ["c", "b"]], zones: [{ name: "z", members: ["a", "b"], boundary: "hard" }], cursor: ["a"] }).ok, "plan builds nodes+edges+zones atomically");
ok(JSON.stringify(pb.cursor()) === JSON.stringify(["a"]) && pb.ready([]).join() === "a" && pb.zonesOf("a").includes("z"), "plan sets cursor, dep frontier is the root, zone applied");
const seq0 = pb.store.lastSeq();
ok(pb.plan({ nodes: ["d"], transitions: [["d", "a", { guard: "vars.x ==" }]] }).error.code === "GuardParseError", "plan rejects a bad guard");
ok(pb.plan({ deps: [["a", "c"]] }).error.code === "CycleRejected" && pb.plan({ nodes: ["e", "e"] }).error.code === "DuplicateId" && pb.store.lastSeq() === seq0 && pb.getNode("d") === null, "plan: invalid specs are rejected and write nothing");
const o = pb.orient({ go: true }); ok(o.cursor[0] === "a" && o.legalMoves[0].to === "b" && o.integrity_ok && !o.done, "orient returns a coherent situational snapshot");
pb.close();

// ---- appendMany atomicity: a bad draft mid-batch leaves zero applied -------
const am = DState.open(":memory:", { seed: false });
const sBefore = am.store.lastSeq();
try { am.store.appendMany([{ type: "ConfigSet", payload: { key: "a", value: 1 } }, { type: "X", get payload() { throw new Error("boom"); } }]); } catch { /* expected */ }
ok(am.store.lastSeq() === sBefore && am.store.getConfig("a") === undefined, "appendMany rolls back fully on a mid-batch throw"); am.close();

// ---- durability: state survives a real close / reopen ----------------------
const before = ds.cursor().slice().sort();
ds.close();
ds = DState.open(FILE, { seed: false, lock: true });
ok(JSON.stringify(ds.cursor().slice().sort()) === JSON.stringify(before), "cursor survives close/reopen");
ok(ds.getNode("scout") !== null && ds.getNode("doc").status === "archived", "memory + status survive reopen");

// ---- crash recovery: a torn trailing event is trimmed; good state survives --
const head = ds.store.lastSeq();
ds.store.events.push({ seq: head + 1, id: "ETORN", type: "TransitionTaken", ts: 1, payload: {}, checksum: "torn", prevHash: "torn", hash: "torn" });
const rec = ds.store.recover();
ok(rec.trimmed === 1, "recovery trims the torn trailing event");
ok(ds.verifyIntegrity().ok && ds.validate().ok, "state is consistent after recovery");

// ---- portability: export and reconstruct an identical projection -----------
const bundle = ds.export();
const clone = importState(":memory:", bundle);
ok(clone.getNode("scout") !== null && clone.verifyIntegrity().ok, "export/import reproduces a valid store");
ok(JSON.stringify(clone.cursor().sort()) === JSON.stringify(ds.cursor().sort()), "cloned cursor matches the source");
clone.close();

// ---- surface sync (no describe() drift) + bounded tail reads ---------------
ok(Object.values(MANIFEST.verbs).flat().every((v) => typeof ds[v[0]] === "function"), "every manifest verb resolves to a real DState method");
const t2 = ds.store.readEvents({ type: "TransitionTaken", limit: 2 });
ok(t2.length === 2 && t2[0].seq < t2[1].seq, "readEvents limit tail-reads the last n in ascending seq");
ds.close();
console.log(`integration witness OK: ${n} assertions across a full agent session (memory/dag/fsm/enforce/zone/guard/evolve/checkpoint/durable/recover/port/plan/errors)`);
cleanup();
