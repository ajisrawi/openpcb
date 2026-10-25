/**
 * Analysis (Allegro Analyze menu, approximated with closed-form physics; no field solver):
 *
 *   Signal integrity   per net: per-segment impedance from the stack-up (microstrip on outer layers, stripline
 *                      inside), propagation delay, discontinuities (width changes, vias, layer changes) with their
 *                      reflection coefficient, and the critical length for a given rise time.
 *   IR drop            DC solve of a net's copper as a resistor network (traces, vias, and plane pours meshed on a
 *                      grid) from its sources (fixed voltage) to its loads (currents); worst drop and current density.
 *   EMI rule checks    high-speed nets crossing a split or leaving their reference plane, routed on a layer with no
 *                      adjacent plane, too close to the board edge, or changing layer with no return via nearby.
 *   Current capacity   IPC-2221 temperature rise of each trace of nets that carry a design current.
 *   3D clearance       part heights against the side limits; bodies of parts on one side overlapping in 3D.
 *   Design compare     what changed between two versions of a board.
 */
import { type Project, type Pt, viaLayers, layerIndexOf, copperOf, heightOf, classOf } from './model.js';
import { defaultLibrary } from './footprints.js';
import { padInstances } from './connectivity.js';
import { impedance } from './outputs.js';
import type { DrcMarker } from './connectivity.js';

const ER = 4.3;                    // FR-4
const RHO = 1.72e-8;               // copper resistivity, ohm*m
const C0 = 299.792458;             // mm/ns

const segLen = (a: Pt, b: Pt) => Math.hypot(b.x - a.x, b.y - a.y);
function inPoly(q: Pt, poly: Pt[]): boolean { let ins = false; for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) { const a = poly[i], b = poly[j]; if ((a.y > q.y) !== (b.y > q.y) && q.x < ((b.x - a.x) * (q.y - a.y)) / (b.y - a.y) + a.x) ins = !ins; } return ins; }

/* ============================== stack-up helpers ============================== */

/** Dielectric between layer i and i+1 (mm): the layer's own value or the remaining thickness shared evenly. */
export function dielectricBelow(p: Project, i: number): number {
  const L = p.layers.length; if (i >= L - 1) return 0;
  const set = p.layers[i].dielectric; if (set) return set;
  const cu = p.layers.reduce((s, l) => s + copperOf(p, l.name), 0);
  const fixed = p.layers.reduce((s, l, k) => s + (k < L - 1 && l.dielectric ? l.dielectric : 0), 0);
  const free = p.layers.filter((l, k) => k < L - 1 && !l.dielectric).length;
  return Math.max(0.05, ((p.rules.viaLength || 1.6) - cu - fixed) / Math.max(1, free));
}
/** Nearest plane layers above and below a routing layer (indices, -1 = none). */
function planesAround(p: Project, i: number): { above: number; below: number } {
  let above = -1, below = -1;
  for (let k = i - 1; k >= 0; k--) if (p.layers[k].type === 'power') { above = k; break; }
  for (let k = i + 1; k < p.layers.length; k++) if (p.layers[k].type === 'power') { below = k; break; }
  return { above, below };
}
const heightBetween = (p: Project, a: number, b: number) => { let h = 0; for (let k = Math.min(a, b); k < Math.max(a, b); k++) h += dielectricBelow(p, k) + (k > Math.min(a, b) ? copperOf(p, p.layers[k].name) : 0); return h; };

/** Characteristic impedance and delay (ps/mm) of a trace of width w on layer i. */
export function traceZ(p: Project, i: number, w: number): { z0: number; tpd: number; type: 'microstrip' | 'stripline' | 'unreferenced' } {
  const L = p.layers.length, t = copperOf(p, p.layers[i].name);
  const { above, below } = planesAround(p, i);
  const outer = i === 0 || i === L - 1;
  if (outer) {
    const ref = i === 0 ? below : above; if (ref < 0) return { z0: NaN, tpd: (Math.sqrt(ER) * 1000) / C0, type: 'unreferenced' };
    const h = heightBetween(p, i, ref);
    const eeff = (ER + 1) / 2 + ((ER - 1) / 2) / Math.sqrt(1 + 12 * h / w);
    return { z0: impedance({ type: 'microstrip', w, h, t, er: ER }).z0, tpd: (Math.sqrt(eeff) * 1000) / C0, type: 'microstrip' };
  }
  if (above < 0 && below < 0) return { z0: NaN, tpd: (Math.sqrt(ER) * 1000) / C0, type: 'unreferenced' };
  const h1 = above >= 0 ? heightBetween(p, above, i) : heightBetween(p, i, below), h2 = below >= 0 ? heightBetween(p, i, below) : h1;
  const h = Math.min(h1, h2), b = h1 + h2 + t;
  return { z0: impedance({ type: 'stripline', w, h, t, er: ER, b }).z0, tpd: (Math.sqrt(ER) * 1000) / C0, type: 'stripline' };
}

