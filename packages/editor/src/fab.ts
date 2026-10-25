/**
 * Fabrication outputs — the OpenBoard counterpart of Allegro's artwork (Gerber) and NC drill export.
 *
 *   Copper     <name>-<layer>.gbr       one per stack layer: pours (with clearances and thermal reliefs),
 *                                       traces, pads, vias (blind/buried vias only on the layers they span)
 *   Mask       <name>-F_Mask.gbr / B    pad openings grown by rules.maskExpansion; vias are tented
 *   Paste      <name>-F_Paste.gbr / B   SMD pads
 *   Silkscreen <name>-F_Silkscreen.gbr  footprint outlines (not imported reference graphics) and reference designators
 *   Outline    <name>-Edge_Cuts.gbr
 *   Drill      <name>-PTH.drl           through vias and through-hole pads (plated)
 *              <name>-<from>-<to>.drl   one per blind/buried via span (laser or controlled-depth), as HDI fabs expect
 *
 * Gerber is RS-274X with X2 file attributes (%TF.FileFunction …%), 4.6 mm format; Excellon is metric, decimal.
 * Pours are written as dark regions followed by clear-polarity (LPC) shapes for the clearances, so no polygon
 * boolean library is needed: the fab's CAM resolves the polarity layers exactly.
 */
import { type Project, type Pt, type Component, type Pad, padToBoard, padLayers, padAngle, viaLayers, layerIndexOf } from './model.js';
import { defaultLibrary } from './footprints.js';
import { strokeText } from './font.js';
import { fabDrawingStrokes, thievingDots, backdrillFiles, applyVariant } from './fabdoc.js';
import { flexFiles } from './flex.js';

export interface FabFile { name: string; content: string }

/* ---------------- plotters: Gerber writer and primitive recorder ---------------- */

/** What the layer generators draw with: Gerber writes RS-274X, the recorder keeps primitives for other formats. */
export interface Plotter {
  circle(dia: number): number;
  rect(w: number, h: number): number;
  polarity(dark: boolean): void;
  flash(d: number, p: Pt): void;
  stroke(d: number, pts: Pt[]): void;
  region(pts: Pt[]): void;
  toString(): string;
}

/** An aperture: a circle (w = diameter) or a rectangle. */
export interface Aperture { shape: 'C' | 'R'; w: number; h: number }
/** One drawn primitive, in drawing order; `dark` false = clear polarity (removes what was drawn before). */
export type Prim =
  | { kind: 'flash'; dark: boolean; ap: Aperture; at: Pt }
  | { kind: 'stroke'; dark: boolean; ap: Aperture; pts: Pt[] }
  | { kind: 'region'; dark: boolean; pts: Pt[] };

export class Recorder implements Plotter {
  prims: Prim[] = [];
  private aps: Aperture[] = [];
  private dark = true;
  constructor(readonly attrs: string[] = []) {}
  circle(dia: number): number { this.aps.push({ shape: 'C', w: Math.max(0.001, dia), h: Math.max(0.001, dia) }); return this.aps.length - 1; }
  rect(w: number, h: number): number { this.aps.push({ shape: 'R', w: Math.max(0.001, w), h: Math.max(0.001, h) }); return this.aps.length - 1; }
  polarity(dark: boolean): void { this.dark = dark; }
  flash(d: number, p: Pt): void { this.prims.push({ kind: 'flash', dark: this.dark, ap: this.aps[d], at: { ...p } }); }
  stroke(d: number, pts: Pt[]): void { if (pts.length === 1) return this.flash(d, pts[0]); if (pts.length >= 2) this.prims.push({ kind: 'stroke', dark: this.dark, ap: this.aps[d], pts: pts.map((q) => ({ ...q })) }); }
  region(pts: Pt[]): void { if (pts.length >= 3) this.prims.push({ kind: 'region', dark: this.dark, pts: pts.map((q) => ({ ...q })) }); }
  toString(): string { return ''; }
}

/** Factory the layer generators use; artworkOf swaps it for a recorder. */
let makePlotter: (attrs: string[]) => Plotter = (attrs) => new Gerber(attrs);

