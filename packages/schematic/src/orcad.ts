/**
 * OrCAD Capture import: designs (.DSN, "OrCAD Windows Design") and libraries (.OLB, "OrCAD Windows Library").
 *
 * Both are OLE compound files. Streams used:
 *   Library                      header, text fonts, page defaults, the string table (property names and values are
 *                                indices into it), part aliases
 *   Cache                        copies of every library symbol the design uses: library parts (one per view,
 *                                "74LS08.Normal" / ".Convert"), packages (pin numbers per unit), port / global /
 *                                off-page / title-block symbols
 *   Views/<sch>/Schematic        the page list of a schematic folder
 *   Views/<sch>/Pages/<page>     a page: title blocks, net table, wires and buses (with net aliases), placed parts,
 *                                hierarchical blocks, ports, globals, off-page connectors, bus entries, graphics
 *   Views/<root>/Hierarchy/Hierarchy   the occurrence tree: per hierarchical path the reference designator, unit
 *                                and pin numbers of every part, and the instance properties (PCB Footprint, ...)
 *
 * Records are chains of prefixes: (type u8, size u32, 0 u32) repeated, closed by a short prefix (type u8, n i16,
 * n x (name u32, value u32) property pairs into the string table), then an optional preamble (FF E4 5C 39, u32 n,
 * n bytes). The first long prefix gives the record's end, so records can be skipped without knowing every field.
 * Coordinates are 1/100 inch with y down; they are scaled to mils.
 *
 * Connectivity is taken from the drawing (wire ends, T joins, pins on wires); where two wires of the same stored
 * net cross without an end point on either, a junction is added so the geometry agrees with the stored nets.
 */
import { type Design, type Page, type LibPart, type LibUnit, type SymPin, type Graphic, type PinType, type Orient, type Pt, type PartInst, type Block, type BlockPin, type Port, type Library, newDesign, newPage, nid, toPage, PAGE_SIZES } from './model.js';
import { readCfb } from '../../editor/src/altium.js';