/* ============================== signal integrity ============================== */

export interface SiNet { net: string; length: number; delayPs: number; vias: number; z: { layer: string; width: number; z0: number; length: number }[]; zMin: number; zMax: number; worstReflection: number; criticalLength: number; lumped: boolean; notes: string[] }

export function siReport(p: Project, opts: { nets?: string[]; riseTimePs?: number; targetZ?: number } = {}): SiNet[] {
  const tr = opts.riseTimePs ?? 500;
  const nets = opts.nets?.length ? opts.nets : [...new Set(p.traces.map((t) => t.net).filter(Boolean))];
  const out: SiNet[] = [];
  for (const net of nets) {
    const traces = p.traces.filter((t) => t.net === net); if (!traces.length) continue;
    const segs = new Map<string, { layer: string; width: number; z0: number; length: number; tpd: number }>();
    let length = 0, delay = 0;
    for (const t of traces) {
      const i = layerIndexOf(p, t.layer); const zt = traceZ(p, i, t.width);
      let L = 0; for (let k = 1; k < t.points.length; k++) L += segLen(t.points[k - 1], t.points[k]);
      length += L; delay += L * zt.tpd;
      const key = `${t.layer}|${t.width}`; const e = segs.get(key);
      if (e) e.length += L; else segs.set(key, { layer: t.layer, width: t.width, z0: zt.z0, length: L, tpd: zt.tpd });
    }
    const vias = p.vias.filter((v) => v.net === net);
    delay += vias.length * (p.rules.viaLength || 1.6) * ((Math.sqrt(ER) * 1000) / C0);
    const zs = [...segs.values()].map((s) => s.z0).filter((z) => Number.isFinite(z));
    const zMin = zs.length ? Math.min(...zs) : NaN, zMax = zs.length ? Math.max(...zs) : NaN;
    const refl = zs.length ? (zMax - zMin) / (zMax + zMin) : 0;
    const tpdAvg = length ? (delay / Math.max(1e-9, length + vias.length * (p.rules.viaLength || 1.6))) : 6;
    const crit = tr / (2 * tpdAvg);
    const notes: string[] = [];
    if (opts.targetZ && zs.some((z) => Math.abs(z - opts.targetZ!) / opts.targetZ! > 0.1)) notes.push(`impedance off target ${opts.targetZ} ohm by more than 10 %`);
    if ([...segs.values()].some((s) => !Number.isFinite(s.z0))) notes.push('routed on a layer with no reference plane');
    if (refl > 0.1) notes.push(`width/layer changes reflect ${(refl * 100).toFixed(0)} % of the edge`);
    if (vias.length > 4) notes.push(`${vias.length} vias (each a discontinuity and a stub unless backdrilled)`);
    out.push({ net, length: +length.toFixed(3), delayPs: +delay.toFixed(1), vias: vias.length, z: [...segs.values()].map((s) => ({ layer: s.layer, width: s.width, z0: +s.z0.toFixed(1), length: +s.length.toFixed(2) })), zMin: +zMin.toFixed(1), zMax: +zMax.toFixed(1), worstReflection: +refl.toFixed(3), criticalLength: +crit.toFixed(1), lumped: length < crit, notes });
  }
  return out.sort((a, b) => b.length - a.length);
}

/* ============================== IR drop ============================== */

export interface IrResult { net: string; nodes: number; sources: { ref: string; v: number }[]; loads: { ref: string; current: number; voltage: number; drop: number }[]; worstDrop: number; maxCurrentDensity: number; hotTrace?: { layer: string; at: Pt; amps: number; width: number } }

