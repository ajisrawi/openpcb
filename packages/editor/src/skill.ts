/**
 * OpenSKILL: a SKILL-compatible scripting language for OpenBoard (Allegro SKILL / axl counterpart).
 *
 * Syntax: both SKILL forms are read - Lisp calls `(plus 1 2)` and C-style calls `plus(1 2)` (the open parenthesis
 * directly after the name), infix operators (= assignment, || && ! == != < > <= >= + - * / **), property access
 * `obj->prop` (and `obj->prop = value`), list property access `objs~>prop`, quoted data `'(1 2 3)`, `'sym`, blocks
 * `{ ... }`, comments `;` and `/* ... *\/`, keyword arguments `?name value`.
 *
 * Special forms: quote setq let prog progn return if(c then .. else ..) when unless cond case while for foreach
 * (also foreach(mapcar ...)) setof exists procedure defun lambda and or getq putpropq.
 * Library: arithmetic and comparison, list functions (car cdr cadr cddr caar cons list append append1 length nth
 * reverse member memq assoc sort mapcar mapc apply funcall last remove), strings (strcat sprintf printf println
 * strlen substring upperCase lowerCase parseString buildString rexMatchp index concat), math (sqrt abs sin cos tan
 * atan2 exp log max min round floor ceiling fix float mod), predicates (numberp stringp listp symbolp null zerop).
 *
 * Design access (axl): axlDBGetDesign() -> design with ->name ->components ->nets ->traces ->vias ->layers ->outline
 * ->rules; parts (->refdes ->x ->y ->xy ->rotation ->side ->value ->footprint ->pins), nets (->name ->pins ->traces
 * ->vias ->length), traces (->net ->layer ->width ->points ->length), vias (->net ->x ->y ->diameter ->drill), pins
 * (->name ->net ->xy ->layers). Setting ->x ->y ->rotation ->side ->value ->width ->net changes the design.
 * axlDBCreateLine axlDBCreateVia axlDeleteObject axlTransformObject axlSelectByName axlNetLength axlRatsnest axlDRC
 * axlRun (any openpcb command, when the host provides it) axlMsgPut.
 */
import { type Project, type Pt, type Trace, type ViaDef, type Component, nextId } from './model.js';
import { padInstances, ratsnest } from './connectivity.js';

/* ------------------------------------------------------------------ values */

export interface Sym { sym: string }
type Fn = { fn: (args: Val[], env: Env, kw: Record<string, Val>) => Val; name: string };
type Lambda = { params: string[]; optional: string[]; rest?: string; body: Val[]; env: Env; name: string };
export type Val = number | string | Sym | Val[] | null | true | Fn | Lambda | DbObj;
export interface DbObj { db: string; get(k: string): Val; put?(k: string, v: Val): void; raw: unknown }

const S = (s: string): Sym => ({ sym: s });
const isSym = (v: Val): v is Sym => !!v && typeof v === 'object' && 'sym' in (v as object);
const isList = (v: Val): v is Val[] => Array.isArray(v);
const isFn = (v: Val): v is Fn => !!v && typeof v === 'object' && 'fn' in (v as object);
const isLambda = (v: Val): v is Lambda => !!v && typeof v === 'object' && 'body' in (v as object) && 'params' in (v as object);
const isDb = (v: Val): v is DbObj => !!v && typeof v === 'object' && 'db' in (v as object);
const truthy = (v: Val) => !(v === null || v === undefined || (Array.isArray(v) && v.length === 0));
const nil = null;

class Env {
  vars = new Map<string, Val>();
  constructor(public parent: Env | null = null) {}
  lookup(n: string): Env | null { let e: Env | null = this; while (e) { if (e.vars.has(n)) return e; e = e.parent; } return null; }
  get(n: string): Val { const e = this.lookup(n); if (!e) throw new SkillError(`unbound variable ${n}`); return e.vars.get(n)!; }
  set(n: string, v: Val) { const e = this.lookup(n); (e ?? this.root()).vars.set(n, v); }
  def(n: string, v: Val) { this.vars.set(n, v); }
  root(): Env { let e: Env = this; while (e.parent) e = e.parent; return e; }
}
export class SkillError extends Error {}
class Return { constructor(public v: Val) {} }

/* ------------------------------------------------------------------ reader */

type Tok = { t: 'num' | 'str' | 'id' | 'op' | 'quote' | 'kw'; v: string; pre: boolean };   // pre: whitespace before

