/**
 * 2D quasi-static field solver for transmission-line cross-sections (Allegro Sigrity/"Field solver" counterpart).
 *
 * The cross-section (trace conductors, reference planes, dielectric slabs, solder mask, air) is meshed with a uniform
 * square grid; Laplace's equation div(eps grad V) = 0 is solved by preconditioned conjugate gradients with the
 * conductors as fixed potentials. Charges give the Maxwell capacitance matrix C; a second solve with every
 * dielectric replaced by air gives C0 and so L = (1/c^2) C0^-1. From these: Z0 / effective permittivity / delay for a
 * single line, odd/even/differential/common impedance for a coupled pair, NEXT/FEXT coefficients, dielectric loss
 * from the field energy in each lossy slab (G = w * sum eps*tan(d)*|E|^2) and conductor loss from Wheeler's
 * incremental-inductance rule (every metal wall receded by one cell: R = Rs/mu0 * dL/dn).
 */
import { type Project, type Pt, copperOf, layerIndexOf } from './model.js';

const EPS0 = 8.8541878128e-12;
const MU0 = 4e-7 * Math.PI;
const CL = 299792458;               // m/s
const RHO_CU = 1.72e-8;

export interface XConductor { x0: number; y0: number; x1: number; y1: number; kind: 'signal' | 'ground' }
export interface XSlab { y0: number; y1: number; er: number; tand: number }
export interface XSection { conductors: XConductor[]; slabs: XSlab[]; x0: number; x1: number; y0: number; y1: number; topOpen: boolean; bottomOpen: boolean }

export interface SolveResult { C: number[][]; C0: number[][]; L: number[][]; G1: number[]; cell: number; nx: number; ny: number; iterations: number }