/**
 * DC IR drop of one net. The net's copper becomes a conductance matrix: trace segments (R = rho L / (w t)), vias
 * (plated barrel, 25 um wall), and pours meshed on a `grid` mm lattice (sheet resistance rho / t). Pads join the copper
 * they touch. Sources are held at their voltage; loads draw their current; the system is solved by conjugate gradient.
 */
export function irDrop(p: Project, net: string, opts: { grid?: number } = {}): IrResult {
  const grid = opts.grid ?? 1;
  const sources = (p.sources ?? []).filter((s) => s.net === net), loads = (p.loads ?? []).filter((l) => l.net === net);
  if (!sources.length) throw new Error(`no source for ${net} (add one: openpcb power <project> source <net> <ref> <volts>)`);
  const nodes: { x: number; y: number; layers: string[] }[] = [];
  const edges: { a: number; b: number; g: number; w?: number; layer?: string }[] = [];
  const nodeAt = new Map<string, number>();
  const hash = new Map<string, number[]>();   // layer|cellX|cellY (1 mm cells) -> node ids, for nearest-node lookups
  const hkey = (layer: string, x: number, y: number) => `${layer}|${Math.floor(x)}|${Math.floor(y)}`;
  const node = (x: number, y: number, layer: string) => { const k = `${layer}|${x.toFixed(3)}|${y.toFixed(3)}`; let n = nodeAt.get(k); if (n === undefined) { n = nodes.length; nodes.push({ x, y, layers: [layer] }); nodeAt.set(k, n); const hk = hkey(layer, x, y); (hash.get(hk) ?? hash.set(hk, []).get(hk)!).push(n); } return n; };
  const t = (layer: string) => copperOf(p, layer) * 1e-3;   // m
  // traces
  for (const tr of p.traces.filter((x) => x.net === net)) for (let i = 1; i < tr.points.length; i++) {
    const a = tr.points[i - 1], b = tr.points[i], L = segLen(a, b) * 1e-3; if (L <= 0) continue;
    edges.push({ a: node(a.x, a.y, tr.layer), b: node(b.x, b.y, tr.layer), g: (tr.width * 1e-3 * t(tr.layer)) / (RHO * L), w: tr.width, layer: tr.layer });
  }
  // pours: grid mesh inside each zone of the net
  const meshes: { layer: string; poly: Pt[]; ids: Map<string, number> }[] = [];
  for (const z of p.zones.filter((x) => x.net === net && x.points.length >= 3)) {
    const xs = z.points.map((q) => q.x), ys = z.points.map((q) => q.y), ids = new Map<string, number>();
    for (let y = Math.min(...ys); y <= Math.max(...ys); y += grid) for (let x = Math.min(...xs); x <= Math.max(...xs); x += grid) if (inPoly({ x, y }, z.points)) ids.set(`${Math.round(x / grid)},${Math.round(y / grid)}`, node(x, y, z.layer));
    const gSheet = t(z.layer) / RHO;   // square of copper: conductance = t / rho
    for (const [k, n] of ids) { const [i, j] = k.split(',').map(Number); for (const nb of [`${i + 1},${j}`, `${i},${j + 1}`]) { const m = ids.get(nb); if (m !== undefined) edges.push({ a: n, b: m, g: gSheet }); } }
    meshes.push({ layer: z.layer, poly: z.points, ids });
  }
  const nearestMesh = (q: Pt, layer: string) => { for (const m of meshes) if (m.layer === layer && inPoly(q, m.poly)) return m.ids.get(`${Math.round(q.x / grid)},${Math.round(q.y / grid)}`); return undefined; };
  // vias: barrel between every pair of consecutive layers they span, and to the copper on those layers
  const barrel = (v: { drill: number }) => { const r1 = (v.drill / 2) * 1e-3, r0 = Math.max(0, r1 - 25e-6); return (Math.PI * (r1 * r1 - r0 * r0)) / (RHO * ((p.rules.viaLength || 1.6) * 1e-3 / Math.max(1, p.layers.length - 1))); };
  const join = (x: number, y: number, layer: string, tol: number): number => {
    // the closest existing node on the layer within tol, else a mesh node, else a new node
    let best = -1, bd = tol;
    const r = Math.ceil(tol);
    for (let gx = Math.floor(x) - r; gx <= Math.floor(x) + r; gx++) for (let gy = Math.floor(y) - r; gy <= Math.floor(y) + r; gy++) for (const i of hash.get(`${layer}|${gx}|${gy}`) ?? []) { const d = Math.hypot(nodes[i].x - x, nodes[i].y - y); if (d <= bd) { bd = d; best = i; } }
    if (best >= 0) return best;
    const m = nearestMesh({ x, y }, layer); if (m !== undefined) return m;
    return node(x, y, layer);
  };
  for (const v of p.vias.filter((x) => x.net === net)) {
    const ls = viaLayers(p, v); let prev = -1;
    for (const l of ls) { const n = join(v.x, v.y, l, v.diameter / 2 + 0.2); if (prev >= 0) edges.push({ a: prev, b: n, g: barrel(v) }); prev = n; }
  }
  // pads: one node per pad joined to the copper it touches on its layers
  const padNode = new Map<string, number>();
  for (const pd of padInstances(p).filter((x) => x.net === net)) {
    const n = nodes.length; nodes.push({ x: pd.center.x, y: pd.center.y, layers: ['pad'] }); padNode.set(pd.key, n);
    for (const l of pd.layers) { const m = join(pd.center.x, pd.center.y, l, Math.max(pd.w, pd.h) / 2 + 0.05); if (m !== n) edges.push({ a: n, b: m, g: 1e4 }); }
  }
  // boundary conditions: a source holds all its pads of the net at V; a load spreads its current over its pads
  const N = nodes.length;
  const fixed = new Map<number, number>();
  for (const s of sources) for (const [k, n] of padNode) if (k.startsWith(s.ref + '-')) fixed.set(n, s.voltage);
  if (!fixed.size) throw new Error(`source pads of ${net} not found`);
  const inj = new Float64Array(N);
  for (const l of loads) { const ns = [...padNode].filter(([k]) => k.startsWith(l.ref + '-')).map(([, n]) => n); for (const n of ns) inj[n] -= l.current / ns.length; }
  // conjugate gradient on the free nodes (Kirchhoff: sum g (v_i - v_j) = injection)
  const adj: { j: number; g: number }[][] = Array.from({ length: N }, () => []);
  for (const e of edges) { adj[e.a].push({ j: e.b, g: e.g }); adj[e.b].push({ j: e.a, g: e.g }); }
  const v = new Float64Array(N); const vs = [...fixed.values()]; const v0 = vs.reduce((s, x) => s + x, 0) / vs.length;
  for (let i = 0; i < N; i++) v[i] = fixed.get(i) ?? v0;
  const free = (i: number) => !fixed.has(i);
  const A = (x: Float64Array, out: Float64Array) => { for (let i = 0; i < N; i++) { if (!free(i)) { out[i] = 0; continue; } let s = 0; for (const { j, g } of adj[i]) s += g * (x[i] - (free(j) ? x[j] : 0)); out[i] = s; } };
  // right-hand side: injections plus the fixed neighbours' contribution
  const b = new Float64Array(N);
  for (let i = 0; i < N; i++) if (free(i)) { let s = inj[i]; for (const { j, g } of adj[i]) if (!free(j)) s += g * v[j]; b[i] = s; }
  // islands without a path to a source would make the system singular: give each free node a tiny leak to v0
  const leak = 1e-9;
  const Ap = (x: Float64Array, out: Float64Array) => { A(x, out); for (let i = 0; i < N; i++) if (free(i)) out[i] += leak * x[i]; };
  for (let i = 0; i < N; i++) if (free(i)) b[i] += leak * v0;
  const x = new Float64Array(N); for (let i = 0; i < N; i++) x[i] = free(i) ? v0 : 0;
  const r = new Float64Array(N), q = new Float64Array(N), d = new Float64Array(N);
  Ap(x, q); for (let i = 0; i < N; i++) { r[i] = free(i) ? b[i] - q[i] : 0; d[i] = r[i]; }
  let rr = r.reduce((s, z) => s + z * z, 0);
  for (let it = 0; it < 20000 && rr > 1e-24; it++) {
    Ap(d, q); const dq = d.reduce((s, z, i) => s + z * q[i], 0); if (!dq) break;
    const alpha = rr / dq; for (let i = 0; i < N; i++) { x[i] += alpha * d[i]; r[i] -= alpha * q[i]; }
    const rr2 = r.reduce((s, z) => s + z * z, 0); const beta = rr2 / rr; rr = rr2; for (let i = 0; i < N; i++) d[i] = r[i] + beta * d[i];
  }
  for (let i = 0; i < N; i++) if (free(i)) v[i] = x[i];
  const loadOut = loads.map((l) => { const ns = [...padNode].filter(([k]) => k.startsWith(l.ref + '-')).map(([, n]) => n); const volt = ns.length ? Math.min(...ns.map((n) => v[n])) : NaN; return { ref: l.ref, current: l.current, voltage: +volt.toFixed(4), drop: +(v0 - volt).toFixed(4) }; });
  let maxJ = 0, hot: IrResult['hotTrace'];
  for (const e of edges) if (e.w && e.layer) { const amps = Math.abs(v[e.a] - v[e.b]) * e.g; const J = amps / (e.w * copperOf(p, e.layer)); if (J > maxJ) { maxJ = J; hot = { layer: e.layer, at: { x: nodes[e.a].x, y: nodes[e.a].y }, amps: +amps.toFixed(3), width: e.w }; } }
  return { net, nodes: N, sources: sources.map((s) => ({ ref: s.ref, v: s.voltage })), loads: loadOut, worstDrop: loadOut.length ? Math.max(...loadOut.map((l) => l.drop)) : 0, maxCurrentDensity: +maxJ.toFixed(1), hotTrace: hot };
}

