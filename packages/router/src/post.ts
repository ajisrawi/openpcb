/**
 * Post-route clean-up, the OpenRoute counterpart of SPECCTRA's `miter` (and Allegro's gloss "convert corners"):
 * every wire corner between 60° and 120° is replaced by a 45°-style chamfer, but only when the new segment keeps
 * the typed clearance from every other-net object on its layer and no same-net copper (another wire, a via or a
 * pad) attaches at the corner — so mitering can never create a DRC error or break a T-junction.
 */
import { Board, type Item } from './board.js';
import type { Design, SessionRoutes, Wire } from './model.js';
import { geomDistance } from './drc.js';
import { type Pt, pointInPolygon, simplifyPolyline } from './geom.js';

export interface MiterOptions {
  length?: number;   // chamfer leg length, resolution units; default 1.5 x the wire width
}

export function miterRoutes(design: Design, routes: SessionRoutes, opts: MiterOptions = {}): { routes: SessionRoutes; mitered: number; skipped: number } {
  const board = new Board(design);
  const rules = board.rules;
  const ex = rules.extremes();
  const reach = ex.maxClearance + ex.maxWidth + 1;   // how far another object can be and still matter
  const ownItems = new Map<Wire, Item[]>();
  // all routed copper on the board, remembering which items belong to which wire
  for (const [net, r] of routes.nets) {
    for (const w of r.wires) ownItems.set(w, board.addWire({ ...w, net }, false));
    for (const v of r.vias) board.addVia({ ...v, net }, false);
  }
  let mitered = 0, skipped = 0;
  const out: SessionRoutes = { resolution: { ...routes.resolution }, nets: new Map(), padstacks: routes.padstacks };
  for (const [net, r] of routes.nets) {
    const wires: Wire[] = [];
    for (const w of r.wires) {
      if (w.points.length < 3 || w.type === 'fix' || w.type === 'protect') { wires.push(w); continue; }
      const li = board.layerIndex(w.layer);
      const hw = w.width / 2;
      const legTarget = opts.length ?? 1.5 * w.width;
      const own = new Set(ownItems.get(w)?.map((i) => i.id) ?? []);
      const pts: Pt[] = [w.points[0]];
      for (let i = 1; i < w.points.length - 1; i++) {
        const a = pts[pts.length - 1], p = w.points[i], b = w.points[i + 1];
        const l1 = Math.hypot(p.x - a.x, p.y - a.y), l2 = Math.hypot(b.x - p.x, b.y - p.y);
        const u1 = { x: (p.x - a.x) / l1, y: (p.y - a.y) / l1 }, u2 = { x: (b.x - p.x) / l2, y: (b.y - p.y) / l2 };
        const cos = u1.x * u2.x + u1.y * u2.y;   // 0 = right angle turn
        const leg = Math.min(legTarget, l1 / 2, l2 / 2);
        if (!(l1 > 0 && l2 > 0) || Math.abs(cos) > 0.5 || leg < hw) { pts.push(p); continue; }
        const c1 = { x: p.x - u1.x * leg, y: p.y - u1.y * leg }, c2 = { x: p.x + u2.x * leg, y: p.y + u2.y * leg };
        const seg = { type: 'seg' as const, a: c1, b: c2, hw };
        const pad = hw + reach;
        const box = { minX: Math.min(c1.x, c2.x, p.x) - pad, minY: Math.min(c1.y, c2.y, p.y) - pad, maxX: Math.max(c1.x, c2.x, p.x) + pad, maxY: Math.max(c1.y, c2.y, p.y) + pad };
        let ok = true;
        for (const it of board.query(box, li)) {
          if (own.has(it.id) || it.kind === 'plane') continue;
          if (it.net === net) {
            // same-net copper touching the cut-off corner (a branch or via ending there) would lose its connection
            if (it.kind !== 'pad' && geomDistance({ type: 'circle', c: p, r: hw }, it.geom) <= 0) { ok = false; break; }
            continue;
          }
          if (it.kind === 'via_keepout') continue;
          const need = it.kind === 'keepout' || it.kind === 'wire_keepout' ? 0 : rules.clearance(net, it.net, 'wire', it.objType, w.layer);
          if (geomDistance(seg, it.geom) < need) { ok = false; break; }
        }
        if (!ok) { skipped++; pts.push(p); continue; }
        pts.push(c1, c2); mitered++;
        // the chamfer is new copper: later checks must see it
        board.addWire({ layer: w.layer, width: w.width, points: [c1, c2], net }, false);
      }
      pts.push(w.points[w.points.length - 1]);
      wires.push({ ...w, points: pts });
    }
    out.nets.set(net, { wires, vias: r.vias });
  }
  return { routes: out, mitered, skipped };
}


/* ---------- length tuning (serpentines) ---------- */

export interface TuneReport { net: string; before: number; target: number; after: number; ok: boolean }

