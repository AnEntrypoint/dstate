---
name: adaptogen
description: >-
  Drive durable agent state through adaptogen, a self-evolving DAG+FSM event store
  reached over one shell binary (npx adaptogen). Use it whenever a task spans more
  than one step, must survive a restart, or needs memory, a plan, a policy, or a
  learned next-move: orient at the start, plan before acting, transition/step each
  move, reward each outcome, checkpoint before risk, recall for memory. The store
  is the single source of truth; state carried only in prose is lost.
allowed-tools: Bash(npx adaptogen *), Bash(npx -y adaptogen *), Read, Write, Skill
---

# adaptogen

**The store is the state; prose is not.** Anything you need to still be true next
turn -- a plan, a decision, a memory, a learned preference, where you are in a
multi-step task -- is a write into adaptogen, not a sentence in your reply. A plan
narrated and not stored evaporates with the turn; the event log survives the
restart, the context window, and the handoff to the next agent. If you are about
to "remember", "note", "track", or "decide" something in prose, that is an
adaptogen verb you skipped.

**One binary, zero install.** Every juncture routes through the shell:
`npx -y adaptogen <command> [--db <file>] [args]`. The default db is
`./adaptogen.db` (project-resident, portable, git-ignorable); `--db :memory:` is
ephemeral. The CLI runs under plain node -- no bun, no build step. Run
`npx -y adaptogen describe` once to print the full machine-readable manifest
(every verb, every typed error code, the guard DSL grammar) and `npx -y adaptogen
help` for the command list. You never need to read adaptogen's source to use it.

**You are the state machine; adaptogen is the durable spine.** It does not act on
its own -- it records what you decide and tells you the legal, ranked next move.
Each action you take is a verb you dispatch; the cursor only moves when you
`transition` it. Drop this and the rest collapses: a plan with no graph, an
outcome with no reward, a decision no future turn can recall.

## The junctures -- enforce adaptogen at every one

A juncture below without its verb is freelancing state in prose. Route each one:

- **Session start (cold or returning): `orient`.** Your first move on any
  multi-step task is `npx -y adaptogen orient`. One read returns the whole
  situation: cursor, ranked suggestions, legal moves, what is blocked and why, the
  dependency-ready frontier, integrity/violation status, the recent log, live
  tunables, and `done`. Skipping orient commits you to an unobserved state.

- **Turning a plan into structure: `plan` (atomic).** The moment a task has more
  than one step, encode it as a graph in one call:
  `npx -y adaptogen plan --spec '{"nodes":[...],"transitions":[...],"deps":[...],"cursor":[...]}'`.
  It validates the whole spec (ids, endpoints, guards, weights, batch acyclicity,
  cursor) before writing anything -- on any error nothing is written and the
  offending item is named by index. Never hand-build a graph node-by-node when one
  `plan` is atomic.

- **Every state move: `transition` / `step`.** Advance the cursor only through the
  store. `npx -y adaptogen transition <to> --vars '{...}'` takes one move and
  records the decision trace (legality, guard, zone, enforcement, stats) at once.
  `npx -y adaptogen step --reward 1` is the one-call loop: it picks the top-ranked
  legal move, takes it, and reinforces it. Use `step` to walk a plan; use
  `transition <to>` when you must force a specific target. Inspect first with
  `suggest` (ranked moves with a score breakdown), `legal-moves`, or
  `explain <to>` (a dry-run decision trace).

- **Every outcome: `reward`.** After a move proves good or bad, teach the store:
  `npx -y adaptogen reward <value> [--edgeId <id>]`. Positive reinforces, negative
  penalizes; the learned prior reshapes future `suggest`/`step` rankings. An
  outcome you never reward is intuition the next agent does not inherit.

- **Durable memory read/write: `remember` / `recall`.** Persist a fact, artifact,
  or piece of context as a node: `npx -y adaptogen remember <id> --payload '{...}'
  --tags a,b`. Retrieve by id, kind, tag, full-text, or embedding similarity:
  `npx -y adaptogen recall --text "..."` / `--tag urgent` / `--embedding '[...]'`.
  This replaces scratch notes and ad-hoc files; the memory is queryable and
  portable.