function lex(src: string): Tok[] {
  const out: Tok[] = [];
  let i = 0, ws = true;
  const ops = ['**', '==', '!=', '<=', '>=', '&&', '||', '->', '~>', '++', '--', '(', ')', '{', '}', '[', ']', '+', '-', '*', '/', '<', '>', '=', '!', ',', ':'];
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) { i++; ws = true; continue; }
    if (c === ';') { while (i < src.length && src[i] !== '\n') i++; ws = true; continue; }
    if (c === '/' && src[i + 1] === '*') { const e = src.indexOf('*/', i + 2); i = e < 0 ? src.length : e + 2; ws = true; continue; }
    if (c === '"') {
      let s = ''; i++;
      while (i < src.length && src[i] !== '"') { if (src[i] === '\\') { const n = src[++i]; s += n === 'n' ? '\n' : n === 't' ? '\t' : n; i++; } else s += src[i++]; }
      i++; out.push({ t: 'str', v: s, pre: ws }); ws = false; continue;
    }
    if (c === "'") { out.push({ t: 'quote', v: "'", pre: ws }); i++; ws = false; continue; }
    const num = /^(\d+\.?\d*([eE][-+]?\d+)?|\.\d+([eE][-+]?\d+)?)/.exec(src.slice(i));
    if (num) { out.push({ t: 'num', v: num[0], pre: ws }); i += num[0].length; ws = false; continue; }
    if (c === '?' && /[A-Za-z_]/.test(src[i + 1] ?? '')) { const m = /^\?[A-Za-z_][\w]*/.exec(src.slice(i))!; out.push({ t: 'kw', v: m[0].slice(1), pre: ws }); i += m[0].length; ws = false; continue; }
    const id = /^[A-Za-z_$][\w$?.@]*/.exec(src.slice(i));
    if (id) { let v = id[0]; while (v.endsWith('.')) v = v.slice(0, -1); out.push({ t: 'id', v, pre: ws }); i += v.length; ws = false; continue; }
    const op = ops.find((o) => src.startsWith(o, i));
    if (op) { out.push({ t: 'op', v: op, pre: ws }); i += op.length; ws = false; continue; }
    throw new SkillError(`unexpected character '${c}'`);
  }
  return out;
}

const PREC: Record<string, number> = { '=': 1, '||': 2, '&&': 3, '==': 4, '!=': 4, '<': 5, '>': 5, '<=': 5, '>=': 5, '+': 6, '-': 6, '*': 7, '/': 7, '**': 8 };
const OPFN: Record<string, string> = { '||': 'or', '&&': 'and', '==': 'equal', '!=': 'nequal', '<': 'lessp', '>': 'greaterp', '<=': 'leqp', '>=': 'geqp', '+': 'plus', '-': 'difference', '*': 'times', '/': 'quotient', '**': 'expt' };

class Parser {
  i = 0;
  constructor(private toks: Tok[]) {}
  peek(): Tok | undefined { return this.toks[this.i]; }
  next(): Tok { const t = this.toks[this.i++]; if (!t) throw new SkillError('unexpected end of input'); return t; }
  isOp(v: string, t = this.peek()) { return !!t && t.t === 'op' && t.v === v; }
  program(): Val[] { const out: Val[] = []; while (this.peek()) out.push(this.expr(0)); return out; }
  expr(minP: number): Val {
    let left = this.unary();
    for (;;) {
      const t = this.peek();
      if (!t || t.t !== 'op' || PREC[t.v] === undefined || PREC[t.v] < minP) break;
      // SKILL: "a -b" (space before the sign, none after) is two arguments, the second negative; "a - b" subtracts
      if ((t.v === '-' || t.v === '+') && t.pre) { const nx = this.toks[this.i + 1]; if (nx && !nx.pre) break; }
      this.next();
      if (t.v === '=') { const right = this.expr(1); left = assign(left, right); continue; }
      const right = this.expr(t.v === '**' ? PREC[t.v] : PREC[t.v] + 1);
      left = [S(OPFN[t.v]), left, right];
    }
    return left;
  }
  unary(): Val {
    if (this.isOp('-')) { this.next(); return [S('minus'), this.unary()]; }
    if (this.isOp('!')) { this.next(); return [S('not'), this.unary()]; }
    return this.postfix(this.primary());
  }
  postfix(v: Val): Val {
    for (;;) {
      if (this.isOp('->')) { this.next(); const n = this.next(); v = [S('getq'), v, S(n.v)]; continue; }
      if (this.isOp('~>')) { this.next(); const n = this.next(); v = [S('mapget'), v, S(n.v)]; continue; }
      if (this.isOp('[') && !this.peek()!.pre) { this.next(); const ix = this.expr(0); this.expect(']'); v = [S('nth'), ix, v]; continue; }
      if (this.isOp('++')) { this.next(); v = [S('setq'), v, [S('plus'), v, 1]]; continue; }
      return v;
    }
  }
  expect(v: string) { const t = this.next(); if (t.t !== 'op' || t.v !== v) throw new SkillError(`expected '${v}', got '${t.v}'`); }
  primary(): Val {
    const t = this.next();
    if (t.t === 'num') return Number(t.v);
    if (t.t === 'str') return t.v;
    if (t.t === 'kw') return S('?' + t.v);
    if (t.t === 'quote') return [S('quote'), this.datum()];
    if (t.t === 'op' && t.v === '(') { const items: Val[] = []; while (!this.isOp(')')) items.push(this.expr(0)); this.next(); return items; }
    if (t.t === 'op' && t.v === '{') { const items: Val[] = [S('progn')]; while (!this.isOp('}')) items.push(this.expr(0)); this.next(); return items; }
    if (t.t === 'id') {
      if (t.v === 'nil') return nil;
      if (t.v === 't') return true;
      // C-style call: the open parenthesis directly after the name
      const n = this.peek();
      if (n && n.t === 'op' && n.v === '(' && !n.pre) {
        this.next();
        const items: Val[] = [S(t.v)];
        while (!this.isOp(')')) { items.push(this.expr(0)); if (this.isOp(',')) this.next(); }
        this.next();
        return items;
      }
      return S(t.v);
    }
    throw new SkillError(`unexpected '${t.v}'`);
  }
  /** quoted data: lists of atoms, no infix */
  datum(): Val {
    const t = this.next();
    if (t.t === 'num') return Number(t.v);
    if (t.t === 'str') return t.v;
    if (t.t === 'id') return t.v === 'nil' ? nil : t.v === 't' ? true : S(t.v);
    if (t.t === 'kw') return S('?' + t.v);
    if (t.t === 'op' && t.v === '(') { const items: Val[] = []; while (!this.isOp(')')) items.push(this.datum()); this.next(); return items; }
    if (t.t === 'op' && (t.v === '-' || t.v === '+')) { const n = this.next(); return (t.v === '-' ? -1 : 1) * Number(n.v); }
    if (t.t === 'quote') return [S('quote'), this.datum()];
    return S(t.v);
  }
}
function assign(target: Val, value: Val): Val {
  if (isSym(target)) return [S('setq'), target, value];
  if (isList(target) && isSym(target[0]) && (target[0].sym === 'getq' || target[0].sym === 'mapget')) return [S('putpropq'), target[1], value, target[2]];
  if (isList(target) && isSym(target[0]) && target[0].sym === 'nth') return [S('setnth'), target[1], target[2], value];
  throw new SkillError('bad assignment target');
}

