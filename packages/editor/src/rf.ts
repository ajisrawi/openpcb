/**
 * RF PCB design (Allegro RF PCB option counterpart): parametric RF copper, ground voids, a frequency-domain network
 * simulator and a full-wave (openEMS FDTD) export.
 *
 *   rfLine     a transmission line along a centre-line, width from the field solver for a target Z0, with square,
 *              optimally mitred (Douglas: M = 52% + 65% e^(-1.35 w/h) for 90 degrees) or curved (radius) bends
 *   rfStub     open or shorted (via to ground) stub, length in mm or in electrical degrees at a frequency; radial stubs
 *   rfTaper    impedance taper between two widths: linear, exponential or Klopfenstein (ripple-optimal)
 *   rfCoupled  edge-coupled pair along a centre-line at a gap (for couplers / differential lines)
 *   rfVoid     ground void: pour cut-out polygons on chosen layers (under launch pads, around RF lines)
 *   All RF elements are stored parametrically (p.rfElements) and drawn as static copper zones; rfRegenerate redraws
 *   one after its parameters change.
 *
 *   rfSimulate ABCD-cascade network analysis between two port pads: the copper path between them is extracted from the
 *              traces (field-solved Z0, effective permittivity and loss per layer and width), vias become series
 *              inductances, two-pin parts on the path are series R/L/C, side branches are open stubs (or shunt parts
 *              to ground at their end); S11/S21 over a sweep, Touchstone .s2p output.
 *   exportOpenEms  Python script for openEMS/CSXCAD: stack-up materials, the copper of the chosen nets as polygons,
 *              reference planes, lumped 50-ohm ports at the port pads, mesh and S-parameter post-processing.
 */
import { type Project, type Pt, nextId, layerIndexOf, copperOf, padToBoard } from './model.js';
import { fieldImpedance, widthForImpedance, stackZ, isReference } from './fieldsolver.js';
import { padInstances } from './connectivity.js';

const C0 = 299.792458;   // mm/ns

export type { RfElement, Void } from './model.js';
import type { RfElement, Void } from './model.js';
type RfProject = Project;

/* ---------------------------------------------------------------- helpers */

/** Dielectric height (mm) from a layer to its nearest reference plane at q. */
export function refHeight(p: Project, layer: string, q?: Pt): number {
  const i = layerIndexOf(p, layer), z = stackZ(p), L = p.layers.length;
  let best = Infinity;
  for (let k = i - 1; k >= 0; k--) if (isReference(p, k, q)) { best = Math.min(best, z.cu[k].y0 - z.cu[i].y1); break; }
  for (let k = i + 1; k < L; k++) if (isReference(p, k, q)) { best = Math.min(best, z.cu[i].y0 - z.cu[k].y1); break; }
  return Number.isFinite(best) ? best : 0.2;
}

/** Guide wavelength (mm) at f GHz for a trace. */
export function guideWavelength(p: Project, layer: string, w: number, ghz: number, at?: Pt): number {
  const lp = fieldImpedance(p, layer, w, { at, freqsGHz: [] });
  return C0 / ghz / Math.sqrt(lp.eeff);
}

const sub = (a: Pt, b: Pt) => ({ x: a.x - b.x, y: a.y - b.y });
const add = (a: Pt, b: Pt) => ({ x: a.x + b.x, y: a.y + b.y });
const mul = (a: Pt, s: number) => ({ x: a.x * s, y: a.y * s });
const len = (a: Pt) => Math.hypot(a.x, a.y);
const unit = (a: Pt) => { const l = len(a) || 1; return { x: a.x / l, y: a.y / l }; };
const perp = (a: Pt) => ({ x: -a.y, y: a.x });
const r5 = (q: Pt) => ({ x: Math.round(q.x * 1e5) / 1e5, y: Math.round(q.y * 1e5) / 1e5 });

/** Centre-line with every interior corner replaced by an arc of radius r. */
function filletCentreline(pts: Pt[], r: number): Pt[] {
  const out: Pt[] = [pts[0]];
  for (let i = 1; i < pts.length - 1; i++) {
    const a = pts[i - 1], b = pts[i], c = pts[i + 1];
    const u1 = unit(sub(b, a)), u2 = unit(sub(c, b));
    const turn = Math.atan2(u1.x * u2.y - u1.y * u2.x, u1.x * u2.x + u1.y * u2.y);
    if (Math.abs(turn) < 1e-3) { out.push(b); continue; }
    const t = Math.min(r * Math.tan(Math.abs(turn) / 2), len(sub(b, a)) / 2, len(sub(c, b)) / 2);
    const rr = t / Math.tan(Math.abs(turn) / 2);
    const p1 = sub(b, mul(u1, t));
    const ctr = add(p1, mul(perp(u1), Math.sign(turn) * rr));
    const a0 = Math.atan2(p1.y - ctr.y, p1.x - ctr.x);
    const n = Math.max(3, Math.ceil(Math.abs(turn) / (Math.PI / 24)));
    for (let k = 0; k <= n; k++) { const ang = a0 + (turn * k) / n; out.push({ x: ctr.x + rr * Math.cos(ang), y: ctr.y + rr * Math.sin(ang) }); }
  }
  out.push(pts[pts.length - 1]);
  return out;
}

/**
 * Outline polygon of a line of width w along `pts`. Corners: 'square' (sharp mitre join), 'miter' (outer corner cut by
 * the fraction M of the corner diagonal), 'curve' (centre-line filleted with radius r).
 */
