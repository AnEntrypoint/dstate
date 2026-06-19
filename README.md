# adaptogen

An agent-owned, self-evolving state system. One LLM agent interacts with it
directly -- there is no second model in the loop. The agent builds a graph that
is, at the same time, its **memory**, its **policy**, and its **intuition**, and
keeps reshaping that graph while it works.

The graph is a hybrid:

- a **DAG** of dependency edges (what must happen before what), kept acyclic, and
- an **FSM** of transition edges (which state can follow which), with a cursor the
  agent moves along.

Every node is a memory cell (its `payload`). Every transition edge carries policy
(a guard plus soft/hard enforcement) and accrues intuition (visit/reward stats
that drive `suggest()`). Zones let the agent fence off "safe limited transition
zones" it may move within freely while crossing their boundary stays governed.

```
  memory            policy                 intuition
  (node.payload)    (guard + enforcement)  (edge stats -> suggest)
        \                |                      /
         \               |                     /
          +----------- one graph --------------+
                 DAG (deps) + FSM (transitions)
```

## Use it from the shell (npx)

No install, no Bun, no build step -- the CLI runs under plain Node, so an agent
reaches the entire surface through one binary:

```
npx -y adaptogen orient                              # one situational snapshot
npx -y adaptogen remember plan --payload '{"goal":"ship"}'
npx -y adaptogen plan --spec '{"nodes":["a","b"],"transitions":[["a","b"]],"cursor":["a"]}'
npx -y adaptogen step --reward 1                      # pick -> move -> reinforce
npx -y adaptogen describe                             # machine-readable manifest
```

The store defaults to `./adaptogen.db` (project-resident and portable); pass
`--db <file>` to choose another, or `--db :memory:` for an ephemeral run. Run
`npx -y adaptogen help` for the full command list and `describe` for every verb,
error code, and the guard DSL grammar.

### Enforce it as a Claude Code skill

This repo ships an Agent Skill at [`.claude/skills/adaptogen/`](.claude/skills/adaptogen/SKILL.md)
that routes every juncture of a task -- orient, plan, transition, reward,
checkpoint, recall -- through `npx adaptogen`, so durable state never lives only
in an agent's prose. It is active automatically when Claude Code runs inside this
repo. To adopt it in another project, copy or symlink that directory into the
project's `.claude/skills/` (it is included in the published npm package under the
same path).

## Why event-sourced over SQLite

The spine is an append-only, hash-chained event log; the queryable graph is a
projection of it (SQLite via libsql, WAL). This gets durability, crash recovery,
time-travel, audit, and deterministic replay from one mechanism, which is exactly
what "construct your own persistence and continuously evolve it reliably" needs.

It is buildless JavaScript (ES modules, no compile step) on Bun, persisting
through a synchronous `libsql` client behind a thin db facade. Dependencies were
surveyed and the FSM/graph libraries rejected in favor of a smaller maintained
surface:

- **XState** models statically-declared machines with code guards; adaptogen's
  machine is constructed and mutated at runtime, carries intuition + persistence,
  and runs agent-authored guards through a sandboxed DSL (never `eval`). Poor fit.
- **graphology** is in-memory only; topo sort and cycle detection are ~20 lines
  here and must integrate with the persistent projection anyway.
- **libsql** is the one runtime dependency: a synchronous SQLite that runs under
  Bun and plain Node, keeping the store portable off Bun while staying buildless.

Net: libsql + hand-rolled small graph algorithms + no FSM library.

## Install / run

```
bun install
bun test          # unit tests
bun test.js       # end-to-end integration witness
bun run bench     # large-graph hot loop + recovery timing
```

Requires Bun and the `libsql` package. SQLite with FTS5 is used for recall, with
a LIKE fallback when FTS5 is absent.

## Quick start

