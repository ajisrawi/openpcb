/** Render an OpenBoard project to SVG (so an agent can look at the board). */
import { type Project, padToBoard, padLayers, padAngle } from '../../editor/src/model.js';
import { defaultLibrary } from '../../editor/src/footprints.js';
import { ratsnest } from '../../editor/src/connectivity.js';
import { textStrokes, dimensionStrokes } from '../../editor/src/fab.js';

export function projectToSvg(p: Project, opts: { width?: number; rats?: boolean; layers?: string[] } = {}): string {
  const xs = p.outline.map((q) => q.x), ys = p.outline.map((q) => q.y);
  const minX = Math.min(...xs) - 2, maxX = Math.max(...xs) + 2, minY = Math.min(...ys) - 2, maxY = Math.max(...ys) + 2;
  const W = opts.width ?? 1200; const scale = W / (maxX - minX); const H = (maxY - minY) * scale;
  const X = (x: number) => ((x - minX) * scale).toFixed(1), Y = (y: number) => ((maxY - y) * scale).toFixed(1);
  const lib = { ...defaultLibrary(), ...p.footprints };
  const color = new Map(p.layers.map((l) => [l.name, l.color]));
  const show = (l: string) => !opts.layers || opts.layers.includes(l);
  const out: string[] = [`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H.toFixed(0)}" viewBox="0 0 ${W} ${H.toFixed(0)}" font-family="sans-serif">`,
    `<rect width="100%" height="100%" fill="#101418"/>`,
    `<polygon points="${p.outline.map((q) => `${X(q.x)},${Y(q.y)}`).join(' ')}" fill="#1b2a1f" stroke="#d9d26b" stroke-width="1.5"/>`];
  for (const z of p.zones) if (show(z.layer) && z.points.length >= 3) out.push(`<polygon points="${z.points.map((q) => `${X(q.x)},${Y(q.y)}`).join(' ')}" fill="${color.get(z.layer)}" fill-opacity="0.15" stroke="${color.get(z.layer)}" stroke-dasharray="${z.dynamic ? '6 4' : ''}"/>`);
  const order = [...p.layers.map((l) => l.name)].reverse();
  for (const layer of order) {
    if (!show(layer)) continue;
    const col = color.get(layer) ?? '#fff'; const op = layer === p.layers[0].name ? 0.95 : 0.55;
    for (const t of p.traces) if (t.layer === layer) out.push(`<polyline points="${t.points.map((q) => `${X(q.x)},${Y(q.y)}`).join(' ')}" fill="none" stroke="${col}" stroke-opacity="${op}" stroke-width="${(t.width * scale).toFixed(1)}" stroke-linecap="round" stroke-linejoin="round"/>`);
    for (const c of p.components) {
      const fp = lib[c.footprint]; if (!fp) continue;
      for (const pad of fp.pads) {
        if (!padLayers(p, c, pad).includes(layer)) continue;
        const ctr = padToBoard(c, pad); const rot = padAngle(c, pad);
        const w = pad.w * scale, h = pad.h * scale;
        if (pad.shape === 'circle') out.push(`<circle cx="${X(ctr.x)}" cy="${Y(ctr.y)}" r="${(w / 2).toFixed(1)}" fill="${col}" fill-opacity="${op}"/>`);
        else out.push(`<rect x="${(-w / 2).toFixed(1)}" y="${(-h / 2).toFixed(1)}" width="${w.toFixed(1)}" height="${h.toFixed(1)}" rx="${pad.shape === 'oval' ? Math.min(w, h) / 2 : 0}" fill="${col}" fill-opacity="${op}" transform="translate(${X(ctr.x)} ${Y(ctr.y)}) rotate(${-rot})"/>`);
        if (pad.th) out.push(`<circle cx="${X(ctr.x)}" cy="${Y(ctr.y)}" r="${(((pad.drill ?? Math.min(pad.w, pad.h) / 2) / 2) * scale).toFixed(1)}" fill="#101418"/>`);
      }
    }
  }
  for (const v of p.vias) out.push(`${v.from && v.to ? `<circle cx="${X(v.x)}" cy="${Y(v.y)}" r="${((v.diameter / 2) * scale + 2).toFixed(1)}" fill="none" stroke="#ffd36b" stroke-dasharray="2 2"/>` : ''}<circle cx="${X(v.x)}" cy="${Y(v.y)}" r="${((v.diameter / 2) * scale).toFixed(1)}" fill="#c9c9c9"/><circle cx="${X(v.x)}" cy="${Y(v.y)}" r="${((v.drill / 2) * scale).toFixed(1)}" fill="#101418"/>`);
  for (const c of p.components) {
    const fp = lib[c.footprint]; if (!fp) continue;
    for (const pl of fp.outline) out.push(`<polyline points="${pl.map((q) => { const b = padToBoard(c, q); return `${X(b.x)},${Y(b.y)}`; }).join(' ')}" fill="none" stroke="${c.side === 'front' ? '#b8c7d9' : '#8a7cc2'}" stroke-width="1"/>`);
    out.push(`<text x="${X(c.x)}" y="${Y(c.y)}" fill="#e6eef7" font-size="${Math.max(8, 1.2 * scale).toFixed(0)}" text-anchor="middle" dominant-baseline="middle">${c.ref}</text>`);
  }
  // rooms, free text, dimensions
  for (const rm of p.rooms ?? []) out.push(`<rect x="${X(Math.min(rm.rect.x1, rm.rect.x2))}" y="${Y(Math.max(rm.rect.y1, rm.rect.y2))}" width="${(Math.abs(rm.rect.x2 - rm.rect.x1) * scale).toFixed(1)}" height="${(Math.abs(rm.rect.y2 - rm.rect.y1) * scale).toFixed(1)}" fill="none" stroke="#be8cff" stroke-dasharray="8 4"/><text x="${X(Math.min(rm.rect.x1, rm.rect.x2)) }" y="${Y(Math.max(rm.rect.y1, rm.rect.y2))}" fill="#be8cff" font-size="11" dy="12" dx="3">room ${rm.name}</text>`);
  const strokes = (ss: { x: number; y: number }[][], col: string, w: number) => { for (const s of ss) out.push(`<polyline points="${s.map((q) => `${X(q.x)},${Y(q.y)}`).join(' ')}" fill="none" stroke="${col}" stroke-width="${Math.max(1, w * scale).toFixed(2)}" stroke-linecap="round"/>`); };
  for (const tx of p.texts ?? []) strokes(textStrokes(tx, tx.layer === 'B.Silk'), tx.layer === 'B.Silk' ? '#c2a7ff' : tx.layer.includes('Fab') ? '#9ad0ff' : '#f2f2f2', Math.max(0.1, tx.size * 0.12));
  for (const dm of p.dimensions ?? []) strokes(dimensionStrokes(dm), '#9ad0ff', 0.12);
  if (opts.rats ?? true) for (const r of ratsnest(p)) out.push(`<line x1="${X(r.a.x)}" y1="${Y(r.a.y)}" x2="${X(r.b.x)}" y2="${Y(r.b.y)}" stroke="rgba(255,255,255,0.6)" stroke-dasharray="4 3"/>`);
  out.push('</svg>');
  return out.join('\n');
}