/** Mesh and solve; returns per-unit-length matrices (F/m, H/m) over the signal conductors (in order). */
export function solveXSection(xs: XSection, opts: { maxNodes?: number; cell?: number } = {}): SolveResult {
  const W = xs.x1 - xs.x0, H = xs.y1 - xs.y0;
  const sig = xs.conductors.filter((c) => c.kind === 'signal').sort((a, b) => a.x0 - b.x0);
  // smallest feature: conductor sizes, gaps, slab thicknesses
  let feat = Infinity;
  for (const c of sig) feat = Math.min(feat, c.x1 - c.x0, c.y1 - c.y0);
  for (const s of xs.slabs) if (s.y1 - s.y0 > 1e-9) feat = Math.min(feat, s.y1 - s.y0);
  for (let i = 1; i < sig.length; i++) feat = Math.min(feat, sig[i].x0 - sig[i - 1].x1);
  const dMin = opts.cell ?? Math.max(feat / 6, Math.min(W, H) * 1e-5);
  const dMax = Math.min(W, H) / 25;
  // graded tensor grid: lines at every edge/interface, spacing growing geometrically away from them
  const graded = (lo: number, hi: number, keys: number[]): number[] => {
    const ks = [...new Set(keys.filter((k) => k >= lo - 1e-12 && k <= hi + 1e-12).concat([lo, hi]).map((k) => Math.round(k * 1e9) / 1e9))].sort((a, b) => a - b);
    const out: number[] = [];
    for (let i = 0; i + 1 < ks.length; i++) {
      const a = ks[i], b = ks[i + 1], L = b - a;
      const left: number[] = [], right: number[] = [];
      let s = dMin, x = a, y = b;
      while (y - x > 2 * Math.min(s, dMax)) { const st = Math.min(s, dMax); x += st; y -= st; left.push(x); right.push(y); s *= 1.3; }
      out.push(a, ...left);
      if (y - x > 1e-9 && L > 2 * dMin) out.push((x + y) / 2);
      out.push(...right.reverse());
    }
    out.push(ks[ks.length - 1]);
    const r = [...new Set(out.map((v) => Math.round(v * 1e9) / 1e9))].sort((a, b) => a - b);
    return r.filter((v, i) => i === 0 || v - r[i - 1] > dMin * 0.2);
  };
  const xk: number[] = [], yk: number[] = [];
  for (const c of xs.conductors) { xk.push(c.x0, c.x1); yk.push(c.y0, c.y1); }
  for (const s of xs.slabs) yk.push(s.y0, s.y1);
  const gx = graded(xs.x0, xs.x1, xk), gy = graded(xs.y0, xs.y1, yk);
  const nx = gx.length, ny = gy.length;
  const dx = gx.slice(1).map((v, i) => v - gx[i]), dy = gy.slice(1).map((v, i) => v - gy[i]);
  const er = new Float64Array((nx - 1) * (ny - 1)), td = new Float64Array((nx - 1) * (ny - 1));
  for (let j = 0; j < ny - 1; j++) {
    const yc = (gy[j] + gy[j + 1]) / 2;
    let e = 1, t = 0;
    for (const s of xs.slabs) if (yc >= s.y0 && yc < s.y1) { e = s.er; t = s.tand; }
    for (let i = 0; i < nx - 1; i++) { er[i * (ny - 1) + j] = e; td[i * (ny - 1) + j] = t; }
  }
  const own = new Int32Array(nx * ny).fill(-1);
  const tol = dMin * 1e-3;
  xs.conductors.forEach((c, k) => {
    for (let i = 0; i < nx; i++) { if (gx[i] < c.x0 - tol || gx[i] > c.x1 + tol) continue; for (let j = 0; j < ny; j++) if (gy[j] >= c.y0 - tol && gy[j] <= c.y1 + tol) own[i * ny + j] = k; }
  });
  const sigIdx = xs.conductors.map((c, k) => (c.kind === 'signal' ? k : -1)).filter((k) => k >= 0).sort((a, b) => xs.conductors[a].x0 - xs.conductors[b].x0);
  const N = sigIdx.length;
  let iters = 0;
  const solve = (air: boolean, k: number) => {
    const e = (i: number, j: number) => (i < 0 || j < 0 || i >= nx - 1 || j >= ny - 1 ? 0 : air ? 1 : er[i * (ny - 1) + j]);
    const DY = (j: number) => (j < 0 || j >= ny - 1 ? 0 : dy[j]), DX = (i: number) => (i < 0 || i >= nx - 1 ? 0 : dx[i]);
    // flux coefficient of edge (i,j)-(i+1,j): eps of the cells above/below weighted by their half heights, over dx
    const cx = (i: number, j: number) => (e(i, j - 1) * DY(j - 1) + e(i, j) * DY(j)) / (2 * dx[i]);
    const cy = (i: number, j: number) => (e(i - 1, j) * DX(i - 1) + e(i, j) * DX(i)) / (2 * dy[j]);
    const n2 = nx * ny;
    const V = new Float64Array(n2), fixed = new Uint8Array(n2);
    for (let n = 0; n < n2; n++) if (own[n] >= 0) { fixed[n] = 1; V[n] = own[n] === k ? 1 : 0; }
    for (let i = 0; i < nx; i++) { if (xs.topOpen) { fixed[i * ny + ny - 1] = 1; V[i * ny + ny - 1] = 0; } if (xs.bottomOpen) { fixed[i * ny] = 1; V[i * ny] = 0; } }
    const CX = new Float64Array(n2), CY = new Float64Array(n2);
    for (let i = 0; i < nx; i++) for (let j = 0; j < ny; j++) { const n = i * ny + j; if (i + 1 < nx) CX[n] = cx(i, j); if (j + 1 < ny) CY[n] = cy(i, j); }
    const diag = new Float64Array(n2), b = new Float64Array(n2);
    for (let i = 0; i < nx; i++) for (let j = 0; j < ny; j++) {
      const n = i * ny + j; if (fixed[n]) continue;
      let d = 0, s = 0;
      const nb = (m: number, c: number) => { if (c === 0) return; d += c; if (fixed[m]) s += c * V[m]; };
      if (i + 1 < nx) nb(n + ny, CX[n]); if (i > 0) nb(n - ny, CX[n - ny]); if (j + 1 < ny) nb(n + 1, CY[n]); if (j > 0) nb(n - 1, CY[n - 1]);
      diag[n] = d; b[n] = s;
    }
    const Ax = (x: Float64Array, out: Float64Array) => {
      for (let i = 0; i < nx; i++) for (let j = 0; j < ny; j++) {
        const n = i * ny + j; if (fixed[n]) { out[n] = 0; continue; }
        let v = diag[n] * x[n];
        if (i + 1 < nx && !fixed[n + ny]) v -= CX[n] * x[n + ny];
        if (i > 0 && !fixed[n - ny]) v -= CX[n - ny] * x[n - ny];
        if (j + 1 < ny && !fixed[n + 1]) v -= CY[n] * x[n + 1];
        if (j > 0 && !fixed[n - 1]) v -= CY[n - 1] * x[n - 1];
        out[n] = v;
      }
    };
    const x = new Float64Array(n2), r = new Float64Array(n2), z = new Float64Array(n2), pp = new Float64Array(n2), Ap = new Float64Array(n2);
    for (let n = 0; n < n2; n++) if (!fixed[n]) { r[n] = b[n]; z[n] = diag[n] ? r[n] / diag[n] : 0; pp[n] = z[n]; }
    let rz = 0, bn = 0; for (let n = 0; n < n2; n++) { rz += r[n] * z[n]; bn += b[n] * b[n]; }
    for (let it = 0; it < 50000; it++) {
      Ax(pp, Ap);
      let pAp = 0; for (let n = 0; n < n2; n++) pAp += pp[n] * Ap[n];
      if (!(pAp > 0)) break;
      const a = rz / pAp;
      let rr = 0;
      for (let n = 0; n < n2; n++) { if (fixed[n]) continue; x[n] += a * pp[n]; r[n] -= a * Ap[n]; rr += r[n] * r[n]; }
      iters++;
      if (rr < 1e-24 * bn) break;
      let rz2 = 0; for (let n = 0; n < n2; n++) { if (fixed[n]) continue; z[n] = diag[n] ? r[n] / diag[n] : 0; rz2 += r[n] * z[n]; }
      const beta = rz2 / rz; rz = rz2;
      for (let n = 0; n < n2; n++) if (!fixed[n]) pp[n] = z[n] + beta * pp[n];
    }
    for (let n = 0; n < n2; n++) if (!fixed[n]) V[n] = x[n];
    const Q = new Float64Array(xs.conductors.length);
    let lossW = 0;
    const tdE = (i: number, j: number) => (i < 0 || j < 0 || i >= nx - 1 || j >= ny - 1 ? 0 : er[i * (ny - 1) + j] * td[i * (ny - 1) + j]);
    const edge = (n: number, m: number, c: number, cl: number) => {
      const on = own[n], om = own[m];
      if (on >= 0 && on !== om) Q[on] += c * (V[n] - V[m]);
      if (om >= 0 && om !== on) Q[om] += c * (V[m] - V[n]);
      const dv = V[n] - V[m]; lossW += cl * dv * dv;
    };
    for (let i = 0; i < nx; i++) for (let j = 0; j < ny; j++) {
      const n = i * ny + j;
      if (i + 1 < nx) edge(n, n + ny, CX[n], air ? 0 : (tdE(i, j - 1) * DY(j - 1) + tdE(i, j) * DY(j)) / (2 * dx[i]));
      if (j + 1 < ny) edge(n, n + 1, CY[n], air ? 0 : (tdE(i - 1, j) * DX(i - 1) + tdE(i, j) * DX(i)) / (2 * dy[j]));
    }
    return { q: sigIdx.map((s) => Q[s] * EPS0), loss: lossW * EPS0 };
  };
  const C = sigIdx.map(() => new Array(N).fill(0)), C0 = sigIdx.map(() => new Array(N).fill(0));
  const G1: number[] = [];
  sigIdx.forEach((k, a) => {
    const s1 = solve(false, k), s0 = solve(true, k);
    for (let b2 = 0; b2 < N; b2++) { C[b2][a] = s1.q[b2]; C0[b2][a] = s0.q[b2]; }
    G1.push(s1.loss);
  });
  const L = inv(C0).map((row) => row.map((v) => v / (CL * CL)));
  void opts.maxNodes;
  return { C: sym(C), C0: sym(C0), L, G1, cell: dMin, nx, ny, iterations: iters };
}

