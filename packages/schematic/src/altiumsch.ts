/**
 * Altium schematic import (.SchDoc): the ASCII format ("|RECORD=1|...", one record per line) and the binary one
 * (compound file, "FileHeader" stream of length-prefixed property records; binary pin records decoded as Altium
 * writes them). Coordinates are 10 mil units (+ _FRAC / 100000), y up; the sheet is flipped to y down.
 *
 *   1 component  2 pin  4 label  6 polyline  7 polygon  8 ellipse  10 round rect  11 elliptical arc  12 arc
 *   13 line  14 rectangle  15 sheet symbol  16 sheet entry  17 power port  18 port  22 no ERC  25 net label
 *   26 bus  27 wire  29 junction  31 sheet  32 sheet name  33 file name  34 designator  37 bus entry
 *   41 parameter  44 implementation list  45 implementation (footprint)
 *
 * Each placed component becomes its own library part drawn from its records (exact geometry), placed unrotated.
 */
import { type Design, type Page, type LibPart, type SymPin, type Graphic, type PinType, type Orient, type Pt, newDesign, newPage, nid } from './model.js';
import { readCfb, parseProps, type Rec } from '../../editor/src/altium.js';

const ELEC: PinType[] = ['input', 'bidirectional', 'output', 'open_collector', 'passive', 'tristate', 'open_emitter', 'power'];
const ORI: Orient[] = ['right', 'up', 'left', 'down'];
const POWER_STYLE: Record<string, 'power_circle' | 'power_arrow' | 'power_bar' | 'ground' | 'ground_signal' | 'ground_earth'> = { '0': 'power_circle', '1': 'power_arrow', '2': 'power_bar', '3': 'power_bar', '4': 'ground', '5': 'ground_signal', '6': 'ground_earth' };

/** Records of a SchDoc (ASCII or binary). */
export function altiumSchRecords(data: Uint8Array): Rec[] {
  if (data[0] === 0xd0 && data[1] === 0xcf) {
    const s = readCfb(data); const b = s.get('FileHeader'); if (!b) throw new Error('SchDoc: no FileHeader stream');
    const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
    const out: Rec[] = []; let o = 0; let first = true;
    while (o + 4 <= b.length) {
      const raw = dv.getUint32(o, true); o += 4;
      const binary = (raw & 0xff000000) !== 0, len = raw & 0x00ffffff;
      if (o + len > b.length) break;
      const chunk = b.subarray(o, o + len); o += len;
      if (!binary) { let txt = ''; for (const c of chunk) { if (!c) break; txt += String.fromCharCode(c); } const r = parseProps(txt); if (first) { first = false; if (!r.RECORD) continue; } out.push(r); continue; }
      // binary pin record
      try {
        const v = new DataView(chunk.buffer, chunk.byteOffset, chunk.byteLength); let q = 0;
        const i32 = () => { const x = v.getInt32(q, true); q += 4; return x; }, i16 = () => { const x = v.getInt16(q, true); q += 2; return x; }, u8 = () => v.getUint8(q++);
        const pstr = () => { const n = u8(); let s2 = ''; for (let i = 0; i < n; i++) s2 += String.fromCharCode(u8()); return s2; };
        const rec = i32(); u8(); const part = i16(); u8(); u8(); u8(); u8(); u8(); pstr(); u8();
        const elec = u8(), conglom = u8(), len2 = i16(), x = i16(), y = i16(); i32();
        const name = pstr(), des = pstr();
        out.push({ RECORD: String(rec), OWNERPARTID: String(part), ELECTRICAL: String(elec), PINCONGLOMERATE: String(conglom), PINLENGTH: String(len2), 'LOCATION.X': String(x), 'LOCATION.Y': String(y), NAME: name, DESIGNATOR: des, __BINARYPIN: '1' });
      } catch { /* malformed */ }
    }
    return out;
  }
  const text = new TextDecoder('latin1').decode(data);
  const out: Rec[] = [];
  // records are separated by line breaks; each line is |KEY=VALUE|... (the first line is the header)
  for (const line of text.split(/\r\n|\r|\n/)) { if (!line.includes('RECORD=')) continue; out.push(parseProps(line.startsWith('|') ? line : '|' + line)); }
  return out;
}

const coord = (r: Rec, k: string) => (Number(r[k] ?? 0) * 10) + Number(r[`${k}_FRAC`] ?? 0) / 10000;

export function importAltiumSchematic(data: Uint8Array, name = 'altium', more: { data: Uint8Array; name: string }[] = []): Design {
  const d = newDesign(name);
  d.schematics = [{ name: 'ROOT', pages: [] }];
  d.root = 'ROOT';
  const lib = { name: 'altium', parts: {} as Record<string, LibPart> };
  d.libraries.push(lib);
  for (const f of [{ data, name }, ...more]) d.schematics[0].pages.push(sheet(d, lib, altiumSchRecords(f.data), f.name));
  return d;
}

