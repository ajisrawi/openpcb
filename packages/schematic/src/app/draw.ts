/** Canvas drawing of render primitives and hit testing (shared by the page canvas, previews and the symbol editor). */
import type { Prim } from '../render.js';
import type { Pt } from '../model.js';

export interface Xf { s: number; ox: number; oy: number }   // screen = (world - o) * s

export function drawPrims(ctx: CanvasRenderingContext2D, prims: Prim[], xf: Xf, opts: { color?: string; alpha?: number } = {}) {
  const X = (x: number) => (x - xf.ox) * xf.s, Y = (y: number) => (y - xf.oy) * xf.s;
  ctx.save();
  ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  if (opts.alpha !== undefined) ctx.globalAlpha = opts.alpha;
  for (const p of prims) {
    const c = opts.color ?? p.c;
    ctx.strokeStyle = c; ctx.fillStyle = c;
    switch (p.t) {
      case 'line': {
        ctx.lineWidth = Math.max(1, p.w * xf.s);
        ctx.beginPath(); p.pts.forEach((q, i) => (i ? ctx.lineTo(X(q.x), Y(q.y)) : ctx.moveTo(X(q.x), Y(q.y)))); ctx.stroke();
        break;
      }
      case 'poly': {
        ctx.lineWidth = Math.max(1, p.w * xf.s);
        ctx.beginPath(); p.pts.forEach((q, i) => (i ? ctx.lineTo(X(q.x), Y(q.y)) : ctx.moveTo(X(q.x), Y(q.y)))); ctx.closePath();
        if (p.fill) ctx.fill(); ctx.stroke();
        break;
      }
      case 'circle': {
        ctx.lineWidth = Math.max(1, p.w * xf.s);
        ctx.beginPath(); ctx.arc(X(p.c0.x), Y(p.c0.y), Math.max(0.5, p.r * xf.s), 0, Math.PI * 2);
        if (p.fill) ctx.fill(); if (p.w > 0) ctx.stroke();
        break;
      }
      case 'arc': {
        // a0..a1 counter-clockwise on screen (y down): canvas angles are negated
        ctx.lineWidth = Math.max(1, p.w * xf.s);
        ctx.beginPath(); ctx.arc(X(p.c0.x), Y(p.c0.y), Math.max(0.5, p.r * xf.s), (-p.a0 * Math.PI) / 180, (-p.a1 * Math.PI) / 180, true); ctx.stroke();
        break;
      }
      case 'text': {
        const px = p.size * xf.s;
        if (px < 3) break;   // too small to read: skip
        ctx.font = `${p.bold ? 'bold ' : ''}${px.toFixed(1)}px Arial, sans-serif`;
        ctx.textAlign = p.anchor === 'middle' ? 'center' : p.anchor === 'end' ? 'right' : 'left';
        ctx.textBaseline = 'alphabetic';
        ctx.save(); ctx.translate(X(p.at.x), Y(p.at.y)); if (p.rot) ctx.rotate((-p.rot * Math.PI) / 180); ctx.fillText(p.s, 0, 0); ctx.restore();
        break;
      }
    }
  }
  ctx.restore();
}

/** Bounding box of primitives (world). */
export function primBox(prims: Prim[]): { x1: number; y1: number; x2: number; y2: number } | null {
  let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
  const add = (q: Pt, r = 0) => { x1 = Math.min(x1, q.x - r); y1 = Math.min(y1, q.y - r); x2 = Math.max(x2, q.x + r); y2 = Math.max(y2, q.y + r); };
  for (const p of prims) {
    if (p.t === 'line' || p.t === 'poly') p.pts.forEach((q) => add(q));
    else if (p.t === 'circle' || p.t === 'arc') add(p.c0, p.r);
    else if (p.t === 'text') { const w = p.s.length * p.size * 0.6; const dx = p.anchor === 'middle' ? w / 2 : p.anchor === 'end' ? w : 0; if (p.rot) { add({ x: p.at.x, y: p.at.y - w }); add({ x: p.at.x - p.size, y: p.at.y }); } else { add({ x: p.at.x - dx, y: p.at.y - p.size }); add({ x: p.at.x - dx + w, y: p.at.y + p.size * 0.2 }); } }
  }
  return Number.isFinite(x1) ? { x1, y1, x2, y2 } : null;
}

const segDist = (p: Pt, a: Pt, b: Pt) => { const dx = b.x - a.x, dy = b.y - a.y, L = dx * dx + dy * dy; const t = L ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / L)) : 0; return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy)); };

/** Distance from a point to a primitive's ink (0 inside filled shapes / text boxes). */
export function primDist(p: Prim, q: Pt): number {
  switch (p.t) {
    case 'line': { let d = Infinity; for (let i = 1; i < p.pts.length; i++) d = Math.min(d, segDist(q, p.pts[i - 1], p.pts[i])); if (p.pts.length === 1) d = Math.hypot(q.x - p.pts[0].x, q.y - p.pts[0].y); return d - p.w / 2; }
    case 'poly': { let d = Infinity; for (let i = 0; i < p.pts.length; i++) d = Math.min(d, segDist(q, p.pts[i], p.pts[(i + 1) % p.pts.length])); if (p.fill && inside(q, p.pts)) return 0; return d - p.w / 2; }
    case 'circle': { const r = Math.hypot(q.x - p.c0.x, q.y - p.c0.y); return p.fill ? Math.max(0, r - p.r) : Math.abs(r - p.r); }
    case 'arc': return Math.abs(Math.hypot(q.x - p.c0.x, q.y - p.c0.y) - p.r);
    case 'text': { const b = primBox([p])!; return q.x >= b.x1 && q.x <= b.x2 && q.y >= b.y1 && q.y <= b.y2 ? 0 : Infinity; }
  }
}

export function inside(q: Pt, poly: Pt[]): boolean {
  let c = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) { const a = poly[i], b = poly[j]; if ((a.y > q.y) !== (b.y > q.y) && q.x < ((b.x - a.x) * (q.y - a.y)) / (b.y - a.y) + a.x) c = !c; }
  return c;
}

/** Fit a world box into a canvas. */
export function fitXf(box: { x1: number; y1: number; x2: number; y2: number }, w: number, h: number, margin = 20): Xf {
  const s = Math.min((w - 2 * margin) / Math.max(1, box.x2 - box.x1), (h - 2 * margin) / Math.max(1, box.y2 - box.y1));
  return { s, ox: (box.x1 + box.x2) / 2 - w / 2 / s, oy: (box.y1 + box.y2) / 2 - h / 2 / s };
}
