/**
 * Interactive routing helpers (Allegro "add connect" support):
 *   shoveVictims  — after a hand-drawn trace is committed, the other nets' *unlocked* copper it crowds; the editor
 *                   rips that copper up and reroutes those nets around the new trace (shove by reroute).
 *   lengthStatus  — live timing feedback while drawing: the net's routed length (+ the draft) against its
 *                   min/max, its differential-pair partner or its length-match group.
 */
import { type Project, type Pt, type Trace, netClearance } from './model.js';
import { padInstances } from './connectivity.js';
import { padGeometry } from './drc.js';
import { geomDistance } from '@openpcb/router';

export function shoveVictims(p: Project, t: Trace): { nets: string[]; traces: number[]; vias: number[] } {
  const c = p.rules.clearance;
  const traces: number[] = [], vias: number[] = [], nets = new Set<string>();
  for (const o of p.traces) {
    if (o === t || o.locked || o.net === t.net || o.layer !== t.layer) continue;
    let hit = false;
    for (let i = 1; i < t.points.length && !hit; i++) for (let j = 1; j < o.points.length && !hit; j++)
      if (geomDistance({ type: 'seg', a: t.points[i - 1], b: t.points[i], hw: t.width / 2 }, { type: 'seg', a: o.points[j - 1], b: o.points[j], hw: o.width / 2 }) < c) hit = true;
    if (hit) { traces.push(o.id); nets.add(o.net); }
  }
  for (const v of p.vias) {
    if (v.locked || v.net === t.net) continue;
    for (let i = 1; i < t.points.length; i++) if (geomDistance({ type: 'seg', a: t.points[i - 1], b: t.points[i], hw: t.width / 2 }, { type: 'circle', c: { x: v.x, y: v.y }, r: v.diameter / 2 }) < c) { vias.push(v.id); nets.add(v.net); break; }
  }
  // a shoved net is rerouted as a whole: all its unlocked copper goes
  for (const o of p.traces) if (!o.locked && nets.has(o.net) && !traces.includes(o.id)) traces.push(o.id);
  for (const v of p.vias) if (!v.locked && nets.has(v.net) && !vias.includes(v.id)) vias.push(v.id);
  return { nets: [...nets].filter(Boolean), traces, vias };
}

const polyLen = (pts: Pt[]) => { let L = 0; for (let i = 1; i < pts.length; i++) L += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y); return L; };
export function netLength(p: Project, net: string): number {
  return p.traces.filter((t) => t.net === net).reduce((s, t) => s + polyLen(t.points), 0) + p.vias.filter((v) => v.net === net).length * p.rules.viaLength;
}

/** "len 12.40 mm  (target 15.00–20.00, 2.60 short)" for the status bar, or '' when the net has no length rule. */
export function lengthStatus(p: Project, net: string, draft: Pt[]): string {
  if (!net) return '';
  const L = netLength(p, net) + polyLen(draft);
  const n = p.nets.find((x) => x.name === net);
  let lo: number | undefined = n?.minLength, hi: number | undefined = n?.maxLength, why = '';
  const dp = p.diffPairs.find((d) => d.p === net || d.n === net);
  if (dp) { const other = netLength(p, dp.p === net ? dp.n : dp.p); lo = other - dp.maxSkew; hi = other + dp.maxSkew; why = 'pair'; }
  const g = p.lengthGroups.find((x) => x.nets.includes(net));
  if (g) { const m = Math.max(...g.nets.filter((x) => x !== net).map((x) => netLength(p, x))); lo = m - g.tolerance; hi = m + g.tolerance; why = `group ${g.name}`; }
  if (lo === undefined && hi === undefined) return `len ${L.toFixed(2)} mm`;
  const tgt = `${lo !== undefined ? lo.toFixed(2) : '–'}–${hi !== undefined ? hi.toFixed(2) : '–'}`;
  const state = lo !== undefined && L < lo ? `${(lo - L).toFixed(2)} short` : hi !== undefined && L > hi ? `${(L - hi).toFixed(2)} long` : 'OK';
  return `len ${L.toFixed(2)} mm (${why ? why + ' ' : ''}target ${tgt}: ${state})`;
}

/* ============================== geometric push-and-shove ============================== */

