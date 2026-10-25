/**
 * Fabrication documentation and manufacturing preparation (Allegro Manufacture menu):
 *
 *   Fab drawing      drill symbols at every hole, the drill chart (symbol, size, plating, span, count), the
 *                    cross-section chart (layer, type, copper and dielectric thickness) and notes — written to the
 *                    Drawing Gerber layer next to the board.
 *   Panelization     step-and-repeat into an array with rails, separation by mouse bites (NPTH rows on tabs) or
 *                    V-score lines, tooling holes and fiducials; returns a new project.
 *   Variants         a project copy with a variant applied (DNP parts removed, values substituted) for BOM/CPL.
 *   Backdrill        through vias of listed nets get their unused stub drilled from one side; one drill file per side.
 *   Copper thieving  a dot pattern in empty areas of the outer layers (no net), keeping clear of all copper.
 *   Coupons          an impedance test coupon: a trace of a layer's width between probe pads with GND pads.
 */
import { type Project, type Pt, type Component, nextId, viaLayers, layerIndexOf, copperOf, normalizeProject } from './model.js';
import { strokeText } from './font.js';
import { drillHoles, type FabFile } from './fab.js';
import { padInstances } from './connectivity.js';
import { ViaSite } from './tools.js';

const r3 = (v: number) => Math.round(v * 1000) / 1000;

/* ============================== fab drawing ============================== */

const SYMBOLS = ['plus', 'cross', 'square', 'triangle', 'diamond', 'circle', 'hex', 'star'] as const;
function symbolStrokes(kind: typeof SYMBOLS[number], c: Pt, s: number): Pt[][] {
  const h = s / 2;
  switch (kind) {
    case 'plus': return [[{ x: c.x - h, y: c.y }, { x: c.x + h, y: c.y }], [{ x: c.x, y: c.y - h }, { x: c.x, y: c.y + h }]];
    case 'cross': return [[{ x: c.x - h, y: c.y - h }, { x: c.x + h, y: c.y + h }], [{ x: c.x - h, y: c.y + h }, { x: c.x + h, y: c.y - h }]];
    case 'square': return [[{ x: c.x - h, y: c.y - h }, { x: c.x + h, y: c.y - h }, { x: c.x + h, y: c.y + h }, { x: c.x - h, y: c.y + h }, { x: c.x - h, y: c.y - h }]];
    case 'triangle': return [[{ x: c.x - h, y: c.y - h }, { x: c.x + h, y: c.y - h }, { x: c.x, y: c.y + h }, { x: c.x - h, y: c.y - h }]];
    case 'diamond': return [[{ x: c.x, y: c.y - h }, { x: c.x + h, y: c.y }, { x: c.x, y: c.y + h }, { x: c.x - h, y: c.y }, { x: c.x, y: c.y - h }]];
    case 'circle': return [Array.from({ length: 13 }, (_, k) => ({ x: c.x + h * Math.cos((k * Math.PI) / 6), y: c.y + h * Math.sin((k * Math.PI) / 6) }))];
    case 'hex': return [Array.from({ length: 7 }, (_, k) => ({ x: c.x + h * Math.cos((k * Math.PI) / 3), y: c.y + h * Math.sin((k * Math.PI) / 3) }))];
    default: return [[{ x: c.x - h, y: c.y }, { x: c.x + h, y: c.y }], [{ x: c.x, y: c.y - h }, { x: c.x, y: c.y + h }], [{ x: c.x - h, y: c.y - h }, { x: c.x + h, y: c.y + h }], [{ x: c.x - h, y: c.y + h }, { x: c.x + h, y: c.y - h }]];
  }
}
const text = (s: string, x: number, y: number, size = 1.2) => strokeText(s, { x, y }, size).map((st) => st.map((q) => ({ x: q.x + (s.length * size * 0.38), y: q.y })));

