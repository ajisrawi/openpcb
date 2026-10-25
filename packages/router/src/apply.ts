/** Merge session routes into a Board (for DRC) or a Design (for the host/editor). */
import type { Board } from './board.js';
import type { Design, SessionRoutes } from './model.js';

export function applyRoutes(board: Board, routes: SessionRoutes): void {
  for (const [net, r] of routes.nets) {
    for (const w of r.wires) board.addWire({ ...w, net }, false);
    for (const v of r.vias) board.addVia({ ...v, net }, false);
  }
}

/** Replace the design's (wiring) with the given routes (keeping fixed pre-routes). */
export function applyRoutesToDesign(design: Design, routes: SessionRoutes): void {
  design.wiring.wires = design.wiring.wires.filter((w) => w.type === 'fix' || w.type === 'protect');
  design.wiring.vias = design.wiring.vias.filter((v) => v.type === 'fix' || v.type === 'protect');
  const scale = design.resolution.value / routes.resolution.value * (unitMm(routes.resolution.unit) / unitMm(design.resolution.unit));
  for (const [net, r] of routes.nets) {
    for (const w of r.wires) design.wiring.wires.push({ layer: w.layer, width: Math.round(w.width * scale), points: w.points.map((p) => ({ x: Math.round(p.x * scale), y: Math.round(p.y * scale) })), net, type: 'route' });
    for (const v of r.vias) design.wiring.vias.push({ padstack: v.padstack, at: { x: Math.round(v.at.x * scale), y: Math.round(v.at.y * scale) }, net, type: 'route' });
  }
}

function unitMm(u: string): number {
  switch (u.toLowerCase()) { case 'inch': case 'in': case 'i': return 25.4; case 'mil': return 0.0254; case 'cm': return 10; case 'mm': return 1; case 'um': case 'micron': case 'microns': return 0.001; default: return 1; }
}
