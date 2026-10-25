/**
 * Altium Designer board import (.PcbDoc), both storage formats:
 *
 *   ASCII     one record per line, "|RECORD=Track|LAYER=TOP|X1=...mil|..." (File > Save As > PCB ASCII)
 *   binary    an OLE compound file (CFB) with one storage per object kind ("Board6/Data", "Components6/Data",
 *             "Nets6/Data", "Pads6/Data", "Tracks6/Data", "Vias6/Data", "Arcs6/Data", "Fills6/Data", "Regions6/Data",
 *             "Polygons6/Data", "Classes6/Data", "Rules6/Data"): property streams are length-prefixed "|KEY=VALUE|"
 *             strings, primitive streams are little-endian binary records (coordinates in 1/10000 mil) that are
 *             decoded here into the same property records as the ASCII format.
 *
 * Both feed one converter: copper layer stack (V9 stack or the old LAYERn chain, copper/dielectric thickness and
 * permittivity), board outline (lines and arcs), components with their pads turned into footprint-local pads
 * (bottom parts un-mirrored), nets, tracks/arcs as traces, vias (with spans), polygon pours and copper regions/fills
 * as zones, keepouts, net classes and the board-wide clearance / width / via rules.
 */
import { type Project, type Pt, type Pad, newProject, nextId, LAYER_COLORS } from './model.js';

export type Rec = Record<string, string>;

/* ================================ compound file ================================ */

/** Streams of an OLE compound file by path ("Storage/Stream"). */
export function readCfb(buf: Uint8Array): Map<string, Uint8Array> {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  if (dv.getUint32(0, true) !== 0xe011cfd0) throw new Error('not a compound file');
  const secSize = 1 << dv.getUint16(30, true), miniSize = 1 << dv.getUint16(32, true);
  const firstDir = dv.getInt32(48, true), cutoff = dv.getUint32(56, true);
  const firstMiniFat = dv.getInt32(60, true), nMiniFat = dv.getUint32(64, true);
  let difatSec = dv.getInt32(68, true);
  const fatSecs: number[] = [];
  for (let i = 0; i < 109; i++) { const s = dv.getInt32(76 + i * 4, true); if (s >= 0) fatSecs.push(s); }
  while (difatSec >= 0) { const off = 512 + difatSec * secSize; for (let i = 0; i < secSize / 4 - 1; i++) { const s = dv.getInt32(off + i * 4, true); if (s >= 0) fatSecs.push(s); } difatSec = dv.getInt32(off + secSize - 4, true); }
  const fat: number[] = [];
  for (const s of fatSecs) { const off = 512 + s * secSize; for (let i = 0; i < secSize / 4; i++) fat.push(dv.getInt32(off + i * 4, true)); }
  const chain = (start: number, table: number[]) => { const out: number[] = []; for (let s = start, g = 0; s >= 0 && g < 1e7; s = table[s], g++) out.push(s); return out; };
  const readChain = (start: number) => { const secs = chain(start, fat); const out = new Uint8Array(secs.length * secSize); secs.forEach((s, i) => out.set(buf.subarray(512 + s * secSize, 512 + (s + 1) * secSize), i * secSize)); return out; };
  const dir = readChain(firstDir);
  const ddv = new DataView(dir.buffer);
  interface Ent { name: string; type: number; left: number; right: number; child: number; start: number; size: number }
  const ents: Ent[] = [];
  for (let o = 0; o + 128 <= dir.length; o += 128) {
    const nl = ddv.getUint16(o + 64, true);
    let name = ''; for (let i = 0; i < Math.max(0, nl / 2 - 1); i++) name += String.fromCharCode(ddv.getUint16(o + i * 2, true));
    ents.push({ name, type: ddv.getUint8(o + 66), left: ddv.getInt32(o + 68, true), right: ddv.getInt32(o + 72, true), child: ddv.getInt32(o + 76, true), start: ddv.getInt32(o + 116, true), size: ddv.getUint32(o + 120, true) });
  }
  const root = ents[0];
  const miniStream = root && root.start >= 0 ? readChain(root.start) : new Uint8Array(0);
  const miniFat: number[] = [];
  if (firstMiniFat >= 0 && nMiniFat) { const mf = readChain(firstMiniFat); const mdv = new DataView(mf.buffer); for (let i = 0; i < mf.length / 4; i++) miniFat.push(mdv.getInt32(i * 4, true)); }
  const streamOf = (e: Ent): Uint8Array => {
    if (e.size < cutoff) { const secs = chain(e.start, miniFat); const out = new Uint8Array(secs.length * miniSize); secs.forEach((s, i) => out.set(miniStream.subarray(s * miniSize, (s + 1) * miniSize), i * miniSize)); return out.subarray(0, e.size); }
    return readChain(e.start).subarray(0, e.size);
  };
  const out = new Map<string, Uint8Array>();
  const walk = (id: number, prefix: string) => {
    if (id < 0 || id >= ents.length) return;
    const e = ents[id];
    walk(e.left, prefix); walk(e.right, prefix);
    const path = prefix ? `${prefix}/${e.name}` : e.name;
    if (e.type === 2) out.set(path, streamOf(e));
    else if (e.type === 1) walk(e.child, path);
  };
  if (root) walk(root.child, '');
  return out;
}

