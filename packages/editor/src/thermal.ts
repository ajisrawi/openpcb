/**
 * Board thermal analysis (Allegro/Celsius PowerDC-thermal counterpart): steady-state 3D conduction in the layered
 * board, solved by preconditioned conjugate gradients on a grid of (copper layer x cell) nodes.
 *
 *   in-plane    each copper layer is a sheet: copper fill (rasterised traces, pads, pours) x copper conductivity
 *               plus the laminate around it
 *   vertical    dielectric between neighbouring copper layers, plus the barrels of the vias in the cell
 *   cooling     convection + linearised radiation from the top and bottom faces (h, W/m^2K)
 *   heat        component power over the part's footprint (outer layer of its side); Joule heat of traces of nets
 *               with a design current (I^2 R per segment)
 *
 * Result: temperature map per layer, temperature under each part, hot spots.
 */
import { type Project, type Pt, copperOf, layerIndexOf, viaLayers, padToBoard } from './model.js';
import { padInstances } from './connectivity.js';
import { defaultLibrary } from './footprints.js';
import { stackZ } from './fieldsolver.js';

const K_CU = 390, K_FR4 = 0.3, RHO_CU = 1.72e-8, PLATING = 0.025e-3;

export interface ThermalOptions { cell?: number; ambient?: number; hTop?: number; hBottom?: number; maxCells?: number; extraPower?: Record<string, number> }
export interface ThermalResult {
  ambient: number; maxTemp: number; cell: number; nx: number; ny: number; x0: number; y0: number; layers: string[];
  temps: Float64Array[];                  // per layer, nx*ny (NaN outside the board)
  parts: { ref: string; power: number; temp: number }[];
  hotspots: { x: number; y: number; layer: string; temp: number }[];
  totalPower: number; iterations: number;
}

const inPoly = (q: Pt, poly: Pt[]) => { let ins = false; for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) { const a = poly[i], b = poly[j]; if ((a.y > q.y) !== (b.y > q.y) && q.x < ((b.x - a.x) * (q.y - a.y)) / (b.y - a.y) + a.x) ins = !ins; } return ins; };
function distPS(q: Pt, a: Pt, b: Pt): number { const dx = b.x - a.x, dy = b.y - a.y, l2 = dx * dx + dy * dy; let t = l2 ? ((q.x - a.x) * dx + (q.y - a.y) * dy) / l2 : 0; t = Math.max(0, Math.min(1, t)); return Math.hypot(q.x - a.x - dx * t, q.y - a.y - dy * t); }

