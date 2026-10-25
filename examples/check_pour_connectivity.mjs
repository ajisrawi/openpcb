// Physical connectivity check of an OpenBoard project WITH REAL POUR FILLS.
//
// OpenBoard's ratsnest (and the router's plane model) treat a copper pour as joining everything of its net inside
// the pour outline. A real pour is cut back around every other-net pad, trace and via, so a pad deep inside a BGA
// can end up on a copper island that touches nothing. This script rasterises each pour the way the Gerber export
// draws it (fill, other-net clearances, thermal gaps + spokes, edge clearance, then the net's own copper), labels
// the copper islands, and union-finds pads, vias, traces and islands per net.
//
// usage: node examples/check_pour_connectivity.mjs <project.openboard.json> [--res 0.03] [--net GND] [--list]
import { readFileSync } from 'node:fs';
import { normalizeProject, viaLayers } from '../packages/cli/dist/editor/src/model.js';
import { padInstances, distSegPad } from '../packages/cli/dist/editor/src/connectivity.js';

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const p = normalizeProject(JSON.parse(readFileSync(args[0], 'utf8')));
const RES = Number(opt('--res', 0.03));
const onlyNet = opt('--net', null);
const list = args.includes('--list');
const R = p.rules;
const pads = padInstances(p);

// ---------- raster helpers ----------
const xs = p.outline.map((q) => q.x), ys = p.outline.map((q) => q.y);
const X0 = Math.min(...xs) - 1, Y0 = Math.min(...ys) - 1;
const NX = Math.ceil((Math.max(...xs) + 1 - X0) / RES), NY = Math.ceil((Math.max(...ys) + 1 - Y0) / RES);
const grid = new Uint8Array(NX * NY);
const label = new Int32Array(NX * NY);
const gi = (x) => Math.floor((x - X0) / RES), gj = (y) => Math.floor((y - Y0) / RES);
const cx = (i) => X0 + (i + 0.5) * RES, cy = (j) => Y0 + (j + 0.5) * RES;
function fillPoly(poly, v) {
  let j0 = Math.max(0, gj(Math.min(...poly.map((q) => q.y)))), j1 = Math.min(NY - 1, gj(Math.max(...poly.map((q) => q.y))));
  for (let j = j0; j <= j1; j++) {
    const y = cy(j), xsx = [];
    for (let a = 0, b = poly.length - 1; a < poly.length; b = a++) { const A = poly[a], B = poly[b]; if ((A.y > y) !== (B.y > y)) xsx.push(A.x + ((y - A.y) * (B.x - A.x)) / (B.y - A.y)); }
    xsx.sort((m, n) => m - n);
    for (let k = 0; k + 1 < xsx.length; k += 2) { const i0 = Math.max(0, Math.ceil((xsx[k] - X0) / RES - 0.5)), i1 = Math.min(NX - 1, Math.floor((xsx[k + 1] - X0) / RES - 0.5)); grid.fill(v, j * NX + i0, j * NX + i1 + 1); }
  }
}
const segDist = (px, py, a, b) => { const dx = b.x - a.x, dy = b.y - a.y, l2 = dx * dx + dy * dy; let t = l2 ? ((px - a.x) * dx + (py - a.y) * dy) / l2 : 0; t = Math.max(0, Math.min(1, t)); return Math.hypot(px - a.x - dx * t, py - a.y - dy * t); };
function capsule(a, b, r, v) {
  const i0 = Math.max(0, gi(Math.min(a.x, b.x) - r)), i1 = Math.min(NX - 1, gi(Math.max(a.x, b.x) + r));
  const j0 = Math.max(0, gj(Math.min(a.y, b.y) - r)), j1 = Math.min(NY - 1, gj(Math.max(a.y, b.y) + r));
  for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) if (segDist(cx(i), cy(j), a, b) <= r) grid[j * NX + i] = v;
}
function padShape(pd, grow, v) {
  const a = (pd.rot * Math.PI) / 180, cs = Math.cos(a), sn = Math.sin(a);
  if (pd.shape === 'circle') return capsule(pd.center, pd.center, Math.max(pd.w, pd.h) / 2 + grow, v);
  if (pd.shape === 'oval') {
    const long = Math.max(pd.w, pd.h), short = Math.min(pd.w, pd.h), h = (long - short) / 2;
    const ux = pd.w >= pd.h ? cs : -sn, uy = pd.w >= pd.h ? sn : cs;
    return capsule({ x: pd.center.x - ux * h, y: pd.center.y - uy * h }, { x: pd.center.x + ux * h, y: pd.center.y + uy * h }, short / 2 + grow, v);
  }
  // rectangle grown by a rounded margin
  const hw = pd.w / 2, hh = pd.h / 2, ext = Math.hypot(hw, hh) + grow;
  const i0 = Math.max(0, gi(pd.center.x - ext)), i1 = Math.min(NX - 1, gi(pd.center.x + ext)), j0 = Math.max(0, gj(pd.center.y - ext)), j1 = Math.min(NY - 1, gj(pd.center.y + ext));
  for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
    const dx = cx(i) - pd.center.x, dy = cy(j) - pd.center.y;
    const lx = Math.abs(dx * cs + dy * sn) - hw, ly = Math.abs(-dx * sn + dy * cs) - hh;
    const d = Math.hypot(Math.max(lx, 0), Math.max(ly, 0)) + Math.min(Math.max(lx, ly), 0);
    if (d <= grow) grid[j * NX + i] = v;
  }
}
const inPoly = (q, poly) => { let ins = false; for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) { const a = poly[i], b = poly[j]; if ((a.y > q.y) !== (b.y > q.y) && q.x < ((b.x - a.x) * (q.y - a.y)) / (b.y - a.y) + a.x) ins = !ins; } return ins; };
function labelGrid() {
  label.fill(0); let n = 0; const stack = new Int32Array(NX * NY);
  for (let s = 0; s < grid.length; s++) {
    if (!grid[s] || label[s]) continue;
    n++; let top = 0; stack[top++] = s; label[s] = n;
    while (top) { const c = stack[--top], i = c % NX; const nb = [i > 0 ? c - 1 : -1, i < NX - 1 ? c + 1 : -1, c - NX, c + NX];
      for (const m of nb) if (m >= 0 && m < grid.length && grid[m] && !label[m]) { label[m] = n; stack[top++] = m; } }
  }
  return n;
}
const labelAt = (q) => { const i = gi(q.x), j = gj(q.y); return i < 0 || j < 0 || i >= NX || j >= NY ? 0 : label[j * NX + i]; };