/* ================================ records ================================ */

export function parseProps(s: string): Rec {
  const r: Rec = {};
  for (const part of s.split('|')) { const i = part.indexOf('='); if (i > 0) { const k = part.slice(0, i).trim().toUpperCase(); if (!(k in r)) r[k] = part.slice(i + 1); } }
  return r;
}

/** Length-prefixed property records of a binary stream. */
function propStream(b: Uint8Array | undefined, skip = 0): Rec[] {
  const out: Rec[] = []; if (!b) return out;
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let o = 0;
  while (o + skip + 4 <= b.length) {
    o += skip;
    const len = dv.getUint32(o, true); o += 4;
    if (len > b.length - o) break;
    let s = ''; for (let i = 0; i < len; i++) { const c = b[o + i]; if (c === 0) break; s += String.fromCharCode(c); }
    out.push(parseProps(s)); o += len;
  }
  return out;
}

const LAYER_NAMES: Record<number, string> = { 1: 'TOP', 32: 'BOTTOM', 33: 'TOPOVERLAY', 34: 'BOTTOMOVERLAY', 35: 'TOPPASTE', 36: 'BOTTOMPASTE', 37: 'TOPSOLDER', 38: 'BOTTOMSOLDER', 55: 'DRILLGUIDE', 56: 'KEEPOUT', 73: 'DRILLDRAWING', 74: 'MULTILAYER' };
for (let i = 2; i <= 31; i++) LAYER_NAMES[i] = `MID${i - 1}`;
for (let i = 39; i <= 54; i++) LAYER_NAMES[i] = `PLANE${i - 38}`;
for (let i = 57; i <= 72; i++) LAYER_NAMES[i] = `MECHANICAL${i - 56}`;