/** The fab drawing: drill symbols on every hole, the drill chart and the cross-section chart, right of the board. */
export function fabDrawingStrokes(p: Project): Pt[][] {
  const out: Pt[][] = [];
  const xs = p.outline.map((q) => q.x), ys = p.outline.map((q) => q.y);
  const x0 = Math.max(...xs) + 10, yTop = Math.max(...ys);
  // drill chart: one row per (size, plated, span)
  const holes = drillHoles(p);
  const kinds = new Map<string, { d: number; plated: boolean; from: string; to: string; n: number; sym: typeof SYMBOLS[number] }>();
  for (const h of holes) {
    const k = `${h.d.toFixed(3)}|${h.plated}|${h.from}|${h.to}`;
    const e = kinds.get(k); if (e) e.n++; else kinds.set(k, { d: h.d, plated: h.plated, from: h.from, to: h.to, n: 1, sym: SYMBOLS[kinds.size % SYMBOLS.length] });
  }
  for (const h of holes) out.push(...symbolStrokes(kinds.get(`${h.d.toFixed(3)}|${h.plated}|${h.from}|${h.to}`)!.sym, h, Math.max(0.6, h.d * 1.4)));
  const rowH = 2.4;
  let y = yTop;
  out.push(...text('DRILL CHART', x0, y)); y -= rowH;
  out.push(...text('SYM  SIZE MM  PLATING  SPAN  QTY', x0, y, 1)); y -= rowH;
  for (const k of [...kinds.values()].sort((a, b) => a.d - b.d)) {
    out.push(...symbolStrokes(k.sym, { x: x0 + 1, y: y + 0.3 }, 1.2));
    out.push(...text(`${k.d.toFixed(3)}  ${k.plated ? 'PTH ' : 'NPTH'}  ${k.from}-${k.to}  ${k.n}`, x0 + 3, y, 1));
    y -= rowH;
  }
  out.push(...text(`TOTAL HOLES ${holes.length}`, x0, y, 1)); y -= rowH * 2;
  // cross-section chart
  out.push(...text('CROSS SECTION', x0, y)); y -= rowH;
  out.push(...text('LAYER  TYPE  CU MM  DIELECTRIC MM', x0, y, 1)); y -= rowH;
  let total = 0;
  p.layers.forEach((l, i) => {
    const cu = copperOf(p, l.name); total += cu;
    const diel = i < p.layers.length - 1 ? (l.dielectric ?? r3(((p.rules.viaLength || 1.6) - p.layers.reduce((s, q) => s + copperOf(p, q.name), 0)) / (p.layers.length - 1))) : 0;
    total += diel;
    out.push(...text(`${l.name}  ${l.type.toUpperCase()}  ${cu.toFixed(4)}  ${diel ? diel.toFixed(3) : '-'}`, x0, y, 1)); y -= rowH;
  });
  out.push(...text(`FINISHED THICKNESS ${total.toFixed(2)} MM`, x0, y, 1)); y -= rowH * 2;
  // standard notes
  for (const n of ['NOTES:', '1. MATERIAL FR4 TG170 OR BETTER.', '2. FINISH ENIG.', '3. SOLDER MASK BOTH SIDES, SILKSCREEN AS SUPPLIED.', '4. DIMENSIONS IN MM.']) { out.push(...text(n, x0, y, 1)); y -= rowH; }
  return out;
}

/* ============================== panelization ============================== */

export interface PanelOptions { nx: number; ny: number; gap?: number; rail?: number; separation?: 'mousebite' | 'vscore'; fiducials?: boolean; toolingHoles?: boolean }