const dPtSeg = (q: Pt, a: Pt, b: Pt): { d: number; c: Pt } => { const dx = b.x - a.x, dy = b.y - a.y, l2 = dx * dx + dy * dy; let tt = l2 ? ((q.x - a.x) * dx + (q.y - a.y) * dy) / l2 : 0; tt = Math.max(0, Math.min(1, tt)); const c = { x: a.x + dx * tt, y: a.y + dy * tt }; return { d: Math.hypot(q.x - c.x, q.y - c.y), c }; };
function segsCross(a: Pt, b: Pt, c: Pt, d: Pt): boolean {
  const o = (p: Pt, q: Pt, r: Pt) => (q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x);
  const d1 = o(c, d, a), d2 = o(c, d, b), d3 = o(a, b, c), d4 = o(a, b, d);
  return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
}
/** Douglas-Peucker on a polyline (keeps the end points). */
function simplify(pts: Pt[], tol: number): Pt[] {
  if (pts.length <= 2) return pts;
  let idx = -1, best = 0;
  for (let i = 1; i < pts.length - 1; i++) { const d = dPtSeg(pts[i], pts[0], pts[pts.length - 1]).d; if (d > best) { best = d; idx = i; } }
  if (best <= tol) return [pts[0], pts[pts.length - 1]];
  return [...simplify(pts.slice(0, idx + 1), tol).slice(0, -1), ...simplify(pts.slice(idx), tol)];
}
const r4 = (q: Pt) => ({ x: Math.round(q.x * 1e4) / 1e4, y: Math.round(q.y * 1e4) / 1e4 });

interface Obst { net: string; layer: string; w: number; pts: Pt[] }
const clr = (p: Project, a: string, b: string) => Math.max(netClearance(p, a), netClearance(p, b));

/** A polyline displaced away from an obstacle polyline so that every point keeps `need` from it; null if it crosses. */
function displace(pts: Pt[], o: Obst, need: number, fixedEnds: [boolean, boolean]): Pt[] | null {
  for (let i = 1; i < pts.length; i++) for (let j = 1; j < o.pts.length; j++) if (segsCross(pts[i - 1], pts[i], o.pts[j - 1], o.pts[j])) return null;
  const step = 0.05, out: Pt[] = [];
  let moved = false;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i], L = Math.hypot(b.x - a.x, b.y - a.y), n = Math.max(1, Math.ceil(L / step));
    for (let k = i === 1 ? 0 : 1; k <= n; k++) {
      const q = { x: a.x + ((b.x - a.x) * k) / n, y: a.y + ((b.y - a.y) * k) / n };
      let best = { d: Infinity, c: q };
      for (let j = 1; j < o.pts.length; j++) { const r = dPtSeg(q, o.pts[j - 1], o.pts[j]); if (r.d < best.d) best = r; }
      if (best.d < need - 1e-9) {
        const isEnd = (i === 1 && k === 0 && fixedEnds[0]) || (i === pts.length - 1 && k === n && fixedEnds[1]);
        if (isEnd || best.d < 1e-9) return null;
        // margin covers the simplification tolerance below (a chord may cut inwards by up to it)
        const s = (need + 0.007) / best.d;
        out.push({ x: best.c.x + (q.x - best.c.x) * s, y: best.c.y + (q.y - best.c.y) * s }); moved = true;
      } else out.push(q);
    }
  }
  return moved ? simplify(out, 0.004).map(r4) : pts;
}

/** Fixed things a pushed trace must still clear: pads, vias, locked traces of other nets, the board edge. */
function fitsFixed(p: Project, net: string, layer: string, w: number, pts: Pt[], skip: Set<number>): boolean {
  const pads = padInstances(p);
  for (let i = 1; i < pts.length; i++) {
    const seg = { type: 'seg' as const, a: pts[i - 1], b: pts[i], hw: w / 2 };
    for (const pd of pads) { if (pd.net === net || !pd.layers.includes(layer)) continue; if (geomDistance(seg, padGeometry(pd)) < clr(p, net, pd.net)) return false; }
    for (const v of p.vias) { if (v.net === net) continue; if (geomDistance(seg, { type: 'circle', c: { x: v.x, y: v.y }, r: v.diameter / 2 }) < clr(p, net, v.net)) return false; }
    for (const t of p.traces) { if (t.net === net || t.layer !== layer || !t.locked || skip.has(t.id)) continue; for (let j = 1; j < t.points.length; j++) if (geomDistance(seg, { type: 'seg', a: t.points[j - 1], b: t.points[j], hw: t.width / 2 }) < clr(p, net, t.net)) return false; }
    let inside = false; const q = pts[i];
    for (let a = 0, b = p.outline.length - 1; a < p.outline.length; b = a++) { const A = p.outline[a], B = p.outline[b]; if ((A.y > q.y) !== (B.y > q.y) && q.x < ((B.x - A.x) * (q.y - A.y)) / (B.y - A.y) + A.x) inside = !inside; }
    if (!inside) return false;
  }
  return true;
}

/**
 * Push-and-shove: the other nets' unlocked traces that the new trace crowds are pushed aside (their crowded part
 * follows the new copper at exactly the clearance), recursively up to `maxDepth` levels; vias of other nets crowding
 * it are moved away, dragging the traces that end on them. Returns what moved and the nets that could not be pushed
 * (they cross the new trace, a pad-attached end would move, or the pushed shape hits fixed copper) — the caller
 * rips those up and reroutes them.
 */
