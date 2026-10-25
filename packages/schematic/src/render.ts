/**
 * Page drawing as primitives (mils, y down) shared by the canvas editor, SVG and PDF output: border with grid
 * zones, title block, part symbols (graphics, pins with numbers and names, reference and value), wires, buses, bus
 * entries, junction dots, net aliases, power / ground symbols, ports, off-page connectors, no-connects, hierarchical
 * blocks, text and graphics.
 */
import { type Design, type Page, type Pt, type Graphic, type PartInst, type Global, PAGE_SIZES, libPart, viewOf, toPage, propOf, unitLetter } from './model.js';
import { blockPinAt } from './connect.js';

export type Prim =
  | { t: 'line'; pts: Pt[]; w: number; c: string; dash?: boolean; obj?: string }
  | { t: 'circle'; c0: Pt; r: number; w: number; c: string; fill?: boolean; obj?: string }
  | { t: 'arc'; c0: Pt; r: number; a0: number; a1: number; w: number; c: string; obj?: string }
  | { t: 'poly'; pts: Pt[]; w: number; c: string; fill?: boolean; obj?: string }
  | { t: 'text'; at: Pt; s: string; size: number; c: string; anchor: 'start' | 'middle' | 'end'; rot?: number; bold?: boolean; obj?: string };

export const COLORS = { wire: '#1a7f1a', bus: '#1f3fbf', part: '#8b0000', pin: '#8b0000', text: '#1f2f6f', ref: '#00008b', value: '#4b4b4b', border: '#7a1f1f', junction: '#1a7f1a', alias: '#000080', power: '#8b4500', port: '#6a1b9a', nc: '#d00000', block: '#00557f', note: '#333333' };

/** Rotate a symbol-local graphic into page space. */
function tg(pi: { x: number; y: number; rot: number; mirror?: boolean }, g: Graphic, color: string, obj: string, out: Prim[]) {
  const T = (q: Pt) => toPage(pi, q);
  switch (g.kind) {
    case 'line': out.push({ t: 'line', pts: g.pts.map(T), w: g.width ?? 8, c: color, obj }); break;
    case 'rect': { const pts = [{ x: g.x1, y: g.y1 }, { x: g.x2, y: g.y1 }, { x: g.x2, y: g.y2 }, { x: g.x1, y: g.y2 }].map(T); out.push({ t: 'poly', pts, w: 8, c: color, fill: g.fill, obj }); break; }
    case 'circle': out.push({ t: 'circle', c0: T(g.c), r: g.r, w: 8, c: color, fill: g.fill, obj }); break;
    case 'polygon': out.push({ t: 'poly', pts: g.pts.map(T), w: 8, c: color, fill: g.fill, obj }); break;
    case 'arc': {
      // the angles turn with the instance (screen counter-clockwise; a mirror reflects them)
      let a0 = g.a0, a1 = g.a1;
      if (pi.mirror) { [a0, a1] = [180 - a1, 180 - a0]; }
      out.push({ t: 'arc', c0: T(g.c), r: g.r, a0: a0 + pi.rot, a1: a1 + pi.rot, w: 8, c: color, obj }); break;
    }
    case 'text': { const at = T(g.at); out.push({ t: 'text', at, s: g.text, size: g.size ?? 50, c: COLORS.text, anchor: pi.mirror && g.anchor !== 'middle' ? (g.anchor === 'end' ? 'start' : 'end') : (g.anchor ?? 'start'), rot: ((g.rot ?? 0) + (pi.rot === 90 || pi.rot === 270 ? 90 : 0)) % 180, obj }); break; }
  }
}

const DIRV: Record<string, Pt> = { left: { x: 1, y: 0 }, right: { x: -1, y: 0 }, up: { x: 0, y: 1 }, down: { x: 0, y: -1 } };