// ---------- per-zone islands ----------
// islandOf[zoneIndex] = { labelAt-snapshot for the items that matter }
const zones = p.zones.filter((z) => z.points.length >= 3 && (!onlyNet || z.net === onlyNet));
const itemIsland = new Map();   // key 'pad:<key>|<zi>' etc -> island id string
for (const [zi, z] of zones.entries()) {
  const t0 = Date.now();
  grid.fill(0);
  fillPoly(z.points, 1);
  const layer = z.layer, c = Math.max(z.clearance ?? 0, R.clearance);
  const lpads = pads.filter((pd) => pd.layers.includes(layer));
  const traces = p.traces.filter((t) => t.layer === layer);
  const vias = p.vias.filter((v) => viaLayers(p, v).includes(layer));
  const clears = [];
  if (z.dynamic) {
    for (const pd of lpads) { padShape(pd, c, 0); if (!(pd.net && pd.net === z.net)) clears.push(() => padShape(pd, c, 0)); }
    for (const t of traces) if (t.net !== z.net) { const f = () => { for (let i = 0; i + 1 < t.points.length; i++) capsule(t.points[i], t.points[i + 1], t.width / 2 + c, 0); }; f(); clears.push(f); }
    for (const v of vias) if (v.net !== z.net) { const f = () => capsule(v, v, v.diameter / 2 + c, 0); f(); clears.push(f); }
    if (p.outline.length >= 3) { const f = () => { for (let i = 0; i < p.outline.length; i++) capsule(p.outline[i], p.outline[(i + 1) % p.outline.length], R.edgeClearance, 0); }; f(); clears.push(f); }
    // thermal spokes for same-net pads
    for (const pd of lpads) if (pd.net && pd.net === z.net) {
      const reach = Math.max(pd.w, pd.h) / 2 + c + 0.05, width = Math.max(R.width, Math.min(pd.w, pd.h) * 0.4, 0.2);
      const a = (pd.rot * Math.PI) / 180, cs = Math.cos(a), sn = Math.sin(a);
      for (const [ux, uy] of [[cs, sn], [-cs, -sn], [-sn, cs], [sn, -cs]]) {
        const end = { x: pd.center.x + ux * (reach + width / 2), y: pd.center.y + uy * (reach + width / 2) };
        if (!inPoly(end, z.points)) continue;
        capsule(pd.center, { x: pd.center.x + ux * reach, y: pd.center.y + uy * reach }, width / 2, 1);
      }
    }
    for (const f of clears) f();
  }
  // the net's own copper on this layer
  for (const pd of lpads) if (pd.net === z.net) padShape(pd, 0, 1);
  for (const t of traces) if (t.net === z.net) for (let i = 0; i + 1 < t.points.length; i++) capsule(t.points[i], t.points[i + 1], t.width / 2, 1);
  for (const v of vias) if (v.net === z.net) capsule(v, v, v.diameter / 2, 1);
  const n = labelGrid();
  for (const pd of lpads) if (pd.net === z.net) { const l = labelAt(pd.center); if (l) itemIsland.set(`pad:${pd.key}|${zi}`, `${zi}:${l}`); }
  for (const t of traces) if (t.net === z.net) { const l = labelAt(t.points[0]); if (l) itemIsland.set(`trace:${t.id}|${zi}`, `${zi}:${l}`); }
  for (const v of vias) if (v.net === z.net) { const l = labelAt(v); if (l) itemIsland.set(`via:${v.id}|${zi}`, `${zi}:${l}`); }
  console.error(`zone ${zi} ${z.net} on ${layer}: ${n} islands (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
}

// ---------- per-net union-find ----------
const distPtSeg = (q, a, b) => segDist(q.x, q.y, a, b);
const cross = (o, a, b) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
// segment-to-segment distance: 0 when they cross, otherwise the closest end point to the other segment
const segSeg = (a, b, c2, d) => {
  const d1 = cross(c2, d, a), d2 = cross(c2, d, b), d3 = cross(a, b, c2), d4 = cross(a, b, d);
  if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))) return 0;
  return Math.min(distPtSeg(a, c2, d), distPtSeg(b, c2, d), distPtSeg(c2, a, b), distPtSeg(d, a, b));
};
let totalOpen = 0; const report = [];
const byNet = new Map();
for (const pd of pads) if (pd.net) { const a = byNet.get(pd.net) ?? []; a.push(pd); byNet.set(pd.net, a); }
for (const [net, nps] of byNet) {
  if (onlyNet && net !== onlyNet) continue;
  if (nps.length < 2) continue;
  const traces = p.traces.filter((t) => t.net === net), vias = p.vias.filter((v) => v.net === net);
  const keys = new Map(); const parent = [];
  const id = (k) => { let x = keys.get(k); if (x === undefined) { x = parent.length; parent.push(x); keys.set(k, x); } return x; };
  const find = (x) => (parent[x] === x ? x : (parent[x] = find(parent[x])));
  const union = (a, b) => { parent[find(a)] = find(b); };
  nps.forEach((pd) => id('pad:' + pd.key)); traces.forEach((t) => id('trace:' + t.id)); vias.forEach((v) => id('via:' + v.id));
  traces.forEach((t) => {
    nps.forEach((pd) => { if (!pd.layers.includes(t.layer)) return; for (let i = 0; i + 1 < t.points.length; i++) if (distSegPad(pd, t.points[i], t.points[i + 1]) <= t.width / 2 + 1e-6) { union(id('pad:' + pd.key), id('trace:' + t.id)); break; } });
    vias.forEach((v) => { if (!viaLayers(p, v).includes(t.layer)) return; for (let i = 0; i + 1 < t.points.length; i++) if (distPtSeg(v, t.points[i], t.points[i + 1]) <= v.diameter / 2 + t.width / 2) { union(id('via:' + v.id), id('trace:' + t.id)); break; } });
  });
  for (let i = 0; i < traces.length; i++) for (let j = i + 1; j < traces.length; j++) {
    const a = traces[i], b = traces[j]; if (a.layer !== b.layer) continue;
    outer: for (let s = 0; s + 1 < a.points.length; s++) for (let t = 0; t + 1 < b.points.length; t++) if (segSeg(a.points[s], a.points[s + 1], b.points[t], b.points[t + 1]) <= (a.width + b.width) / 2 + 1e-6) { union(id('trace:' + a.id), id('trace:' + b.id)); break outer; }
  }
  vias.forEach((v) => { const vl = viaLayers(p, v); nps.forEach((pd) => { if (pd.layers.some((l) => vl.includes(l)) && distSegPad(pd, v, v) <= v.diameter / 2 + 1e-6) union(id('pad:' + pd.key), id('via:' + v.id)); }); });
  vias.forEach((v, i) => { const li = viaLayers(p, v); for (let j = i + 1; j < vias.length; j++) { const w = vias[j]; if (Math.hypot(v.x - w.x, v.y - w.y) <= (v.diameter + w.diameter) / 2 && viaLayers(p, w).some((l) => li.includes(l))) union(id('via:' + v.id), id('via:' + w.id)); } });
  for (const [k, isl] of itemIsland) { const [item] = k.split('|'); if (!keys.has(item)) continue; union(id(item), id('island:' + isl)); }
  const groups = new Map();
  for (const pd of nps) { const r = find(id('pad:' + pd.key)); const g = groups.get(r) ?? []; g.push(pd.key); groups.set(r, g); }
  if (groups.size > 1) {
    totalOpen += groups.size - 1;
    const gl = [...groups.values()].sort((a, b) => b.length - a.length);
    report.push({ net, opens: groups.size - 1, cutOff: gl.slice(1).flat() });
  }
}
report.sort((a, b) => b.opens - a.opens);
console.log(JSON.stringify({ ok: true, opens: totalOpen, nets: report.length, byNet: report.map((r) => ({ net: r.net, opens: r.opens, ...(list ? { pads: r.cutOff } : { sample: r.cutOff.slice(0, 6) }) })) }, null, 1));