class Gerber implements Plotter {
  private body: string[] = [];
  private aps = new Map<string, number>();
  private cur = -1;
  private dark = true;
  constructor(private attrs: string[]) {}
  private n(v: number): string { return String(Math.round(v * 1e6)); }
  ap(def: string): number { let d = this.aps.get(def); if (d === undefined) { d = 10 + this.aps.size; this.aps.set(def, d); } return d; }
  circle(dia: number): number { return this.ap(`C,${Math.max(0.001, dia).toFixed(6)}`); }
  rect(w: number, h: number): number { return this.ap(`R,${Math.max(0.001, w).toFixed(6)}X${Math.max(0.001, h).toFixed(6)}`); }
  private use(d: number): void { if (d !== this.cur) { this.body.push(`D${d}*`); this.cur = d; } }
  polarity(dark: boolean): void { if (dark !== this.dark) { this.body.push(dark ? '%LPD*%' : '%LPC*%'); this.dark = dark; } }
  flash(d: number, p: Pt): void { this.use(d); this.body.push(`X${this.n(p.x)}Y${this.n(p.y)}D03*`); }
  stroke(d: number, pts: Pt[]): void {
    if (pts.length < 2) { if (pts.length === 1) this.flash(d, pts[0]); return; }
    this.use(d); this.body.push('G01*');
    this.body.push(`X${this.n(pts[0].x)}Y${this.n(pts[0].y)}D02*`);
    for (let i = 1; i < pts.length; i++) this.body.push(`X${this.n(pts[i].x)}Y${this.n(pts[i].y)}D01*`);
  }
  region(pts: Pt[]): void {
    if (pts.length < 3) return;
    this.body.push('G36*', 'G01*', `X${this.n(pts[0].x)}Y${this.n(pts[0].y)}D02*`);
    for (let i = 1; i < pts.length; i++) this.body.push(`X${this.n(pts[i].x)}Y${this.n(pts[i].y)}D01*`);
    this.body.push(`X${this.n(pts[0].x)}Y${this.n(pts[0].y)}D01*`, 'G37*');
  }
  toString(): string {
    const head = ['G04 OpenBoard fabrication output*', ...this.attrs.map((a) => `%TF.${a}*%`), '%FSLAX46Y46*%', '%MOMM*%', '%LPD*%'];
    for (const [def, d] of this.aps) head.push(`%ADD${d}${def}*%`);
    return [...head, ...this.body, 'M02*', ''].join('\n');
  }
}

/* ---------------- geometry helpers ---------------- */

interface PadInst { c: Component; pad: Pad; ctr: Pt; rot: number; layers: string[]; net: string }

function padInstancesOf(p: Project): PadInst[] {
  const lib = { ...defaultLibrary(), ...p.footprints };
  const netOf = new Map<string, string>();
  for (const n of p.nets) for (const pin of n.pins) netOf.set(pin, n.name);
  const out: PadInst[] = [];
  for (const c of p.components) {
    const fp = lib[c.footprint]; if (!fp) continue;
    for (const pad of fp.pads) out.push({ c, pad, ctr: padToBoard(c, pad), rot: padAngle(c, pad), layers: padLayers(p, c, pad), net: netOf.get(`${c.ref}-${pad.id}`) ?? '' });
  }
  return out;
}

/** Draw a pad grown by `grow` on each side: circle flash, axis-aligned rect flash, rotated rect region, oval stroke. */
function drawPad(g: Plotter, pi: PadInst, grow: number): void {
  const w = pi.pad.w + 2 * grow, h = pi.pad.h + 2 * grow;
  const a = (((pi.rot % 360) + 360) % 360) * Math.PI / 180;
  const cs = Math.cos(a), sn = Math.sin(a);
  if (pi.pad.shape === 'circle') { g.flash(g.circle(Math.max(w, h)), pi.ctr); return; }
  if (pi.pad.shape === 'oval') {
    const d = Math.min(w, h), half = (Math.max(w, h) - d) / 2;
    const ux = w >= h ? cs : -sn, uy = w >= h ? sn : cs;
    g.stroke(g.circle(d), [{ x: pi.ctr.x - ux * half, y: pi.ctr.y - uy * half }, { x: pi.ctr.x + ux * half, y: pi.ctr.y + uy * half }]);
    return;
  }
  const quarter = Math.abs(Math.round(pi.rot / 90) * 90 - pi.rot) < 1e-6;
  if (quarter) { const swap = Math.round(pi.rot / 90) % 2 !== 0; g.flash(swap ? g.rect(h, w) : g.rect(w, h), pi.ctr); return; }
  const corners = [[-w / 2, -h / 2], [w / 2, -h / 2], [w / 2, h / 2], [-w / 2, h / 2]].map(([x, y]) => ({ x: pi.ctr.x + x * cs - y * sn, y: pi.ctr.y + x * sn + y * cs }));
  g.region(corners);
}