export function parse(src: string): Val[] { return new Parser(lex(src)).program(); }

/* ------------------------------------------------------------------ printing */

export function show(v: Val): string {
  if (v === null || v === undefined) return 'nil';
  if (v === true) return 't';
  if (typeof v === 'number') return Number.isInteger(v) ? String(v) : String(Math.round(v * 1e6) / 1e6);
  if (typeof v === 'string') return JSON.stringify(v);
  if (isSym(v)) return v.sym;
  if (isList(v)) return `(${v.map(show).join(' ')})`;
  if (isFn(v)) return `funobj:${v.name}`;
  if (isLambda(v)) return `funobj:${v.name || 'lambda'}`;
  if (isDb(v)) return `dbid:${v.db}`;
  return String(v);
}
const plain = (v: Val) => (typeof v === 'string' ? v : show(v));

/* ------------------------------------------------------------------ interpreter */

export interface SkillHost { print?: (s: string) => void; run?: (cmd: string, args: string[]) => unknown; drc?: () => { kind: string; message: string; x: number; y: number }[] }

export class Skill {
  readonly global = new Env();
  out: string[] = [];
  constructor(public project: Project, public host: SkillHost = {}) { this.install(); }

  run(src: string): Val { let v: Val = nil; for (const f of parse(src)) v = this.eval(f, this.global); return v; }

  eval(x: Val, env: Env): Val {
    if (isSym(x)) { if (x.sym.startsWith('?')) return x; return env.get(x.sym); }
    if (!isList(x)) return x;
    if (!x.length) return nil;
    const head = x[0];
    if (isSym(head)) {
      const sf = this.special[head.sym];
      if (sf) return sf(x.slice(1), env);
    }
    const f = isSym(head) ? env.get(head.sym) : this.eval(head, env);
    // keyword arguments ?name value
    const args: Val[] = []; const kw: Record<string, Val> = {};
    for (let i = 1; i < x.length; i++) {
      const a = x[i];
      if (isSym(a) && a.sym.startsWith('?')) { kw[a.sym.slice(1)] = this.eval(x[++i], env); continue; }
      args.push(this.eval(a, env));
    }
    return this.apply(f, args, kw, isSym(head) ? head.sym : 'fn');
  }

  apply(f: Val, args: Val[], kw: Record<string, Val> = {}, name = 'fn'): Val {
    if (isSym(f)) { name = f.sym; f = this.global.get(f.sym); }   // 'name refers to the function of that name
    if (isFn(f)) return f.fn(args, this.global, kw);
    if (isLambda(f)) {
      const e = new Env(f.env);
      f.params.forEach((p, i) => { if (i >= args.length) throw new SkillError(`${f.name || name}: too few arguments`); e.def(p, args[i]); });
      f.optional.forEach((p, i) => e.def(p, kw[p] ?? args[f.params.length + i] ?? nil));
      if (f.rest) e.def(f.rest, args.slice(f.params.length + f.optional.length));
      let v: Val = nil;
      try { for (const b of f.body) v = this.eval(b, e); } catch (r) { if (r instanceof Return) return r.v; throw r; }
      return v;
    }
    throw new SkillError(`${name} is not a function`);
  }

