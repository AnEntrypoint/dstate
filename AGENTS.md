# AGENTS.md -- hard rules for working in adaptogen

adaptogen is an agent-owned, self-evolving DAG+FSM state store. These are the
load-bearing invariants. Any agent (or human) changing this code keeps them.

Runtime: buildless JavaScript (ES modules, no types, no compile step) on Bun.
Persistence: synchronous libsql client behind `db.js` facade -- use `openDatabase`; never import a SQLite driver directly (facade detail in rs-learn).

## Architecture (do not route around)

- The event log (`events` table) is the single source of truth. `Store.append`
  is the ONLY mutation path. Every projection table (`nodes`, `edges`, `zones`,
  `zone_members`, `stats`, `cursor`) is a pure, deterministic fold of the log:
  `rebuild()` must always reproduce the live projection exactly. If you add state,
  add an event type and an `applyEvent` case -- never write a projection table
  directly from a feature.
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
- All SQL is parameterized. No string interpolation of agent input into SQL or
  FTS queries. Ids are charset-validated; payloads are size-capped.

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
