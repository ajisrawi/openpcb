/**
 * Rigid-flex design (Allegro rigid-flex / 3D bend counterpart).
 *
 *   flex zones   areas with their own copper layer set (the flex core), coverlay instead of solder mask
 *   bend areas   strips that bend: start axis, angle, inner radius; the far side folds about the axis
 *   stiffeners   rigid backing on the flex (drawing + Gerber)
 *   flexDrc      copper on layers a flex zone does not have; vias and pads inside bend areas; traces not crossing a
 *                bend at a right angle; traces on adjacent layers stacked in a bend (I-beam); solid pours in a bend;
 *                bend radius below the IPC-2223 minimum for the flex thickness (single 6x, double 10x, multilayer
 *                20x static, 100x dynamic); parts on flex without a stiffener
 *   foldPoint    the flat board -> bent 3D mapping (cylindrical in the bend strip, rigid beyond it; bends applied from
 *                the last to the first, each bend's far side carrying the later ones)
 *   bentSolids / exportBentStep   the board cut into rigid pieces and bend facets, folded, plus part bodies and wire
 *                bonds, written as closed STEP solids
 *   flexFiles    coverlay (top/bottom) and stiffener Gerbers for the fabrication set
 */
import { type Project, type Pt, type FlexZone, type BendArea, type Stiffener, nextId, copperOf, heightOf, viaLayers } from './model.js';
import { defaultLibrary } from './footprints.js';
import { padInstances } from './connectivity.js';
import { prism, tube, polyhedraToStep, type P3, type Polyhedron } from './step3d.js';
import { bondSolids } from './bond.js';
import type { Plotter } from './fab.js';

const inPoly = (q: Pt, poly: Pt[]) => { let ins = false; for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) { const a = poly[i], b = poly[j]; if ((a.y > q.y) !== (b.y > q.y) && q.x < ((b.x - a.x) * (q.y - a.y)) / (b.y - a.y) + a.x) ins = !ins; } return ins; };
const sub = (a: Pt, b: Pt) => ({ x: a.x - b.x, y: a.y - b.y });
const dot = (a: Pt, b: Pt) => a.x * b.x + a.y * b.y;

export function addFlexZone(p: Project, z: Omit<FlexZone, 'id'>): FlexZone { const o = { id: nextId(p), ...z }; (p.flexZones ??= []).push(o); return o; }
export function addBend(p: Project, b: Omit<BendArea, 'id'>): BendArea { const o = { id: nextId(p), ...b }; (p.bends ??= []).push(o); return o; }
export function addStiffener(p: Project, s: Omit<Stiffener, 'id'>): Stiffener { const o = { id: nextId(p), ...s }; (p.stiffeners ??= []).push(o); return o; }

/** Bend frame: axis origin A, axis direction u, fold direction n (towards the bend area), strip width W along n. */
function frame(b: BendArea): { A: Pt; u: Pt; n: Pt; W: number } {
  const A = b.axis[0], d = sub(b.axis[1], b.axis[0]), L = Math.hypot(d.x, d.y) || 1, u = { x: d.x / L, y: d.y / L };
  let n = { x: -u.y, y: u.x };
  // n points into the bend area polygon
  const c = b.points.reduce((s, q) => ({ x: s.x + q.x / b.points.length, y: s.y + q.y / b.points.length }), { x: 0, y: 0 });
  if (dot(sub(c, A), n) < 0) n = { x: -n.x, y: -n.y };
  const W = Math.max(...b.points.map((q) => dot(sub(q, A), n)), 1e-6);
  return { A, u, n, W };
}

/** Flex thickness (mm) of a zone: its copper plus the dielectrics between its layers (or the stated value). */
export function flexThickness(p: Project, z: FlexZone): number {
  if (z.thickness) return z.thickness;
  const idx = z.layers.map((l) => p.layers.findIndex((x) => x.name === l)).filter((i) => i >= 0).sort((a, b) => a - b);
  let t = idx.reduce((s, i) => s + copperOf(p, p.layers[i].name), 0);
  for (let k = 1; k < idx.length; k++) t += Math.min(0.1, p.layers[idx[k - 1]].dielectric ?? 0.05);
  return t + 0.05 + (z.coverlay !== false ? 2 * 0.05 : 0);   // core film + coverlay
}