const U = 10;   // 1/100 inch -> mil
/** ORCAD_DEBUG=1 adds diagnostics to the import notes (Node only) */
const DEBUG = () => !!(globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env?.ORCAD_DEBUG;
const PORT_TYPES: PinType[] = ['input', 'bidirectional', 'output', 'open_collector', 'passive', 'tristate', 'open_emitter', 'power'];
const PRIMS = new Set([40, 41, 42, 43, 44, 45, 46, 47, 48, 87]);

interface Prefix { type: number; end: number; props: [number, number][]; n: number }

class Rd {
  b: Uint8Array; dv: DataView; p = 0;
  constructor(b: Uint8Array) { this.b = b; this.dv = new DataView(b.buffer, b.byteOffset, b.byteLength); }
  need(n: number) { if (this.p + n > this.b.length) throw new Error(`read past end @${this.p}`); }
  u8() { this.need(1); return this.b[this.p++]; }
  u16() { this.need(2); const v = this.dv.getUint16(this.p, true); this.p += 2; return v; }
  i16() { this.need(2); const v = this.dv.getInt16(this.p, true); this.p += 2; return v; }
  u32() { this.need(4); const v = this.dv.getUint32(this.p, true); this.p += 4; return v; }
  i32() { this.need(4); const v = this.dv.getInt32(this.p, true); this.p += 4; return v; }
  skip(n: number) { this.need(n); this.p += n; }
  zstr() { let s = ''; for (let i = 0; i < 4000; i++) { const c = this.u8(); if (!c) return s; s += String.fromCharCode(c); } throw new Error('string too long'); }
  /** u16 length + zero-terminated text (the length must match) */
  str() { const at = this.p; const n = this.u16(); const s = this.zstr(); if (s.length !== n) throw new Error(`string length ${n} != ${s.length} @${at}`); return s; }
  isStr(): boolean { const n = this.b[this.p] | (this.b[this.p + 1] << 8); if (this.p + 2 + n >= this.b.length || this.b[this.p + 2 + n] !== 0) return false; for (let i = 0; i < n; i++) { const c = this.b[this.p + 2 + i]; if (c < 32 && c !== 9) return false; } return true; }
  preamble() { const b = this.b, p = this.p; if (b[p] === 0xff && b[p + 1] === 0xe4 && b[p + 2] === 0x5c && b[p + 3] === 0x39) { this.p += 4; const n = this.u32(); this.skip(n); return true; } return false; }
  private tryPrefixes(n: number): Prefix {
    let type = -1, end = 0; const props: [number, number][] = [];
    for (let i = 0; i < n; i++) {
      const at = this.p; const t = this.u8(); if (i === 0) type = t; else if (t !== type) throw new Error('prefix type changes');
      if (i < n - 1) { const size = this.u32(); if (this.u32() !== 0) throw new Error('prefix padding'); if (at + 9 + size > this.b.length) throw new Error('prefix size'); if (i === 0) end = at + 9 + size; }
      else { const k = this.i16(); if (k > 500) throw new Error('too many properties'); for (let j = 0; j < k; j++) props.push([this.u32(), this.u32()]); }
    }
    return { type, end, props, n };
  }
  /** the longest valid prefix chain at the current position */
  prefixes(): Prefix { const s = this.p; for (let n = 10; n >= 1; n--) { try { return this.tryPrefixes(n); } catch { this.p = s; } } throw new Error(`no record prefix @${s}`); }
  peekType() { return this.b[this.p]; }
  hex(n = 24) { return Array.from(this.b.subarray(this.p, this.p + n), (x) => x.toString(16).padStart(2, '0')).join(' '); }
}

// ---------------------------------------------------------------------------------------------------------------
// Library stream: string table

interface LibStream { kind: 'design' | 'library'; strings: string[]; aliases: [string, string][]; root?: string }

function readLibraryStream(buf: Uint8Array): LibStream {
  const r = new Rd(buf);
  const intro = r.zstr(); r.p = 32;
  const kind = intro.startsWith('OrCAD Windows Library') ? 'library' : 'design';
  r.skip(4 + 12);
  const fonts = r.u16(); r.skip(Math.max(0, fonts - 1) * 60);
  const some = r.u16(); r.skip(some * 2 + 8);
  for (let i = 0; i < 8; i++) r.str();
  r.skip(156);                                         // page settings
  const strings: string[] = [];
  const at = r.p; let n = r.u32();
  // old files have a u16 count
  if (n > 1e6) { r.p = at; n = r.u16(); }
  for (let i = 0; i < n; i++) strings.push(r.str());
  const aliases: [string, string][] = [];
  try { const na = r.u16(); for (let i = 0; i < na; i++) aliases.push([r.str(), r.str()]); } catch { /* optional */ }
  let root: string | undefined;
  if (kind === 'design') { try { r.skip(8); root = r.str(); } catch { /* optional */ } }
  return { kind, strings, aliases, root };
}

// ---------------------------------------------------------------------------------------------------------------
// Symbols (library parts) and packages

interface OPin { name: string; start: Pt; hot: Pt; type: PinType; shape: number }
interface OSymbol { name: string; source: string; graphics: Graphic[]; pins: OPin[]; pinNamesVisible?: boolean; pinNumbersVisible?: boolean; /** stored pin slot of each pin (deleted pins leave empty slots) */ slots?: number[]; props: Record<string, string>; implementation?: string; implementationType?: number; refPrefix?: string; value?: string; bbox?: { x1: number; y1: number; x2: number; y2: number } }
interface ODevice { unit: string; cell: string; pins: string[] }
interface OPackage { name: string; source: string; refDes: string; footprint: string; devices: ODevice[] }

type S = (i: number) => string;

const scale = (v: number) => v * U;

/** one primitive (prefix already read); appends to out; coordinates offset by (ox, oy) in 1/100 inch */
function readPrimitive(r: Rd, t: number, out: Graphic[], ox: number, oy: number, notes: string[], inVector = false) {
  const P = (x: number, y: number): Pt => ({ x: scale(x + ox), y: scale(y + oy) });
  if (t === 48) {                                     // symbol vector: a group of primitives with its own origin
    r.p -= 1;
    const pf = r.prefixes(); r.preamble();
    const lx = r.i16(), ly = r.i16(); const n = r.u16();
    for (let i = 0; i < n; i++) { const t2 = r.u8(); r.u8(); r.u8(); readPrimitive(r, t2, out, ox + lx, oy + ly, notes, true); }
    try { r.str(); } catch { /* name */ }
    if (pf.end) r.p = Math.max(r.p, pf.end);
    return;
  }
  const start = r.p;
  let len = r.u32();
  // text primitives, and every primitive inside a symbol vector, count their length without the 8-byte header
  if (t === 46 || inVector) len += 8;
  const end = start + len;
  if (end > r.b.length || len < 8) throw new Error(`primitive ${t} length ${len}`);
  r.skip(4);
  const pts = (extraMin: number) => {
    // [style (8)] [fill (8)] u16 count, count x (y, x) i16
    for (const extra of [extraMin, 0, 8, 16]) { const at = start + 8 + extra; if (at + 2 > end) continue; const c = r.dv.getUint16(at, true); if (8 + extra + 2 + 4 * c === len || (c >= 2 && 8 + extra + 2 + 4 * c <= len && 8 + extra + 2 + 4 * c > len - 4)) { r.p = at + 2; const out2: Pt[] = []; for (let i = 0; i < c; i++) { const y = r.i16(), x = r.i16(); out2.push(P(x, y)); } return { pts: out2, fill: extra >= 16 ? r.dv.getUint32(start + 16, true) === 0 : false }; } }
    return { pts: [] as Pt[], fill: false };
  };
  switch (t) {
    case 40: { const x1 = r.i32(), y1 = r.i32(), x2 = r.i32(), y2 = r.i32(); const fill = len >= 40 ? r.dv.getUint32(start + 32, true) === 0 : false; const a = P(Math.min(x1, x2), Math.min(y1, y2)), b = P(Math.max(x1, x2), Math.max(y1, y2)); out.push({ kind: 'rect', x1: a.x, y1: a.y, x2: b.x, y2: b.y, fill }); break; }
    case 41: { const x1 = r.i32(), y1 = r.i32(), x2 = r.i32(), y2 = r.i32(); out.push({ kind: 'line', pts: [P(x1, y1), P(x2, y2)] }); break; }
    case 42: {
      const x1 = r.i32(), y1 = r.i32(), x2 = r.i32(), y2 = r.i32(), sx = r.i32(), sy = r.i32(), ex = r.i32(), ey = r.i32();
      const cx = (x1 + x2) / 2, cy = (y1 + y2) / 2, rx = Math.abs(x2 - x1) / 2, ry = Math.abs(y2 - y1) / 2;
      // screen angles (counter-clockwise on screen, y down); OrCAD sweeps counter-clockwise from start to end
      const ang = (x: number, y: number) => (Math.atan2(-(y - cy), x - cx) * 180) / Math.PI;
      let a0 = ang(sx, sy), a1 = ang(ex, ey); if (a1 <= a0) a1 += 360;
      if (Math.abs(rx - ry) < 0.5) out.push({ kind: 'arc', c: P(cx, cy), r: scale((rx + ry) / 2), a0, a1 });
      else { const ps: Pt[] = []; const k = Math.max(4, Math.ceil((a1 - a0) / 10)); for (let i = 0; i <= k; i++) { const a = ((a0 + ((a1 - a0) * i) / k) * Math.PI) / 180; ps.push(P(cx + rx * Math.cos(a), cy - ry * Math.sin(a))); } out.push({ kind: 'line', pts: ps }); }
      break;
    }
    case 43: {
      const x1 = r.i32(), y1 = r.i32(), x2 = r.i32(), y2 = r.i32(); const fill = len >= 40 ? r.dv.getUint32(start + 32, true) === 0 : false;
      const cx = (x1 + x2) / 2, cy = (y1 + y2) / 2, rx = Math.abs(x2 - x1) / 2, ry = Math.abs(y2 - y1) / 2;
      if (Math.abs(rx - ry) < 0.5) out.push({ kind: 'circle', c: P(cx, cy), r: scale(rx), fill });
      else { const ps: Pt[] = []; for (let i = 0; i < 36; i++) { const a = (i * Math.PI) / 18; ps.push(P(cx + rx * Math.cos(a), cy + ry * Math.sin(a))); } out.push({ kind: 'polygon', pts: ps, fill }); }
      break;
    }
    case 44: { const { pts: ps, fill } = pts(16); if (ps.length >= 3) out.push({ kind: 'polygon', pts: ps, fill }); break; }
    case 45: { const { pts: ps } = pts(8); if (ps.length >= 2) out.push({ kind: 'line', pts: ps }); break; }
    case 87: {
      const { pts: ps } = pts(8);
      if (ps.length >= 4) { const line: Pt[] = [ps[0]]; for (let i = 0; i + 3 < ps.length; i += 3) { const [a, b, c, d] = ps.slice(i, i + 4); for (let k = 1; k <= 8; k++) { const u = k / 8, v = 1 - u; line.push({ x: v * v * v * a.x + 3 * v * v * u * b.x + 3 * v * u * u * c.x + u * u * u * d.x, y: v * v * v * a.y + 3 * v * v * u * b.y + 3 * v * u * u * c.y + u * u * u * d.y }); } } out.push({ kind: 'line', pts: line }); }
      break;
    }
    case 46: { const lx = r.i32(), ly = r.i32(); r.skip(16); r.skip(4); const text = r.str(); out.push({ kind: 'text', at: P(lx, ly), text, size: 60 }); break; }
    case 47: notes.push('bitmap graphic skipped'); break;
    default: notes.push(`primitive ${t} skipped`);
  }
  r.p = end;
  r.preamble();
}

function readPrimitives(r: Rd, n: number, limit: number, out: Graphic[], notes: string[], ox = 0, oy = 0) {
  for (let i = 0; i < n; i++) {
    // two equal primitive ids; unknown filler bytes between primitives are skipped
    let k = 0;
    while (k < 64 && r.p + 2 <= limit && !(PRIMS.has(r.b[r.p]) && r.b[r.p] === r.b[r.p + 1])) { r.p++; k++; }
    if (r.p + 2 > limit) return;
    const t = r.u8(); r.u8();
    const s = r.p;
    try { readPrimitive(r, t, out, ox, oy, notes); } catch (e) { notes.push(`primitive ${t}: ${(e as Error).message}`); r.p = s; return; }
  }
}

/** position of the pin count: a u16 followed by a pin record (types 26 / 27), within 64 bytes; else a zero count */
function findPinList(r: Rd, end: number): number {
  for (let q = r.p; q < Math.min(end - 2, r.p + 96); q++) { const t = r.b[q + 2]; if ((t === 26 || t === 27) && r.b[q + 11] === t && r.dv.getUint16(q, true) > 0 && r.dv.getUint16(q, true) < 2000) return q; }
  // no pins: a zero count followed by the display-property list (count + record type 39), else the first zero count
  const isRec = (q: number, t: number) => r.b[q] === t && r.b[q + 9] === t;
  for (let q = r.p; q < Math.min(end - 4, r.p + 96); q++) if (r.dv.getUint16(q, true) === 0 && r.dv.getUint16(q + 2, true) > 0 && isRec(q + 4, 39)) return q;
  for (let q = r.p; q < Math.min(end - 2, r.p + 96); q++) if (r.dv.getUint16(q, true) === 0) return q;
  return r.p;
}

function readDispProp(r: Rd, s: S) {
  const pf = r.prefixes(); r.preamble();
  const name = s(r.u32()); const x = r.i16(), y = r.i16(); const rf = r.u16();
  if (pf.end) r.p = pf.end; else r.skip(4);
  return { name, x, y, rot: rf >> 14 };
}
function readDispProps(r: Rd, s: S) { const n = r.u16(); const out: ReturnType<typeof readDispProp>[] = []; for (let i = 0; i < n; i++) out.push(readDispProp(r, s)); return out; }

function readPin(r: Rd, s: S): OPin | null {
  const pf = r.prefixes(); r.preamble();
  const name = r.str(); const sx = r.i32(), sy = r.i32(), hx = r.i32(), hy = r.i32(); const shape = r.u16(); r.u16(); const pt = r.u32();
  if (pf.end) r.p = pf.end; else { r.skip(4); readDispProps(r, s); }
  return { name, start: { x: sx, y: sy }, hot: { x: hx, y: hy }, type: PORT_TYPES[pt] ?? 'passive', shape };
}

/** library part / symbol record (prefix chain at r.p) */
function readSymbol(r: Rd, s: S, notes: string[]): OSymbol {
  const pf = r.prefixes(); r.preamble();
  const end = pf.end || r.b.length;
  const props: Record<string, string> = {}; for (const [a, b] of pf.props) props[s(a)] = s(b);
  const name = r.str(); const source = r.str();
  const graphics: Graphic[] = [];
  r.skip(4);
  const np = r.u16();
  readPrimitives(r, np, end, graphics, notes);
  const pins: OPin[] = [];
  const sym: OSymbol = { name, source, graphics, pins, props };
  try {
    // the pin list follows the primitives; filler before it is skipped by looking for a pin record
    r.p = findPinList(r, end);
    // the symbol's size (width, height) precedes the pin count
    if (r.p - 4 >= 0) { const w = r.dv.getInt16(r.p - 4, true), h = r.dv.getInt16(r.p - 2, true); if (w > 0 && h > 0 && w < 5000 && h < 5000) sym.bbox = { x1: 0, y1: 0, x2: w, y2: h }; }
    const nPins = r.u16();
    const slots: number[] = [];
    for (let i = 0; i < nPins; i++) { if (r.b[r.p] === 0) { r.p++; continue; } const p = readPin(r, s); if (p) { pins.push(p); slots.push(i); } }
    if (slots.length !== nPins) sym.slots = slots;
    readDispProps(r, s);
    if (r.p < end) {
      r.preamble();
      const implPath = r.str(); const impl = r.str(); const refDes = r.str(); const value = r.str(); const bits = r.u8();
      sym.implementation = impl || undefined; sym.implementationType = (bits >> 3) & 7; sym.refPrefix = refDes || undefined; sym.value = value || undefined; void implPath;
      sym.pinNamesVisible = !!(bits & 1); sym.pinNumbersVisible = !(bits & 4);
    }
  } catch (e) { notes.push(`symbol ${name}: ${(e as Error).message}`); }
  if (pf.end) r.p = pf.end;
  return sym;
}

function readPackage(r: Rd): OPackage {
  const pf = r.prefixes(); r.preamble();
  const name = r.str(); const source = r.str(); const refDes = r.str(); r.str(); const footprint = r.str();
  const devices: ODevice[] = [];
  const nd = r.u16();
  for (let i = 0; i < nd; i++) {
    const dpf = r.prefixes(); r.preamble();
    const unit = r.str(); const cell = r.str();
    const n = r.u16(); const pins: string[] = [];
    for (let j = 0; j < n; j++) { const len = r.i16(); if (len === -1) { pins.push(''); continue; } r.p -= 2; pins.push(r.str()); r.u8(); }
    devices.push({ unit, cell, pins });
    if (dpf.end) r.p = dpf.end;
  }
  if (pf.end) r.p = pf.end;
  return { name, source, refDes, footprint, devices };
}

/** global / port / off-page symbols: "SthInPages0" body (graphics) + pins */
function readSpecialSymbol(r: Rd, s: S, notes: string[]): OSymbol {
  const pf = r.prefixes(); r.preamble();
  const end = pf.end || r.b.length;
  const name = r.str(); const source = r.str(); r.skip(4);
  const graphics: Graphic[] = []; const np = r.u16(); readPrimitives(r, np, end, graphics, notes);
  const pins: OPin[] = [];
  try {
    // optional bbox (8 bytes) before the pin list
    const g0 = r.p;
    r.p = findPinList(r, end);
    // outline: (x1, y1, x2, y2) i16 right after the graphics
    let bbox: OSymbol['bbox'];
    if (r.p - g0 >= 8) { const x1 = r.dv.getInt16(r.p - 8, true), y1 = r.dv.getInt16(r.p - 6, true), x2 = r.dv.getInt16(r.p - 4, true), y2 = r.dv.getInt16(r.p - 2, true); if (x2 >= x1 && y2 >= y1 && x2 - x1 < 2000 && y2 - y1 < 2000) bbox = { x1, y1, x2, y2 }; }
    const n = r.u16(); for (let i = 0; i < n; i++) { const p = readPin(r, s); if (p) pins.push(p); }
    if (pf.end) r.p = pf.end;
    return { name, source, graphics, pins, props: {}, bbox: bbox ?? graphicsBox(graphics, pins) };
  } catch { /* symbols without pins */ }
  if (pf.end) r.p = pf.end;
  return { name, source, graphics, pins, props: {}, bbox: graphicsBox(graphics, pins) };
}

/** outline of a symbol (1/100 inch) from its graphics (mils) and pins */
function graphicsBox(gs: Graphic[], pins: OPin[]): OSymbol['bbox'] {
  const xs: number[] = [], ys: number[] = [];
  const add = (p: Pt) => { xs.push(p.x / U); ys.push(p.y / U); };
  for (const g of gs) { if (g.kind === 'line' || g.kind === 'polygon') g.pts.forEach(add); else if (g.kind === 'rect') { add({ x: g.x1, y: g.y1 }); add({ x: g.x2, y: g.y2 }); } else if (g.kind === 'circle' || g.kind === 'arc') { add({ x: g.c.x - g.r, y: g.c.y - g.r }); add({ x: g.c.x + g.r, y: g.c.y + g.r }); } }
  for (const p of pins) { xs.push(p.hot.x, p.start.x); ys.push(p.hot.y, p.start.y); }
  if (!xs.length) return undefined;
  return { x1: Math.min(...xs), y1: Math.min(...ys), x2: Math.max(...xs), y2: Math.max(...ys) };
}

interface Cache { parts: Map<string, OSymbol>; packages: Map<string, OPackage>; specials: Map<string, OSymbol>; variants: Map<string, OSymbol[]>; notes: string[] }

function addSpecial(cache: Cache, sym: OSymbol) { cache.specials.set(sym.name, sym); const a = cache.variants.get(sym.name) ?? []; a.push(sym); cache.variants.set(sym.name, a); }

/** Walk a stream for library records (cache, or the streams of a library). */
function scanSymbols(buf: Uint8Array, s: S, cache: Cache) {
  const r = new Rd(buf); const b = buf;
  let p = 0;
  while (p < b.length - 12) {
    const t = b[p];
    if ((t === 24 || t === 31 || t === 33 || t === 34 || t === 35 || t === 64 || t === 75 || t === 76 || t === 98) && b[p + 9] === t && b[p + 5] === 0 && b[p + 6] === 0 && b[p + 7] === 0 && b[p + 8] === 0) {
      r.p = p;
      try {
        if (t === 24 || t === 34) { const sym = readSymbol(r, s, cache.notes); cache.parts.set(sym.name, sym); if (t === 34) addSpecial(cache, sym); p = Math.max(r.p, p + 1); continue; }
        if (t === 31) { const pk = readPackage(r); cache.packages.set(pk.name, pk); p = Math.max(r.p, p + 1); continue; }
        if (t === 33 || t === 35) { const sym = readSpecialSymbol(r, s, cache.notes); addSpecial(cache, sym); p = Math.max(r.p, p + 1); continue; }
        const pf = r.prefixes(); if (pf.end > p) { p = pf.end; continue; }
      } catch (e) { cache.notes.push(`library record ${t} @${p}: ${(e as Error).message}`); }
    }
    p++;
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Pages

interface OWire { bus: boolean; ref: number; net: number; a: Pt; b: Pt; aliases: { at: Pt; name: string; rot: number }[] }
interface OInstPin { idx: number; at: Pt; wire: number; net: number }
interface OInst { drawn: boolean; unit: number; value: string; impl: string; pkg: string; dbId: number; loc: Pt; bbox: { x1: number; y1: number; x2: number; y2: number }; rot: number; mirror: boolean; ref: string; props: Record<string, string>; pins: OInstPin[]; source: string; symbol?: OSymbol }
interface OGraphicInst { type: number; name: string; label: string; dbId: number; loc: Pt; bbox: { x1: number; y1: number; x2: number; y2: number }; props: Record<string, string>; rot: number; mirror: boolean; wire?: number; graphics: Graphic[] }
interface OPage { name: string; size: string; width: number; height: number; titles: OGraphicInst[]; nets: Map<number, string>; wires: OWire[]; insts: OInst[]; ports: OGraphicInst[]; globals: OGraphicInst[]; offPages: OGraphicInst[]; busEntries: { a: Pt; b: Pt }[]; graphics: OGraphicInst[] }

function readGraphicInst(r: Rd, pf: Prefix, s: S, notes: string[]): OGraphicInst {
  r.preamble();
  // the object's name (net name of a port / power symbol / off-page connector) as a string-table index
  const label = s(r.u32()); r.u32();
  const name = r.str(); const dbId = r.u32();
  const locY = r.i16(), locX = r.i16(), y2 = r.i16(), x2 = r.i16(), x1 = r.i16(), y1 = r.i16();
  r.u8(); const o1 = r.u8(); r.u8(); r.u8();
  const props: Record<string, string> = {}; for (const [a, b] of pf.props) props[s(a)] = s(b);
  readDispProps(r, s);
  const flag = r.u8();
  const graphics: Graphic[] = [];
  if (flag === 0x02) {
    try {
      const gpf = r.prefixes(); r.preamble();
      const gend = gpf.end || r.b.length;
      r.str(); r.str(); r.skip(4);
      const np = r.u16(); readPrimitives(r, np, gend, graphics, notes, locX, locY);
      if (gpf.end) r.p = gpf.end;
    } catch (e) { notes.push(`graphic ${name}: ${(e as Error).message}`); }
  }
  return { type: pf.type, name, label, dbId, loc: { x: locX, y: locY }, bbox: { x1, y1, x2, y2 }, props, rot: o1 & 3, mirror: !!(o1 & 4), graphics };
}

function readPage(buf: Uint8Array, s: S, notes: string[]): OPage {
  const r = new Rd(buf);
  r.prefixes(); r.preamble();
  const name = r.str(); const size = r.str();
  const ps = r.p; r.skip(24); const width = r.u32(), height = r.u32(); r.p = ps + 156;
  const pg: OPage = { name, size, width, height, titles: [], nets: new Map(), wires: [], insts: [], ports: [], globals: [], offPages: [], busEntries: [], graphics: [] };
  const list = <T>(fn: () => T): T[] => { const n = r.u16(); const out: T[] = []; for (let i = 0; i < n; i++) out.push(fn()); return out; };
  const rec = <T>(fn: (pf: Prefix) => T) => (): T => { const pf = r.prefixes(); const o = fn(pf); if (pf.end) r.p = pf.end; return o; };
  pg.titles = list(rec((pf) => readGraphicInst(r, pf, s, notes)));
  list(() => { r.skip(9); r.u32(); r.str(); r.skip(16); });
  list(() => { r.skip(9); r.u32(); r.str(); r.skip(16); const n = r.u16(); r.skip(4 * n); });
  for (const nt of list(() => ({ name: r.str(), id: r.u32() }))) pg.nets.set(nt.id, nt.name);
  pg.wires = list(rec((pf) => {
    r.preamble(); const ref = r.u32(); const net = r.u32(); r.u32();
    const x1 = r.i32(), y1 = r.i32(), x2 = r.i32(), y2 = r.i32(); r.u8();
    const aliases = list(rec(() => { r.preamble(); const x = r.i32(), y = r.i32(); r.u32(); const rot = r.u32(); r.u32(); return { at: { x: x * U, y: y * U }, rot, name: r.str() }; }));
    return { bus: pf.type === 21, ref, net, a: { x: x1 * U, y: y1 * U }, b: { x: x2 * U, y: y2 * U }, aliases };
  }));
  pg.insts = list(rec((pf) => {
    r.preamble();
    r.skip(8);
    const pkg = r.str(); const dbId = r.u32();
    const by1 = r.i16(), bx1 = r.i16(), by2 = r.i16(), bx2 = r.i16();
    const x = r.i16(), y = r.i16();
    const o = [r.u8(), r.u8(), r.u8(), r.u8()];
    readDispProps(r, s);
    const props: Record<string, string> = {}; for (const [a, b] of pf.props) props[s(a)] = s(b);
    const flag = r.u8();
    let symbol: OSymbol | undefined;
    if (flag !== 0 && r.b[r.p] === r.b[r.p + 9] && r.b[r.p] > 0) { try { symbol = readSymbol(r, s, notes); } catch (e) { notes.push(`block symbol: ${(e as Error).message}`); } }
    const ref = r.str();
    // value and implementation (child schematic of a block) as string-table indices
    const value = s(r.u32()); r.u32(); const impl = s(r.u32()); r.u16();
    const pins = list(rec(() => { r.preamble(); const idx = r.u16(); const px = r.i16(), py = r.i16(); const wire = r.u32(), net = r.u32(); return { idx, at: { x: px * U, y: py * U }, wire, net }; }));
    let source = '', unit = 0;
    if (pf.end && r.p < pf.end && r.isStr()) { source = r.str(); if (r.p + 2 <= pf.end) unit = r.u16(); }
    return { drawn: pf.type === 12, unit, value, impl, pkg, dbId, loc: { x: x * U, y: y * U }, bbox: { x1: bx1 * U, y1: by1 * U, x2: bx2 * U, y2: by2 * U }, rot: o[1] & 3, mirror: !!(o[1] & 4), ref, props, pins, source, symbol };
  }));
  pg.ports = list(rec((pf) => { const g = readGraphicInst(r, pf, s, notes); g.wire = r.u32(); return g; }));
  pg.globals = list(() => { const g = rec((pf) => readGraphicInst(r, pf, s, notes))(); g.wire = r.u32(); r.u8(); return g; });
  pg.offPages = list(() => { const g = rec((pf) => readGraphicInst(r, pf, s, notes))(); g.wire = r.u32(); r.u8(); return g; });
  list(rec((pf) => { const g = readGraphicInst(r, pf, s, notes); return g; }));                // ERC markers
  pg.busEntries = list(rec(() => { r.preamble(); r.u32(); const x1 = r.i32(), y1 = r.i32(), x2 = r.i32(), y2 = r.i32(); return { a: { x: x1 * U, y: y1 * U }, b: { x: x2 * U, y: y2 * U } }; }));
  try { pg.graphics = list(rec((pf) => readGraphicInst(r, pf, s, notes))); } catch (e) { notes.push(`page ${name} graphics: ${(e as Error).message}`); }
  return pg;
}

// ---------------------------------------------------------------------------------------------------------------
// Hierarchy (occurrences)

interface OOcc { dbId: number; name: string; ref: string; unit: string; props: Record<string, string>; pinNumbers: string[]; children: OOcc[] }

function readHierarchy(buf: Uint8Array, s: S, notes: string[]): OOcc {
  const r = new Rd(buf);
  const pinData = () => { if (r.isStr()) return r.str(); r.skip(2); return ''; };
  const isRec = (q: number, t: number) => r.b[q] === t && r.b[q + 9] === t && r.b[q + 5] === 0 && r.b[q + 6] === 0 && r.b[q + 7] === 0 && r.b[q + 8] === 0;
  /** a u16 count followed by a record of type t (or a zero count): skip filler / preambles up to it */
  const isPre = (q: number) => r.b[q] === 0xff && r.b[q + 1] === 0xe4 && r.b[q + 2] === 0x5c && r.b[q + 3] === 0x39;
  const seekCount = (t: number) => {
    const s0 = r.p;
    for (let k = 0; k < 8; k++) {
      if (isPre(r.p)) { r.preamble(); continue; }
      const c = r.dv.getUint16(r.p, true);
      if (c > 0 && isRec(r.p + 2, t)) return;
      // a zero count, unless filler / a preamble with the real count follows shortly
      if (c === 0) { let later = false; for (let q = r.p + 2; q <= r.p + 8; q += 2) if (isPre(q) || (r.dv.getUint16(q, true) > 0 && isRec(q + 2, t))) { later = true; break; } if (!later) return; }
      r.p += 2;
    }
    r.p = s0;
  };
  const body = (dbId: number, props: Record<string, string>): OOcc => {
    const bs = r.p; const t = r.u8(); const size = r.u32(); r.u32();
    if (t !== 0x42) throw new Error(`occurrence body type ${t} @${bs}`);
    const name = r.str(), ref = r.str(), unit = s(r.u32());
    const pinNumbers: string[] = [];
    seekCount(0x44);
    const np = r.u16();
    for (let i = 0; i < np; i++) { const pf = r.prefixes(); r.preamble(); r.u32(); pinData(); let num = ''; for (const [a, b] of pf.props) if (s(a) === 'Number') num = s(b); pinNumbers.push(num); }
    const o: OOcc = { dbId, name, ref, unit, props, pinNumbers, children: [] };
    if (!name) { r.p = bs + 9 + size; r.u16(); return o; }
    seekCount(0x43);
    const nn = r.u16(); for (let i = 0; i < nn; i++) { r.prefixes(); r.preamble(); r.u32(); r.str(); }
    // (T82: 8 bytes each) list, page-reference (T91) list with a u16 or u32 count, optional preamble, then the child
    // occurrences (T66) with a u16 or u32 count
    seekCount(0x52);
    const ng = r.u16();
    for (let g = 0; g < ng; g++) { r.prefixes(); r.preamble(); r.u32(); r.u32(); }
    const count = (t: number, allowZeroThen: (q: number) => boolean): number => {
      if (isRec(r.p + 4, t) && r.dv.getUint32(r.p, true) < 100000) return r.u32();
      if (isRec(r.p + 2, t)) return r.u16();
      if (r.dv.getUint32(r.p, true) === 0 && allowZeroThen(r.p + 4)) { r.p += 4; return 0; }
      if (r.dv.getUint16(r.p, true) === 0) { r.p += 2; return 0; }
      throw new Error(`no ${t} count @${r.p}`);
    };
    const childStart = (q: number) => isPre(q) || isRec(q + 2, 0x42) || isRec(q + 4, 0x42) || r.dv.getUint16(q, true) === 0;
    const n91 = count(0x5b, childStart);
    for (let i = 0; i < n91; i++) { r.prefixes(); r.preamble(); r.skip(8); }
    if (isPre(r.p)) r.preamble();
    const nc = isRec(r.p + 4, 0x42) && !isRec(r.p + 2, 0x42) ? r.u32() : r.u16();
    for (let i = 0; i < nc; i++) {
      const at = r.p;
      try { o.children.push(occ()); }
      catch (e) { notes.push(`hierarchy: ${(e as Error).message} (${name}: ${o.children.length} of ${nc} occurrences read)`); r.p = at; return o; }
    }
    return o;
  };
  const occ = (): OOcc => { const pf = r.prefixes(); r.preamble(); r.u32(); const dbId = r.u32(); const props: Record<string, string> = {}; for (const [a, b] of pf.props) props[s(a)] = s(b); return body(dbId, props); };
  return body(0, {});
}

// ---------------------------------------------------------------------------------------------------------------
// Conversion to the OpenSchematic model

const ORIENT = (d: Pt): Orient => (Math.abs(d.x) >= Math.abs(d.y) ? (d.x < 0 ? 'left' : 'right') : d.y < 0 ? 'up' : 'down');

function symPins(sym: OSymbol, numbers: string[] | undefined): SymPin[] {
  return sym.pins.map((p, i) => {
    const d = { x: p.hot.x - p.start.x, y: p.hot.y - p.start.y };
    const len = Math.round(Math.hypot(d.x, d.y)) * U;
    const shape: SymPin['shape'] = len === 0 ? 'zero' : p.shape & 2 && p.shape & 4 ? 'dot_clock' : p.shape & 2 ? 'clock' : p.shape & 4 ? 'dot' : 'line';
    // invisible power pins (shape bit 7; zero-length in old libraries) join the net of their name
    const hidden = p.type === 'power' && (!!(p.shape & 0x80) || len === 0);
    return { number: numbers?.[i] || String(i + 1), name: p.name, type: p.type, x: p.hot.x * U, y: p.hot.y * U, length: len, orient: len ? ORIENT(d) : 'right', shape, ...(hidden ? { hidden: true, net: p.name } : {}) };
  });
}

/** OrCAD symbol name "74LS08.Normal" -> part "74LS08", view Normal / Convert */
const splitView = (n: string) => { const m = /^(.*)\.(Normal|Convert)$/i.exec(n); return m ? { part: m[1], convert: /^convert$/i.test(m[2]) } : { part: n, convert: false }; };

function buildLibPart(name: string, cache: Cache): LibPart | undefined {
  const pk = cache.packages.get(name);
  // heterogeneous package: every unit is its own symbol cell ("MT47H64M8CBA", "MT47H64M8CBB")
  const hetero = !!pk && pk.devices.length > 1 && new Set(pk.devices.map((dv) => dv.cell)).size > 1;
  const symOfCell = (cell: string) => ({ normal: cache.parts.get(`${cell}.Normal`) ?? cache.parts.get(cell), convert: cache.parts.get(`${cell}.Convert`) });
  const normal0 = hetero ? symOfCell(pk!.devices[0].cell).normal : cache.parts.get(`${name}.Normal`) ?? cache.parts.get(name);
  if (!normal0) return undefined;
  const devices = pk?.devices.length ? pk.devices : [{ unit: 'A', cell: name, pins: [] as string[] }];
  const units: LibUnit[] = [];
  for (const dv of devices) {
    const { normal, convert } = hetero ? symOfCell(dv.cell) : { normal: normal0, convert: cache.parts.get(`${name}.Convert`) };
    if (!normal) { cache.notes.push(`${name}: unit ${dv.unit} symbol ${dv.cell} not in the cache`); continue; }
    units.push({ normal: { graphics: normal.graphics, pins: symPins(normal, dv.pins) }, ...(convert ? { convert: { graphics: convert.graphics, pins: symPins(convert, dv.pins) } } : {}) });
  }
  if (!units.length) return undefined;
  const ref = (pk?.refDes || normal0.refPrefix || 'U').replace(/\?$/, '');
  const props: Record<string, string> = { Value: normal0.value ?? name };
  if (pk?.footprint) props['PCB Footprint'] = pk.footprint;
  for (const [k, v] of Object.entries(normal0.props)) if (v) props[k] = v;
  return { name, refPrefix: ref || 'U', units, props, kind: 'part', description: normal0.source ? `from ${normal0.source}` : undefined, ...(normal0.pinNamesVisible === false ? { hidePinNames: true } : {}), ...(normal0.pinNumbersVisible === false ? { hidePinNumbers: true } : {}) };
}

/** symbol cell -> heterogeneous package and unit */
function cellIndex(cache: Cache): Map<string, { pkg: string; unit: number }> {
  const out = new Map<string, { pkg: string; unit: number }>();
  for (const pk of cache.packages.values()) if (pk.devices.length > 1 && new Set(pk.devices.map((dv) => dv.cell)).size > 1) pk.devices.forEach((dv, i) => { if (dv.cell) out.set(dv.cell, { pkg: pk.name, unit: i }); });
  return out;
}

/** dense pin index of a stored pin slot (1-based slot as stored with instance pins) */
const slotPin = (sym: OSymbol | undefined, slot1: number) => (sym?.slots ? sym.slots.indexOf(slot1 - 1) : slot1 - 1);

/** best rotation / mirror / offset placing the symbol's pins on the stored absolute pin positions */
function fitPlacement(sym: SymPin[], inst: OInst, os?: OSymbol): { x: number; y: number; rot: 0 | 90 | 180 | 270; mirror: boolean; ok: boolean } {
  const pairs = inst.pins.map((ip) => ({ ip, sp: sym[slotPin(os, ip.idx)] })).filter((q) => q.sp && !q.sp.hidden);
  const fallback = { x: inst.loc.x, y: inst.loc.y, rot: ((inst.rot * 90) % 360) as 0 | 90 | 180 | 270, mirror: inst.mirror, ok: false };
  if (!pairs.length) return fallback;
  let best = { ...fallback, score: -1 };
  for (const mirror of [false, true]) for (const rot of [0, 90, 180, 270] as const) {
    const o = toPage({ x: 0, y: 0, rot, mirror }, pairs[0].sp);
    const x = pairs[0].ip.at.x - o.x, y = pairs[0].ip.at.y - o.y;
    let score = 0; for (const q of pairs) { const p = toPage({ x, y, rot, mirror }, q.sp); if (Math.abs(p.x - q.ip.at.x) < 1 && Math.abs(p.y - q.ip.at.y) < 1) score++; }
    // prefer the stored origin and rotation on ties
    const bonus = (x === inst.loc.x && y === inst.loc.y ? 0.5 : 0) + (rot === inst.rot * 90 && mirror === inst.mirror ? 0.25 : 0);
    if (score + bonus > best.score) best = { x, y, rot, mirror, ok: score === pairs.length, score: score + bonus };
  }
  return best;
}

const pageSizeName = (size: string, w: number, h: number): Page['size'] => {
  const s = size.trim().toUpperCase();
  if (s in PAGE_SIZES) return s as Page['size'];
  let best: Page['size'] = 'A', d = Infinity;
  for (const [k, v] of Object.entries(PAGE_SIZES)) { const e = Math.abs(v.w - w) + Math.abs(v.h - h); if (e < d) { d = e; best = k as Page['size']; } }
  return best;
};

const TITLE_KEYS: Record<string, string> = { Title: 'Title', Doc: 'Document Number', RevCode: 'Revision', OrgName: 'Company', OrgAddr1: 'Address 1', OrgAddr2: 'Address 2', OrgAddr3: 'Address 3', OrgAddr4: 'Address 4', 'Page Number': 'Sheet', 'Page Count': 'Sheets', 'Page Create Date': 'Date', 'Page Modify Date': 'Modified', 'Cage Code': 'Cage Code' };

const segCross = (a: Pt, b: Pt, c: Pt, d: Pt): Pt | null => {
  // axis-aligned and general segments: proper intersection point interior to both
  const den = (b.x - a.x) * (d.y - c.y) - (b.y - a.y) * (d.x - c.x);
  if (Math.abs(den) < 1e-9) return null;
  const t = ((c.x - a.x) * (d.y - c.y) - (c.y - a.y) * (d.x - c.x)) / den, u = ((c.x - a.x) * (b.y - a.y) - (c.y - a.y) * (b.x - a.x)) / den;
  if (t <= 1e-6 || t >= 1 - 1e-6 || u <= 1e-6 || u >= 1 - 1e-6) return null;
  return { x: a.x + t * (b.x - a.x), y: a.y + t * (b.y - a.y) };
};

const nearestOnSeg = (p: Pt, a: Pt, b: Pt): Pt => {
  const dx = b.x - a.x, dy = b.y - a.y, L = dx * dx + dy * dy;
  const t = L ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / L)) : 0;
  // stay on the grid of the wire (orthogonal wires)
  return { x: Math.round(a.x + t * dx), y: Math.round(a.y + t * dy) };
};

const GLOBAL_STYLE = (sym: string): 'power_bar' | 'power_arrow' | 'power_circle' | 'ground' | 'ground_signal' | 'ground_earth' => {
  const n = sym.toUpperCase();
  if (/GND|GROUND|VSS/.test(n)) return /EARTH/.test(n) ? 'ground_earth' : /SIGNAL/.test(n) ? 'ground_signal' : 'ground';
  return /ARROW/.test(n) ? 'power_arrow' : /CIRCLE/.test(n) ? 'power_circle' : 'power_bar';
};

/**
 * Cross-check: wires our geometry joins (shared end point, end point on another wire) must carry the same stored net.
 * Disagreements are reported in the notes (with the place), they point at drawing details the import misreads.
 */
function checkStoredNets(op: OPage, segs: { a: Pt; b: Pt; net: number; id: number }[], page: Page, notes: string[]) {
  const on = (p: Pt, a: Pt, b: Pt) => Math.abs((b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x)) < 1e-6 && p.x >= Math.min(a.x, b.x) - 0.5 && p.x <= Math.max(a.x, b.x) + 0.5 && p.y >= Math.min(a.y, b.y) - 0.5 && p.y <= Math.max(a.y, b.y) + 0.5;
  let n = 0;
  for (const w of segs) for (const e of [w.a, w.b]) for (const v of segs) {
    if (v === w || !w.net || !v.net || w.net === v.net) continue;
    if (on(e, v.a, v.b)) { if (n++ < 5) notes.push(`${page.name}: wires of nets ${op.nets.get(w.net) ?? w.net} and ${op.nets.get(v.net) ?? v.net} touch at ${e.x},${e.y}`); }
  }
  if (n > 5) notes.push(`${page.name}: ${n} wire contacts between different stored nets`);
}

export interface OrcadImport { design: Design; notes: string[] }

export interface OrcadOptions {
  /** another design a block refers to (OrCAD "Project" implementation): its file contents, or null */
  resolve?: (implementation: string) => Uint8Array | null;
}

type InstMap = Map<number, { pi: PartInst; lp: LibPart; inst: OInst; sch: string }>;

export function importOrcadDesign(data: Uint8Array, name = 'design', opts: OrcadOptions = {}): OrcadImport {
  const r = importDesign(data, name, opts, 0);
  return { design: r.design, notes: r.notes };
}

function importDesign(data: Uint8Array, name: string, opts: OrcadOptions, depth: number): OrcadImport & { insts: InstMap } {
  const streams = readCfb(data);
  const libBuf = streams.get('Library'); if (!libBuf) throw new Error('not an OrCAD design: no Library stream');
  const lib = readLibraryStream(libBuf);
  const s: S = (i) => lib.strings[i] ?? '';
  const notes: string[] = [];
  const cache: Cache = { parts: new Map(), packages: new Map(), specials: new Map(), variants: new Map(), notes };
  const cacheBuf = streams.get('Cache'); if (cacheBuf) scanSymbols(cacheBuf, s, cache);
  if (lib.kind === 'library') for (const [k, v] of streams) if (/^(Cells|Packages|Symbols|Parts)\//.test(k)) scanSymbols(v, s, cache);

  const d = newDesign(name); d.schematics = [];
  // OrCAD semantics: same-named aliases, ports and off-page connectors of a folder are one net
  d.settings.orcadNames = true;
  const libName = `${name}_lib`;
  const olib: Library = { name: libName, parts: {} };
  d.libraries.push(olib);
  const cells = cellIndex(cache);
  const partFor = (pkg: string): LibPart | undefined => {
    const { part: cell } = splitView(pkg);
    const part = cells.get(cell)?.pkg ?? cell;
    if (olib.parts[part]) return olib.parts[part];
    const lp = buildLibPart(part, cache); if (lp) olib.parts[part] = lp; return lp;
  };

  // schematic folders and their pages
  const folders = new Map<string, string[]>();
  for (const k of streams.keys()) { const m = /^Views\/([^/]+)\/Pages\/(.+)$/.exec(k); if (m) { const a = folders.get(m[1]) ?? []; a.push(m[2]); folders.set(m[1], a); } }
  // page order from the Schematic stream
  for (const [sch, pages] of folders) {
    const sb = streams.get(`Views/${sch}/Schematic`);
    if (sb) { try { const r = new Rd(sb); r.prefixes(); r.preamble(); r.str(); r.skip(4); const n = r.u16(); const order: string[] = []; for (let i = 0; i < n; i++) order.push(r.str()); pages.sort((a, b) => (order.indexOf(a) + 1 || 1e9) - (order.indexOf(b) + 1 || 1e9)); } catch { /* keep stream order */ } }
  }
  // the root schematic's hierarchy stream (a design may keep others, e.g. for test benches): the named root, else the largest
  const hierStreams = [...streams.keys()].filter((k) => k.endsWith('/Hierarchy/Hierarchy'));
  const hierStream = hierStreams.find((k) => k === `Views/${lib.root}/Hierarchy/Hierarchy`) ?? hierStreams.sort((a, b) => streams.get(b)!.length - streams.get(a)!.length)[0];
  const rootName = lib.root && folders.has(lib.root) ? lib.root : hierStream ? hierStream.split('/')[1] : [...folders.keys()][0];
  d.root = rootName ?? 'SCHEMATIC1';

  // occurrences: per instance dbId the list of (path, ref, unit, pin numbers, props) in hierarchy order
  let occRoot: OOcc | undefined;
  if (hierStream) { try { occRoot = readHierarchy(streams.get(hierStream)!, s, notes); } catch (e) { notes.push(`hierarchy: ${(e as Error).message}`); } }

  // read pages
  const instByDb: InstMap = new Map();
  const external = new Map<string, InstMap>();   // schematic name of an imported sub-design -> its instances
  const subOccurrences = new Map<string, Design['occurrences']>();
  const blockByDb = new Map<number, { b: Block; sch: string }>();
  const symOf = (inst: OInst) => cache.parts.get(inst.pkg) ?? cache.parts.get(`${splitView(inst.pkg).part}.Normal`);
  for (const [schName, pageNames] of folders) {
    const sch = { name: schName, pages: [] as Page[] };
    d.schematics.push(sch);
    for (const pn of pageNames) {
      let op: OPage;
      try { op = readPage(streams.get(`Views/${schName}/Pages/${pn}`)!, s, notes); } catch (e) { notes.push(`page ${schName}/${pn}: ${(e as Error).message}`); continue; }
      const page = newPage(op.name || pn, pageSizeName(op.size, op.width, op.height));
      page.title = {};
      for (const t of op.titles) for (const [k, v] of Object.entries(t.props)) if (v) page.title[TITLE_KEYS[k] ?? k] = v;
      if (!page.title.Title) page.title.Title = page.name;
      // wires (each stores its own id and the id of its net in the page's net table)
      const segs: { a: Pt; b: Pt; net: number; id: number }[] = [];
      for (const w of op.wires) {
        let wid: number | undefined;
        if (w.bus) page.buses.push({ id: nid(d), pts: [w.a, w.b] });
        else { wid = nid(d); page.wires.push({ id: wid, pts: [w.a, w.b] }); segs.push({ a: w.a, b: w.b, net: w.net, id: wid }); }
        // an alias belongs to the wire it is stored with: put it on the wire (OrCAD keeps the label's text position)
        for (const a of w.aliases) page.aliases.push({ id: nid(d), at: nearestOnSeg(a.at, w.a, w.b), name: a.name, ...(a.rot & 1 ? { rot: 90 as const } : {}), ...(wid !== undefined ? { wire: wid } : {}) });
      }
      // parts and blocks
      for (const inst of op.insts) {
        // a hierarchical block (drawn instance), or a hierarchical part: a part whose implementation is a schematic folder
        const libSym = symOf(inst);
        const hierPart = !inst.drawn && !!inst.impl && [...folders.keys()].some((f) => f.toLowerCase() === inst.impl.toLowerCase()) && (libSym?.implementationType === 1 || libSym?.implementationType === undefined);
        if (inst.drawn || hierPart) {
          const sy = inst.symbol ?? libSym;
          const want = inst.impl || sy?.implementation || inst.pkg || inst.ref;
          const schOf = folders.has(want) ? want : ([...folders.keys()].find((f) => f.toLowerCase() === want.toLowerCase()) ?? want);
          if (!folders.has(schOf) && !external.has(schOf)) {
            // another design: read it (when the caller can find it) and add its schematics
            const sub = depth < 8 ? opts.resolve?.(want) : null;
            if (sub) {
              try {
                const si = importDesign(sub, want, opts, depth + 1);
                mergeSubDesign(d, si.design, want);
                external.set(want, si.insts); subOccurrences.set(want, si.design.occurrences);
                notes.push(`${inst.ref}: block ${want} read from its own design (${si.design.schematics.length} schematics)`);
              } catch (e) { notes.push(`${inst.ref}: block design ${want}: ${(e as Error).message}`); }
            } else notes.push(`${inst.ref}: block implementation ${want} is not a schematic of this design (another design or library)`);
          }
          // body: the symbol's rectangle (else the stored bounding box)
          const rect = sy?.graphics.find((g) => g.kind === 'rect') as Extract<Graphic, { kind: 'rect' }> | undefined;
          const body = sy?.bbox ? { x1: inst.loc.x + sy.bbox.x1 * U, y1: inst.loc.y + sy.bbox.y1 * U, x2: inst.loc.x + sy.bbox.x2 * U, y2: inst.loc.y + sy.bbox.y2 * U } : rect ? { x1: inst.loc.x + rect.x1, y1: inst.loc.y + rect.y1, x2: inst.loc.x + rect.x2, y2: inst.loc.y + rect.y2 } : inst.bbox;
          const bx = body.x1, by = body.y1, bw = body.x2 - body.x1, bh = body.y2 - body.y1;
          const pins: BlockPin[] = [];
          for (const ip of inst.pins) {
            const sp = sy?.pins[slotPin(sy, ip.idx)]; if (!sp) continue;
            const at = ip.at;
            const dl = Math.abs(at.x - bx), dr = Math.abs(at.x - (bx + bw)), dt = Math.abs(at.y - by), db = Math.abs(at.y - (by + bh));
            const m = Math.min(dl, dr, dt, db);
            const side: BlockPin['side'] = m === dl ? 'left' : m === dr ? 'right' : m === dt ? 'top' : 'bottom';
            const dir: Port['dir'] = sp.type === 'input' ? 'input' : sp.type === 'output' ? 'output' : sp.type === 'passive' ? 'passive' : 'bidirectional';
            // block pins sit on the body edge: put the connection there and draw a stub wire to the stored pin point
            const offset = side === 'left' || side === 'right' ? at.y - by : at.x - bx;
            const edge = side === 'left' ? { x: bx, y: at.y } : side === 'right' ? { x: bx + bw, y: at.y } : side === 'top' ? { x: at.x, y: by } : { x: at.x, y: by + bh };
            if (Math.abs(edge.x - at.x) > 0.5 || Math.abs(edge.y - at.y) > 0.5) page.wires.push({ id: nid(d), pts: [edge, at] });
            pins.push({ name: sp.name, dir, side, offset });
          }
          const b: Block = { id: nid(d), ref: inst.ref || `BLOCK${inst.dbId}`, schematic: schOf, x: bx, y: by, w: bw, h: bh, pins };
          page.blocks.push(b); blockByDb.set(inst.dbId, { b, sch: schName });
          continue;
        }
        const lp = partFor(inst.pkg);
        if (!lp) { notes.push(`${inst.ref}: symbol ${inst.pkg} not in the cache`); continue; }
        const { convert } = splitView(inst.pkg);
        const sym = symOf(inst);
        const sp = sym ? symPins(sym, undefined) : lp.units[0].normal.pins;
        const fit = fitPlacement(sp, inst, sym);
        if (!fit.ok && inst.pins.length) {
          notes.push(`${inst.ref} (${inst.pkg}): placement fitted to ${inst.pins.length} stored pin positions only partly`);
          if (DEBUG()) notes.push(`debug fit ${inst.ref}: sym pins ${sym?.pins.length} slots ${JSON.stringify(sym?.slots?.slice(0, 12))} stored ${JSON.stringify(inst.pins.slice(0, 8).map((p) => [p.idx, p.at.x, p.at.y]))} symbol ${JSON.stringify(sp.slice(0, 8).map((q) => [q.name, q.x, q.y, q.hidden ? 'h' : '']))} loc ${inst.loc.x},${inst.loc.y} rot ${inst.rot} mirror ${inst.mirror} fit ${JSON.stringify(fit)}`);
        }
        const props: Record<string, string> = {};
        for (const [k, v] of Object.entries(inst.props)) if (v) props[k] = v;
        if (inst.value && inst.value !== lp.props.Value) props.Value = inst.value;
        const hetUnit = cells.get(splitView(inst.pkg).part)?.unit;
        const pi: PartInst = { id: nid(d), lib: libName, part: lp.name, unit: Math.min(hetUnit ?? inst.unit, lp.units.length - 1), ...(convert ? { convert: true } : {}), ref: inst.ref || `${lp.refPrefix}?`, x: fit.x, y: fit.y, rot: fit.rot, ...(fit.mirror ? { mirror: true } : {}), props, occKey: `I${inst.dbId}` };
        page.parts.push(pi);
        // validation aid: OrCAD's own stored net of every pin (symbol pin index -> net name), only on request
        if (DEBUG()) Object.defineProperty(pi, 'storedNets', { value: Object.fromEntries(inst.pins.map((p) => { const di = slotPin(sym, p.idx); const w = p.wire && p.wire !== 0xffffffff ? op.wires.find((x) => x.ref === p.wire) : undefined; const net = w ? w.net : p.net; return [di, op.nets.get(net) ?? (net ? `#${net}` : '')]; })), enumerable: false });
        instByDb.set(inst.dbId, { pi, lp, inst, sch: schName });
      }
      // ports, globals, off-page connectors: named by the net of the wire they touch
      const wireNetName = (wref: number | undefined): string => { if (!wref) return ''; const w = op.wires.find((x) => x.ref === wref); return w ? (op.nets.get(w.net) ?? '') : ''; };
      // stored nets at points: wire segments, and part pins (each stored with its net id)
      const pinNets: { at: Pt; net: number }[] = op.insts.flatMap((i) => i.pins.map((p) => ({ at: p.at, net: p.net })));
      const onW = (at: Pt, w: OWire) => Math.abs((w.b.x - w.a.x) * (at.y - w.a.y) - (w.b.y - w.a.y) * (at.x - w.a.x)) < 1e-6 && at.x >= Math.min(w.a.x, w.b.x) - 0.5 && at.x <= Math.max(w.a.x, w.b.x) + 0.5 && at.y >= Math.min(w.a.y, w.b.y) - 0.5 && at.y <= Math.max(w.a.y, w.b.y) + 0.5;
      const touching = (at: Pt): string => {
        for (const w of op.wires) if (!w.bus && onW(at, w)) { const n = op.nets.get(w.net); if (n) return n; }
        for (const p of pinNets) if (Math.abs(p.at.x - at.x) < 0.5 && Math.abs(p.at.y - at.y) < 0.5) { const n = op.nets.get(p.net); if (n) return n; }
        return '';
      };
      const connected = (at: Pt) => op.wires.some((w) => onW(at, w)) || pinNets.some((p) => Math.abs(p.at.x - at.x) < 0.5 && Math.abs(p.at.y - at.y) < 0.5);
      /**
       * connection point of a port / global / off-page symbol: its pin, with the symbol placed so its (rotated)
       * outline sits in the stored bounding box (the stored "location" is the label's). Same-named symbols from
       * different libraries and the four orientations give candidates; the one on a wire or pin wins.
       */
      const symPinOff = (name: string, g: OGraphicInst): Pt => {
        const vs = (cache.variants.get(name) ?? (cache.parts.get(name) ? [cache.parts.get(name)!] : [])).filter((v) => v.pins[0]);
        const box = { x1: Math.min(g.bbox.x1, g.bbox.x2) * U, y1: Math.min(g.bbox.y1, g.bbox.y2) * U, x2: Math.max(g.bbox.x1, g.bbox.x2) * U, y2: Math.max(g.bbox.y1, g.bbox.y2) * U };
        const cands: { at: Pt; pri: number }[] = [];
        const pri0 = (c: { pri: number }) => c.pri === 0;
        for (const v of vs) {
          const bb = v.bbox ?? { x1: 0, y1: 0, x2: 0, y2: 0 };
          const pin = { x: v.pins[0].hot.x * U, y: v.pins[0].hot.y * U };
          for (const mirror of [false, true]) for (const rot of [0, 90, 180, 270] as const) {
            const cs = [{ x: bb.x1 * U, y: bb.y1 * U }, { x: bb.x2 * U, y: bb.y1 * U }, { x: bb.x1 * U, y: bb.y2 * U }, { x: bb.x2 * U, y: bb.y2 * U }].map((q) => toPage({ x: 0, y: 0, rot, mirror }, q));
            const mnx = Math.min(...cs.map((q) => q.x)), mny = Math.min(...cs.map((q) => q.y)), mxx = Math.max(...cs.map((q) => q.x)), mxy = Math.max(...cs.map((q) => q.y));
            const pp = toPage({ x: 0, y: 0, rot, mirror }, pin);
            const stored = rot === g.rot * 90 && mirror === g.mirror ? 0 : 1;
            // align the outline with each corner of the box (labels widen the box on one side)
            cands.push({ at: { x: box.x1 - mnx + pp.x, y: box.y1 - mny + pp.y }, pri: stored * 4 });
            cands.push({ at: { x: box.x2 - mxx + pp.x, y: box.y1 - mny + pp.y }, pri: stored * 4 + 1 });
            cands.push({ at: { x: box.x1 - mnx + pp.x, y: box.y2 - mxy + pp.y }, pri: stored * 4 + 2 });
            cands.push({ at: { x: box.x2 - mxx + pp.x, y: box.y2 - mxy + pp.y }, pri: stored * 4 + 3 });
          }
        }
        cands.sort((p, q) => p.pri - q.pri);
        // best evidence: the stored net at the point carries the symbol's name; then any connection
        const hit = (g.label ? cands.find((c) => touching(c.at) === g.label) : undefined) ?? cands.find((c) => connected(c.at) && (!g.label || !touching(c.at) || !op.nets.size || pri0(c))) ?? cands.find((c) => connected(c.at));
        if (DEBUG() && !hit) notes.push(`debug unconnected ${name} bbox ${JSON.stringify(g.bbox)} rot ${g.rot}`);
        return hit?.at ?? cands[0]?.at ?? { x: g.loc.x * U, y: g.loc.y * U };
      };
      for (const g of op.ports) {
        const at = symPinOff(g.name, g);
        const nm = g.label || g.props.Name || wireNetName(g.wire) || touching(at) || g.name;
        page.ports.push({ id: nid(d), at, name: nm, dir: 'bidirectional', ...(g.rot === 2 || /RIGHT/i.test(g.name) ? { rot: 180 as const } : {}) });
      }
      for (const g of op.globals) {
        const at = symPinOff(g.name, g);
        const nm = g.label || g.props.Name || g.props.Value || wireNetName(g.wire) || touching(at) || g.name;
        { const t = touching(at); if (t && t !== nm && DEBUG()) notes.push(`debug ${page.name}: power ${nm} (${g.name}) at ${at.x},${at.y} touches stored net ${t}; bbox ${JSON.stringify(g.bbox)} rot ${g.rot} mirror ${g.mirror} variants ${JSON.stringify((cache.variants.get(g.name) ?? []).map((v) => [v.bbox, v.pins.map((p) => p.hot)]))}`); }
        page.globals.push({ id: nid(d), at, net: nm, style: GLOBAL_STYLE(g.name), ...(g.rot ? { rot: ((g.rot * 90) % 360) as 0 | 90 | 180 | 270 } : {}) });
      }
      for (const g of op.offPages) {
        const at = symPinOff(g.name, g);
        const nm = g.label || g.props.Name || wireNetName(g.wire) || touching(at) || g.name;
        page.offPages.push({ id: nid(d), at, name: nm, ...(g.rot === 2 ? { rot: 180 as const } : {}) });
      }
      for (const be of op.busEntries) {
        const dx = be.b.x - be.a.x, dy = be.b.y - be.a.y;
        page.busEntries.push({ id: nid(d), at: be.a, dir: `${dy < 0 ? 'n' : 's'}${dx < 0 ? 'w' : 'e'}` as 'ne' | 'nw' | 'se' | 'sw' });
      }
      for (const g of op.graphics) for (const gr of g.graphics) {
        if (gr.kind === 'text') page.texts.push({ id: nid(d), at: gr.at, text: gr.text, size: gr.size });
        else page.graphics.push({ id: nid(d), g: gr });
      }
      // junctions where wires of the same stored net cross
      for (let i = 0; i < segs.length; i++) for (let j = i + 1; j < segs.length; j++) {
        const a = segs[i], b = segs[j]; if (!a.net || a.net !== b.net) continue;
        const x = segCross(a.a, a.b, b.a, b.b); if (x) page.junctions.push({ id: nid(d), at: x });
      }
      checkStoredNets(op, segs, page, notes);
      sch.pages.push(page);
    }
  }
  // occurrences from the hierarchy tree
  if (occRoot && DEBUG()) { const show = (o: OOcc, ind: string, out: string[]) => { out.push(`${ind}${o.name || '.'} db${o.dbId} ${o.ref}${o.unit} kids ${o.children.length}`); if (ind.length < 6) for (const c of o.children.slice(0, 6)) show(c, ind + '  ', out); return out; }; notes.push('debug occ ' + show(occRoot, '', []).join(' / ')); }
  if (occRoot) {
    let applied = 0;
    const seenFirst = new Set<number>();
    const walk = (o: OOcc, path: string, depth: number, insts: InstMap) => {
      if (depth > 32) return;
      for (const c of o.children) {
        if (c.name) {          // a block occurrence
          const bl = blockByDb.get(c.dbId);
          const seg = bl?.b.ref ?? `B${c.dbId}`;
          walk(c, path ? `${path}/${seg}` : seg, depth + 1, (bl && external.get(bl.b.schematic)) ?? insts);
          continue;
        }
        const hit = insts.get(c.dbId); if (!hit) continue;
        // occurrence data (designator, unit) when stored for this path; flat designs leave it empty: the page's values
        const has = !!(c.ref || c.unit);
        const hetUnit = cells.get(splitView(hit.inst.pkg).part)?.unit;
        const unitIdx = hetUnit ?? (!has ? hit.pi.unit : Math.max(0, hit.lp.units.length > 1 ? (cache.packages.get(hit.lp.name)?.devices.findIndex((dv) => dv.unit === c.unit) ?? 0) : 0));
        const key = path ? `${path}/I${c.dbId}` : `I${c.dbId}`;
        const props: Record<string, string> = {};
        for (const [k, v] of Object.entries(c.props)) if (v) props[k] = v;
        if (!seenFirst.has(c.dbId)) {
          // the first occurrence also becomes the instance's own designator, unit and properties
          seenFirst.add(c.dbId);
          if (c.ref) hit.pi.ref = c.ref;
          if (has) hit.pi.unit = unitIdx;
          Object.assign(hit.pi.props, props);
        }
        d.occurrences[key] = { path: key, ref: c.ref || hit.pi.ref, unit: unitIdx, ...(Object.keys(props).length ? { props } : {}) };
        applied++;
      }
    };
    // occurrences of imported sub-designs, under every path that uses them (the walk below may refine them)
    if (external.size) {
      const visit = (sch: string, path: string, k: number) => { if (k > 32) return; for (const pg of d.schematics.find((x) => x.name === sch)?.pages ?? []) for (const b of pg.blocks) { const bp = path ? `${path}/${b.ref}` : b.ref; const subOcc = subOccurrences.get(b.schematic); if (subOcc) for (const [key, o] of Object.entries(subOcc)) d.occurrences[`${bp}/${key}`] = { ...o, path: `${bp}/${key}` }; visit(b.schematic, bp, k + 1); } };
      visit(d.root, '', 0);
    }
    walk(occRoot, '', 0, instByDb);
    notes.push(`${applied} part occurrences`);
  }
  // pin number overrides per occurrence are already the package pin numbers of the unit (Number properties only
  // repeat them); parts whose package is missing keep 1..n
  for (const [part, lp] of Object.entries(olib.parts)) if (!cache.packages.get(part)) notes.push(`${part}: no package in the cache, pins numbered 1..n`);
  notes.push(`${d.schematics.length} schematics, ${d.schematics.reduce((n, x) => n + x.pages.length, 0)} pages, ${Object.keys(olib.parts).length} library parts`);
  return { design: d, notes, insts: instByDb };
}

/** Add another design's schematics (its root renamed to `as`, the others prefixed) and libraries to d. */
function mergeSubDesign(d: Design, sub: Design, as: string) {
  const rename = new Map<string, string>();
  const taken = new Set(d.schematics.map((x) => x.name));
  for (const sc of sub.schematics) { let n = sc.name === sub.root ? as : `${as}:${sc.name}`; while (taken.has(n)) n += '_'; rename.set(sc.name, n); taken.add(n); }
  for (const sc of sub.schematics) {
    for (const pg of sc.pages) {
      for (const b of pg.blocks) b.schematic = rename.get(b.schematic) ?? b.schematic;
      // fresh object ids in the merged design
      for (const k of ['parts', 'wires', 'buses', 'busEntries', 'junctions', 'aliases', 'globals', 'ports', 'offPages', 'noConnects', 'blocks', 'texts', 'graphics', 'bookmarks'] as const) {
        const map = new Map<number, number>();
        for (const o of pg[k] as { id: number }[]) { const nidv = nid(d); map.set(o.id, nidv); o.id = nidv; }
        if (k === 'wires') for (const a of pg.aliases) if (a.wire !== undefined && map.has(a.wire)) a.wire = map.get(a.wire);
      }
    }
    d.schematics.push({ name: rename.get(sc.name)!, pages: sc.pages });
  }
  for (const l of sub.libraries) if (!d.libraries.some((x) => x.name === l.name)) d.libraries.push(l);
}

/** OrCAD library (.OLB): every part of it as an OpenSchematic library. */
export function importOrcadLibrary(data: Uint8Array, name = 'library'): { library: Library; notes: string[] } {
  const streams = readCfb(data);
  const libBuf = streams.get('Library'); if (!libBuf) throw new Error('not an OrCAD library: no Library stream');
  const lib = readLibraryStream(libBuf);
  const s: S = (i) => lib.strings[i] ?? '';
  const notes: string[] = [];
  const cache: Cache = { parts: new Map(), packages: new Map(), specials: new Map(), variants: new Map(), notes };
  for (const [k, v] of streams) if (k !== 'Library') scanSymbols(v, s, cache);
  const out: Library = { name, parts: {} };
  const names = new Set<string>();
  const cells = cellIndex(cache);
  for (const k of cache.parts.keys()) { const c = splitView(k).part; names.add(cells.get(c)?.pkg ?? c); }
  for (const k of cache.packages.keys()) names.add(k);
  for (const n of names) { const lp = buildLibPart(n, cache); if (lp) out.parts[n] = lp; }
  notes.push(`${Object.keys(out.parts).length} parts, ${cache.packages.size} packages, ${cache.specials.size} special symbols`);
  return { library: out, notes };
}
