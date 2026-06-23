#!/usr/bin/env node
// Thin CLI over the facade for humans and for the agent to shell out to. ASCII
// output, conventional exit codes. Subcommands map to verbs. Pass --json to make
// the human-readable commands (status, history) emit structured JSON instead, so
// an agent parses rather than scrapes.

import { DState } from "./index.js";
import { importState } from "./portability.js";
import { readFileSync, writeFileSync } from "node:fs";

function usage() {
  process.stdout.write(
    [
      "adaptogen <command> [--db <file>] [--json] [args]",
      "",
      "compose:",
      "  plan --spec <json>  atomic bulk builder ({nodes,transitions,deps,cursor}); all-or-nothing",
      "  orient              one situational snapshot (cursor,suggestions,blocked,ready,violations,recent)",
      "",
      "inspect:",
      "  status              cursor, legal moves, ready frontier, violations",
      "  metrics             node/edge/zone/event counts + replay cost",
      "  describe            machine-readable manifest of the full agent surface",
      "  render              ASCII live view of cursor, moves, and recent log",
      "  tunables            current agent-settable knobs as json",
      "  verify              hash-chain integrity report (exit 1 if broken)",
      "  graph               mermaid export of the active graph",
      "  dot                 graphviz dot export",
      "  explain <to>        decision trace for transitioning to <to>",
      "  legal-moves         all non-denied moves from the cursor (--vars json)",
      "  validate            invariant + integrity report (exit 1 if invalid)",
      "  history [n]         last n log entries",
      "  get <id>            node by id as json",
      "  recall              query nodes (--text --kind --tag --status --limit)",
      "",
      "mutate:",
      "  remember <id>       create/update a node (--kind --label --payload json --tags a,b)",
      "  link <from> <to>    transition/dependency edge (--kind --label --guard --enforcement --weight)",
      "  depend <node> <pre> dependency edge (node depends on pre)",
      "  unlink <edgeId>     remove an edge",
      "  enforce <e> <mode>  set edge enforcement (off|soft|hard)",
      "  set-tunable <k> <v> set an agent knob to a json value (range-checked)",
      "  repair              auto-fix fixable invariant violations, quarantine the rest",
      "  archive <id>        archive a node",
      "  deprecate <id>      deprecate a node",
      "  cursor [ids...]     print cursor, or set it to ids",
      "  transition <to>     move the cursor (--vars json)",
      "",
      "zones:",
      "  zone-define <n> <ids>  define a zone over id,id,... (--intra --boundary)",
      "  zone-add <name> <id>   add a node to a zone",
      "  zone-remove <name> <id> remove a node from a zone",
      "  zone-list              all zones as json",
      "",
      "durability:",
      "  checkpoint <name>   named checkpoint of the current head",
      "  rollback <name>     restore to a named checkpoint",
      "  checkpoints         list checkpoints as json",
      "  compact [retain]    snapshot and prune old events",
      "  export <file>       write a portable json bundle",
      "  import <file>       load a portable json bundle into --db",
      "",
      "flags:",
      "  --db <file>         store path, a portable json bundle (default ./adaptogen.json, :memory: for ephemeral)",
      "  --json              emit structured json for status/history",
    ].join("\n") + "\n",
  );
}

// Split argv into positionals and `--flag value` pairs (`--json` is boolean).
// This lets mutation subcommands mix positionals with typed flags cleanly.
function parseArgs(args) {
  const flags = {};
  const positionals = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--json") {
      flags.json = true;
    } else if (a.startsWith("--")) {
      flags[a.slice(2)] = args[++i];
    } else {
      positionals.push(a);
    }
  }
  return { flags, positionals };
}

// Print a Result<T>: value as json on success (exit 0), error json on failure
// (exit 1). ASCII only.
function emitResult(r) {
  if (r && typeof r === "object" && "ok" in r && !r.ok) {
    process.stdout.write(JSON.stringify(r.error.toJSON(), null, 2) + "\n");
    return 1;
  }
  const value = r && typeof r === "object" && "ok" in r ? r.value : r;
  process.stdout.write(JSON.stringify(value, null, 2) + "\n");
  return 0;
}

function parseJsonFlag(s, what) {
  if (s === undefined) return undefined;
  try {
    return JSON.parse(s);
  } catch {
    process.stderr.write(`invalid json for ${what}: ${s}\n`);
    return null;
  }
}