/* ============================== EMI rule checks ============================== */

/** High-speed nets: pair and length-group members, nets with a class named like high speed, or clock-like names. */
function highSpeed(p: Project): Set<string> {
  const s = new Set<string>();
  for (const d of p.diffPairs) { s.add(d.p); s.add(d.n); }
  for (const g of p.lengthGroups) for (const n of g.nets) s.add(n);
  for (const n of p.nets) if (/CLK|CLOCK|_P$|_N$|DQ|DQS|LVDS|USB_D|ETH_|RGMII|HDMI|PCIE/i.test(n.name) || /HS|HIGH|FAST|DIFF|RF/i.test(classOf(p, n.name)?.name ?? '')) s.add(n.name);
  return s;
}

export function emiCheck(p: Project, opts: { nets?: string[]; edgeDistance?: number; returnViaDistance?: number } = {}): DrcMarker[] {
  const out: DrcMarker[] = [];
  const hs = opts.nets?.length ? new Set(opts.nets) : highSpeed(p);
  const edgeD = opts.edgeDistance ?? 1, retD = opts.returnViaDistance ?? 1.5;
  const segD = (q: Pt, a: Pt, b: Pt) => { const dx = b.x - a.x, dy = b.y - a.y, l2 = dx * dx + dy * dy; let tt = l2 ? ((q.x - a.x) * dx + (q.y - a.y) * dy) / l2 : 0; tt = Math.max(0, Math.min(1, tt)); return Math.hypot(q.x - a.x - dx * tt, q.y - a.y - dy * tt); };
  const edgeDist = (q: Pt) => { let d = Infinity; for (let i = 0; i < p.outline.length; i++) d = Math.min(d, segD(q, p.outline[i], p.outline[(i + 1) % p.outline.length])); return d; };
  const zoneAt = (layer: string, q: Pt) => p.zones.find((z) => z.layer === layer && inPoly(q, z.points));
  const reported = new Set<string>();
  const add = (m: DrcMarker, key: string) => { if (!reported.has(key)) { reported.add(key); out.push(m); } };
  for (const t of p.traces) {
    if (!hs.has(t.net)) continue;
    const i = layerIndexOf(p, t.layer); const { above, below } = planesAround(p, i);
    const refs = [above, below].filter((k) => k >= 0 && Math.abs(k - i) === 1 || (k >= 0 && (i === 0 || i === p.layers.length - 1)));
    if (!refs.length) add({ kind: 'emi-unreferenced', at: t.points[0], layer: t.layer, message: `${t.net} routed on ${t.layer} with no adjacent reference plane` }, `unref|${t.net}|${t.layer}`);
    for (let k = 1; k < t.points.length; k++) {
      const a = t.points[k - 1], b = t.points[k], L = segLen(a, b), n = Math.max(1, Math.ceil(L / 0.5));
      for (let s = 0; s <= n; s++) {
        const q = { x: a.x + ((b.x - a.x) * s) / n, y: a.y + ((b.y - a.y) * s) / n };
        for (const r of refs) {
          const z = zoneAt(p.layers[r].name, q);
          if (!z) add({ kind: 'emi-split-crossing', at: q, layer: t.layer, message: `${t.net} leaves its reference plane on ${p.layers[r].name} (gap or split under the trace)` }, `split|${t.net}|${r}|${Math.round(q.x)}|${Math.round(q.y)}`);
        }
        if (edgeDist(q) < edgeD + t.width / 2) add({ kind: 'emi-edge', at: q, layer: t.layer, message: `${t.net} runs ${edgeDist(q).toFixed(2)} mm from the board edge (< ${edgeD} mm)` }, `edge|${t.net}|${Math.round(q.x / 3)}|${Math.round(q.y / 3)}`);
      }
    }
  }
  // layer changes of high-speed nets need a return-path (ground) via close by
  const gndVias = p.vias.filter((v) => /^(A|D)?GND/i.test(v.net));
  for (const v of p.vias) {
    if (!hs.has(v.net)) continue;
    const near = gndVias.some((g) => Math.hypot(g.x - v.x, g.y - v.y) <= retD);
    if (!near) add({ kind: 'emi-return-via', at: { x: v.x, y: v.y }, layer: viaLayers(p, v)[0], message: `${v.net} changes layer with no ground via within ${retD} mm (return path)` }, `ret|${v.id}`);
  }
  return out;
}