function sheet(d: Design, lib: { parts: Record<string, LibPart> }, recs: Rec[], name: string): Page {
  const sh = recs.find((r) => r.RECORD === '31');
  // sheet height (y flip): custom size or the standard sheet style
  const styles = [[1150, 760], [1550, 1110], [2230, 1570], [3150, 2230], [4460, 3150], [950, 750], [1500, 950], [2000, 1500], [3200, 2000], [4200, 3200], [1100, 850], [1400, 850], [1700, 1100]];
  const custom = sh?.USECUSTOMSHEET === 'T';
  const H = custom ? Number(sh?.CUSTOMY ?? 760) * 10 : (styles[Number(sh?.SHEETSTYLE ?? 0)]?.[1] ?? 760) * 10;
  const page = newPage(name, H > 20000 ? 'D' : H > 15000 ? 'C' : H > 10000 ? 'B' : 'A');
  const P = (r: Rec, kx = 'LOCATION.X', ky = 'LOCATION.Y'): Pt => ({ x: Math.round(coord(r, kx)), y: Math.round(H - coord(r, ky)) });
  const ptsOf = (r: Rec): Pt[] => { const n = Number(r.LOCATIONCOUNT ?? 0); const out: Pt[] = []; for (let i = 1; i <= n; i++) out.push(P(r, `X${i}`, `Y${i}`)); return out; };
  // owner chains
  const comps = new Map<number, { rec: Rec; pins: Rec[]; gfx: Rec[]; ref?: string; params: Record<string, string>; footprint?: string; implLists: number[] }>();
  recs.forEach((r, i) => { if (r.RECORD === '1') comps.set(i, { rec: r, pins: [], gfx: [], params: {}, implLists: [] }); });
  let lastComp = -1;
  const implOwner = new Map<number, number>();
  recs.forEach((r, i) => {
    if (r.RECORD === '1') { lastComp = i; return; }
    const owner = r.OWNERINDEX !== undefined ? Number(r.OWNERINDEX) : r.__BINARYPIN ? lastComp : -1;
    const c = comps.get(owner);
    if (r.RECORD === '44' && c) { c.implLists.push(i); implOwner.set(i, owner); return; }
    if (r.RECORD === '45') { const lo = implOwner.get(owner); const cc = lo !== undefined ? comps.get(lo) : undefined; if (cc && (r.MODELTYPE ?? '').toUpperCase() === 'PCBLIB' && (r.ISCURRENT === 'T' || !cc.footprint)) cc.footprint = r.MODELNAME; return; }
    if (!c) return;
    if (r.RECORD === '2') c.pins.push(r);
    else if (r.RECORD === '34') c.ref = r.TEXT;
    else if (r.RECORD === '41') { if (r.NAME) c.params[r.NAME] = r.TEXT ?? ''; }
    else if (['4', '6', '7', '8', '10', '11', '12', '13', '14'].includes(r.RECORD ?? '')) c.gfx.push(r);
  });
  for (const [i, c] of comps) {
    const r = c.rec;
    const unit = Math.max(0, Number(r.CURRENTPARTID ?? 1) - 1), nUnits = Math.max(1, Number(r.PARTCOUNT ?? 2) - 1);
    const mode = r.DISPLAYMODE ?? '0';
    const at = P(r);
    const mine = (x: Rec) => (x.OWNERPARTID === undefined || x.OWNERPARTID === '-1' || x.OWNERPARTID === '0' || Number(x.OWNERPARTID) - 1 === unit) && (x.OWNERPARTDISPLAYMODE ?? '0') === mode;
    const L = (q: Pt): Pt => ({ x: q.x - at.x, y: q.y - at.y });
    const pins: SymPin[] = c.pins.filter(mine).map((p) => {
      const cg = Number(p.PINCONGLOMERATE ?? 0), ori = ORI[cg & 3], len = Number(p.PINLENGTH ?? 0) * 10 + Number(p.PINLENGTH_FRAC ?? 0) / 10000;
      const base = P(p);
      const dv = ori === 'right' ? { x: 1, y: 0 } : ori === 'left' ? { x: -1, y: 0 } : ori === 'up' ? { x: 0, y: -1 } : { x: 0, y: 1 };
      const tip = { x: base.x + dv.x * len, y: base.y + dv.y * len };
      const hidden = (cg & 0x04) !== 0;
      const type = ELEC[Number(p.ELECTRICAL ?? 4)] ?? 'passive';
      const pname = (p.NAME ?? '').replace(/\\/g, '');
      return { number: p.DESIGNATOR ?? '', name: pname, type, ...L(tip), length: Math.round(len), orient: ori, ...(hidden ? { hidden: true, ...(type === 'power' ? { net: pname } : {}) } : {}) } as SymPin;
    });
    const graphics: Graphic[] = [];
    for (const g of c.gfx.filter(mine)) {
      switch (g.RECORD) {
        case '13': graphics.push({ kind: 'line', pts: [L(P(g)), L(P(g, 'CORNER.X', 'CORNER.Y'))] }); break;
        case '6': { const pts = ptsOf(g).map(L); if (pts.length >= 2) graphics.push({ kind: 'line', pts }); break; }
        case '7': { const pts = ptsOf(g).map(L); if (pts.length >= 3) graphics.push({ kind: 'polygon', pts, fill: g.ISSOLID === 'T' }); break; }
        case '14': case '10': { const a = L(P(g)), b = L(P(g, 'CORNER.X', 'CORNER.Y')); graphics.push({ kind: 'rect', x1: a.x, y1: a.y, x2: b.x, y2: b.y }); break; }
        case '8': { const cc = L(P(g)); graphics.push({ kind: 'circle', c: cc, r: Math.round(coord(g, 'RADIUS')) }); break; }
        case '12': case '11': { const cc = L(P(g)); graphics.push({ kind: 'arc', c: cc, r: Math.round(coord(g, 'RADIUS')), a0: Number(g.STARTANGLE ?? 0), a1: Number(g.ENDANGLE ?? 360) }); break; }
        case '4': graphics.push({ kind: 'text', at: L(P(g)), text: g.TEXT ?? '', size: 50 }); break;
      }
    }
    const libName = (r.LIBREFERENCE ?? `PART${i}`).replace(/[^\w.+-]/g, '_');
    const key = `${libName}#${i}`;
    const units = Array.from({ length: nUnits }, (_, u) => ({ normal: u === unit ? { graphics, pins } : { graphics: [], pins: [] } }));
    const ref = c.ref ?? `${/^[A-Za-z]+/.exec(r.DESIGNATORPREFIX ?? 'U')?.[0] ?? 'U'}?`;
    const value = c.params.Value ?? (c.params.Comment && !c.params.Comment.startsWith('=') ? c.params.Comment : undefined) ?? r.COMMENT ?? libName;
    lib.parts[key] = { name: key, refPrefix: /^[A-Za-z]+/.exec(ref)?.[0] ?? 'U', units, props: { Value: value, ...(c.footprint ? { 'PCB Footprint': c.footprint } : {}), ...(r.COMPONENTDESCRIPTION ? { Description: r.COMPONENTDESCRIPTION } : {}) }, description: r.COMPONENTDESCRIPTION ?? '' };
    page.parts.push({ id: nid(d), lib: 'altium', part: key, unit, ref, x: at.x, y: at.y, rot: 0, props: {} });
  }
  for (const r of recs) {
    switch (r.RECORD) {
      case '27': { const pts = ptsOf(r); if (pts.length >= 2) page.wires.push({ id: nid(d), pts }); break; }
      case '26': { const pts = ptsOf(r); if (pts.length >= 2) page.buses.push({ id: nid(d), pts }); break; }
      case '29': page.junctions.push({ id: nid(d), at: P(r) }); break;
      case '25': page.aliases.push({ id: nid(d), at: P(r), name: r.TEXT ?? '' }); break;
      case '17': { const style = POWER_STYLE[r.STYLE ?? '2'] ?? 'power_bar'; const o = Number(r.ORIENTATION ?? (style.startsWith('ground') ? 3 : 1)); page.globals.push({ id: nid(d), at: P(r), net: r.TEXT ?? '', style, rot: ((style.startsWith('ground') ? (o === 3 ? 0 : o === 1 ? 180 : o === 0 ? 90 : 270) : (o === 1 ? 0 : o === 3 ? 180 : o === 0 ? 270 : 90))) as 0 }); break; }
      case '18': {
        // a port connects at its left end, or its right end when the wire comes from the right (ALIGNMENT / STYLE)
        const at = P(r); const w = coord(r, 'WIDTH');
        const right = (r.STYLE === '3' || r.STYLE === '2') ? false : (r.IOTYPE === '1');
        page.offPages.push({ id: nid(d), at: right ? { x: Math.round(at.x + w), y: at.y } : at, name: r.NAME ?? '' });
        break;
      }
      case '22': page.noConnects.push({ id: nid(d), at: P(r) }); break;
      case '37': { const a = P(r), b = P(r, 'CORNER.X', 'CORNER.Y'); page.busEntries.push({ id: nid(d), at: a, dir: `${b.y < a.y ? 'n' : 's'}${b.x < a.x ? 'w' : 'e'}` as 'ne' }); break; }
    }
  }
  // free texts / graphics on the sheet (owner -1)
  for (const r of recs) if (r.RECORD === '4' && (r.OWNERINDEX === undefined || r.OWNERINDEX === '-1')) page.texts.push({ id: nid(d), at: P(r), text: r.TEXT ?? '', size: 50 });
  // ports connect at whichever end a wire touches
  for (const o of page.offPages) {
    const touches = (q: Pt) => page.wires.some((w) => w.pts.some((p) => p.x === q.x && p.y === q.y));
    if (!touches(o.at)) { const rec = recs.find((r) => r.RECORD === '18' && r.NAME === o.name); if (rec) { const a = P(rec), w = Math.round(coord(rec, 'WIDTH')); for (const q of [a, { x: a.x + w, y: a.y }]) if (touches(q)) { o.at = q; break; } } }
  }
  return page;
}