const wireLen = (w: Wire) => { let L = 0; for (let i = 1; i < w.points.length; i++) L += Math.hypot(w.points[i].x - w.points[i - 1].x, w.points[i].y - w.points[i - 1].y); return L; };

/**
 * Length tuning: brings nets up to a target length with accordion serpentines inserted on their longest straight
 * segments. Targets: the shorter net of each differential pair to its partner (skew), every net of a class with
 * (match_net_length on) to the longest in the class, and every net with (length max min) to at least its minimum.
 * Each serpentine is clearance-checked against other-net copper (including serpentines already added); a net that
 * cannot be tuned keeps its copper and is reported.
 */
export function tuneRoutes(design: Design, routes: SessionRoutes, opts: { viaLength?: number; phase?: boolean } = {}): { routes: SessionRoutes; report: TuneReport[] } {
  const board = new Board(design);
  const rules = board.rules;
  const mm = rules.mmToRes();
  for (const [net, r] of routes.nets) { for (const w of r.wires) board.addWire({ ...w, net }, false); for (const v of r.vias) board.addVia({ ...v, net }, false); }
  const out: SessionRoutes = { resolution: { ...routes.resolution }, nets: new Map(), padstacks: routes.padstacks };
  for (const [net, r] of routes.nets) out.nets.set(net, { wires: r.wires.map((w) => ({ ...w, points: w.points.slice() })), vias: r.vias });
  // electrical length: wires plus a length per via (board thickness), as the host's length rules count it
  const len = (net: string) => (out.nets.get(net)?.wires ?? []).reduce((s, w) => s + wireLen(w), 0) + (out.nets.get(net)?.vias.length ?? 0) * (opts.viaLength ?? 0);
  // targets
  const target = new Map<string, { len: number; tol: number }>();
  const want = (net: string, L: number, tol: number) => { const cur = target.get(net); if (!cur || L > cur.len) target.set(net, { len: L, tol }); };
  const pairNet = new Map<string, number>();   // net -> pair gap (phase tuning keeps bumps low)
  for (const pr of design.network.pairs ?? []) {
    const a = len(pr.p), b = len(pr.n), tol = pr.tolerance ?? 0.05 * mm;
    if (a + tol < b) want(pr.p, b, tol); else if (b + tol < a) want(pr.n, a, tol);
    const gap = pr.gap ?? rules.clearance(pr.p, pr.n);
    pairNet.set(pr.p, gap); pairNet.set(pr.n, gap);
  }
  for (const cls of design.network.classes.values()) {
    if (!cls.circuit?.matchNetLength) continue;
    const tol = cls.circuit.matchNetLength.tolerance ?? 0.1 * mm;
    const L = Math.max(...cls.nets.map(len));
    for (const n of cls.nets) if (len(n) + tol < L) want(n, L, tol);
  }
  for (const n of design.network.nets.values()) { const c = n.circuit?.length ?? (n.className ? design.network.classes.get(n.className)?.circuit?.length : undefined); if (c?.min !== undefined && len(n.name) < c.min) want(n.name, c.min, 0); }
  const report: TuneReport[] = [];
  for (const [net, tg] of target) {
    const before = len(net);
    let deficit = tg.len - before;
    const wires = out.nets.get(net)?.wires ?? [];
    // candidate segments, longest first
    // phase tuning (a pair member): compensate close to the wire ends, where the skew of a pair builds up at the
    // pins, with bumps no higher than about the coupling distance so the pair stays coupled
    const phase = !!opts.phase && pairNet.has(net);
    const segs: { w: Wire; i: number; L: number }[] = [];
    const order = () => { if (phase) segs.sort((a, b) => (Math.min(a.i, a.w.points.length - a.i) - Math.min(b.i, b.w.points.length - b.i)) || (b.L - a.L)); else segs.sort((a, b) => b.L - a.L); };
    for (const w of wires) for (let i = 1; i < w.points.length; i++) segs.push({ w, i, L: Math.hypot(w.points[i].x - w.points[i - 1].x, w.points[i].y - w.points[i - 1].y) });
    order();
    for (const s of segs) {
      if (deficit <= tg.tol / 2) break;
      const w = s.w; const li = board.layerIndex(w.layer);
      // the segment may have moved inside the wire after an earlier insertion: find it again
      const A = s.w.points[s.i - 1], B = s.w.points[s.i];
      if (!A || !B || Math.hypot(B.x - A.x, B.y - A.y) !== s.L) continue;
      const hw = w.width / 2;
      const clr = rules.clearance(net, undefined, 'wire', 'wire', w.layer);
      const spacing = Math.max(3 * w.width, w.width + 2 * clr);   // centre distance between neighbouring legs
      const u = { x: (B.x - A.x) / s.L, y: (B.y - A.y) / s.L };
      const usable = s.L - 2 * spacing;
      const mMax = Math.floor(usable / (2 * spacing));
      if (mMax < 1) continue;
      const aMax = phase ? Math.max(w.width, 2 * (w.width + (pairNet.get(net) ?? clr))) : 12 * w.width;
      let done = false;
      for (const side of [1, -1]) {
        if (done) break;
        const nrm = { x: -u.y * side, y: u.x * side };
        for (let m = Math.min(mMax, Math.max(1, Math.ceil(deficit / (2 * aMax)))); m <= mMax && !done; m++) {
          const a = Math.min(aMax, deficit / (2 * m));
          if (a < w.width / 4) break;   // small skews take low bumps; below a quarter width it is noise
          const pts: Pt[] = [A];
          const start = { x: A.x + u.x * spacing, y: A.y + u.y * spacing };
          for (let p = 0; p < m; p++) {
            const x0 = { x: start.x + u.x * 2 * spacing * p, y: start.y + u.y * 2 * spacing * p };
            const x1 = { x: x0.x + u.x * spacing, y: x0.y + u.y * spacing };
            pts.push(x0, { x: x0.x + nrm.x * a, y: x0.y + nrm.y * a }, { x: x1.x + nrm.x * a, y: x1.y + nrm.y * a }, x1);
          }
          pts.push(B);
          // clearance of every new segment against other-net copper on the layer
          let ok = true;
          for (let k = 1; k < pts.length && ok; k++) {
            const seg = { type: 'seg' as const, a: pts[k - 1], b: pts[k], hw };
            const pad = hw + rules.extremes().maxClearance + rules.extremes().maxWidth;
            const box = { minX: Math.min(pts[k - 1].x, pts[k].x) - pad, minY: Math.min(pts[k - 1].y, pts[k].y) - pad, maxX: Math.max(pts[k - 1].x, pts[k].x) + pad, maxY: Math.max(pts[k - 1].y, pts[k].y) + pad };
            for (const it of board.query(box, li)) {
              if (it.kind === 'plane' || it.kind === 'via_keepout') continue;
              if (it.net === net) continue;
              const need = it.kind === 'keepout' || it.kind === 'wire_keepout' ? 0 : rules.clearance(net, it.net, 'wire', it.objType, w.layer);
              if (geomDistance(seg, it.geom) < need) { ok = false; break; }
            }
            if (ok && board.boundary.length >= 3 && !pointInPolygon(pts[k], board.boundary)) ok = false;
          }
          if (!ok) continue;
          w.points.splice(s.i - 1, 2, ...pts);
          for (let k = 1; k < pts.length; k++) board.addWire({ layer: w.layer, width: w.width, points: [pts[k - 1], pts[k]], net }, false);
          deficit -= 2 * a * m;
          done = true;
        }
      }
      if (done) {
        // later candidates on this wire refer to old indices: recompute from scratch on the next round
        segs.length = 0;
        for (const ww of wires) for (let i = 1; i < ww.points.length; i++) segs.push({ w: ww, i, L: Math.hypot(ww.points[i].x - ww.points[i - 1].x, ww.points[i].y - ww.points[i - 1].y) });
        order();
      }
    }
    const after = len(net);
    report.push({ net, before, target: tg.len, after, ok: after >= tg.len - tg.tol });
  }
  return { routes: out, report };
}