function bboxOf(pts: Pt[]): { x0: number; y0: number; x1: number; y1: number } {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const q of pts) { x0 = Math.min(x0, q.x); y0 = Math.min(y0, q.y); x1 = Math.max(x1, q.x); y1 = Math.max(y1, q.y); }
  return { x0, y0, x1, y1 };
}
const near = (b: ReturnType<typeof bboxOf>, q: Pt, m: number) => q.x >= b.x0 - m && q.x <= b.x1 + m && q.y >= b.y0 - m && q.y <= b.y1 + m;
const fileLayer = (name: string) => name.replace(/[.\s]/g, '_');
function distToPolygon(q: Pt, poly: Pt[]): number {
  let best = Infinity;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length], dx = b.x - a.x, dy = b.y - a.y, l2 = dx * dx + dy * dy;
    let tt = l2 ? ((q.x - a.x) * dx + (q.y - a.y) * dy) / l2 : 0; tt = Math.max(0, Math.min(1, tt));
    best = Math.min(best, Math.hypot(q.x - a.x - dx * tt, q.y - a.y - dy * tt));
  }
  return best;
}
function insidePolygon(q: Pt, poly: Pt[]): boolean {
  let ins = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) { const a = poly[i], b = poly[j]; if ((a.y > q.y) !== (b.y > q.y) && q.x < ((b.x - a.x) * (q.y - a.y)) / (b.y - a.y) + a.x) ins = !ins; }
  return ins;
}

/* ---------------- per-layer outputs ---------------- */

