/**
 * Artwork exports from the same primitives as the Gerber files (fab.ts artworkOf):
 *
 *   DXF      AutoCAD R12 ASCII: one DXF layer per board layer; traces as wide polylines, round flashes as filled
 *            discs, rectangles as SOLIDs, regions as closed polylines. DXF has no clear polarity, so pour cut-outs
 *            are not represented (pours appear as their outline) — use Gerber/ODB++/IPC-2581 for fabrication.
 *   PDF      vector plot, one page per layer (dark = layer colour, clear polarity painted in the paper colour, so
 *            pours show their clearances) plus an assembly page (silkscreen, outline, fab drawing).
 *   GDSII    binary stream, one GDS layer number per board layer; database unit 1 nm.
 *   ODB++    the directory tree (matrix, profile, per-layer features with positive/negative polarity, drill layers,
 *            netlist), zipped.
 *   IPC-2581 revision C XML: content dictionary, layers, stack-up, profile, packages, components, logical nets,
 *            layer features (positive/negative sets) and a BOM.
 */
import { type Project, type Pt, padToBoard, heightOf, copperOf } from './model.js';
import { defaultLibrary } from './footprints.js';
import { artworkOf, drillHoles, type ArtLayer, type Prim, type Aperture, zipFiles, type FabFile } from './fab.js';
import { padInstances } from './connectivity.js';

const f6 = (v: number) => (Math.round(v * 1e6) / 1e6).toString();
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/* ============================== DXF ============================== */

export function exportDxf(p: Project, opts: { layers?: string[] } = {}): string {
  const art = artworkOf(p).filter((l) => !opts.layers || opts.layers.includes(l.name));
  const o: string[] = [];
  const g = (code: number, v: string | number) => { o.push(String(code), typeof v === 'number' ? f6(v) : v); };
  g(0, 'SECTION'); g(2, 'HEADER'); g(9, '$ACADVER'); g(1, 'AC1009'); g(9, '$INSUNITS'); g(70, '4'); g(0, 'ENDSEC');
  g(0, 'SECTION'); g(2, 'TABLES'); g(0, 'TABLE'); g(2, 'LAYER'); g(70, String(art.length));
  art.forEach((l, i) => { g(0, 'LAYER'); g(2, dxfName(l.name)); g(70, '0'); g(62, String((i % 7) + 1)); g(6, 'CONTINUOUS'); });
  g(0, 'ENDTAB'); g(0, 'ENDSEC');
  g(0, 'SECTION'); g(2, 'ENTITIES');
  for (const l of art) {
    const L = dxfName(l.name);
    for (const pr of l.prims) {
      if (!pr.dark) continue;
      if (pr.kind === 'stroke') polyline(g, L, pr.pts, pr.ap.shape === 'C' ? pr.ap.w : Math.min(pr.ap.w, pr.ap.h), false);
      else if (pr.kind === 'region') polyline(g, L, pr.pts, 0, true);
      else if (pr.ap.shape === 'C') { const r = pr.ap.w / 2; g(0, 'POLYLINE'); g(8, L); g(66, '1'); g(70, '1'); g(40, r); g(41, r); vertex(g, L, { x: pr.at.x - r / 2, y: pr.at.y }, 1); vertex(g, L, { x: pr.at.x + r / 2, y: pr.at.y }, 1); g(0, 'SEQEND'); g(8, L); }
      else { const hw = pr.ap.w / 2, hh = pr.ap.h / 2, c = pr.at; g(0, 'SOLID'); g(8, L); g(10, c.x - hw); g(20, c.y - hh); g(30, 0); g(11, c.x + hw); g(21, c.y - hh); g(31, 0); g(12, c.x - hw); g(22, c.y + hh); g(32, 0); g(13, c.x + hw); g(23, c.y + hh); g(33, 0); }
    }
  }
  for (const h of drillHoles(p)) { g(0, 'CIRCLE'); g(8, 'DRILL'); g(10, h.x); g(20, h.y); g(30, 0); g(40, h.d / 2); }
  g(0, 'ENDSEC'); g(0, 'EOF');
  return o.join('\n') + '\n';
}
const dxfName = (s: string) => s.replace(/[^A-Za-z0-9_-]/g, '_').toUpperCase();
function vertex(g: (c: number, v: string | number) => void, L: string, q: Pt, bulge = 0): void { g(0, 'VERTEX'); g(8, L); g(10, q.x); g(20, q.y); g(30, 0); if (bulge) g(42, bulge); }
function polyline(g: (c: number, v: string | number) => void, L: string, pts: Pt[], width: number, closed: boolean): void {
  g(0, 'POLYLINE'); g(8, L); g(66, '1'); g(70, closed ? '1' : '0'); if (width > 0) { g(40, width); g(41, width); }
  for (const q of pts) vertex(g, L, q);
  g(0, 'SEQEND'); g(8, L);
}