export function partPrims(d: Design, pi: PartInst, out: Prim[], opts: { selected?: boolean } = {}) {
  const lp = libPart(d, pi.lib, pi.part);
  const obj = `part:${pi.id}`;
  const col = opts.selected ? '#ff6a00' : COLORS.part;
  if (!lp) { out.push({ t: 'poly', pts: [{ x: pi.x - 100, y: pi.y - 100 }, { x: pi.x + 100, y: pi.y - 100 }, { x: pi.x + 100, y: pi.y + 100 }, { x: pi.x - 100, y: pi.y + 100 }], w: 8, c: '#f00', obj }, { t: 'text', at: { x: pi.x, y: pi.y }, s: `? ${pi.part}`, size: 50, c: '#f00', anchor: 'middle', obj }); return; }
  const v = viewOf(lp, pi.unit, pi.convert);
  for (const g of v.graphics) tg(pi, g, col, obj, out);
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const ext = (q: Pt) => { minX = Math.min(minX, q.x); minY = Math.min(minY, q.y); maxX = Math.max(maxX, q.x); maxY = Math.max(maxY, q.y); };
  for (const pin of v.pins) {
    if (pin.hidden) continue;
    const dv = DIRV[pin.orient];
    const tip = { x: pin.x, y: pin.y }, base = { x: pin.x + dv.x * pin.length, y: pin.y + dv.y * pin.length };
    const T = (q: Pt) => toPage(pi, q);
    if (pin.length > 0) out.push({ t: 'line', pts: [T(tip), T(base)], w: 8, c: col, obj });
    if (pin.shape === 'dot' || pin.shape === 'dot_clock') out.push({ t: 'circle', c0: T({ x: base.x - dv.x * 15, y: base.y - dv.y * 15 }), r: 15, w: 6, c: col, obj });
    ext(T(tip)); ext(T(base));
    const lpkind = lp.kind && lp.kind !== 'part';
    if (!lpkind && lp.units.length + v.pins.length > 3) {
      // pin number on the pin, name inside the body
      const mid = T({ x: (tip.x + base.x) / 2, y: (tip.y + base.y) / 2 }), inside = T({ x: base.x + dv.x * 20, y: base.y + dv.y * 20 });
      const horizontal = Math.abs(T(base).x - T(tip).x) > Math.abs(T(base).y - T(tip).y);
      if (!lp.hidePinNumbers) out.push({ t: 'text', at: { x: mid.x, y: mid.y - (horizontal ? 12 : 0) }, s: pin.number, size: 40, c: col, anchor: 'middle', rot: horizontal ? 0 : 90, obj });
      if (!lp.hidePinNames && pin.name && pin.name !== pin.number && !/^~?$/.test(pin.name)) out.push({ t: 'text', at: { x: inside.x, y: inside.y + (horizontal ? 15 : 0) }, s: pin.name, size: 40, c: COLORS.text, anchor: horizontal ? (T(base).x > T(tip).x ? 'start' : 'end') : 'start', rot: horizontal ? 0 : 90, obj });
    }
  }
  for (const g of v.graphics) { if (g.kind === 'rect') { ext(toPage(pi, { x: g.x1, y: g.y1 })); ext(toPage(pi, { x: g.x2, y: g.y2 })); } else if (g.kind === 'line' || g.kind === 'polygon') g.pts.forEach((q) => ext(toPage(pi, q))); else if (g.kind === 'circle' || g.kind === 'arc') { ext(toPage(pi, { x: g.c.x - g.r, y: g.c.y - g.r })); ext(toPage(pi, { x: g.c.x + g.r, y: g.c.y + g.r })); } }
  if (!Number.isFinite(minX)) { minX = pi.x - 50; maxX = pi.x + 50; minY = pi.y - 50; maxY = pi.y + 50; }
  if (lp.kind && lp.kind !== 'part') return;
  const shown = pi.shownProps ?? ['Reference', 'Value'];
  let ty = minY - 20;
  const label = (s: string, c: string) => { out.push({ t: 'text', at: { x: (minX + maxX) / 2, y: ty }, s, size: 50, c, anchor: 'middle', obj }); ty -= 60; };
  const lines: [string, string][] = [];
  for (const k of shown) { if (k === 'Reference') lines.push([`${pi.ref}${lp.units.length > 1 ? unitLetter(pi.unit) : ''}`, COLORS.ref]); else { const v2 = propOf(d, pi, k); if (v2) lines.push([v2, COLORS.value]); } }
  for (const [s, c] of lines.reverse()) label(s, c);
  if (pi.dnp) out.push({ t: 'line', pts: [{ x: minX, y: minY }, { x: maxX, y: maxY }], w: 6, c: '#c00', obj }, { t: 'line', pts: [{ x: minX, y: maxY }, { x: maxX, y: minY }], w: 6, c: '#c00', obj });
}