/* ============================== current capacity ============================== */

/** IPC-2221: I = k * dT^0.44 * A^0.725 (A in mil^2); k = 0.048 outer, 0.024 inner. Temperature rise for a trace. */
export function tempRise(amps: number, widthMm: number, copperMm: number, outer: boolean): number {
  const areaMil2 = (widthMm / 0.0254) * (copperMm / 0.0254), k = outer ? 0.048 : 0.024;
  return Math.pow(amps / (k * Math.pow(areaMil2, 0.725)), 1 / 0.44);
}
export function requiredWidth(amps: number, copperMm: number, outer: boolean, dT = 10): number {
  const k = outer ? 0.048 : 0.024;
  const areaMil2 = Math.pow(amps / (k * Math.pow(dT, 0.44)), 1 / 0.725);
  return (areaMil2 / (copperMm / 0.0254)) * 0.0254;
}
export function currentCheck(p: Project, opts: { maxRise?: number } = {}): DrcMarker[] {
  const maxRise = opts.maxRise ?? 10, out: DrcMarker[] = [];
  const amps = new Map<string, number>(); for (const n of p.nets) if (n.current) amps.set(n.name, n.current);
  for (const t of p.traces) {
    const I = amps.get(t.net); if (!I) continue;
    const i = layerIndexOf(p, t.layer), outer = i === 0 || i === p.layers.length - 1, cu = copperOf(p, t.layer);
    const dT = tempRise(I, t.width, cu, outer);
    if (dT > maxRise) out.push({ kind: 'current', at: t.points[0], layer: t.layer, message: `${t.net} ${I} A on ${t.width} mm: +${dT.toFixed(1)} °C > ${maxRise} °C (needs ${requiredWidth(I, cu, outer, maxRise).toFixed(2)} mm)` });
  }
  return out;
}