function copperLayer(p: Project, layer: string, pads: PadInst[]): string {
  const idx = layerIndexOf(p, layer), last = p.layers.length - 1;
  const pos = idx === 0 ? 'Top' : idx === last ? 'Bot' : 'Inr';
  const g = makePlotter([`GenerationSoftware,OpenBoard,OpenBoard,0.1`, `FileFunction,Copper,L${idx + 1},${pos}`, `FilePolarity,Positive`]);
  const R = p.rules;
  const traces = p.traces.filter((t) => t.layer === layer);
  const vias = p.vias.filter((v) => viaLayers(p, v).includes(layer));
  const lpads = pads.filter((pi) => pi.layers.includes(layer));
  // 1. pours: dark region, then clear-polarity clearances; same-net pads get thermal reliefs
  const spokes: { pi: PadInst; reach: number; width: number; zone: Pt[] }[] = [];
  const clears: (() => void)[] = [];   // other-net clearances, replayed after the spokes so a spoke never bridges into one
  // several pours on one layer (split planes): the earlier pour in the list has priority. Pours are drawn from the
  // lowest priority up; each one first clears a clearance-wide band around its own outline (cutting back the
  // lower-priority pours of other nets drawn before it), and clears other-net copper only near itself.
  const onLayer = p.zones.filter((zz) => zz.layer === layer && zz.points.length >= 3);
  for (const z of onLayer.slice().reverse()) {
    const c = Math.max(z.clearance, R.clearance);
    if (onLayer.some((o) => o !== z && o.net !== z.net)) { g.polarity(false); g.stroke(g.circle(2 * c), [...z.points, z.points[0]]); }
    g.polarity(true); g.region(z.points);
    if (!z.dynamic) continue;   // static pours are fixed copper: written as drawn
    const bb = bboxOf(z.points);
    const reach = (q: Pt, r: number) => near(bb, q, r + c) && (insidePolygon(q, z.points) || distToPolygon(q, z.points) <= r + c);
    g.polarity(false);
    for (const pi of lpads) {
      if (!reach(pi.ctr, Math.max(pi.pad.w, pi.pad.h))) continue;
      drawPad(g, pi, c);   // other nets: clearance; same net: thermal gap (spokes restore the connection)
      if (pi.net && pi.net === z.net) spokes.push({ pi, reach: Math.max(pi.pad.w, pi.pad.h) / 2 + c + 0.05, width: Math.max(R.width, Math.min(pi.pad.w, pi.pad.h) * 0.4, 0.2), zone: z.points });
      else clears.push(() => drawPad(g, pi, c));
    }
    for (const t of traces) if (t.net !== z.net && t.points.some((q, i) => reach(q, t.width) || (i > 0 && reach({ x: (q.x + t.points[i - 1].x) / 2, y: (q.y + t.points[i - 1].y) / 2 }, t.width + Math.hypot(q.x - t.points[i - 1].x, q.y - t.points[i - 1].y) / 2)))) { const draw = () => g.stroke(g.circle(t.width + 2 * c), t.points); draw(); clears.push(draw); }
    for (const v of vias) if (v.net !== z.net && reach(v, v.diameter)) { const draw = () => g.flash(g.circle(v.diameter + 2 * c), v); draw(); clears.push(draw); }
    // keep the pour back from the board edge
    if (p.outline.length >= 3) { const draw = () => g.stroke(g.circle(2 * R.edgeClearance), [...p.outline, p.outline[0]]); draw(); clears.push(draw); }
  }
  // 2. thermal spokes (two crossing bars per same-net pad, in the pad's own frame), then re-cut other-net clearances
  if (spokes.length) {
    g.polarity(true);
    for (const { pi, reach, width, zone } of spokes) {
      const a = pi.rot * Math.PI / 180, cs = Math.cos(a), sn = Math.sin(a), d = g.circle(width);
      // four half-spokes; one whose end would leave the pour polygon is not drawn (no copper stubs outside the pour)
      for (const [ux, uy] of [[cs, sn], [-cs, -sn], [-sn, cs], [sn, -cs]]) {
        const end = { x: pi.ctr.x + ux * (reach + width / 2), y: pi.ctr.y + uy * (reach + width / 2) };
        if (!insidePolygon(end, zone)) continue;
        g.stroke(d, [pi.ctr, { x: pi.ctr.x + ux * reach, y: pi.ctr.y + uy * reach }]);
      }
    }
    g.polarity(false);
    for (const draw of clears) draw();
  }
  // ground voids (RF): pour copper removed inside them (drawn before the copper objects, which stay)
  const voidsHere = (p.voids ?? []).filter((v) => v.layer === layer && v.points.length >= 3);
  if (voidsHere.length && onLayer.some((z) => z.dynamic)) { g.polarity(false); for (const v of voidsHere) g.region(v.points); g.polarity(true); for (const z of onLayer) if (!z.dynamic) g.region(z.points); }
  g.polarity(true);
  // copper thieving on the outer layers (no net), clear of all copper
  if (p.rules.thieving && (idx === 0 || idx === last)) { const ap = g.circle(p.rules.thieving.size); for (const q of thievingDots(p, layer, p.rules.thieving)) g.flash(ap, q); }
  // 3. copper objects
  for (const t of traces) g.stroke(g.circle(t.width), t.points);
  for (const pi of lpads) drawPad(g, pi, 0);
  for (const v of vias) g.flash(g.circle(v.diameter), v);
  return g.toString();
}

function maskLayer(p: Project, side: 'front' | 'back', pads: PadInst[]): string {
  const layer = side === 'front' ? p.layers[0].name : p.layers[p.layers.length - 1].name;
  const g = makePlotter([`GenerationSoftware,OpenBoard,OpenBoard,0.1`, `FileFunction,Soldermask,${side === 'front' ? 'Top' : 'Bot'}`, `FilePolarity,Negative`]);
  for (const pi of pads) if (pi.layers.includes(layer)) drawPad(g, pi, p.rules.maskExpansion);
  for (const pi of pads) if (pi.pad.npth) g.flash(g.circle((pi.pad.drill ?? pi.pad.w) + 2 * p.rules.maskExpansion), pi.ctr);   // non-plated holes are opened
  return g.toString();
}

function pasteLayer(p: Project, side: 'front' | 'back', pads: PadInst[]): string {
  const layer = side === 'front' ? p.layers[0].name : p.layers[p.layers.length - 1].name;
  const g = makePlotter([`GenerationSoftware,OpenBoard,OpenBoard,0.1`, `FileFunction,Paste,${side === 'front' ? 'Top' : 'Bot'}`, `FilePolarity,Positive`]);
  for (const pi of pads) if (!pi.pad.th && pi.layers.includes(layer)) drawPad(g, pi, 0);
  return g.toString();
}