function globalPrims(g: Global, out: Prim[]) {
  const obj = `global:${g.id}`, c = COLORS.power, { x, y } = g.at;
  const rot = g.rot ?? 0;
  const R = (dx: number, dy: number): Pt => { const a = (rot * Math.PI) / 180, co = Math.round(Math.cos(a)), si = Math.round(Math.sin(a)); return { x: x + dx * co + dy * si, y: y - dx * si + dy * co }; };
  if (g.style === 'label') {
    // global label: a flag with the name, pointing away from its connection point
    const w = 60 + g.net.length * 32, s = rot === 180 ? -1 : 1;
    out.push({ t: 'poly', pts: [{ x, y }, { x: x + s * 40, y: y - 40 }, { x: x + s * (40 + w), y: y - 40 }, { x: x + s * (40 + w), y: y + 40 }, { x: x + s * 40, y: y + 40 }], w: 6, c: '#7a4f00', obj }, { t: 'text', at: { x: x + s * 60, y: y + 17 }, s: g.net, size: 45, c: '#7a4f00', anchor: s > 0 ? 'start' : 'end', obj });
    return;
  }
  if (g.style.startsWith('ground')) {
    out.push({ t: 'line', pts: [R(0, 0), R(0, 50)], w: 8, c, obj });
    if (g.style === 'ground_signal') out.push({ t: 'poly', pts: [R(-50, 50), R(50, 50), R(0, 110)], w: 8, c, obj });
    else for (let i = 0; i < 3; i++) out.push({ t: 'line', pts: [R(-50 + i * 15, 50 + i * 25), R(50 - i * 15, 50 + i * 25)], w: 8, c, obj });
    out.push({ t: 'text', at: R(0, 160), s: g.net, size: 45, c, anchor: 'middle', obj });
  } else {
    out.push({ t: 'line', pts: [R(0, 0), R(0, -60)], w: 8, c, obj });
    if (g.style === 'power_circle') out.push({ t: 'circle', c0: R(0, -85), r: 25, w: 8, c, obj });
    else if (g.style === 'power_arrow') out.push({ t: 'poly', pts: [R(-30, -60), R(30, -60), R(0, -110)], w: 8, c, obj, fill: true });
    else out.push({ t: 'line', pts: [R(-60, -60), R(60, -60)], w: 10, c, obj });
    out.push({ t: 'text', at: R(0, -130), s: g.net, size: 45, c, anchor: 'middle', obj });
  }
}

