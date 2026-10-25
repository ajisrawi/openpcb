/**
 * Net connectivity from geometry (pads, traces, vias) -> ratsnest of the
 * still-open connections, plus a simple shape-based DRC for the editor.
 */
import { type Project, type Pt, padToBoard, padLayers, netOfPin, viaLayers, padAngle } from './model.js';
import { defaultLibrary } from './footprints.js';

export interface PadInstance { ref: string; padId: string; key: string; net: string; center: Pt; layers: string[]; w: number; h: number; shape: 'rect' | 'circle' | 'oval'; rot: number; side: 'front' | 'back'; th: boolean; }

export function padInstances(p: Project): PadInstance[] {
  const lib = { ...defaultLibrary(), ...p.footprints };
  const out: PadInstance[] = [];
  for (const c of p.components) {
    const fp = lib[c.footprint]; if (!fp) continue;
    for (const pad of fp.pads) {
      const net = netOfPin(p, c.ref, pad.id);
      out.push({ ref: c.ref, padId: pad.id, key: `${c.ref}-${pad.id}`, net: net?.name ?? '', center: padToBoard(c, pad), layers: padLayers(p, c, pad), w: pad.w, h: pad.h, shape: pad.shape, rot: padAngle(c, pad), side: c.side, th: pad.th });
    }
  }
  return out;
}

function distPtSeg(q: Pt, a: Pt, b: Pt): number {
  const dx = b.x - a.x, dy = b.y - a.y; const l2 = dx * dx + dy * dy;
  let t = l2 > 0 ? ((q.x - a.x) * dx + (q.y - a.y) * dy) / l2 : 0; t = Math.max(0, Math.min(1, t));
  return Math.hypot(q.x - (a.x + dx * t), q.y - (a.y + dy * t));
}
function segSeg(a1: Pt, a2: Pt, b1: Pt, b2: Pt): number {
  const cr = (o: Pt, a: Pt, b: Pt) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  const d1 = cr(b1, b2, a1), d2 = cr(b1, b2, a2), d3 = cr(a1, a2, b1), d4 = cr(a1, a2, b2);
  if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))) return 0;
  return Math.min(distPtSeg(a1, b1, b2), distPtSeg(a2, b1, b2), distPtSeg(b1, a1, a2), distPtSeg(b2, a1, a2));
}

export interface RatLine { net: string; a: Pt; b: Pt; }

/** Compute unrouted connections (ratsnest) per net using union-find over copper. */
/** Distance from segment a-b to a pad's copper (0 when touching/inside), using the pad's real shape and rotation. */
export function distSegPad(pd: PadInstance, a: Pt, b: Pt): number {
  const hw = pd.w / 2, hh = pd.h / 2;
  if (pd.shape === 'circle') return Math.max(0, distPtSeg(pd.center, a, b) - Math.max(hw, hh));
  const r = (-pd.rot * Math.PI) / 180, cs = Math.cos(r), sn = Math.sin(r);
  const loc = (q: Pt): Pt => { const dx = q.x - pd.center.x, dy = q.y - pd.center.y; return { x: dx * cs - dy * sn, y: dx * sn + dy * cs }; };
  const la = loc(a), lb = loc(b);
  if (pd.shape === 'oval') {
    const r0 = Math.min(hw, hh); const ax = Math.max(0, hw - r0), ay = Math.max(0, hh - r0);
    return Math.max(0, segSeg(la, lb, { x: -ax, y: -ay }, { x: ax, y: ay }) - r0);
  }
  const inside = (q: Pt) => Math.abs(q.x) <= hw && Math.abs(q.y) <= hh;
  if (inside(la) || inside(lb)) return 0;
  const cn = [{ x: -hw, y: -hh }, { x: hw, y: -hh }, { x: hw, y: hh }, { x: -hw, y: hh }];
  let d = Infinity;
  for (let i = 0; i < 4; i++) d = Math.min(d, segSeg(la, lb, cn[i], cn[(i + 1) % 4]));
  return d;
}