/* ---------- gloss: critic, center, spread, fatten, teardrops ---------- */

type Seg = { type: 'seg'; a: Pt; b: Pt; hw: number };

/** Board with all routed copper; remembers which items each wire made so a wire never blocks itself. */
function boardWith(design: Design, routes: SessionRoutes): { board: Board; own: Map<Wire, Set<number>> } {
  const board = new Board(design);
  const own = new Map<Wire, Set<number>>();
  for (const [net, r] of routes.nets) {
    for (const w of r.wires) own.set(w, new Set(board.addWire({ ...w, net }, false).map((i) => i.id)));
    for (const v of r.vias) board.addVia({ ...v, net }, false);
  }
  return { board, own };
}

/** True if a segment of `net` on `layer` keeps clearance from every other-net object (and stays on the board). */
function segClear(board: Board, net: string, layer: string, seg: Seg, extra = 0): boolean {
  const li = board.layerIndex(layer);
  const ex = board.rules.extremes();
  const pad = seg.hw + ex.maxClearance + ex.maxWidth + extra + 1;
  const box = { minX: Math.min(seg.a.x, seg.b.x) - pad, minY: Math.min(seg.a.y, seg.b.y) - pad, maxX: Math.max(seg.a.x, seg.b.x) + pad, maxY: Math.max(seg.a.y, seg.b.y) + pad };
  for (const it of board.query(box, li)) {
    if (it.kind === 'plane' || it.kind === 'via_keepout' || it.net === net) continue;
    const need = (it.kind === 'keepout' || it.kind === 'wire_keepout' ? 0 : board.rules.clearance(net, it.net, 'wire', it.objType, layer)) + extra;
    if (geomDistance(seg, it.geom) < need) return false;
  }
  if (board.boundary.length >= 3 && (!pointInPolygon(seg.a, board.boundary) || !pointInPolygon(seg.b, board.boundary))) return false;
  return true;
}