function silkLayer(p: Project, side: 'front' | 'back'): string {
  const lib = { ...defaultLibrary(), ...p.footprints };
  const g = makePlotter([`GenerationSoftware,OpenBoard,OpenBoard,0.1`, `FileFunction,Legend,${side === 'front' ? 'Top' : 'Bot'}`, `FilePolarity,Positive`]);
  const d = g.circle(p.rules.silkWidth);
  for (const c of p.components) {
    if (c.side !== side) continue;
    const fp = lib[c.footprint]; if (!fp) continue;
    if (fp.outlineKind !== 'reference') for (const pl of fp.outline) g.stroke(d, pl.map((q) => padToBoard(c, q)));
    // reference designator: 1 mm high, centred on the part; mirrored on the bottom (Gerber is viewed from the top)
    const h = Math.min(1.0, Math.max(0.6, Math.min(fp.body.w, fp.body.h) * 0.45));
    for (const stroke of strokeText(c.ref, { x: c.x, y: c.y }, h, side === 'back')) g.stroke(d, stroke);
  }
  // free text on this side's silkscreen
  const silk = side === 'front' ? 'F.Silk' : 'B.Silk';
  for (const tx of p.texts ?? []) if (tx.layer === silk) for (const stroke of textStrokes(tx, side === 'back')) g.stroke(g.circle(Math.max(p.rules.silkWidth, tx.size * 0.12)), stroke);
  // clip the legend at exposed copper and drill holes (Allegro auto-silkscreen): pads of this side opened by the
  // mask plus silkToCopper, and every drill hole plus silkToCopper
  const layer = side === 'front' ? p.layers[0].name : p.layers[p.layers.length - 1].name;
  g.polarity(false);
  for (const pi of padInstancesOf(p)) if (pi.layers.includes(layer)) drawPad(g, pi, p.rules.maskExpansion + p.rules.silkToCopper);
  for (const v of p.vias) g.flash(g.circle(v.drill + 2 * p.rules.silkToCopper), v);
  g.polarity(true);
  return g.toString();
}

/** Strokes of a text item (rotation about its anchor; mirrored for the bottom side). */
export function textStrokes(tx: { text: string; x: number; y: number; size: number; rot: number }, mirror = false): Pt[][] {
  const a = (tx.rot * Math.PI) / 180, cs = Math.cos(a), sn = Math.sin(a);
  return strokeText(tx.text, { x: 0, y: 0 }, tx.size, mirror).map((s) => s.map((q) => ({ x: tx.x + q.x * cs - q.y * sn, y: tx.y + q.x * sn + q.y * cs })));
}

/** Documentation layer (Gerber): board outline, dimensions and notes/text on the Fab layer, for the fab drawing. */
function drawingLayer(p: Project): string {
  const g = makePlotter([`GenerationSoftware,OpenBoard,OpenBoard,0.1`, `FileFunction,Drawing`, `FilePolarity,Positive`]);
  const d = g.circle(0.15);
  g.stroke(d, [...p.outline, p.outline[0]]);
  for (const dm of p.dimensions ?? []) for (const s of dimensionStrokes(dm)) g.stroke(d, s);
  for (const tx of p.texts ?? []) if (tx.layer === 'Fab' || tx.layer === 'F.Fab') for (const s of textStrokes(tx)) g.stroke(d, s);
  // fab drawing: drill symbols, drill chart, cross-section chart, notes
  for (const s of fabDrawingStrokes(p)) g.stroke(d, s);
  return g.toString();
}