/** Step-and-repeat the board into a panel; every instance gets refs/nets suffixed _<i>. */
export function panelize(p: Project, o: PanelOptions): Project {
  const gap = o.gap ?? (o.separation === 'vscore' ? 0 : 2), rail = o.rail ?? 5;
  const xs = p.outline.map((q) => q.x), ys = p.outline.map((q) => q.y);
  const bx0 = Math.min(...xs), by0 = Math.min(...ys), W = Math.max(...xs) - bx0, H = Math.max(...ys) - by0;
  const P: Project = normalizeProject(JSON.parse(JSON.stringify({ ...p, components: [], nets: [], traces: [], vias: [], zones: [], keepouts: [], texts: [], dimensions: [], rooms: [], regions: [], diffPairs: [], lengthGroups: [], tuneBackup: undefined })));
  P.name = `${p.name}_panel_${o.nx}x${o.ny}`;
  const PW = o.nx * W + (o.nx - 1) * gap + 2 * rail, PH = o.ny * H + (o.ny - 1) * gap + 2 * rail;
  P.outline = [{ x: 0, y: 0 }, { x: PW, y: 0 }, { x: PW, y: PH }, { x: 0, y: PH }];
  P.cutouts = [];
  let inst = 0;
  for (let j = 0; j < o.ny; j++) for (let i = 0; i < o.nx; i++) {
    inst++;
    const dx = rail + i * (W + gap) - bx0, dy = rail + j * (H + gap) - by0;
    const sfx = `_${inst}`;
    const mv = (q: Pt) => ({ x: r3(q.x + dx), y: r3(q.y + dy) });
    for (const c of p.components) P.components.push({ ...c, ref: c.ref + sfx, x: r3(c.x + dx), y: r3(c.y + dy) } as Component);
    for (const n of p.nets) P.nets.push({ ...n, name: n.name + sfx, pins: n.pins.map((k) => { const at = k.lastIndexOf('-'); return k.slice(0, at) + sfx + k.slice(at); }) });
    for (const t of p.traces) P.traces.push({ ...t, id: nextId(P), net: t.net ? t.net + sfx : t.net, points: t.points.map(mv) });
    for (const v of p.vias) P.vias.push({ ...v, id: nextId(P), net: v.net ? v.net + sfx : v.net, x: r3(v.x + dx), y: r3(v.y + dy) });
    for (const z of p.zones) P.zones.push({ ...z, id: nextId(P), net: z.net ? z.net + sfx : z.net, points: z.points.map(mv) });
    for (const k of p.keepouts) P.keepouts.push({ ...k, id: nextId(P), rect: { x1: k.rect.x1 + dx, y1: k.rect.y1 + dy, x2: k.rect.x2 + dx, y2: k.rect.y2 + dy } });
    for (const tx of p.texts ?? []) P.texts!.push({ ...tx, id: nextId(P), x: tx.x + dx, y: tx.y + dy });
    // the board's own outline is milled (or scored) out of the panel
    if (o.separation !== 'vscore') P.cutouts.push([...p.outline.map(mv), mv(p.outline[0])]);
  }
  // separation: mouse bites on tabs (two tabs per board edge), or V-score lines on the drawing layer
  const bitten = new Set<string>();
  const bite = (cx: number, cy: number, horiz: boolean) => { const key = `${cx.toFixed(2)},${cy.toFixed(2)}`; if (bitten.has(key)) return; bitten.add(key); for (let k = -2; k <= 2; k++) { const q = horiz ? { x: cx + k * 0.8, y: cy } : { x: cx, y: cy + k * 0.8 }; P.components.push({ ref: `MB${P.components.length}`, footprint: 'Hole_0.5mm_NPTH', value: 'mouse bite', x: r3(q.x), y: r3(q.y), rot: 0, side: 'front', locked: true }); } };
  P.footprints['Hole_0.5mm_NPTH'] = { name: 'Hole_0.5mm_NPTH', pads: [{ id: '', x: 0, y: 0, w: 0.5, h: 0.5, shape: 'circle', th: true, drill: 0.5, npth: true }], outline: [], body: { w: 0.5, h: 0.5 } };
  if (o.separation === 'vscore') {
    for (let i = 1; i < o.nx; i++) { const x = rail + i * W; (P.dimensions ??= []); P.texts!.push({ id: nextId(P), text: 'V-SCORE', x, y: PH - 1.5, size: 1, rot: 0, layer: 'Fab' }); (P.cutouts ??= []).push([{ x, y: 0 }, { x, y: PH }]); }
    for (let j = 1; j < o.ny; j++) { const y = rail + j * H; P.texts!.push({ id: nextId(P), text: 'V-SCORE', x: 3, y, size: 1, rot: 0, layer: 'Fab' }); (P.cutouts ??= []).push([{ x: 0, y }, { x: PW, y }]); }
  } else {
    for (let j = 0; j < o.ny; j++) for (let i = 0; i < o.nx; i++) {
      const x0 = rail + i * (W + gap), y0 = rail + j * (H + gap);
      for (const f of [0.25, 0.75]) { bite(x0 + W * f, y0 - gap / 2, true); bite(x0 + W * f, y0 + H + gap / 2, true); bite(x0 - gap / 2, y0 + H * f, false); bite(x0 + W + gap / 2, y0 + H * f, false); }
    }
  }
  // drop mouse-bite holes that would come too close to board copper (hole-to-copper / hole-to-hole)
  {
    const R = P.rules, segD = (q: Pt, a: Pt, b: Pt) => { const dx = b.x - a.x, dy = b.y - a.y, l2 = dx * dx + dy * dy; let tt = l2 ? ((q.x - a.x) * dx + (q.y - a.y) * dy) / l2 : 0; tt = Math.max(0, Math.min(1, tt)); return Math.hypot(q.x - a.x - dx * tt, q.y - a.y - dy * tt); };
    const copperPads = padInstances(P).filter((pd) => !pd.ref.startsWith('MB'));
    const holeR = 0.25;
    P.components = P.components.filter((c) => {
      if (!c.ref.startsWith('MB')) return true;
      const q = { x: c.x, y: c.y };
      if (P.vias.some((v) => Math.hypot(v.x - q.x, v.y - q.y) - v.diameter / 2 - holeR < R.holeToCopper || Math.hypot(v.x - q.x, v.y - q.y) - v.drill / 2 - holeR < R.holeToHole)) return false;
      if (P.traces.some((t) => t.points.some((_, i) => i > 0 && segD(q, t.points[i - 1], t.points[i]) - t.width / 2 - holeR < R.holeToCopper))) return false;
      if (copperPads.some((pd) => Math.hypot(pd.center.x - q.x, pd.center.y - q.y) - Math.max(pd.w, pd.h) / 2 - holeR < R.holeToCopper)) return false;
      return true;
    });
  }
  // tooling holes and fiducials on the rails
  if (o.toolingHoles ?? true) {
    P.footprints['Hole_3.0mm_NPTH'] = { name: 'Hole_3.0mm_NPTH', pads: [{ id: '', x: 0, y: 0, w: 3, h: 3, shape: 'circle', th: true, drill: 3, npth: true }], outline: [], body: { w: 3, h: 3 } };
    for (const [x, y] of [[rail / 2, rail / 2], [PW - rail / 2, rail / 2], [rail / 2, PH - rail / 2]]) P.components.push({ ref: `TH${P.components.length}`, footprint: 'Hole_3.0mm_NPTH', value: 'tooling', x, y, rot: 0, side: 'front', locked: true });
  }
  if (o.fiducials ?? true) {
    P.footprints['Fiducial_1mm'] = { name: 'Fiducial_1mm', pads: [{ id: '1', x: 0, y: 0, w: 1, h: 1, shape: 'circle', th: false }], outline: [], body: { w: 3, h: 3 } };
    for (const [x, y] of [[rail * 1.8, rail / 2], [PW - rail * 1.8, rail / 2], [rail * 1.8, PH - rail / 2]]) P.components.push({ ref: `FID${P.components.length}`, footprint: 'Fiducial_1mm', value: 'fiducial', x, y, rot: 0, side: 'front', locked: true });
  }
  return P;
}