/** Binary primitive records (Pads6/Tracks6/Vias6/Arcs6/Fills6) decoded into ASCII-style property records. */
function binaryPrims(b: Uint8Array | undefined, kind: 'Pad' | 'Track' | 'Via' | 'Arc' | 'Fill'): Rec[] {
  const out: Rec[] = []; if (!b) return out;
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let o = 0;
  const u8 = () => dv.getUint8(o++), u16 = () => { const v = dv.getUint16(o, true); o += 2; return v; }, i32 = () => { const v = dv.getInt32(o, true); o += 4; return v; }, f64 = () => { const v = dv.getFloat64(o, true); o += 8; return v; };
  const mil = (v: number) => `${v / 10000}mil`;
  const ln = (v: number) => LAYER_NAMES[v] ?? `L${v}`;
  const sub = () => { const len = dv.getUint32(o, true); o += 4; return o + len; };
  const idx = (v: number) => (v === 0xffff ? undefined : String(v));
  while (o < b.length) {
    const type = u8();
    try {
      if (kind === 'Pad' && type === 2) {
        let end = sub(); const nl = u8(); let name = ''; for (let i = 0; i < nl; i++) name += String.fromCharCode(u8()); o = end;
        for (let k = 0; k < 3; k++) { end = sub(); o = end; }
        end = sub(); const s5len = end - o;
        const layer = u8(); const flags1 = u8(); u8(); const net = u16(); o += 2; const comp = u16(); o += 4;
        const x = i32(), y = i32(), tx = i32(), ty = i32(); i32(); i32(); i32(); i32();
        const hole = i32(); const ts = u8(); u8(); u8(); const rot = f64(); const plated = u8() !== 0;
        void s5len; void flags1;
        o = end;
        end = sub(); o = end;   // per-layer sizes and shapes (not used: top size governs)
        const shape = ts === 1 ? 'ROUND' : ts === 3 ? 'OCTAGONAL' : 'RECTANGLE';
        out.push({ RECORD: 'Pad', NAME: name, LAYER: ln(layer), X: mil(x), Y: mil(y), XSIZE: mil(tx), YSIZE: mil(ty), HOLESIZE: mil(hole), SHAPE: shape, ROTATION: String(rot), PLATED: plated ? 'TRUE' : 'FALSE', ...(idx(net) ? { NET: idx(net)! } : {}), ...(idx(comp) ? { COMPONENT: idx(comp)! } : {}) });
      } else if (kind === 'Track' && type === 4) {
        const end = sub(); const layer = u8(); u8(); const f2 = u8(); const net = u16(), poly = u16(), comp = u16(); o += 4;
        const x1 = i32(), y1 = i32(), x2 = i32(), y2 = i32(), w = i32(); o = end;
        out.push({ RECORD: 'Track', LAYER: ln(layer), X1: mil(x1), Y1: mil(y1), X2: mil(x2), Y2: mil(y2), WIDTH: mil(w), ...(f2 === 2 ? { KEEPOUT: 'TRUE' } : {}), ...(idx(net) ? { NET: idx(net)! } : {}), ...(idx(poly) ? { POLYGON: idx(poly)! } : {}), ...(idx(comp) ? { COMPONENT: idx(comp)! } : {}) });
      } else if (kind === 'Arc' && type === 1) {
        const end = sub(); const layer = u8(); u8(); const f2 = u8(); const net = u16(), poly = u16(), comp = u16(); o += 4;
        const cx = i32(), cy = i32(), r = i32(), sa = f64(), ea = f64(), w = i32(); o = end;
        out.push({ RECORD: 'Arc', LAYER: ln(layer), 'LOCATION.X': mil(cx), 'LOCATION.Y': mil(cy), RADIUS: mil(r), STARTANGLE: String(sa), ENDANGLE: String(ea), WIDTH: mil(w), ...(f2 === 2 ? { KEEPOUT: 'TRUE' } : {}), ...(idx(net) ? { NET: idx(net)! } : {}), ...(idx(poly) ? { POLYGON: idx(poly)! } : {}), ...(idx(comp) ? { COMPONENT: idx(comp)! } : {}) });
      } else if (kind === 'Via' && type === 3) {
        const end = sub(); o += 3; const net = u16(); o += 8;
        const x = i32(), y = i32(), d = i32(), hole = i32(); const ls = u8(), le = u8(); o = end;
        out.push({ RECORD: 'Via', X: mil(x), Y: mil(y), DIAMETER: mil(d), HOLESIZE: mil(hole), STARTLAYER: ln(ls), ENDLAYER: ln(le), ...(idx(net) ? { NET: idx(net)! } : {}) });
      } else if (kind === 'Fill' && type === 6) {
        const end = sub(); const layer = u8(); u8(); const f2 = u8(); const net = u16(); o += 2; const comp = u16(); o += 4;
        const x1 = i32(), y1 = i32(), x2 = i32(), y2 = i32(), rot = f64(); o = end;
        out.push({ RECORD: 'Fill', LAYER: ln(layer), X1: mil(x1), Y1: mil(y1), X2: mil(x2), Y2: mil(y2), ROTATION: String(rot), ...(f2 === 2 ? { KEEPOUT: 'TRUE' } : {}), ...(idx(net) ? { NET: idx(net)! } : {}), ...(idx(comp) ? { COMPONENT: idx(comp)! } : {}) });
      } else {
        // unknown record type in this stream: skip its subrecords until the next plausible type byte
        const end = sub(); o = end;
      }
    } catch { break; }
  }
  return out;
}

/** Regions6: [type 11][len][layer u8][flags u8 u8][net u16][poly u16][comp u16][skip 5][props u32-len string][n u32][n x (x f64, y f64)]. */
function binaryRegions(b: Uint8Array | undefined): Rec[] {
  const out: Rec[] = []; if (!b) return out;
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let o = 0;
  while (o + 5 < b.length) {
    const type = dv.getUint8(o); o++;
    const len = dv.getUint32(o, true); o += 4; const end = o + len;
    if (type === 11) {
      try {
        const layer = dv.getUint8(o); const f2 = dv.getUint8(o + 2); const net = dv.getUint16(o + 3, true); const comp = dv.getUint16(o + 7, true);
        let q = o + 9 + 5;
        const pl = dv.getUint32(q, true); q += 4; let s = ''; for (let i = 0; i < pl; i++) { const c = b[q + i]; if (c === 0) break; s += String.fromCharCode(c); } q += pl;
        const props = parseProps(s);
        const n = dv.getUint32(q, true); q += 4;
        const r: Rec = { RECORD: 'Region', LAYER: LAYER_NAMES[layer] ?? `L${layer}`, ...props, ...(net !== 0xffff ? { NET: String(net) } : {}), ...(comp !== 0xffff ? { COMPONENT: String(comp) } : {}), ...(f2 === 2 ? { KEEPOUT: 'TRUE' } : {}) };
        for (let i = 0; i < n && q + 16 <= end; i++) { r[`VX${i}`] = `${dv.getFloat64(q, true) / 10000}mil`; r[`VY${i}`] = `${dv.getFloat64(q + 8, true) / 10000}mil`; r[`KIND${i}`] = '0'; q += 16; }
        out.push(r);
      } catch { /* malformed */ }
    }
    o = end;
  }
  return out;
}