/** Polylines of a linear dimension: extension lines, the dimension line with arrows, and the value text. */
export function dimensionStrokes(dm: { a: Pt; b: Pt; offset: number }): Pt[][] {
  const dx = dm.b.x - dm.a.x, dy = dm.b.y - dm.a.y, L = Math.hypot(dx, dy); if (L < 1e-9) return [];
  const u = { x: dx / L, y: dy / L }, n = { x: -u.y, y: u.x };
  const o = dm.offset, A = { x: dm.a.x + n.x * o, y: dm.a.y + n.y * o }, B = { x: dm.b.x + n.x * o, y: dm.b.y + n.y * o };
  const ext = (q: Pt, Q: Pt) => [{ x: q.x + n.x * Math.sign(o) * 0.3, y: q.y + n.y * Math.sign(o) * 0.3 }, { x: Q.x + n.x * Math.sign(o) * 0.8, y: Q.y + n.y * Math.sign(o) * 0.8 }];
  const ah = Math.min(0.8, L / 4), aw = ah * 0.4;
  const arrow = (tip: Pt, dir: Pt) => [{ x: tip.x + dir.x * ah + n.x * aw, y: tip.y + dir.y * ah + n.y * aw }, tip, { x: tip.x + dir.x * ah - n.x * aw, y: tip.y + dir.y * ah - n.y * aw }];
  const label = `${L.toFixed(2)}`;
  const mid = { x: (A.x + B.x) / 2 + n.x * Math.sign(o || 1) * 0.6, y: (A.y + B.y) / 2 + n.y * Math.sign(o || 1) * 0.6 };
  const ang = (Math.atan2(u.y, u.x) * 180) / Math.PI;
  const rot = ang > 90 || ang < -90 ? ang + 180 : ang;
  return [ext(dm.a, A), ext(dm.b, B), [A, B], arrow(A, u), arrow(B, { x: -u.x, y: -u.y }), ...textStrokes({ text: label, x: mid.x, y: mid.y, size: 1, rot })];
}

function outlineLayer(p: Project): string {
  const g = makePlotter([`GenerationSoftware,OpenBoard,OpenBoard,0.1`, `FileFunction,Profile,NP`, `FilePolarity,Positive`]);
  if (p.outline.length >= 3) g.stroke(g.circle(0.1), [...p.outline, p.outline[0]]);
  for (const c of p.cutouts ?? []) if (c.length >= 2) g.stroke(g.circle(0.1), c);
  return g.toString();
}

/* ---------------- Excellon drill ---------------- */

function drillFile(holes: { x: number; y: number; d: number }[], fileFunction: string): string {
  const tools = [...new Set(holes.map((h) => h.d.toFixed(3)))].sort((a, b) => Number(a) - Number(b));
  const out = ['M48', '; DRILL file OpenBoard 0.1', `; #@! TF.FileFunction,${fileFunction}`, '; FORMAT={-:-/ absolute / metric / decimal}', 'FMAT,2', 'METRIC'];
  tools.forEach((t, i) => out.push(`T${i + 1}C${t}`));
  out.push('%', 'G90', 'G05');
  tools.forEach((t, i) => {
    out.push(`T${i + 1}`);
    for (const h of holes) if (h.d.toFixed(3) === t) out.push(`X${h.x.toFixed(3)}Y${h.y.toFixed(3)}`);
  });
  out.push('M30', '');
  return out.join('\n');
}

/* ---------------- entry point ---------------- */

export function exportFabrication(p: Project, opts: { name?: string } = {}): FabFile[] {
  const name = (opts.name ?? p.name ?? 'board').replace(/[^\w.-]+/g, '_');
  const pads = padInstancesOf(p);
  const files: FabFile[] = [];
  for (const l of p.layers) files.push({ name: `${name}-${fileLayer(l.name)}.gbr`, content: copperLayer(p, l.name, pads) });
  files.push({ name: `${name}-F_Mask.gbr`, content: maskLayer(p, 'front', pads) });
  files.push({ name: `${name}-B_Mask.gbr`, content: maskLayer(p, 'back', pads) });
  files.push({ name: `${name}-F_Paste.gbr`, content: pasteLayer(p, 'front', pads) });
  files.push({ name: `${name}-B_Paste.gbr`, content: pasteLayer(p, 'back', pads) });
  files.push({ name: `${name}-F_Silkscreen.gbr`, content: silkLayer(p, 'front') });
  files.push({ name: `${name}-B_Silkscreen.gbr`, content: silkLayer(p, 'back') });
  files.push({ name: `${name}-Edge_Cuts.gbr`, content: outlineLayer(p) });
  files.push({ name: `${name}-Drawing.gbr`, content: drawingLayer(p) });
  // drills: through holes in one file, every blind/buried span in its own file
  const last = p.layers.length;
  const pth: { x: number; y: number; d: number }[] = [];
  const npth: { x: number; y: number; d: number }[] = [];
  const spans = new Map<string, { from: string; to: string; holes: { x: number; y: number; d: number }[] }>();
  for (const pi of pads) if (pi.pad.th) (pi.pad.npth ? npth : pth).push({ x: pi.ctr.x, y: pi.ctr.y, d: pi.pad.drill ?? Math.min(pi.pad.w, pi.pad.h) / 2 });
  for (const v of p.vias) {
    const ls = viaLayers(p, v);
    if (ls.length === p.layers.length) { pth.push({ x: v.x, y: v.y, d: v.drill }); continue; }
    const key = `${ls[0]}|${ls[ls.length - 1]}`;
    const s = spans.get(key) ?? { from: ls[0], to: ls[ls.length - 1], holes: [] };
    s.holes.push({ x: v.x, y: v.y, d: v.drill }); spans.set(key, s);
  }
  files.push({ name: `${name}-PTH.drl`, content: drillFile(pth, `Plated,1,${last},PTH`) });
  if (npth.length) files.push({ name: `${name}-NPTH.drl`, content: drillFile(npth, `NonPlated,1,${last},NPTH`) });
  if ((p.backdrill ?? []).length) files.push(...backdrillFiles(p, name).files);
  if ((p.flexZones ?? []).length) files.push(...flexFiles(p, name, makePlotter));
  for (const s of spans.values()) {
    const a = layerIndexOf(p, s.from) + 1, b = layerIndexOf(p, s.to) + 1;
    const kind = a === 1 || b === last ? 'Blind' : 'Buried';
    files.push({ name: `${name}-${fileLayer(s.from)}-${fileLayer(s.to)}.drl`, content: drillFile(s.holes, `Plated,${a},${b},${kind}`) });
  }
  return files;
}