export interface FlexMarker { kind: 'flex-layer' | 'flex-bend-via' | 'flex-bend-pad' | 'flex-bend-angle' | 'flex-ibeam' | 'flex-solid-pour' | 'flex-radius' | 'flex-stiffener'; message: string; at: Pt }

export function flexDrc(p: Project, opts: { angleTolerance?: number } = {}): FlexMarker[] {
  const out: FlexMarker[] = [];
  const zones = p.flexZones ?? [], bends = p.bends ?? [];
  const zoneAt = (q: Pt) => zones.find((z) => inPoly(q, z.points));
  const bendAt = (q: Pt) => bends.find((b) => inPoly(q, b.points));
  // copper on layers the flex zone does not have
  for (const t of p.traces) for (const q of t.points) { const z = zoneAt(q); if (z && !z.layers.includes(t.layer)) { out.push({ kind: 'flex-layer', message: `trace ${t.net} on ${t.layer}: flex zone ${z.name} has no such layer`, at: q }); break; } }
  for (const v of p.vias) { const z = zoneAt(v); if (z) { const missing = viaLayers(p, v).filter((l) => !z.layers.includes(l)); if (missing.length) out.push({ kind: 'flex-layer', message: `via ${v.net} spans ${missing.join(', ')} missing in flex zone ${z.name}`, at: v }); } }
  for (const zz of p.zones) { const c = zz.points[0]; const z = c && zoneAt(c); if (z && !z.layers.includes(zz.layer)) out.push({ kind: 'flex-layer', message: `pour ${zz.net} on ${zz.layer}: flex zone ${z.name} has no such layer`, at: c }); }
  // vias / pads in bends
  for (const v of p.vias) { const b = bendAt(v); if (b) out.push({ kind: 'flex-bend-via', message: `via ${v.net} inside bend ${b.name}`, at: v }); }
  for (const pd of padInstances(p)) { const b = bendAt(pd.center); if (b) out.push({ kind: 'flex-bend-pad', message: `pad ${pd.key} inside bend ${b.name}`, at: pd.center }); }
  // traces crossing a bend must run perpendicular to the bend axis; adjacent-layer traces must not stack (I-beam)
  const tol = opts.angleTolerance ?? 10;
  for (const b of bends) {
    const { A, u, n, W } = frame(b);
    const inB = (q: Pt) => { const s = dot(sub(q, A), n); return s > 0 && s < W && inPoly(q, b.points); };
    const segsIn: { layer: string; a: Pt; c: Pt; net: string; w: number }[] = [];
    for (const t of p.traces) for (let i = 1; i < t.points.length; i++) {
      const a0 = t.points[i - 1], c0 = t.points[i];
      // the part of the segment inside the bend strip (0 < s < W)
      const sa = dot(sub(a0, A), n), sc = dot(sub(c0, A), n);
      const lo = Math.max(0, Math.min(sa, sc)), hi = Math.min(W, Math.max(sa, sc)); if (hi <= lo) continue;
      const at = (s: number) => { const k = Math.abs(sc - sa) < 1e-12 ? 0 : (s - sa) / (sc - sa); return { x: a0.x + (c0.x - a0.x) * k, y: a0.y + (c0.y - a0.y) * k }; };
      const a = Math.abs(sc - sa) < 1e-12 ? a0 : at(lo), c = Math.abs(sc - sa) < 1e-12 ? c0 : at(hi), m = { x: (a.x + c.x) / 2, y: (a.y + c.y) / 2 };
      if (!inPoly(m, b.points)) continue;
      const d = sub(c, a), L = Math.hypot(d.x, d.y); if (L < 1e-6) continue;
      const dev = (Math.acos(Math.min(1, Math.abs(dot(d, n)) / L)) * 180) / Math.PI;
      if (dev > tol) out.push({ kind: 'flex-bend-angle', message: `trace ${t.net} crosses bend ${b.name} ${dev.toFixed(1)}° off perpendicular (> ${tol}°)`, at: m });
      segsIn.push({ layer: t.layer, a, c, net: t.net, w: t.width });
    }
    const li = (l: string) => p.layers.findIndex((x) => x.name === l);
    for (let i = 0; i < segsIn.length; i++) for (let j = i + 1; j < segsIn.length; j++) {
      const s1 = segsIn[i], s2 = segsIn[j]; if (Math.abs(li(s1.layer) - li(s2.layer)) !== 1) continue;
      // offset across the bend (along u) of two parallel crossing traces
      const o1 = dot(sub({ x: (s1.a.x + s1.c.x) / 2, y: (s1.a.y + s1.c.y) / 2 }, A), u), o2 = dot(sub({ x: (s2.a.x + s2.c.x) / 2, y: (s2.a.y + s2.c.y) / 2 }, A), u);
      if (Math.abs(o1 - o2) < (s1.w + s2.w) / 2) out.push({ kind: 'flex-ibeam', message: `traces ${s1.net} (${s1.layer}) and ${s2.net} (${s2.layer}) stacked in bend ${b.name}: stagger them`, at: s1.a });
    }
    for (const zz of p.zones) if (zz.dynamic && zz.points.some((q) => inB(q)) || (zz.dynamic && inPoly({ x: A.x + n.x * W / 2, y: A.y + n.y * W / 2 }, zz.points))) out.push({ kind: 'flex-solid-pour', message: `solid pour ${zz.net} on ${zz.layer} in bend ${b.name}: use a hatched pour`, at: zz.points[0] });
    // bend radius (IPC-2223) for the flex zone the bend lies in
    const z = zoneAt({ x: A.x + n.x * W / 2, y: A.y + n.y * W / 2 }) ?? zones[0];
    if (z) {
      const t = flexThickness(p, z), nl = z.layers.length;
      const k = b.dynamic ? 100 : nl <= 1 ? 6 : nl === 2 ? 10 : 20;
      if (b.radius < k * t) out.push({ kind: 'flex-radius', message: `bend ${b.name}: radius ${b.radius} mm < ${k} x thickness ${t.toFixed(3)} = ${(k * t).toFixed(2)} mm (IPC-2223${b.dynamic ? ', dynamic' : ''})`, at: A });
      const Rn = W / Math.max(1e-6, (Math.abs(b.angle) * Math.PI) / 180);
      if (Math.abs(Rn - (b.radius + t / 2)) > 0.25 * (b.radius + t / 2)) out.push({ kind: 'flex-radius', message: `bend ${b.name}: area width ${W.toFixed(2)} mm gives a neutral radius ${Rn.toFixed(2)} mm, radius + t/2 = ${(b.radius + t / 2).toFixed(2)} mm`, at: A });
    }
  }
  // parts on flex need a stiffener under them
  const lib = { ...defaultLibrary(), ...p.footprints };
  for (const c of p.components) { const z = zoneAt(c); if (!z || !lib[c.footprint]) continue; if (!(p.stiffeners ?? []).some((s) => inPoly(c, s.points))) out.push({ kind: 'flex-stiffener', message: `${c.ref} sits on flex zone ${z.name} without a stiffener`, at: c }); }
  return out;
}

