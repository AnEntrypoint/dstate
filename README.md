# adaptogen

An agent-owned state machine. One LLM agent interacts with it directly -- there
is no second model in the loop. The agent builds a graph that is, at the same
time, its **memory** and its transition **policy**, and keeps reshaping that
graph while it works.

The graph is a hybrid:

- a **DAG** of dependency edges (what must happen before what), kept acyclic, and
- an **FSM** of transition edges (which state can follow which), with a cursor the
  agent moves along.

Every node is a memory cell (its `payload`). Every transition edge carries policy
(a guard plus soft/hard enforcement). Zones let the agent fence off "safe limited
transition zones" it may move within freely while crossing their boundary stays
governed.

```
  memory            policy
  (node.payload)    (guard + enforcement + zones)
        \                |
         +----------- one graph ----------+
                 DAG (deps) + FSM (transitions)
```

There is no database, no embeddings, and no learned ranking: the state lives in
memory as an append-only event log folded into a projection, and persists to a
plain, portable JSON bundle on disk.

## Vendor your own state machine

The whole configuration is a declarative JSON spec you hand to `plan()` (or the
`plan` CLI verb). Copy [`examples/fsm.spec.json`](examples/fsm.spec.json), change
the nodes/transitions/zones, and ship your own machine -- no need to touch the
library:

```json
{
  "nodes": [{ "id": "research" }, { "id": "draft" }, { "id": "review" }, { "id": "ship" }],
  "transitions": [
    ["research", "draft"],
    ["draft", "review"],
    ["review", "ship", { "guard": "vars.approved == true", "enforcement": "hard" }]
  ],
  "deps": [["draft", "research"], ["review", "draft"], ["ship", "review"]],
  "zones": [{ "name": "safe", "members": ["research", "draft", "review"], "intra": "off", "boundary": "hard" }],
  "cursor": ["research"]
}
```

`plan()` validates the whole spec -- ids, endpoints, guard compilation, weights,
batch dependency-acyclicity, zones, cursor -- and only then writes. On the first
problem it returns one `Result` fail naming the offending item by index and
writes **nothing** (no partial graph). An endpoint resolves if it already exists
or is declared in `spec.nodes`, so fresh and existing nodes wire together in one
shot. The default seed graph is itself just a spec (`DEFAULT_SPEC`).

## Use it from the shell (npx)

No install, no Bun, no build step, no native dependency -- the CLI runs under
plain Node, so an agent reaches the entire surface through one binary:

```
npx -y adaptogen orient                              # one situational snapshot
npx -y adaptogen remember plan --payload '{"goal":"ship"}'
npx -y adaptogen plan --spec "$(cat examples/fsm.spec.json)"   # load your machine
npx -y adaptogen transition draft --vars '{"approved":true}'
npx -y adaptogen describe                            # machine-readable manifest
```

The store defaults to `./adaptogen.json` (project-resident and portable); pass
`--db <file>` to choose another, or `--db :memory:` for an ephemeral run. Run
`npx -y adaptogen help` for the full command list and `describe` for every verb,
error code, and the guard DSL grammar.

## Install / run

```
bun install       # (or: npm install) -- no runtime dependencies
bun test.js       # end-to-end integration witness  (node test.js also works)
bun run bench     # large-graph hot loop + recovery timing
```

The runtime is buildless JavaScript (ES modules, no compile step) and depends on
nothing but the Node standard library (`node:crypto`, `node:fs`). Bun is used to
run the test and bench, but the library itself runs under plain Node.

## Quick start

```js
import { Adaptogen } from "adaptogen"; // `DState` is also exported as an alias

const ds = Adaptogen.open("./agent.json"); // loads + recovers + locks + seeds

ds.remember({ id: "research", payload: { topic: "caches" } }); // memory
ds.remember({ id: "draft" });
ds.link("research", "draft");          // a transition edge
ds.depend("draft", "research");        // draft depends on research (DAG)

ds.setCursor(["research"]);
ds.transition("draft");                // move the cursor along the FSM

console.log(ds.render());              // ASCII live view of the current state
ds.close();                            // writes the JSON bundle to disk
```

## Orient before acting

A cold or returning agent reads one snapshot instead of stitching together
`legalMoves`/`ready`/`validate`/`history`:

```js
const o = ds.orient();
// { cursor, legalMoves, blocked:[{to,reasons}], ready,
//   violations, integrity_ok, recent, seq, tunables, done }
if (!o.done && o.integrity_ok && o.legalMoves[0]) ds.transition(o.legalMoves[0].to);
```

## Guard DSL

A transition edge can carry a guard: a sandboxed boolean expression (never
`eval`) evaluated against a read-only context. It is loop-free and depth/length
bounded; an unknown path reads as `undefined` (comparisons against it are
false), so a guard never throws.

Context: `from`, `to`, `fromTags`, `toTags`, `fromKind`, `toKind`, `edge.label`,
`edge.weight`, and `vars.*` (passed per `transition(to, vars)`). Operators:
`&& || ! == != > >= < <=` plus `in` (membership in a literal array) and `has`
(array/string contains).

```js
ds.link("review", "ship", { guard: "vars.approved == true" });
ds.link("draft", "review", { guard: "toTags has 'ready'" });
```

Full grammar, operators, and examples are in `describe().guardDSL`.

## The verb surface

Compose / vendor