```js
import { Adaptogen } from "adaptogen"; // `DState` is also exported as an alias

const ds = Adaptogen.open("./agent.db"); // recovers, locks, seeds a starter model

ds.remember({ id: "research", payload: { topic: "caches" } }); // memory
ds.remember({ id: "draft" });
ds.link("research", "draft");          // a transition edge
ds.depend("draft", "research");        // draft depends on research (DAG)

ds.setCursor(["research"]);
ds.transition("draft");                // move the cursor along the FSM
ds.reward(1);                          // reinforce the path just taken

console.log(ds.render());              // ASCII live view of the current state
ds.close();
```

## Driving it as an agent

The tight loop -- rank the legal moves, take the best, learn from the result --
is one call. `step()` composes `suggest -> transition -> reward` and tells you
what happened and whether anything is left:

```js
const ds = Adaptogen.open("./agent.db");
ds.setCursor(["plan"]);

let s = ds.step({ reward: 1 });          // take the top-ranked move, reward it
while (s.ok && !s.value.done) {
  // s.value: { to, suggestion{breakdown}, applied, soft_warned, denied, done }
  s = ds.step({ reward: 1 });
}
```

`step({ to })` forces a target; omit `reward` to move without reinforcing. On a
dead end it returns a typed `NoMoves` fail whose `error.details.hint` names the
recovery. Every `Result` failure an agent can hit carries such a `hint`, and
`describe().errorHints` maps each code to its recovery. `describe().patterns`
holds runnable snippets for the common flows (step loop, checkpoint/rollback,
reward decay, zones), so a cold agent learns usage without reading source.

### Build a workflow in one call

Going from a mental plan to the graph used to be many `remember`/`link`/`depend`
calls. `plan()` does it atomically: validate the whole spec -- ids, endpoints,
guard compilation, weights, batch dependency-acyclicity, cursor -- and only then
write. On the first problem it returns one `Result` fail naming the offending
item by index and writes **nothing** (no partial graph). An endpoint resolves if
it already exists or is declared in `spec.nodes`, so fresh and existing nodes
wire together in one shot.

```js
const r = ds.plan({
  nodes: ["research", { id: "draft", payload: { words: 0 } }, "review", "ship"],
  transitions: [["research", "draft"], ["draft", "review"], ["review", "ship", { guard: "vars.approved == true" }]],
  deps: [["draft", "research"], ["review", "draft"], ["ship", "review"]],
  cursor: ["research"],
});
if (!r.ok) console.log(r.error.code, r.error.message);
```

### Orient before acting

A cold or returning agent reads one snapshot instead of stitching together
`suggest`/`legalMoves`/`ready`/`validate`/`history`:

```js
const o = ds.orient();
// { cursor, suggestions, legalMoves, blocked:[{to,reasons}], ready,
//   violations, integrity_ok, recent, seq, ftsEnabled, tunables, done }
if (!o.done && o.integrity_ok) ds.step({ reward: 1 });
```

## Guard DSL

A transition edge can carry a guard: a sandboxed boolean expression (never
`eval`) evaluated against a read-only context. It is loop-free and depth/length
bounded; an unknown path reads as `undefined` (comparisons against it are
false), so a guard never throws.

Context: `from`, `to`, `fromTags`, `toTags`, `fromKind`, `toKind`, `edge.label`,
`edge.weight`, `stat.visits`, `stat.emaReward`, `stat.successes`,
`stat.failures`, and `vars.*` (passed per `transition(to, vars)`). Operators:
`&& || ! == != > >= < <=` plus `in` (membership in a literal array) and `has`
(array/string contains).

```js
ds.link("review", "ship", { guard: "stat.failures == 0 && vars.approved == true" });
ds.link("draft", "review", { guard: "toTags has 'ready'" });
```

Full grammar, operators, and examples are in `describe().guardDSL`.

## The verb surface

Compose (the two highest-leverage entrypoints)

