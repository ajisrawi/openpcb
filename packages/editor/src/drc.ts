/**
 * OpenBoard design rule check.
 *
 * Copper clearance comes from the router's exact shape-based checker run on the
 * exported design; everything the router does not know about (drills, silkscreen,
 * solder mask, pours, constraints) is checked here on the project directly.
 *
 * Checks: clearance, keepout, outline, unconnected, track-width, annular-ring,
 * hole-to-copper, hole-to-hole, pour-to-copper (static zones), diff-pair (gap /
 * uncoupled / skew), length (min/max and matched groups), silk-to-copper,
 * silk-off-board, silk-over-hole, mask-sliver.
 */
import { Board, runDrc, geomDistance, pointInPolygon, type Geometry } from '@openpcb/router';
import type { Project, Pt, Trace } from './model.js';
import { drcKey } from './model.js';
import { projectToDesign } from './dsnio.js';
import { ratsnest, padInstances, type DrcMarker, type PadInstance } from './connectivity.js';
import { padToBoard, viaLayers, isMicrovia, layerIndexOf } from './model.js';
import { defaultLibrary } from './footprints.js';

const EPS = 0.0005;   // mm: 0.5 um, below any fab tolerance, above mm/um rounding

/** Exact copper geometry of a placed pad (mm). */
export function padGeometry(pd: PadInstance): Geometry {
  const rot = (pd.rot * Math.PI) / 180;   // PadInstance.rot is the final board angle (padAngle)
  const cs = Math.cos(rot), sn = Math.sin(rot);
  const tf = (x: number, y: number): Pt => ({ x: pd.center.x + x * cs - y * sn, y: pd.center.y + x * sn + y * cs });
  if (pd.shape === 'circle') return { type: 'circle', c: pd.center, r: pd.w / 2 };
  if (pd.shape === 'oval') {
    const r = Math.min(pd.w, pd.h) / 2;
    return pd.w >= pd.h ? { type: 'seg', a: tf(-pd.w / 2 + r, 0), b: tf(pd.w / 2 - r, 0), hw: r } : { type: 'seg', a: tf(0, -pd.h / 2 + r), b: tf(0, pd.h / 2 - r), hw: r };
  }
  const w = pd.w / 2, h = pd.h / 2;
  return { type: 'poly', pts: [tf(-w, -h), tf(w, -h), tf(w, h), tf(-w, h)] };
}

function segLen(a: Pt, b: Pt): number { return Math.hypot(a.x - b.x, a.y - b.y); }
function traceLength(t: Trace): number { let L = 0; for (let i = 1; i < t.points.length; i++) L += segLen(t.points[i - 1], t.points[i]); return L; }
function distPtSeg(q: Pt, a: Pt, b: Pt): number { const dx = b.x - a.x, dy = b.y - a.y; const l2 = dx * dx + dy * dy; let t = l2 ? ((q.x - a.x) * dx + (q.y - a.y) * dy) / l2 : 0; t = Math.max(0, Math.min(1, t)); return Math.hypot(q.x - (a.x + dx * t), q.y - (a.y + dy * t)); }
function mid(a: Pt, b: Pt): Pt { return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }; }

interface Hole { pt: Pt; r: number; net: string; what: string; layers: string[]; laser: boolean }

/** Simple spatial bucket for near-pair queries. */
class Grid<T extends { pt: Pt }> {
  private cells = new Map<string, T[]>();
  constructor(private readonly size: number) {}
  add(o: T): void { const k = `${Math.floor(o.pt.x / this.size)},${Math.floor(o.pt.y / this.size)}`; const a = this.cells.get(k); if (a) a.push(o); else this.cells.set(k, [o]); }
  near(pt: Pt, radius: number): T[] { const out: T[] = []; const n = Math.ceil(radius / this.size); const cx = Math.floor(pt.x / this.size), cy = Math.floor(pt.y / this.size); for (let dx = -n; dx <= n; dx++) for (let dy = -n; dy <= n; dy++) { const a = this.cells.get(`${cx + dx},${cy + dy}`); if (a) out.push(...a); } return out; }
}