const cloneRoutes = (routes: SessionRoutes): SessionRoutes => {
  const out: SessionRoutes = { resolution: { ...routes.resolution }, nets: new Map(), padstacks: routes.padstacks };
  for (const [net, r] of routes.nets) out.nets.set(net, { wires: r.wires.map((w) => ({ ...w, points: w.points.map((p) => ({ ...p })) })), vias: r.vias.slice() });
  return out;
};

/**
 * critic: (1) trim dangling wire ends — an end that touches no same-net pad, via or other wire on its layer is cut
 * back segment by segment; (2) remove notches — an out-and-back detour p0→p1→p2→p3 whose ends p0, p3 lie on one
 * horizontal/vertical line is replaced by p0→p3 when that shortcut is clear; (3) drop collinear points.
 */
export function criticRoutes(design: Design, routes: SessionRoutes): { routes: SessionRoutes; trimmed: number; notches: number } {
  const out = cloneRoutes(routes);
  const { board } = boardWith(design, out);
  let trimmed = 0, notches = 0;
  for (const [net, r] of out.nets) {
    const li = (l: string) => board.layerIndex(l);
    const touches = (w: Wire, e: Pt): boolean => {
      const probe = { type: 'circle' as const, c: e, r: w.width / 2 };
      for (const it of board.query({ minX: e.x - w.width, minY: e.y - w.width, maxX: e.x + w.width, maxY: e.y + w.width }, li(w.layer))) {
        if (it.net !== net || it.kind === 'plane') continue;
        if (it.kind === 'wire') {
          const g = it.geom as Seg;
          // skip the wire's own segment that ends here
          if (w.points.some((p, i) => i > 0 && ((p.x === g.a.x && p.y === g.a.y && w.points[i - 1].x === g.b.x && w.points[i - 1].y === g.b.y) || (p.x === g.b.x && p.y === g.b.y && w.points[i - 1].x === g.a.x && w.points[i - 1].y === g.a.y)))) continue;
        }
        if (geomDistance(probe, it.geom) <= 0) return true;
      }
      return false;
    };
    for (const w of r.wires) {
      if (w.type === 'fix' || w.type === 'protect') continue;
      while (w.points.length >= 2 && !touches(w, w.points[w.points.length - 1])) { w.points.pop(); trimmed++; }
      while (w.points.length >= 2 && !touches(w, w.points[0])) { w.points.shift(); trimmed++; }
      // notches
      for (let i = 0; i + 3 < w.points.length; i++) {
        const p0 = w.points[i], p3 = w.points[i + 3];
        if (!(p0.x === p3.x || p0.y === p3.y)) continue;
        const direct = Math.hypot(p3.x - p0.x, p3.y - p0.y);
        const detour = Math.hypot(w.points[i + 1].x - p0.x, w.points[i + 1].y - p0.y) + Math.hypot(w.points[i + 2].x - w.points[i + 1].x, w.points[i + 2].y - w.points[i + 1].y) + Math.hypot(p3.x - w.points[i + 2].x, p3.y - w.points[i + 2].y);
        if (detour <= direct + 1e-9) continue;
        const seg: Seg = { type: 'seg', a: p0, b: p3, hw: w.width / 2 };
        if (!segClear(board, net, w.layer, seg)) continue;
        w.points.splice(i + 1, 2); notches++;
        board.addWire({ layer: w.layer, width: w.width, points: [p0, p3], net }, false);
        i = Math.max(-1, i - 2);
      }
      w.points = simplifyPolyline(w.points);
    }
    r.wires = r.wires.filter((w) => w.points.length >= 2);
  }
  return { routes: out, trimmed, notches };
}

/**
 * center / spread: an interior wire segment whose two neighbouring segments are perpendicular to it can slide
 * sideways (its neighbours just get longer or shorter). `center` slides it to the middle of the free channel;
 * `spread` slides it away from the nearer side until it has `target` extra space, if the far side allows.
 */