function main() {
  const argv = typeof process !== "undefined" ? process.argv.slice(2) : [];
  const { flags, positionals } = parseArgs(argv);
  const cmd = positionals[0];
  if (!cmd || cmd === "help" || cmd === "--help") {
    usage();
    return 0;
  }
  const dbFile = flags.db ?? "./adaptogen.json";
  const json = !!flags.json;
  const rest = positionals.slice(1);

  if (cmd === "describe") {
    process.stdout.write(JSON.stringify(DState.prototype.describe.call({}), null, 2) + "\n");
    return 0;
  }

  if (cmd === "import") {
    const file = rest[0];
    if (!file) {
      process.stderr.write("import needs a file\n");
      return 2;
    }
    let bundle;
    try {
      bundle = JSON.parse(readFileSync(file, "utf8"));
    } catch (e) {
      process.stderr.write(`cannot read/parse bundle ${file}: ${e.message}\n`);
      return 1;
    }
    if (!bundle || !Array.isArray(bundle.events)) {
      process.stderr.write(`bundle ${file} is not a valid export ({ events: [...] })\n`);
      return 1;
    }
    const ds = importState(dbFile, bundle, { lock: false });
    process.stdout.write(`imported ${bundle.events.length} events into ${dbFile}\n`);
    ds.close();
    return 0;
  }

  const ds = DState.open(dbFile, { lock: false, seed: false });
  try {
    switch (cmd) {
      case "status":
        if (json) {
          process.stdout.write(
            JSON.stringify(
              {
                cursor: ds.cursor(),
                moves: ds.legalMoves(),
                ready: ds.ready(),
                violations: ds.validate().violations.length,
                seq: ds.store.lastSeq(),
              },
              null,
              2,
            ) + "\n",
          );
        } else {
          process.stdout.write(ds.render() + "\n");
        }
        return 0;
      case "metrics":
        process.stdout.write(JSON.stringify(ds.metrics(), null, 2) + "\n");
        return 0;
      case "graph":
        process.stdout.write(ds.toMermaid() + "\n");
        return 0;
      case "dot":
        process.stdout.write(ds.toDot() + "\n");
        return 0;
      case "explain": {
        const to = rest[0];
        if (!to) {
          process.stderr.write("explain needs a target node\n");
          return 2;
        }
        const r = ds.explainTransition(to);
        process.stdout.write(JSON.stringify(r.ok ? r.value : r.error.toJSON(), null, 2) + "\n");
        return r.ok ? 0 : 1;
      }
      case "validate": {
        const report = ds.validate();
        process.stdout.write(JSON.stringify(report, null, 2) + "\n");
        return report.ok ? 0 : 1;
      }
      case "compact": {
        const retain = rest[0] ? Number(rest[0]) : 0;
        process.stdout.write(JSON.stringify(ds.compact(retain)) + "\n");
        return 0;
      }
      case "history": {
        const n = rest[0] ? Number(rest[0]) : 20;
        const entries = ds.history({ limit: n });
        if (json) {
          process.stdout.write(JSON.stringify(entries, null, 2) + "\n");
        } else {
          for (const h of entries) {
            process.stdout.write(`${h.seq}\t${h.type}\t${h.summary}\n`);
          }
        }
        return 0;
      }
      case "export": {
        const file = rest[0];
        const bundle = ds.export();
        if (file) {
          writeFileSync(file, JSON.stringify(bundle));
          process.stdout.write(`exported ${bundle.events.length} events to ${file}\n`);
        } else {
          process.stdout.write(JSON.stringify(bundle) + "\n");
        }
        return 0;
      }
      case "remember": {
        const id = rest[0];
        if (!id) {
          process.stderr.write("remember needs a node id\n");
          return 2;
        }
        const payload = parseJsonFlag(flags.payload, "--payload");
        if (payload === null) return 2;
        return emitResult(
          ds.remember({ id, kind: flags.kind, label: flags.label, payload, tags: flags.tags ? flags.tags.split(",") : undefined }),
        );
      }
      case "get": {
        const id = rest[0];
        if (!id) {
          process.stderr.write("get needs a node id\n");
          return 2;
        }
        const node = ds.getNode(id);
        process.stdout.write(JSON.stringify(node, null, 2) + "\n");
        return node ? 0 : 1;
      }
      case "recall": {
        const q = { text: flags.text, kind: flags.kind, tag: flags.tag, status: flags.status };
        if (flags.limit) q.limit = Number(flags.limit);
        process.stdout.write(JSON.stringify(ds.recall(q), null, 2) + "\n");
        return 0;
      }
      case "link": {
        const [from, to] = rest;
        if (!from || !to) {
          process.stderr.write("link needs <from> <to>\n");
          return 2;
        }
        const weight = flags.weight !== undefined ? Number(flags.weight) : undefined;
        return emitResult(
          ds.link(from, to, { kind: flags.kind, label: flags.label, guard: flags.guard, enforcement: flags.enforcement, weight }),
        );
      }
      case "depend": {
        const [node, prereq] = rest;
        if (!node || !prereq) {
          process.stderr.write("depend needs <node> <prereq>\n");
          return 2;
        }
        return emitResult(ds.depend(node, prereq));
      }
      case "unlink": {
        const edgeId = rest[0];
        if (!edgeId) {
          process.stderr.write("unlink needs an edge id\n");
          return 2;
        }
        return emitResult(ds.unlink(edgeId));
      }
      case "cursor": {
        if (rest.length === 0) {
          process.stdout.write(JSON.stringify(ds.cursor(), null, 2) + "\n");
          return 0;
        }
        return emitResult(ds.setCursor(rest));
      }
      case "transition": {
        const to = rest[0];
        if (!to) {
          process.stderr.write("transition needs a target node\n");
          return 2;
        }
        const vars = parseJsonFlag(flags.vars, "--vars");
        if (vars === null) return 2;
        return emitResult(ds.transition(to, vars ?? {}));
      }
      case "enforce": {
        const [edgeId, mode] = rest;
        if (!edgeId || !mode) {
          process.stderr.write("enforce needs <edgeId> <off|soft|hard>\n");
          return 2;
        }
        return emitResult(ds.setEnforcement(edgeId, mode));
      }
      case "legal-moves": {
        const vars = parseJsonFlag(flags.vars, "--vars");
        if (vars === null) return 2;
        process.stdout.write(JSON.stringify(ds.legalMoves(vars ?? {}), null, 2) + "\n");
        return 0;
      }
      case "plan": {
        const spec = parseJsonFlag(flags.spec, "--spec");
        if (spec === null) return 2;
        if (spec === undefined) {
          process.stderr.write("plan needs --spec <json> ({ nodes, transitions, deps, cursor })\n");
          return 2;
        }
        return emitResult(ds.plan(spec));
      }
      case "orient": {
        const vars = parseJsonFlag(flags.vars, "--vars");
        if (vars === null) return 2;
        process.stdout.write(JSON.stringify(ds.orient(vars ?? {}), null, 2) + "\n");
        return 0;
      }
      case "archive":
      case "deprecate": {
        const id = rest[0];
        if (!id) {
          process.stderr.write(`${cmd} needs a node id\n`);
          return 2;
        }
        return emitResult(cmd === "archive" ? ds.archive(id) : ds.deprecate(id));
      }
      case "zone-define": {
        const name = rest[0];
        const members = rest[1] ? rest[1].split(",") : [];
        if (!name || members.length === 0) {
          process.stderr.write("zone-define needs <name> <id,id,...>\n");
          return 2;
        }
        return emitResult(ds.defineZone(name, members, { intra: flags.intra, boundary: flags.boundary }));
      }
      case "zone-add": {
        const [name, node] = rest;
        if (!name || !node) {
          process.stderr.write("zone-add needs <name> <id>\n");
          return 2;
        }
        return emitResult(ds.addToZone(name, node));
      }
      case "zone-remove": {
        const [name, node] = rest;
        if (!name || !node) {
          process.stderr.write("zone-remove needs <name> <id>\n");
          return 2;
        }
        return emitResult(ds.removeFromZone(name, node));
      }
      case "zone-list":
        process.stdout.write(JSON.stringify(ds.zones(), null, 2) + "\n");
        return 0;
      case "checkpoint": {
        const name = rest[0];
        if (!name) {
          process.stderr.write("checkpoint needs a name\n");
          return 2;
        }
        return emitResult(ds.checkpoint(name));
      }
      case "rollback": {
        const name = rest[0];
        if (!name) {
          process.stderr.write("rollback needs a name\n");
          return 2;
        }
        return emitResult(ds.rollback(name));
      }
      case "checkpoints":
        process.stdout.write(JSON.stringify(ds.listCheckpoints(), null, 2) + "\n");
        return 0;
      case "render":
        process.stdout.write(ds.render() + "\n");
        return 0;
      case "tunables":
        process.stdout.write(JSON.stringify(ds.getTunables(), null, 2) + "\n");
        return 0;
      case "set-tunable": {
        const key = rest[0];
        if (!key || rest[1] === undefined) {
          process.stderr.write("set-tunable needs <key> <json-value>\n");
          return 2;
        }
        const value = parseJsonFlag(rest[1], "value");
        if (value === null) return 2;
        return emitResult(ds.setTunable(key, value));
      }
      case "repair":
        process.stdout.write(JSON.stringify(ds.repair(), null, 2) + "\n");
        return 0;
      case "verify": {
        const report = ds.verifyIntegrity();
        process.stdout.write(JSON.stringify(report, null, 2) + "\n");
        return report.ok ? 0 : 1;
      }
      default:
        usage();
        return 2;
    }
  } finally {
    ds.close();
  }
}

const code = main();
if (typeof process !== "undefined") process.exit(code);