- `plan({nodes, transitions, deps, zones?, cursor?})` -- one atomic, all-or-nothing call that turns a spec into a graph; validated in full before anything is written, so a failure leaves zero events and names the offending item by index. This is the vendoring surface.
- `orient(vars?)` -- one situational snapshot: `{cursor, legalMoves, blocked, ready, violations, integrity_ok, recent, seq, tunables, done}`. Pure read.

Memory

- `remember({id, kind?, label?, payload?, tags?, status?, expectVersion?})` -- create/update a node; `payload` is the memory. Optimistic concurrency via `expectVersion`.
- `recall({id?|kind?|tag?|status?|text?, limit?})` -- query nodes by id/kind/tag/status, or a case-insensitive substring over label+payload (`text`). Not ranked, no vectors.
- `getNode(id)`, `setStatus(id, status)`, `archive(id)`, `deprecate(id)`.

Structure

- `link(from, to, {id?, kind?, label?, guard?, enforcement?, weight?})` -- transition or dependency edge. `weight` must be a finite number `>= 0`.
- `depend(node, prereq)` -- dependency edge; rejected with the cycle path if it would close a loop.
- `unlink(edgeId)`, `setEnforcement(edgeId, mode)`.
- `ready(done?)`, `topo()`, `reachable(from, kind?)`, `ancestors(id)`, `descendants(id)`.

FSM

- `setCursor(nodes)`, `cursor()`.
- `transition(to, vars?)` -- legality + guard + zone + enforcement + record, all at once. Returns a decision trace.
- `legalMoves(vars?)`, `explainTransition(to, vars?)`.

Zones (safe limited transition zones)

- `defineZone(name, members, {intra?, boundary?})`, `addToZone`, `removeFromZone`, `zonesOf(id)`, `zones()`.
- `deriveZone(seed, predicate?)` -- the agent maps out a safe zone automatically from the reachable subset satisfying a guard predicate, then ratifies it.

Self-evolution

- `splitState`, `mergeStates`, `gc`, `migrate(kind, fn)` -- pure structural transforms, all replayable through the event log.

Durability & integrity

- `checkpoint(name)`, `rollback(name)`, `branch(file)`/`discard()`.
- `snapshot()`, `compact(retain?)`.
- `validate()`, `repair()`, `verifyIntegrity()`.

Observe & port

- `render()`, `metrics()`, `toMermaid()`, `toDot()`, `history(filter?)`.
- `describe()` -- machine-readable manifest of the whole verb surface, error codes, guard DSL grammar, and enforcement levels.
- `export()` / `importState(file, bundle)`.
- `setTunable(key, value)` / `getTunables()`.

## Soft vs hard enforcement

A transition is allowed unless a policy reason applies: a failing guard, a zone
boundary crossing, or an above-`off` intra-zone policy. Each reason is governed
by an enforcement mode and the strictest decision wins:

- `off` -- allowed (a note in the trace).
- `soft` -- allowed, but flagged (a `SoftViolation` is recorded).
- `hard` -- blocked; a `BlockedAttempt` is recorded with the reason; the cursor
  does not move.

Enforcement is static: an edge is `off`/`soft`/`hard` as authored and never
auto-promotes or demotes. Edge enforcement overrides zone, which overrides the
global default. An edge set to `off` is the explicit **gate** that lets an
otherwise-blocked crossing through. `explainTransition` returns the full trace.

## Durability model

- The event log is hash-chained and checksummed; the queryable graph is a pure,
  deterministic fold (projection) of it.
- On open, the JSON bundle is loaded and replayed; boot `recover()` verifies the
  chain, trims a torn/partial trailing event to the last good seq, loads the
  newest snapshot at/under head, and replays the tail.
- `close()`/`save()` writes the full history back to the JSON file atomically
  (temp + rename). On-disk durability is **snapshot-on-save**, not per-append:
  events since the last save are lost if the process dies before saving.
- Snapshots + `compact()` bound replay cost; `export()`/`importState()` round-trip
  the whole history as portable JSON.

## CLI

The CLI is a thin shell over the JS facade; an agent can drive a full session
(inspect and mutate) without writing JS. ASCII output, conventional exit codes,
`--json` for parseable status/history.

Inspect:

```
adaptogen status --db ./agent.json   # cursor, legal moves, ready frontier, violations
adaptogen describe                   # machine-readable manifest (verbs, errors, guard DSL, tunables)
adaptogen graph / dot                # mermaid / graphviz export
adaptogen explain <to>               # decision trace
adaptogen legal-moves [--vars '<json>']
adaptogen validate                   # invariants + integrity (exit 1 if invalid)
adaptogen history [n] [--json]
adaptogen get <id>
adaptogen recall --text <q> [--kind --tag --status --limit]
```

Mutate / vendor:

```
adaptogen plan --spec '<json>'       # load a whole machine atomically (vendoring)
adaptogen remember <id> [--kind --label --payload '<json>' --tags a,b]
adaptogen link <from> <to> [--kind --label --guard '<expr>' --enforcement --weight]
adaptogen depend <node> <prereq>
adaptogen unlink <edgeId> / enforce <edgeId> <off|soft|hard>
adaptogen archive <id> / deprecate <id>
adaptogen cursor [ids...]            # print cursor, or set it
adaptogen transition <to> [--vars '<json>']
adaptogen zone-define <name> <id,id,...> [--intra ...] [--boundary ...]
adaptogen zone-add / zone-remove / zone-list
adaptogen checkpoint <name> / rollback <name> / checkpoints
adaptogen compact [retain] / export <file> / import <file>
```

License: MIT.