export function slideRoutes(design: Design, routes: SessionRoutes, mode: 'center' | 'spread', target = 0): { routes: SessionRoutes; moved: number } {
  const out = cloneRoutes(routes);
  const { board } = boardWith(design, out);
  const step = Math.max(1, Math.round(board.rules.mmToRes() * 0.025));   // 25 um search step
  let moved = 0;
  for (const [net, r] of out.nets) for (const w of r.wires) {
    if (w.type === 'fix' || w.type === 'protect') continue;
    const hw = w.width / 2;
    for (let i = 1; i + 2 < w.points.length; i++) {
      const p0 = w.points[i - 1], a = w.points[i], b = w.points[i + 1], p3 = w.points[i + 2];
      const horiz = a.y === b.y && a.x !== b.x, vert = a.x === b.x && a.y !== b.y;
      if (!horiz && !vert) continue;
      const perpOk = horiz ? (p0.x === a.x && p3.x === b.x) : (p0.y === a.y && p3.y === b.y);
      if (!perpOk) continue;
      const shifted = (d: number): Pt[] => horiz ? [{ x: a.x, y: a.y + d }, { x: b.x, y: b.y + d }] : [{ x: a.x + d, y: a.y }, { x: b.x + d, y: b.y }];
      const fits = (d: number): boolean => {
        const [na, nb] = shifted(d);
        // the slid segment and the two neighbours it stretches must all stay clear
        return segClear(board, net, w.layer, { type: 'seg', a: na, b: nb, hw }) && segClear(board, net, w.layer, { type: 'seg', a: p0, b: na, hw }) && segClear(board, net, w.layer, { type: 'seg', a: nb, b: p3, hw });
      };
      // free room on each side (how far the segment could slide)
      const room = (sgn: number): number => { let d = 0; while (d < 40 * step && fits(sgn * (d + step))) d += step; return d; };
      const up = room(1), down = room(-1);
      let shift = 0;
      if (mode === 'center') shift = Math.round((up - down) / 2 / step) * step;
      else if (target > 0) { if (up < target && down > target - up) shift = -Math.min(down, target - up); else if (down < target && up > target - down) shift = Math.min(up, target - down); }
      // never move a segment into its own neighbours' length to zero
      if (shift === 0) continue;
      const [na, nb] = shifted(shift);
      if ((horiz && (Math.sign(na.y - p0.y) !== Math.sign(a.y - p0.y) || Math.sign(nb.y - p3.y) !== Math.sign(b.y - p3.y))) || (vert && (Math.sign(na.x - p0.x) !== Math.sign(a.x - p0.x) || Math.sign(nb.x - p3.x) !== Math.sign(b.x - p3.x)))) continue;
      if (!fits(shift)) continue;
      w.points[i] = na; w.points[i + 1] = nb; moved++;
      board.addWire({ layer: w.layer, width: w.width, points: [p0, na, nb, p3], net }, false);
    }
  }
  return { routes: out, moved };
}

/** fatten (gloss line fatten): widen each wire segment to `width` where the wider copper still keeps clearance. */
export function fattenRoutes(design: Design, routes: SessionRoutes, width: number): { routes: SessionRoutes; fattened: number } {
  const out = cloneRoutes(routes);
  const { board } = boardWith(design, out);
  let fattened = 0;
  for (const [net, r] of out.nets) {
    const extra: Wire[] = [];
    for (const w of r.wires) {
      if (w.type === 'fix' || w.type === 'protect' || w.width >= width) continue;
      // whole wire at once if it fits, else segment by segment (fat segments added as overlapping copper)
      const all = w.points.every((p, i) => i === 0 || segClear(board, net, w.layer, { type: 'seg', a: w.points[i - 1], b: p, hw: width / 2 }));
      if (all) { w.width = width; fattened++; board.addWire({ ...w, net }, false); continue; }
      for (let i = 1; i < w.points.length; i++) {
        const seg: Seg = { type: 'seg', a: w.points[i - 1], b: w.points[i], hw: width / 2 };
        if (!segClear(board, net, w.layer, seg)) continue;
        const fw: Wire = { layer: w.layer, width, points: [w.points[i - 1], w.points[i]], net, type: 'route' };
        extra.push(fw); board.addWire(fw, false); fattened++;
      }
    }
    r.wires.push(...extra);
  }
  return { routes: out, fattened };
}

/**
 * teardrop: where a wire ends on a same-net pad or via wider than the wire, add two short tapered wires from the
 * pad's edge (at ±70 % of its radius, across the wire) to a point on the wire 1.5 pad radii out, if they keep
 * clearance. The fab merges them with the pad into a teardrop.
 */
export function teardropRoutes(design: Design, routes: SessionRoutes): { routes: SessionRoutes; added: number } {
  const out = cloneRoutes(routes);
  const { board } = boardWith(design, out);
  let added = 0;
  for (const [net, r] of out.nets) {
    const extra: Wire[] = [];
    for (const w of r.wires) {
      if (w.points.length < 2) continue;
      const li = board.layerIndex(w.layer);
      for (const [e, n] of [[w.points[0], w.points[1]], [w.points[w.points.length - 1], w.points[w.points.length - 2]]] as [Pt, Pt][]) {
        // the pad/via the end sits on: same net, contains the end point, larger than the wire
        let rad = 0;
        for (const it of board.query({ minX: e.x - 1, minY: e.y - 1, maxX: e.x + 1, maxY: e.y + 1 }, li)) {
          if (it.net !== net || (it.kind !== 'pad' && it.kind !== 'via')) continue;
          if (geomDistance({ type: 'circle', c: e, r: 0 }, it.geom) > 0) continue;
          const b = it.bbox; rad = Math.max(rad, Math.min(b.maxX - b.minX, b.maxY - b.minY) / 2);
        }
        if (rad <= w.width) continue;
        const L = Math.hypot(n.x - e.x, n.y - e.y); if (L < rad * 1.6) continue;
        const u = { x: (n.x - e.x) / L, y: (n.y - e.y) / L }, nrm = { x: -u.y, y: u.x };
        const tip = { x: e.x + u.x * rad * 1.5, y: e.y + u.y * rad * 1.5 };
        for (const s of [1, -1]) {
          const base = { x: e.x + nrm.x * s * rad * 0.7, y: e.y + nrm.y * s * rad * 0.7 };
          const seg: Seg = { type: 'seg', a: base, b: tip, hw: w.width / 2 };
          if (!segClear(board, net, w.layer, seg)) continue;
          const tw: Wire = { layer: w.layer, width: w.width, points: [base, tip], net, type: 'route' };
          extra.push(tw); board.addWire(tw, false); added++;
        }
      }
    }
    r.wires.push(...extra);
  }
  return { routes: out, added };
}