export function pushShove(p: Project, t: Trace, opts: { maxDepth?: number } = {}): { pushed: number[]; movedVias: number[]; failed: string[] } {
  const maxDepth = opts.maxDepth ?? 3;
  const pushed = new Set<number>(), movedVias: number[] = [], failed = new Set<string>();
  const pads = padInstances(p);
  const onPad = (q: Pt, net: string, layer: string) => pads.some((pd) => pd.net === net && pd.layers.includes(layer) && Math.hypot(pd.center.x - q.x, pd.center.y - q.y) <= Math.max(pd.w, pd.h) / 2 + 1e-6);
  // vias of other nets crowding the new trace: move them straight away
  for (const v of p.vias) {
    if (v.locked || v.net === t.net) continue;
    const need = v.diameter / 2 + t.width / 2 + clr(p, v.net, t.net);
    let best = { d: Infinity, c: { x: v.x, y: v.y } as Pt };
    for (let i = 1; i < t.points.length; i++) { const r = dPtSeg(v, t.points[i - 1], t.points[i]); if (r.d < best.d) best = r; }
    if (best.d >= need) continue;
    if (best.d < 1e-9) { failed.add(v.net); continue; }
    const s = (need + 0.002) / best.d, nv = r4({ x: best.c.x + (v.x - best.c.x) * s, y: best.c.y + (v.y - best.c.y) * s });
    const attached = p.traces.filter((o) => o.net === v.net && !o.locked && (Math.hypot(o.points[0].x - v.x, o.points[0].y - v.y) < 1e-6 || Math.hypot(o.points[o.points.length - 1].x - v.x, o.points[o.points.length - 1].y - v.y) < 1e-6));
    const old = { x: v.x, y: v.y }; v.x = nv.x; v.y = nv.y;
    for (const o of attached) { if (Math.hypot(o.points[0].x - old.x, o.points[0].y - old.y) < 1e-6) o.points[0] = { ...nv }; else o.points[o.points.length - 1] = { ...nv }; pushed.add(o.id); }
    movedVias.push(v.id);
  }
  // traces: breadth-first, each pushed trace becomes an obstacle for the next level
  let wave: Obst[] = [{ net: t.net, layer: t.layer, w: t.width, pts: t.points }];
  for (let depth = 0; depth < maxDepth && wave.length; depth++) {
    const next: Obst[] = [];
    for (const o of wave) {
      for (const v of p.traces) {
        if (v.locked || v.net === o.net || v.layer !== o.layer || v.id === t.id || failed.has(v.net)) continue;
        const need = o.w / 2 + v.width / 2 + clr(p, o.net, v.net);
        let close = false;
        for (let i = 1; i < v.points.length && !close; i++) for (let j = 1; j < o.pts.length && !close; j++) if (geomDistance({ type: 'seg', a: v.points[i - 1], b: v.points[i], hw: 0 }, { type: 'seg', a: o.pts[j - 1], b: o.pts[j], hw: 0 }) < need - 1e-9) close = true;
        if (!close) continue;
        const ends: [boolean, boolean] = [onPad(v.points[0], v.net, v.layer) || p.vias.some((x) => x.net === v.net && Math.hypot(x.x - v.points[0].x, x.y - v.points[0].y) < 1e-6), onPad(v.points[v.points.length - 1], v.net, v.layer) || p.vias.some((x) => x.net === v.net && Math.hypot(x.x - v.points[v.points.length - 1].x, x.y - v.points[v.points.length - 1].y) < 1e-6)];
        const np = displace(v.points, o, need, ends);
        if (!np || !fitsFixed(p, v.net, v.layer, v.width, np, new Set([t.id]))) { failed.add(v.net); continue; }
        v.points = np; pushed.add(v.id);
        next.push({ net: v.net, layer: v.layer, w: v.width, pts: np });
      }
    }
    wave = next;
  }
  // anything still crowding after the last level has to be rerouted
  if (wave.length) for (const o of wave) for (const v of p.traces) {
    if (v.locked || v.net === o.net || v.layer !== o.layer) continue;
    const need = o.w / 2 + v.width / 2 + clr(p, o.net, v.net);
    for (let i = 1; i < v.points.length; i++) for (let j = 1; j < o.pts.length; j++) if (geomDistance({ type: 'seg', a: v.points[i - 1], b: v.points[i], hw: 0 }, { type: 'seg', a: o.pts[j - 1], b: o.pts[j], hw: 0 }) < need - 1e-9) failed.add(v.net);
  }
  return { pushed: [...pushed], movedVias, failed: [...failed].filter(Boolean) };
}