/** DRC with waived markers removed (Allegro Waive DRC); `projectDrcAll` returns every marker. */
export function projectDrc(p: Project): DrcMarker[] {
  const waived = new Set(p.waivers ?? []);
  const all = projectDrcAll(p);
  return waived.size ? all.filter((m) => !waived.has(drcKey(m))) : all;
}

export function projectDrcAll(p: Project): DrcMarker[] {
  const out: DrcMarker[] = [];
  const R = p.rules;
  const lib = { ...defaultLibrary(), ...p.footprints };
  const pads = padInstances(p);
  const padGeo = new Map<PadInstance, Geometry>(); for (const pd of pads) padGeo.set(pd, padGeometry(pd));
  const allLayers = p.layers.map((l) => l.name);
  const sideLayer = (side: 'front' | 'back') => (side === 'front' ? allLayers[0] : allLayers[allLayers.length - 1]);

  /* 1. copper clearance, keepouts, outline — router's exact checker */
  try {
    const d = projectToDesign(p, { keepAutorouted: true, holeKeepouts: false });
    const board = new Board(d);
    for (const x of runDrc(board)) {
      const toMm = (u: number) => u / 1000;
      out.push({
        kind: x.kind, at: { x: toMm(x.at.x), y: toMm(x.at.y) }, layer: board.layerNames[x.layer] ?? String(x.layer),
        message: x.kind === 'clearance'
          ? `${x.a.kind} ${x.a.net ?? x.a.ref ?? ''} to ${x.b!.kind} ${x.b!.net ?? x.b!.ref ?? ''}: ${toMm(x.distance).toFixed(3)} mm < ${toMm(x.required).toFixed(3)} mm`
          : x.kind === 'outside_boundary' ? `${x.a.kind} ${x.a.net ?? ''} outside board outline` : `${x.a.kind} ${x.a.net ?? ''} inside keepout`,
      });
    }
  } catch (e) { out.push({ kind: 'error', at: { x: 0, y: 0 }, layer: '', message: 'clearance check failed: ' + (e as Error).message }); }

  /* 2. unconnected pads */
  for (const r of ratsnest(p)) out.push({ kind: 'unconnected', at: mid(r.a, r.b), layer: allLayers[0], message: `net ${r.net}: open connection (${r.a.x.toFixed(2)},${r.a.y.toFixed(2)}) to (${r.b.x.toFixed(2)},${r.b.y.toFixed(2)})` });

  /* 3. track width */
  for (const t of p.traces) {
    const netW = p.nets.find((n) => n.name === t.net)?.width;
    const min = Math.max(R.minTrackWidth, netW ?? 0);
    if (t.width < min - EPS) out.push({ kind: 'track-width', at: t.points[0], layer: t.layer, message: `trace ${t.net || '(no net)'} width ${t.width.toFixed(3)} mm < ${min.toFixed(3)} mm` });
  }

  /* 4. annular ring, holes */
  const holes: Hole[] = [];
  for (const pd of pads) if (pd.th) {
    const fp = lib[p.components.find((c) => c.ref === pd.ref)?.footprint ?? '']; const pad = fp?.pads.find((x) => x.id === pd.padId);
    const drill = pad?.drill ?? Math.min(pd.w, pd.h) / 2;
    const ring = (Math.min(pd.w, pd.h) - drill) / 2;
    if (!pad?.npth && ring < R.minAnnularRing - EPS) out.push({ kind: 'annular-ring', at: pd.center, layer: allLayers[0], message: `pad ${pd.key}: annular ring ${ring.toFixed(3)} mm < ${R.minAnnularRing} mm` });
    holes.push({ pt: pd.center, r: drill / 2, net: pd.net, what: `pad ${pd.key}`, layers: allLayers, laser: false });
  }
  for (const v of p.vias) {
    const ring = (v.diameter - v.drill) / 2;
    const micro = isMicrovia(p, v);
    const vlr = viaLayers(p, v);
    // blind vias (outer layer to an inner one) are laser drilled, as single or stacked microvias: microvia ring rule
    const laserSpan = vlr.length < allLayers.length && (vlr[0] === allLayers[0] || vlr[vlr.length - 1] === allLayers[allLayers.length - 1]);
    const minRing = micro || laserSpan ? (R.minMicroviaDiameter - R.minMicroviaDrill) / 2 : R.minAnnularRing;   // microvias have their own size rules
    if (ring < minRing - EPS) out.push({ kind: 'annular-ring', at: { x: v.x, y: v.y }, layer: allLayers[0], message: `${micro ? 'microvia' : 'via'} ${v.net}: annular ring ${ring.toFixed(3)} mm < ${minRing} mm` });
    const vl = viaLayers(p, v);
    // via span rules: layers must exist; a microvia (two adjacent layers) has its own minimum sizes
    if ((v.from && layerIndexOf(p, v.from) < 0) || (v.to && layerIndexOf(p, v.to) < 0)) out.push({ kind: 'via-span', at: { x: v.x, y: v.y }, layer: allLayers[0], message: `via ${v.net}: unknown span ${v.from}..${v.to}` });
    else if (micro) {
      if (v.diameter < R.minMicroviaDiameter - EPS) out.push({ kind: 'microvia-size', at: { x: v.x, y: v.y }, layer: vl[0], message: `microvia ${v.net} ${vl[0]}-${vl[1]}: diameter ${v.diameter} mm < ${R.minMicroviaDiameter} mm` });
      if (v.drill < R.minMicroviaDrill - EPS) out.push({ kind: 'microvia-size', at: { x: v.x, y: v.y }, layer: vl[0], message: `microvia ${v.net} ${vl[0]}-${vl[1]}: drill ${v.drill} mm < ${R.minMicroviaDrill} mm` });
    }
    // blind vias (an outer layer to an inner one) are laser drilled; through and buried vias are mechanical
    const laser = vl.length < allLayers.length && (vl[0] === allLayers[0] || vl[vl.length - 1] === allLayers[allLayers.length - 1]);
    holes.push({ pt: { x: v.x, y: v.y }, r: v.drill / 2, net: v.net, what: `${laser ? 'blind via' : 'via'} ${v.net}`, layers: vl, laser });
  }
  // hole-to-copper: pads (any layer), traces, vias of other nets
  const reach = R.holeToCopper + 2;
  const padGrid = new Grid<{ pt: Pt; pd: PadInstance }>(2); for (const pd of pads) padGrid.add({ pt: pd.center, pd });
  const viaGrid = new Grid<{ pt: Pt; v: typeof p.vias[number] }>(2); for (const v of p.vias) viaGrid.add({ pt: { x: v.x, y: v.y }, v });
  for (const h of holes) {
    const hole: Geometry = { type: 'circle', c: h.pt, r: h.r };
    const H2C = h.laser ? R.laserHoleToCopper : R.holeToCopper;
    for (const { pd } of padGrid.near(h.pt, reach + 3)) {
      if (pd.net && pd.net === h.net) continue;
      if (pd.center === h.pt) continue;
      if (!pd.layers.some((l) => h.layers.includes(l))) continue;   // a blind hole never meets copper outside its span
      const dd = geomDistance(hole, padGeo.get(pd)!);
      if (dd < H2C - EPS) out.push({ kind: 'hole-to-copper', at: h.pt, layer: allLayers[0], message: `${h.what} hole to pad ${pd.key}: ${Math.max(0, dd).toFixed(3)} mm < ${H2C} mm` });
    }
    for (const { v } of viaGrid.near(h.pt, reach)) {
      if (v.net && v.net === h.net) continue;
      if (v.x === h.pt.x && v.y === h.pt.y) continue;
      if (!viaLayers(p, v).some((l) => h.layers.includes(l))) continue;
      const dd = Math.hypot(v.x - h.pt.x, v.y - h.pt.y) - h.r - v.diameter / 2;
      if (dd < H2C - EPS) out.push({ kind: 'hole-to-copper', at: h.pt, layer: allLayers[0], message: `${h.what} hole to via ${v.net}: ${Math.max(0, dd).toFixed(3)} mm < ${H2C} mm` });
    }
    for (const t of p.traces) {
      if (t.net && t.net === h.net) continue;
      if (!h.layers.includes(t.layer)) continue;
      for (let i = 0; i + 1 < t.points.length; i++) {
        const dd = distPtSeg(h.pt, t.points[i], t.points[i + 1]) - h.r - t.width / 2;
        if (dd < H2C - EPS) { out.push({ kind: 'hole-to-copper', at: h.pt, layer: t.layer, message: `${h.what} hole to trace ${t.net}: ${Math.max(0, dd).toFixed(3)} mm < ${H2C} mm` }); break; }
      }
    }
  }
  // hole-to-hole
  const holeGrid = new Grid<Hole>(2); for (const h of holes) holeGrid.add(h);
  const seenH = new Set<string>();
  const holeIdx = new Map<Hole, number>(); holes.forEach((h, i) => holeIdx.set(h, i));
  holes.forEach((h, i) => {
    for (const o of holeGrid.near(h.pt, Math.max(R.holeToHole, R.laserHoleToHole) + 3)) {
      if (o === h) continue;
      const j = holeIdx.get(o)!; const k = i < j ? `${i}:${j}` : `${j}:${i}`;
      if (seenH.has(k)) continue; seenH.add(k);
      // holes that share no layer never meet (a blind via over a buried one in a different span, opposite blind vias)
      if (!h.layers.some((l) => o.layers.includes(l))) continue;
      const centre = Math.hypot(o.pt.x - h.pt.x, o.pt.y - h.pt.y);
      const sameNet = !!h.net && h.net === o.net;
      // stacked vias: same net, same position, adjacent spans (the fab plates one onto the other)
      if (sameNet && centre < EPS && (h.laser || o.laser)) continue;
      const need = h.laser || o.laser ? (sameNet ? R.laserHoleToHoleSameNet : R.laserHoleToHole) : R.holeToHole;
      const dd = centre - h.r - o.r;
      if (dd < need - EPS) out.push({ kind: 'hole-to-hole', at: mid(h.pt, o.pt), layer: allLayers[0], message: `${h.what} to ${o.what}: ${Math.max(0, dd).toFixed(3)} mm < ${need} mm` });
    }
  });

  /* 5. static pours: other-net copper too close to the pour */
  for (const z of p.zones) {
    if (z.dynamic || z.points.length < 3) continue;
    const zg: Geometry = { type: 'poly', pts: z.points };
    const need = z.clearance;
    for (const pd of pads) { if (pd.net === z.net || !pd.layers.includes(z.layer)) continue; const dd = geomDistance(zg, padGeo.get(pd)!); if (dd < need - EPS) out.push({ kind: 'pour-to-copper', at: pd.center, layer: z.layer, message: `pour ${z.net} to pad ${pd.key}: ${Math.max(0, dd).toFixed(3)} mm < ${need} mm` }); }
    for (const t of p.traces) { if (t.net === z.net || t.layer !== z.layer) continue; for (let i = 0; i + 1 < t.points.length; i++) { const dd = geomDistance(zg, { type: 'seg', a: t.points[i], b: t.points[i + 1], hw: t.width / 2 }); if (dd < need - EPS) { out.push({ kind: 'pour-to-copper', at: mid(t.points[i], t.points[i + 1]), layer: z.layer, message: `pour ${z.net} to trace ${t.net}: ${Math.max(0, dd).toFixed(3)} mm < ${need} mm` }); break; } } }
    for (const v of p.vias) { if (v.net === z.net) continue; const dd = geomDistance(zg, { type: 'circle', c: { x: v.x, y: v.y }, r: v.diameter / 2 }); if (dd < need - EPS) out.push({ kind: 'pour-to-copper', at: { x: v.x, y: v.y }, layer: z.layer, message: `pour ${z.net} to via ${v.net}: ${Math.max(0, dd).toFixed(3)} mm < ${need} mm` }); }
  }

  /* 6. differential pairs */
  const netLength = (net: string) => p.traces.filter((t) => t.net === net).reduce((s, t) => s + traceLength(t), 0) + p.vias.filter((v) => v.net === net).length * R.viaLength;
  for (const dp of p.diffPairs) {
    const tp = p.traces.filter((t) => t.net === dp.p), tn = p.traces.filter((t) => t.net === dp.n);
    if (!tp.length && !tn.length) continue;
    const width = Math.max(tp[0]?.width ?? R.width, tn[0]?.width ?? R.width);
    const target = dp.gap + width;   // centre-line spacing when coupled
    let uncoupled = 0; let first: Pt | undefined;
    for (const t of tp) for (let i = 0; i + 1 < t.points.length; i++) {
      const a = t.points[i], b = t.points[i + 1]; const L = segLen(a, b); if (L < EPS) continue;
      const samples = [a, mid(a, b), b];
      let coupledSamples = 0;
      for (const s of samples) { let best = Infinity; for (const o of tn) { if (o.layer !== t.layer) continue; for (let j = 0; j + 1 < o.points.length; j++) best = Math.min(best, distPtSeg(s, o.points[j], o.points[j + 1])); } if (Math.abs(best - target) <= dp.tolerance + EPS) coupledSamples++; }
      if (coupledSamples < 2) { uncoupled += L; first ??= mid(a, b); }
    }
    if (uncoupled > dp.maxUncoupled + EPS) out.push({ kind: 'diff-pair', at: first ?? tp[0]?.points[0] ?? { x: 0, y: 0 }, layer: tp[0]?.layer ?? allLayers[0], message: `pair ${dp.name}: ${uncoupled.toFixed(2)} mm uncoupled (gap ${dp.gap} ± ${dp.tolerance} mm) > ${dp.maxUncoupled} mm` });
    const skew = Math.abs(netLength(dp.p) - netLength(dp.n));
    if (skew > dp.maxSkew + EPS) out.push({ kind: 'diff-pair', at: tp[0]?.points[0] ?? tn[0]?.points[0] ?? { x: 0, y: 0 }, layer: tp[0]?.layer ?? allLayers[0], message: `pair ${dp.name}: length skew ${skew.toFixed(2)} mm > ${dp.maxSkew} mm` });
  }

  /* 7. length rules */
  for (const n of p.nets) {
    if (n.minLength === undefined && n.maxLength === undefined) continue;
    const L = netLength(n.name); const t0 = p.traces.find((t) => t.net === n.name);
    if (n.minLength !== undefined && L < n.minLength - EPS) out.push({ kind: 'length', at: t0?.points[0] ?? { x: 0, y: 0 }, layer: t0?.layer ?? allLayers[0], message: `net ${n.name}: length ${L.toFixed(2)} mm < min ${n.minLength} mm` });
    if (n.maxLength !== undefined && L > n.maxLength + EPS) out.push({ kind: 'length', at: t0?.points[0] ?? { x: 0, y: 0 }, layer: t0?.layer ?? allLayers[0], message: `net ${n.name}: length ${L.toFixed(2)} mm > max ${n.maxLength} mm` });
  }
  for (const g of p.lengthGroups) {
    const Ls = g.nets.map((n) => ({ n, L: netLength(n) }));
    if (!Ls.length) continue;
    const lo = Ls.reduce((a, b) => (a.L < b.L ? a : b)), hi = Ls.reduce((a, b) => (a.L > b.L ? a : b));
    if (hi.L - lo.L > g.tolerance + EPS) { const t0 = p.traces.find((t) => t.net === lo.n); out.push({ kind: 'length', at: t0?.points[0] ?? { x: 0, y: 0 }, layer: t0?.layer ?? allLayers[0], message: `group ${g.name}: ${hi.n} ${hi.L.toFixed(2)} mm vs ${lo.n} ${lo.L.toFixed(2)} mm, mismatch ${(hi.L - lo.L).toFixed(2)} mm > ${g.tolerance} mm` }); }
  }

  /* 8. silkscreen: footprint outlines (component side) vs pads, board edge, holes */
  const silkHw = R.silkWidth / 2;
  const inside = (q: Pt) => pointInPolygon(q, p.outline);
  for (const c of p.components) {
    const fp = lib[c.footprint]; if (!fp || fp.outlineKind === 'reference') continue;
    const layer = sideLayer(c.side);
    for (const pl of fp.outline) {
      const pts = pl.map((q) => padToBoard(c, q));
      for (let i = 0; i + 1 < pts.length; i++) {
        const seg: Geometry = { type: 'seg', a: pts[i], b: pts[i + 1], hw: silkHw };
        if (!inside(pts[i]) || !inside(pts[i + 1])) { out.push({ kind: 'silk-off-board', at: pts[i], layer, message: `${c.ref} silkscreen outside board outline` }); }
        // with silkscreen clipping on (default) the Gerber legend is cut back at pads and holes, so these are fixed at output
        if (R.silkClip !== false) continue;
        for (const { pd } of padGrid.near(mid(pts[i], pts[i + 1]), segLen(pts[i], pts[i + 1]) / 2 + 3)) {
          if (!pd.layers.includes(layer)) continue;
          const dd = geomDistance(seg, padGeo.get(pd)!);
          if (dd < R.silkToCopper - EPS) { out.push({ kind: 'silk-to-copper', at: mid(pts[i], pts[i + 1]), layer, message: `${c.ref} silkscreen to pad ${pd.key}: ${Math.max(0, dd).toFixed(3)} mm < ${R.silkToCopper} mm` }); break; }
        }
        for (const h of holeGrid.near(mid(pts[i], pts[i + 1]), segLen(pts[i], pts[i + 1]) / 2 + 2)) {
          if (distPtSeg(h.pt, pts[i], pts[i + 1]) < h.r + silkHw) { out.push({ kind: 'silk-over-hole', at: h.pt, layer, message: `${c.ref} silkscreen crosses ${h.what} hole` }); break; }
        }
      }
    }
  }

  /* 9. solder mask: openings of different-net pads on the same side must leave a web */
  const seenM = new Set<string>();
  for (const pd of pads) {
    const sides = pd.th ? ['front', 'back'] : [p.components.find((c) => c.ref === pd.ref)?.side ?? 'front'];
    for (const { pd: o } of padGrid.near(pd.center, Math.max(pd.w, pd.h) + 3)) {
      if (o === pd || (o.net && o.net === pd.net && o.ref === pd.ref)) continue;
      const k = pd.key < o.key ? `${pd.key}|${o.key}` : `${o.key}|${pd.key}`; if (seenM.has(k)) continue; seenM.add(k);
      const oSides = o.th ? ['front', 'back'] : [p.components.find((c) => c.ref === o.ref)?.side ?? 'front'];
      if (!sides.some((s) => oSides.includes(s))) continue;
      if (pd.net && pd.net === o.net) continue;
      const dd = geomDistance(padGeo.get(pd)!, padGeo.get(o)!) - 2 * R.maskExpansion;
      if (dd < R.minMaskSliver - EPS) out.push({ kind: 'mask-sliver', at: mid(pd.center, o.center), layer: sideLayer(sides[0] as 'front' | 'back'), message: `mask web between ${pd.key} and ${o.key}: ${Math.max(0, dd).toFixed(3)} mm < ${R.minMaskSliver} mm` });
    }
  }

  /* 10. crosstalk: parallel (same layer) and tandem (adjacent layers) coupled length between two nets */
  out.push(...crosstalk(p, 'parallel', R.parallelGap, R.parallelLimit));
  out.push(...crosstalk(p, 'tandem', R.tandemGap, R.tandemLimit));
  return out;
}