/* ---------- shielding ---------- */

/**
 * shield: guard traces of `shieldNet` alongside every wire segment of `net`, on both sides, at `gap` edge-to-edge,
 * kept only where they clear all other copper; each kept guard gets a via of the shield net at both ends where one
 * fits (so a ground plane ties it down). Corners are trimmed so guards of neighbouring segments never cross.
 */
export function shieldRoutes(design: Design, routes: SessionRoutes, net: string, shieldNet: string, gap?: number): { routes: SessionRoutes; guards: number; vias: number } {
  const out = cloneRoutes(routes);
  const { board } = boardWith(design, out);
  const rules = board.rules;
  const target = out.nets.get(net);
  if (!target) return { routes: out, guards: 0, vias: 0 };
  const sh = out.nets.get(shieldNet) ?? { wires: [], vias: [] }; out.nets.set(shieldNet, sh);
  const ws = rules.width(shieldNet);
  const viaName = rules.via(shieldNet) ?? design.structure.vias[0];
  const ps = viaName ? design.library.padstacks.get(viaName) : undefined;
  let vr = 0; for (const s of ps?.shapes ?? []) if (s.kind === 'circle') vr = Math.max(vr, (s.diameter ?? 0) / 2);
  let guards = 0, vias = 0;
  for (const w of target.wires) {
    const g = gap ?? rules.clearance(net, shieldNet, 'wire', 'wire', w.layer);
    const off = w.width / 2 + g + ws / 2;
    for (let i = 1; i < w.points.length; i++) {
      const a = w.points[i - 1], b = w.points[i]; const L = Math.hypot(b.x - a.x, b.y - a.y);
      if (L < 2 * off + ws) continue;
      const u = { x: (b.x - a.x) / L, y: (b.y - a.y) / L }, n = { x: -u.y, y: u.x };
      for (const s of [1, -1]) {
        const p0 = { x: a.x + u.x * off + n.x * s * off, y: a.y + u.y * off + n.y * s * off };
        const p1 = { x: b.x - u.x * off + n.x * s * off, y: b.y - u.y * off + n.y * s * off };
        const seg: Seg = { type: 'seg', a: p0, b: p1, hw: ws / 2 };
        if (!segClear(board, shieldNet, w.layer, seg)) continue;
        const gw: Wire = { layer: w.layer, width: ws, points: [p0, p1], net: shieldNet, type: 'route' };
        sh.wires.push(gw); board.addWire(gw, false); guards++;
        // stitching vias at the guard's ends
        if (viaName && vr > 0) for (const e of [p0, p1]) {
          let ok = true;
          for (const it of board.query({ minX: e.x - vr * 4, minY: e.y - vr * 4, maxX: e.x + vr * 4, maxY: e.y + vr * 4 })) {
            if (it.kind === 'plane' || it.net === shieldNet) continue;
            const need = it.kind === 'keepout' || it.kind === 'via_keepout' ? 0 : rules.clearance(shieldNet, it.net, 'via', it.objType);
            if (geomDistance({ type: 'circle', c: e, r: vr }, it.geom) < need) { ok = false; break; }
          }
          if (!ok) continue;
          const v = { padstack: viaName, at: e, net: shieldNet, type: 'route' as const };
          sh.vias.push(v); board.addVia(v, false); vias++;
        }
      }
    }
  }
  return { routes: out, guards, vias };
}


/* ---------- arcs (recorner arc) ---------- */

/**
 * Arc corners (Allegro gloss "convert corners to arcs", SPECCTRA `recorner arc`): each wire corner turning between
 * 20 and 160 degrees becomes a tangent circular arc of radius `radius` (default 3 x the wire width), written as
 * short chords (at most 10 degrees each). Like miter it is skipped where the arc would come closer than the typed
 * clearance to other-net copper, or where same-net copper attaches at the corner.
 */