/** Every primitive of a page. `selected` object keys ("part:12") are drawn highlighted; `highlightNets` wire ids. */
export function pagePrims(d: Design, page: Page, opts: { selected?: Set<string>; highlight?: Set<string>; border?: boolean } = {}): Prim[] {
  const out: Prim[] = [];
  const sel = opts.selected ?? new Set<string>();
  const S = PAGE_SIZES[page.size];
  if (opts.border !== false) {
    const m = 200;
    out.push({ t: 'poly', pts: [{ x: 0, y: 0 }, { x: S.w, y: 0 }, { x: S.w, y: S.h }, { x: 0, y: S.h }], w: 10, c: COLORS.border, obj: 'border' });
    out.push({ t: 'poly', pts: [{ x: m, y: m }, { x: S.w - m, y: m }, { x: S.w - m, y: S.h - m }, { x: m, y: S.h - m }], w: 6, c: COLORS.border, obj: 'border' });
    // grid zones 1..8 across, A..D down
    for (let i = 1; i < 8; i++) { const x = (S.w * i) / 8; out.push({ t: 'line', pts: [{ x, y: 0 }, { x, y: m }], w: 4, c: COLORS.border }, { t: 'line', pts: [{ x, y: S.h - m }, { x, y: S.h }], w: 4, c: COLORS.border }); }
    for (let i = 0; i < 8; i++) { const x = (S.w * (i + 0.5)) / 8; out.push({ t: 'text', at: { x, y: m * 0.65 }, s: String(8 - i), size: 70, c: COLORS.border, anchor: 'middle' }, { t: 'text', at: { x, y: S.h - m * 0.3 }, s: String(8 - i), size: 70, c: COLORS.border, anchor: 'middle' }); }
    for (let i = 0; i < 4; i++) { const y = (S.h * (i + 0.5)) / 4; out.push({ t: 'text', at: { x: m / 2, y }, s: String.fromCharCode(68 - i), size: 70, c: COLORS.border, anchor: 'middle' }, { t: 'text', at: { x: S.w - m / 2, y }, s: String.fromCharCode(68 - i), size: 70, c: COLORS.border, anchor: 'middle' }); }
    // title block
    const tw = 3800, th = 900, x0 = S.w - m - tw, y0 = S.h - m - th;
    out.push({ t: 'poly', pts: [{ x: x0, y: y0 }, { x: x0 + tw, y: y0 }, { x: x0 + tw, y: y0 + th }, { x: x0, y: y0 + th }], w: 8, c: COLORS.border, obj: 'title' });
    for (const [i, y] of [[0, 250], [1, 550]] as const) out.push({ t: 'line', pts: [{ x: x0, y: y0 + y }, { x: x0 + tw, y: y0 + y }], w: 6, c: COLORS.border }); void 0;
    const t = { ...(d.settings.titleDefaults ?? {}), ...(page.title ?? {}) };
    out.push({ t: 'text', at: { x: x0 + 60, y: y0 + 120 }, s: t.Company ?? '', size: 60, c: COLORS.border, anchor: 'start' });
    out.push({ t: 'text', at: { x: x0 + 60, y: y0 + 420 }, s: `Title: ${t.Title ?? page.name}`, size: 80, c: COLORS.text, anchor: 'start', bold: true });
    out.push({ t: 'text', at: { x: x0 + 60, y: y0 + 740 }, s: `Doc: ${t['Document Number'] ?? d.name}   Rev: ${t.Revision ?? ''}   Date: ${t.Date ?? ''}   Sheet: ${t.Sheet ?? ''}`, size: 55, c: COLORS.border, anchor: 'start' });
  }
  for (const g of page.graphics) tg({ x: 0, y: 0, rot: 0 }, g.g, sel.has(`graphic:${g.id}`) ? '#ff6a00' : COLORS.note, `graphic:${g.id}`, out);
  const hl = opts.highlight ?? new Set<string>();
  for (const w of page.wires) out.push({ t: 'line', pts: w.pts, w: hl.has(`w${w.id}`) ? 22 : 10, c: sel.has(`wire:${w.id}`) ? '#ff6a00' : hl.has(`w${w.id}`) ? '#ffb000' : COLORS.wire, obj: `wire:${w.id}` });
  for (const b of page.buses) out.push({ t: 'line', pts: b.pts, w: 30, c: sel.has(`bus:${b.id}`) ? '#ff6a00' : COLORS.bus, obj: `bus:${b.id}` });
  for (const e of page.busEntries) { const dx = e.dir.endsWith('e') ? 100 : -100, dy = e.dir.startsWith('n') ? -100 : 100; out.push({ t: 'line', pts: [e.at, { x: e.at.x + dx, y: e.at.y + dy }], w: 10, c: COLORS.bus, obj: `busEntry:${e.id}` }); }
  for (const j of page.junctions) out.push({ t: 'circle', c0: j.at, r: 25, w: 0, c: COLORS.junction, fill: true, obj: `junction:${j.id}` });
  for (const a of page.aliases) out.push({ t: 'text', at: { x: a.at.x + 10, y: a.at.y - 15 }, s: a.name, size: 50, c: sel.has(`alias:${a.id}`) ? '#ff6a00' : COLORS.alias, anchor: 'start', rot: a.rot ?? 0, obj: `alias:${a.id}` });
  for (const g of page.globals) globalPrims(g, out);
  for (const p of page.ports) {
    const dir = (p.rot ?? 0) === 180 ? -1 : 1, { x, y } = p.at, c = sel.has(`port:${p.id}`) ? '#ff6a00' : COLORS.port, obj = `port:${p.id}`;
    out.push({ t: 'poly', pts: [{ x, y }, { x: x + dir * 60, y: y - 50 }, { x: x + dir * 360, y: y - 50 }, { x: x + dir * 360, y: y + 50 }, { x: x + dir * 60, y: y + 50 }], w: 8, c, obj }, { t: 'text', at: { x: x + dir * 400, y: y + 18 }, s: p.name, size: 50, c, anchor: dir > 0 ? 'start' : 'end', obj });
  }
  for (const o of page.offPages) {
    const dir = (o.rot ?? 0) === 180 ? -1 : 1, { x, y } = o.at, c = COLORS.port, obj = `offpage:${o.id}`;
    out.push({ t: 'poly', pts: [{ x, y }, { x: x + dir * 100, y: y - 50 }, { x: x + dir * 200, y: y }, { x: x + dir * 100, y: y + 50 }], w: 8, c, obj }, { t: 'poly', pts: [{ x: x + dir * 100, y: y - 50 }, { x: x + dir * 200, y }, { x: x + dir * 300, y: y - 50 }, { x: x + dir * 200, y: y }], w: 6, c, obj }, { t: 'text', at: { x: x + dir * 340, y: y + 18 }, s: o.name, size: 50, c, anchor: dir > 0 ? 'start' : 'end', obj });
  }
  for (const n of page.noConnects) out.push({ t: 'line', pts: [{ x: n.at.x - 40, y: n.at.y - 40 }, { x: n.at.x + 40, y: n.at.y + 40 }], w: 10, c: COLORS.nc, obj: `nc:${n.id}` }, { t: 'line', pts: [{ x: n.at.x - 40, y: n.at.y + 40 }, { x: n.at.x + 40, y: n.at.y - 40 }], w: 10, c: COLORS.nc, obj: `nc:${n.id}` });
  for (const b of page.blocks) {
    const c = sel.has(`block:${b.id}`) ? '#ff6a00' : COLORS.block, obj = `block:${b.id}`;
    out.push({ t: 'poly', pts: [{ x: b.x, y: b.y }, { x: b.x + b.w, y: b.y }, { x: b.x + b.w, y: b.y + b.h }, { x: b.x, y: b.y + b.h }], w: 10, c, obj, fill: false });
    out.push({ t: 'text', at: { x: b.x, y: b.y - 30 }, s: `${b.ref}: ${b.schematic}`, size: 55, c, anchor: 'start', obj, bold: true });
    for (const p of b.pins) { const at = blockPinAt(b, p); out.push({ t: 'poly', pts: [{ x: at.x - 30, y: at.y - 30 }, { x: at.x + 30, y: at.y - 30 }, { x: at.x + 30, y: at.y + 30 }, { x: at.x - 30, y: at.y + 30 }], w: 6, c, obj, fill: true }); const inside = p.side === 'left' ? { x: at.x + 50, y: at.y + 15 } : p.side === 'right' ? { x: at.x - 50, y: at.y + 15 } : p.side === 'top' ? { x: at.x, y: at.y + 70 } : { x: at.x, y: at.y - 40 }; out.push({ t: 'text', at: inside, s: p.name, size: 45, c, anchor: p.side === 'left' ? 'start' : p.side === 'right' ? 'end' : 'middle', obj }); }
  }
  for (const t of page.texts) out.push({ t: 'text', at: t.at, s: t.text, size: t.size ?? 60, c: sel.has(`text:${t.id}`) ? '#ff6a00' : COLORS.note, anchor: 'start', rot: t.rot, obj: `text:${t.id}` });
  for (const pi of page.parts) partPrims(d, pi, out, { selected: sel.has(`part:${pi.id}`) });
  for (const bm of page.bookmarks) out.push({ t: 'text', at: bm.at, s: `⚑ ${bm.name}`, size: 45, c: '#008080', anchor: 'start', obj: `bookmark:${bm.id}` });
  return out;
}

/** Junction dots where three or more wire ends / T-joins meet (Capture places them automatically). */
export function autoJunctions(page: Page): Pt[] {
  const cnt = new Map<string, { p: Pt; n: number }>();
  const add = (p: Pt, n = 1) => { const k = `${p.x},${p.y}`; const e = cnt.get(k) ?? { p, n: 0 }; e.n += n; cnt.set(k, e); };
  for (const w of page.wires) { add(w.pts[0]); add(w.pts[w.pts.length - 1]); for (let i = 1; i < w.pts.length - 1; i++) add(w.pts[i], 2); }
  for (const w of page.wires) for (const o of page.wires) if (o !== w) for (const e of [o.pts[0], o.pts[o.pts.length - 1]]) for (let i = 1; i < w.pts.length; i++) { const a = w.pts[i - 1], b = w.pts[i]; const inside = (a.x === b.x && e.x === a.x && e.y > Math.min(a.y, b.y) && e.y < Math.max(a.y, b.y)) || (a.y === b.y && e.y === a.y && e.x > Math.min(a.x, b.x) && e.x < Math.max(a.x, b.x)); if (inside) add(e, 2); }
  return [...cnt.values()].filter((e) => e.n >= 3).map((e) => e.p);
}