const sym = (M: number[][]) => M.map((r, i) => r.map((v, j) => (v + M[j][i]) / 2));
function inv(M: number[][]): number[][] {
  const n = M.length, A = M.map((r, i) => [...r, ...Array.from({ length: n }, (_, j) => (i === j ? 1 : 0))]);
  for (let c = 0; c < n; c++) {
    let p = c; for (let r = c + 1; r < n; r++) if (Math.abs(A[r][c]) > Math.abs(A[p][c])) p = r;
    [A[c], A[p]] = [A[p], A[c]];
    const d = A[c][c]; for (let j = 0; j < 2 * n; j++) A[c][j] /= d;
    for (let r = 0; r < n; r++) if (r !== c) { const f = A[r][c]; for (let j = 0; j < 2 * n; j++) A[r][j] -= f * A[c][j]; }
  }
  return A.map((r) => r.slice(n));
}

export interface LineParams {
  z0: number; eeff: number; tpdPsPerMm: number; C: number; L: number;          // single line (conductor 0)
  zOdd?: number; zEven?: number; zDiff?: number; zCommon?: number;           // pair
  kNext?: number; kFextPerMm?: number;                                       // coupling (pair): backward coefficient, forward per mm per ns rise
  rdcPerMm: number; lossDbPerMm: { ghz: number; conductor: number; dielectric: number; total: number }[];
  cell: number; nodes: number;
}