export function arcRoutes(design: Design, routes: SessionRoutes, opts: { radius?: number } = {}): { routes: SessionRoutes; arcs: number; skipped: number } {
  const { board, own } = boardWith(design, routes);
  const out = cloneRoutes(routes);
  let arcs = 0, skipped = 0;
  const origWires = [...routes.nets.values()].flatMap((r) => r.wires);
  let wi = 0;
  for (const [net, r] of out.nets) {
    for (const w of r.wires) {
      const ownIds = own.get(origWires[wi++]) ?? new Set<number>();
      if (w.points.length < 3 || w.type === 'fix' || w.type === 'protect') continue;
      const li = board.layerIndex(w.layer), hw = w.width / 2;
      const R = opts.radius ?? 3 * w.width;
      const pts: Pt[] = [w.points[0]];
      for (let i = 1; i < w.points.length - 1; i++) {
        const a = pts[pts.length - 1], p = w.points[i], b = w.points[i + 1];
        const l1 = Math.hypot(p.x - a.x, p.y - a.y), l2 = Math.hypot(b.x - p.x, b.y - p.y);
        if (!(l1 > 0 && l2 > 0)) { pts.push(p); continue; }
        const u1 = { x: (p.x - a.x) / l1, y: (p.y - a.y) / l1 }, u2 = { x: (b.x - p.x) / l2, y: (b.y - p.y) / l2 };
        const turn = Math.acos(Math.max(-1, Math.min(1, u1.x * u2.x + u1.y * u2.y)));   // 0 = straight on
        if (turn < (20 * Math.PI) / 180 || turn > (160 * Math.PI) / 180) { pts.push(p); continue; }
        const tan = Math.tan(turn / 2);
        const tlen = Math.min(R * tan, l1 / 2, l2 / 2);
        const rr = tlen / tan;
        if (rr < hw) { pts.push(p); continue; }
        // same-net copper attaching at the corner would be cut off
        let attached = false;
        for (const it of board.query({ minX: p.x - hw, minY: p.y - hw, maxX: p.x + hw, maxY: p.y + hw }, li)) {
          if (it.net !== net || ownIds.has(it.id) || it.kind === 'pad' || it.kind === 'plane') continue;
          if (geomDistance({ type: 'circle', c: p, r: hw }, it.geom) <= 0) { attached = true; break; }
        }
        if (attached) { skipped++; pts.push(p); continue; }
        const t1 = { x: p.x - u1.x * tlen, y: p.y - u1.y * tlen }, t2 = { x: p.x + u2.x * tlen, y: p.y + u2.y * tlen };
        const cross = u1.x * u2.y - u1.y * u2.x, side = cross > 0 ? 1 : -1;
        const centre = { x: t1.x - u1.y * rr * side, y: t1.y + u1.x * rr * side };
        const a0 = Math.atan2(t1.y - centre.y, t1.x - centre.x), a1 = Math.atan2(t2.y - centre.y, t2.x - centre.x);
        let da = a1 - a0; while (da > Math.PI) da -= 2 * Math.PI; while (da < -Math.PI) da += 2 * Math.PI;
        const n = Math.max(2, Math.ceil(Math.abs(da) / ((10 * Math.PI) / 180)));
        const arc: Pt[] = [];
        for (let k = 0; k <= n; k++) { const ang = a0 + (da * k) / n; arc.push({ x: Math.round(centre.x + rr * Math.cos(ang)), y: Math.round(centre.y + rr * Math.sin(ang)) }); }
        let ok = true;
        for (let k = 1; k < arc.length && ok; k++) ok = segClear(board, net, w.layer, { type: 'seg', a: arc[k - 1], b: arc[k], hw });
        if (ok) ok = segClear(board, net, w.layer, { type: 'seg', a, b: arc[0], hw });
        if (!ok) { skipped++; pts.push(p); continue; }
        pts.push(...arc); arcs++;
        for (let k = 1; k < arc.length; k++) board.addWire({ layer: w.layer, width: w.width, points: [arc[k - 1], arc[k]], net }, false);
      }
      pts.push(w.points[w.points.length - 1]);
      w.points = pts;
    }
  }
  return { routes: out, arcs, skipped };
}

/* ---------- tapers ---------- */

/**
 * Tapered width changes (Allegro "add tapered trace"): where two wires of a net meet end-to-end on one layer with
 * different widths (a neck-down region, a width rule change), the end of the wider wire steps down to the narrow
 * width in `steps` stages over about 3 x the width difference. Each stage is narrower than the wire it replaces and
 * follows its centre-line, so tapering can never reduce a clearance.
 */
