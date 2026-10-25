/**
 * Connectivity with real pour fills.
 *
 * The ratsnest treats a copper pour as joining everything of its net inside the pour outline. A real pour is cut
 * back around every other-net pad, trace and via (exactly as the Gerber export draws it), so a pad deep inside a
 * BGA can sit on a copper island that reaches nothing. This rasterises each pour the way fab.ts draws it (fill,
 * other-net clearances, thermal gaps with spokes, edge clearance, then the net's own copper), labels the islands,
 * and union-finds pads, traces, vias and islands per net. Slow-ish (a few seconds per pour), so it is an explicit
 * check (openpcb pourcheck / drc --pours), not part of the live ratsnest.
 */
import { type Project, type Pt, viaLayers } from './model.js';
import { padInstances, distSegPad, type PadInstance } from './connectivity.js';

export interface PourOpen { net: string; opens: number; pads: string[]; at: Pt }
export interface PourReport { opens: number; nets: PourOpen[]; islands: { net: string; layer: string; islands: number }[] }

export function pourConnectivity(p: Project, opts: { res?: number; net?: string } = {}): PourReport {
  const RES = opts.res ?? 0.03;
  const R = p.rules;
  const pads = padInstances(p);
  const outline = p.outline.length >= 3 ? p.outline : boundsOf(pads.map((x) => x.center));
  const xs = outline.map((q) => q.x), ys = outline.map((q) => q.y);
  const X0 = Math.min(...xs) - 1, Y0 = Math.min(...ys) - 1;
  const NX = Math.ceil((Math.max(...xs) + 1 - X0) / RES), NY = Math.ceil((Math.max(...ys) + 1 - Y0) / RES);
  const grid = new Uint8Array(NX * NY);
  const label = new Int32Array(NX * NY);
  const stack = new Int32Array(NX * NY);
  const gi = (x: number) => Math.floor((x - X0) / RES), gj = (y: number) => Math.floor((y - Y0) / RES);
  const cx = (i: number) => X0 + (i + 0.5) * RES, cy = (j: number) => Y0 + (j + 0.5) * RES;
  const segDist = (px: number, py: number, a: Pt, b: Pt) => { const dx = b.x - a.x, dy = b.y - a.y, l2 = dx * dx + dy * dy; let t = l2 ? ((px - a.x) * dx + (py - a.y) * dy) / l2 : 0; t = Math.max(0, Math.min(1, t)); return Math.hypot(px - a.x - dx * t, py - a.y - dy * t); };

  const fillPoly = (poly: Pt[], v: number) => {
    const j0 = Math.max(0, gj(Math.min(...poly.map((q) => q.y)))), j1 = Math.min(NY - 1, gj(Math.max(...poly.map((q) => q.y))));
    for (let j = j0; j <= j1; j++) {
      const y = cy(j), cut: number[] = [];
      for (let a = 0, b = poly.length - 1; a < poly.length; b = a++) { const A = poly[a], B = poly[b]; if ((A.y > y) !== (B.y > y)) cut.push(A.x + ((y - A.y) * (B.x - A.x)) / (B.y - A.y)); }
      cut.sort((m, n) => m - n);
      for (let k = 0; k + 1 < cut.length; k += 2) { const i0 = Math.max(0, Math.ceil((cut[k] - X0) / RES - 0.5)), i1 = Math.min(NX - 1, Math.floor((cut[k + 1] - X0) / RES - 0.5)); if (i1 >= i0) grid.fill(v, j * NX + i0, j * NX + i1 + 1); }
    }
  };
  const capsule = (a: Pt, b: Pt, r: number, v: number) => {
    const i0 = Math.max(0, gi(Math.min(a.x, b.x) - r)), i1 = Math.min(NX - 1, gi(Math.max(a.x, b.x) + r));
    const j0 = Math.max(0, gj(Math.min(a.y, b.y) - r)), j1 = Math.min(NY - 1, gj(Math.max(a.y, b.y) + r));
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) if (segDist(cx(i), cy(j), a, b) <= r) grid[j * NX + i] = v;
  };
  const padShape = (pd: PadInstance, grow: number, v: number) => {
    const ang = (pd.rot * Math.PI) / 180, cs = Math.cos(ang), sn = Math.sin(ang);
    if (pd.shape === 'circle') return capsule(pd.center, pd.center, Math.max(pd.w, pd.h) / 2 + grow, v);
    if (pd.shape === 'oval') {
      const long = Math.max(pd.w, pd.h), short = Math.min(pd.w, pd.h), h = (long - short) / 2;
      const ux = pd.w >= pd.h ? cs : -sn, uy = pd.w >= pd.h ? sn : cs;
      return capsule({ x: pd.center.x - ux * h, y: pd.center.y - uy * h }, { x: pd.center.x + ux * h, y: pd.center.y + uy * h }, short / 2 + grow, v);
    }
    const hw = pd.w / 2, hh = pd.h / 2, ext = Math.hypot(hw, hh) + grow;
    const i0 = Math.max(0, gi(pd.center.x - ext)), i1 = Math.min(NX - 1, gi(pd.center.x + ext)), j0 = Math.max(0, gj(pd.center.y - ext)), j1 = Math.min(NY - 1, gj(pd.center.y + ext));
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
      const dx = cx(i) - pd.center.x, dy = cy(j) - pd.center.y;
      const lx = Math.abs(dx * cs + dy * sn) - hw, ly = Math.abs(-dx * sn + dy * cs) - hh;
      const d = Math.hypot(Math.max(lx, 0), Math.max(ly, 0)) + Math.min(Math.max(lx, ly), 0);
      if (d <= grow) grid[j * NX + i] = v;
    }
  };
  const inPoly = (q: Pt, poly: Pt[]) => { let ins = false; for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) { const a = poly[i], b = poly[j]; if ((a.y > q.y) !== (b.y > q.y) && q.x < ((b.x - a.x) * (q.y - a.y)) / (b.y - a.y) + a.x) ins = !ins; } return ins; };
  const labelGrid = () => {
    label.fill(0); let n = 0;
    for (let s = 0; s < grid.length; s++) {
      if (!grid[s] || label[s]) continue;
      n++; let top = 0; stack[top++] = s; label[s] = n;
      while (top) {
        const c = stack[--top], i = c % NX;
        if (i > 0 && grid[c - 1] && !label[c - 1]) { label[c - 1] = n; stack[top++] = c - 1; }
        if (i < NX - 1 && grid[c + 1] && !label[c + 1]) { label[c + 1] = n; stack[top++] = c + 1; }
        if (c >= NX && grid[c - NX] && !label[c - NX]) { label[c - NX] = n; stack[top++] = c - NX; }
        if (c + NX < grid.length && grid[c + NX] && !label[c + NX]) { label[c + NX] = n; stack[top++] = c + NX; }
      }
    }
    return n;
  };
  const labelAt = (q: Pt) => { const i = gi(q.x), j = gj(q.y); return i < 0 || j < 0 || i >= NX || j >= NY ? 0 : label[j * NX + i]; };

  // ---- islands of every pour ----
  const zones = p.zones.filter((z) => z.points.length >= 3 && (!opts.net || z.net === opts.net));
  const itemIsland: [string, string][] = [];
  const islands: PourReport['islands'] = [];
  zones.forEach((z, zi) => {
    grid.fill(0);
    fillPoly(z.points, 1);
    const layer = z.layer, c = Math.max(z.clearance ?? 0, R.clearance);
    // split planes: higher-priority (earlier) pours of other nets on this layer, plus a clearance band, are not ours
    const all = p.zones.filter((o) => o.layer === layer && o.points.length >= 3);
    for (const o of all.slice(0, all.indexOf(z))) if (o.net !== z.net) { fillPoly(o.points, 0); for (let i = 0; i < o.points.length; i++) capsule(o.points[i], o.points[(i + 1) % o.points.length], c, 0); }
    // ground voids (RF): no pour copper inside them
    if (z.dynamic) for (const v of p.voids ?? []) if (v.layer === layer && v.points.length >= 3) fillPoly(v.points, 0);
    const lpads = pads.filter((pd) => pd.layers.includes(layer));
    const traces = p.traces.filter((t) => t.layer === layer);
    const vias = p.vias.filter((v) => viaLayers(p, v).includes(layer));
    if (z.dynamic) {
      const clears: (() => void)[] = [];
      for (const pd of lpads) { padShape(pd, c, 0); if (!(pd.net && pd.net === z.net)) clears.push(() => padShape(pd, c, 0)); }
      for (const t of traces) if (t.net !== z.net) { const f = () => { for (let i = 0; i + 1 < t.points.length; i++) capsule(t.points[i], t.points[i + 1], t.width / 2 + c, 0); }; f(); clears.push(f); }
      for (const v of vias) if (v.net !== z.net) { const f = () => capsule(v, v, v.diameter / 2 + c, 0); f(); clears.push(f); }
      if (p.outline.length >= 3) { const f = () => { for (let i = 0; i < p.outline.length; i++) capsule(p.outline[i], p.outline[(i + 1) % p.outline.length], R.edgeClearance, 0); }; f(); clears.push(f); }
      for (const pd of lpads) if (pd.net && pd.net === z.net) {
        const reach = Math.max(pd.w, pd.h) / 2 + c + 0.05, width = Math.max(R.width, Math.min(pd.w, pd.h) * 0.4, 0.2);
        const ang = (pd.rot * Math.PI) / 180, cs = Math.cos(ang), sn = Math.sin(ang);
        for (const [ux, uy] of [[cs, sn], [-cs, -sn], [-sn, cs], [sn, -cs]]) {
          const end = { x: pd.center.x + ux * (reach + width / 2), y: pd.center.y + uy * (reach + width / 2) };
          if (!inPoly(end, z.points)) continue;
          capsule(pd.center, { x: pd.center.x + ux * reach, y: pd.center.y + uy * reach }, width / 2, 1);
        }
      }
      for (const f of clears) f();
    }
    for (const pd of lpads) if (pd.net === z.net) padShape(pd, 0, 1);
    for (const t of traces) if (t.net === z.net) for (let i = 0; i + 1 < t.points.length; i++) capsule(t.points[i], t.points[i + 1], t.width / 2, 1);
    for (const v of vias) if (v.net === z.net) capsule(v, v, v.diameter / 2, 1);
    islands.push({ net: z.net, layer, islands: labelGrid() });
    for (const pd of lpads) if (pd.net === z.net) { const l = labelAt(pd.center); if (l) itemIsland.push([`pad:${pd.key}`, `${zi}:${l}`]); }
    for (const t of traces) if (t.net === z.net) { const l = labelAt(t.points[0]); if (l) itemIsland.push([`trace:${t.id}`, `${zi}:${l}`]); }
    for (const v of vias) if (v.net === z.net) { const l = labelAt(v); if (l) itemIsland.push([`via:${v.id}`, `${zi}:${l}`]); }
  });

  // ---- per-net union-find ----
  const distPtSeg = (q: Pt, a: Pt, b: Pt) => segDist(q.x, q.y, a, b);
  const cross = (o: Pt, a: Pt, b: Pt) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  // segment-to-segment distance: 0 when they cross, otherwise the closest end point to the other segment
  const segSeg = (a: Pt, b: Pt, c2: Pt, d: Pt) => {
    const d1 = cross(c2, d, a), d2 = cross(c2, d, b), d3 = cross(a, b, c2), d4 = cross(a, b, d);
    if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))) return 0;
    return Math.min(distPtSeg(a, c2, d), distPtSeg(b, c2, d), distPtSeg(c2, a, b), distPtSeg(d, a, b));
  };
  const byNet = new Map<string, PadInstance[]>();
  for (const pd of pads) if (pd.net) { const a = byNet.get(pd.net) ?? []; a.push(pd); byNet.set(pd.net, a); }
  const report: PourOpen[] = []; let total = 0;
  for (const [net, nps] of byNet) {
    if (opts.net && net !== opts.net) continue;
    if (nps.length < 2) continue;
    const traces = p.traces.filter((t) => t.net === net), vias = p.vias.filter((v) => v.net === net);
    const keys = new Map<string, number>(); const parent: number[] = [];
    const id = (k: string) => { let x = keys.get(k); if (x === undefined) { x = parent.length; parent.push(x); keys.set(k, x); } return x; };
    const find = (x: number): number => (parent[x] === x ? x : (parent[x] = find(parent[x])));
    const union = (a: number, b: number) => { parent[find(a)] = find(b); };
    nps.forEach((pd) => id('pad:' + pd.key)); traces.forEach((t) => id('trace:' + t.id)); vias.forEach((v) => id('via:' + v.id));
    for (const t of traces) {
      for (const pd of nps) { if (!pd.layers.includes(t.layer)) continue; for (let i = 0; i + 1 < t.points.length; i++) if (distSegPad(pd, t.points[i], t.points[i + 1]) <= t.width / 2 + 1e-6) { union(id('pad:' + pd.key), id('trace:' + t.id)); break; } }
      for (const v of vias) { if (!viaLayers(p, v).includes(t.layer)) continue; for (let i = 0; i + 1 < t.points.length; i++) if (distPtSeg(v, t.points[i], t.points[i + 1]) <= v.diameter / 2 + t.width / 2) { union(id('via:' + v.id), id('trace:' + t.id)); break; } }
    }
    for (let i = 0; i < traces.length; i++) for (let j = i + 1; j < traces.length; j++) {
      const a = traces[i], b = traces[j]; if (a.layer !== b.layer) continue;
      outer: for (let s = 0; s + 1 < a.points.length; s++) for (let t = 0; t + 1 < b.points.length; t++) if (segSeg(a.points[s], a.points[s + 1], b.points[t], b.points[t + 1]) <= (a.width + b.width) / 2 + 1e-6) { union(id('trace:' + a.id), id('trace:' + b.id)); break outer; }
    }
    for (const v of vias) { const vl = viaLayers(p, v); for (const pd of nps) if (pd.layers.some((l) => vl.includes(l)) && distSegPad(pd, v, v) <= v.diameter / 2 + 1e-6) union(id('pad:' + pd.key), id('via:' + v.id)); }
    vias.forEach((v, i) => { const li = viaLayers(p, v); for (let j = i + 1; j < vias.length; j++) { const w = vias[j]; if (Math.hypot(v.x - w.x, v.y - w.y) <= (v.diameter + w.diameter) / 2 && viaLayers(p, w).some((l) => li.includes(l))) union(id('via:' + v.id), id('via:' + w.id)); } });
    for (const [item, isl] of itemIsland) if (keys.has(item)) union(id(item), id('island:' + isl));
    const groups = new Map<number, PadInstance[]>();
    for (const pd of nps) { const r = find(id('pad:' + pd.key)); const g = groups.get(r) ?? []; g.push(pd); groups.set(r, g); }
    if (groups.size > 1) {
      const gl = [...groups.values()].sort((a, b) => b.length - a.length);
      const cut = gl.slice(1).flat();
      total += groups.size - 1;
      report.push({ net, opens: groups.size - 1, pads: cut.map((x) => x.key), at: cut[0].center });
    }
  }
  report.sort((a, b) => b.opens - a.opens);
  return { opens: total, nets: report, islands };
}

function boundsOf(pts: Pt[]): Pt[] {
  const xs = pts.map((q) => q.x), ys = pts.map((q) => q.y);
  const x0 = Math.min(...xs) - 5, x1 = Math.max(...xs) + 5, y0 = Math.min(...ys) - 5, y1 = Math.max(...ys) + 5;
  return [{ x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 }];
}
