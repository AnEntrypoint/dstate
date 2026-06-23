# AGENTS.md -- hard rules for working in adaptogen

adaptogen is an agent-owned, self-evolving DAG+FSM state store. These are the
load-bearing invariants. Any agent (or human) changing this code keeps them.

Runtime: buildless JavaScript (ES modules, no types, no compile step); runs on
plain Node or Bun with NO native/runtime dependency.
Persistence: in-memory event log + projection, persisted to a portable JSON
bundle on disk (`export()`/`save()` write it, `DState.open` loads+replays it).
There is no database, no embeddings, no learned ranking. On-disk durability is
snapshot-on-save (atomic temp+rename), not per-append.

## Architecture (do not route around)

- The event log (the `Store.events` array) is the single source of truth.
  `Store.append` is the ONLY mutation path. Every projection structure (`nodes`,
  `edges`, `zones`, `zoneMembers`, `cursorSet`, `metaMap`) is a pure,
  deterministic fold of the log: `rebuild()` must always reproduce the live
  projection exactly. If you add state, add an event type and an `applyEvent`
  case -- never write a projection structure directly from a feature. Snapshots
  and checkpoints are durable side tables (NOT projection): `clearProjection()`
  must not clear them, so a rollback past a CheckpointCreated event still leaves
  the checkpoint reachable.
- Never hard-delete history. Nodes are archived/deprecated, edges are removed via
  `EdgeRemoved` events, and the log is only trimmed by recovery (torn tail) or an
  explicit rollback/compaction. Audit survives.
- Every event is checksummed and hash-chained. Do not weaken `hash.js`; recovery
  and integrity depend on a break being localizable to one seq.

## Agent-facing surface

- Agent input never throws. Public `DState` verbs return `Result<T, DStateError>`
  with a typed code. Internal invariant breaches (adaptogen is itself wrong) may
  throw; bad agent input may not.
- Guards are the `guard.js` DSL only. NEVER `eval`/`Function`/dynamic import on
  agent-authored strings. The DSL is loop-free, depth- and length-bounded, and
  reads context via own-property lookups that reject `__proto__`/`constructor`/
  `prototype`. Keep it that way.
- No agent input is ever interpolated into executable code or a query language;
  recall is a plain in-memory field/substring filter. Ids are charset-validated;
  payloads are size-capped.

## Output

- ASCII only in rendered/exported output. Arrows are `->`, not a glyph. No
  emojis, bullets, or decorative unicode in `render.js`/CLI output (`ascii()`
  strips them defensively; do not defeat it).

## Memory & portability

- State is project-resident and portable: `export()`/`importState` round-trip the
  full history into plain JSON. Do not introduce platform-resident or
  machine-local state that cannot be exported.

## Change discipline

- Data model first: if control flow gets convoluted, fix the shape, not the flow.
- A change that regresses a green test is reverted first, diagnosed second.
- The code is plain JavaScript: there is no `tsc`/type gate. Commit only with
  `bun test.js` (the integration witness) passing and `bun run bench` under budget
  (per-step transition+suggest stays flat as the graph grows; the bench fails on an
  O(n) regression). Push only on a clean tree.
- Tests are ONE file: `test.js` at repo root, 200-line ceiling, real services, no mocks (contract in rs-learn). New behavior -> assertion in `test.js`, not a new file.

@.gm/next-step.md
