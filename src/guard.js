// A small, sandboxed predicate DSL for transition guards. It is an interpreted
// AST over a read-only context object: NO eval/Function, no host bindings, no
// property access that could reach a prototype. The language has no loops and a
// bounded AST depth, so evaluation always terminates quickly. This is the only
// place agent-authored expressions run, and it must never become a code path
// into the host.

import { ok, fail } from "./errors.js";

const MAX_EXPR_LEN = 2000;
// The only escape sequences a guard string literal admits; each maps to the
// character it produces. An escape outside this set is a GuardParseError.
const ESCAPES = { "\\": "\\", '"': '"', "'": "'", n: "\n", r: "\r", t: "\t" };
const MAX_DEPTH = 64;
const FORBIDDEN_SEGMENTS = new Set(["__proto__", "prototype", "constructor"]);

// AST node shapes (documented, not typed):
//   { t: "lit", v }                       literal
//   { t: "path", segs: string[] }         own-property path lookup
//   { t: "arr", items: Node[] }           array literal
//   { t: "unary", op: "!", e: Node }      logical not
//   { t: "bin", op, l: Node, r: Node }    binary op
// Token shape: { k: "num"|"str"|"id"|"op"|"punc", v: string }

function tokenize(src) {
  const toks = [];
  let i = 0;
  const ops = ["&&", "||", "==", "!=", ">=", "<=", ">", "<", "!"];
  while (i < src.length) {
    const c = src[i];
    if (c === " " || c === "\t" || c === "\n" || c === "\r") {
      i++;
      continue;
    }
    if (c === "'" || c === '"') {
      let j = i + 1;
      let s = "";
      while (j < src.length && src[j] !== c) {
        if (src[j] === "\\" && j + 1 < src.length) {
          // Only a known escape is accepted; an unknown one (\x, \u, ...) is a
          // parse error rather than silently collapsing to the bare character.
          const esc = ESCAPES[src[j + 1]];
          if (esc === undefined) return fail("GuardParseError", `invalid escape '\\${src[j + 1]}' in string`);
          s += esc;
          j += 2;
        } else {
          s += src[j];
          j++;
        }
      }
      if (j >= src.length) return fail("GuardParseError", "unterminated string");
      toks.push({ k: "str", v: s });
      i = j + 1;
      continue;
    }
    if (/[0-9]/.test(c) || (c === "-" && /[0-9]/.test(src[i + 1] ?? ""))) {
      let j = i + 1;
      while (j < src.length && /[0-9.]/.test(src[j])) j++;
      toks.push({ k: "num", v: src.slice(i, j) });
      i = j;
      continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      let j = i + 1;
      while (j < src.length && /[A-Za-z0-9_.]/.test(src[j])) j++;
      toks.push({ k: "id", v: src.slice(i, j) });
      i = j;
      continue;
    }
    if (c === "(" || c === ")" || c === "[" || c === "]" || c === ",") {
      toks.push({ k: "punc", v: c });
      i++;
      continue;
    }
    const op = ops.find((o) => src.startsWith(o, i));
    if (op) {
      toks.push({ k: "op", v: op });
      i += op.length;
      continue;
    }
    return fail("GuardParseError", `unexpected character '${c}' at ${i}`);
  }
  return ok(toks);
}