/* ============================== variants ============================== */

/** A copy of the project with a variant applied: DNP parts removed, values substituted. */
export function applyVariant(p: Project, name: string): Project {
  const v = (p.variants ?? []).find((x) => x.name === name);
  if (!v) throw new Error(`no variant ${name}`);
  const q: Project = JSON.parse(JSON.stringify(p));
  const dnp = new Set(v.dnp);
  q.components = q.components.filter((c) => !dnp.has(c.ref)).map((c) => (v.values?.[c.ref] ? { ...c, value: v.values[c.ref] } : c));
  q.name = `${p.name}_${name}`;
  return q;
}

/* ============================== backdrill ============================== */

/**
 * Backdrill: for every through via of a listed net, the deepest layer its copper actually uses (traces or pads
 * touching it) from the drilled side's opposite; the stub beyond is drilled out from `side` with drill + oversize,
 * never through the `mustNotCut` layer. Returns one Excellon file per side and a report.
 */
export function backdrillFiles(p: Project, name = p.name): { files: FabFile[]; report: { net: string; x: number; y: number; side: string; to: string; stub: number }[] } {
  const report: { net: string; x: number; y: number; side: string; to: string; stub: number }[] = [];
  const bySide = new Map<string, { x: number; y: number; d: number; to: string }[]>();
  const pads = padInstances(p);
  for (const bd of p.backdrill ?? []) {
    for (const v of p.vias) {
      if (!bd.nets.includes(v.net) || viaLayers(p, v).length !== p.layers.length) continue;
      const used = new Set<number>();
      for (const t of p.traces) if (t.net === v.net && t.points.some((q) => Math.hypot(q.x - v.x, q.y - v.y) <= v.diameter / 2 + t.width / 2 + 1e-6)) used.add(layerIndexOf(p, t.layer));
      for (const pd of pads) if (pd.net === v.net && Math.hypot(pd.center.x - v.x, pd.center.y - v.y) <= Math.max(pd.w, pd.h) / 2) for (const l of pd.layers) used.add(layerIndexOf(p, l));
      if (!used.size) continue;
      const last = p.layers.length - 1;
      // drill from `side` down to just before the first used layer seen from that side
      const deepest = bd.side === 'bottom' ? Math.max(...used) : Math.min(...used);
      const stopAt = bd.side === 'bottom' ? deepest + 1 : deepest - 1;
      // a must-not-cut layer stops the drill on the near side of it
      const limit = bd.mustNotCut ? layerIndexOf(p, bd.mustNotCut) : -1;
      const to = bd.side === 'bottom' ? Math.max(stopAt, limit >= 0 ? limit + 1 : stopAt) : Math.min(stopAt, limit >= 0 ? limit - 1 : stopAt);
      if ((bd.side === 'bottom' && to > last) || (bd.side === 'top' && to < 0)) continue;   // no stub to remove
      const stubLayers = bd.side === 'bottom' ? last - to + 1 : to + 1;
      const toName = p.layers[to].name;
      (bySide.get(bd.side) ?? bySide.set(bd.side, []).get(bd.side)!).push({ x: v.x, y: v.y, d: r3(v.drill + bd.oversize), to: toName });
      report.push({ net: v.net, x: v.x, y: v.y, side: bd.side, to: toName, stub: stubLayers });
    }
  }
  const files: FabFile[] = [];
  for (const [side, holes] of bySide) {
    const tools = [...new Set(holes.map((h) => `${h.d.toFixed(3)}|${h.to}`))];
    // the file spans the deepest backdrill of the side; each tool states its own depth (last layer removed)
    const idx = holes.map((h) => layerIndexOf(p, h.to));
    const span = side === 'top' ? `1,${Math.max(...idx) + 1}` : `${Math.min(...idx) + 1},${p.layers.length}`;
    const out = ['M48', `; BACKDRILL from ${side} — OpenBoard 0.1`, `; #@! TF.FileFunction,NonPlated,${span},Blind`, 'METRIC'];
    tools.forEach((t, i) => { const [d, to] = t.split('|'); out.push(`T${i + 1}C${d} ; depth: remove ${side === 'top' ? p.layers[0].name : p.layers[p.layers.length - 1].name} through ${to}`); });
    out.push('%', 'G90', 'G05');
    tools.forEach((t, i) => { out.push(`T${i + 1}`); for (const h of holes) if (`${h.d.toFixed(3)}|${h.to}` === t) out.push(`X${h.x.toFixed(3)}Y${h.y.toFixed(3)}`); });
    out.push('M30', '');
    files.push({ name: `${name}-backdrill-${side}.drl`, content: out.join('\n') });
  }
  return { files, report };
}