/** Line parameters of a cross-section (conductor widths in mm); losses at the given frequencies (GHz). */
export function lineParams(xs: XSection, opts: { freqsGHz?: number[]; rho?: number; maxNodes?: number } = {}): LineParams {
  const mm = (v: number) => v / 1000;   // solver works in mm, results per metre -> per mm conversions below
  const s = solveXSection(xs, { maxNodes: opts.maxNodes });
  // per-unit-length values are scale-free in 2D (capacitance per metre), so mm coordinates are fine
  const C11 = s.C[0][0], L11 = s.L[0][0];
  const z0 = Math.sqrt(L11 / C11), eeff = C11 / s.C0[0][0], tpd = Math.sqrt(L11 * C11);   // s/m
  const out: LineParams = { z0, eeff, tpdPsPerMm: tpd * 1e9, C: C11, L: L11, rdcPerMm: 0, lossDbPerMm: [], cell: s.cell, nodes: s.nx * s.ny };
  if (s.C.length >= 2) {
    const C12 = s.C[0][1], L12 = s.L[0][1];
    const zo = Math.sqrt((L11 - L12) / (C11 - C12)), ze = Math.sqrt((L11 + L12) / (C11 + C12));
    out.zOdd = zo; out.zEven = ze; out.zDiff = 2 * zo; out.zCommon = ze / 2;
    out.kNext = 0.25 * (-C12 / C11 + L12 / L11);
    out.kFextPerMm = 0.5 * (L12 / L11 + C12 / C11) * tpd * 1e9 / 1;   // FEXT = kFext * length(mm) / rise(ns) [sign: + means inverted]
  }
  // conductor loss: Wheeler's incremental inductance (walls receded by one cell)
  const rho = opts.rho ?? RHO_CU;
  const sig = xs.conductors.filter((c) => c.kind === 'signal').sort((a, b) => a.x0 - b.x0)[0];
  out.rdcPerMm = rho / (mm(sig.x1 - sig.x0) * mm(sig.y1 - sig.y0)) / 1000;
  const d = Math.min(sig.x1 - sig.x0, sig.y1 - sig.y0) / 20;
  const shrunk: XSection = { ...xs, conductors: xs.conductors.map((c) => c.kind === 'signal' ? { ...c, x0: c.x0 + d, x1: c.x1 - d, y0: c.y0 + d, y1: c.y1 - d } : c) };
  // planes receded towards themselves
  const sigs = xs.conductors.filter((c) => c.kind === 'signal');
  shrunk.conductors = shrunk.conductors.map((c) => c.kind === 'ground' ? { ...c, y1: sigs.some((q) => q.y0 >= c.y1 - 1e-9) ? c.y1 - d : c.y1, y0: sigs.some((q) => q.y1 <= c.y0 + 1e-9) ? c.y0 + d : c.y0 } : c);
  let dLdn = 0;
  try {
    const s2 = solveXSection(shrunk, { cell: s.cell });
    dLdn = (s2.L[0][0] - L11) / mm(d);   // H/m per m
  } catch { /* too thin to shrink */ }
  for (const ghz of opts.freqsGHz ?? [1, 5, 10]) {
    const f = ghz * 1e9, w = 2 * Math.PI * f;
    const Rs = Math.sqrt(Math.PI * f * MU0 * rho);
    const rac = Math.max(0, (Rs / MU0) * dLdn);                       // ohm/m
    const R = Math.sqrt((out.rdcPerMm * 1000) ** 2 + rac ** 2);
    const G = w * s.G1[0];                                           // S/m
    const ac = R / (2 * z0), ad = (G * z0) / 2;                      // Np/m
    out.lossDbPerMm.push({ ghz, conductor: (8.686 * ac) / 1000, dielectric: (8.686 * ad) / 1000, total: (8.686 * (ac + ad)) / 1000 });
  }
  return out;
}