export function linePolygon(pts: Pt[], w: number, bend: 'square' | 'miter' | 'curve', opts: { miter?: number; radius?: number } = {}): Pt[] {
  const P = bend === 'curve' ? filletCentreline(pts, opts.radius ?? 3 * w) : pts;
  const hw = w / 2;
  const left: Pt[] = [], right: Pt[] = [];
  for (let i = 0; i < P.length; i++) {
    const d0 = i > 0 ? unit(sub(P[i], P[i - 1])) : unit(sub(P[1], P[0]));
    const d1 = i < P.length - 1 ? unit(sub(P[i + 1], P[i])) : d0;
    const n0 = perp(d0), n1 = perp(d1);
    let m = unit(add(n0, n1)); if (len(add(n0, n1)) < 1e-9) m = n0;
    const c = Math.max(0.2, m.x * n1.x + m.y * n1.y);
    const L = add(P[i], mul(m, hw / c)), R = sub(P[i], mul(m, hw / c));
    const turn = d0.x * d1.y - d0.y * d1.x;   // > 0: left turn, the outer side is the right
    if (bend === 'miter' && i > 0 && i < P.length - 1 && Math.abs(turn) > 1e-6) {
      const outer = turn > 0 ? R : L, inner = turn > 0 ? L : R;
      const ang = Math.acos(Math.max(-1, Math.min(1, d0.x * d1.x + d0.y * d1.y)));   // turn angle
      const M = (opts.miter ?? 0.6) * Math.min(1, ang / (Math.PI / 2));
      const diag = sub(inner, outer), cut = add(outer, mul(diag, M));
      // chamfer line through `cut`, perpendicular to the diagonal; its ends on the two outer edges
      const e1 = mul(d0, -1), e2 = d1;   // outer edges leave the outer vertex backwards along d0 and forwards along d1
      const du = unit(diag), dist = len(sub(cut, outer));
      const a1 = dist / Math.max(0.05, Math.abs(e1.x * du.x + e1.y * du.y)), a2 = dist / Math.max(0.05, Math.abs(e2.x * du.x + e2.y * du.y));
      const q1 = add(outer, mul(e1, a1)), q2 = add(outer, mul(e2, a2));
      if (turn > 0) { left.push(inner); right.push(q1, q2); } else { right.push(inner); left.push(q1, q2); }
      continue;
    }
    left.push(L); right.push(R);
  }
  return [...left, ...right.reverse()].map(r5);
}

/** Douglas optimal mitre fraction for a 90-degree bend (w/h >= 0.25). */
export function optimalMiter(w: number, h: number): number { return Math.min(0.95, 0.52 + 0.65 * Math.exp(-1.35 * (w / Math.max(1e-6, h)))); }

/* -------------------------------------------------------------- elements */

function addZones(p: RfProject, el: RfElement, polys: Pt[][]) {
  for (const id of el.zoneIds) { const i = p.zones.findIndex((z) => z.id === id); if (i >= 0) p.zones.splice(i, 1); }
  el.zoneIds = polys.map((pts) => { const id = nextId(p); p.zones.push({ id, net: el.net, layer: el.layer, points: pts, clearance: 0, dynamic: false }); return id; });
}
function widthOf(p: Project, layer: string, o: { width?: number; z0?: number; at?: Pt }): { w: number; z: number } {
  if (o.width) { let z = NaN; try { z = fieldImpedance(p, layer, o.width, { at: o.at, freqsGHz: [] }).z0; } catch { /* no reference */ } return { w: o.width, z }; }
  const r = widthForImpedance(p, layer, o.z0 ?? 50, { at: o.at }); return { w: r.width, z: r.z };
}
const pathLen = (pts: Pt[]) => pts.reduce((s, q, i) => (i ? s + len(sub(q, pts[i - 1])) : 0), 0);

export interface LineOpts { net: string; layer: string; points: Pt[]; z0?: number; width?: number; bend?: 'square' | 'miter' | 'curve'; radius?: number; miter?: number; freqGHz?: number }
export function rfLine(p: RfProject, o: LineOpts, el?: RfElement): RfElement {
  const { w, z } = widthOf(p, o.layer, { width: o.width, z0: o.z0, at: o.points[0] });
  const h = refHeight(p, o.layer, o.points[0]);
  const miter = o.miter ?? optimalMiter(w, h);
  const poly = linePolygon(o.points, w, o.bend ?? 'miter', { miter, radius: o.radius ?? 3 * w });
  const L = pathLen(o.points), f = o.freqGHz ?? 1;
  let lg = NaN; try { lg = guideWavelength(p, o.layer, w, f, o.points[0]); } catch { /* */ }
  const e: RfElement = el ?? { id: nextId(p), kind: 'line', net: o.net, layer: o.layer, params: {}, zoneIds: [], info: {} };
  e.params = { ...o }; e.info = { width: w, z0: z, length: L, miter, electricalDeg: (360 * L) / lg, wavelength: lg, h };
  addZones(p, e, [poly]);
  if (!el) (p.rfElements ??= []).push(e);
  return e;
}