export function ratsnest(p: Project): RatLine[] {
  const pads = padInstances(p);
  const out: RatLine[] = [];
  const byNet = new Map<string, PadInstance[]>();
  for (const pd of pads) if (pd.net) { const a = byNet.get(pd.net) ?? []; a.push(pd); byNet.set(pd.net, a); }
  for (const [net, nets] of byNet) {
    if (nets.length < 2) continue;
    const traces = p.traces.filter((t) => t.net === net);
    const vias = p.vias.filter((v) => v.net === net);
    const zones = p.zones.filter((z) => z.net === net && z.points.length >= 3);
    const n = nets.length + traces.length + vias.length + zones.length;
    const parent = Array.from({ length: n }, (_, i) => i);
    const find = (x: number): number => (parent[x] === x ? x : (parent[x] = find(parent[x])));
    const union = (a: number, b: number) => { parent[find(a)] = find(b); };
    const T = nets.length, V = T + traces.length;
    // pad-trace
    traces.forEach((t, ti) => {
      nets.forEach((pd, pi) => {
        if (!pd.layers.includes(t.layer)) return;
        for (let i = 0; i + 1 < t.points.length; i++) if (distSegPad(pd, t.points[i], t.points[i + 1]) <= t.width / 2 + 1e-6) { union(pi, T + ti); break; }
      });
      vias.forEach((v, vi) => { if (!viaLayers(p, v).includes(t.layer)) return; for (let i = 0; i + 1 < t.points.length; i++) if (distPtSeg({ x: v.x, y: v.y }, t.points[i], t.points[i + 1]) <= v.diameter / 2 + t.width / 2) { union(V + vi, T + ti); break; } });
    });
    // trace-trace (same layer, touching)
    for (let i = 0; i < traces.length; i++) for (let j = i + 1; j < traces.length; j++) {
      const a = traces[i], b = traces[j]; if (a.layer !== b.layer) continue;
      let touch = false;
      for (let s = 0; s + 1 < a.points.length && !touch; s++) for (let t = 0; t + 1 < b.points.length; t++) if (segSeg(a.points[s], a.points[s + 1], b.points[t], b.points[t + 1]) <= (a.width + b.width) / 2 + 1e-6) { touch = true; break; }
      if (touch) union(T + i, T + j);
    }
    // via-pad (through-hole pads)
    vias.forEach((v, vi) => { const vl = viaLayers(p, v); nets.forEach((pd, pi) => { if (!pd.layers.some((l) => vl.includes(l))) return; if (distSegPad(pd, { x: v.x, y: v.y }, { x: v.x, y: v.y }) <= v.diameter / 2 + 1e-6) union(pi, V + vi); }); });
    // stacked / overlapping vias of the net that share a layer are one piece of copper (blind on buried, etc.)
    vias.forEach((v, i) => { const li = viaLayers(p, v); for (let j = i + 1; j < vias.length; j++) { const w = vias[j]; if (Math.hypot(v.x - w.x, v.y - w.y) <= (v.diameter + w.diameter) / 2 && viaLayers(p, w).some((l) => li.includes(l))) union(V + i, V + j); } });
    // copper pours: pads, vias and traces of the net on the pour's layer inside the polygon are joined by the pour
    const Z = V + vias.length;
    const inPoly = (q: Pt, poly: Pt[]) => { let ins = false; for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) { const a = poly[i], b = poly[j]; if ((a.y > q.y) !== (b.y > q.y) && q.x < ((b.x - a.x) * (q.y - a.y)) / (b.y - a.y) + a.x) ins = !ins; } return ins; };
    zones.forEach((z, zi) => {
      nets.forEach((pd, pi) => { if (pd.layers.includes(z.layer) && inPoly(pd.center, z.points)) union(pi, Z + zi); });
      vias.forEach((v, vi) => { if (viaLayers(p, v).includes(z.layer) && inPoly({ x: v.x, y: v.y }, z.points)) union(V + vi, Z + zi); });
      traces.forEach((t, ti) => { if (t.layer === z.layer && t.points.some((q) => inPoly(q, z.points))) union(T + ti, Z + zi); });
    });
    // wire bonds join their two pads (die pad to bond finger, die to die)
    for (const bw of p.bondWires ?? []) {
      if (bw.net !== net || !('ref' in bw.to)) continue;
      const to = bw.to as { ref: string; pad: string };
      const a = nets.findIndex((pd) => pd.ref === bw.from.ref && pd.padId === bw.from.pad), b = nets.findIndex((pd) => pd.ref === to.ref && pd.padId === to.pad);
      if (a >= 0 && b >= 0) union(a, b);
    }
    // components -> MST between pad groups
    const groups = new Map<number, PadInstance[]>();
    nets.forEach((pd, pi) => { const r = find(pi); const g = groups.get(r) ?? []; g.push(pd); groups.set(r, g); });
    const gl = [...groups.values()];
    const inTree = new Set<number>([0]);
    while (inTree.size < gl.length) {
      let best = Infinity, bj = -1, ba: Pt | null = null, bb: Pt | null = null;
      for (const i of inTree) for (let j = 0; j < gl.length; j++) {
        if (inTree.has(j)) continue;
        for (const a of gl[i]) for (const b of gl[j]) { const dd = Math.hypot(a.center.x - b.center.x, a.center.y - b.center.y); if (dd < best) { best = dd; bj = j; ba = a.center; bb = b.center; } }
      }
      inTree.add(bj); out.push({ net, a: ba!, b: bb! });
    }
  }
  return out;
}

export interface DrcMarker { kind: string; at: Pt; layer: string; message: string; }

