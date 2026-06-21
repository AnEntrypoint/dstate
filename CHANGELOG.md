# Changelog

## Unreleased

- ci(workflow): add `.github/workflows/ci.yml` running the integration witness
  (`bun test.js`) and the performance bench (`bun run bench`) on every pull
  request and every push to a non-main branch. Previously only `publish.yml`
  existed and it runs solely on push to `main`, so pull requests and feature
  branches got no CI at all. The new workflow never publishes, so it cannot
  collide with the release path; concurrency cancels superseded runs per ref.
- fix(pkg): `package.json` `files` listed `.claude/skills`, but the Agent Skill
  actually lives at `skills/adaptogen/SKILL.md`, so `npm pack` shipped the
  package WITHOUT the skill. `files` now lists `skills`; `npm pack --dry-run`
  confirms `skills/adaptogen/SKILL.md` is in the tarball.
- fix(test): the integration witness now creates `./tmp` before opening the store.
  `./tmp` is gitignored, so on a fresh clone (and in the publish CI) it is absent
  and `libsql` failed to open `./tmp/integration.db` with `SQLITE_CANTOPEN`. The
  witness is self-contained again: `bun test.js` passes from a clean checkout.
- feat(npx): the CLI now runs under plain Node -- the `bin` shebang switched from
  `bun` to `node` (the runtime path has no `bun:` imports; `libsql` is node-native),
  so `npx -y adaptogen <command>` works with zero install and no Bun. `engines` now
  declares `node >=18` alongside `bun`.
- feat(skill): ship a Claude Code Agent Skill at `skills/adaptogen/SKILL.md`
  (included in the npm package) that enforces routing every task juncture --
  orient, plan, transition/step, reward, checkpoint, recall, validate, export --
  through `npx adaptogen`, so durable state never lives only in agent prose. README
  gains an npx quickstart and a skill-adoption note.
- chore(test): tests are now ONE file -- `test.js` at repo root, real services
  only, 200-line hard ceiling (176 lines). The `test/` directory (24 files) is
  removed. The single witness was widened from 22 to 62 assertions, covering the
  full public surface: memory/recall (id, FTS text, quoted tag, kind, embedding),
  the typed error contract (InvalidInput, Conflict, PayloadTooLarge, NotFound,
  CycleRejected), dag (topo/ready/ancestors/descendants), edges (guard/weight/
  unlink), zones, fsm (allow/deny/warn/soft_warned), intuition (suggest+breakdown,
  step loop incl NoMoves, trace-decay reward), guard DSL (compile/eval/__proto__
  rejection/missing-key), tunables, self-evolution, checkpoint/rollback, durable
  close/reopen, crash recovery, and export/import. `package.json` `test` and CI now
  run `bun test.js`; AGENTS.md encodes the one-file/200-line rule as policy.

## Unreleased (agent fluency)

- feat(agent-loop): `step({to?, vars?, reward?})` -- one call composes
  `suggest -> transition -> reward` and returns `{to, suggestion, applied,
  soft_warned, denied, outcome, reward, done}`, so an agent advances its own
  state without orchestrating three verbs per tick. Exposed on the CLI as `step`.
- feat(introspection): every dead-end `fail()` now carries an actionable
  `details.hint`; `transition` outcomes carry a top-level `soft_warned`;
  `suggest()` results carry a `breakdown` of `{reward, weight, explore}`.
- feat(describe): MANIFEST gains `patterns` (runnable worked flows), `errorHints`
  (per-code recovery), tunable/zone/enforcement `meaning`, guard DSL `examples`
  and missing-key semantics -- a cold agent learns usage from `describe()` alone.
- feat(cli): new subcommands `step`, `legal-moves`, `archive`/`deprecate`,
  `zone-define`/`zone-add`/`zone-remove`/`zone-list`,
  `checkpoint`/`rollback`/`checkpoints`, and `--embedding` on remember/recall.