  private body(forms: Val[], env: Env): Val { let v: Val = nil; for (const f of forms) v = this.eval(f, env); return v; }
  private lambdaOf(params: Val, body: Val[], env: Env, name: string): Lambda {
    const ps = isList(params) ? params : params === null ? [] : [params];
    const req: string[] = [], opt: string[] = []; let rest: string | undefined; let mode = 'req';
    for (const p of ps) {
      const n = isSym(p) ? p.sym : isList(p) && isSym(p[0]) ? p[0].sym : '';
      if (n === '@optional' || n === '@key') { mode = 'opt'; continue; }
      if (n === '@rest') { mode = 'rest'; continue; }
      if (mode === 'req') req.push(n); else if (mode === 'opt') opt.push(n); else rest = n;
    }
    return { params: req, optional: opt, rest, body, env, name };
  }

  special: Record<string, (a: Val[], env: Env) => Val> = {
    quote: (a) => a[0],
    setq: (a, env) => { const v = this.eval(a[1], env); env.set((a[0] as Sym).sym, v); return v; },
    progn: (a, env) => this.body(a, env),
    prog: (a, env) => { const e = new Env(env); for (const v of (a[0] as Val[] | null) ?? []) e.def(isSym(v) ? v.sym : (v as Sym[])[0].sym, nil); try { return this.body(a.slice(1), e); } catch (r) { if (r instanceof Return) return r.v; throw r; } },
    let: (a, env) => {
      const e = new Env(env);
      for (const b of (a[0] as Val[] | null) ?? []) { if (isSym(b)) e.def(b.sym, nil); else { const l = b as Val[]; e.def((l[0] as Sym).sym, this.eval(l[1], env)); } }
      return this.body(a.slice(1), e);
    },
    return: (a, env) => { throw new Return(a.length ? this.eval(a[0], env) : nil); },
    if: (a, env) => {
      const c = truthy(this.eval(a[0], env));
      const rest = a.slice(1);
      const ti = rest.findIndex((x) => isSym(x) && x.sym === 'then'), ei = rest.findIndex((x) => isSym(x) && x.sym === 'else');
      if (ti >= 0 || ei >= 0) {
        const thenB = rest.slice(ti >= 0 ? ti + 1 : 0, ei >= 0 ? ei : rest.length), elseB = ei >= 0 ? rest.slice(ei + 1) : [];
        return this.body(c ? thenB : elseB, env);
      }
      return c ? this.eval(rest[0], env) : this.body(rest.slice(1), env);
    },
    when: (a, env) => (truthy(this.eval(a[0], env)) ? this.body(a.slice(1), env) : nil),
    unless: (a, env) => (!truthy(this.eval(a[0], env)) ? this.body(a.slice(1), env) : nil),
    cond: (a, env) => { for (const cl of a) { const l = cl as Val[]; const c = this.eval(l[0], env); if (truthy(c)) return l.length > 1 ? this.body(l.slice(1), env) : c; } return nil; },
    case: (a, env) => {
      const v = this.eval(a[0], env);
      for (const cl of a.slice(1)) { const l = cl as Val[]; const k = l[0]; if ((isSym(k) && k.sym === 't') || k === true || (isList(k) ? k.some((x) => equal(x, v)) : equal(k, v))) return this.body(l.slice(1), env); }
      return nil;
    },
    while: (a, env) => { let n = 0; while (truthy(this.eval(a[0], env))) { this.body(a.slice(1), env); if (++n > 1e7) throw new SkillError('while: too many iterations'); } return true; },
    for: (a, env) => { const v = (a[0] as Sym).sym, from = this.eval(a[1], env) as number, to = this.eval(a[2], env) as number; const e = new Env(env); for (let i = from; i <= to; i++) { e.def(v, i); this.body(a.slice(3), e); } return true; },
    foreach: (a, env) => {
      let mode = '', k = 0;
      if (isSym(a[0]) && (a[0].sym === 'mapcar' || a[0].sym === 'mapc')) { mode = a[0].sym; k = 1; }
      const v = (a[k] as Sym).sym; const list = this.eval(a[k + 1], env);
      const items = isList(list) ? list : list === null ? [] : [list];
      const e = new Env(env); const out: Val[] = [];
      for (const it of items) { e.def(v, it); out.push(this.body(a.slice(k + 2), e)); }
      return mode === 'mapcar' ? out : list;
    },
    setof: (a, env) => { const v = (a[0] as Sym).sym; const list = this.eval(a[1], env); const e = new Env(env); return ((list as Val[]) ?? []).filter((it) => { e.def(v, it); return truthy(this.eval(a[2], e)); }); },
    exists: (a, env) => { const v = (a[0] as Sym).sym; const list = this.eval(a[1], env); const e = new Env(env); for (const it of (list as Val[]) ?? []) { e.def(v, it); if (truthy(this.eval(a[2], e))) return [it]; } return nil; },
    procedure: (a, env) => { const sig = a[0] as Val[]; const name = (sig[0] as Sym).sym; const f = this.lambdaOf(sig.slice(1), a.slice(1), env, name); this.global.def(name, f); return S(name); },
    defun: (a, env) => { const name = (a[0] as Sym).sym; const f = this.lambdaOf(a[1], a.slice(2), env, name); this.global.def(name, f); return S(name); },
    lambda: (a, env) => this.lambdaOf(a[0], a.slice(1), env, ''),
    and: (a, env) => { let v: Val = true; for (const x of a) { v = this.eval(x, env); if (!truthy(v)) return nil; } return v; },
    or: (a, env) => { for (const x of a) { const v = this.eval(x, env); if (truthy(v)) return v; } return nil; },
    getq: (a, env) => getProp(this.eval(a[0], env), (a[1] as Sym).sym),
    putpropq: (a, env) => { const o = this.eval(a[0], env), v = this.eval(a[1], env); putProp(o, (a[2] as Sym).sym, v); return v; },
    // obj~>prop: the property of one object, or of every object of a list
    mapget: (a, env) => { const l = this.eval(a[0], env); if (l !== null && !Array.isArray(l)) return getProp(l, (a[1] as Sym).sym); return ((l as Val[]) ?? []).map((o) => getProp(o, (a[1] as Sym).sym)); },
    setnth: (a, env) => { const i = this.eval(a[0], env) as number, l = this.eval(a[1], env) as Val[], v = this.eval(a[2], env); l[i] = v; return v; },
  };

