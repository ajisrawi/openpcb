/**
 * Planar geometry helpers. All coordinates are numbers in design units
 * (the router converts everything to integer "resolution units" at load time,
 * mirroring SPECCTRA's `(resolution <unit> <n>)`).
 */

export interface Pt { x: number; y: number; }
export interface Box { minX: number; minY: number; maxX: number; maxY: number; }

export const EPS = 1e-9;

export function pt(x: number, y: number): Pt { return { x, y }; }
export function add(a: Pt, b: Pt): Pt { return { x: a.x + b.x, y: a.y + b.y }; }
export function sub(a: Pt, b: Pt): Pt { return { x: a.x - b.x, y: a.y - b.y }; }
export function scale(a: Pt, s: number): Pt { return { x: a.x * s, y: a.y * s }; }
export function dot(a: Pt, b: Pt): number { return a.x * b.x + a.y * b.y; }
export function cross(a: Pt, b: Pt): number { return a.x * b.y - a.y * b.x; }
export function len(a: Pt): number { return Math.hypot(a.x, a.y); }
export function dist(a: Pt, b: Pt): number { return Math.hypot(a.x - b.x, a.y - b.y); }
export function manhattan(a: Pt, b: Pt): number { return Math.abs(a.x - b.x) + Math.abs(a.y - b.y); }
export function eqPt(a: Pt, b: Pt, eps = EPS): boolean { return Math.abs(a.x - b.x) <= eps && Math.abs(a.y - b.y) <= eps; }

/** Rotate `p` about the origin by `deg` degrees counter-clockwise. */
export function rotate(p: Pt, deg: number): Pt {
  if (deg === 0) return { x: p.x, y: p.y };
  const r = (deg * Math.PI) / 180;
  const c = Math.cos(r), s = Math.sin(r);
  return { x: p.x * c - p.y * s, y: p.x * s + p.y * c };
}

export function emptyBox(): Box { return { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity }; }
export function boxOf(pts: Pt[]): Box {
  const b = emptyBox();
  for (const p of pts) extendBox(b, p.x, p.y);
  return b;
}
export function extendBox(b: Box, x: number, y: number): void {
  if (x < b.minX) b.minX = x; if (x > b.maxX) b.maxX = x;
  if (y < b.minY) b.minY = y; if (y > b.maxY) b.maxY = y;
}
export function growBox(b: Box, d: number): Box { return { minX: b.minX - d, minY: b.minY - d, maxX: b.maxX + d, maxY: b.maxY + d }; }
export function boxesOverlap(a: Box, b: Box): boolean {
  return a.minX <= b.maxX && b.minX <= a.maxX && a.minY <= b.maxY && b.minY <= a.maxY;
}
export function boxContains(b: Box, p: Pt): boolean { return p.x >= b.minX && p.x <= b.maxX && p.y >= b.minY && p.y <= b.maxY; }

/** Distance from point `p` to segment `a`-`b`. */
export function distPointSeg(p: Pt, a: Pt, b: Pt): number {
  const ab = sub(b, a);
  const l2 = dot(ab, ab);
  if (l2 < EPS) return dist(p, a);
  let t = dot(sub(p, a), ab) / l2;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return dist(p, { x: a.x + ab.x * t, y: a.y + ab.y * t });
}

/** Distance between segments a1-a2 and b1-b2 (0 if they intersect). */
export function distSegSeg(a1: Pt, a2: Pt, b1: Pt, b2: Pt): number {
  if (segmentsIntersect(a1, a2, b1, b2)) return 0;
  return Math.min(distPointSeg(a1, b1, b2), distPointSeg(a2, b1, b2), distPointSeg(b1, a1, a2), distPointSeg(b2, a1, a2));
}

export function segmentsIntersect(a1: Pt, a2: Pt, b1: Pt, b2: Pt): boolean {
  const d1 = cross(sub(a2, a1), sub(b1, a1));
  const d2 = cross(sub(a2, a1), sub(b2, a1));
  const d3 = cross(sub(b2, b1), sub(a1, b1));
  const d4 = cross(sub(b2, b1), sub(a2, b1));
  if (((d1 > EPS && d2 < -EPS) || (d1 < -EPS && d2 > EPS)) && ((d3 > EPS && d4 < -EPS) || (d3 < -EPS && d4 > EPS))) return true;
  const on = (p: Pt, q: Pt, r: Pt) => Math.abs(cross(sub(q, p), sub(r, p))) <= EPS &&
    r.x >= Math.min(p.x, q.x) - EPS && r.x <= Math.max(p.x, q.x) + EPS && r.y >= Math.min(p.y, q.y) - EPS && r.y <= Math.max(p.y, q.y) + EPS;
  return on(a1, a2, b1) || on(a1, a2, b2) || on(b1, b2, a1) || on(b1, b2, a2);
}

/** Point in polygon (ray casting). */
export function pointInPolygon(p: Pt, poly: Pt[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const pi = poly[i], pj = poly[j];
    if ((pi.y > p.y) !== (pj.y > p.y) && p.x < ((pj.x - pi.x) * (p.y - pi.y)) / (pj.y - pi.y + 0) + pi.x) inside = !inside;
  }
  return inside;
}

/** Distance from a point to a polygon boundary (0 if inside). */
export function distPointPolygon(p: Pt, poly: Pt[]): number {
  if (pointInPolygon(p, poly)) return 0;
  let d = Infinity;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) d = Math.min(d, distPointSeg(p, poly[j], poly[i]));
  return d;
}

/** Distance from segment to polygon (0 if touching/inside). */
export function distSegPolygon(a: Pt, b: Pt, poly: Pt[]): number {
  if (pointInPolygon(a, poly) || pointInPolygon(b, poly)) return 0;
  let d = Infinity;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) d = Math.min(d, distSegSeg(a, b, poly[j], poly[i]));
  return d;
}

/** Axis-aligned rectangle as polygon. */
export function rectPoly(x1: number, y1: number, x2: number, y2: number): Pt[] {
  const a = Math.min(x1, x2), b = Math.min(y1, y2), c = Math.max(x1, x2), d = Math.max(y1, y2);
  return [pt(a, b), pt(c, b), pt(c, d), pt(a, d)];
}

/** Signed area (positive = counter-clockwise). */
export function polygonArea(poly: Pt[]): number {
  let a = 0;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) a += cross(poly[j], poly[i]);
  return a / 2;
}

/** Transform a local footprint point to board coordinates: rotate, mirror for back side, translate. */
export function placeTransform(local: Pt, origin: Pt, rotationDeg: number, back: boolean): Pt {
  // SPECCTRA: back-side images are mirrored about the Y axis before rotation.
  const m = back ? { x: -local.x, y: local.y } : local;
  const r = rotate(m, rotationDeg);
  return { x: origin.x + r.x, y: origin.y + r.y };
}

/** Remove collinear interior points from a polyline. */
export function simplifyPolyline(pts: Pt[]): Pt[] {
  if (pts.length <= 2) return pts.slice();
  const out: Pt[] = [pts[0]];
  for (let i = 1; i < pts.length - 1; i++) {
    const a = out[out.length - 1], b = pts[i], c = pts[i + 1];
    if (Math.abs(cross(sub(b, a), sub(c, b))) > EPS || dot(sub(b, a), sub(c, b)) < 0) out.push(b);
  }
  out.push(pts[pts.length - 1]);
  return out;
}