/* ================================ from the stack-up ================================ */

/** z (mm, 0 = bottom of the board) of each layer's copper and the dielectric below it. */
export function stackZ(p: Project): { cu: { y0: number; y1: number }[]; diel: { y0: number; y1: number; er: number; tand: number }[]; top: number } {
  const L = p.layers.length;
  const t = p.layers.map((l) => copperOf(p, l.name));
  const d = p.layers.map((_, i) => (i < L - 1 ? dielBelow(p, i) : 0));
  const total = t.reduce((a, b) => a + b, 0) + d.reduce((a, b) => a + b, 0);
  let y = total;
  const cu: { y0: number; y1: number }[] = [], diel: { y0: number; y1: number; er: number; tand: number }[] = [];
  for (let i = 0; i < L; i++) {
    cu.push({ y0: y - t[i], y1: y }); y -= t[i];
    if (i < L - 1) { diel.push({ y0: y - d[i], y1: y, er: p.layers[i].er ?? 4.3, tand: p.layers[i].lossTangent ?? 0.02 }); y -= d[i]; }
  }
  return { cu, diel, top: total };
}
function dielBelow(p: Project, i: number): number {
  const L = p.layers.length; if (i >= L - 1) return 0;
  const set = p.layers[i].dielectric; if (set) return set;
  const cu = p.layers.reduce((s, l) => s + copperOf(p, l.name), 0);
  const fixed = p.layers.reduce((s, l, k) => s + (k < L - 1 && l.dielectric ? l.dielectric : 0), 0);
  const free = p.layers.filter((l, k) => k < L - 1 && !l.dielectric).length;
  return Math.max(0.05, ((p.rules.viaLength || 1.6) - cu - fixed) / Math.max(1, free));
}

const inPoly = (q: Pt, poly: Pt[]) => { let ins = false; for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) { const a = poly[i], b = poly[j]; if ((a.y > q.y) !== (b.y > q.y) && q.x < ((b.x - a.x) * (q.y - a.y)) / (b.y - a.y) + a.x) ins = !ins; } return ins; };

/** Is layer k a reference plane at point q: a plane layer, or a pour (zone) there. */
export function isReference(p: Project, k: number, q?: Pt): boolean {
  if (p.layers[k].type === 'power') return true;
  if (!q) return false;
  return p.zones.some((z) => z.layer === p.layers[k].name && inPoly(q, z.points));
}

/**
 * Cross-section of a trace (or a pair, with `gap`) of width w on a layer, at point q of the board: the nearest
 * reference planes above and below, the dielectrics in between, solder mask and air on the outer layers.
 * `coplanar` adds same-layer ground beside the trace(s) at that spacing.
 */