  private install() {
    const g = this.global;
    const def = (name: string, fn: (args: Val[], kw: Record<string, Val>) => Val) => g.def(name, { fn: (a, _e, kw) => fn(a, kw), name });
    const num = (v: Val, f = 'arith') => { if (typeof v !== 'number') throw new SkillError(`${f}: ${show(v)} is not a number`); return v; };
    def('plus', (a) => (a.some((x) => typeof x === 'string') ? a.map(plain).join('') : a.reduce((s: number, x) => s + num(x, 'plus'), 0)));
    def('difference', (a) => (a.length === 1 ? -num(a[0]) : a.slice(1).reduce((s: number, x) => s - num(x), num(a[0]))));
    def('times', (a) => a.reduce((s: number, x) => s * num(x, 'times'), 1));
    def('quotient', (a) => a.slice(1).reduce((s: number, x) => s / num(x), num(a[0])));
    def('minus', (a) => -num(a[0]));
    def('expt', (a) => Math.pow(num(a[0]), num(a[1])));
    def('mod', (a) => num(a[0]) % num(a[1])); def('remainder', (a) => num(a[0]) % num(a[1]));
    def('add1', (a) => num(a[0]) + 1); def('sub1', (a) => num(a[0]) - 1);
    for (const [n, f] of [['sqrt', Math.sqrt], ['abs', Math.abs], ['sin', Math.sin], ['cos', Math.cos], ['tan', Math.tan], ['exp', Math.exp], ['log', Math.log], ['floor', Math.floor], ['ceiling', Math.ceil], ['round', Math.round], ['fix', Math.trunc]] as [string, (x: number) => number][]) def(n, (a) => f(num(a[0], n)));
    def('atan2', (a) => Math.atan2(num(a[0]), num(a[1]))); def('float', (a) => num(a[0])); def('max', (a) => Math.max(...a.map((x) => num(x)))); def('min', (a) => Math.min(...a.map((x) => num(x))));
    def('equal', (a) => (equal(a[0], a[1]) ? true : nil)); def('nequal', (a) => (equal(a[0], a[1]) ? nil : true)); def('eq', (a) => (a[0] === a[1] || equal(a[0], a[1]) ? true : nil)); def('neq', (a) => (equal(a[0], a[1]) ? nil : true));
    def('lessp', (a) => (num(a[0]) < num(a[1]) ? true : nil)); def('greaterp', (a) => (num(a[0]) > num(a[1]) ? true : nil)); def('leqp', (a) => (num(a[0]) <= num(a[1]) ? true : nil)); def('geqp', (a) => (num(a[0]) >= num(a[1]) ? true : nil));
    def('not', (a) => (truthy(a[0]) ? nil : true)); def('null', (a) => (truthy(a[0]) ? nil : true)); def('zerop', (a) => (a[0] === 0 ? true : nil));
    def('numberp', (a) => (typeof a[0] === 'number' ? true : nil)); def('stringp', (a) => (typeof a[0] === 'string' ? true : nil)); def('listp', (a) => (isList(a[0]) || a[0] === null ? true : nil)); def('symbolp', (a) => (isSym(a[0]) ? true : nil)); def('dbobjectp', (a) => (isDb(a[0]) ? true : nil));
    // lists
    const L = (v: Val): Val[] => (v === null ? [] : isList(v) ? v : [v]);
    def('car', (a) => L(a[0])[0] ?? nil); def('cdr', (a) => L(a[0]).slice(1)); def('cadr', (a) => L(a[0])[1] ?? nil); def('cddr', (a) => L(a[0]).slice(2)); def('caar', (a) => L(L(a[0])[0])[0] ?? nil); def('caddr', (a) => L(a[0])[2] ?? nil);
    def('cons', (a) => [a[0], ...L(a[1])]); def('list', (a) => a); def('append', (a) => a.flatMap(L)); def('append1', (a) => [...L(a[0]), a[1]]);
    def('length', (a) => (typeof a[0] === 'string' ? a[0].length : L(a[0]).length)); def('nth', (a) => L(a[1])[num(a[0])] ?? nil); def('reverse', (a) => L(a[0]).slice().reverse());
    def('last', (a) => { const l = L(a[0]); return l.length ? [l[l.length - 1]] : nil; });
    def('member', (a) => { const l = L(a[1]); const i = l.findIndex((x) => equal(x, a[0])); return i >= 0 ? l.slice(i) : nil; }); def('memq', (a) => { const l = L(a[1]); const i = l.findIndex((x) => equal(x, a[0])); return i >= 0 ? l.slice(i) : nil; });
    def('remove', (a) => L(a[1]).filter((x) => !equal(x, a[0])));
    def('assoc', (a) => L(a[1]).find((x) => isList(x) && equal(x[0], a[0])) ?? nil);
    def('sort', (a) => { const l = L(a[0]).slice(); const f = a[1]; return l.sort((x, y) => (f ? (truthy(this.apply(f, [x, y])) ? -1 : truthy(this.apply(f, [y, x])) ? 1 : 0) : num(x) - num(y))); });
    def('mapcar', (a) => L(a[1]).map((x, i) => this.apply(a[0], a.length > 2 ? [x, ...a.slice(2).map((l) => L(l)[i])] : [x])));
    def('mapc', (a) => { L(a[1]).forEach((x) => this.apply(a[0], [x])); return a[1]; });
    def('apply', (a) => this.apply(a[0], L(a[1]))); def('funcall', (a) => this.apply(a[0], a.slice(1)));
    def('range', (a) => { const out: Val[] = []; for (let i = num(a[0]); i <= num(a[1]); i += a[2] !== undefined ? num(a[2]) : 1) out.push(i); return out; });
    // strings
    def('strcat', (a) => a.map(plain).join('')); def('concat', (a) => S(a.map(plain).join('')));
    def('strlen', (a) => String(a[0]).length); def('substring', (a) => String(a[0]).substr(num(a[1]) - 1, a[2] !== undefined ? num(a[2]) : undefined));
    def('upperCase', (a) => String(a[0]).toUpperCase()); def('lowerCase', (a) => String(a[0]).toLowerCase());
    def('parseString', (a) => String(a[0]).split(new RegExp(`[${(typeof a[1] === 'string' ? a[1] : ' ').replace(/[\]\\^-]/g, '\\$&')}]+`)).filter(Boolean));
    def('buildString', (a) => L(a[0]).map(plain).join(typeof a[1] === 'string' ? a[1] : ' '));
    def('rexMatchp', (a) => (new RegExp(String(a[0])).test(String(a[1])) ? true : nil));
    def('index', (a) => { const s = String(a[0]), i = s.indexOf(String(a[1])); return i >= 0 ? s.slice(i) : nil; });
    def('symbolToString', (a) => (isSym(a[0]) ? a[0].sym : String(a[0]))); def('stringToSymbol', (a) => S(String(a[0])));
    def('sprintf', (a) => fmt(String(a[1]), a.slice(2)));
    def('printf', (a) => { this.emit(fmt(String(a[0]), a.slice(1))); return true; });
    def('println', (a) => { this.emit(a.map(plain).join(' ') + '\n'); return a[0] ?? nil; });
    def('print', (a) => { this.emit(show(a[0])); return a[0] ?? nil; });
    def('axlMsgPut', (a) => { this.emit(fmt(String(a[0]), a.slice(1)) + '\n'); return true; });
    def('xCoord', (a) => L(a[0])[0] ?? nil); def('yCoord', (a) => L(a[0])[1] ?? nil);
    // design access
    def('axlDBGetDesign', () => this.design());
    def('axlSelectByName', (a) => {
      const kind = String(a[0]).toUpperCase(), names = L(a[1]).map(plain);
      if (kind === 'COMPONENT' || kind === 'REFDES') return this.project.components.filter((c) => names.includes(c.ref)).map((c) => this.comp(c));
      if (kind === 'NET') return this.project.nets.filter((n) => names.includes(n.name)).map((n) => this.net(n.name));
      throw new SkillError(`axlSelectByName: unknown kind ${kind}`);
    });
    def('axlDBCreateLine', (a, kw) => {
      const net = plain(a[0] ?? kw.net ?? ''), layer = plain(a[1] ?? kw.layer ?? this.project.layers[0].name), width = num(a[2] ?? kw.width ?? this.project.rules.width), pts = L(a[3] ?? kw.points).map((q) => ({ x: num(L(q)[0]), y: num(L(q)[1]) }));
      if (pts.length < 2) throw new SkillError('axlDBCreateLine: need two points');
      const t: Trace = { id: nextId(this.project), net, layer, width, points: pts };
      this.project.traces.push(t); return this.trace(t);
    });
    def('axlDBCreateVia', (a, kw) => { const v: ViaDef = { id: nextId(this.project), net: plain(a[0] ?? kw.net ?? ''), x: num(a[1] ?? kw.x), y: num(a[2] ?? kw.y), diameter: num(a[3] ?? kw.diameter ?? this.project.rules.viaDiameter), drill: num(a[4] ?? kw.drill ?? this.project.rules.viaDrill) }; this.project.vias.push(v); return this.via(v); });
    def('axlDeleteObject', (a) => {
      for (const o of L(a[0])) { if (!isDb(o)) continue; const r = o.raw;
        this.project.traces = this.project.traces.filter((t) => t !== r); this.project.vias = this.project.vias.filter((v) => v !== r);
        if (o.db === 'comp') { const c = r as Component; this.project.components = this.project.components.filter((x) => x !== c); for (const n of this.project.nets) n.pins = n.pins.filter((k) => !k.startsWith(c.ref + '-')); } }
      return true;
    });
    def('axlTransformObject', (a, kw) => {
      const mv = kw.move ? L(kw.move) : null, ang = kw.angle !== undefined ? num(kw.angle) : kw.rotate !== undefined ? num(kw.rotate) : 0;
      for (const o of L(a[0])) {
        if (!isDb(o)) continue;
        if (o.db === 'comp') { const c = o.raw as Component; if (mv) { c.x += num(mv[0]); c.y += num(mv[1]); } c.rot = (((c.rot + ang) % 360) + 360) % 360; if (kw.mirror && truthy(kw.mirror)) c.side = c.side === 'front' ? 'back' : 'front'; }
        else if (o.db === 'trace') { const t = o.raw as Trace; if (mv) t.points = t.points.map((q) => ({ x: q.x + num(mv[0]), y: q.y + num(mv[1]) })); }
        else if (o.db === 'via') { const v = o.raw as ViaDef; if (mv) { v.x += num(mv[0]); v.y += num(mv[1]); } }
      }
      return a[0];
    });
    def('axlNetLength', (a) => { const n = isDb(a[0]) ? String(a[0].get('name')) : plain(a[0]); return this.project.traces.filter((t) => t.net === n).reduce((s, t) => s + plen(t.points), 0); });
    def('axlRatsnest', () => ratsnest(this.project).length);
    def('axlDRC', () => (this.host.drc ? this.host.drc().map((m) => [m.kind, m.message, [m.x, m.y]]) : (() => { throw new SkillError('axlDRC: no DRC in this host'); })()));
    def('axlRun', (a) => { if (!this.host.run) throw new SkillError('axlRun: not available in this host'); const r = this.host.run(plain(a[0]), a.slice(1).map(plain)); return toVal(r); });
    def('axlShell', (a) => { if (!this.host.run) throw new SkillError('axlShell: not available'); const parts = String(a[0]).split(/\s+/).filter(Boolean); return toVal(this.host.run(parts[0], parts.slice(1))); });
  }