export interface StubOpts { net: string; layer: string; at: Pt; angle: number; length?: number; degrees?: number; freqGHz?: number; z0?: number; width?: number; end?: 'open' | 'short'; radial?: number; ground?: string }
export function rfStub(p: RfProject, o: StubOpts, el?: RfElement): RfElement {
  const { w, z } = widthOf(p, o.layer, { width: o.width, z0: o.z0, at: o.at });
  const f = o.freqGHz ?? 1;
  let lg = NaN; try { lg = guideWavelength(p, o.layer, w, f, o.at); } catch { /* */ }
  // open stubs radiate a little beyond their end: shorten by the open-end extension (Hammerstad) when given in degrees
  const h = refHeight(p, o.layer, o.at);
  const lp = (() => { try { return fieldImpedance(p, o.layer, w, { at: o.at, freqsGHz: [] }); } catch { return null; } })();
  const ee = lp?.eeff ?? 3;
  const dl = 0.412 * h * ((ee + 0.3) * (w / h + 0.264)) / ((ee - 0.258) * (w / h + 0.8));
  let L = o.length ?? ((o.degrees ?? 90) / 360) * lg;
  if (o.length === undefined && (o.end ?? 'open') === 'open') L = Math.max(w, L - dl);
  const d = { x: Math.cos((o.angle * Math.PI) / 180), y: Math.sin((o.angle * Math.PI) / 180) };
  const e: RfElement = el ?? { id: nextId(p), kind: o.radial ? 'radial' : 'stub', net: o.net, layer: o.layer, params: {}, zoneIds: [], info: {} };
  let poly: Pt[];
  if (o.radial) {
    // radial stub: sector of angle `radial` degrees, apex at the attach point
    const a0 = (o.angle - o.radial / 2) * Math.PI / 180, a1 = (o.angle + o.radial / 2) * Math.PI / 180, n = 24;
    poly = [o.at, ...Array.from({ length: n + 1 }, (_, k) => { const a = a0 + ((a1 - a0) * k) / n; return { x: o.at.x + L * Math.cos(a), y: o.at.y + L * Math.sin(a) }; })].map(r5);
  } else poly = linePolygon([o.at, add(o.at, mul(d, L))], w, 'square');
  e.params = { ...o }; e.info = { width: w, z0: z, length: L, electricalDeg: (360 * (L + ((o.end ?? 'open') === 'open' ? dl : 0))) / lg, openEnd: dl };
  addZones(p, e, [poly]);
  // shorted stub: a via to the ground net at the far end
  if ((o.end ?? 'open') === 'short' && !o.radial) {
    const endPt = r5(add(o.at, mul(d, L - Math.max(w, p.rules.viaDiameter) / 2)));
    p.vias.push({ id: nextId(p), net: o.ground ?? 'GND', x: endPt.x, y: endPt.y, diameter: Math.min(w, p.rules.viaDiameter), drill: Math.min(w * 0.5, p.rules.viaDrill) });
    // the stub copper belongs to the RF net; the short is made by giving the end to the ground via: the zone net stays
  }
  if (!el) (p.rfElements ??= []).push(e);
  return e;
}

/** Modified Bessel I1 (series). */
function besselI1(x: number): number { let s = 0, t = x / 2; for (let k = 0; k < 40; k++) { s += t; t *= (x * x / 4) / ((k + 1) * (k + 2)); } return s; }
/** Klopfenstein phi(x, A) = integral_0^x I1(A sqrt(1-y^2)) / (A sqrt(1-y^2)) dy. */
function kPhi(x: number, A: number): number {
  const n = 200; let s = 0;
  for (let k = 0; k < n; k++) { const y = ((k + 0.5) / n) * x; const r = A * Math.sqrt(Math.max(0, 1 - y * y)); s += r < 1e-9 ? 0.5 : besselI1(r) / r; }
  return (s * x) / n;
}

export interface TaperOpts { net: string; layer: string; from: Pt; to: Pt; z1?: number; z2?: number; w1?: number; w2?: number; profile?: 'linear' | 'exponential' | 'klopfenstein'; ripple?: number; steps?: number }
export function rfTaper(p: RfProject, o: TaperOpts, el?: RfElement): RfElement {
  const W1 = widthOf(p, o.layer, { width: o.w1, z0: o.z1, at: o.from }), W2 = widthOf(p, o.layer, { width: o.w2, z0: o.z2, at: o.to });
  const N = o.steps ?? 32, L = len(sub(o.to, o.from)), d = unit(sub(o.to, o.from)), n = perp(d);
  const prof = o.profile ?? 'exponential';
  // width as a function of impedance: a small solver table, interpolated in log space
  const ws = Array.from({ length: 12 }, (_, k) => Math.min(W1.w, W2.w) * 0.7 * Math.pow((Math.max(W1.w, W2.w) * 1.4) / (Math.min(W1.w, W2.w) * 0.7), k / 11));
  const zs = ws.map((w) => { try { return fieldImpedance(p, o.layer, w, { at: o.from, freqsGHz: [] }).z0; } catch { return NaN; } });
  const wOfZ = (z: number) => { for (let k = 0; k + 1 < ws.length; k++) { const a = zs[k], b = zs[k + 1]; if ((z <= a && z >= b) || (z >= a && z <= b)) { const t = (Math.log(z) - Math.log(a)) / (Math.log(b) - Math.log(a)); return Math.exp(Math.log(ws[k]) + t * (Math.log(ws[k + 1]) - Math.log(ws[k]))); } } return z > zs[0] ? ws[0] : ws[ws.length - 1]; };
  const z1 = Number.isFinite(W1.z) ? W1.z : 50, z2 = Number.isFinite(W2.z) ? W2.z : 50;
  const G0 = 0.5 * Math.log(z2 / z1), Gm = o.ripple ?? 0.02, A = Math.acosh(Math.max(1.0001, Math.abs(G0) / Gm));
  const widths: number[] = [];
  for (let k = 0; k <= N; k++) {
    const s = k / N;
    if (prof === 'linear') widths.push(W1.w + (W2.w - W1.w) * s);
    else if (prof === 'exponential') widths.push(wOfZ(z1 * Math.exp(s * Math.log(z2 / z1))));
    else { const lnz = 0.5 * Math.log(z1 * z2) + (G0 / Math.cosh(A)) * A * A * kPhi(2 * s - 1, A); widths.push(wOfZ(Math.exp(lnz))); }
  }
  widths[0] = W1.w; widths[N] = W2.w;
  const leftS = widths.map((w, k) => add(add(o.from, mul(d, (L * k) / N)), mul(n, w / 2)));
  const rightS = widths.map((w, k) => sub(add(o.from, mul(d, (L * k) / N)), mul(n, w / 2)));
  const e: RfElement = el ?? { id: nextId(p), kind: 'taper', net: o.net, layer: o.layer, params: {}, zoneIds: [], info: {} };
  e.params = { ...o }; e.info = { w1: W1.w, w2: W2.w, z1, z2, length: L, ripple: Gm };
  addZones(p, e, [[...leftS, ...rightS.reverse()].map(r5)]);
  if (!el) (p.rfElements ??= []).push(e);
  return e;
}