- `plan({nodes, transitions, deps, cursor?})` -- one atomic, all-or-nothing call that turns a mental plan into a graph: the whole spec is validated (ids, endpoints, guards, weights, batch acyclicity, cursor) before anything is written, so a failure leaves zero events and names the offending item by index. An endpoint resolves if it pre-exists or is declared in `nodes`.
- `orient(vars?)` -- one situational snapshot a cold or returning agent reads to decide its next move: `{cursor, suggestions, legalMoves, blocked, ready, violations, integrity_ok, recent, seq, ftsEnabled, tunables, done}`. Pure read.

Memory

- `remember({id, kind?, label?, payload?, tags?, status?, expectVersion?})` -- create/update a node; `payload` is the memory. Optimistic concurrency via `expectVersion`.
- `recall({id?|kind?|tag?|status?|text?|embedding?, limit?})` -- query nodes by id/kind/tag/status, full-text (FTS5, LIKE fallback), or cosine similarity over a supplied `embedding`.
- `getNode(id)`, `setStatus(id, status)`, `archive(id)`, `deprecate(id)`.

Structure

- `link(from, to, {id?, kind?, label?, guard?, enforcement?, weight?})` -- transition or dependency edge. `weight` must be a finite number `>= 0`.
- `depend(node, prereq)` -- dependency edge; rejected with the cycle path if it would close a loop.
- `unlink(edgeId)`, `setEnforcement(edgeId, mode)`.
- `ready(done?)`, `topo()`, `reachable(from, kind?)`, `ancestors(id)`, `descendants(id)`.

FSM

- `setCursor(nodes)`, `cursor()`.
- `transition(to, vars?)` -- legality + guard + zone + enforcement + record + stats, all at once. Returns a decision trace.
- `legalMoves(vars?)`, `explainTransition(to, vars?)`.

Zones (safe limited transition zones)

- `defineZone(name, members, {intra?, boundary?})`, `addToZone`, `removeFromZone`, `zonesOf(id)`, `zones()`.
- `deriveZone(seed, predicate?)` -- the agent maps out a safe zone automatically from the reachable subset satisfying a guard predicate, then ratifies it.

Intuition

- `suggest(vars?)` -- ranks legal moves by a learned value (UCB by default; epsilon/greedy configurable), each with a `confidence` and a `breakdown` of `{reward, weight, explore}` so you can see why a move ranked where it did.
- `step({to?, vars?, reward?})` -- one-call `suggest -> transition -> reward`; returns `{to, suggestion, applied, soft_warned, denied, done}`.
- `reward(value, {edgeId?|trace?, depth?, lambda?})` -- single-step, or decayed multi-step credit: `reward(1, {trace: true, depth: 3, lambda: 0.6})` reinforces the last 3 transitions with exponential decay.
- `getStat("node"|"edge", id)`, `ftsEnabled()`.

Self-evolution

- `splitState`, `mergeStates`, `gc`, `migrate(kind, fn)`.
- `optimize()` -- mines graph + stats for dead nodes, duplicate/low-value edges, soft->hard promotion candidates, zone tightening.
- `reweight()`, `selfIterate()` -- one safe closed loop: reweight -> apply safe suggestions -> validate -> rollback on regression.

Durability & integrity

- `checkpoint(name)`, `rollback(name)`, `branch(file)`/`discard()`.
- `snapshot()`, `compact(retain?)`.
- `validate()`, `repair()`, `verifyIntegrity()`.

Observe & port

- `render()`, `metrics()`, `toMermaid()`, `toDot()`, `history(filter?)`.
- `describe()` -- machine-readable manifest of the whole verb surface, error
  codes, guard DSL grammar, and enforcement levels, so an agent can introspect
  the API without reading source.
- `export()` / `importState(file, bundle)`.
- `setTunable(key, value)` / `getTunables()`.

## Soft vs hard enforcement

A transition is allowed unless a policy reason applies: a failing guard, a zone
boundary crossing, or an above-`off` intra-zone policy. Each reason is governed
by an enforcement mode and the strictest decision wins:

- `off` -- allowed (a note in the trace).
- `soft` -- allowed, but flagged and counted; after `escalationThreshold` soft
  violations the edge auto-promotes to `hard`.
- `hard` -- blocked; a `BlockedAttempt` is recorded with the reason; the cursor
  does not move.

Edge enforcement overrides zone, which overrides the global default. An edge set
to `off` is the explicit **gate** that lets an otherwise-blocked crossing through.
`explainTransition` returns the full deciding trace.

## Self-iteration loop

```
  transition outcome -> stats -> optimize() suggestions
        ^                                   |
        |                                   v
     validate() <---- apply safe edits (gc, promote, reweight)
        |
        +-- on broken invariant: rollback to the pre-iteration checkpoint
```

`selfIterate()` runs exactly one safe pass and reports the deltas, so the agent
iterates on its own abilities without ever leaving the graph in an invalid state.
Call `optimize()` to inspect candidate edits (dead nodes, duplicate/low-value
edges, soft->hard promotions) without applying them, and `selfIterate()` once per
episode to apply the safe subset under a checkpoint that rolls back on regression.

Zones fence off a region the agent moves within freely while crossing the
boundary stays governed: `defineZone(name, members, {intra, boundary})` sets the
in-zone vs boundary enforcement, and `deriveZone(seed, predicate?)` auto-derives
the members from the reachable subset satisfying a guard predicate, then ratifies
them. Use a checkpoint around a risky exploration and `rollback(name)` if
`validate()` does not hold.

## Durability model

- WAL + hash-chained, checksummed events.
- Boot `recover()` verifies the chain, trims a torn/partial trailing write to the
  last good seq, loads the newest snapshot at/under head, and replays the tail.
- Snapshots + compaction bound replay cost; recovery time is a function of the
  snapshot tail, not the whole log.

## CLI

The CLI is a thin shell over the JS facade; an agent can drive a full session
(inspect and mutate) without writing JS. ASCII output, conventional exit codes,
`--json` for parseable status/history.

Inspect:

```
adaptogen status --db ./agent.db     # cursor, ranked moves, ready frontier, violations
adaptogen status --json              # same, as structured json for an agent to parse
adaptogen describe                   # machine-readable manifest (verbs, errors, guard DSL, tunables)
adaptogen graph / dot                # mermaid / graphviz export
adaptogen suggest                    # ranked next moves (json, with score breakdown)
adaptogen explain <to>               # decision trace
adaptogen legal-moves [--vars '<json>'] # all non-denied moves from the cursor
adaptogen validate                   # invariants + integrity (exit 1 if invalid)
adaptogen history [n] [--json]
adaptogen get <id>                   # node by id
adaptogen recall --text <q> [--kind --tag --status --embedding '<json>' --limit]
```

Mutate:

```
adaptogen remember <id> [--kind --label --payload '<json>' --tags a,b --embedding '<json>']
adaptogen link <from> <to> [--kind --label --guard '<expr>' --enforcement --weight]
adaptogen depend <node> <prereq>     # node depends on prereq (DAG edge)
adaptogen unlink <edgeId>
adaptogen enforce <edgeId> <off|soft|hard>
adaptogen archive <id> / deprecate <id>
adaptogen cursor [ids...]            # print cursor, or set it
adaptogen transition <to> [--vars '<json>']
adaptogen step [to] [--reward <v>] [--vars '<json>']  # suggest -> transition -> reward
adaptogen reward <value> [--edgeId <id>]
```

Zones:

```
adaptogen zone-define <name> <id,id,...> [--intra off|soft|hard] [--boundary ...]
adaptogen zone-add <name> <id> / zone-remove <name> <id> / zone-list
```

Durability:

```
adaptogen checkpoint <name> / rollback <name> / checkpoints
adaptogen compact [retain]
adaptogen export <file> / import <file>
```

License: MIT.