  emit(s: string) { this.out.push(s); this.host.print?.(s); }

  /* --- db objects --- */
  design(): DbObj {
    const p = this.project;
    return obj('design', p, (k) => {
      switch (k) {
        case 'name': return p.name;
        case 'components': return p.components.map((c) => this.comp(c));
        case 'nets': return p.nets.map((n) => this.net(n.name));
        case 'traces': return p.traces.map((t) => this.trace(t));
        case 'vias': return p.vias.map((v) => this.via(v));
        case 'layers': return p.layers.map((l) => l.name);
        case 'outline': return p.outline.map((q) => [q.x, q.y]);
        case 'rules': return Object.entries(p.rules).map(([a, b]) => [S(a), typeof b === 'number' || typeof b === 'string' ? b : show(toVal(b))]);
        case 'objType': return 'design';
      }
      return nil;
    }, (k, v) => { if (k === 'name') p.name = plain(v); });
  }
  comp(c: Component): DbObj {
    return obj('comp', c, (k) => {
      switch (k) {
        case 'refdes': case 'name': return c.ref;
        case 'x': return c.x; case 'y': return c.y; case 'xy': return [c.x, c.y];
        case 'rotation': return c.rot; case 'side': return c.side === 'front' ? 'top' : 'bottom'; case 'value': return c.value; case 'footprint': case 'symbol': return c.footprint;
        case 'locked': return c.locked ? true : nil; case 'objType': return 'component';
        case 'pins': return padInstances(this.project).filter((pd) => pd.ref === c.ref).map((pd) => obj('pin', pd, (kk) => kk === 'name' ? pd.padId : kk === 'net' ? pd.net : kk === 'xy' ? [pd.center.x, pd.center.y] : kk === 'layers' ? pd.layers : kk === 'number' ? pd.padId : kk === 'objType' ? 'pin' : nil));
      }
      return nil;
    }, (k, v) => {
      if (k === 'x') c.x = Number(v); else if (k === 'y') c.y = Number(v); else if (k === 'xy') { c.x = Number((v as Val[])[0]); c.y = Number((v as Val[])[1]); }
      else if (k === 'rotation') c.rot = Number(v); else if (k === 'side') c.side = /bot|back/i.test(plain(v)) ? 'back' : 'front'; else if (k === 'value') c.value = plain(v); else if (k === 'locked') c.locked = truthy(v);
      else throw new SkillError(`component ->${k} is read-only`);
    });
  }
  net(name: string): DbObj {
    const p = this.project;
    return obj('net', name, (k) => {
      const n = p.nets.find((x) => x.name === name);
      switch (k) {
        case 'name': return name; case 'pins': return n ? n.pins.slice() : nil;
        case 'traces': return p.traces.filter((t) => t.net === name).map((t) => this.trace(t));
        case 'vias': return p.vias.filter((v) => v.net === name).map((v) => this.via(v));
        case 'length': return p.traces.filter((t) => t.net === name).reduce((s, t) => s + plen(t.points), 0);
        case 'objType': return 'net';
      }
      return nil;
    });
  }
  trace(t: Trace): DbObj {
    return obj('trace', t, (k) => k === 'net' ? t.net : k === 'layer' ? t.layer : k === 'width' ? t.width : k === 'points' ? t.points.map((q) => [q.x, q.y]) : k === 'length' ? plen(t.points) : k === 'objType' ? 'path' : nil,
      (k, v) => { if (k === 'width') t.width = Number(v); else if (k === 'net') t.net = plain(v); else if (k === 'layer') t.layer = plain(v); else if (k === 'points') t.points = (v as Val[]).map((q) => ({ x: Number((q as Val[])[0]), y: Number((q as Val[])[1]) })); else throw new SkillError(`trace ->${k} is read-only`); });
  }
  via(v: ViaDef): DbObj {
    return obj('via', v, (k) => k === 'net' ? v.net : k === 'x' ? v.x : k === 'y' ? v.y : k === 'xy' ? [v.x, v.y] : k === 'diameter' ? v.diameter : k === 'drill' ? v.drill : k === 'objType' ? 'via' : nil,
      (k, val) => { if (k === 'x') v.x = Number(val); else if (k === 'y') v.y = Number(val); else if (k === 'net') v.net = plain(val); else if (k === 'diameter') v.diameter = Number(val); else if (k === 'drill') v.drill = Number(val); else throw new SkillError(`via ->${k} is read-only`); });
  }
}

