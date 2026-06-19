// Database open + pragmas, over a synchronous libsql client. WAL for durability
// under crash, NORMAL sync for the WAL fast path, foreign_keys on, a busy_timeout
// so concurrent readers wait rather than erroring. FTS5 is probed once and its
// availability cached: the recall path degrades to LIKE when the build lacks it.
//
// libsql exposes a better-sqlite3-shaped API (db.prepare(sql).get/all/run,
// db.exec(ddl), db.transaction(fn)). The Db facade below re-exposes the
// bun:sqlite-shaped surface the rest of the store was written against --
// db.query(sql).get/all and db.run(sql, ...args) -- so call sites are unchanged.
// It also strips libsql's injected `_metadata` row key and normalizes bind
// values (undefined -> null, boolean -> 0/1) to match bun:sqlite leniency.

import Database from "libsql";

function stripMeta(row) {
  if (row && typeof row === "object" && "_metadata" in row) delete row._metadata;
  return row;
}

function normArgs(args) {
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === undefined) args[i] = null;
    else if (a === true) args[i] = 1;
    else if (a === false) args[i] = 0;
  }
  return args;
}

class Db {
  constructor(raw, filename) {
    this.raw = raw;
    this.filename = filename;
    this._cache = new Map();
  }
  _stmt(sql) {
    let s = this._cache.get(sql);
    if (!s) {
      s = this.raw.prepare(sql);
      this._cache.set(sql, s);
    }
    return s;
  }
  // bun:sqlite-shaped: db.query(sql).get(...args) / .all(...args)
  query(sql) {
    const stmt = this._stmt(sql);
    return {
      get: (...args) => stripMeta(stmt.get(...normArgs(args))),
      all: (...args) => stmt.all(...normArgs(args)).map(stripMeta),
    };
  }
  // bun:sqlite-shaped: db.run(sql, ...args) -> { changes }
  run(sql, ...args) {
    const info = this._stmt(sql).run(...normArgs(args));
    return { changes: Number(info?.changes ?? 0), lastInsertRowid: info?.lastInsertRowid };
  }
  exec(sql) {
    this.raw.exec(sql);
    return this;
  }
  transaction(fn) {
    return this.raw.transaction(fn);
  }
  close() {
    this.raw.close();
  }
}

export function openDatabase(filename) {
  const raw = new Database(filename);
  // PRAGMAs: in-memory dbs ignore journal_mode but the calls are harmless.
  raw.exec("PRAGMA journal_mode = WAL;");
  raw.exec("PRAGMA synchronous = NORMAL;");
  raw.exec("PRAGMA foreign_keys = ON;");
  raw.exec("PRAGMA busy_timeout = 5000;");
  const ftsEnabled = probeFts(raw);
  return { db: new Db(raw, filename), ftsEnabled };
}

function probeFts(raw) {
  try {
    raw.exec("CREATE VIRTUAL TABLE IF NOT EXISTS __fts_probe USING fts5(x);");
    raw.exec("DROP TABLE IF EXISTS __fts_probe;");
    return true;
  } catch {
    return false;
  }
}