- **Risk boundary: `checkpoint` before, `rollback` on regression.** Before any
  move you might need to undo, `npx -y adaptogen checkpoint <name>`. If validation
  or reality regresses, `npx -y adaptogen rollback <name>` restores the exact
  projection. `checkpoints` lists them. This is the safe way to try a risky path.

- **Integrity suspicion: `validate` / `verify` / `repair`.** When state looks
  wrong, `npx -y adaptogen validate` (invariant + integrity report, exit 1 if
  invalid), `npx -y adaptogen verify` (hash-chain integrity), and
  `npx -y adaptogen repair` (auto-fix fixable violations, quarantine the rest).
  Run them before trusting a store you did not just build.

- **Policy: `link` guards/enforcement, `zone-define` safe regions.** Encode rules
  on the graph, not in your head. `npx -y adaptogen link <from> <to> --guard
  "vars.approved == true" --enforcement hard` gates a move; soft warns and counts,
  hard denies, off is the explicit gate through a boundary. `zone-define <name>
  <id,id,...> --intra off --boundary hard` makes a region the agent moves within
  freely while the boundary stays governed.

- **Self-improvement: `metrics`, then evolve.** `npx -y adaptogen metrics` surfaces
  hot paths and enforcement/intuition aggregates. The library API
  (`optimize()`/`selfIterate()`) mines the graph for dead nodes, low-value edges,
  and promotion candidates and applies safe edits behind a validate-and-rollback
  guard -- reach for it when the graph itself should improve.

- **Handoff / portability: `export` / `import`.** `npx -y adaptogen export <file>`
  writes the full history as portable JSON; `npx -y adaptogen import <file> --db
  <target>` reconstructs an identical store. This is how state crosses machines,
  agents, and harnesses. Never invent a platform-local memory store beside it.

## Discipline

**Standing approval -- finish the whole task.** Once you have adopted a plan in
the store, walk its full closure: `step` until `orient` reports `done`, do not
stop at a convenient slice, do not ask whether to continue. Newly discovered work
is a new `remember`/`plan` node, not a deferral.

**Every verb returns a typed Result; read it.** A failure is
`{ "code": ..., "message": ..., "details": ... }` with a recovery hint, never a
crash. On `NotFound` create the id first; on `IllegalTransition`/`NoMoves` consult
`suggest`/`legal-moves` or `link` a move; on `HardBlocked` relax enforcement or
pick another move; on `CycleRejected` reorder a dependency. `describe` carries the
full error-code table with the fix for each.

**Inspect before you mutate, witness after.** `orient`/`suggest`/`explain` are
pure reads -- use them to decide. After a mutation, the store's own response (or a
follow-up `orient`) is the witness that it landed; your narration is not.

**ASCII only.** adaptogen output and the ids/labels you feed it stay ASCII --
arrows are `->`, no decorative glyphs.

## Minimal session

```
npx -y adaptogen --db ./agent.db orient
npx -y adaptogen --db ./agent.db plan --spec '{"nodes":["research","draft","review","ship"],"transitions":[["research","draft"],["draft","review"],["review","ship",{"guard":"vars.approved == true"}]],"deps":[["draft","research"],["review","draft"],["ship","review"]],"cursor":["research"]}'
npx -y adaptogen --db ./agent.db step --reward 1
npx -y adaptogen --db ./agent.db checkpoint before-ship
npx -y adaptogen --db ./agent.db transition ship --vars '{"approved":true}'
npx -y adaptogen --db ./agent.db orient   # done == true when the plan is walked
```

Stuck, unsure of the next move, or handed an unfamiliar store: `npx -y adaptogen
describe` for the surface and `npx -y adaptogen orient` for the situation. Those
two reads re-ground you without reading any source.
