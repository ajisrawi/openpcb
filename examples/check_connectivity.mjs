// Independent connectivity check of a routed session: union-find over pads, wires, vias by geometry.
import { readFileSync } from 'node:fs';
import * as m from '../packages/router/dist/index.js';
const d = m.parseDsn(readFileSync(process.argv[2], 'utf8'));
const ses = m.parseSession(readFileSync(process.argv[3], 'utf8'), d.resolution);
const b = new m.Board(d);
const dps = (q, a, c) => { const dx = c.x - a.x, dy = c.y - a.y; const l2 = dx * dx + dy * dy; let t = l2 ? ((q.x - a.x) * dx + (q.y - a.y) * dy) / l2 : 0; t = Math.max(0, Math.min(1, t)); return Math.hypot(q.x - (a.x + dx * t), q.y - (a.y + dy * t)); };
// via geometry from its own padstack (session library first): radius and the layers it spans
const viaInfo = new Map();
const infoOf = (name) => {
  let i = viaInfo.get(name); if (i) return i;
  const ps = ses.routes.padstacks.find((x) => x.name === name) ?? d.library.padstacks.get(name);
  let r = 0; const layers = new Set();
  for (const s of ps?.shapes ?? []) { if (s.kind === 'circle') r = Math.max(r, (s.diameter ?? 0) / 2); for (const li of b.layersFor(s.layer)) layers.add(li); }
  if (!layers.size) for (let li = 0; li < d.structure.layers.length; li++) layers.add(li);
  i = { r, layers }; viaInfo.set(name, i); return i;
};
let open = 0;
for (const net of d.network.nets.values()) {
  const terms = net.pins.map((p) => b.terminalByRef.get(p)).filter(Boolean);
  const r = ses.routes.nets.get(net.name) ?? { wires: [], vias: [] };
  const n = terms.length + r.wires.length + r.vias.length;
  const parent = Array.from({ length: n }, (_, i) => i);
  const find = (x) => (parent[x] === x ? x : (parent[x] = find(parent[x])));
  const union = (a, c) => { parent[find(a)] = find(c); };
  const T = terms.length, V = T + r.wires.length;
  r.wires.forEach((w, wi) => {
    const li = b.layerIndex(w.layer);
    terms.forEach((t, ti) => { if (!t.layers.includes(li)) return; const pads = t.items.filter((it) => it.layer === li); for (let i = 0; i + 1 < w.points.length; i++) { const seg = { type: 'seg', a: w.points[i], b: w.points[i + 1], hw: w.width / 2 }; if (pads.some((it) => m.geomDistance(seg, it.geom) <= 1)) { union(ti, T + wi); break; } } });
    // a via joins a wire only on a layer the via spans (blind/buried vias end inside the board)
    r.vias.forEach((v, vi) => { if (!infoOf(v.padstack).layers.has(li)) return; for (let i = 0; i + 1 < w.points.length; i++) if (dps(v.at, w.points[i], w.points[i + 1]) <= w.width / 2 + 1) { union(V + vi, T + wi); break; } });
  });
  for (let i = 0; i < r.wires.length; i++) for (let j = i + 1; j < r.wires.length; j++) {
    const a = r.wires[i], c = r.wires[j]; if (a.layer !== c.layer) continue;
    let touch = false;
    for (let s = 0; s + 1 < a.points.length && !touch; s++) for (let t = 0; t + 1 < c.points.length; t++) if (m.distSegSeg(a.points[s], a.points[s + 1], c.points[t], c.points[t + 1]) <= (a.width + c.width) / 2 + 1) { touch = true; break; }
    if (touch) union(T + i, T + j);
  }
  r.vias.forEach((v, vi) => { const inf = infoOf(v.padstack); terms.forEach((t, ti) => { const disk = { type: 'circle', c: v.at, r: inf.r }; if (t.items.some((it) => (it.layer === -1 || inf.layers.has(it.layer)) && m.geomDistance(disk, it.geom) <= 1)) union(ti, V + vi); }); });
  // stacked / overlapping vias sharing a layer are one piece of copper
  r.vias.forEach((v, i) => { const a = infoOf(v.padstack); for (let j = i + 1; j < r.vias.length; j++) { const w = r.vias[j], c = infoOf(w.padstack); if (Math.hypot(v.at.x - w.at.x, v.at.y - w.at.y) <= a.r + c.r + 1 && [...a.layers].some((l) => c.layers.has(l))) union(V + i, V + j); } });
  // plane nets: every through-hole pin and every via of the net is joined by the plane
  // only planes on non-signal layers: a pour on a routed (signal) layer is cut back around other nets and can leave
  // pads on islands, so it proves nothing (use check_pour_connectivity.mjs on the OpenBoard project for pours)
  const signalLayer = (li) => d.structure.layers[li]?.type === 'signal';
  const planeLayers = d.structure.planes.filter((pl) => pl.net === net.name).map((pl) => b.layerIndex(pl.shape.layer)).filter((li) => li >= 0 && !signalLayer(li));
  if (planeLayers.length) {
    // through-hole pins, vias and SMD pins lying on a layer that carries the net's pour are all joined by the plane
    // (a plane node joins them even when no pin sits on the plane itself, e.g. all-SMD nets fed through fanout vias)
    const onPlane = terms.map((t, i) => (!t.isSmd || t.layers.some((l) => planeLayers.includes(l)) ? i : -1)).filter((i) => i >= 0);
    const P = parent.push(parent.length) - 1;
    for (const i of onPlane) union(i, P);
    r.vias.forEach((_, vi) => union(V + vi, P));
  }
  const roots = new Set(terms.map((_, i) => find(i)));
  if (roots.size > 1) {
    open += roots.size - 1;
    console.log(`net ${net.name}: ${roots.size} groups`);
    const groups = {}; terms.forEach((t, i) => { (groups[find(i)] ??= []).push(t.ref); }); console.log('  ', Object.values(groups).map((g) => g.join(',')).join(' | '));
    // dangling wire ends: endpoints not touching anything
    r.wires.forEach((w, wi) => { for (const e of [w.points[0], w.points[w.points.length - 1]]) { let ok = false; for (const t of terms) if (t.items.some((it) => m.geomContains(it.geom, e))) ok = true; for (const v of r.vias) if (Math.hypot(e.x - v.at.x, e.y - v.at.y) < 1) ok = true; for (const o of r.wires) if (o !== w && o.layer === w.layer) for (let s = 0; s + 1 < o.points.length; s++) if (dps(e, o.points[s], o.points[s + 1]) <= 1) ok = true; if (!ok) console.log(`   dangling end of wire ${wi} on ${w.layer} at ${e.x},${e.y}`); } });
  }
}
console.log('open connections', open);