/* ============================== 3D clearance ============================== */

export function clearance3d(p: Project): DrcMarker[] {
  const lib = { ...defaultLibrary(), ...p.footprints }, out: DrcMarker[] = [];
  const box = (c: (typeof p.components)[number]) => { const fp = lib[c.footprint]; if (!fp) return null; const a = (c.rot * Math.PI) / 180, cs = Math.abs(Math.cos(a)), sn = Math.abs(Math.sin(a)); const hw = (fp.body.w / 2) * cs + (fp.body.h / 2) * sn, hh = (fp.body.w / 2) * sn + (fp.body.h / 2) * cs; return { x0: c.x - hw, x1: c.x + hw, y0: c.y - hh, y1: c.y + hh, h: heightOf(p, c) }; };
  for (const c of p.components) {
    const lim = c.side === 'front' ? p.rules.maxHeightTop : p.rules.maxHeightBottom;
    if (lim && heightOf(p, c) > lim + 1e-9) out.push({ kind: 'height', at: { x: c.x, y: c.y }, layer: c.side === 'front' ? p.layers[0].name : p.layers[p.layers.length - 1].name, message: `${c.ref} is ${heightOf(p, c)} mm tall > ${lim} mm allowed on the ${c.side === 'front' ? 'top' : 'bottom'}` });
  }
  const bs = p.components.map((c) => ({ c, b: box(c) })).filter((x) => x.b);
  for (let i = 0; i < bs.length; i++) for (let j = i + 1; j < bs.length; j++) {
    const A = bs[i], B = bs[j]; if (A.c.side !== B.c.side) continue;
    const ox = Math.min(A.b!.x1, B.b!.x1) - Math.max(A.b!.x0, B.b!.x0), oy = Math.min(A.b!.y1, B.b!.y1) - Math.max(A.b!.y0, B.b!.y0);
    if (ox > 0.05 && oy > 0.05) out.push({ kind: 'body-overlap', at: { x: (A.c.x + B.c.x) / 2, y: (A.c.y + B.c.y) / 2 }, layer: A.c.side === 'front' ? p.layers[0].name : p.layers[p.layers.length - 1].name, message: `${A.c.ref} and ${B.c.ref} bodies overlap (${ox.toFixed(2)} x ${oy.toFixed(2)} mm, heights ${A.b!.h}/${B.b!.h} mm)` });
  }
  return out;
}