export interface CoupledOpts { net: string; net2: string; layer: string; points: Pt[]; width: number; gap: number; bend?: 'square' | 'miter' | 'curve' }
export function rfCoupled(p: RfProject, o: CoupledOpts, el?: RfElement): RfElement {
  const off = (o.width + o.gap) / 2;
  const shift = (pts: Pt[], d: number) => pts.map((q, i) => { const d0 = i > 0 ? unit(sub(q, pts[i - 1])) : unit(sub(pts[1], pts[0])); const d1 = i < pts.length - 1 ? unit(sub(pts[i + 1], q)) : d0; let m = unit(add(perp(d0), perp(d1))); const c = Math.max(0.3, m.x * perp(d1).x + m.y * perp(d1).y); return add(q, mul(m, d / c)); });
  const a = linePolygon(shift(o.points, off), o.width, o.bend ?? 'miter'), b = linePolygon(shift(o.points, -off), o.width, o.bend ?? 'miter');
  let zd = NaN, kn = NaN; try { const lp = fieldImpedance(p, o.layer, o.width, { gap: o.gap, at: o.points[0], freqsGHz: [] }); zd = lp.zDiff ?? NaN; kn = lp.kNext ?? NaN; } catch { /* */ }
  const e: RfElement = el ?? { id: nextId(p), kind: 'coupled', net: o.net, layer: o.layer, params: {}, zoneIds: [], info: {} };
  e.params = { ...o }; e.info = { zDiff: zd, couplingDb: 20 * Math.log10(Math.max(1e-9, 2 * Math.abs(kn))), length: pathLen(o.points) };
  // two zones, one per net
  for (const id of e.zoneIds) { const i = p.zones.findIndex((z) => z.id === id); if (i >= 0) p.zones.splice(i, 1); }
  const id1 = nextId(p); p.zones.push({ id: id1, net: o.net, layer: o.layer, points: a, clearance: 0, dynamic: false });
  const id2 = nextId(p); p.zones.push({ id: id2, net: o.net2, layer: o.layer, points: b, clearance: 0, dynamic: false });
  e.zoneIds = [id1, id2];
  if (!el) (p.rfElements ??= []).push(e);
  return e;
}

/** Redraw an RF element from its (edited) parameters. */
export function rfRegenerate(p: RfProject, id: number): RfElement {
  const e = p.rfElements?.find((x) => x.id === id); if (!e) throw new Error(`no RF element ${id}`);
  const o = e.params as never;
  if (e.kind === 'line') return rfLine(p, o, e);
  if (e.kind === 'stub' || e.kind === 'radial') return rfStub(p, o, e);
  if (e.kind === 'taper') return rfTaper(p, o, e);
  return rfCoupled(p, o, e);
}

/** Ground void: pour cut-outs on the given layers (polygon, or a band of `gap` around a net's copper on its layer). */
export function rfVoid(p: RfProject, o: { layers: string[]; points?: Pt[]; around?: { net: string; gap: number }; note?: string }): Void[] {
  const out: Void[] = [];
  const polys: Pt[][] = [];
  if (o.points) polys.push(o.points);
  if (o.around) {
    for (const t of p.traces) if (t.net === o.around.net) polys.push(linePolygon(t.points, t.width + 2 * o.around.gap, 'square'));
    for (const z of p.zones) if (z.net === o.around.net && !z.dynamic) {
      // grow the shape: offset each vertex away from the centroid (adequate for the convex RF shapes made here)
      const c = z.points.reduce((s, q) => add(s, q), { x: 0, y: 0 }); const cc = mul(c, 1 / z.points.length);
      polys.push(z.points.map((q) => add(q, mul(unit(sub(q, cc)), o.around!.gap))).map(r5));
    }
    for (const pd of padInstances(p)) if (pd.net === o.around.net) { const hw = pd.w / 2 + o.around.gap, hh = pd.h / 2 + o.around.gap; polys.push([{ x: pd.center.x - hw, y: pd.center.y - hh }, { x: pd.center.x + hw, y: pd.center.y - hh }, { x: pd.center.x + hw, y: pd.center.y + hh }, { x: pd.center.x - hw, y: pd.center.y + hh }]); }
  }
  for (const layer of o.layers) for (const pts of polys) { const v: Void = { id: nextId(p), layer, points: pts, ...(o.note ? { note: o.note } : {}) }; (p.voids ??= []).push(v); out.push(v); }
  return out;
}

/* ------------------------------------------------------------ simulation */

type Cx = [number, number];
const cadd = (a: Cx, b: Cx): Cx => [a[0] + b[0], a[1] + b[1]];
const csub = (a: Cx, b: Cx): Cx => [a[0] - b[0], a[1] - b[1]];
const cmul = (a: Cx, b: Cx): Cx => [a[0] * b[0] - a[1] * b[1], a[0] * b[1] + a[1] * b[0]];
const cdiv = (a: Cx, b: Cx): Cx => { const d = b[0] * b[0] + b[1] * b[1]; return [(a[0] * b[0] + a[1] * b[1]) / d, (a[1] * b[0] - a[0] * b[1]) / d]; };
const cexp = (a: Cx): Cx => { const m = Math.exp(a[0]); return [m * Math.cos(a[1]), m * Math.sin(a[1])]; };
const ccosh = (a: Cx): Cx => mulS(cadd(cexp(a), cexp([-a[0], -a[1]])), 0.5);
const csinh = (a: Cx): Cx => mulS(csub(cexp(a), cexp([-a[0], -a[1]])), 0.5);
const mulS = (a: Cx, s: number): Cx => [a[0] * s, a[1] * s];
const cabs = (a: Cx) => Math.hypot(a[0], a[1]);
type ABCD = [Cx, Cx, Cx, Cx];
const mm2 = (m: ABCD, n: ABCD): ABCD => [cadd(cmul(m[0], n[0]), cmul(m[1], n[2])), cadd(cmul(m[0], n[1]), cmul(m[1], n[3])), cadd(cmul(m[2], n[0]), cmul(m[3], n[2])), cadd(cmul(m[2], n[1]), cmul(m[3], n[3]))];
const series = (Z: Cx): ABCD => [[1, 0], Z, [0, 0], [1, 0]];
const shunt = (Y: Cx): ABCD => [[1, 0], [0, 0], Y, [1, 0]];
const tline = (Z0: number, gl: Cx): ABCD => [ccosh(gl), mulS(csinh(gl), Z0), mulS(csinh(gl), 1 / Z0), ccosh(gl)];