- fix: recall by a tag containing quotes/backslashes now matches the exact JSON
  element (was a broken substring match); decision-trace `escalation` key is
  camelCase `softViolations`; `bumpCounter` guards its SQL column against an
  allow-list. Added `ftsEnabled()` so an agent knows if text recall is degraded.

## Unreleased

- chore!: rename the project from `dstate` to `adaptogen` (npm package, `adaptogen`
  CLI bin, manifest identity, default db path `./adaptogen.db`, docs). The JS class
  is still exported as `DState`, now also aliased as `Adaptogen`. Why: ship under
  the published package name; no API behavior change.
- ci: publish to npm on every push to `main` -- `.github/workflows/publish.yml`
  runs the test + integration witness, bumps the patch version, publishes, and
  pushes the version commit back with `[skip ci]`. Requires an `NPM_TOKEN` repo
  secret. Why: releases follow `main` automatically instead of by hand.
- feat(cli): mutation subcommands (remember/get/recall/link/depend/unlink/enforce/
  cursor/transition/reward) so an agent drives a full session by shelling out.
- feat(manifest): `describe()` now reports `getStat` and the tunables defaults/ranges.
- fix: `link()` rejects a non-finite/negative edge weight; new `DependencyToDeadNode`
  invariant with repair, and `selfIterate` prunes a gc'd node's edges.

## 0.2.0

- refactor!: migrate the whole library from TypeScript to buildless JavaScript
  (ES modules, no compile step, no `tsc` gate). Why: run directly with zero build
  tooling; the commit gate is now `bun test` + the `bun test.js` witness + bench.
- feat!: swap the persistence layer from `bun:sqlite` to a synchronous `libsql`
  client behind a new `db.js` facade. Why: portable off Bun (libsql runs under
  plain Node too) while keeping the synchronous, Result-returning API unchanged.
  The facade re-exposes the bun:sqlite-shaped `query/run` surface, strips libsql's
  injected `_metadata` row key, and normalizes bind values.
- fix(perf): index edges on composite `(src, kind)` / `(dst, kind)`. Why: under
  libsql's planner the separate single-column indexes let a `src=? AND kind=?`
  lookup pick the low-cardinality `kind` index and scan the whole edge table,
  turning `suggest()`/`transition()` into O(n); the composite keys restore flat
  per-step cost (the bench now stays well under budget across graph sizes).
- perf(graph): `dependencyCycle` walks indexed out-edges instead of materializing
  the full adjacency every call, so adding a dependency link stays cheap on long
  chains.
- feat(agent): machine-readable self-description -- `DState.describe()` and
  `dstate describe`, plus a `--json` flag on `status`/`history`. Why: let an agent
  introspect the full verb surface, error codes, guard grammar, and enforcement
  levels, and parse CLI output instead of scraping it.
- decision: keep xstate out and skip floosie. Why: xstate models code-defined
  in-memory statecharts and would reintroduce JS-function guards the sandboxed DSL
  exists to forbid, net-growing the surface; floosie is a stream/ACP transport
  platform with no mapping onto an event-sourced state store.

## Unreleased

- feat: dstate -- agent-owned self-evolving DAG+FSM state store. Why: give one LLM
  agent a single durable structure that is its memory, policy, and intuition at
  once, and that it can keep reshaping while it works.
- chore: untrack churny plugkit runtime (.gm/prd.yml, .gm/mutables.yml). Why: the
  plan watcher rewrites them every dispatch; tracking them would keep the tree
  perpetually dirty.
- test: root integration witness (bun test.js). Why: prove the whole stack on a
  real on-disk store -- build, enforce, reward, evolve, checkpoint, crash-recover,
  port -- not just isolated units.
- feat(enforce): auto-demote a hard edge back to soft after clean runs. Why: an
  edge that hardened on a rough patch should relax once the agent uses it cleanly
  again, so policy tracks current behavior instead of ratcheting one way.