export function thermalAnalysis(p: Project, opts: ThermalOptions = {}): ThermalResult {
  const ambient = opts.ambient ?? 25, hTop = opts.hTop ?? 12, hBot = opts.hBottom ?? 12;
  const xs = p.outline.map((q) => q.x), ys = p.outline.map((q) => q.y);
  const x0 = Math.min(...xs), y0 = Math.min(...ys), W = Math.max(...xs) - x0, H = Math.max(...ys) - y0;
  let c = opts.cell ?? 0.5;
  const maxCells = opts.maxCells ?? 60_000;
  while ((W / c) * (H / c) > maxCells) c *= 1.2;
  const nx = Math.ceil(W / c), ny = Math.ceil(H / c), NC = nx * ny, L = p.layers.length;
  const cx = (i: number) => x0 + (i + 0.5) * c, cy = (j: number) => y0 + (j + 0.5) * c;
  const active = new Uint8Array(NC);
  for (let i = 0; i < nx; i++) for (let j = 0; j < ny; j++) active[i * ny + j] = inPoly({ x: cx(i), y: cy(j) }, p.outline) ? 1 : 0;
  // copper fill per layer (2x2 supersampling)
  const fill = Array.from({ length: L }, () => new Float32Array(NC));
  const stamp = (li: number, box: { x0: number; y0: number; x1: number; y1: number }, inside: (q: Pt) => boolean) => {
    const i0 = Math.max(0, Math.floor((box.x0 - x0) / c)), i1 = Math.min(nx - 1, Math.floor((box.x1 - x0) / c));
    const j0 = Math.max(0, Math.floor((box.y0 - y0) / c)), j1 = Math.min(ny - 1, Math.floor((box.y1 - y0) / c));
    for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) {
      let n = 0; for (const a of [0.25, 0.75]) for (const b of [0.25, 0.75]) if (inside({ x: x0 + (i + a) * c, y: y0 + (j + b) * c })) n++;
      if (n) fill[li][i * ny + j] = Math.max(fill[li][i * ny + j], n / 4);
    }
  };
  for (const z of p.zones) { const li = layerIndexOf(p, z.layer); if (li < 0) continue; const zx = z.points.map((q) => q.x), zy = z.points.map((q) => q.y); stamp(li, { x0: Math.min(...zx), y0: Math.min(...zy), x1: Math.max(...zx), y1: Math.max(...zy) }, (q) => inPoly(q, z.points)); }
  for (let li = 0; li < L; li++) if (p.layers[li].type === 'power') fill[li].fill(1);   // plane layers are solid copper
  for (const t of p.traces) {
    const li = layerIndexOf(p, t.layer); if (li < 0) continue;
    for (let k = 1; k < t.points.length; k++) { const a = t.points[k - 1], b = t.points[k], r = t.width / 2; stamp(li, { x0: Math.min(a.x, b.x) - r, y0: Math.min(a.y, b.y) - r, x1: Math.max(a.x, b.x) + r, y1: Math.max(a.y, b.y) + r }, (q) => distPS(q, a, b) <= r); }
  }
  for (const pd of padInstances(p)) for (const ln of pd.layers) { const li = layerIndexOf(p, ln); if (li < 0) continue; const r = Math.max(pd.w, pd.h) / 2; stamp(li, { x0: pd.center.x - r, y0: pd.center.y - r, x1: pd.center.x + r, y1: pd.center.y + r }, (q) => Math.abs(q.x - pd.center.x) <= pd.w / 2 + 1e-9 && Math.abs(q.y - pd.center.y) <= pd.h / 2 + 1e-9); }
  // stack-up (SI units)
  const z = stackZ(p);
  const tcu = p.layers.map((l) => copperOf(p, l.name) * 1e-3);
  const dk = z.diel.map((d) => (d.y1 - d.y0) * 1e-3);
  const cm = c * 1e-3, A = cm * cm;
  // vias per cell: barrel conductance per layer gap
  const viaG = Array.from({ length: Math.max(0, L - 1) }, () => new Float64Array(NC));
  for (const v of p.vias) {
    const ls = viaLayers(p, v).map((n) => layerIndexOf(p, n)).filter((i) => i >= 0).sort((a, b) => a - b);
    const i = Math.floor((v.x - x0) / c), j = Math.floor((v.y - y0) / c); if (i < 0 || j < 0 || i >= nx || j >= ny) continue;
    const ring = Math.PI * (v.drill * 1e-3) * PLATING;   // barrel cross-section
    for (let k = ls[0]; k < ls[ls.length - 1]; k++) viaG[k][i * ny + j] += (K_CU * ring) / Math.max(dk[k], 1e-6);
  }
  for (const pd of padInstances(p)) if (pd.th) {
    const i = Math.floor((pd.center.x - x0) / c), j = Math.floor((pd.center.y - y0) / c); if (i < 0 || j < 0 || i >= nx || j >= ny) continue;
    const ring = Math.PI * (Math.min(pd.w, pd.h) * 0.6e-3) * PLATING;
    for (let k = 0; k < L - 1; k++) viaG[k][i * ny + j] += (K_CU * ring) / Math.max(dk[k], 1e-6);
  }
  // heat sources
  const Q = new Float64Array(L * NC);
  const lib = { ...defaultLibrary(), ...p.footprints };
  const parts: { ref: string; power: number; cells: number[]; li: number }[] = [];
  let total = 0;
  for (const comp of p.components) {
    const P = opts.extraPower?.[comp.ref] ?? comp.power ?? 0;
    const fp = lib[comp.footprint]; if (!fp) continue;
    const li = comp.side === 'front' ? 0 : L - 1;
    const pts = fp.pads.map((pad) => padToBoard(comp, pad));
    const bx0 = Math.min(...pts.map((q) => q.x), comp.x) - 0.3, bx1 = Math.max(...pts.map((q) => q.x), comp.x) + 0.3, by0 = Math.min(...pts.map((q) => q.y), comp.y) - 0.3, by1 = Math.max(...pts.map((q) => q.y), comp.y) + 0.3;
    const cells: number[] = [];
    for (let i = Math.max(0, Math.floor((bx0 - x0) / c)); i <= Math.min(nx - 1, Math.floor((bx1 - x0) / c)); i++) for (let j = Math.max(0, Math.floor((by0 - y0) / c)); j <= Math.min(ny - 1, Math.floor((by1 - y0) / c)); j++) if (active[i * ny + j]) cells.push(i * ny + j);
    if (!cells.length) { const i = Math.floor((comp.x - x0) / c), j = Math.floor((comp.y - y0) / c); if (i >= 0 && j >= 0 && i < nx && j < ny) cells.push(i * ny + j); }
    if (P > 0) for (const n of cells) Q[li * NC + n] += P / cells.length;
    total += P;
    parts.push({ ref: comp.ref, power: P, cells, li });
  }
  for (const t of p.traces) {
    const I = p.nets.find((n) => n.name === t.net)?.current; if (!I) continue;
    const li = layerIndexOf(p, t.layer); if (li < 0) continue;
    for (let k = 1; k < t.points.length; k++) {
      const a = t.points[k - 1], b = t.points[k], len = Math.hypot(b.x - a.x, b.y - a.y);
      const R = (RHO_CU * len * 1e-3) / (t.width * 1e-3 * tcu[li]), P = I * I * R;
      const n = Math.max(1, Math.ceil(len / c));
      for (let s = 0; s < n; s++) { const q = { x: a.x + ((b.x - a.x) * (s + 0.5)) / n, y: a.y + ((b.y - a.y) * (s + 0.5)) / n }; const i = Math.floor((q.x - x0) / c), j = Math.floor((q.y - y0) / c); if (i >= 0 && j >= 0 && i < nx && j < ny) Q[li * NC + i * ny + j] += P / n; }
      total += P;
    }
  }
  // conductances
  const sheet = (li: number, n: number) => K_CU * tcu[li] * fill[li][n] + K_FR4 * (tcu[li] * (1 - fill[li][n]) + ((li > 0 ? dk[li - 1] : 0) + (li < L - 1 ? dk[li] : 0)) / 2);
  const N = L * NC;
  const diag = new Float64Array(N);
  const gx = new Float64Array(N), gy = new Float64Array(N), gz = new Float64Array(N);   // to +x, +y, +layer
  for (let li = 0; li < L; li++) for (let i = 0; i < nx; i++) for (let j = 0; j < ny; j++) {
    const n = i * ny + j, m = li * NC + n; if (!active[n]) continue;
    const s0 = sheet(li, n);
    if (i + 1 < nx && active[n + ny]) { const s1 = sheet(li, n + ny); gx[m] = (2 * s0 * s1) / (s0 + s1 || 1); }
    if (j + 1 < ny && active[n + 1]) { const s1 = sheet(li, n + 1); gy[m] = (2 * s0 * s1) / (s0 + s1 || 1); }
    if (li + 1 < L) gz[m] = (K_FR4 * A) / Math.max(dk[li], 1e-6) + viaG[li][n];
  }
  for (let li = 0; li < L; li++) for (let n = 0; n < NC; n++) {
    const m = li * NC + n; if (!active[n]) continue;
    let d = gx[m] + gy[m] + gz[m];
    if (n >= ny) d += gx[m - ny]; if (n % ny) d += gy[m - 1]; if (li) d += gz[m - NC];
    if (li === 0) d += hTop * A; if (li === L - 1) d += hBot * A;
    diag[m] = d;
  }
  const Ax = (x: Float64Array, out: Float64Array) => {
    for (let li = 0; li < L; li++) for (let n = 0; n < NC; n++) {
      const m = li * NC + n; if (!active[n]) { out[m] = 0; continue; }
      let v = diag[m] * x[m];
      if (gx[m]) v -= gx[m] * x[m + ny]; if (n >= ny && gx[m - ny]) v -= gx[m - ny] * x[m - ny];
      if (gy[m]) v -= gy[m] * x[m + 1]; if (n % ny && gy[m - 1]) v -= gy[m - 1] * x[m - 1];
      if (gz[m]) v -= gz[m] * x[m + NC]; if (li && gz[m - NC]) v -= gz[m - NC] * x[m - NC];
      out[m] = v;
    }
  };
  const T = new Float64Array(N), r = Float64Array.from(Q), zz = new Float64Array(N), pp = new Float64Array(N), Ap = new Float64Array(N);
  for (let m = 0; m < N; m++) { zz[m] = diag[m] ? r[m] / diag[m] : 0; pp[m] = zz[m]; }
  let rz = 0, bn = 0; for (let m = 0; m < N; m++) { rz += r[m] * zz[m]; bn += r[m] * r[m]; }
  let it = 0;
  if (bn > 0) for (; it < 20000; it++) {
    Ax(pp, Ap);
    let pAp = 0; for (let m = 0; m < N; m++) pAp += pp[m] * Ap[m];
    if (!(pAp > 0)) break;
    const a = rz / pAp; let rr = 0;
    for (let m = 0; m < N; m++) { T[m] += a * pp[m]; r[m] -= a * Ap[m]; rr += r[m] * r[m]; }
    if (rr < 1e-20 * bn) break;
    let rz2 = 0; for (let m = 0; m < N; m++) { zz[m] = diag[m] ? r[m] / diag[m] : 0; rz2 += r[m] * zz[m]; }
    const beta = rz2 / rz; rz = rz2;
    for (let m = 0; m < N; m++) pp[m] = zz[m] + beta * pp[m];
  }
  const temps = Array.from({ length: L }, (_, li) => { const a = new Float64Array(NC); for (let n = 0; n < NC; n++) a[n] = active[n] ? ambient + T[li * NC + n] : NaN; return a; });
  let maxT = ambient;
  const hot: ThermalResult['hotspots'] = [];
  for (let li = 0; li < L; li++) for (let n = 0; n < NC; n++) {
    const t = temps[li][n]; if (!(t > maxT)) continue; maxT = t;
  }
  // hot spots: local maxima on the outer layers above ambient + 25 % of the rise
  for (const li of [0, L - 1]) for (let i = 1; i < nx - 1; i++) for (let j = 1; j < ny - 1; j++) {
    const n = i * ny + j, t = temps[li][n]; if (!(t > ambient + 0.25 * (maxT - ambient)) || maxT - ambient < 0.5) continue;
    if ([n - ny, n + ny, n - 1, n + 1].every((m) => !(temps[li][m] > t))) hot.push({ x: cx(i), y: cy(j), layer: p.layers[li].name, temp: t });
  }
  hot.sort((a, b) => b.temp - a.temp);
  return {
    ambient, maxTemp: maxT, cell: c, nx, ny, x0, y0, layers: p.layers.map((l) => l.name), temps,
    parts: parts.map((q) => ({ ref: q.ref, power: q.power, temp: q.cells.length ? q.cells.reduce((s, n) => s + temps[q.li][n], 0) / q.cells.length : ambient })).sort((a, b) => b.temp - a.temp),
    hotspots: hot.slice(0, 20), totalPower: total, iterations: it,
  };
}