/* ------------------------------------------------------------------ folding */

/** Fold one point (x, y, z) of the flat board; zmid = the neutral plane. */
export function foldPoint(p: Project, q: P3, zmid = -(p.rules.viaLength || 1.6) / 2): P3 {
  let r = { ...q };
  const bends = (p.bends ?? []).slice().reverse();
  for (const b of bends) r = foldOne(b, r, zmid);
  return r;
}
function foldOne(b: BendArea, q: P3, zmid: number): P3 {
  const { A, u, n, W } = frame(b);
  const th = (Math.abs(b.angle) * Math.PI) / 180; if (th < 1e-9) return q;
  const sgn = b.angle >= 0 ? 1 : -1;
  const Rn = W / th;
  const rel = { x: q.x - A.x, y: q.y - A.y };
  const s = rel.x * n.x + rel.y * n.y, t = rel.x * u.x + rel.y * u.y, h = sgn * (q.z - zmid);
  if (s <= 0) return q;
  let s2: number, h2: number;
  if (s < W) { const ph = s / Rn, rr = Rn - h; s2 = rr * Math.sin(ph); h2 = Rn - rr * Math.cos(ph); }
  else { const rr = Rn - h; s2 = rr * Math.sin(th) + (s - W) * Math.cos(th); h2 = Rn - rr * Math.cos(th) + (s - W) * Math.sin(th); }
  return { x: A.x + u.x * t + n.x * s2, y: A.y + u.y * t + n.y * s2, z: zmid + sgn * h2 };
}

