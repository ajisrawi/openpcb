/**
 * S-expression reader/writer for the SPECCTRA design language.
 *
 * The language is a tree of parenthesised lists whose leaves are atoms
 * (identifiers, numbers, quoted strings). `#` starts a comment to end of line.
 * The `(parser (string_quote ")` descriptor can change the quote character,
 * and `(space_in_quoted_tokens on)` allows spaces inside quoted tokens; both
 * are honoured when they appear near the top of the file.
 */

export type SAtom = string;
export type SNode = SAtom | SList;
export interface SList extends Array<SNode> {}

export interface ParseOptions {
  /** Quote character, default `"`. */
  quote?: string;
}

export class SExprError extends Error {
  constructor(message: string, public readonly offset: number, public readonly line: number) {
    super(`${message} (line ${line})`);
  }
}

/** Parse a complete document; returns the list of top-level forms. */
export function parseSExpr(text: string, options: ParseOptions = {}): SList {
  let quote = options.quote ?? '"';
  // Pre-scan for a string_quote declaration so odd quote chars work.
  const sq = /\(\s*string_quote\s+(\S)\s*\)/.exec(text.slice(0, 2000));
  if (sq && !options.quote) quote = sq[1];

  const n = text.length;
  let i = 0;
  let line = 1;
  const root: SList = [];
  const stack: SList[] = [root];

  const isDelim = (c: string) => c === '(' || c === ')' || c === ' ' || c === '\t' || c === '\r' || c === '\n' || c === '\f';

  while (i < n) {
    const c = text[i];
    if (c === '\n') { line++; i++; continue; }
    if (c === ' ' || c === '\t' || c === '\r' || c === '\f') { i++; continue; }
    if (c === '#') { while (i < n && text[i] !== '\n') i++; continue; }
    if (c === '(') { const l: SList = []; stack[stack.length - 1].push(l); stack.push(l); i++; continue; }
    if (c === ')') {
      if (stack.length === 1) throw new SExprError('Unbalanced )', i, line);
      stack.pop(); i++; continue;
    }
    if (c === quote) {
      // (string_quote ") declares the quote character itself: take it literally.
      const cur = stack[stack.length - 1];
      if (cur.length === 1 && isAtom(cur[0]) && (cur[0] as string).toLowerCase() === 'string_quote') { cur.push(c); i++; continue; }
      // Quoted token: keep contents verbatim (quote char doubled inside is kept as-is; SPECCTRA has no escape).
      let j = i + 1;
      while (j < n && text[j] !== quote) { if (text[j] === '\n') line++; j++; }
      if (j >= n) throw new SExprError('Unterminated quoted string', i, line);
      stack[stack.length - 1].push(text.slice(i + 1, j));
      i = j + 1; continue;
    }
    let j = i;
    while (j < n && !isDelim(text[j])) j++;
    stack[stack.length - 1].push(text.slice(i, j));
    i = j;
  }
  if (stack.length !== 1) throw new SExprError('Unbalanced (', i, line);
  return root;
}

export function isList(n: SNode): n is SList { return Array.isArray(n); }
export function isAtom(n: SNode): n is SAtom { return typeof n === 'string'; }

/** First element of a list as a lowercase keyword, or '' for atoms / empty lists. */
export function head(n: SNode): string {
  return isList(n) && n.length > 0 && isAtom(n[0]) ? (n[0] as string).toLowerCase() : '';
}

/** All direct children that are lists with the given head. */
export function children(n: SNode, key: string): SList[] {
  if (!isList(n)) return [];
  const k = key.toLowerCase();
  return n.filter((c): c is SList => isList(c) && head(c) === k);
}

/** First direct child list with the given head. */
export function child(n: SNode, key: string): SList | undefined {
  return children(n, key)[0];
}

/** Atom arguments of a list (direct children that are atoms, excluding the head). */
export function atoms(n: SNode): string[] {
  if (!isList(n)) return [];
  return n.slice(1).filter(isAtom) as string[];
}

export function num(a: SNode | undefined, def = 0): number {
  if (a === undefined || !isAtom(a)) return def;
  const v = Number(a);
  return Number.isFinite(v) ? v : def;
}

/* ---------- writer ---------- */

export interface WriteOptions { indent?: string; maxLineAtoms?: number; }

/**
 * Serialise a tree back to text. Lists whose children are all atoms are
 * printed on one line; nested lists are indented one level per depth.
 */
export function writeSExpr(node: SNode, opts: WriteOptions = {}, depth = 0): string {
  const indent = opts.indent ?? '  ';
  if (isAtom(node)) return quoteIfNeeded(node);
  const list = node as SList;
  if (list.every(isAtom)) return '(' + list.map(quoteIfNeeded).join(' ') + ')';
  const pad = indent.repeat(depth + 1);
  let out = '(';
  let first = true;
  let lineHasAtoms = false;
  for (const c of list) {
    if (isAtom(c)) {
      out += (first ? '' : ' ') + quoteIfNeeded(c);
      lineHasAtoms = true;
    } else {
      out += '\n' + pad + writeSExpr(c, opts, depth + 1);
      lineHasAtoms = false;
    }
    first = false;
  }
  out += lineHasAtoms && list.every((c, i) => i === 0 || isAtom(c)) ? ')' : '\n' + indent.repeat(depth) + ')';
  return out;
}

export function quoteIfNeeded(a: string): string {
  if (a === '') return '""';
  if (a === '"') return a;   // the string_quote declaration
  return /[\s()"#]/.test(a) ? '"' + a + '"' : a;
}

/** Format a number for DSN output (no exponent, trimmed trailing zeros). */
export function fmt(v: number, decimals = 4): string {
  if (Number.isInteger(v)) return String(v);
  return v.toFixed(decimals).replace(/\.?0+$/, '');
}