/** "100n", "4.7k", "10pF", "2n2", "1R5" -> value in base units. */
export function parseValue(v: string): number {
  const s = v.trim().replace(/[ΩFHfh]$/u, '').replace(/ohm$/i, '');
  const m = /^([0-9]*\.?[0-9]+)\s*([pnuµmkMGR]?)([0-9]*)$/u.exec(s);
  if (!m) return NaN;
  const mult: Record<string, number> = { p: 1e-12, n: 1e-9, u: 1e-6, 'µ': 1e-6, m: 1e-3, k: 1e3, M: 1e6, G: 1e9, R: 1, '': 1 };
  const base = parseFloat(m[1] + (m[3] ? '.' + m[3] : ''));
  return base * (mult[m[2]] ?? 1);
}

interface Edge { a: string; b: string; kind: 'line' | 'via' | 'part'; layer?: string; w?: number; len?: number; at?: Pt; part?: { ref: string; value: string; prefix: string }; viaLen?: number; viaDia?: number }

export interface SimResult { freqsGHz: number[]; s11: Cx[]; s21: Cx[]; path: string[]; stubs: number; touchstone: string }

/**
 * Two-port S-parameters between port pads (e.g. "J1-1" -> "J2-1"), reference impedance z0.
 */
export function rfSimulate(p: Project, port1: string, port2: string, opts: { fStartGHz?: number; fStopGHz?: number; points?: number; z0?: number; ground?: string[] } = {}): SimResult {
  const z0 = opts.z0 ?? 50;
  const grounds = new Set(opts.ground ?? ['GND', 'AGND', 'DGND', 'GNDA', 'GROUND', 'VSS']);
  const pads = padInstances(p);
  const key = (q: Pt, layer: string) => `${layer}:${Math.round(q.x * 1000)}:${Math.round(q.y * 1000)}`;
  const edges: Edge[] = [];
  const adj = new Map<string, Edge[]>();
  const link = (e: Edge) => { edges.push(e); for (const n of [e.a, e.b]) { const a = adj.get(n) ?? []; a.push(e); adj.set(n, a); } };
  // trace segments; their end nodes snap onto pad nodes when inside a pad
  const padNode = (pd: typeof pads[number]) => `PAD:${pd.key}`;
  const nodeAt = (q: Pt, layer: string, net: string) => {
    for (const pd of pads) if (pd.net === net && pd.layers.includes(layer) && Math.abs(q.x - pd.center.x) <= pd.w / 2 + 1e-6 && Math.abs(q.y - pd.center.y) <= pd.h / 2 + 1e-6) return padNode(pd);
    for (const v of p.vias) if (v.net === net && Math.hypot(v.x - q.x, v.y - q.y) <= v.diameter / 2 + 1e-6) return `VIA:${v.id}:${layer}`;
    return key(q, layer);
  };
  for (const t of p.traces) for (let i = 1; i < t.points.length; i++) {
    const a = nodeAt(t.points[i - 1], t.layer, t.net), b = nodeAt(t.points[i], t.layer, t.net);
    if (a !== b) link({ a, b, kind: 'line', layer: t.layer, w: t.width, len: len(sub(t.points[i], t.points[i - 1])), at: t.points[i - 1] });
  }
  // parametric RF elements: their centre-lines are transmission-line sections too
  const groundNodes = new Set<string>();
  for (const e of p.rfElements ?? []) {
    const pr = e.params as Record<string, unknown>, w = e.info.width;
    if (e.kind === 'line') { const pts = pr.points as Pt[]; for (let i = 1; i < pts.length; i++) { const a = nodeAt(pts[i - 1], e.layer, e.net), b = nodeAt(pts[i], e.layer, e.net); if (a !== b) link({ a, b, kind: 'line', layer: e.layer, w, len: len(sub(pts[i], pts[i - 1])), at: pts[i - 1] }); } }
    else if (e.kind === 'stub') {
      const at = pr.at as Pt, ang = (Number(pr.angle) * Math.PI) / 180, end = add(at, mul({ x: Math.cos(ang), y: Math.sin(ang) }, e.info.length));
      const a = nodeAt(at, e.layer, e.net), b = key(end, e.layer) + ':stub' + e.id;
      link({ a, b, kind: 'line', layer: e.layer, w, len: e.info.length + (pr.end === 'short' ? 0 : e.info.openEnd ?? 0), at });
      if (pr.end === 'short') groundNodes.add(b);
    } else if (e.kind === 'taper') {
      const A = pr.from as Pt, B = pr.to as Pt, N = 12;
      for (let k = 0; k < N; k++) { const q0 = add(A, mul(sub(B, A), k / N)), q1 = add(A, mul(sub(B, A), (k + 1) / N)); const ww = e.info.w1 + ((e.info.w2 - e.info.w1) * (k + 0.5)) / N; const a = k === 0 ? nodeAt(q0, e.layer, e.net) : key(q0, e.layer), b = k === N - 1 ? nodeAt(q1, e.layer, e.net) : key(q1, e.layer); link({ a, b, kind: 'line', layer: e.layer, w: ww, len: len(sub(q1, q0)), at: q0 }); }
    }
  }
  // vias: the layer nodes of a via are joined through its barrel (series inductance over the span used)
  const stack = stackZ(p);
  for (const v of p.vias) {
    const ls = p.layers.map((l) => l.name);
    const nodes = [...adj.keys()].filter((k) => k.startsWith(`VIA:${v.id}:`));
    for (let i = 1; i < nodes.length; i++) {
      const la = layerIndexOf(p, nodes[0].split(':')[2]), lb = layerIndexOf(p, nodes[i].split(':')[2]);
      const h = Math.abs(stack.cu[la].y1 - stack.cu[lb].y1);
      link({ a: nodes[0], b: nodes[i], kind: 'via', viaLen: h, viaDia: v.drill });
    }
    void ls;
  }
  // T-junctions: a line end lying inside another line segment splits that segment there
  const ptOf = (n: string): Pt | null => { const m = /^([^:]+):(-?\d+):(-?\d+)/.exec(n); return m && !n.startsWith('PAD') && !n.startsWith('VIA') ? { x: Number(m[2]) / 1000, y: Number(m[3]) / 1000 } : null; };
  for (let guard = 0; guard < 4; guard++) {
    let split = false;
    for (const e of edges.slice()) {
      if (e.kind !== 'line') continue;
      for (const endN of [e.a, e.b]) {
        const q = ptOf(endN) ?? (() => { const pd = pads.find((x) => padNode(x) === endN); return pd ? pd.center : null; })(); if (!q) continue;
        for (const f of edges) {
          if (f === e || f.kind !== 'line' || f.layer !== e.layer || f.a === endN || f.b === endN) continue;
          const A = ptOf(f.a) ?? pads.find((x) => padNode(x) === f.a)?.center, B = ptOf(f.b) ?? pads.find((x) => padNode(x) === f.b)?.center; if (!A || !B) continue;
          const d = sub(B, A), L2 = d.x * d.x + d.y * d.y; if (!L2) continue;
          const s = ((q.x - A.x) * d.x + (q.y - A.y) * d.y) / L2; if (s <= 1e-6 || s >= 1 - 1e-6) continue;
          const foot = add(A, mul(d, s)); if (len(sub(foot, q)) > Math.max(f.w ?? 0, e.w ?? 0) / 2 + 1e-6) continue;
          // split f at the foot point into two sections joined at endN
          const fl = f.len ?? Math.sqrt(L2);
          const f2: Edge = { ...f, a: endN, len: fl * (1 - s), at: foot };
          adj.set(f.b, (adj.get(f.b) ?? []).map((x) => (x === f ? f2 : x)));
          f.b = endN; f.len = fl * s;
          adj.get(endN)!.push(f, f2); edges.push(f2);
          split = true; break;
        }
      }
    }
    if (!split) break;
  }
  // two-pin parts: series elements between their pads
  const byRef = new Map<string, typeof pads>(); for (const pd of pads) { const a = byRef.get(pd.ref) ?? []; a.push(pd); byRef.set(pd.ref, a); }
  for (const [ref, ps] of byRef) {
    if (ps.length !== 2) continue;
    const c = p.components.find((x) => x.ref === ref)!; const prefix = /^[A-Za-z]+/.exec(ref)?.[0]?.toUpperCase() ?? '';
    if (!/^(R|C|L|FB)$/.test(prefix)) continue;
    link({ a: padNode(ps[0]), b: padNode(ps[1]), kind: 'part', part: { ref, value: c.value, prefix } });
  }
  // path between the ports (fewest elements; parts to ground are never on the path)
  const P1 = pads.find((x) => x.key === port1), P2 = pads.find((x) => x.key === port2);
  if (!P1 || !P2) throw new Error(`port pad not found: ${!P1 ? port1 : port2}`);
  const s = padNode(P1), tgt = padNode(P2);
  const prev = new Map<string, Edge | null>([[s, null]]);
  const q = [s];
  const groundPad = (n: string) => { if (groundNodes.has(n)) return true; const pd = pads.find((x) => padNode(x) === n); return pd ? grounds.has(pd.net.toUpperCase()) : false; };
  while (q.length && !prev.has(tgt)) { const n = q.shift()!; for (const e of adj.get(n) ?? []) { const m = e.a === n ? e.b : e.a; if (prev.has(m) || groundPad(m)) continue; prev.set(m, e); q.push(m); } }
  if (!prev.has(tgt)) throw new Error(`no copper/part path from ${port1} to ${port2}`);
  const pathE: Edge[] = [], pathN: string[] = [tgt];
  for (let n = tgt; n !== s; ) { const e = prev.get(n)!; pathE.unshift(e); n = e.a === n ? e.b : e.a; pathN.unshift(n); }
  const onPath = new Set(pathE);
  const pathSet = new Set(pathN);
  const lineParams = (e: Edge, ghz: number) => { const lp = fieldImpedance(p, e.layer!, e.w!, { at: e.at, freqsGHz: [ghz] }); return lp; };
  const fStart = opts.fStartGHz ?? 0.1, fStop = opts.fStopGHz ?? 6, N = opts.points ?? 101;
  const freqs = Array.from({ length: N }, (_, k) => fStart + ((fStop - fStart) * k) / Math.max(1, N - 1));
  /** input impedance looking into a branch from node n through edge e (away from `from`), recursively; open ends -> infinite */
  const zin = (e: Edge, from: string, ghz: number, depth: number): Cx | null => {
    const w = 2 * Math.PI * ghz * 1e9;
    const far = e.a === from ? e.b : e.a;
    if (depth > 30) return null;
    // load at the far node: other branches in parallel; a part to ground is a shunt load
    let Yl: Cx = [0, 0];
    for (const f of adj.get(far) ?? []) {
      if (f === e || onPath.has(f)) continue;
      const fz = zin(f, far, ghz, depth + 1); if (fz) Yl = cadd(Yl, cdiv([1, 0], fz));
    }
    const elementZ = (ed: Edge, Zl: Cx | null): Cx | null => {
      if (ed.kind === 'part') { const Zp = partZ(ed, w); return Zl ? cadd(Zp, Zl) : (groundPad(far) ? Zp : null); }
      if (ed.kind === 'via') { const Zv: Cx = [0, w * viaL(ed)]; return Zl ? cadd(Zv, Zl) : null; }
      const lp = lineParams(ed, ghz); const beta = (2 * Math.PI * ghz * Math.sqrt(lp.eeff)) / C0; const alpha = (lp.lossDbPerMm[0]?.total ?? 0) / 8.686;
      const gl: Cx = [alpha * ed.len!, beta * ed.len!];
      const Z0 = lp.z0;
      if (!Zl) return cmul([Z0, 0], cdiv(ccosh(gl), csinh(gl)));   // open: Z0 coth(gl)
      return cmul([Z0, 0], cdiv(cadd(Zl, cmul([Z0, 0], cdiv(csinh(gl), ccosh(gl)))), cadd([Z0, 0], cmul(Zl, cdiv(csinh(gl), ccosh(gl))))));
    };
    const Zl = Yl[0] === 0 && Yl[1] === 0 ? (groundPad(far) ? [0, 0] as Cx : null) : cdiv([1, 0], Yl);
    return elementZ(e, Zl);
  };
  const viaL = (e: Edge) => { const h = e.viaLen ?? 1, d = e.viaDia ?? 0.3; return 0.2e-9 * h * (Math.log((4 * h) / d) + 1); };   // nH/mm formula, h and d in mm
  const partZ = (e: Edge, w: number): Cx => {
    const v = parseValue(e.part!.value);
    if (e.part!.prefix === 'R' || e.part!.prefix === 'FB') return [Number.isFinite(v) ? v : 0, 0];
    if (e.part!.prefix === 'L') return [0, w * (Number.isFinite(v) ? v : 0)];
    if (e.part!.prefix === 'C') { const Cv = Number.isFinite(v) && v > 0 ? v : 1e-9; const esl = 0.5e-9; return [0.05, w * esl - 1 / (w * Cv)]; }
    return [0, 0];
  };
  const s11: Cx[] = [], s21: Cx[] = [];
  let stubs = 0;
  for (const ghz of freqs) {
    const w = 2 * Math.PI * ghz * 1e9;
    let M: ABCD = [[1, 0], [0, 0], [0, 0], [1, 0]];
    for (let i = 0; i < pathE.length; i++) {
      const e = pathE[i], from = pathN[i];
      // shunt branches hanging off the node we are at
      if (i > 0 || true) for (const f of adj.get(from) ?? []) {
        if (onPath.has(f)) continue;
        const other = f.a === from ? f.b : f.a; if (pathSet.has(other)) continue;
        const z = zin(f, from, ghz, 0); if (z && cabs(z) > 1e-12) { M = mm2(M, shunt(cdiv([1, 0], z))); if (ghz === freqs[0]) stubs++; }
      }
      if (e.kind === 'part') M = mm2(M, series(partZ(e, w)));
      else if (e.kind === 'via') M = mm2(M, series([0, w * viaL(e)]));
      else {
        const lp = lineParams(e, ghz);
        const beta = (2 * Math.PI * ghz * Math.sqrt(lp.eeff)) / C0;   // rad/mm
        const alpha = (lp.lossDbPerMm[0]?.total ?? 0) / 8.686;      // Np/mm
        M = mm2(M, tline(lp.z0, [alpha * e.len!, beta * e.len!]));
      }
    }
    const [A, B, Cc, D] = M;
    const den = cadd(cadd(A, mulS(B, 1 / z0)), cadd(mulS(Cc, z0), D));
    s11.push(cdiv(csub(cadd(A, mulS(B, 1 / z0)), cadd(mulS(Cc, z0), D)), den));
    s21.push(cdiv([2, 0], den));
  }
  const db = (c: Cx) => 20 * Math.log10(Math.max(1e-15, cabs(c)));
  const ang = (c: Cx) => (Math.atan2(c[1], c[0]) * 180) / Math.PI;
  const ts = [`! OpenBoard RF network analysis ${port1} -> ${port2} (reciprocal, symmetric approximation for S22)`, `# GHZ S DB R ${z0}`,
    ...freqs.map((f, k) => `${f.toFixed(6)} ${db(s11[k]).toFixed(4)} ${ang(s11[k]).toFixed(3)} ${db(s21[k]).toFixed(4)} ${ang(s21[k]).toFixed(3)} ${db(s21[k]).toFixed(4)} ${ang(s21[k]).toFixed(3)} ${db(s11[k]).toFixed(4)} ${ang(s11[k]).toFixed(3)}`), ''].join('\n');
  return { freqsGHz: freqs, s11, s21, path: pathN.map((n) => n.replace(/^PAD:/, '')), stubs, touchstone: ts };
}