/** All records of a PcbDoc (ASCII text or compound-file bytes), grouped by RECORD kind. */
export function altiumRecords(data: Uint8Array | string): Map<string, Rec[]> {
  const by = new Map<string, Rec[]>();
  const add = (r: Rec) => { const k = r.RECORD ?? '?'; const a = by.get(k) ?? []; a.push(r); by.set(k, a); };
  const bytes = typeof data === 'string' ? null : data;
  if (bytes && bytes.length > 8 && bytes[0] === 0xd0 && bytes[1] === 0xcf && bytes[2] === 0x11 && bytes[3] === 0xe0) {
    const s = readCfb(bytes);
    const get = (n: string) => s.get(`${n}/Data`);
    for (const r of propStream(get('Board6'))) add({ ...r, RECORD: 'Board' });
    for (const r of propStream(get('Components6'))) add({ ...r, RECORD: 'Component' });
    for (const r of propStream(get('Nets6'))) add({ ...r, RECORD: 'Net' });
    for (const r of propStream(get('Classes6'))) add({ ...r, RECORD: 'Class' });
    for (const r of propStream(get('Polygons6'))) add({ ...r, RECORD: 'Polygon' });
    for (const r of propStream(get('Rules6'), 2)) add({ ...r, RECORD: 'Rule' });
    for (const r of binaryPrims(get('Pads6'), 'Pad')) add(r);
    for (const r of binaryPrims(get('Tracks6'), 'Track')) add(r);
    for (const r of binaryPrims(get('Vias6'), 'Via')) add(r);
    for (const r of binaryPrims(get('Arcs6'), 'Arc')) add(r);
    for (const r of binaryPrims(get('Fills6'), 'Fill')) add(r);
    for (const r of binaryRegions(get('Regions6'))) add(r);
    for (const r of binaryRegions(get('ShapeBasedRegions6'))) add(r);
    return by;
  }
  const text = typeof data === 'string' ? data : new TextDecoder('latin1').decode(data);
  for (const line of text.split(/\r\n|\r|\n/)) if (line.startsWith('|RECORD=')) add(parseProps(line));
  return by;
}

/* ================================ conversion ================================ */

/** "12.5mil" / "0.3mm" / "1.2in" -> mm */
function len(v: string | undefined): number {
  if (v === undefined || v === '') return 0;
  const m = /^\s*([-+0-9.eE]+)\s*([a-zA-Z]*)/.exec(v); if (!m) return 0;
  const x = parseFloat(m[1]); const u = m[2].toLowerCase();
  return u === 'mm' ? x : u === 'in' || u === 'inch' ? x * 25.4 : u === 'mil' || u === '' ? x * 0.0254 : x * 0.0254;
}
const num = (v: string | undefined, d = 0) => (v === undefined || v.trim() === '' ? d : parseFloat(v));
const yes = (v: string | undefined) => (v ?? '').toUpperCase() === 'TRUE';

/** Polyline of a KINDn/VXn/VYn vertex list (arcs between vertices expanded). */
function vertexList(r: Rec, ox: number, oy: number): Pt[] {
  const pts: Pt[] = [];
  for (let i = 0; r[`VX${i}`] !== undefined; i++) {
    const p = { x: len(r[`VX${i}`]) - ox, y: len(r[`VY${i}`]) - oy };
    pts.push(p);
    if (r[`KIND${i}`] === '1' && r[`VX${i + 1}`] !== undefined) {
      const c = { x: len(r[`CX${i}`]) - ox, y: len(r[`CY${i}`]) - oy }, R = len(r[`R${i}`]);
      const q = { x: len(r[`VX${i + 1}`]) - ox, y: len(r[`VY${i + 1}`]) - oy };
      let a0 = Math.atan2(p.y - c.y, p.x - c.x), a1 = Math.atan2(q.y - c.y, q.x - c.x);
      // Altium arcs run counter-clockwise from SA to EA; the vertex order says which way this edge goes
      const sa = (num(r[`SA${i}`]) * Math.PI) / 180;
      const ccw = Math.abs(Math.atan2(Math.sin(a0 - sa), Math.cos(a0 - sa))) < 0.05;
      if (ccw) { while (a1 <= a0) a1 += 2 * Math.PI; } else { while (a1 >= a0) a1 -= 2 * Math.PI; }
      const n = Math.max(2, Math.ceil(Math.abs(a1 - a0) / (Math.PI / 18)));
      for (let k = 1; k < n; k++) { const a = a0 + ((a1 - a0) * k) / n; pts.push({ x: c.x + R * Math.cos(a), y: c.y + R * Math.sin(a) }); }
    }
  }
  if (pts.length > 2 && Math.hypot(pts[0].x - pts[pts.length - 1].x, pts[0].y - pts[pts.length - 1].y) < 1e-6) pts.pop();
  return pts;
}