/* ============================== design compare ============================== */

export interface CompareReport { added: string[]; removed: string[]; moved: { ref: string; dx: number; dy: number; rot?: string; side?: string }[]; valueChanged: { ref: string; was: string; is: string }[]; footprintChanged: { ref: string; was: string; is: string }[]; netsAdded: string[]; netsRemoved: string[]; netsChanged: { net: string; added: string[]; removed: string[] }[]; routing: { net: string; lengthWas: number; lengthIs: number; viasWas: number; viasIs: number }[] }

export function compareProjects(a: Project, b: Project): CompareReport {
  const ca = new Map(a.components.map((c) => [c.ref, c])), cb = new Map(b.components.map((c) => [c.ref, c]));
  const r: CompareReport = { added: [], removed: [], moved: [], valueChanged: [], footprintChanged: [], netsAdded: [], netsRemoved: [], netsChanged: [], routing: [] };
  for (const [ref, c] of cb) { const o = ca.get(ref); if (!o) { r.added.push(ref); continue; } if (Math.hypot(c.x - o.x, c.y - o.y) > 1e-6 || c.rot !== o.rot || c.side !== o.side) r.moved.push({ ref, dx: +(c.x - o.x).toFixed(3), dy: +(c.y - o.y).toFixed(3), ...(c.rot !== o.rot ? { rot: `${o.rot}->${c.rot}` } : {}), ...(c.side !== o.side ? { side: `${o.side}->${c.side}` } : {}) }); if (c.value !== o.value) r.valueChanged.push({ ref, was: o.value, is: c.value }); if (c.footprint !== o.footprint) r.footprintChanged.push({ ref, was: o.footprint, is: c.footprint }); }
  for (const ref of ca.keys()) if (!cb.has(ref)) r.removed.push(ref);
  const na = new Map(a.nets.map((n) => [n.name, new Set(n.pins)])), nb = new Map(b.nets.map((n) => [n.name, new Set(n.pins)]));
  for (const [n, pins] of nb) { const o = na.get(n); if (!o) { r.netsAdded.push(n); continue; } const add = [...pins].filter((x) => !o.has(x)), rem = [...o].filter((x) => !pins.has(x)); if (add.length || rem.length) r.netsChanged.push({ net: n, added: add, removed: rem }); }
  for (const n of na.keys()) if (!nb.has(n)) r.netsRemoved.push(n);
  const len = (p: Project, n: string) => p.traces.filter((t) => t.net === n).reduce((s, t) => s + t.points.slice(1).reduce((q, pt, i) => q + segLen(t.points[i], pt), 0), 0);
  for (const n of new Set([...na.keys(), ...nb.keys()])) { const la = len(a, n), lb = len(b, n), va = a.vias.filter((v) => v.net === n).length, vb = b.vias.filter((v) => v.net === n).length; if (Math.abs(la - lb) > 0.01 || va !== vb) r.routing.push({ net: n, lengthWas: +la.toFixed(2), lengthIs: +lb.toFixed(2), viasWas: va, viasIs: vb }); }
  return r;
}