/** Clip a polygon to the half-plane dot(q - A, n) >= c (Sutherland-Hodgman). */
function clipHalf(poly: Pt[], A: Pt, n: Pt, c: number, keepAbove: boolean): Pt[] {
  const out: Pt[] = [];
  const val = (q: Pt) => (dot(sub(q, A), n) - c) * (keepAbove ? 1 : -1);
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length], va = val(a), vb = val(b);
    if (va >= 0) out.push(a);
    if ((va >= 0) !== (vb >= 0)) { const t = va / (va - vb); out.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t }); }
  }
  return out;
}

/** The flat board cut along every bend into rigid pieces and `facets` strips per bend. */
function boardPieces(p: Project, facets: number): Pt[][] {
  let pieces: Pt[][] = [p.outline.slice()];
  for (const b of p.bends ?? []) {
    const { A, n, W } = frame(b);
    const cuts = [0, ...Array.from({ length: facets - 1 }, (_, k) => (W * (k + 1)) / facets), W];
    const next: Pt[][] = [];
    for (const pc of pieces) {
      next.push(clipHalf(pc, A, n, 0, false));
      for (let k = 0; k + 1 < cuts.length; k++) next.push(clipHalf(clipHalf(pc, A, n, cuts[k], true), A, n, cuts[k + 1], false));
      next.push(clipHalf(pc, A, n, W, true));
    }
    pieces = next.filter((q) => q.length >= 3 && Math.abs(q.reduce((s, a, i) => { const c = q[(i + 1) % q.length]; return s + a.x * c.y - c.x * a.y; }, 0)) > 1e-8);
  }
  return pieces;
}

