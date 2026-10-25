/**
 * Shape-based design rule check: exact geometric distances between copper
 * items of different nets, compared with the resolved clearance rule.
 */
import { type Board, type Item, type Geometry, ALL_LAYERS } from './board.js';
import { distPointSeg, distSegSeg, distPointPolygon, distSegPolygon, segmentsIntersect, pointInPolygon, growBox, boxesOverlap, type Pt } from './geom.js';

export interface Violation {
  kind: 'clearance' | 'outside_boundary' | 'keepout';
  a: Item;
  b?: Item;
  distance: number;
  required: number;
  at: Pt;
  layer: number;
}

/** Distance between two geometries (0 if overlapping). */
export function geomDistance(g1: Geometry, g2: Geometry): number {
  if (g1.type === 'circle' && g2.type === 'circle') return Math.max(0, Math.hypot(g1.c.x - g2.c.x, g1.c.y - g2.c.y) - g1.r - g2.r);
  if (g1.type === 'circle' && g2.type === 'seg') return Math.max(0, distPointSeg(g1.c, g2.a, g2.b) - g1.r - g2.hw);
  if (g1.type === 'seg' && g2.type === 'circle') return geomDistance(g2, g1);
  if (g1.type === 'seg' && g2.type === 'seg') return Math.max(0, distSegSeg(g1.a, g1.b, g2.a, g2.b) - g1.hw - g2.hw);
  if (g1.type === 'circle' && g2.type === 'poly') return Math.max(0, distPointPolygon(g1.c, g2.pts) - g1.r);
  if (g1.type === 'poly' && g2.type === 'circle') return geomDistance(g2, g1);
  if (g1.type === 'seg' && g2.type === 'poly') return Math.max(0, distSegPolygon(g1.a, g1.b, g2.pts) - g1.hw);
  if (g1.type === 'poly' && g2.type === 'seg') return geomDistance(g2, g1);
  if (g1.type === 'poly' && g2.type === 'poly') return polyPolyDistance(g1.pts, g2.pts);
  return Infinity;
}

function polyPolyDistance(a: Pt[], b: Pt[]): number {
  for (const p of a) if (pointInPolygon(p, b)) return 0;
  for (const p of b) if (pointInPolygon(p, a)) return 0;
  let d = Infinity;
  for (let i = 0, j = a.length - 1; i < a.length; j = i++) {
    for (let k = 0, l = b.length - 1; k < b.length; l = k++) {
      if (segmentsIntersect(a[j], a[i], b[l], b[k])) return 0;
      d = Math.min(d, distSegSeg(a[j], a[i], b[l], b[k]));
    }
  }
  return d;
}

function geomCenter(g: Geometry): Pt {
  switch (g.type) {
    case 'circle': return g.c;
    case 'seg': return { x: (g.a.x + g.b.x) / 2, y: (g.a.y + g.b.y) / 2 };
    case 'poly': { let x = 0, y = 0; for (const p of g.pts) { x += p.x; y += p.y; } return { x: x / g.pts.length, y: y / g.pts.length }; }
  }
}

function sharesLayer(a: Item, b: Item): number | undefined {
  if (a.layer === ALL_LAYERS) return b.layer === ALL_LAYERS ? 0 : b.layer;
  if (b.layer === ALL_LAYERS) return a.layer;
  return a.layer === b.layer ? a.layer : undefined;
}

export interface DrcOptions { onlyItems?: Item[]; }

/** Run clearance and keepout checks. Returns violations (each pair reported once). */
export function runDrc(board: Board, opts: DrcOptions = {}): Violation[] {
  const out: Violation[] = [];
  const seen = new Set<string>();
  const items = opts.onlyItems ?? board.items;
  const maxC = board.rules.extremes().maxClearance;
  const tol = 0.0005 * board.rules.mmToRes();   // 0.5 um: below any fab tolerance, above export rounding
  for (const a of items) {
    if (a.kind === 'keepout' || a.kind === 'via_keepout' || a.kind === 'wire_keepout' || a.kind === 'plane') continue;
    const near = board.query(growBox(a.bbox, maxC + 1));
    for (const b of near) {
      if (a === b) continue;
      const key = a.id < b.id ? `${a.id}:${b.id}` : `${b.id}:${a.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const layer = sharesLayer(a, b);
      if (layer === undefined) continue;
      if (b.kind === 'plane') continue;   // pours are re-filled around copper by the host
      if (b.kind === 'keepout' || b.kind === 'via_keepout' || b.kind === 'wire_keepout') {
        if (b.kind === 'via_keepout' && a.kind !== 'via') continue;
        if (b.kind === 'wire_keepout' && a.kind !== 'wire') continue;
        if (a.kind === 'pad') continue;
        const dd = geomDistance(a.geom, b.geom);
        if (dd <= 0) out.push({ kind: 'keepout', a, b, distance: dd, required: 0, at: geomCenter(a.geom), layer });
        continue;
      }
      if (a.net !== undefined && a.net !== '' && a.net === b.net) continue;
      // plane copper is relieved around pins and vias (anti-pads); only wires are checked against planes
      if (a.kind === 'pad' && b.kind === 'pad' && a.ref?.split('-')[0] === b.ref?.split('-')[0] && !a.net && !b.net) continue;
      const req = board.rules.clearance(a.net, b.net, a.objType, b.objType, board.layerNames[layer], geomCenter(a.geom));
      if (!boxesOverlap(growBox(a.bbox, req), b.bbox)) continue;
      const dd = geomDistance(a.geom, b.geom);
      if (dd < req - tol) out.push({ kind: 'clearance', a, b, distance: dd, required: req, at: geomCenter(a.geom), layer });
    }
    // boundary check for routed copper
    if ((a.kind === 'wire' || a.kind === 'via') && board.boundary.length >= 3) {
      const c = geomCenter(a.geom);
      if (!pointInPolygon(c, board.boundary)) out.push({ kind: 'outside_boundary', a, distance: 0, required: 0, at: c, layer: a.layer });
    }
  }
  return out;
}