/** Coupled length of every net pair whose trace segments run parallel (within 5°) closer than `gap` (edge to
 *  edge); same layer for 'parallel', adjacent copper layers for 'tandem'. Pairs over `limit` are reported. */
function crosstalk(p: Project, mode: 'parallel' | 'tandem', gap: number, limit: number): DrcMarker[] {
  if (!(gap > 0 && limit > 0)) return [];
  const layerIdx = new Map(p.layers.map((l, i) => [l.name, i]));
  interface S { net: string; layer: number; a: Pt; b: Pt; hw: number; len: number; ux: number; uy: number }
  const segs: S[] = [];
  for (const t of p.traces) for (let i = 1; i < t.points.length; i++) {
    const a = t.points[i - 1], b = t.points[i], len = Math.hypot(b.x - a.x, b.y - a.y); if (len < 1e-6) continue;
    segs.push({ net: t.net, layer: layerIdx.get(t.layer) ?? 0, a, b, hw: t.width / 2, len, ux: (b.x - a.x) / len, uy: (b.y - a.y) / len });
  }
  const grid = new Grid<{ pt: Pt; s: S }>(5);
  for (const s of segs) { const n = Math.ceil(s.len / 2.5); for (let k = 0; k <= n; k++) grid.add({ pt: { x: s.a.x + (s.b.x - s.a.x) * k / n, y: s.a.y + (s.b.y - s.a.y) * k / n }, s }); }
  const coupled = new Map<string, { len: number; at: Pt; layer: number }>();
  const seen = new Set<string>();
  const idx = new Map(segs.map((s, i) => [s, i]));
  for (const s of segs) {
    for (const { s: o } of grid.near(mid(s.a, s.b), s.len / 2 + gap + 5)) {
      if (o === s || !o.net || !s.net || o.net === s.net) continue;
      const dl = Math.abs(o.layer - s.layer);
      if (mode === 'parallel' ? dl !== 0 : dl !== 1) continue;
      const i = idx.get(s)!, j = idx.get(o)!; const key = i < j ? `${i}:${j}` : `${j}:${i}`; if (seen.has(key)) continue; seen.add(key);
      if (Math.abs(s.ux * o.uy - s.uy * o.ux) > Math.sin((5 * Math.PI) / 180)) continue;   // not parallel
      // overlap of o's projection on s, and their lateral (edge) distance
      const t0 = (o.a.x - s.a.x) * s.ux + (o.a.y - s.a.y) * s.uy, t1 = (o.b.x - s.a.x) * s.ux + (o.b.y - s.a.y) * s.uy;
      const lo = Math.max(0, Math.min(t0, t1)), hi = Math.min(s.len, Math.max(t0, t1)); if (hi - lo <= 0) continue;
      const lat = Math.abs((o.a.x - s.a.x) * -s.uy + (o.a.y - s.a.y) * s.ux) - s.hw - o.hw;
      if (lat > gap) continue;
      const pk = s.net < o.net ? `${s.net}|${o.net}` : `${o.net}|${s.net}`;
      const cur = coupled.get(pk) ?? { len: 0, at: { x: s.a.x + s.ux * lo, y: s.a.y + s.uy * lo }, layer: s.layer };
      cur.len += hi - lo; coupled.set(pk, cur);
    }
  }
  const out: DrcMarker[] = [];
  for (const [pk, c] of coupled) if (c.len > limit + EPS) { const [n1, n2] = pk.split('|'); out.push({ kind: 'crosstalk', at: c.at, layer: p.layers[c.layer]?.name ?? '', message: `${mode} coupling ${n1} / ${n2}: ${c.len.toFixed(2)} mm within ${gap} mm > ${limit} mm` }); }
  return out;
}

/** Counts per kind, for the summary line. */
export function drcSummary(markers: DrcMarker[]): string {
  const c = new Map<string, number>();
  for (const m of markers) c.set(m.kind, (c.get(m.kind) ?? 0) + 1);
  return [...c.entries()].map(([k, n]) => `${k} ${n}`).join(', ') || 'none';
}