/* ============================== copper thieving ============================== */

/** Dot positions for copper thieving on `layer`: a grid of `size` dots every `pitch`, `clearance` from all copper. */
export function thievingDots(p: Project, layer: string, o: { pitch?: number; size?: number; clearance?: number } = {}): Pt[] {
  const pitch = o.pitch ?? 2, size = o.size ?? 1, clr = o.clearance ?? 1;
  const xs = p.outline.map((q) => q.x), ys = p.outline.map((q) => q.y);
  const inPoly = (q: Pt) => { let ins = false; for (let i = 0, j = p.outline.length - 1; i < p.outline.length; j = i++) { const a = p.outline[i], b = p.outline[j]; if ((a.y > q.y) !== (b.y > q.y) && q.x < ((b.x - a.x) * (q.y - a.y)) / (b.y - a.y) + a.x) ins = !ins; } return ins; };
  const segD = (q: Pt, a: Pt, b: Pt) => { const dx = b.x - a.x, dy = b.y - a.y, l2 = dx * dx + dy * dy; let t = l2 ? ((q.x - a.x) * dx + (q.y - a.y) * dy) / l2 : 0; t = Math.max(0, Math.min(1, t)); return Math.hypot(q.x - a.x - dx * t, q.y - a.y - dy * t); };
  const edge = (q: Pt) => { let d = Infinity; for (let i = 0; i < p.outline.length; i++) d = Math.min(d, segD(q, p.outline[i], p.outline[(i + 1) % p.outline.length])); return d; };
  const pads = padInstances(p).filter((pd) => pd.layers.includes(layer) || pd.th);
  const traces = p.traces.filter((t) => t.layer === layer);
  const zones = p.zones.filter((z) => z.layer === layer);
  const out: Pt[] = [];
  const need = size / 2 + clr;
  for (let y = Math.min(...ys) + pitch / 2; y < Math.max(...ys); y += pitch) for (let x = Math.min(...xs) + pitch / 2; x < Math.max(...xs); x += pitch) {
    const q = { x: r3(x), y: r3(y) };
    if (!inPoly(q) || edge(q) < need + p.rules.edgeClearance) continue;
    if (zones.some((z) => { let ins = false; for (let i = 0, j = z.points.length - 1; i < z.points.length; j = i++) { const a = z.points[i], b = z.points[j]; if ((a.y > q.y) !== (b.y > q.y) && q.x < ((b.x - a.x) * (q.y - a.y)) / (b.y - a.y) + a.x) ins = !ins; } return ins; })) continue;   // pours already balance copper
    if (pads.some((pd) => Math.hypot(pd.center.x - q.x, pd.center.y - q.y) < Math.max(pd.w, pd.h) / 2 + need)) continue;
    if (p.vias.some((v) => Math.hypot(v.x - q.x, v.y - q.y) < v.diameter / 2 + need)) continue;
    if (traces.some((t) => t.points.some((_, i) => i > 0 && segD(q, t.points[i - 1], t.points[i]) < t.width / 2 + need))) continue;
    if (p.keepouts.some((k) => q.x > k.rect.x1 - need && q.x < k.rect.x2 + need && q.y > k.rect.y1 - need && q.y < k.rect.y2 + need)) continue;
    out.push(q);
  }
  return out;
}