/* ---------------------------------------------------------- openEMS export */

/**
 * openEMS (FDTD) model of the chosen nets: Python script for CSXCAD/openEMS. Units mm. Dielectrics as boxes per slab,
 * reference planes as metal boxes, copper of the nets as extruded polygons (traces via their outline), lumped ports
 * between each port pad and the plane below, mesh from the geometry edges with smoothing, S-parameters at the end.
 */
export function exportOpenEms(p: Project, o: { nets: string[]; ports: string[]; fmaxGHz?: number; margin?: number }): string {
  const z = stackZ(p), L = p.layers.length;
  const fmax = o.fmaxGHz ?? 10, margin = o.margin ?? 3;
  const nets = new Set(o.nets);
  const polys: { layer: number; pts: Pt[] }[] = [];
  for (const t of p.traces) if (nets.has(t.net)) polys.push({ layer: layerIndexOf(p, t.layer), pts: linePolygon(t.points, t.width, 'square') });
  for (const zz of p.zones) if (nets.has(zz.net)) polys.push({ layer: layerIndexOf(p, zz.layer), pts: zz.points });
  const pads = padInstances(p);
  for (const pd of pads) if (nets.has(pd.net)) for (const ln of pd.layers) { const hw = pd.w / 2, hh = pd.h / 2; polys.push({ layer: layerIndexOf(p, ln), pts: [{ x: pd.center.x - hw, y: pd.center.y - hh }, { x: pd.center.x + hw, y: pd.center.y - hh }, { x: pd.center.x + hw, y: pd.center.y + hh }, { x: pd.center.x - hw, y: pd.center.y + hh }] }); }
  const xs = polys.flatMap((q) => q.pts.map((r) => r.x)), ys = polys.flatMap((q) => q.pts.map((r) => r.y));
  const bx0 = Math.min(...xs) - margin, bx1 = Math.max(...xs) + margin, by0 = Math.min(...ys) - margin, by1 = Math.max(...ys) + margin;
  const f = (v: number) => (Math.round(v * 1e4) / 1e4).toString();
  const lines: string[] = [
    '# openEMS model generated by OpenBoard (RF PCB). Requires openEMS + CSXCAD Python bindings.',
    'import os, numpy as np',
    'from CSXCAD import ContinuousStructure',
    'from openEMS import openEMS',
    'from openEMS.physical_constants import C0',
    `unit = 1e-3; f_max = ${fmax}e9; f0 = f_max / 2; fc = f_max / 2`,
    'FDTD = openEMS(NrTS=60000, EndCriteria=1e-4)',
    'FDTD.SetGaussExcite(f0, fc)',
    "FDTD.SetBoundaryCond(['PML_8'] * 6)",
    'CSX = ContinuousStructure()',
    'FDTD.SetCSX(CSX)',
    'mesh = CSX.GetGrid(); mesh.SetDeltaUnit(unit)',
    'metal = CSX.AddMetal("copper")',
  ];
  // dielectrics
  z.diel.forEach((d, i) => { lines.push(`sub${i} = CSX.AddMaterial("diel${i}", epsilon=${d.er}, kappa=${(2 * Math.PI * fmax / 2 * 1e9 * 8.854e-12 * d.er * d.tand).toExponential(4)})`, `sub${i}.AddBox([${f(bx0)}, ${f(by0)}, ${f(d.y0)}], [${f(bx1)}, ${f(by1)}, ${f(d.y1)}], priority=0)`); });
  // reference planes (plane layers / pours of other nets) as metal sheets
  for (let k = 0; k < L; k++) if (p.layers[k].type === 'power' || p.zones.some((zz) => zz.layer === p.layers[k].name && !nets.has(zz.net))) lines.push(`metal.AddBox([${f(bx0)}, ${f(by0)}, ${f(z.cu[k].y0)}], [${f(bx1)}, ${f(by1)}, ${f(z.cu[k].y1)}], priority=5)  # ${p.layers[k].name} reference`);
  // net copper
  polys.forEach((q, i) => { const zz = z.cu[q.layer]; lines.push(`metal.AddLinPoly(points=np.array([[${q.pts.map((r) => f(r.x)).join(', ')}], [${q.pts.map((r) => f(r.y)).join(', ')}]]), norm_dir='z', elevation=${f(zz.y0)}, length=${f(zz.y1 - zz.y0)}, priority=10)  # ${i}`); });
  // ports
  o.ports.forEach((key, i) => {
    const pd = pads.find((x) => x.key === key); if (!pd) return;
    const li = layerIndexOf(p, pd.layers[0]);
    let ref = -1; for (let k = li + 1; k < L; k++) if (isReference(p, k, pd.center)) { ref = k; break; }
    if (ref < 0) for (let k = li - 1; k >= 0; k--) if (isReference(p, k, pd.center)) { ref = k; break; }
    const zTop = z.cu[li].y0, zRef = ref >= 0 ? z.cu[ref].y1 : z.cu[L - 1].y0;
    const hw = Math.min(pd.w, pd.h) / 2;
    lines.push(`port${i + 1} = FDTD.AddLumpedPort(${i + 1}, 50, [${f(pd.center.x - hw)}, ${f(pd.center.y - hw)}, ${f(Math.min(zTop, zRef))}], [${f(pd.center.x + hw)}, ${f(pd.center.y + hw)}, ${f(Math.max(zTop, zRef))}], 'z', excite=${i === 0 ? 1 : 0}, priority=20)  # ${key}`);
  });
  lines.push(
    `mesh.AddLine('x', [${f(bx0)}, ${f(bx1)}]); mesh.AddLine('y', [${f(by0)}, ${f(by1)}]); mesh.AddLine('z', [${f(-margin)}, ${f(z.top + margin)}])`,
    `mesh.AddLine('z', [${[...new Set(z.cu.flatMap((c) => [c.y0, c.y1]))].map(f).join(', ')}])`,
    "for d in 'xyz':",
    '    mesh.SmoothMeshLines(d, C0 / f_max / unit / 20, 1.4)',
    "sim = os.path.join(os.getcwd(), 'openboard_rf')",
    'FDTD.Run(sim, cleanup=True)',
    'f = np.linspace(max(1e6, f0 - fc), f0 + fc, 401)',
    'for prt in [p for p in [globals().get("port%d" % i) for i in range(1, 9)] if p is not None]: prt.CalcPort(sim, f)',
    's11 = port1.uf_ref / port1.uf_inc',
    'out = ["# Hz S RI R 50"] + ["%g %g %g" % (fi, s.real, s.imag) for fi, s in zip(f, s11)]',
    "if 'port2' in globals(): s21 = port2.uf_ref / port1.uf_inc; out = [\"# Hz S RI R 50\"] + [\"%g %g %g %g %g %g %g %g %g\" % (fi, a.real, a.imag, b.real, b.imag, b.real, b.imag, a.real, a.imag) for fi, a, b in zip(f, s11, s21)]",
    "open('openboard_rf.s%dp' % (2 if 'port2' in globals() else 1), 'w').write('\\n'.join(out))",
    '');
  void copperOf; void padToBoard;
  return lines.join('\n');
}