function obj(db: string, raw: unknown, get: (k: string) => Val, put?: (k: string, v: Val) => void): DbObj { return { db, raw, get, put }; }
function getProp(o: Val, k: string): Val {
  if (isDb(o)) return o.get(k);
  if (isList(o)) { // disembodied property list (nil k1 v1 ...) or assoc list
    for (let i = 0; i + 1 < o.length; i++) if (isSym(o[i]) && (o[i] as Sym).sym === k) return o[i + 1];
    const a = o.find((x) => isList(x) && isSym(x[0]) && (x[0] as Sym).sym === k) as Val[] | undefined; return a ? a[1] : nil;
  }
  return nil;
}
function putProp(o: Val, k: string, v: Val) {
  if (isDb(o)) { if (!o.put) throw new SkillError(`${o.db}: properties are read-only`); o.put(k, v); return; }
  if (isList(o)) { for (let i = 0; i + 1 < o.length; i++) if (isSym(o[i]) && (o[i] as Sym).sym === k) { o[i + 1] = v; return; } o.push(S(k), v); return; }
  throw new SkillError('putprop: not an object');
}
function equal(a: Val, b: Val): boolean {
  if (a === b) return true;
  if (isSym(a) && isSym(b)) return a.sym === b.sym;
  if (isList(a) && isList(b)) return a.length === b.length && a.every((x, i) => equal(x, b[i]));
  if ((a === null && isList(b) && !b.length) || (b === null && isList(a) && !a.length)) return true;
  if (isDb(a) && isDb(b)) return a.raw === b.raw && a.db === b.db;
  return false;
}
function plen(pts: Pt[]) { let s = 0; for (let i = 1; i < pts.length; i++) s += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y); return s; }
function toVal(x: unknown): Val {
  if (x === null || x === undefined || x === false) return nil;
  if (x === true) return true;
  if (typeof x === 'number' || typeof x === 'string') return x;
  if (Array.isArray(x)) return x.map(toVal);
  if (typeof x === 'object') return Object.entries(x as Record<string, unknown>).map(([k, v]) => [S(k), toVal(v)]);
  return String(x);
}
/** SKILL printf: %d %f %g %s %L (any value) %n (number) %%, with width/precision. */
function fmt(f: string, args: Val[]): string {
  let i = 0;
  return f.replace(/%(-?\d*)(?:\.(\d+))?([dfgsLnx%])/g, (_, w: string, pr: string, c: string) => {
    if (c === '%') return '%';
    const a = args[i++];
    let s: string;
    if (c === 'd') s = String(Math.trunc(Number(a)));
    else if (c === 'f') s = Number(a).toFixed(pr !== undefined ? Number(pr) : 6);
    else if (c === 'g' || c === 'n') s = pr !== undefined ? Number(Number(a).toPrecision(Number(pr))).toString() : String(Math.round(Number(a) * 1e6) / 1e6);
    else if (c === 'x') s = Math.trunc(Number(a)).toString(16);
    else if (c === 'L') s = show(a);
    else s = plain(a);
    const width = Math.abs(Number(w) || 0);
    return w.startsWith('-') ? s.padEnd(width) : s.padStart(width);
  });
}