/* ============================== impedance coupon ============================== */

/**
 * Impedance coupon: on each requested layer a straight trace of that layer's routing width, `length` long, between
 * two probe vias, each with a GND via 2.54 mm beside it (signal-ground probe pitch). Placed from `at` upwards.
 */
export function addCoupon(p: Project, o: { at: Pt; layers: string[]; width?: number; length?: number; gnd?: string }): number {
  const L = o.length ?? 25, pitchY = 4, gnd = o.gnd ?? 'GND';
  // check the whole coupon first: every via and every point of each trace must fit the rules
  const site = new ViaSite(p), all = p.layers.map((l) => l.name);
  const problems: string[] = [];
  o.layers.forEach((layer, i) => {
    const net = `COUPON_${layer.replace(/\W/g, '')}`, w = o.width ?? p.rules.width, y = o.at.y + i * pitchY;
    for (const q of [{ x: o.at.x, y }, { x: o.at.x + L, y }]) if (!site.ok(net, q, p.rules.viaDiameter, p.rules.viaDrill, all)) problems.push(`${layer} probe via at ${q.x},${q.y}`);
    for (const q of [{ x: o.at.x, y: y + 2.54 }, { x: o.at.x + L, y: y + 2.54 }]) if (!site.ok(gnd, q, p.rules.viaDiameter, p.rules.viaDrill, all)) problems.push(`${layer} GND via at ${q.x},${q.y}`);
    for (let s = 0.5; s < L; s += 0.5) if (!site.ok(net, { x: o.at.x + s, y }, w, 0, [layer])) { problems.push(`${layer} trace near x=${(o.at.x + s).toFixed(1)}`); break; }
  });
  if (problems.length) throw new Error(`coupon does not fit there: ${problems.join('; ')}`);
  let added = 0;
  o.layers.forEach((layer, i) => {
    const net = `COUPON_${layer.replace(/\W/g, '')}`;
    const w = o.width ?? p.rules.width, y = o.at.y + i * pitchY;
    const a = { x: o.at.x, y }, b = { x: o.at.x + L, y };
    if (!p.nets.some((n) => n.name === net)) p.nets.push({ name: net, pins: [] });
    p.traces.push({ id: nextId(p), net, layer, width: w, points: [a, b], locked: true });
    for (const q of [a, b]) p.vias.push({ id: nextId(p), net, x: q.x, y: q.y, diameter: p.rules.viaDiameter, drill: p.rules.viaDrill, locked: true });
    for (const q of [{ x: a.x, y: a.y + 2.54 }, { x: b.x, y: b.y + 2.54 }]) p.vias.push({ id: nextId(p), net: gnd, x: q.x, y: q.y, diameter: p.rules.viaDiameter, drill: p.rules.viaDrill, locked: true });
    (p.texts ??= []).push({ id: nextId(p), text: `Z ${layer} W${w}`, x: a.x + L / 2, y: y + 1.2, size: 0.8, rot: 0, layer: 'F.Silk' });
    added++;
  });
  return added;
}