// Recursive-descent parser with explicit depth guard.
class Parser {
  constructor(toks) {
    this.toks = toks;
    this.pos = 0;
  }
  peek() {
    return this.toks[this.pos];
  }
  eat() {
    return this.toks[this.pos++];
  }
  parse(depth) {
    return this.or(depth);
  }
  or(d) {
    if (d > MAX_DEPTH) return fail("GuardParseError", "expression too deep");
    let left = this.and(d + 1);
    if (!left.ok) return left;
    while (this.peek()?.k === "op" && this.peek().v === "||") {
      this.eat();
      const right = this.and(d + 1);
      if (!right.ok) return right;
      left = ok({ t: "bin", op: "||", l: left.value, r: right.value });
    }
    return left;
  }
  and(d) {
    if (d > MAX_DEPTH) return fail("GuardParseError", "expression too deep");
    let left = this.cmp(d + 1);
    if (!left.ok) return left;
    while (this.peek()?.k === "op" && this.peek().v === "&&") {
      this.eat();
      const right = this.cmp(d + 1);
      if (!right.ok) return right;
      left = ok({ t: "bin", op: "&&", l: left.value, r: right.value });
    }
    return left;
  }
  cmp(d) {
    if (d > MAX_DEPTH) return fail("GuardParseError", "expression too deep");
    const left = this.unary(d + 1);
    if (!left.ok) return left;
    const p = this.peek();
    const cmpOps = ["==", "!=", ">", ">=", "<", "<="];
    if (p?.k === "op" && cmpOps.includes(p.v)) {
      this.eat();
      const right = this.unary(d + 1);
      if (!right.ok) return right;
      return ok({ t: "bin", op: p.v, l: left.value, r: right.value });
    }
    if (p?.k === "id" && (p.v === "in" || p.v === "has")) {
      this.eat();
      const right = this.unary(d + 1);
      if (!right.ok) return right;
      return ok({ t: "bin", op: p.v, l: left.value, r: right.value });
    }
    return left;
  }
  unary(d) {
    if (d > MAX_DEPTH) return fail("GuardParseError", "expression too deep");
    if (this.peek()?.k === "op" && this.peek().v === "!") {
      this.eat();
      const e = this.unary(d + 1);
      if (!e.ok) return e;
      return ok({ t: "unary", op: "!", e: e.value });
    }
    return this.primary(d + 1);
  }
  primary(d) {
    const t = this.eat();
    if (!t) return fail("GuardParseError", "unexpected end of expression");
    if (t.k === "num") return ok({ t: "lit", v: Number(t.v) });
    if (t.k === "str") return ok({ t: "lit", v: t.v });
    if (t.k === "punc" && t.v === "(") {
      const e = this.or(d + 1);
      if (!e.ok) return e;
      const close = this.eat();
      if (!close || close.v !== ")") return fail("GuardParseError", "expected )");
      return e;
    }
    if (t.k === "punc" && t.v === "[") {
      const items = [];
      if (this.peek()?.v !== "]") {
        for (;;) {
          const it = this.or(d + 1);
          if (!it.ok) return it;
          items.push(it.value);
          if (this.peek()?.v === ",") {
            this.eat();
            continue;
          }
          break;
        }
      }
      const close = this.eat();
      if (!close || close.v !== "]") return fail("GuardParseError", "expected ]");
      return ok({ t: "arr", items });
    }
    if (t.k === "id") {
      if (t.v === "true") return ok({ t: "lit", v: true });
      if (t.v === "false") return ok({ t: "lit", v: false });
      if (t.v === "null") return ok({ t: "lit", v: null });
      const segs = t.v.split(".");
      for (const s of segs) {
        if (FORBIDDEN_SEGMENTS.has(s)) return fail("GuardParseError", `forbidden identifier segment '${s}'`);
        if (s.length === 0) return fail("GuardParseError", "empty identifier segment");
      }
      return ok({ t: "path", segs });
    }
    return fail("GuardParseError", `unexpected token '${t.v}'`);
  }
  atEnd() {
    return this.pos >= this.toks.length;
  }
}

export function compileGuard(expr) {
  if (expr.length > MAX_EXPR_LEN) return fail("GuardParseError", "expression too long");
  const toks = tokenize(expr);
  if (!toks.ok) return toks;
  const parser = new Parser(toks.value);
  const ast = parser.parse(0);
  if (!ast.ok) return ast;
  if (!parser.atEnd()) return fail("GuardParseError", "trailing tokens after expression");
  return ok({ expr, ast: ast.value });
}

// Safe own-property path lookup: never crosses into a prototype.
function lookup(ctx, segs) {
  let cur = ctx;
  for (const s of segs) {
    if (cur === null || typeof cur !== "object") return undefined;
    if (!Object.prototype.hasOwnProperty.call(cur, s)) return undefined;
    cur = cur[s];
  }
  return cur;
}

function evalNode(n, ctx) {
  switch (n.t) {
    case "lit":
      return n.v;
    case "path":
      return lookup(ctx, n.segs);
    case "arr":
      return n.items.map((i) => evalNode(i, ctx));
    case "unary":
      return !truthy(evalNode(n.e, ctx));
    case "bin": {
      if (n.op === "&&") return truthy(evalNode(n.l, ctx)) && truthy(evalNode(n.r, ctx));
      if (n.op === "||") return truthy(evalNode(n.l, ctx)) || truthy(evalNode(n.r, ctx));
      const l = evalNode(n.l, ctx);
      const r = evalNode(n.r, ctx);
      switch (n.op) {
        case "==":
          return l === r;
        case "!=":
          return l !== r;
        case ">":
          return l > r;
        case ">=":
          return l >= r;
        case "<":
          return l < r;
        case "<=":
          return l <= r;
        case "in":
          return Array.isArray(r) ? r.includes(l) : false;
        case "has":
          if (Array.isArray(l)) return l.includes(r);
          if (l && typeof l === "object") return Object.prototype.hasOwnProperty.call(l, String(r));
          return false;
      }
      return false;
    }
  }
}

function truthy(v) {
  return v !== false && v !== null && v !== undefined && v !== 0 && v !== "";
}

export function evalGuard(g, ctx) {
  return truthy(evalNode(g.ast, ctx));
}