export function taperRoutes(design: Design, routes: SessionRoutes, opts: { steps?: number } = {}): { routes: SessionRoutes; tapers: number } {
  const out = cloneRoutes(routes);
  const steps = Math.max(2, opts.steps ?? 3);
  let tapers = 0;
  const same = (a: Pt, b: Pt) => Math.abs(a.x - b.x) < 1 && Math.abs(a.y - b.y) < 1;
  for (const [net, r] of out.nets) {
    const added: Wire[] = [];
    for (const wide of r.wires) {
      for (const endAtStart of [true, false]) {
        const n = wide.points.length; if (n < 2) continue;
        const J = endAtStart ? wide.points[0] : wide.points[n - 1];
        const narrow = r.wires.find((o) => o !== wide && o.layer === wide.layer && o.width < wide.width && (same(o.points[0], J) || same(o.points[o.points.length - 1], J)));
        if (!narrow) continue;
        const L = 3 * (wide.width - narrow.width);
        const P = endAtStart ? wide.points[1] : wide.points[n - 2];
        const segL = Math.hypot(P.x - J.x, P.y - J.y);
        if (segL < L * 1.2 || L <= 0) continue;
        const u = { x: (P.x - J.x) / segL, y: (P.y - J.y) / segL };
        const at = (d: number) => ({ x: Math.round(J.x + u.x * d), y: Math.round(J.y + u.y * d) });
        for (let k = 0; k < steps; k++) {
          const wk = Math.round(narrow.width + ((wide.width - narrow.width) * (k + 1)) / (steps + 1));
          added.push({ ...wide, net, width: wk, points: [at((L * k) / steps), at((L * (k + 1)) / steps)] });
        }
        // the wide wire now starts where the taper ends
        if (endAtStart) wide.points[0] = at(L); else wide.points[n - 1] = at(L);
        tapers++;
      }
    }
    r.wires.push(...added);
  }
  return { routes: out, tapers };
}


/* ---------- smooth (gridless pull-tight) ---------- */

/**
 * Gridless smoothing (Allegro gloss "smooth"/pull-tight): the lattice router's wires follow 0.1 mm cells; here each
 * wire is rebuilt from its own vertices with the longest direct shortcuts that keep the typed clearance from every
 * other-net object — off the lattice. With `any` false only shortcuts at multiples of 45° are taken. Vertices where
 * same-net copper attaches (T-junctions, vias, pads) are kept, so connectivity cannot change.
 */
export function smoothRoutes(design: Design, routes: SessionRoutes, opts: { any?: boolean } = {}): { routes: SessionRoutes; removed: number; shortened: number } {
  const { board, own } = boardWith(design, routes);
  const out = cloneRoutes(routes);
  const origWires = [...routes.nets.values()].flatMap((r) => r.wires);
  let wi = 0, removed = 0, shortened = 0;
  const ok45 = (a: Pt, b: Pt) => { const dx = Math.abs(b.x - a.x), dy = Math.abs(b.y - a.y); return dx < 1 || dy < 1 || Math.abs(dx - dy) < 1; };
  for (const [net, r] of out.nets) {
    for (const w of r.wires) {
      const ownIds = own.get(origWires[wi++]) ?? new Set<number>();
      if (w.points.length < 3 || w.type === 'fix' || w.type === 'protect') continue;
      const li = board.layerIndex(w.layer), hw = w.width / 2;
      // same-net copper attached anywhere along the wire (pads, vias, other wires' ends or T-junctions), with the
      // segments it touches: a shortcut over those segments must still touch it
      const attach: { geom: Item['geom']; segs: Set<number> }[] = [];
      {
        const xs = w.points.map((q) => q.x), ys = w.points.map((q) => q.y);
        for (const it of board.query({ minX: Math.min(...xs) - hw, minY: Math.min(...ys) - hw, maxX: Math.max(...xs) + hw, maxY: Math.max(...ys) + hw }, li)) {
          if (it.net !== net || ownIds.has(it.id) || it.kind === 'plane') continue;
          const segs = new Set<number>();
          for (let s = 1; s < w.points.length; s++) if (geomDistance({ type: 'seg', a: w.points[s - 1], b: w.points[s], hw }, it.geom) <= 0) segs.add(s);
          if (segs.size) attach.push({ geom: it.geom, segs });
        }
      }
      const keepsAttachments = (i: number, k: number) => { const seg = { type: 'seg' as const, a: w.points[i], b: w.points[k], hw }; for (const a of attach) { let touched = false; for (let s = i + 1; s <= k; s++) if (a.segs.has(s)) { touched = true; break; } if (touched && geomDistance(seg, a.geom) > 0) return false; } return true; };
      const before = w.points.reduce((s, p, i) => (i ? s + Math.hypot(p.x - w.points[i - 1].x, p.y - w.points[i - 1].y) : 0), 0);
      const pts: Pt[] = [w.points[0]];
      let i = 0;
      while (i < w.points.length - 1) {
        let j = i + 1;
        for (let k = w.points.length - 1; k > i + 1; k--) {
          if (!opts.any && !ok45(w.points[i], w.points[k])) continue;
          if (!keepsAttachments(i, k)) continue;
          if (segClear(board, net, w.layer, { type: 'seg', a: w.points[i], b: w.points[k], hw })) { j = k; break; }
        }
        removed += j - i - 1;
        pts.push(w.points[j]);
        if (j > i + 1) board.addWire({ layer: w.layer, width: w.width, points: [w.points[i], w.points[j]], net }, false);
        i = j;
      }
      const after = pts.reduce((s, p, k) => (k ? s + Math.hypot(p.x - pts[k - 1].x, p.y - pts[k - 1].y) : 0), 0);
      if (after < before - 1) shortened++;
      w.points = pts;
    }
  }
  return { routes: out, removed, shortened };
}