export function stackupCrossSection(p: Project, layer: string, w: number, opts: { gap?: number; coplanar?: number; at?: Pt } = {}): XSection {
  const i = layerIndexOf(p, layer); if (i < 0) throw new Error(`no layer ${layer}`);
  const L = p.layers.length, z = stackZ(p);
  let above = -1, below = -1;
  for (let k = i - 1; k >= 0; k--) if (isReference(p, k, opts.at)) { above = k; break; }
  for (let k = i + 1; k < L; k++) if (isReference(p, k, opts.at)) { below = k; break; }
  if (above < 0 && below < 0) throw new Error(`layer ${layer} has no reference plane`);
  const cuT = z.cu[i];
  const yBot = below >= 0 ? z.cu[below].y0 : -0;
  const yTopRef = above >= 0 ? z.cu[above].y1 : -0;
  const hRef = Math.min(above >= 0 ? yTopRef - cuT.y1 : Infinity, below >= 0 ? cuT.y0 - z.cu[below].y1 : Infinity);
  const pairW = opts.gap !== undefined ? 2 * w + opts.gap : w;
  const span = Math.max(pairW + 2 * (opts.coplanar ?? 0) + 2 * w, pairW + 24 * hRef, 12 * w);
  const conductors: XConductor[] = [];
  const x0 = -span / 2, x1 = span / 2;
  if (opts.gap !== undefined) { conductors.push({ x0: -opts.gap / 2 - w, x1: -opts.gap / 2, y0: cuT.y0, y1: cuT.y1, kind: 'signal' }, { x0: opts.gap / 2, x1: opts.gap / 2 + w, y0: cuT.y0, y1: cuT.y1, kind: 'signal' }); }
  else conductors.push({ x0: -w / 2, x1: w / 2, y0: cuT.y0, y1: cuT.y1, kind: 'signal' });
  if (opts.coplanar !== undefined) { const e = pairW / 2 + opts.coplanar; conductors.push({ x0, x1: -e, y0: cuT.y0, y1: cuT.y1, kind: 'ground' }, { x0: e, x1, y0: cuT.y0, y1: cuT.y1, kind: 'ground' }); }
  if (above >= 0) conductors.push({ x0, x1, y0: z.cu[above].y0, y1: z.cu[above].y1, kind: 'ground' });
  if (below >= 0) conductors.push({ x0, x1, y0: z.cu[below].y0, y1: z.cu[below].y1, kind: 'ground' });
  // dielectric slabs (copper levels of other layers take the dielectric they sit in)
  const slabs: XSlab[] = [];
  for (const d of z.diel) slabs.push({ ...d });
  for (let k = 0; k < L; k++) {
    const ref = k > 0 ? z.diel[k - 1] : z.diel[0];
    const own = k === 0 || k === L - 1 ? null : ref;
    if (own) slabs.push({ y0: z.cu[k].y0, y1: z.cu[k].y1, er: own.er, tand: own.tand });
  }
  let topOpen = false, bottomOpen = false, y0 = yBot, y1 = yTopRef;
  const H = Math.max(hRef, w) * 10;
  if (above < 0) { // outer side up: mask + air
    const m = p.layers[0].mask ?? { thickness: 0.02, er: 3.5 };
    if (i === 0) slabs.push({ y0: cuT.y0, y1: cuT.y1 + m.thickness, er: m.er, tand: 0.02 });
    else slabs.push({ y0: z.cu[0].y0, y1: z.top + m.thickness, er: m.er, tand: 0.02 });
    y1 = z.top + H; topOpen = true;
    if (i === 0) { /* conductor y-range already set */ }
  }
  if (below < 0) {
    const m = p.layers[L - 1].mask ?? { thickness: 0.02, er: 3.5 };
    if (i === L - 1) slabs.push({ y0: cuT.y0 - m.thickness, y1: cuT.y1, er: m.er, tand: 0.02 });
    else slabs.push({ y0: -m.thickness, y1: z.cu[L - 1].y1, er: m.er, tand: 0.02 });
    y0 = -H; bottomOpen = true;
  }
  // trim slabs to the domain; the copper level of the trace layer is dielectric beside the trace
  if (i > 0 && i < L - 1) slabs.push({ y0: cuT.y0, y1: cuT.y1, er: z.diel[i - 1].er, tand: z.diel[i - 1].tand });
  return { conductors, slabs: slabs.filter((s) => s.y1 > y0 && s.y0 < y1).map((s) => ({ ...s, y0: Math.max(s.y0, y0), y1: Math.min(s.y1, y1) })), x0, x1, y0, y1, topOpen, bottomOpen };
}