/** Heat map of one layer as SVG (blue = ambient, red = hottest), with the outline. */
export function thermalSvg(p: Project, r: ThermalResult, layer?: string, widthPx = 900): string {
  const li = Math.max(0, layer ? r.layers.indexOf(layer) : 0);
  const sc = widthPx / (r.nx * r.cell), Hpx = r.ny * r.cell * sc;
  const col = (t: number) => { const f = Math.max(0, Math.min(1, (t - r.ambient) / Math.max(1e-9, r.maxTemp - r.ambient))); const h = (1 - f) * 240; return `hsl(${h.toFixed(0)},90%,50%)`; };
  const parts: string[] = [];
  for (let i = 0; i < r.nx; i++) for (let j = 0; j < r.ny; j++) { const t = r.temps[li][i * r.ny + j]; if (!Number.isFinite(t)) continue; parts.push(`<rect x="${(i * r.cell * sc).toFixed(1)}" y="${(Hpx - (j + 1) * r.cell * sc).toFixed(1)}" width="${(r.cell * sc + 0.6).toFixed(1)}" height="${(r.cell * sc + 0.6).toFixed(1)}" fill="${col(t)}"/>`); }
  const ol = p.outline.map((q) => `${((q.x - r.x0) * sc).toFixed(1)},${(Hpx - (q.y - r.y0) * sc).toFixed(1)}`).join(' ');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${widthPx}" height="${Hpx.toFixed(0)}" viewBox="0 0 ${widthPx} ${Hpx.toFixed(0)}">${parts.join('')}<polygon points="${ol}" fill="none" stroke="#000" stroke-width="1"/><text x="6" y="16" font-size="13" font-family="sans-serif">${r.layers[li]}: ${r.ambient.toFixed(0)}–${r.maxTemp.toFixed(1)} °C</text></svg>`;
}
