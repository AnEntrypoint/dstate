// Machine-readable self-description so an agent can introspect adaptogen's full
// surface without reading source: the verbs it can call, the typed error codes a
// Result may carry, the guard DSL grammar, and the enforcement levels. Pure data
// plus describe(); ASCII only.

import { ERROR_CODES } from "./errors.js";
import { DEFAULT_TUNABLES } from "./config.js";

export const MANIFEST = {
  name: "adaptogen",
  summary:
    "Agent-owned DAG+FSM state store: durable memory and transition policy in one event-sourced, in-memory graph; vendor your own machine as a JSON spec.",
  enforcement: {
    levels: ["off", "soft", "hard"],
    meaning: {
      off: "transition always allowed (an explicit gate through a boundary)",
      soft: "transition warned and recorded as a soft violation, still applied",
      hard: "transition denied (BlockedAttempt recorded, cursor does not move)",
    },
    precedence: "edge enforcement overrides zone, which overrides defaultEnforcement; strictest deciding reason wins. Enforcement is static: off/soft/hard as authored, never auto-changed.",
  },
  errorCodes: ERROR_CODES,
  errorHints: {
    NotFound: "the id does not exist; create it (remember/link) or query getNode/recall first",
    DuplicateId: "an id collision; choose a fresh id or upsert the existing one",
    InvalidInput: "malformed argument (bad id charset, non-finite weight, empty cursor); fix the value",
    PayloadTooLarge: "payload exceeds maxPayloadBytes; shrink it or raise the tunable",
    CycleRejected: "a dependency edge would close a loop; reorder or drop an edge (details.cycle has the path)",
    IllegalTransition: "no enabled edge from the cursor to the target; check legalMoves()",
    HardBlocked: "a hard enforcement reason denied the move; setEnforcement(edge,'off') to gate, or pick another move",
    GuardParseError: "the guard DSL string did not compile; see the message for the offending token",
    IntegrityBroken: "hash-chain break or unreadable store file; run verifyIntegrity()/repair(), restore from a checkpoint",
    LockHeld: "another writer holds the store lock; close it or open with lock:false (single-writer only)",
    Conflict: "optimistic-concurrency or branch mismatch; re-read and retry",
    ZoneNotFound: "no such zone; defineZone() first or check zones()",
    CheckpointNotFound: "no checkpoint by that name; listCheckpoints()",
    MigrationError: "the migrate() apply fn threw or returned an invalid node; see the message",
    InvalidConfig: "tunable out of range; see tunables.ranges",
  },
  guardDSL: {
    summary:
      "loop-free, depth- and length-bounded predicate over a read-only context; no eval/Function; own-property paths only (rejects __proto__/prototype/constructor)",
    operators: ["&&", "||", "!", "==", "!=", ">", ">=", "<", "<=", "in", "has"],
    literals: ["number", "'string'", "true", "false", "null", "[a, b, ...]"],
    context: [
      "from", "to", "fromTags", "toTags", "fromKind", "toKind",
      "edge.label", "edge.weight",
      "vars.*",
    ],
    missingKey: "an unknown path reads as undefined; comparisons against it are false (a guard never throws on a missing key)",
    operatorNotes: "'in': membership in a literal array (x in [a,b]); 'has': array/string contains (fromTags has 'urgent')",
    examples: [
      "vars.approved == true",
      "fromKind == 'state' && toKind == 'state'",
      "toTags has 'safe' || edge.weight >= 2",
      "!(vars.dryRun == true)",
    ],
  },
  verbs: {
    compose: [
      ["plan", "({ nodes:[id|{id,kind?,label?,payload?,tags?,status?}], transitions:[[from,to,opts?]|{from,to,...opts}], deps:[[node,prereq]|{node,prereq}], zones?:[{name,members,intra?,boundary?}], cursor?:[id] }) -> Result<{nodes,transitions,deps,zones,cursor}> -- atomic, all-or-nothing bulk graph builder; validates the whole spec (ids, endpoints, guards, weights, batch acyclicity, zones, cursor) before writing anything, so a failure leaves zero events. This is the vendoring surface: ship your own FSM as a JSON spec. An endpoint resolves if pre-existing OR declared in spec.nodes."],
      ["orient", "(vars?) -> { cursor, legalMoves, blocked[{to,reasons}], ready, violations, integrity_ok, recent, seq, tunables, done } -- one situational snapshot a cold/returning agent reads to decide its next move; pure read."],
    ],
    memory: [
      ["remember", "{ id, kind?, label?, payload?, tags?, status?, expectVersion? } -> Result<DNode>"],
      ["getNode", "(id) -> DNode | null"],
      ["recall", "({ id?, kind?, tag?, status?, text?, limit? }) -> DNode[] (exact field + case-insensitive substring; not ranked)"],
      ["setStatus", "(id, status) -> Result<DNode>"],
      ["archive", "(id) -> Result<DNode>"],
      ["deprecate", "(id) -> Result<DNode>"],
    ],
    edges: [
      ["link", "(from, to, { id?, kind?, label?, guard?, enforcement?, weight? }) -> Result<DEdge>; weight must be a finite number >= 0"],
      ["depend", "(node, prereq, opts?) -> Result<DEdge>"],
      ["unlink", "(edgeId) -> Result<true>"],
      ["setEnforcement", "(edgeId, mode) -> Result<DEdge>"],
    ],
    fsm: [
      ["cursor", "() -> NodeId[]"],
      ["setCursor", "(nodes) -> Result<NodeId[]>"],
      ["legalMoves", "(vars?) -> MoveInfo[] (each: edgeId,to,from,decision,enforcement)"],
      ["explainTransition", "(to, vars?) -> Result<DecisionTrace>"],
      ["transition", "(to, vars?) -> Result<TransitionOutcome>"],
    ],
    dag: [
      ["ready", "(done?) -> NodeId[]"],
      ["topo", "() -> { order, cyclic }"],
      ["reachable", "(from, kind?) -> NodeId[]"],
      ["ancestors", "(of, kind?) -> NodeId[]"],
      ["descendants", "(of, kind?) -> NodeId[]"],
    ],
    zones: [
      ["defineZone", "(name, members, { intra?, boundary? }) -> Result<Zone>"],
      ["addToZone", "(name, node) -> Result<Zone>"],
      ["removeFromZone", "(name, node) -> Result<Zone>"],
      ["zonesOf", "(node) -> ZoneName[] (the zones a node belongs to)"],
      ["deriveZone", "(seed, predicate?) -> Result<{ members }>"],
      ["zones", "() -> Zone[]"],
    ],
    evolve: [
      ["splitState", "(nodeId, newId, moveEdgeIds) -> Result"],
      ["mergeStates", "(a, b) -> Result"],
      ["gc", "() -> { deprecated, prunedEdges }"],
      ["migrate", "(kind, apply, toVersion?) -> Result"],
    ],
    integrity: [
      ["validate", "() -> ValidationReport"],
      ["repair", "() -> { fixed, quarantined }"],
      ["verifyIntegrity", "() -> IntegrityReport"],
    ],
    durability: [
      ["checkpoint", "(name) -> Result<{ seq }>"],
      ["rollback", "(name) -> Result<{ seq }>"],
      ["listCheckpoints", "() -> { name, seq }[]"],
      ["branch", "(filename) -> Result<DState>"],
      ["merge", "(branchDs) -> Result<{ merged }>"],
      ["discard", "() -> void"],
      ["snapshot", "() -> string"],
      ["compact", "(retain?) -> { snapshotId, pruned }"],
      ["export", "() -> ExportBundle"],
    ],
    config: [
      ["getTunables", "() -> Tunables"],
      ["setTunable", "(key, value) -> Result<Tunables>"],
    ],
    observe: [
      ["render", "() -> string (ASCII live view)"],
      ["metrics", "() -> Metrics"],
      ["toMermaid", "() -> string"],
      ["toDot", "() -> string"],
      ["history", "(filter?) -> HistoryEntry[]"],
      ["describe", "() -> this manifest"],
    ],
  },
  zones: {
    summary: "named safe-transition regions the agent may move within freely while crossing the boundary stays governed",
    meaning: {
      intra: "enforcement applied to moves that stay inside the zone",
      boundary: "enforcement applied to moves that cross the zone edge",
      defineZone: "declare a zone over explicit members",
      deriveZone: "auto-derive members from the reachable subset satisfying a guard predicate, then ratify them as a zone",
    },
  },
  tunables: {
    summary: "agent-settable knobs (setTunable/getTunables); each is range-checked, an out-of-range value is an InvalidConfig Result",
    defaults: DEFAULT_TUNABLES,
    ranges: {
      defaultEnforcement: "off|soft|hard",
      snapshotInterval: "integer >= 0",
      retain: "integer >= 0",
      maxPayloadBytes: "integer >= 64",
    },
    meaning: {
      defaultEnforcement: "policy applied when neither edge nor zone overrides it",
      snapshotInterval: "events between automatic snapshots; bounds recovery replay cost (0 disables)",
      retain: "events retained behind the snapshot on compact()",
      maxPayloadBytes: "cap on a node payload's JSON size",
    },
  },
  patterns: {
    summary: "worked, runnable agent flows (ASCII only); copy and adapt",
    vendor_a_machine: [
      "// Ship your own FSM as a plain JSON spec -- this IS the config surface.",
      "const r = ds.plan({",
      "  nodes: ['research', { id: 'draft', payload: { words: 0 } }, 'review', 'ship'],",
      "  transitions: [['research', 'draft'], ['draft', 'review'], ['review', 'ship', { guard: \"vars.approved == true\", enforcement: 'hard' }]],",
      "  deps: [['draft', 'research'], ['review', 'draft'], ['ship', 'review']],",
      "  zones: [{ name: 'safe', members: ['research', 'draft', 'review'], intra: 'off', boundary: 'hard' }],",
      "  cursor: ['research'],",
      "});",
      "if (!r.ok) console.log(r.error.code, r.error.message); // names the offending item by index",
    ],
    orient_then_act: [
      "// A cold or returning agent reads one snapshot, then moves.",
      "const o = ds.orient();",
      "// o: { cursor, legalMoves, blocked, ready, violations, integrity_ok, recent, done }",
      "if (!o.done && o.integrity_ok && o.legalMoves[0]) ds.transition(o.legalMoves[0].to);",
    ],
    minimal_session: [
      "const ds = Adaptogen.open('./agent.json');",
      "ds.remember({ id: 'plan', payload: { goal: 'ship' } });",
      "ds.remember({ id: 'exec' });",
      "ds.link('plan', 'exec');",
      "ds.setCursor(['plan']);",
      "const r = ds.transition('exec');",
      "ds.close(); // writes the JSON bundle to disk",
    ],
    checkpoint_rollback: [
      "ds.checkpoint('before-risky');",
      "const r = ds.transition('risky');",
      "if (!ds.validate().ok) ds.rollback('before-risky');",
    ],
    zones: [
      "ds.defineZone('safe', ['a', 'b'], { intra: 'off', boundary: 'hard' });",
      "// or auto-derive from a reachable predicate, then ratify:",
      "ds.deriveZone('a', \"toTags has 'safe'\");",
    ],
  },
};