const cache = new Map<string, LineParams>();
/** Field-solved parameters of a trace / pair on a layer (cached by geometry). */
export function fieldImpedance(p: Project, layer: string, w: number, opts: { gap?: number; coplanar?: number; at?: Pt; freqsGHz?: number[] } = {}): LineParams {
  const xs = stackupCrossSection(p, layer, w, opts);
  const key = JSON.stringify([xs, opts.freqsGHz ?? null]);
  let r = cache.get(key);
  if (!r) { r = lineParams(xs, { freqsGHz: opts.freqsGHz }); cache.set(key, r); }
  return r;
}

/** Width that gives a target impedance on a layer (single, or differential with `gap`), by bisection on the solver. */
export function widthForImpedance(p: Project, layer: string, target: number, opts: { gap?: number; at?: Pt; min?: number; max?: number } = {}): { width: number; z: number; reached: boolean } {
  let lo = opts.min ?? 0.05, hi = opts.max ?? 2.0;
  const z = (w: number) => { const r = fieldImpedance(p, layer, w, { gap: opts.gap, at: opts.at, freqsGHz: [] }); return opts.gap !== undefined ? r.zDiff! : r.z0; };
  // a thick dielectric needs wide traces: grow the upper bound (to 20 mm) until it brackets the target
  if (opts.max === undefined) while (hi < 20 && z(hi) > target) { lo = hi; hi *= 2; }
  for (let k = 0; k < 18; k++) { const m = (lo + hi) / 2; if (z(m) > target) lo = m; else hi = m; }
  const width = Math.round(((lo + hi) / 2) * 1000) / 1000;
  const zw = z(width);
  return { width, z: zw, reached: Math.abs(zw - target) <= Math.max(0.5, target * 0.02) };
}

export interface FieldSiNet { net: string; segments: { layer: string; width: number; length: number; z0: number; zDiff?: number; gap?: number; lossDb: number }[]; length: number; delayPs: number; lossDb: number; zMin: number; zMax: number; partner?: string }
export interface FieldXtalk { a: string; b: string; layer: string; length: number; gap: number; next: number; fext: number }

/**
 * Field-solved SI report: impedance of every trace width/layer a net uses, differential impedance of pairs at their
 * actual spacing, insertion loss at `freqGHz`, and NEXT/FEXT for other-net traces running parallel closer than
 * `xtalkGap` (mm) for longer than `xtalkMin` (mm).
 */