/* ---------------- store-only ZIP (for fab upload) ---------------- */

const CRC_TABLE = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
function crc32(b: Uint8Array): number { let c = 0xffffffff; for (let i = 0; i < b.length; i++) c = CRC_TABLE[(c ^ b[i]) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }

export function zipFiles(files: FabFile[]): Uint8Array {
  const enc = new TextEncoder();
  const parts: Uint8Array[] = []; const central: Uint8Array[] = [];
  let offset = 0;
  for (const f of files) {
    const nameB = enc.encode(f.name), data = enc.encode(f.content), crc = crc32(data);
    const lh = new DataView(new ArrayBuffer(30));
    lh.setUint32(0, 0x04034b50, true); lh.setUint16(4, 20, true); lh.setUint16(8, 0, true);
    lh.setUint32(14, crc, true); lh.setUint32(18, data.length, true); lh.setUint32(22, data.length, true); lh.setUint16(26, nameB.length, true);
    parts.push(new Uint8Array(lh.buffer), nameB, data);
    const ch = new DataView(new ArrayBuffer(46));
    ch.setUint32(0, 0x02014b50, true); ch.setUint16(4, 20, true); ch.setUint16(6, 20, true);
    ch.setUint32(16, crc, true); ch.setUint32(20, data.length, true); ch.setUint32(24, data.length, true); ch.setUint16(28, nameB.length, true); ch.setUint32(42, offset, true);
    central.push(new Uint8Array(ch.buffer), nameB);
    offset += 30 + nameB.length + data.length;
  }
  const cdSize = central.reduce((s, b) => s + b.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true); end.setUint16(8, files.length, true); end.setUint16(10, files.length, true); end.setUint32(12, cdSize, true); end.setUint32(16, offset, true);
  const all = [...parts, ...central, new Uint8Array(end.buffer)];
  const out = new Uint8Array(all.reduce((s, b) => s + b.length, 0));
  let o = 0; for (const b of all) { out.set(b, o); o += b.length; }
  return out;
}

/* ---------------- assembly: BOM + pick-and-place (JLCPCB format) ---------------- */

const natural = (a: string, b: string) => a.localeCompare(b, undefined, { numeric: true });
const csv = (s: string) => (/[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
/** Mechanical parts the assembler does not place. */
const isMechanical = (fp: string) => /mountinghole|^hole_|fiducial|^testpoint_/i.test(fp.replace(/^.*:/, ''));

export function exportAssembly(p: Project, opts: { name?: string; variant?: string } = {}): FabFile[] {
  if (opts.variant) p = applyVariant(p, opts.variant);
  const name = (opts.name ?? p.name ?? 'board').replace(/[^\w.-]+/g, '_');
  const parts = p.components.filter((c) => !isMechanical(c.footprint) && !/^dnp$/i.test(c.value ?? ''));
  const groups = new Map<string, { value: string; footprint: string; refs: string[] }>();
  for (const c of parts) {
    const fp = c.footprint.replace(/^.*:/, '');
    const key = `${c.value}\u0000${fp}`;
    const g = groups.get(key) ?? { value: c.value ?? '', footprint: fp, refs: [] };
    g.refs.push(c.ref); groups.set(key, g);
  }
  const bom = ['Comment,Designator,Footprint,JLCPCB Part #'];
  for (const g of [...groups.values()].sort((a, b) => natural(a.refs.sort(natural)[0], b.refs.sort(natural)[0]))) bom.push([csv(g.value), csv(g.refs.sort(natural).join(',')), csv(g.footprint), ''].join(','));
  const cpl = ['Designator,Mid X,Mid Y,Layer,Rotation'];
  for (const c of [...parts].sort((a, b) => natural(a.ref, b.ref))) {
    const rot = (((Math.round(c.rot * 100) / 100) % 360) + 360) % 360;
    cpl.push([csv(c.ref), `${c.x.toFixed(4)}mm`, `${c.y.toFixed(4)}mm`, c.side === 'back' ? 'Bottom' : 'Top', String(rot)].join(','));
  }
  return [{ name: `${name}-BOM.csv`, content: bom.join('\n') + '\n' }, { name: `${name}-CPL.csv`, content: cpl.join('\n') + '\n' }];
}


/* ---------------- artwork for other formats ---------------- */

export type ArtKind = 'copper' | 'mask' | 'paste' | 'silk' | 'outline' | 'drawing';
export interface ArtLayer { name: string; kind: ArtKind; side?: 'front' | 'back'; copper?: string; prims: Prim[] }

/**
 * Every fabrication layer as drawing primitives (the same geometry the Gerber files carry, including pour
 * clearances as clear-polarity primitives), for DXF, PDF, GDSII, ODB++ and IPC-2581 writers.
 */
export function artworkOf(p: Project, opts: { kinds?: ArtKind[] } = {}): ArtLayer[] {
  const want = (k: ArtKind) => !opts.kinds || opts.kinds.includes(k);
  const out: ArtLayer[] = [];
  const pads = padInstancesOf(p);
  const rec = (name: string, kind: ArtKind, fn: () => void, extra: Partial<ArtLayer> = {}) => {
    const prev = makePlotter; let r: Recorder | null = null;
    makePlotter = (a) => (r = new Recorder(a));
    try { fn(); } finally { makePlotter = prev; }
    out.push({ name, kind, prims: r ? (r as Recorder).prims : [], ...extra });
  };
  if (want('copper')) for (const l of p.layers) rec(l.name, 'copper', () => copperLayer(p, l.name, pads), { copper: l.name });
  if (want('mask')) { rec('F.Mask', 'mask', () => maskLayer(p, 'front', pads), { side: 'front' }); rec('B.Mask', 'mask', () => maskLayer(p, 'back', pads), { side: 'back' }); }
  if (want('paste')) { rec('F.Paste', 'paste', () => pasteLayer(p, 'front', pads), { side: 'front' }); rec('B.Paste', 'paste', () => pasteLayer(p, 'back', pads), { side: 'back' }); }
  if (want('silk')) { rec('F.Silk', 'silk', () => silkLayer(p, 'front'), { side: 'front' }); rec('B.Silk', 'silk', () => silkLayer(p, 'back'), { side: 'back' }); }
  if (want('outline')) rec('Edge.Cuts', 'outline', () => outlineLayer(p));
  if (want('drawing')) rec('Fab.Drawing', 'drawing', () => drawingLayer(p));
  return out;
}

/** Every drill hole: through holes (pads and vias) and blind/buried via holes with their layer span. */
export function drillHoles(p: Project): { x: number; y: number; d: number; plated: boolean; from: string; to: string; net: string }[] {
  const out: { x: number; y: number; d: number; plated: boolean; from: string; to: string; net: string }[] = [];
  const first = p.layers[0].name, last = p.layers[p.layers.length - 1].name;
  for (const pi of padInstancesOf(p)) if (pi.pad.th) out.push({ x: pi.ctr.x, y: pi.ctr.y, d: pi.pad.drill ?? Math.min(pi.pad.w, pi.pad.h) / 2, plated: !pi.pad.npth, from: first, to: last, net: pi.net });
  for (const v of p.vias) { const ls = viaLayers(p, v); out.push({ x: v.x, y: v.y, d: v.drill, plated: true, from: ls[0], to: ls[ls.length - 1], net: v.net }); }
  return out;
}

export { padInstancesOf };