/* ============================== PDF ============================== */

const PDF_COLORS: Record<string, [number, number, number]> = { copper: [0.75, 0.2, 0.1], mask: [0.1, 0.45, 0.2], paste: [0.45, 0.45, 0.45], silk: [0, 0, 0], outline: [0.6, 0.5, 0], drawing: [0.1, 0.25, 0.6] };

export function exportPdf(p: Project, opts: { layers?: string[]; title?: string } = {}): Uint8Array {
  const art = artworkOf(p);
  const xs = p.outline.map((q) => q.x), ys = p.outline.map((q) => q.y);
  const dims = (p.dimensions ?? []).flatMap((d) => [d.a, d.b]);
  const minX = Math.min(...xs, ...dims.map((q) => q.x)) - 8, maxX = Math.max(...xs, ...dims.map((q) => q.x)) + 8;
  const minY = Math.min(...ys, ...dims.map((q) => q.y)) - 8, maxY = Math.max(...ys, ...dims.map((q) => q.y)) + 14;
  const PT = 72 / 25.4;
  // 1:1 on paper up to A3 landscape, scaled to fit beyond that
  const maxW = 420, maxH = 297;
  const s = Math.min(1, maxW / (maxX - minX), maxH / (maxY - minY)) * PT;
  const W = (maxX - minX) * s, H = (maxY - minY) * s;
  const X = (x: number) => ((x - minX) * s).toFixed(3), Y = (y: number) => ((y - minY) * s).toFixed(3);
  const pages: string[] = [];
  const draw = (l: ArtLayer, col: [number, number, number], ops: string[]) => {
    for (const pr of l.prims) {
      const c = pr.dark ? col : [1, 1, 1];
      ops.push(`${c[0]} ${c[1]} ${c[2]} RG ${c[0]} ${c[1]} ${c[2]} rg`);
      if (pr.kind === 'stroke') { ops.push(`${(apWidth(pr.ap) * s).toFixed(3)} w 1 J 1 j`); ops.push(pr.pts.map((q, i) => `${X(q.x)} ${Y(q.y)} ${i ? 'l' : 'm'}`).join(' ') + ' S'); }
      else if (pr.kind === 'region') ops.push(pr.pts.map((q, i) => `${X(q.x)} ${Y(q.y)} ${i ? 'l' : 'm'}`).join(' ') + ' h f');
      else if (pr.ap.shape === 'C') ops.push(circlePath(Number(X(pr.at.x)), Number(Y(pr.at.y)), (pr.ap.w / 2) * s) + ' f');
      else ops.push(`${((pr.at.x - pr.ap.w / 2 - minX) * s).toFixed(3)} ${((pr.at.y - pr.ap.h / 2 - minY) * s).toFixed(3)} ${(pr.ap.w * s).toFixed(3)} ${(pr.ap.h * s).toFixed(3)} re f`);
    }
  };
  const title = (t: string) => `BT /F1 10 Tf 0 0 0 rg 14 ${(H - 16).toFixed(1)} Td (${pdfStr(t)}) Tj ET`;
  const scaleNote = s < PT - 1e-9 ? ` (scale 1:${(PT / s).toFixed(2)})` : ' (scale 1:1)';
  const outline = art.find((l) => l.kind === 'outline');
  for (const l of art) {
    if (opts.layers && !opts.layers.includes(l.name)) continue;
    if (l.kind === 'outline') continue;
    const ops: string[] = ['1 1 1 rg 0 0 ' + W.toFixed(2) + ' ' + H.toFixed(2) + ' re f'];
    if (outline) draw(outline, PDF_COLORS.outline, ops);
    draw(l, PDF_COLORS[l.kind], ops);
    ops.push(title(`${opts.title ?? p.name} - ${l.name}${scaleNote}`));
    pages.push(ops.join('\n'));
  }
  // assembly page: outline, top silkscreen, fab drawing (dimensions, notes)
  const asm: string[] = ['1 1 1 rg 0 0 ' + W.toFixed(2) + ' ' + H.toFixed(2) + ' re f'];
  for (const l of art) if (l.kind === 'outline' || l.kind === 'drawing' || l.name === 'F.Silk') draw(l, PDF_COLORS[l.kind], asm);
  asm.push(title(`${opts.title ?? p.name} - assembly / fabrication drawing${scaleNote}`));
  pages.push(asm.join('\n'));
  return buildPdf(pages, W, H);
}
const apWidth = (a: Aperture) => (a.shape === 'C' ? a.w : Math.min(a.w, a.h));
const pdfStr = (s: string) => s.replace(/[\\()]/g, (m) => '\\' + m).replace(/[^\x20-\x7e]/g, '?');
function circlePath(cx: number, cy: number, r: number): string {
  const k = 0.5523 * r, f = (v: number) => v.toFixed(3);
  return `${f(cx + r)} ${f(cy)} m ${f(cx + r)} ${f(cy + k)} ${f(cx + k)} ${f(cy + r)} ${f(cx)} ${f(cy + r)} c ${f(cx - k)} ${f(cy + r)} ${f(cx - r)} ${f(cy + k)} ${f(cx - r)} ${f(cy)} c ${f(cx - r)} ${f(cy - k)} ${f(cx - k)} ${f(cy - r)} ${f(cx)} ${f(cy - r)} c ${f(cx + k)} ${f(cy - r)} ${f(cx + r)} ${f(cy - k)} ${f(cx + r)} ${f(cy)} c`;
}
function buildPdf(pages: string[], W: number, H: number): Uint8Array {
  const objs: string[] = [];
  const add = (s: string) => { objs.push(s); return objs.length; };
  const catalog = add(''), pagesId = add(''), font = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  const kids: number[] = [];
  for (const content of pages) {
    const cid = add(`<< /Length ${content.length} >>\nstream\n${content}\nendstream`);
    kids.push(add(`<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 ${W.toFixed(2)} ${H.toFixed(2)}] /Resources << /Font << /F1 ${font} 0 R >> >> /Contents ${cid} 0 R >>`));
  }
  objs[catalog - 1] = `<< /Type /Catalog /Pages ${pagesId} 0 R >>`;
  objs[pagesId - 1] = `<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(' ')}] /Count ${kids.length} >>`;
  let out = '%PDF-1.4\n';
  const offs: number[] = [];
  objs.forEach((o, i) => { offs.push(out.length); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n` + offs.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('');
  out += `trailer\n<< /Size ${objs.length + 1} /Root ${catalog} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new Uint8Array([...out].map((ch) => ch.charCodeAt(0) & 0xff));
}

/* ============================== GDSII ============================== */

export function exportGdsii(p: Project, opts: { layers?: string[] } = {}): Uint8Array {
  const art = artworkOf(p).filter((l) => !opts.layers || opts.layers.includes(l.name));
  const bytes: number[] = [];
  const rec = (type: number, dt: number, payload: number[]) => { const len = 4 + payload.length; bytes.push((len >> 8) & 0xff, len & 0xff, type, dt, ...payload); };
  const i16 = (...v: number[]) => v.flatMap((x) => [(x >> 8) & 0xff, x & 0xff]);
  const i32 = (...v: number[]) => v.flatMap((x) => [(x >>> 24) & 0xff, (x >>> 16) & 0xff, (x >>> 8) & 0xff, x & 0xff]);
  const str = (s: string) => { const b = [...s].map((c) => c.charCodeAt(0) & 0x7f); if (b.length % 2) b.push(0); return b; };
  const now = new Date(); const date = i16(now.getFullYear(), now.getMonth() + 1, now.getDate(), now.getHours(), now.getMinutes(), now.getSeconds());
  const nm = (v: number) => Math.round(v * 1e6);   // mm -> nm (database unit)
  rec(0x00, 0x02, i16(600));
  rec(0x01, 0x02, [...date, ...date]);
  rec(0x02, 0x06, str((p.name || 'BOARD').slice(0, 30)));
  rec(0x03, 0x05, [...real8(1e-3), ...real8(1e-9)]);   // user unit = 1 um (1e-3 db units ... 1000 db per user unit), db unit = 1 nm
  rec(0x05, 0x02, [...date, ...date]);
  rec(0x06, 0x06, str('PCB'));
  const boundary = (layer: number, pts: Pt[]) => {
    for (const chunk of splitPoly(pts, 8000)) { rec(0x08, 0x00, []); rec(0x0d, 0x02, i16(layer)); rec(0x0e, 0x02, i16(0)); rec(0x10, 0x03, i32(...[...chunk, chunk[0]].flatMap((q) => [nm(q.x), nm(q.y)]))); rec(0x11, 0x00, []); }
  };
  art.forEach((l, li) => {
    const layer = li + 1;
    for (const pr of l.prims) {
      if (!pr.dark) continue;
      if (pr.kind === 'region') boundary(layer, pr.pts);
      else if (pr.kind === 'stroke') { rec(0x09, 0x00, []); rec(0x0d, 0x02, i16(layer)); rec(0x0e, 0x02, i16(0)); rec(0x21, 0x02, i16(1)); rec(0x0f, 0x03, i32(nm(apWidth(pr.ap)))); rec(0x10, 0x03, i32(...pr.pts.slice(0, 8000).flatMap((q) => [nm(q.x), nm(q.y)]))); rec(0x11, 0x00, []); }
      else if (pr.ap.shape === 'C') { const r = pr.ap.w / 2, n = 32; boundary(layer, Array.from({ length: n }, (_, k) => ({ x: pr.at.x + r * Math.cos((2 * Math.PI * k) / n), y: pr.at.y + r * Math.sin((2 * Math.PI * k) / n) }))); }
      else { const hw = pr.ap.w / 2, hh = pr.ap.h / 2, c = pr.at; boundary(layer, [{ x: c.x - hw, y: c.y - hh }, { x: c.x + hw, y: c.y - hh }, { x: c.x + hw, y: c.y + hh }, { x: c.x - hw, y: c.y + hh }]); }
    }
  });
  rec(0x07, 0x00, []); rec(0x04, 0x00, []);
  return new Uint8Array(bytes);
}
function splitPoly(pts: Pt[], max: number): Pt[][] { return pts.length <= max ? [pts] : [pts.slice(0, max)]; }
/** GDSII 8-byte real: sign, excess-64 base-16 exponent, 56-bit mantissa. */
function real8(v: number): number[] {
  if (v === 0) return [0, 0, 0, 0, 0, 0, 0, 0];
  const sign = v < 0 ? 0x80 : 0; v = Math.abs(v);
  let exp = 64; while (v >= 1) { v /= 16; exp++; } while (v < 1 / 16) { v *= 16; exp--; }
  const out = [sign | exp];
  for (let i = 0; i < 7; i++) { v *= 256; const b = Math.floor(v); out.push(b); v -= b; }
  return out;
}

/* ============================== ODB++ ============================== */

export function exportOdb(p: Project, opts: { name?: string } = {}): FabFile[] {
  const job = (opts.name ?? p.name ?? 'board').replace(/[^\w.-]+/g, '_').toLowerCase();
  const art = artworkOf(p);
  const files: FabFile[] = [];
  const put = (path: string, content: string) => files.push({ name: `${job}/${path}`, content });
  const lname = (s: string) => s.toLowerCase().replace(/[^a-z0-9_+-]/g, '_');
  put('misc/info', [`JOB_NAME=${job}`, 'ODB_VERSION_MAJOR=7', 'ODB_VERSION_MINOR=0', 'ODB_SOURCE=OpenBoard', `CREATION_DATE=${stamp()}`, 'SAVE_APP=OpenBoard', 'UNITS=MM', ''].join('\n'));
  // matrix: layers in physical order
  const rows: { name: string; type: string; ctx: string; pol?: string; start?: string; end?: string }[] = [];
  const by = (kind: string, side?: string) => art.filter((l) => l.kind === kind && (!side || l.side === side));
  for (const l of by('silk', 'front')) rows.push({ name: lname('f_silk'), type: 'SILK_SCREEN', ctx: 'BOARD' });
  for (const l of by('paste', 'front')) rows.push({ name: lname('f_paste'), type: 'SOLDER_PASTE', ctx: 'BOARD' });
  for (const l of by('mask', 'front')) rows.push({ name: lname('f_mask'), type: 'SOLDER_MASK', ctx: 'BOARD' });
  for (const l of art.filter((x) => x.kind === 'copper')) rows.push({ name: lname(l.name), type: p.layers.find((q) => q.name === l.name)?.type === 'power' ? 'POWER_GROUND' : 'SIGNAL', ctx: 'BOARD' });
  for (const l of by('mask', 'back')) rows.push({ name: lname('b_mask'), type: 'SOLDER_MASK', ctx: 'BOARD' });
  for (const l of by('paste', 'back')) rows.push({ name: lname('b_paste'), type: 'SOLDER_PASTE', ctx: 'BOARD' });
  for (const l of by('silk', 'back')) rows.push({ name: lname('b_silk'), type: 'SILK_SCREEN', ctx: 'BOARD' });
  // drill layers, one per span
  const spans = new Map<string, ReturnType<typeof drillHoles>>();
  for (const h of drillHoles(p)) { const k = `${h.from}|${h.to}`; (spans.get(k) ?? spans.set(k, []).get(k)!).push(h); }
  for (const [k] of spans) { const [a, b] = k.split('|'); rows.push({ name: `drill_${lname(a)}_${lname(b)}`, type: 'DRILL', ctx: 'BOARD', start: lname(a), end: lname(b) }); }
  rows.push({ name: 'fab_drawing', type: 'DOCUMENT', ctx: 'MISC' });
  put('matrix/matrix', ['STEP {', '   COL=1', '   NAME=PCB', '}', '', ...rows.flatMap((r, i) => ['LAYER {', `   ROW=${i + 1}`, `   CONTEXT=${r.ctx}`, `   TYPE=${r.type}`, `   NAME=${r.name.toUpperCase()}`, '   POLARITY=POSITIVE', `   START_NAME=${(r.start ?? '').toUpperCase()}`, `   END_NAME=${(r.end ?? '').toUpperCase()}`, '}', '']), ''].join('\n'));
  put('steps/pcb/stephdr', ['UNITS=MM', 'X_DATUM=0', 'Y_DATUM=0', 'X_ORIGIN=0', 'Y_ORIGIN=0', ''].join('\n'));
  put('steps/pcb/profile', ['UNITS=MM', '#', 'S P 0', ...surfaceLines(p.outline), 'SE', ''].join('\n'));
  const layerFile = (name: string, prims: Prim[]) => put(`steps/pcb/layers/${name}/features`, odbFeatures(prims));
  const map: Record<string, string> = { 'F.Silk': 'f_silk', 'B.Silk': 'b_silk', 'F.Mask': 'f_mask', 'B.Mask': 'b_mask', 'F.Paste': 'f_paste', 'B.Paste': 'b_paste', 'Fab.Drawing': 'fab_drawing' };
  for (const l of art) { if (l.kind === 'outline') continue; layerFile(l.kind === 'copper' ? lname(l.name) : map[l.name], l.prims); }
  for (const [k, holes] of spans) { const [a, b] = k.split('|'); layerFile(`drill_${lname(a)}_${lname(b)}`, holes.map((h) => ({ kind: 'flash', dark: true, ap: { shape: 'C', w: h.d, h: h.d }, at: { x: h.x, y: h.y } }) as Prim)); }
  // netlist (cadnet): one point per pad and via, with its net
  const nets = [...new Set([...p.nets.map((n) => n.name)])];
  const netIdx = new Map(nets.map((n, i) => [n, i]));
  const pts: string[] = [];
  for (const pd of padInstances(p)) if (pd.net && netIdx.has(pd.net)) pts.push(`${netIdx.get(pd.net)} ${f6(Math.min(pd.w, pd.h) / 2)} ${f6(pd.center.x)} ${f6(pd.center.y)} ${pd.th ? 'B' : pd.side === 'front' ? 'T' : 'D'} e`);
  for (const v of p.vias) if (netIdx.has(v.net)) pts.push(`${netIdx.get(v.net)} ${f6(v.drill / 2)} ${f6(v.x)} ${f6(v.y)} B v`);
  put('steps/pcb/netlists/cadnet/netlist', ['H optimize n staggered n', 'UNITS=MM', ...nets.map((n, i) => `$${i} ${n.replace(/\s+/g, '_')}`), '#', ...pts, ''].join('\n'));
  return files;
}
function stamp(): string { const d = new Date(); const z = (v: number) => String(v).padStart(2, '0'); return `${d.getFullYear()}${z(d.getMonth() + 1)}${z(d.getDate())}.${z(d.getHours())}${z(d.getMinutes())}${z(d.getSeconds())}`; }
function surfaceLines(poly: Pt[]): string[] { return [`OB ${f6(poly[0].x)} ${f6(poly[0].y)} I`, ...poly.slice(1).map((q) => `OS ${f6(q.x)} ${f6(q.y)}`), `OS ${f6(poly[0].x)} ${f6(poly[0].y)}`, 'OE']; }
function odbFeatures(prims: Prim[]): string {
  const syms = new Map<string, number>();
  const sym = (a: Aperture) => { const k = a.shape === 'C' ? `r${Math.round(a.w * 1000)}` : `rect${Math.round(a.w * 1000)}x${Math.round(a.h * 1000)}`; let i = syms.get(k); if (i === undefined) { i = syms.size; syms.set(k, i); } return i; };
  const body: string[] = [];
  for (const pr of prims) {
    const pol = pr.dark ? 'P' : 'N';
    if (pr.kind === 'stroke') { const s = sym(pr.ap.shape === 'C' ? pr.ap : { shape: 'C', w: apWidth(pr.ap), h: apWidth(pr.ap) }); for (let i = 1; i < pr.pts.length; i++) body.push(`L ${f6(pr.pts[i - 1].x)} ${f6(pr.pts[i - 1].y)} ${f6(pr.pts[i].x)} ${f6(pr.pts[i].y)} ${s} ${pol} 0`); }
    else if (pr.kind === 'flash') body.push(`P ${f6(pr.at.x)} ${f6(pr.at.y)} ${sym(pr.ap)} ${pol} 0 0`);
    else body.push(`S ${pol} 0`, ...surfaceLines(pr.pts), 'SE');
  }
  return ['UNITS=MM', '#', ...[...syms].map(([k, i]) => `$${i} ${k}`), '#', ...body, ''].join('\n');
}
export function odbZip(files: FabFile[]): Uint8Array { return zipFiles(files); }

/* ============================== IPC-2581 ============================== */

export function exportIpc2581(p: Project): string {
  const art = artworkOf(p);
  const lib = { ...defaultLibrary(), ...p.footprints };
  const apIds = new Map<string, string>();
  const apId = (a: Aperture) => { const k = a.shape === 'C' ? `CIRCLE_${f6(a.w)}` : `RECT_${f6(a.w)}x${f6(a.h)}`; if (!apIds.has(k)) apIds.set(k, k.replace(/\./g, 'p')); return apIds.get(k)!; };
  const lineIds = new Map<string, string>();
  const lineId = (w: number) => { const k = `LINE_${f6(w)}`.replace(/\./g, 'p'); lineIds.set(k, f6(w)); return k; };
  const fn = (l: ArtLayer) => (l.kind === 'copper' ? (p.layers.find((q) => q.name === l.name)?.type === 'power' ? 'PLANE' : 'SIGNAL') : l.kind === 'mask' ? 'SOLDERMASK' : l.kind === 'paste' ? 'SOLDERPASTE' : l.kind === 'silk' ? 'SILKSCREEN' : l.kind === 'outline' ? 'BOARD_OUTLINE' : 'DOCUMENT');
  const sideOf = (l: ArtLayer) => { if (l.kind === 'copper') { const i = p.layers.findIndex((q) => q.name === l.name); return i === 0 ? 'TOP' : i === p.layers.length - 1 ? 'BOTTOM' : 'INTERNAL'; } return l.side === 'back' ? 'BOTTOM' : l.side === 'front' ? 'TOP' : 'ALL'; };
  const lref = (s: string) => esc(s);
  // features per layer, grouped by polarity runs
  const features: string[] = [];
  for (const l of art) {
    if (l.kind === 'outline') continue;
    features.push(`        <LayerFeature layerRef="${lref(l.name)}">`);
    let run: Prim[] = []; let pol: boolean | null = null;
    const flush = () => {
      if (!run.length) return;
      features.push(`          <Set polarity="${pol ? 'POSITIVE' : 'NEGATIVE'}"><Features>`);
      for (const pr of run) {
        if (pr.kind === 'stroke') features.push(`            <Polyline><PolyBegin x="${f6(pr.pts[0].x)}" y="${f6(pr.pts[0].y)}"/>${pr.pts.slice(1).map((q) => `<PolyStepSegment x="${f6(q.x)}" y="${f6(q.y)}"/>`).join('')}<LineDescRef id="${lineId(apWidth(pr.ap))}"/></Polyline>`);
        else if (pr.kind === 'flash') features.push(`            <Pad><Location x="${f6(pr.at.x)}" y="${f6(pr.at.y)}"/><StandardPrimitiveRef id="${apId(pr.ap)}"/></Pad>`);
        else features.push(`            <Contour><Polygon><PolyBegin x="${f6(pr.pts[0].x)}" y="${f6(pr.pts[0].y)}"/>${pr.pts.slice(1).map((q) => `<PolyStepSegment x="${f6(q.x)}" y="${f6(q.y)}"/>`).join('')}<PolyStepSegment x="${f6(pr.pts[0].x)}" y="${f6(pr.pts[0].y)}"/></Polygon></Contour>`);
      }
      features.push('          </Features></Set>'); run = [];
    };
    for (const pr of l.prims) { if (pol !== null && pr.dark !== pol) flush(); pol = pr.dark; run.push(pr); }
    flush();
    features.push('        </LayerFeature>');
  }
  // drills
  const holes = drillHoles(p);
  features.push(`        <LayerFeature layerRef="DRILL"><Set polarity="POSITIVE"><Features>`);
  for (const h of holes) features.push(`          <Hole name="H" diameter="${f6(h.d)}" platingStatus="${h.plated ? 'PLATED' : 'NONPLATED'}" plusTol="0" minusTol="0" x="${f6(h.x)}" y="${f6(h.y)}"/>`);
  features.push('        </Features></Set></LayerFeature>');
  const usedFp = [...new Set(p.components.map((c) => c.footprint))];
  const packages = usedFp.map((name) => { const fp = lib[name]; if (!fp) return ''; const hw = fp.body.w / 2, hh = fp.body.h / 2; return `        <Package name="${esc(name)}" type="OTHER" height="${f6(fp.height ?? 1)}"><Outline><Polygon><PolyBegin x="${f6(-hw)}" y="${f6(-hh)}"/><PolyStepSegment x="${f6(hw)}" y="${f6(-hh)}"/><PolyStepSegment x="${f6(hw)}" y="${f6(hh)}"/><PolyStepSegment x="${f6(-hw)}" y="${f6(hh)}"/><PolyStepSegment x="${f6(-hw)}" y="${f6(-hh)}"/></Polygon><LineDescRef id="${lineId(0.1)}"/></Outline>${fp.pads.map((pd) => `<Pin number="${esc(pd.id)}" type="${pd.th ? 'THRU' : 'SURFACE'}"><Location x="${f6(pd.x)}" y="${f6(pd.y)}"/><StandardPrimitiveRef id="${apId(pd.shape === 'circle' ? { shape: 'C', w: pd.w, h: pd.w } : { shape: 'R', w: pd.w, h: pd.h })}"/></Pin>`).join('')}</Package>`; }).filter(Boolean);
  const comps = p.components.map((c) => `        <Component refDes="${esc(c.ref)}" packageRef="${esc(c.footprint)}" layerRef="${lref(c.side === 'front' ? p.layers[0].name : p.layers[p.layers.length - 1].name)}" part="${esc(c.value || c.footprint)}" mountType="${(lib[c.footprint]?.pads ?? []).some((pd) => pd.th) ? 'THMT' : 'SMT'}"><Xform rotation="${f6(c.rot)}"${c.side === 'back' ? ' mirror="true"' : ''}/><Location x="${f6(c.x)}" y="${f6(c.y)}"/></Component>`);
  const nets = p.nets.map((n) => `        <LogicalNet name="${esc(n.name)}">${n.pins.map((k) => { const i = k.lastIndexOf('-'); return `<PinRef componentRef="${esc(k.slice(0, i))}" pin="${esc(k.slice(i + 1))}"/>`; }).join('')}</LogicalNet>`);
  const stack = p.layers.map((l) => `          <StackupLayer layerOrGroupRef="${lref(l.name)}" thickness="${f6(copperOf(p, l.name))}" sequence="${p.layers.indexOf(l) + 1}"/>`);
  // BOM
  const groups = new Map<string, string[]>(); for (const c of p.components) { const k = `${c.value}|${c.footprint}`; (groups.get(k) ?? groups.set(k, []).get(k)!).push(c.ref); }
  const bom = [...groups].map(([k, refs]) => { const [value, fp] = k.split('|'); return `    <BomItem OEMDesignNumberRef="${esc(value || fp)}" quantity="${refs.length}" category="ELECTRICAL">${refs.map((r) => `<RefDes name="${esc(r)}" packageRef="${esc(fp)}" populate="true" layerRef="${lref(p.layers[0].name)}"/>`).join('')}<Characteristics category="ELECTRICAL"/></BomItem>`; });
  const dict = [...apIds].map(([k, id]) => { const m = /^(CIRCLE|RECT)_([\d.]+)(?:x([\d.]+))?$/.exec(k)!; return m[1] === 'CIRCLE' ? `      <EntryStandard id="${id}"><Circle diameter="${m[2]}"/></EntryStandard>` : `      <EntryStandard id="${id}"><RectCenter width="${m[2]}" height="${m[3]}"/></EntryStandard>`; });
  const ldict = [...lineIds].map(([id, w]) => `      <EntryLineDesc id="${id}"><LineDesc lineEnd="ROUND" lineWidth="${w}"/></EntryLineDesc>`);
  const layers = [...art.filter((l) => l.kind !== 'outline').map((l) => `        <Layer name="${lref(l.name)}" layerFunction="${fn(l)}" side="${sideOf(l)}" polarity="POSITIVE"/>`), '        <Layer name="DRILL" layerFunction="DRILL" side="ALL" polarity="POSITIVE"/>'];
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<IPC-2581 revision="C" xmlns="http://webstds.ipc.org/2581">',
    '  <Content roleRef="Owner">',
    '    <FunctionMode mode="FABRICATION"/>',
    '    <StepRef name="pcb"/>',
    ...art.filter((l) => l.kind !== 'outline').map((l) => `    <LayerRef name="${lref(l.name)}"/>`), '    <LayerRef name="DRILL"/>',
    '    <BomRef name="bom"/>',
    '    <DictionaryStandard units="MILLIMETER">', ...dict, '    </DictionaryStandard>',
    '    <DictionaryLineDesc units="MILLIMETER">', ...ldict, '    </DictionaryLineDesc>',
    '  </Content>',
    `  <LogisticHeader><Role id="Owner" roleFunction="SENDER"/><Enterprise id="OpenBoard" code="NONE"/><Person name="OpenBoard" enterpriseRef="OpenBoard" roleRef="Owner"/></LogisticHeader>`,
    `  <HistoryRecord number="1" origination="${new Date().toISOString().slice(0, 19)}" software="OpenBoard" lastChange="${new Date().toISOString().slice(0, 19)}"/>`,
    `  <Bom name="bom"><BomHeader assembly="pcb" revision="1"><StepRef name="pcb"/></BomHeader>`, ...bom, '  </Bom>',
    `  <Ecad name="${esc(p.name)}">`,
    '    <CadHeader units="MILLIMETER"/>',
    '    <CadData>', ...layers,
    `        <Stackup name="stackup" overallThickness="${f6(p.rules.viaLength)}" whereMeasured="METAL"><StackupGroup name="group" thickness="${f6(p.rules.viaLength)}">`, ...stack, '        </StackupGroup></Stackup>',
    '      <Step name="pcb">',
    `        <Datum x="0" y="0"/>`,
    `        <Profile><Polygon><PolyBegin x="${f6(p.outline[0].x)}" y="${f6(p.outline[0].y)}"/>${[...p.outline.slice(1), p.outline[0]].map((q) => `<PolyStepSegment x="${f6(q.x)}" y="${f6(q.y)}"/>`).join('')}</Polygon></Profile>`,
    ...packages, ...comps, ...nets, ...features,
    '      </Step>',
    '    </CadData>',
    '  </Ecad>',
    '</IPC-2581>', '',
  ].join('\n');
}

void padToBoard; void heightOf;