export function fieldSiReport(p: Project, opts: { nets?: string[]; freqGHz?: number; riseNs?: number; xtalkGap?: number; xtalkMin?: number } = {}): { nets: FieldSiNet[]; crosstalk: FieldXtalk[] } {
  const f = opts.freqGHz ?? 1, rise = opts.riseNs ?? 0.5;
  const only = opts.nets?.length ? new Set(opts.nets) : null;
  const partner = new Map<string, string>(); for (const d of p.diffPairs) { partner.set(d.p, d.n); partner.set(d.n, d.p); }
  const nets: FieldSiNet[] = [];
  const byNet = new Map<string, typeof p.traces>();
  for (const t of p.traces) { if (only && !only.has(t.net)) continue; const a = byNet.get(t.net) ?? []; a.push(t); byNet.set(t.net, a); }
  for (const [net, ts] of byNet) {
    const segs: FieldSiNet['segments'] = [];
    let length = 0, delay = 0, loss = 0;
    for (const t of ts) {
      let len = 0; for (let k = 1; k < t.points.length; k++) len += Math.hypot(t.points[k].x - t.points[k - 1].x, t.points[k].y - t.points[k - 1].y);
      let lp: LineParams;
      const at = t.points[0];
      try { lp = fieldImpedance(p, t.layer, t.width, { at, freqsGHz: [f] }); } catch { continue; }
      // pair spacing measured to the partner's nearest parallel trace on the same layer
      let gap: number | undefined, zd: number | undefined;
      const pn = partner.get(net);
      if (pn) {
        let best = Infinity;
        for (const o of p.traces) if (o.net === pn && o.layer === t.layer) for (const q of t.points) for (let k = 1; k < o.points.length; k++) best = Math.min(best, distPS(q, o.points[k - 1], o.points[k]) - t.width / 2 - o.width / 2);
        if (best < 4 * t.width + 0.5) { gap = Math.round(best * 1000) / 1000; try { zd = fieldImpedance(p, t.layer, t.width, { gap, at, freqsGHz: [] }).zDiff; } catch { /* */ } }
      }
      const lossDb = (lp.lossDbPerMm[0]?.total ?? 0) * len;
      segs.push({ layer: t.layer, width: t.width, length: len, z0: lp.z0, ...(zd ? { zDiff: zd, gap } : {}), lossDb });
      length += len; delay += len * lp.tpdPsPerMm; loss += lossDb;
    }
    if (!segs.length) continue;
    nets.push({ net, segments: segs, length, delayPs: delay, lossDb: loss, zMin: Math.min(...segs.map((s) => s.z0)), zMax: Math.max(...segs.map((s) => s.z0)), ...(partner.has(net) ? { partner: partner.get(net) } : {}) });
  }
  // crosstalk: parallel neighbours of the reported nets
  const xt: FieldXtalk[] = [];
  const gapMax = opts.xtalkGap ?? 0.3, minLen = opts.xtalkMin ?? 3;
  const seen = new Set<string>();
  for (const t of p.traces) {
    if (only && !only.has(t.net)) continue;
    for (const o of p.traces) {
      if (o.net === t.net || o.layer !== t.layer || partner.get(t.net) === o.net) continue;
      const key = t.net < o.net ? `${t.net}|${o.net}|${t.layer}` : `${o.net}|${t.net}|${t.layer}`;
      // parallel run: sample t every 0.25 mm, count samples within gapMax of o
      let run = 0, gsum = 0;
      for (let k = 1; k < t.points.length; k++) {
        const a = t.points[k - 1], b = t.points[k], L = Math.hypot(b.x - a.x, b.y - a.y), n = Math.max(1, Math.ceil(L / 0.25));
        for (let s = 0; s < n; s++) {
          const q = { x: a.x + ((b.x - a.x) * (s + 0.5)) / n, y: a.y + ((b.y - a.y) * (s + 0.5)) / n };
          let d = Infinity; for (let m = 1; m < o.points.length; m++) d = Math.min(d, distPS(q, o.points[m - 1], o.points[m]));
          const g = d - t.width / 2 - o.width / 2;
          if (g <= gapMax) { run += L / n; gsum += g * (L / n); }
        }
      }
      if (run < minLen) continue;
      const prev = xt.find((x) => `${x.a}|${x.b}|${x.layer}` === key || `${x.b}|${x.a}|${x.layer}` === key);
      if (prev || seen.has(key)) continue; seen.add(key);
      const gap = Math.max(0.03, Math.round((gsum / run) * 1000) / 1000);
      try {
        const lp = fieldImpedance(p, t.layer, t.width, { gap, at: t.points[0], freqsGHz: [] });
        const tof = run * lp.tpdPsPerMm / 1000;   // ns
        const next = Math.abs(lp.kNext ?? 0) * Math.min(1, (2 * tof) / rise);
        const fext = Math.abs((lp.kFextPerMm ?? 0) * run / 1000 / rise) ;
        xt.push({ a: t.net, b: o.net, layer: t.layer, length: Math.round(run * 100) / 100, gap, next, fext });
      } catch { /* no reference */ }
    }
  }
  xt.sort((a, b) => b.next + b.fext - a.next - a.fext);
  return { nets, crosstalk: xt };
}

function distPS(q: Pt, a: Pt, b: Pt): number { const dx = b.x - a.x, dy = b.y - a.y, l2 = dx * dx + dy * dy; let t = l2 ? ((q.x - a.x) * dx + (q.y - a.y) * dy) / l2 : 0; t = Math.max(0, Math.min(1, t)); return Math.hypot(q.x - a.x - dx * t, q.y - a.y - dy * t); }