function arcPoints(c: Pt, r: number, sa: number, ea: number): Pt[] {
  let a0 = (sa * Math.PI) / 180, a1 = (ea * Math.PI) / 180; while (a1 <= a0) a1 += 2 * Math.PI;
  const n = Math.max(2, Math.ceil((a1 - a0) / (Math.PI / 18)));
  return Array.from({ length: n + 1 }, (_, k) => { const a = a0 + ((a1 - a0) * k) / n; return { x: c.x + r * Math.cos(a), y: c.y + r * Math.sin(a) }; });
}

export function importAltiumPcb(data: Uint8Array | string, name = 'altium'): Project {
  const R = altiumRecords(data);
  const boards = R.get('Board') ?? [];
  if (!boards.length && !(R.get('Component')?.length)) throw new Error('not an Altium PcbDoc (no Board/Component records)');
  const board: Rec = {}; for (const b of boards) for (const [k, v] of Object.entries(b)) if (!(k in board)) board[k] = v;
  const ox = len(board.ORIGINX), oy = len(board.ORIGINY);
  const p = newProject(name, 2);
  // ---- copper stack
  interface SL { alt: string; name: string; plane: boolean; cu: number; diel?: number; er?: number }
  const stack: SL[] = [];
  let pendingDiel: { h: number; er: number } | null = null;
  for (let i = 0; board[`V9_STACK_LAYER${i}_NAME`] !== undefined; i++) {
    const id = num(board[`V9_STACK_LAYER${i}_LAYERID`]), hi = Math.floor(id / 65536), lo = id % 65536;
    const nm = board[`V9_STACK_LAYER${i}_NAME`];
    if (hi === 0x0100 || hi === 0x0101) {
      const alt = hi === 0x0101 ? `PLANE${lo}` : lo === 1 ? 'TOP' : lo === 0xffff ? 'BOTTOM' : `MID${lo - 1}`;
      if (stack.length && pendingDiel) { stack[stack.length - 1].diel = pendingDiel.h; stack[stack.length - 1].er = pendingDiel.er; }
      pendingDiel = null;
      stack.push({ alt, name: nm, plane: hi === 0x0101, cu: len(board[`V9_STACK_LAYER${i}_COPTHICK`]) });
    } else if (hi === 0x0104 && stack.length) {
      const h = len(board[`V9_STACK_LAYER${i}_DIELHEIGHT`]), er = num(board[`V9_STACK_LAYER${i}_DIELCONST`], 4.3);
      pendingDiel = pendingDiel ? { h: pendingDiel.h + h, er } : { h, er };
    }
  }
  if (!stack.length) {
    // old format: LAYERnNAME / LAYERnNEXT chain from the top layer (1) to the bottom layer (32)
    const altOf = (n: number) => LAYER_NAMES[n] ?? `L${n}`;
    const seen = new Set<number>();
    for (let n = 1; n && !seen.has(n) && n <= 74; ) {
      seen.add(n);
      if (n === 1 || n === 32 || (n >= 2 && n <= 31) || (n >= 39 && n <= 54)) stack.push({ alt: altOf(n), name: board[`LAYER${n}NAME`] ?? altOf(n), plane: n >= 39, cu: len(board[`LAYER${n}COPTHICK`]), diel: len(board[`LAYER${n}DIELHEIGHT`]) || undefined, er: num(board[`LAYER${n}DIELCONST`], 0) || undefined });
      if (n === 32) break;
      n = num(board[`LAYER${n}NEXT`]);
    }
    if (!stack.length) stack.push({ alt: 'TOP', name: 'Top', plane: false, cu: 0.035 }, { alt: 'BOTTOM', name: 'Bottom', plane: false, cu: 0.035 });
  }
  // only the copper layers that are used (MID layers of a 2-layer board are listed but empty)
  const used = new Set<string>(['TOP', 'BOTTOM']);
  for (const k of ['Track', 'Arc', 'Fill', 'Region', 'Polygon', 'Pad']) for (const r of R.get(k) ?? []) used.add((r.LAYER ?? '').toUpperCase());
  for (const v of R.get('Via') ?? []) { used.add((v.STARTLAYER ?? '').toUpperCase()); used.add((v.ENDLAYER ?? '').toUpperCase()); }
  const cop = stack.filter((s) => used.has(s.alt) || s.plane);
  const L = cop.length;
  const obName = (i: number) => (i === 0 ? 'F.Cu' : i === L - 1 ? 'B.Cu' : `In${i}.Cu`);
  const layerOf = new Map<string, string>();
  cop.forEach((s, i) => layerOf.set(s.alt, obName(i)));
  p.layers = cop.map((s, i) => ({ name: obName(i), type: s.plane ? 'power' : 'signal', color: LAYER_COLORS[i % LAYER_COLORS.length], direction: i % 2 === 0 ? 'horizontal' : 'vertical', visible: true, ...(s.cu ? { copper: Math.round(s.cu * 10000) / 10000 } : {}), ...(i < L - 1 && s.diel ? { dielectric: Math.round(s.diel * 10000) / 10000 } : {}), ...(s.er ? { er: s.er } : {}) }));
  const totalH = p.layers.reduce((a, l, i) => a + (l.copper ?? 0.035) + (i < L - 1 ? l.dielectric ?? 0 : 0), 0);
  if (totalH > 0.2) p.rules.viaLength = Math.round(totalH * 1000) / 1000;
  const copper = (alt: string | undefined) => layerOf.get((alt ?? '').toUpperCase());
  // ---- outline
  const outline = vertexList(board, ox, oy);
  if (outline.length >= 3) p.outline = outline;
  // ---- nets and components (index = record order, or ID)
  const nets = R.get('Net') ?? [];
  const netName = (i: string | undefined) => { if (i === undefined) return ''; const n = Number(i); const r = nets.find((x) => num(x.ID, -1) === n) ?? nets[n]; return r?.NAME ?? ''; };
  const comps = R.get('Component') ?? [];
  const compOf = (i: string | undefined) => { if (i === undefined) return undefined; const n = Number(i); return comps.find((x) => num(x.ID, -1) === n) ?? comps[n]; };
  const refOf = new Map<Rec, string>();
  const pinsOf = new Map<string, string[]>();
  comps.forEach((c, i) => refOf.set(c, c.SOURCEDESIGNATOR || c.NAME || `U${i + 1}`));
  const padsByComp = new Map<Rec, Rec[]>();
  const freePads: Rec[] = [];
  for (const pd of R.get('Pad') ?? []) { const c = compOf(pd.COMPONENT); if (c) { const a = padsByComp.get(c) ?? []; a.push(pd); padsByComp.set(c, a); } else freePads.push(pd); }
  const silk = new Map<Rec, Pt[][]>();
  const addSilk = (c: Rec | undefined, pts: Pt[]) => { if (!c) return; const a = silk.get(c) ?? []; a.push(pts); silk.set(c, a); };
  const isOverlay = (l: string | undefined) => /OVERLAY/.test((l ?? '').toUpperCase());
  for (const t of R.get('Track') ?? []) if (t.COMPONENT !== undefined && isOverlay(t.LAYER)) addSilk(compOf(t.COMPONENT), [{ x: len(t.X1) - ox, y: len(t.Y1) - oy }, { x: len(t.X2) - ox, y: len(t.Y2) - oy }]);
  for (const a of R.get('Arc') ?? []) if (a.COMPONENT !== undefined && isOverlay(a.LAYER)) addSilk(compOf(a.COMPONENT), arcPoints({ x: len(a['LOCATION.X']) - ox, y: len(a['LOCATION.Y']) - oy }, len(a.RADIUS), num(a.STARTANGLE), num(a.ENDANGLE)));
  const used2 = new Set<string>();
  const place = (c: Rec | null, pads: Rec[], idx: number) => {
    let ref = c ? refOf.get(c)! : `FP${idx}`;
    while (used2.has(ref)) ref += '_';
    used2.add(ref);
    const back = c ? (c.LAYER ?? 'TOP').toUpperCase() === 'BOTTOM' : (pads[0]?.LAYER ?? '').toUpperCase() === 'BOTTOM';
    const cx = c ? len(c.X) - ox : len(pads[0].X) - ox, cy = c ? len(c.Y) - oy : len(pads[0].Y) - oy;
    const rot = c ? ((num(c.ROTATION) % 360) + 360) % 360 : 0;
    const rr = (-rot * Math.PI) / 180, cs = Math.cos(rr), sn = Math.sin(rr);
    const toLocal = (q: Pt): Pt => { const dx = q.x - cx, dy = q.y - cy; const m = { x: dx * cs - dy * sn, y: dx * sn + dy * cs }; return back ? { x: -m.x, y: m.y } : m; };
    const fpPads: Pad[] = [];
    for (const pd of pads) {
      const lay = (pd.LAYER ?? '').toUpperCase();
      const hole = len(pd.HOLESIZE);
      const th = lay === 'MULTILAYER' || hole > 0;
      if (!th && !copper(lay)) continue;
      const loc = toLocal({ x: len(pd.X) - ox, y: len(pd.Y) - oy });
      let w = len(pd.XSIZE), h = len(pd.YSIZE);
      const abs = num(pd.ROTATION);
      let rel = back ? rot - abs : abs - rot; rel = ((rel % 360) + 360) % 360;
      let prot: number | undefined;
      const q = rel / 90;
      if (Math.abs(q - Math.round(q)) < 1e-4) { if (Math.round(q) % 2 === 1) [w, h] = [h, w]; } else prot = Math.round(rel * 100) / 100;
      const sh = (pd.SHAPE ?? '').toUpperCase();
      const shape: Pad['shape'] = sh === 'ROUND' ? (Math.abs(w - h) < 1e-6 ? 'circle' : 'oval') : 'rect';
      const id = pd.NAME || String(fpPads.length + 1);
      const npth = th && pd.PLATED !== undefined && !yes(pd.PLATED);
      fpPads.push({ id, x: Math.round(loc.x * 1e5) / 1e5, y: Math.round(loc.y * 1e5) / 1e5, w: w || hole, h: h || hole, shape, th, ...(th ? { drill: hole || Math.min(w, h) * 0.5 } : {}), ...(prot !== undefined ? { rot: prot } : {}), ...(npth ? { npth: true } : {}) });
      const n = netName(pd.NET); if (n) { const a = pinsOf.get(n) ?? []; a.push(`${ref}-${id}`); pinsOf.set(n, a); }
    }
    const outlineS = (c ? silk.get(c) ?? [] : []).map((pl) => pl.map(toLocal));
    let bw = 1, bh = 1; for (const pd of fpPads) { bw = Math.max(bw, Math.abs(pd.x) * 2 + pd.w); bh = Math.max(bh, Math.abs(pd.y) * 2 + pd.h); }
    const base = c?.PATTERN || `PAD_${ref}`;
    const key = p.footprints[base] && JSON.stringify(p.footprints[base].pads) !== JSON.stringify(fpPads) ? `${base}#${ref}` : base;
    p.footprints[key] = { name: key, pads: fpPads, outline: outlineS, body: { w: bw, h: bh }, outlineKind: 'silk', ...(c?.HEIGHT ? { height: Math.round(len(c.HEIGHT) * 1000) / 1000 } : {}) };
    p.components.push({ ref, footprint: key, value: c?.COMMENT ?? c?.SOURCELIBREFERENCE ?? '', x: cx, y: cy, rot, side: back ? 'back' : 'front' });
  };
  comps.forEach((c, i) => place(c, padsByComp.get(c) ?? [], i));
  freePads.forEach((pd, i) => place(null, [pd], i + 1));
  for (const [n, pins] of pinsOf) p.nets.push({ name: n, pins });
  for (const n of nets) if (n.NAME && !pinsOf.has(n.NAME)) p.nets.push({ name: n.NAME, pins: [] });
  // ---- copper: tracks, arcs, vias, pours, fills, regions
  for (const t of R.get('Track') ?? []) {
    const l = copper(t.LAYER); if (!l || t.COMPONENT !== undefined && !t.NET || (t.POLYGON !== undefined && t.POLYGON !== '65535' && !yes(t.POLYGONOUTLINE) && t.POLYGON !== '')) continue;
    if (yes(t.KEEPOUT)) continue;
    p.traces.push({ id: nextId(p), net: netName(t.NET), layer: l, width: len(t.WIDTH), points: [{ x: len(t.X1) - ox, y: len(t.Y1) - oy }, { x: len(t.X2) - ox, y: len(t.Y2) - oy }] });
  }
  for (const a of R.get('Arc') ?? []) {
    const l = copper(a.LAYER); if (!l || (a.COMPONENT !== undefined && !a.NET) || yes(a.KEEPOUT)) continue;
    p.traces.push({ id: nextId(p), net: netName(a.NET), layer: l, width: len(a.WIDTH), points: arcPoints({ x: len(a['LOCATION.X']) - ox, y: len(a['LOCATION.Y']) - oy }, len(a.RADIUS), num(a.STARTANGLE), num(a.ENDANGLE)) });
  }
  for (const v of R.get('Via') ?? []) {
    const a = copper(v.STARTLAYER) ?? 'F.Cu', b = copper(v.ENDLAYER) ?? 'B.Cu';
    const through = a === p.layers[0].name && b === p.layers[L - 1].name;
    p.vias.push({ id: nextId(p), net: netName(v.NET), x: len(v.X) - ox, y: len(v.Y) - oy, diameter: len(v.DIAMETER), drill: len(v.HOLESIZE), ...(through ? {} : { from: a, to: b }) });
  }
  for (const pg of R.get('Polygon') ?? []) {
    const l = copper(pg.LAYER); if (!l) continue;
    const pts = vertexList(pg, ox, oy); if (pts.length < 3) continue;
    p.zones.push({ id: nextId(p), net: netName(pg.NET), layer: l, points: pts, clearance: p.rules.clearance, dynamic: true });
  }
  for (const f of R.get('Fill') ?? []) {
    const l = copper(f.LAYER); if (!l || yes(f.KEEPOUT)) continue;
    const x1 = len(f.X1) - ox, y1 = len(f.Y1) - oy, x2 = len(f.X2) - ox, y2 = len(f.Y2) - oy;
    p.zones.push({ id: nextId(p), net: netName(f.NET), layer: l, points: [{ x: x1, y: y1 }, { x: x2, y: y1 }, { x: x2, y: y2 }, { x: x1, y: y2 }], clearance: 0, dynamic: false });
  }
  for (const rg of R.get('Region') ?? []) {
    const pts = vertexList(rg, ox, oy); if (pts.length < 3) continue;
    const kind = num(rg.KIND);
    const l = copper(rg.LAYER);
    if (kind === 3 || (rg.LAYER ?? '').toUpperCase() === 'KEEPOUT' || yes(rg.KEEPOUT)) { (p.cutouts ??= []); if (kind === 3) p.cutouts.push(pts); continue; }
    if (l && kind === 0 && rg.COMPONENT === undefined) p.zones.push({ id: nextId(p), net: netName(rg.NET), layer: l, points: pts, clearance: 0, dynamic: false });
  }
  // ---- classes and rules
  for (const c of R.get('Class') ?? []) {
    if (num(c.KIND) !== 0 || !c.NAME || /^All Nets$/i.test(c.NAME)) continue;
    const members: string[] = []; for (let i = 0; c[`M${i}`] !== undefined; i++) members.push(c[`M${i}`]);
    if (members.length) (p.netClasses ??= []).push({ name: c.NAME, nets: members });
  }
  for (const r of [...(R.get('Rule') ?? []), ...(R.get('DXPRule') ?? [])]) {
    if (!yes(r.ENABLED ?? 'TRUE')) continue;
    // old rules scope by SCOPEn_0_KIND, newer (DXPRule) ones by query expressions; 'All' / absent = whole board
    const all = (e: string | undefined) => e === undefined || /^\s*All\s*$/i.test(e);
    const kind = (r.RULEKIND ?? '').toLowerCase(), boardScope = (r.SCOPE1_0_KIND ?? 'Board') === 'Board' && (r.SCOPE2_0_KIND ?? 'Board') === 'Board' && all(r.SCOPE1EXPRESSION) && all(r.SCOPE2EXPRESSION);
    if (kind === 'routingvias' && r.WIDTH && r.HOLEWIDTH && len(r.WIDTH) <= len(r.HOLEWIDTH)) continue;
    if (kind === 'clearance' && boardScope && r.GAP) p.rules.clearance = Math.round(len(r.GAP) * 10000) / 10000;
    if (kind === 'width' && boardScope && r.PREFEREDWIDTH) p.rules.width = Math.round(len(r.PREFEREDWIDTH) * 10000) / 10000;
    if (kind === 'routingvias' && boardScope && r.WIDTH) { p.rules.viaDiameter = Math.round(len(r.WIDTH) * 10000) / 10000; if (r.HOLEWIDTH) p.rules.viaDrill = Math.round(len(r.HOLEWIDTH) * 10000) / 10000; }
    if (kind === 'clearance' && !boardScope && r.SCOPE1_0_KIND === 'NetClass' && r.GAP) { const cl = p.netClasses?.find((x) => x.name === r.SCOPE1_0_VALUE); if (cl) cl.clearance = len(r.GAP); }
    if (kind === 'width' && r.SCOPE1_0_KIND === 'NetClass' && r.PREFEREDWIDTH) { const cl = p.netClasses?.find((x) => x.name === r.SCOPE1_0_VALUE); if (cl) cl.width = len(r.PREFEREDWIDTH); }
  }
  return p;
}