/** Folded 3D solids: board pieces (flex zones at their own thickness around the neutral plane), parts, wire bonds. */
export function bentSolids(p: Project, opts: { facets?: number } = {}): Polyhedron[] {
  const T = p.rules.viaLength || 1.6, zmid = -T / 2;
  const out: Polyhedron[] = [];
  const zones = p.flexZones ?? [];
  // within one bend facet the fold is replaced by the affine map through its two edges, so faces stay planar
  const fold = (q: P3, piece: Pt[]) => {
    const c = piece.reduce((s, a) => ({ x: s.x + a.x / piece.length, y: s.y + a.y / piece.length }), { x: 0, y: 0 });
    for (const b of p.bends ?? []) {
      const { A, n, W } = frame(b);
      const sc = dot(sub(c, A), n);
      if (sc > 0 && sc < W) {
        const ss = piece.map((a) => dot(sub(a, A), n)); const s0 = Math.min(...ss), s1 = Math.max(...ss);
        const s = dot(sub(q, A), n), tt = (s - s0) / Math.max(1e-9, s1 - s0);
        const qa = { x: q.x + n.x * (s0 - s), y: q.y + n.y * (s0 - s), z: q.z }, qb = { x: q.x + n.x * (s1 - s), y: q.y + n.y * (s1 - s), z: q.z };
        const fa = foldPoint(p, qa, zmid), fb = foldPoint(p, qb, zmid);
        return { x: fa.x + (fb.x - fa.x) * tt, y: fa.y + (fb.y - fa.y) * tt, z: fa.z + (fb.z - fa.z) * tt };
      }
    }
    return foldPoint(p, q, zmid);
  };
  boardPieces(p, opts.facets ?? 8).forEach((pc, i) => {
    const c = pc.reduce((s, a) => ({ x: s.x + a.x / pc.length, y: s.y + a.y / pc.length }), { x: 0, y: 0 });
    const z = zones.find((zz) => inPoly(c, zz.points));
    const t = z ? flexThickness(p, z) : T;
    const pr = prism(`PCB_${i}`, pc, zmid - t / 2, zmid + t / 2);
    pr.verts = pr.verts.map((v) => fold(v, pc));
    out.push(pr);
  });
  const lib = { ...defaultLibrary(), ...p.footprints };
  for (const comp of p.components) {
    const fp = lib[comp.footprint]; if (!fp || !fp.body) continue;
    const hw = fp.body.w / 2, hh = fp.body.h / 2, a = (comp.rot * Math.PI) / 180, cs = Math.cos(a), sn = Math.sin(a), m = comp.side === 'back' ? -1 : 1;
    const poly = [[-hw, -hh], [hw, -hh], [hw, hh], [-hw, hh]].map(([x, y]) => ({ x: comp.x + m * x * cs - y * sn, y: comp.y + m * x * sn + y * cs }));
    const z = zones.find((zz) => inPoly(comp, zz.points)); const t = z ? flexThickness(p, z) : T;
    const top = zmid + t / 2, bot = zmid - t / 2, h = heightOf(p, comp);
    const pr = prism(comp.ref, poly, comp.side === 'front' ? top : bot - h, comp.side === 'front' ? top + h : bot);
    pr.verts = pr.verts.map((v) => foldPoint(p, v, zmid));
    out.push(pr);
  }
  for (const w of bondSolids(p)) for (const t of tube(w.name, w.pts.map((q) => foldPoint(p, { x: q.x, y: q.y, z: q.z }, zmid)), w.size)) out.push(t);
  return out;
}

export function exportBentStep(p: Project, opts: { facets?: number } = {}): string { return polyhedraToStep(`${p.name}_bent`, bentSolids(p, opts)); }

/* ------------------------------------------------------------------ fab files */

/** Coverlay (per side: flex zones with openings at the pads, `expansion` larger) and stiffener drawings. */
export function flexFiles(p: Project, name: string, makePlotter: (attrs: string[]) => Plotter, opts: { expansion?: number } = {}): { name: string; content: string }[] {
  const zones = p.flexZones ?? []; if (!zones.length) return [];
  const exp = opts.expansion ?? 0.1;
  const pads = padInstances(p);
  const files: { name: string; content: string }[] = [];
  for (const side of ['front', 'back'] as const) {
    const g = makePlotter([`%TF.FileFunction,Other,Coverlay${side === 'front' ? 'Top' : 'Bot'}*%`, '%TF.FilePolarity,Positive*%']);
    const layer = side === 'front' ? p.layers[0].name : p.layers[p.layers.length - 1].name;
    g.polarity(true);
    for (const z of zones) if (z.coverlay !== false && z.layers.includes(layer)) g.region(z.points);
    g.polarity(false);
    for (const pd of pads) if (pd.layers.includes(layer) && zones.some((z) => inPoly(pd.center, z.points))) {
      const w = pd.w + 2 * exp, h = pd.h + 2 * exp;
      if (pd.shape === 'circle') g.flash(g.circle(Math.max(w, h)), pd.center);
      else { const r = (pd.rot * Math.PI) / 180, c = Math.abs(Math.cos(r)) > 0.7; g.flash(g.rect(c ? w : h, c ? h : w), pd.center); }
    }
    files.push({ name: `${name}-${side === 'front' ? 'F' : 'B'}_Coverlay.gbr`, content: g.toString() });
    const st = (p.stiffeners ?? []).filter((s) => s.side === side);
    if (st.length) { const s = makePlotter([`%TF.FileFunction,Other,Stiffener${side === 'front' ? 'Top' : 'Bot'}*%`]); s.polarity(true); for (const x of st) s.region(x.points); files.push({ name: `${name}-${side === 'front' ? 'F' : 'B'}_Stiffener.gbr`, content: s.toString() }); }
  }
  return files;
}
