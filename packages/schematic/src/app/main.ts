/**
 * OpenSchematic — schematic capture in the browser / desktop app (the OrCAD Capture / Allegro System Capture
 * counterpart of OpenBoard).
 *
 * Editing: parts, wires (orthogonal, auto-ends on pins), buses and bus entries, net aliases, power / ground,
 * hierarchical ports and blocks (descend / ascend), off-page connectors, no-connects, junctions, text and graphics;
 * move with rubber-banding wires, rotate, mirror, copy / paste, undo / redo. Project tree with schematic folders and
 * pages, library browser with preview, property editor, find, net browser with highlighting across pages.
 * Tools: annotate, ERC, netlists (KiCad / Telesis / EDIF / SPICE), BOM, cross reference, PDF / SVG, forward annotation
 * to OpenBoard and back annotation, variants, SPICE simulation with plots, symbol editor, OpenSKILL console,
 * cross-probing with OpenBoard. Imports KiCad, OrCAD Capture (.DSN / .OLB) and Altium (.SchDoc) designs and libraries.
 */
import { type Design, type Page, type PartInst, type Pt, type LibPart, type Library, type Graphic, type Global, PAGE_SIZES, newDesign, newPage, nid, normalizeDesign, libPart, propOf, instPins, schematicOf, allPages, unitLetter, viewOf, toPage } from '../model.js';
import { basicLibrary } from '../library.js';
import { pagePrims, partPrims, autoJunctions, type Prim } from '../render.js';
import { buildNetlist, blockPinAt, type Netlist } from '../connect.js';
import { annotate, resetAnnotation, backAnnotate } from '../annotate.js';
import { runErc, type ErcMarker } from '../erc.js';
import { toBoard, kicadNetlist, telesisNetlist, edifNetlist, spiceNetlist, bom, crossReference } from '../netlist.js';
import { pageSvg, designPdf } from '../output.js';
import { importKicadSchematic, importKicadSymbolLibrary } from '../kicadsch.js';
import { importAltiumSchematic } from '../altiumsch.js';
import { importOrcadDesign, importOrcadLibrary } from '../orcad.js';
import { importSystemCapture } from '../syscap.js';
import { importDeHdl } from '../dehdl.js';
import { simulate, type SimResult } from '../spice.js';
import { schSkill } from '../schskill.js';
import { show } from '../../../editor/src/skill.js';
import { xprobeSend, xprobeOn } from '../../../editor/src/xprobe.js';
import { drawPrims, primBox, primDist, fitXf, type Xf } from './draw.js';
import { pinsToText, textToPins, gfxToText, textToGfx, generateBox } from './symtext.js';
import { TeamClient } from './team.js';
import { constraintsToText, textToConstraints, compareDesigns, parseCsv, linkPartDatabase, replaceInDesign } from '../design_tools.js';
import type { PinType } from '../model.js';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const canvas = $<HTMLCanvasElement>('canvas');
const ctx = canvas.getContext('2d')!;

/* ---------------------------------------------------------------- state */
type Tool = 'select' | 'part' | 'wire' | 'bus' | 'busentry' | 'alias' | 'power' | 'ground' | 'port' | 'offpage' | 'nc' | 'junction' | 'block' | 'text' | 'line' | 'rect' | 'probe';
const st = {
  d: newDesign('untitled') as Design,
  sch: '', page: 0,
  path: [] as { sch: string; page: number; ref: string }[],   // hierarchy stack (descended blocks)
  sel: new Set<string>(),
  tool: 'select' as Tool,
  xf: { s: 0.12, ox: -200, oy: -200 } as Xf,
  undo: [] as string[], redo: [] as string[],
  highlight: '' as string,          // net name highlighted
  variant: '' as string,
  placing: null as null | { lib: string; part: string; unit: number; rot: 0 | 90 | 180 | 270; mirror: boolean },
  pts: [] as Pt[],                  // wire / bus / line being drawn
  cursor: { x: 0, y: 0 } as Pt,
  hv: true,                         // wire corner: horizontal first
  drag: null as null | { kind: 'move' | 'pan' | 'box' | 'rect' | 'block'; start: Pt; screen: Pt; orig?: string; moved?: boolean; ends?: { w: number; i: number }[] },
  erc: [] as ErcMarker[],
  nl: null as Netlist | null,
  clip: '' as string,
  dirty: false,
  file: 'untitled.opensch.json',
  sim: null as null | SimResult,
  libSel: null as null | { lib: string; part: string },
};
const GRID = 100;

const page = (): Page => { const s = schematicOf(st.d, st.sch) ?? st.d.schematics[0]; st.sch = s.name; if (st.page >= s.pages.length) st.page = 0; return s.pages[st.page]; };
const snap = (v: number) => Math.round(v / GRID) * GRID;
const snapPt = (p: Pt): Pt => ({ x: snap(p.x), y: snap(p.y) });
const log = (s: string) => { const el = $('log'); el.textContent += s + '\n'; el.scrollTop = el.scrollHeight; };
const status = (s: string) => { $('status').textContent = s; };

function snapshot() { st.undo.push(JSON.stringify(st.d)); if (st.undo.length > 150) st.undo.shift(); st.redo = []; }
function changed() { st.dirty = true; st.nl = null; render(); fillNets(); team.changed(); try { localStorage.setItem('opensch.autosave', JSON.stringify({ d: st.d, file: st.file })); } catch { /* quota */ } }
const team = new TeamClient({
  design: () => st.d,
  replace: (d) => { st.d = normalizeDesign(d); st.sel.clear(); st.undo = []; st.redo = []; if (!schematicOf(st.d, st.sch)) { st.sch = st.d.root; st.page = 0; } refreshAll(); },
  refresh: () => { st.nl = null; fillTree(); fillTabs(); render(); fillNets(); },
  log: (s) => log(s),
  page: () => ({ sch: st.sch, page: page().name }),
});
function edit(f: () => void) { snapshot(); f(); changed(); fillProps(); }
function undo() { const s = st.undo.pop(); if (!s) return; st.redo.push(JSON.stringify(st.d)); st.d = normalizeDesign(JSON.parse(s)); st.sel.clear(); refreshAll(); }
function redo() { const s = st.redo.pop(); if (!s) return; st.undo.push(JSON.stringify(st.d)); st.d = normalizeDesign(JSON.parse(s)); st.sel.clear(); refreshAll(); }
function netlist(): Netlist { if (!st.nl) st.nl = buildNetlist(st.d, { variant: st.variant || undefined }); return st.nl; }

/* ---------------------------------------------------------------- view */
const toWorld = (sx: number, sy: number): Pt => ({ x: sx / st.xf.s + st.xf.ox, y: sy / st.xf.s + st.xf.oy });
let fitted = false;
function resize() { const r = canvas.getBoundingClientRect(); canvas.width = Math.max(100, Math.floor(r.width)); canvas.height = Math.max(100, Math.floor(r.height)); if (!fitted && r.width > 200) { fitted = true; fitPage(); } render(); }
function fitPage() { const S = PAGE_SIZES[page().size]; st.xf = fitXf({ x1: 0, y1: 0, x2: S.w, y2: S.h }, canvas.width, canvas.height, 20); render(); }
function zoomAt(sx: number, sy: number, f: number) { const w = toWorld(sx, sy); st.xf.s = Math.min(3, Math.max(0.01, st.xf.s * f)); st.xf.ox = w.x - sx / st.xf.s; st.xf.oy = w.y - sy / st.xf.s; render(); }
function centerOn(p: Pt) { st.xf.ox = p.x - canvas.width / 2 / st.xf.s; st.xf.oy = p.y - canvas.height / 2 / st.xf.s; }

let prims: Prim[] = [];
function highlightSet(): Set<string> {
  const out = new Set<string>(); if (!st.highlight) return out;
  const pn = netlist().pageNets.get(`${st.sch}/${page().name}`);
  if (pn) for (const [k, v] of pn) if (v === st.highlight || v.endsWith('/' + st.highlight)) out.add(k);
  return out;
}

function render() {
  const W = canvas.width, H = canvas.height, pg = page(), S = PAGE_SIZES[pg.size];
  ctx.fillStyle = '#0e1114'; ctx.fillRect(0, 0, W, H);
  // the sheet
  const a = { x: (0 - st.xf.ox) * st.xf.s, y: (0 - st.xf.oy) * st.xf.s };
  ctx.fillStyle = '#ffffff'; ctx.fillRect(a.x, a.y, S.w * st.xf.s, S.h * st.xf.s);
  // grid dots
  if (GRID * st.xf.s >= 7) {
    ctx.fillStyle = '#c9ced6';
    const w0 = toWorld(0, 0), w1 = toWorld(W, H);
    for (let x = Math.max(0, snap(w0.x)); x <= Math.min(S.w, w1.x); x += GRID) for (let y = Math.max(0, snap(w0.y)); y <= Math.min(S.h, w1.y); y += GRID) ctx.fillRect((x - st.xf.ox) * st.xf.s - 0.5, (y - st.xf.oy) * st.xf.s - 0.5, 1.2, 1.2);
  }
  // variant DNP marks follow the selected variant
  const v = st.d.variants.find((x) => x.name === st.variant);
  const dnpSaved = new Map<PartInst, boolean | undefined>();
  if (v) for (const pi of pg.parts) { dnpSaved.set(pi, pi.dnp); if (v.dnp.includes(pi.ref)) pi.dnp = true; }
  prims = pagePrims(st.d, pg, { selected: st.sel, highlight: highlightSet() });
  for (const [pi, x] of dnpSaved) pi.dnp = x;
  for (const j of autoJunctions(pg)) prims.push({ t: 'circle', c0: j, r: 25, w: 0, c: '#1a7f1a', fill: true });
  drawPrims(ctx, prims, st.xf);
  // ERC markers on this page
  for (const m of st.erc) if (m.at && m.page === `${st.sch}/${pg.name}`) drawPrims(ctx, [{ t: 'circle', c0: m.at, r: 60, w: 12, c: m.severity === 'error' ? '#e11d48' : '#d97706' }], st.xf);
  // tool previews
  drawPrims(ctx, previewPrims(), st.xf, { alpha: 0.75 });
  // other designers (team design): cursors on this page, and a reserved page outline
  for (const [u, c] of team.cursors) if (c.sch === st.sch && c.page === pg.name) drawPrims(ctx, [{ t: 'poly', pts: [{ x: c.x, y: c.y }, { x: c.x + 60, y: c.y + 160 }, { x: c.x + 160, y: c.y + 60 }], w: 6, c: c.color, fill: true }, { t: 'text', at: { x: c.x + 170, y: c.y + 170 }, s: u, size: 60, c: c.color, anchor: 'start' }], st.xf);
  const res = team.reservations.find((r) => r.sch === st.sch && r.page === pg.name);
  if (res) drawPrims(ctx, [{ t: 'poly', pts: [{ x: 0, y: 0 }, { x: S.w, y: 0 }, { x: S.w, y: S.h }, { x: 0, y: S.h }], w: 40, c: res.owner === team.user ? '#16a34a' : '#dc2626' }, { t: 'text', at: { x: 300, y: 160 }, s: `reserved by ${res.owner}`, size: 90, c: res.owner === team.user ? '#16a34a' : '#dc2626', anchor: 'start' }], st.xf);
  if (st.drag?.kind === 'box' || st.drag?.kind === 'rect' || st.drag?.kind === 'block') {
    const p0 = st.drag.start, p1 = st.cursor;
    drawPrims(ctx, [{ t: 'poly', pts: [p0, { x: p1.x, y: p0.y }, p1, { x: p0.x, y: p1.y }], w: 0, c: '#3b82f6' }], st.xf);
  }
  status(`${st.sch}/${pg.name}  x ${Math.round(st.cursor.x)}  y ${Math.round(st.cursor.y)} mil  zoom ${(st.xf.s * 100).toFixed(1)}%  ${st.tool}${st.highlight ? '  net ' + st.highlight : ''}${st.dirty ? '  *' : ''}`);
  $('crumbs').textContent = [...st.path.map((p) => `${p.sch}/${p.ref}`), st.sch].join(' › ');
}

function previewPrims(): Prim[] {
  const out: Prim[] = [], c = st.cursor;
  const col = '#2563eb';
  if (st.tool === 'part' && st.placing) {
    const pi: PartInst = { id: -1, lib: st.placing.lib, part: st.placing.part, unit: st.placing.unit, ref: '?', x: c.x, y: c.y, rot: st.placing.rot, mirror: st.placing.mirror, props: {} };
    partPrims(st.d, pi, out); return out.map((p) => ({ ...p, c: col }));
  }
  if ((st.tool === 'wire' || st.tool === 'bus' || st.tool === 'line') && st.pts.length) {
    const pts = [...st.pts, ...corner(st.pts[st.pts.length - 1], c)];
    out.push({ t: 'line', pts, w: st.tool === 'bus' ? 30 : 10, c: col, dash: true });
  }
  if (st.tool === 'power' || st.tool === 'ground') out.push({ t: 'circle', c0: c, r: 30, w: 8, c: col });
  if (st.tool === 'busentry') out.push({ t: 'line', pts: [c, { x: c.x + 100, y: c.y - 100 }], w: 10, c: col });
  return out;
}
/** orthogonal corner points from a to b */
function corner(a: Pt, b: Pt): Pt[] { if (a.x === b.x || a.y === b.y) return [b]; return st.hv ? [{ x: b.x, y: a.y }, b] : [{ x: a.x, y: b.y }, b]; }

/* ---------------------------------------------------------------- hit testing */
function objAt(q: Pt): string | null {
  const tol = 8 / st.xf.s;
  let best: { obj: string; d: number; area: number } | null = null;
  // parts and blocks also hit inside their extent
  const boxes = new Map<string, Prim[]>();
  for (const p of prims) if (p.obj && p.obj !== 'border' && p.obj !== 'title') { const a = boxes.get(p.obj) ?? []; a.push(p); boxes.set(p.obj, a); }
  for (const [obj, ps] of boxes) {
    let d = Infinity; for (const p of ps) d = Math.min(d, primDist(p, q));
    const b = primBox(ps)!; const area = (b.x2 - b.x1) * (b.y2 - b.y1);
    if ((obj.startsWith('part:') || obj.startsWith('block:')) && q.x >= b.x1 && q.x <= b.x2 && q.y >= b.y1 && q.y <= b.y2) d = Math.min(d, tol * 0.9);
    if (d <= tol && (!best || d < best.d - 1e-6 || (Math.abs(d - best.d) < 1e-6 && area < best.area))) best = { obj, d, area };
  }
  return best?.obj ?? null;
}
const parseKey = (k: string) => { const i = k.indexOf(':'); return { kind: k.slice(0, i), id: Number(k.slice(i + 1)) }; };
const ARR: Record<string, keyof Page> = { part: 'parts', wire: 'wires', bus: 'buses', busEntry: 'busEntries', junction: 'junctions', alias: 'aliases', global: 'globals', port: 'ports', offpage: 'offPages', nc: 'noConnects', block: 'blocks', text: 'texts', graphic: 'graphics', bookmark: 'bookmarks' };
function objOf(k: string): { arr: { id: number }[]; o: { id: number } & Record<string, unknown> } | null {
  const { kind, id } = parseKey(k); const a = ARR[kind]; if (!a) return null;
  const arr = page()[a] as unknown as ({ id: number } & Record<string, unknown>)[]; const o = arr.find((x) => x.id === id);
  return o ? { arr, o } : null;
}

/** connection points on the page (pins, wire ends) for wire auto-finish */
function connectionAt(q: Pt): boolean {
  const pg = page();
  for (const pi of pg.parts) for (const { pin, at } of instPins(st.d, pi)) if (!pin.hidden && at.x === q.x && at.y === q.y) return true;
  for (const w of pg.wires) for (const e of [w.pts[0], w.pts[w.pts.length - 1]]) if (e.x === q.x && e.y === q.y) return true;
  for (const b of pg.blocks) for (const p of b.pins) { const a = blockPinAt(b, p); if (a.x === q.x && a.y === q.y) return true; }
  return false;
}

/* ---------------------------------------------------------------- moving */
function translate(k: string, dx: number, dy: number) {
  const r = objOf(k); if (!r) return; const o = r.o as Record<string, unknown>;
  const mv = (p: Pt) => { p.x += dx; p.y += dy; };
  if ('pts' in o) (o.pts as Pt[]).forEach(mv);
  else if ('at' in o) mv(o.at as Pt);
  else if ('g' in o) { const g = o.g as Graphic; if (g.kind === 'rect') { g.x1 += dx; g.x2 += dx; g.y1 += dy; g.y2 += dy; } else if (g.kind === 'line' || g.kind === 'polygon') g.pts.forEach(mv); else if (g.kind === 'circle' || g.kind === 'arc') mv(g.c); else if (g.kind === 'text') mv(g.at); }
  else if ('x' in o) { (o as { x: number }).x += dx; (o as { y: number }).y += dy; }
}
/** wire end points attached to the selected parts / blocks / labels: they follow the move (rubber banding) */
function attachedEnds(): { w: number; i: number }[] {
  const pg = page(); const pts: Pt[] = [];
  for (const k of st.sel) {
    const { kind } = parseKey(k); const r = objOf(k); if (!r) continue;
    if (kind === 'part') for (const { at } of instPins(st.d, r.o as unknown as PartInst)) pts.push(at);
    if (kind === 'block') { const b = r.o as unknown as Page['blocks'][number]; for (const p of b.pins) pts.push(blockPinAt(b, p)); }
    if ((kind === 'global' || kind === 'port' || kind === 'offpage') && 'at' in r.o) pts.push(r.o.at as Pt);
  }
  const out: { w: number; i: number }[] = [];
  for (const w of pg.wires) { if (st.sel.has(`wire:${w.id}`)) continue; for (const i of [0, w.pts.length - 1]) if (pts.some((p) => p.x === w.pts[i].x && p.y === w.pts[i].y)) out.push({ w: w.id, i }); }
  return out;
}

/* ---------------------------------------------------------------- mouse */
canvas.addEventListener('contextmenu', (e) => e.preventDefault());
canvas.addEventListener('wheel', (e) => { e.preventDefault(); const r = canvas.getBoundingClientRect(); zoomAt(e.clientX - r.left, e.clientY - r.top, e.deltaY < 0 ? 1.2 : 1 / 1.2); }, { passive: false });
canvas.addEventListener('mousedown', (e) => {
  const r = canvas.getBoundingClientRect(); const sx = e.clientX - r.left, sy = e.clientY - r.top;
  const w = toWorld(sx, sy), g = snapPt(w);
  if (e.button === 1 || (e.button === 0 && e.altKey) || e.button === 2 && st.tool === 'select') { st.drag = { kind: 'pan', start: w, screen: { x: sx, y: sy } }; return; }
  if (e.button === 2) { finishPath(); setTool('select'); return; }
  switch (st.tool) {
    case 'select': {
      const hit = objAt(w);
      if (e.ctrlKey && hit) { highlightAt(w); return; }
      if (hit) {
        if (!e.shiftKey && !st.sel.has(hit)) st.sel.clear();
        if (e.shiftKey && st.sel.has(hit)) st.sel.delete(hit); else st.sel.add(hit);
        st.drag = { kind: 'move', start: g, screen: { x: sx, y: sy }, orig: JSON.stringify(st.d), ends: attachedEnds() };
      } else { if (!e.shiftKey) st.sel.clear(); st.drag = { kind: 'box', start: w, screen: { x: sx, y: sy } }; }
      fillProps(); render(); probeOut(); return;
    }
    case 'probe': highlightAt(w); return;
    case 'part': placePart(g); return;
    case 'wire': case 'bus': case 'line': {
      if (!st.pts.length) { st.pts = [g]; render(); return; }
      const last = st.pts[st.pts.length - 1];
      if (g.x === last.x && g.y === last.y) { finishPath(); return; }
      st.pts.push(...corner(last, g));
      if (st.tool === 'wire' && connectionAt(g) && st.pts.length > 2) finishPath();
      render(); return;
    }
    case 'rect': case 'block': st.drag = { kind: st.tool === 'rect' ? 'rect' : 'block', start: g, screen: { x: sx, y: sy } }; return;
    default: placeAt(g); return;
  }
});
canvas.addEventListener('dblclick', (e) => {
  const r = canvas.getBoundingClientRect(); const w = toWorld(e.clientX - r.left, e.clientY - r.top);
  if (st.tool === 'wire' || st.tool === 'bus' || st.tool === 'line') { finishPath(); return; }
  const hit = objAt(w); if (!hit) return;
  if (hit.startsWith('block:')) { const b = objOf(hit)!.o as unknown as Page['blocks'][number]; descend(b); return; }
  st.sel = new Set([hit]); fillProps(); const f = document.querySelector<HTMLInputElement>('#props input'); f?.focus(); render();
});
let lastCursorSent = 0;
window.addEventListener('mousemove', (e) => {
  const r = canvas.getBoundingClientRect(); const sx = e.clientX - r.left, sy = e.clientY - r.top;
  const w = toWorld(sx, sy); st.cursor = st.tool === 'select' && !st.drag ? w : snapPt(w);
  if (team.connected && e.target === canvas) { const now = Date.now(); if (now - lastCursorSent > 120) { lastCursorSent = now; team.cursor(Math.round(w.x), Math.round(w.y)); } }
  const dg = st.drag;
  if (dg?.kind === 'pan') { st.xf.ox -= (sx - dg.screen.x) / st.xf.s; st.xf.oy -= (sy - dg.screen.y) / st.xf.s; dg.screen = { x: sx, y: sy }; render(); return; }
  if (dg?.kind === 'move') {
    const g = snapPt(w); const dx = g.x - dg.start.x, dy = g.y - dg.start.y;
    if (!dx && !dy && !dg.moved) { render(); return; }
    // move from the original each time
    st.d = normalizeDesign(JSON.parse(dg.orig!)); dg.moved = true;
    for (const k of st.sel) translate(k, dx, dy);
    for (const en of dg.ends ?? []) { const wi = page().wires.find((x) => x.id === en.w); if (!wi) continue; const p = wi.pts[en.i]; const nb = wi.pts[en.i === 0 ? 1 : wi.pts.length - 2]; p.x += dx; p.y += dy;
      // keep the wire orthogonal: bend it with an extra corner when needed
      if (nb && p.x !== nb.x && p.y !== nb.y) { const c = { x: nb.x, y: p.y }; if (en.i === 0) wi.pts.splice(1, 0, c); else wi.pts.splice(wi.pts.length - 1, 0, c); } }
    st.nl = null; render(); return;
  }
  render();
});
window.addEventListener('mouseup', () => {
  const dg = st.drag; st.drag = null; if (!dg) return;
  if (dg.kind === 'move' && dg.moved) { st.undo.push(dg.orig!); st.redo = []; for (const w of page().wires) w.pts = simplify(w.pts); changed(); fillProps(); }
  else if (dg.kind === 'box') {
    const a = dg.start, b = st.cursor; const x1 = Math.min(a.x, b.x), x2 = Math.max(a.x, b.x), y1 = Math.min(a.y, b.y), y2 = Math.max(a.y, b.y);
    if (x2 - x1 > 5 || y2 - y1 > 5) {
      const groups = new Map<string, Prim[]>(); for (const p of prims) if (p.obj && p.obj !== 'border' && p.obj !== 'title') { const g = groups.get(p.obj) ?? []; g.push(p); groups.set(p.obj, g); }
      for (const [k, ps] of groups) { const bb = primBox(ps)!; if (bb.x1 >= x1 && bb.x2 <= x2 && bb.y1 >= y1 && bb.y2 <= y2) st.sel.add(k); }
      fillProps(); probeOut();
    }
    render();
  } else if (dg.kind === 'rect') {
    const a = dg.start, b = st.cursor; if (a.x !== b.x && a.y !== b.y) edit(() => page().graphics.push({ id: nid(st.d), g: { kind: 'rect', x1: Math.min(a.x, b.x), y1: Math.min(a.y, b.y), x2: Math.max(a.x, b.x), y2: Math.max(a.y, b.y) } }));
  } else if (dg.kind === 'block') {
    const a = dg.start, b = st.cursor; if (a.x === b.x || a.y === b.y) return;
    ask('Block: reference and schematic (e.g. "AMP1 AMPLIFIER")', `B${page().blocks.length + 1} ${st.d.schematics.find((s) => s.name !== st.sch)?.name ?? 'CHILD'}`).then((s) => {
      if (!s) return; const [ref, sch] = s.split(/\s+/);
      edit(() => {
        if (!schematicOf(st.d, sch)) { st.d.schematics.push({ name: sch, pages: [newPage('PAGE1')] }); log(`new schematic folder ${sch}`); }
        const bl = { id: nid(st.d), ref, schematic: sch, x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(b.x - a.x), h: Math.abs(b.y - a.y), pins: [] as Page['blocks'][number]['pins'] };
        page().blocks.push(bl); syncBlockPins(bl);
      });
      fillTree();
    });
  } else if (dg.kind === 'pan' && Math.hypot(st.cursor.x - dg.start.x, st.cursor.y - dg.start.y) < 2 && st.tool !== 'select') { /* right click in a tool */ }
});

/** merge collinear consecutive points and drop zero-length segments */
function simplify(pts: Pt[]): Pt[] {
  const out: Pt[] = [];
  for (const p of pts) { const l = out[out.length - 1]; if (l && l.x === p.x && l.y === p.y) continue; if (out.length >= 2) { const a = out[out.length - 2], b = out[out.length - 1]; if ((a.x === b.x && b.x === p.x) || (a.y === b.y && b.y === p.y)) { out[out.length - 1] = p; continue; } } out.push({ x: p.x, y: p.y }); }
  return out.length >= 2 ? out : pts;
}

function finishPath() {
  const pts = simplify(st.pts); st.pts = [];
  if (pts.length >= 2) edit(() => {
    if (st.tool === 'wire') page().wires.push({ id: nid(st.d), pts });
    else if (st.tool === 'bus') page().buses.push({ id: nid(st.d), pts });
    else if (st.tool === 'line') page().graphics.push({ id: nid(st.d), g: { kind: 'line', pts } });
  });
  render();
}

function highlightAt(w: Pt) {
  const hit = objAt(w); const pn = netlist().pageNets.get(`${st.sch}/${page().name}`);
  let name = '';
  if (hit?.startsWith('wire:')) name = pn?.get(`w${parseKey(hit).id}`) ?? '';
  if (!name && hit?.startsWith('part:')) { const pi = objOf(hit)!.o as unknown as PartInst; let bd = Infinity; for (const n of netlist().nets) for (const x of n.nodes) if (x.inst === pi) { const d = Math.hypot(x.at.x - w.x, x.at.y - w.y); if (d < bd) { bd = d; name = n.name; } } }
  st.highlight = st.highlight === name ? '' : name; render(); fillNets();
  if (st.highlight) { log(`net ${st.highlight}`); xprobeSend({ type: 'net', name: st.highlight, from: 'sch' }); }
}

/* ---------------------------------------------------------------- placing */
function placePart(at: Pt) {
  if (!st.placing) { log('pick a part in the library first'); return; }
  const lp = libPart(st.d, st.placing.lib, st.placing.part); if (!lp) return;
  edit(() => { const pi: PartInst = { id: nid(st.d), lib: st.placing!.lib, part: st.placing!.part, unit: st.placing!.unit, ref: `${lp.refPrefix}?`, x: at.x, y: at.y, rot: st.placing!.rot, ...(st.placing!.mirror ? { mirror: true } : {}), props: {} }; page().parts.push(pi); st.sel = new Set([`part:${pi.id}`]); });
  // multi-unit parts: next placement takes the next unit
  if (lp.units.length > 1) st.placing.unit = (st.placing.unit + 1) % lp.units.length;
}
let lastPower = 'VCC', lastAlias = 'NET1', lastPort = 'IN', lastOff = 'SIG';
async function placeAt(g: Pt) {
  const pg = page();
  switch (st.tool) {
    case 'alias': { const n = await ask('Net alias', lastAlias); if (!n) return; lastAlias = bumpName(n); const w = pg.wires.find((x) => x.pts.some((p, i) => i > 0 && onSeg(g, x.pts[i - 1], p))); edit(() => pg.aliases.push({ id: nid(st.d), at: g, name: n, ...(w ? { wire: w.id } : {}) })); break; }
    case 'power': { const n = await ask('Power net', lastPower); if (!n) return; lastPower = n; edit(() => pg.globals.push({ id: nid(st.d), at: g, net: n, style: 'power_bar' })); break; }
    case 'ground': { const n = await ask('Ground net', 'GND'); if (!n) return; edit(() => pg.globals.push({ id: nid(st.d), at: g, net: n, style: 'ground' })); break; }
    case 'port': { const n = await ask('Port: name [input|output|bidirectional|passive]', `${lastPort} input`); if (!n) return; const [name, dir] = n.split(/\s+/); lastPort = bumpName(name); edit(() => pg.ports.push({ id: nid(st.d), at: g, name, dir: (['input', 'output', 'bidirectional', 'passive'].includes(dir) ? dir : 'bidirectional') as 'input' })); break; }
    case 'offpage': { const n = await ask('Off-page connector', lastOff); if (!n) return; lastOff = bumpName(n); edit(() => pg.offPages.push({ id: nid(st.d), at: g, name: n })); break; }
    case 'nc': edit(() => pg.noConnects.push({ id: nid(st.d), at: g })); break;
    case 'junction': edit(() => pg.junctions.push({ id: nid(st.d), at: g })); break;
    case 'busentry': edit(() => pg.busEntries.push({ id: nid(st.d), at: g, dir: 'ne' })); break;
    case 'text': { const t = await ask('Text', ''); if (!t) return; edit(() => pg.texts.push({ id: nid(st.d), at: g, text: t, size: 60 })); break; }
  }
}
const onSeg = (p: Pt, a: Pt, b: Pt) => (a.x === b.x && p.x === a.x && p.y >= Math.min(a.y, b.y) && p.y <= Math.max(a.y, b.y)) || (a.y === b.y && p.y === a.y && p.x >= Math.min(a.x, b.x) && p.x <= Math.max(a.x, b.x));
const bumpName = (n: string) => n.replace(/(\d+)(?!.*\d)/, (m) => String(Number(m) + 1));

/* ---------------------------------------------------------------- selection edits */
function rotateSel() {
  if (st.tool === 'part' && st.placing) { st.placing.rot = ((st.placing.rot + 90) % 360) as 0; render(); return; }
  if (!st.sel.size) return;
  edit(() => {
    for (const k of st.sel) {
      const r = objOf(k); if (!r) continue; const o = r.o as Record<string, unknown>; const { kind } = parseKey(k);
      if (kind === 'part' || kind === 'global') o.rot = (((Number(o.rot) || 0) + 90) % 360);
      else if (kind === 'port' || kind === 'offpage') o.rot = Number(o.rot) === 180 ? 0 : 180;
      else if (kind === 'alias') o.rot = Number(o.rot) === 90 ? 0 : 90;
      else if (kind === 'text') o.rot = Number(o.rot) === 90 ? 0 : 90;
      else if (kind === 'busEntry') o.dir = ({ ne: 'nw', nw: 'sw', sw: 'se', se: 'ne' } as Record<string, string>)[String(o.dir)];
    }
  });
}
function mirrorSel() { if (st.tool === 'part' && st.placing) { st.placing.mirror = !st.placing.mirror; render(); return; } edit(() => { for (const k of st.sel) if (k.startsWith('part:')) { const o = objOf(k)!.o as unknown as PartInst; o.mirror = !o.mirror; } }); }
function deleteSel() { if (!st.sel.size) return; edit(() => { for (const k of st.sel) { const r = objOf(k); if (r) r.arr.splice(r.arr.indexOf(r.o), 1); } st.sel.clear(); }); }
function copySel() {
  const pg = page(); const out: Record<string, unknown[]> = {};
  for (const k of st.sel) { const { kind } = parseKey(k); const r = objOf(k); if (!r) continue; const a = ARR[kind] as string; (out[a] ??= []).push(r.o); }
  st.clip = JSON.stringify(out); void pg; log(`copied ${st.sel.size} object(s)`);
}
function pasteClip() {
  if (!st.clip) return; const data = JSON.parse(st.clip) as Record<string, ({ id: number } & Record<string, unknown>)[]>;
  // place the copy so its first point lands on the cursor
  let ref: Pt | null = null;
  for (const arr of Object.values(data)) for (const o of arr) { const p = ('pts' in o ? (o.pts as Pt[])[0] : 'at' in o ? (o.at as Pt) : 'x' in o ? { x: o.x as number, y: o.y as number } : null); if (p && !ref) ref = p; }
  const dx = ref ? st.cursor.x - ref.x : 200, dy = ref ? st.cursor.y - ref.y : 200;
  edit(() => {
    st.sel.clear(); const pg = page();
    for (const [a, arr] of Object.entries(data)) for (const o of arr) {
      o.id = nid(st.d); if (a === 'parts') (o as unknown as PartInst).ref = (o as unknown as PartInst).ref.replace(/\d+$/, '?'); if (a === 'parts') delete (o as Record<string, unknown>).occKey;
      (pg[a as keyof Page] as unknown as unknown[]).push(o);
      const kind = Object.entries(ARR).find(([, v]) => v === a)![0]; st.sel.add(`${kind}:${o.id}`); translate(`${kind}:${o.id}`, snap(dx), snap(dy));
    }
  });
}

/* ---------------------------------------------------------------- hierarchy */
function openPage(sch: string, idx: number) { st.sch = sch; st.page = idx; st.sel.clear(); fillTree(); fillTabs(); fitPage(); fillProps(); }
function descend(b: Page['blocks'][number]) {
  const s = schematicOf(st.d, b.schematic); if (!s) { log(`schematic ${b.schematic} does not exist`); return; }
  st.path.push({ sch: st.sch, page: st.page, ref: b.ref }); openPage(s.name, 0); log(`descended into ${b.ref} (${b.schematic})`);
}
function ascend() { const p = st.path.pop(); if (p) openPage(p.sch, p.page); else { const parent = allPages(st.d).find(({ page: pg }) => pg.blocks.some((b) => b.schematic === st.sch)); if (parent) openPage(parent.sch.name, parent.sch.pages.indexOf(parent.page)); } }
/** block pins from the ports of its schematic: inputs left, outputs right */
function syncBlockPins(b: Page['blocks'][number]) {
  const s = schematicOf(st.d, b.schematic); if (!s) return;
  const ports = new Map<string, Page['ports'][number]['dir']>(); for (const pg of s.pages) for (const p of pg.ports) if (!ports.has(p.name)) ports.set(p.name, p.dir);
  const keep = new Map(b.pins.map((p) => [p.name, p]));
  const left = [...ports].filter(([, d]) => d !== 'output'), right = [...ports].filter(([, d]) => d === 'output');
  b.h = Math.max(b.h, (Math.max(left.length, right.length) + 1) * 100);
  b.pins = [...left.map(([n, d], i) => keep.get(n) ?? { name: n, dir: d, side: 'left' as const, offset: (i + 1) * 100 }), ...right.map(([n, d], i) => keep.get(n) ?? { name: n, dir: d, side: 'right' as const, offset: (i + 1) * 100 })];
}

/* ---------------------------------------------------------------- panels */
function refreshAll() { st.nl = null; fillTree(); fillTabs(); fillLibrary(); fillProps(); fillNets(); fillVariants(); render(); }

function fillTree() {
  const el = $('tree'); el.innerHTML = '';
  for (const s of st.d.schematics) {
    const r = document.createElement('div'); r.className = 'row sch'; r.innerHTML = `<span>${s.name === st.d.root ? '★ ' : ''}${esc(s.name)}</span><small>${s.pages.length} p</small>`;
    r.title = 'Double-click: rename · right-click: make root'; r.ondblclick = () => renameSchematic(s.name); r.oncontextmenu = (e) => { e.preventDefault(); edit(() => { st.d.root = s.name; }); fillTree(); log(`root schematic: ${s.name}`); };
    el.appendChild(r);
    s.pages.forEach((p, i) => { const q = document.createElement('div'); q.className = 'row page' + (s.name === st.sch && i === st.page ? ' sel' : ''); const rv = team.reservations.find((r) => r.sch === s.name && r.page === p.name); q.innerHTML = `<span>${esc(p.name)}${rv ? ` <small>🔒 ${esc(rv.owner)}</small>` : ''}</span><small>${p.parts.length}</small>`; q.onclick = () => { st.path = []; openPage(s.name, i); }; q.ondblclick = () => renamePage(s.name, i); el.appendChild(q); });
  }
}
function fillTabs() { const el = $('tabs'); el.innerHTML = ''; const s = schematicOf(st.d, st.sch)!; s.pages.forEach((p, i) => { const t = document.createElement('div'); t.className = 'tab' + (i === st.page ? ' active' : ''); t.textContent = p.name; t.onclick = () => openPage(s.name, i); el.appendChild(t); }); }
async function renameSchematic(name: string) { const n = await ask('Rename schematic folder', name); if (!n || n === name) return; edit(() => { const s = schematicOf(st.d, name)!; s.name = n; if (st.d.root === name) st.d.root = n; for (const { page: pg } of allPages(st.d)) for (const b of pg.blocks) if (b.schematic === name) b.schematic = n; if (st.sch === name) st.sch = n; }); fillTree(); }
async function renamePage(sch: string, i: number) { const pg = schematicOf(st.d, sch)!.pages[i]; const n = await ask('Rename page', pg.name); if (!n) return; edit(() => { pg.name = n; }); fillTree(); fillTabs(); }

// library browser
function libParts(): { lib: string; lp: LibPart }[] { return st.d.libraries.flatMap((l) => Object.values(l.parts).map((lp) => ({ lib: l.name, lp }))); }
function fillLibrary() {
  const f = $<HTMLSelectElement>('lib-filter'); const cur = f.value;
  f.innerHTML = '<option value="">all libraries</option>' + st.d.libraries.map((l) => `<option ${l.name === cur ? 'selected' : ''}>${esc(l.name)}</option>`).join('');
  const q = $<HTMLInputElement>('lib-search').value.trim().toLowerCase();
  const el = $('lib-list'); el.innerHTML = '';
  let n = 0;
  for (const { lib, lp } of libParts()) {
    if (f.value && lib !== f.value) continue;
    if (q && !lp.name.toLowerCase().includes(q) && !(lp.props.Value ?? '').toLowerCase().includes(q) && !(lp.description ?? '').toLowerCase().includes(q)) continue;
    if (++n > 400) break;
    const r = document.createElement('div'); r.className = 'row' + (st.libSel?.lib === lib && st.libSel.part === lp.name ? ' sel' : '');
    r.innerHTML = `<span>${esc(lp.name)}</span><small>${esc(lib)}${lp.units.length > 1 ? ' ×' + lp.units.length : ''}</small>`;
    r.onclick = () => { st.libSel = { lib, part: lp.name }; fillLibrary(); };
    r.ondblclick = () => { st.libSel = { lib, part: lp.name }; st.placing = { lib, part: lp.name, unit: 0, rot: 0, mirror: false }; setTool('part'); };
    el.appendChild(r);
  }
  drawLibPreview();
}
function drawLibPreview() {
  const c = $<HTMLCanvasElement>('lib-preview'); const r = c.getBoundingClientRect(); c.width = Math.max(100, r.width); const g = c.getContext('2d')!;
  g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height);
  if (!st.libSel) { $('lib-info').textContent = 'double-click a part to place it'; return; }
  const lp = libPart(st.d, st.libSel.lib, st.libSel.part); if (!lp) return;
  const out: Prim[] = []; partPrims(st.d, { id: -1, lib: st.libSel.lib, part: lp.name, unit: 0, ref: `${lp.refPrefix}?`, x: 0, y: 0, rot: 0, props: {} }, out);
  const b = primBox(out); if (b) drawPrims(g, out, fitXf(b, c.width, c.height, 10));
  $('lib-info').textContent = `${lp.name} — ${lp.units.length} unit(s), ${lp.units[0].normal.pins.length} pins${lp.props['PCB Footprint'] ? ', ' + lp.props['PCB Footprint'] : ''}${lp.description ? ' — ' + lp.description : ''}`;
}

// properties
function fillProps() {
  const el = $('props'); el.innerHTML = '';
  const field = (label: string, value: string, set: (v: string) => void, opts?: string[]) => {
    const l = document.createElement('label'); l.textContent = label;
    let inp: HTMLInputElement | HTMLSelectElement;
    if (opts) { inp = document.createElement('select'); inp.innerHTML = opts.map((o) => `<option ${o === value ? 'selected' : ''}>${esc(o)}</option>`).join(''); }
    else { inp = document.createElement('input'); inp.value = value; }
    inp.onchange = () => edit(() => set(inp.value)); l.appendChild(inp); el.appendChild(l);
  };
  const btn = (label: string, f: () => void) => { const b = document.createElement('button'); b.textContent = label; b.onclick = f; el.appendChild(b); };
  if (st.sel.size !== 1) {
    const pg = page();
    if (st.sel.size > 1) { const d = document.createElement('div'); d.className = 'hint'; d.textContent = `${st.sel.size} objects selected`; el.appendChild(d); return; }
    const t = pg.title ?? (pg.title = {});
    field('Page name', pg.name, (v) => { pg.name = v; fillTree(); fillTabs(); });
    field('Size', pg.size, (v) => { pg.size = v as Page['size']; }, Object.keys(PAGE_SIZES));
    for (const k of ['Title', 'Document Number', 'Revision', 'Date', 'Company']) field(k, t[k] ?? '', (v) => { t[k] = v; });
    return;
  }
  const k = [...st.sel][0]; const { kind } = parseKey(k); const r = objOf(k); if (!r) return; const o = r.o as Record<string, unknown>;
  switch (kind) {
    case 'part': {
      const pi = o as unknown as PartInst; const lp = libPart(st.d, pi.lib, pi.part);
      field('Reference', pi.ref, (v) => { pi.ref = v; });
      field('Value', propOf(st.d, pi, 'Value') ?? '', (v) => { pi.props.Value = v; });
      field('PCB Footprint', propOf(st.d, pi, 'PCB Footprint') ?? '', (v) => { pi.props['PCB Footprint'] = v; });
      if (lp && lp.units.length > 1) field('Unit', unitLetter(pi.unit), (v) => { pi.unit = v.charCodeAt(0) - 65; }, lp.units.map((_, i) => unitLetter(i)));
      if (lp?.units.some((u) => u.convert)) field('View', pi.convert ? 'Convert' : 'Normal', (v) => { pi.convert = v === 'Convert'; }, ['Normal', 'Convert']);
      field('Do not place', pi.dnp ? 'yes' : 'no', (v) => { pi.dnp = v === 'yes'; }, ['no', 'yes']);
      const h = document.createElement('div'); h.className = 'hint'; h.textContent = `${pi.lib}:${pi.part}  ${pi.x},${pi.y} rot ${pi.rot}${pi.mirror ? ' mirrored' : ''}`; el.appendChild(h);
      // all properties
      const all = { ...(lp?.props ?? {}), ...pi.props };
      for (const [key, v] of Object.entries(all)) { if (key === 'Value' || key === 'PCB Footprint') continue; field(key, v, (nv) => { pi.props[key] = nv; }); }
      btn('Add property', async () => { const s = await ask('Property name=value', 'Tolerance=1%'); if (!s) return; const i = s.indexOf('='); edit(() => { pi.props[s.slice(0, i)] = s.slice(i + 1); }); });
      btn('Edit symbol', () => openSymbolEditor(pi.lib, pi.part));
      break;
    }
    case 'wire': case 'bus': {
      const name = netlist().pageNets.get(`${st.sch}/${page().name}`)?.get(`w${o.id}`);
      const d = document.createElement('div'); d.className = 'hint'; d.textContent = `${kind} ${o.id}: ${(o.pts as Pt[]).length} points${name ? ', net ' + name : ''}`; el.appendChild(d);
      if (name) btn('Highlight net', () => { st.highlight = name; render(); fillNets(); });
      break;
    }
    case 'alias': field('Name', String(o.name), (v) => { o.name = v; }); break;
    case 'global': field('Net', String(o.net), (v) => { o.net = v; }); field('Style', String(o.style), (v) => { o.style = v; }, ['power_bar', 'power_arrow', 'power_circle', 'ground', 'ground_signal', 'ground_earth', 'label']); break;
    case 'port': field('Name', String(o.name), (v) => { o.name = v; }); field('Direction', String(o.dir), (v) => { o.dir = v; }, ['input', 'output', 'bidirectional', 'passive']); break;
    case 'offpage': field('Name', String(o.name), (v) => { o.name = v; }); break;
    case 'text': field('Text', String(o.text), (v) => { o.text = v; }); field('Size', String(o.size ?? 60), (v) => { o.size = Number(v); }); break;
    case 'block': {
      const b = o as unknown as Page['blocks'][number];
      field('Reference', b.ref, (v) => { b.ref = v; });
      field('Schematic', b.schematic, (v) => { b.schematic = v; }, st.d.schematics.map((s) => s.name));
      btn('Sync pins from ports', () => edit(() => syncBlockPins(b)));
      btn('Descend', () => descend(b));
      break;
    }
  }
}

// nets
function fillNets() {
  const el = $('net-list'); el.innerHTML = '';
  const q = $<HTMLInputElement>('net-filter').value.trim().toLowerCase();
  let nl: Netlist; try { nl = netlist(); } catch (e) { el.textContent = (e as Error).message; return; }
  $('net-count').textContent = `${nl.nets.length}`;
  for (const n of nl.nets) {
    if (q && !n.name.toLowerCase().includes(q)) continue;
    const r = document.createElement('div'); r.className = 'row' + (n.name === st.highlight ? ' sel' : '');
    r.innerHTML = `<span>${esc(n.name)}</span><small>${n.nodes.length}</small>`;
    r.title = n.nodes.slice(0, 40).map((x) => `${x.ref}-${x.pin}`).join(' ');
    r.onclick = () => { st.highlight = st.highlight === n.name ? '' : n.name; if (st.highlight) xprobeSend({ type: 'net', name: n.name, from: 'sch' }); render(); fillNets(); };
    el.appendChild(r);
  }
}

// find
$('find').addEventListener('input', () => {
  const q = $<HTMLInputElement>('find').value.trim().toLowerCase(); const el = $('find-list'); el.innerHTML = ''; if (!q) return;
  const hits: { label: string; sch: string; page: number; key: string; at: Pt }[] = [];
  for (const s of st.d.schematics) s.pages.forEach((pg, i) => {
    for (const pi of pg.parts) if (pi.ref.toLowerCase().includes(q) || (propOf(st.d, pi, 'Value') ?? '').toLowerCase().includes(q)) hits.push({ label: `${pi.ref} ${propOf(st.d, pi, 'Value') ?? ''}`, sch: s.name, page: i, key: `part:${pi.id}`, at: pi });
    for (const a of pg.aliases) if (a.name.toLowerCase().includes(q)) hits.push({ label: `alias ${a.name}`, sch: s.name, page: i, key: `alias:${a.id}`, at: a.at });
    for (const p of pg.ports) if (p.name.toLowerCase().includes(q)) hits.push({ label: `port ${p.name}`, sch: s.name, page: i, key: `port:${p.id}`, at: p.at });
    for (const t of pg.texts) if (t.text.toLowerCase().includes(q)) hits.push({ label: `text ${t.text}`, sch: s.name, page: i, key: `text:${t.id}`, at: t.at });
  });
  for (const h of hits.slice(0, 200)) { const r = document.createElement('div'); r.className = 'row'; r.innerHTML = `<span>${esc(h.label)}</span><small>${esc(h.sch)}/${esc(schematicOf(st.d, h.sch)!.pages[h.page].name)}</small>`; r.onclick = () => { st.sch = h.sch; st.page = h.page; st.sel = new Set([h.key]); fillTree(); fillTabs(); centerOn(h.at); fillProps(); render(); }; el.appendChild(r); }
});

// ERC
function runErcUi() {
  st.erc = runErc(st.d); const el = $('erc-list'); el.innerHTML = '';
  for (const m of st.erc) {
    const r = document.createElement('div'); r.className = 'row ' + (m.severity === 'error' ? 'err' : 'warn'); r.innerHTML = `<span>${esc(m.message)}</span>`; r.title = m.kind;
    r.onclick = () => { if (m.page) { const [s, p] = m.page.split('/'); const sc = schematicOf(st.d, s); if (sc) { st.sch = s; st.page = Math.max(0, sc.pages.findIndex((x) => x.name === p)); fillTree(); fillTabs(); } } if (m.at) centerOn(m.at); render(); };
    el.appendChild(r);
  }
  log(`ERC: ${st.erc.filter((m) => m.severity === 'error').length} errors, ${st.erc.filter((m) => m.severity === 'warning').length} warnings`); render();
}
$('btn-erc').onclick = runErcUi;

/* ---------------------------------------------------------------- dialogs */
function ask(title: string, value: string): Promise<string | null> {
  const dlg = $<HTMLDialogElement>('dlg-prompt'); $('prompt-title').textContent = title; const inp = $<HTMLInputElement>('prompt-in'); inp.value = value;
  return new Promise((res) => { dlg.onclose = () => res(dlg.returnValue === 'ok' ? inp.value.trim() : null); dlg.returnValue = ''; dlg.showModal(); inp.select(); });
}
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
function download(name: string, data: string | Uint8Array, type = 'application/octet-stream') { const blob = new Blob([data as BlobPart], { type }); const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 4000); }
function pickFiles(accept: string, multiple: boolean): Promise<File[]> {
  const inp = $<HTMLInputElement>(multiple ? 'file-multi' : 'file-in'); inp.accept = accept; inp.value = '';
  return new Promise((res) => { inp.onchange = () => res([...(inp.files ?? [])]); inp.click(); });
}

/* ---------------------------------------------------------------- file operations */
function setDesign(d: Design, file: string) { st.d = normalizeDesign(d); st.file = file; st.undo = []; st.redo = []; st.path = []; st.sel.clear(); st.erc = []; st.highlight = ''; st.dirty = false; if (!st.d.libraries.some((l) => l.name === 'OpenSch')) st.d.libraries.push(basicLibrary()); st.sch = st.d.root; st.page = 0; refreshAll(); fitPage(); }
async function openDesign() {
  const [f] = await pickFiles('.json,.opensch', false); if (!f) return;
  try { setDesign(JSON.parse(await f.text()) as Design, f.name); log(`opened ${f.name}`); } catch (e) { log(`open failed: ${(e as Error).message}`); }
}
async function importDesign() {
  const files = await pickFiles('.kicad_sch,.dsn,.DSN,.schdoc,.SchDoc,.sdax', true); if (!files.length) return;
  const byName = new Map(files.map((f) => [f.name.toLowerCase(), f]));
  const main = files.find((f) => /\.dsn$/i.test(f.name)) ?? files.find((f) => /\.kicad_sch$/i.test(f.name) && !files.some((g) => g !== f && /\.kicad_sch$/i.test(g.name) && false)) ?? files[0];
  try {
    if (/[.]sdax$/i.test(main.name)) {
      const r = importSystemCapture(new Uint8Array(await main.arrayBuffer()), main.name.replace(/[.]sdax$/i, ''));
      setDesign(r.design, main.name.replace(/[.]sdax$/i, '.opensch.json')); r.notes.forEach((n) => log(`  ${n}`));
    } else if (/\.dsn$/i.test(main.name)) {
      // other selected .DSN files can resolve blocks implemented by other designs
      const bufs = new Map<string, Uint8Array>(); for (const f of files) bufs.set(f.name.toLowerCase().replace(/\.dsn$/, ''), new Uint8Array(await f.arrayBuffer()));
      const r = importOrcadDesign(bufs.get(main.name.toLowerCase().replace(/\.dsn$/, ''))!, main.name.replace(/\.dsn$/i, ''), { resolve: (impl) => bufs.get(impl.toLowerCase()) ?? null });
      setDesign(r.design, main.name.replace(/\.dsn$/i, '.opensch.json')); r.notes.slice(0, 40).forEach((n) => log(`  ${n}`));
    } else if (/\.kicad_sch$/i.test(main.name)) {
      // the root sheet is the one no other selected sheet refers to
      const texts = new Map<string, string>(); for (const f of files) texts.set(f.name.toLowerCase(), await f.text());
      const referenced = new Set<string>(); for (const t of texts.values()) for (const m of t.matchAll(/\(property "Sheet ?file" "([^"]+)"/g)) referenced.add(m[1].toLowerCase());
      const root = files.find((f) => /\.kicad_sch$/i.test(f.name) && !referenced.has(f.name.toLowerCase())) ?? main;
      const d = importKicadSchematic(texts.get(root.name.toLowerCase())!, { name: root.name.replace(/\.kicad_sch$/i, ''), readFile: (n) => texts.get(n.toLowerCase()) ?? texts.get(n.split(/[\\/]/).pop()!.toLowerCase()) ?? null });
      setDesign(d, root.name.replace(/\.kicad_sch$/i, '.opensch.json'));
      const missing = [...referenced].filter((n) => !texts.has(n)); if (missing.length) log(`select these sheets too to load them: ${missing.join(', ')}`);
    } else {
      const sch = files.filter((f) => /\.schdoc$/i.test(f.name)); const datas = await Promise.all(sch.map(async (f) => ({ data: new Uint8Array(await f.arrayBuffer()), name: f.name.replace(/\.schdoc$/i, '') })));
      const d = importAltiumSchematic(datas[0].data, datas[0].name, datas.slice(1)); setDesign(d, datas[0].name + '.opensch.json');
    }
    void byName;
    const nl = netlist(); log(`imported ${main.name}: ${st.d.schematics.length} schematics, ${nl.parts.length} parts, ${nl.nets.length} nets`);
  } catch (e) { log(`import failed: ${(e as Error).message}`); }
}
/** Design Entry HDL: pick the project folder (the .cpm, cds.lib, worklib and the libraries it defines) */
async function importDeHdlFolder() {
  const inp = document.createElement('input'); inp.type = 'file'; (inp as HTMLInputElement & { webkitdirectory: boolean }).webkitdirectory = true; inp.multiple = true;
  const files: File[] = await new Promise((res) => { inp.onchange = () => res([...(inp.files ?? [])]); inp.click(); });
  if (!files.length) return;
  const texts = new Map<string, string>();
  for (const f of files) { const rel = ((f as File & { webkitRelativePath?: string }).webkitRelativePath || f.name).split('\\').join('/'); if (/\.(cpm|lib|csa|css)$/i.test(rel)) texts.set(`/${rel}`.toLowerCase(), await f.text()); }
  const cpm = [...texts.keys()].find((k) => k.endsWith('.cpm') && !/\/cds\.cpm$/.test(k));
  if (!cpm) { log('no .cpm project file in that folder'); return; }
  const norm = (p: string) => { const out: string[] = []; for (const seg of p.toLowerCase().split('/')) { if (seg === '..') out.pop(); else if (seg && seg !== '.') out.push(seg); } return '/' + out.join('/'); };
  const fsx = { read: (p: string) => texts.get(norm(p)) ?? null, list: (dir: string) => { const d = norm(dir) + '/'; return [...new Set([...texts.keys()].filter((k) => k.startsWith(d)).map((k) => k.slice(d.length).split('/')[0]))]; } };
  try { const r = importDeHdl(cpm, fsx); setDesign(r.design, `${r.design.name}.opensch.json`); r.notes.slice(0, 30).forEach((n) => log(`  ${n}`)); log(`imported Design Entry HDL project ${r.design.name}`); }
  catch (e) { log(`Design Entry HDL import failed: ${(e as Error).message}`); }
}
async function importLibrary() {
  const files = await pickFiles('.kicad_sym,.olb,.OLB', true);
  for (const f of files) {
    try {
      let lib: Library;
      if (/\.olb$/i.test(f.name)) { const r = importOrcadLibrary(new Uint8Array(await f.arrayBuffer()), f.name.replace(/\.olb$/i, '')); lib = r.library; r.notes.forEach((n) => log(`  ${n}`)); }
      else lib = importKicadSymbolLibrary(await f.text(), f.name.replace(/\.kicad_sym$/i, ''));
      edit(() => { st.d.libraries = st.d.libraries.filter((l) => l.name !== lib.name); st.d.libraries.push(lib); });
      log(`library ${lib.name}: ${Object.keys(lib.parts).length} parts`); fillLibrary();
    } catch (e) { log(`${f.name}: ${(e as Error).message}`); }
  }
}
function saveDesign() { download(st.file.endsWith('.json') ? st.file : st.file + '.opensch.json', JSON.stringify(st.d, null, 1), 'application/json'); st.dirty = false; render(); }

/* ---------------------------------------------------------------- tools menu actions */
function doAnnotate(reset: boolean) { edit(() => { const r = annotate(st.d, { reset }); log(`annotate: ${r.changed.length} designators assigned`); }); }
function exportNetlist(fmt: string) {
  const name = st.d.name.replace(/\s+/g, '_');
  if (fmt === 'kicad') download(`${name}.net`, kicadNetlist(st.d, netlist()));
  else if (fmt === 'telesis') download(`${name}.tel`, telesisNetlist(st.d, netlist()));
  else if (fmt === 'edif') download(`${name}.edn`, edifNetlist(st.d, netlist()));
  else if (fmt === 'spice') { const r = spiceNetlist(st.d, {}, netlist()); download(`${name}.cir`, r.text); if (r.skipped.length) log(`SPICE: no model for ${r.skipped.join(', ')}`); }
  log(`netlist (${fmt}) written`);
}
function forwardToBoard() {
  try {
    const r = toBoard(st.d, undefined, { variant: st.variant || undefined });
    const j = JSON.stringify(r.project);
    download(`${st.d.name.replace(/\s+/g, '_')}.openboard.json`, j, 'application/json');
    xprobeSend({ type: 'board', project: r.project, from: 'sch' });
    log(`board: ${r.project.components.length} components, ${r.project.nets.length} nets; ${r.report.placeholders.length} placeholder footprints (sent to OpenBoard if it is open)`);
  } catch (e) { log(`create netlist failed: ${(e as Error).message}`); }
}
async function backAnnotateFromBoard() {
  const [f] = await pickFiles('.json', false); if (!f) return;
  const board = JSON.parse(await f.text()) as { components: { ref: string; value?: string; footprint: string }[] };
  const values: Record<string, string> = {}, footprints: Record<string, string> = {};
  const parts = new Map(netlist().parts.map((p) => [p.ref, p]));
  for (const c of board.components) { const p = parts.get(c.ref); if (!p) continue; if (c.value && c.value !== p.value) values[c.ref] = c.value; if (c.footprint && c.footprint !== p.footprint) footprints[c.ref] = c.footprint; }
  const sw = await ask('Reference renames from the board (was:is, comma separated; empty = none)', '');
  const renames = (sw ?? '').split(',').map((x) => x.trim()).filter(Boolean).map((x) => { const [was, is] = x.split(':'); return { was, is }; });
  edit(() => { const r = backAnnotate(st.d, { renames, values, footprints }); log(`back annotation: ${r.renamed} renamed, ${r.values} values, ${r.footprints} footprints${r.unknown.length ? '; unknown ' + r.unknown.join(' ') : ''}`); });
}

/* ---------------------------------------------------------------- variants */
function fillVariants() { const s = $<HTMLSelectElement>('sel-variant'); s.innerHTML = '<option value="">(no variant)</option>' + st.d.variants.map((v) => `<option ${v.name === st.variant ? 'selected' : ''}>${esc(v.name)}</option>`).join(''); }
$<HTMLSelectElement>('sel-variant').onchange = (e) => { st.variant = (e.target as HTMLSelectElement).value; st.nl = null; render(); fillNets(); log(`variant: ${st.variant || 'none'}`); };
function editVariants() {
  const dlg = $<HTMLDialogElement>('dlg-variants'); const ta = $<HTMLTextAreaElement>('var-text');
  ta.value = st.d.variants.map((v) => `${v.name}: ${v.dnp.join(' ')}${v.values && Object.keys(v.values).length ? ' ; ' + Object.entries(v.values).map(([a, b]) => `${a}=${b}`).join(' ') : ''}`).join('\n');
  dlg.onclose = () => { if (dlg.returnValue !== 'ok') return; edit(() => { st.d.variants = ta.value.split('\n').map((l) => l.trim()).filter(Boolean).map((l) => { const [name, rest = ''] = l.split(':'); const [dnp = '', vals = ''] = rest.split(';'); return { name: name.trim(), dnp: dnp.trim().split(/\s+/).filter(Boolean), values: Object.fromEntries(vals.trim().split(/\s+/).filter((x) => x.includes('=')).map((x) => x.split('='))) }; }); }); fillVariants(); };
  dlg.returnValue = ''; dlg.showModal();
}
function toggleDnpInVariant() {
  if (!st.variant) { log('choose a variant first (Tools > Variants)'); return; }
  const v = st.d.variants.find((x) => x.name === st.variant)!;
  edit(() => { for (const k of st.sel) if (k.startsWith('part:')) { const pi = objOf(k)!.o as unknown as PartInst; const i = v.dnp.indexOf(pi.ref); if (i >= 0) v.dnp.splice(i, 1); else v.dnp.push(pi.ref); } });
}

/* ---------------------------------------------------------------- simulation */
function simDialog() {
  const dlg = $<HTMLDialogElement>('dlg-sim');
  dlg.onclose = () => {
    if (dlg.returnValue !== 'ok') return;
    const kind = $<HTMLSelectElement>('sim-kind').value; const v = (id: string) => $<HTMLInputElement>(id).value.trim();
    const probes = v('sim-probes').split(/[\s,]+/).filter(Boolean);
    const num = (s: string) => { const m = /^([-+]?[\d.]+(?:e[-+]?\d+)?)\s*(meg|[fpnumkgt])?/i.exec(s); if (!m) return Number(s); const k: Record<string, number> = { f: 1e-15, p: 1e-12, n: 1e-9, u: 1e-6, m: 1e-3, k: 1e3, meg: 1e6, g: 1e9, t: 1e12 }; return Number(m[1]) * (m[2] ? k[m[2].toLowerCase()] : 1); };
    try {
      const r = simulate(st.d, { op: kind === 'op' || undefined, tran: kind === 'tran' ? { step: num(v('sim-tstep')), stop: num(v('sim-tstop')) } : undefined, ac: kind === 'ac' ? { fStart: num(v('sim-f1')), fStop: num(v('sim-f2')), points: Number(v('sim-np')) || 20 } : undefined, probes: probes.length ? probes : undefined });
      st.sim = r; showPane('sim'); plotSim();
      if (r.skipped.length) log(`simulation: no SPICE model for ${r.skipped.join(', ')}`);
      log(`simulation done: ${r.nodes.length} nodes`);
    } catch (e) { log(`simulation failed: ${(e as Error).message}`); }
  };
  dlg.returnValue = ''; dlg.showModal();
}
function plotSim() {
  const c = $<HTMLCanvasElement>('plot'); const r = c.getBoundingClientRect(); c.width = Math.max(200, r.width); c.height = Math.max(80, r.height); const g = c.getContext('2d')!;
  g.fillStyle = '#0b0e11'; g.fillRect(0, 0, c.width, c.height);
  const sim = st.sim; if (!sim) return;
  const op = $('sim-op'); op.textContent = sim.op ? Object.entries(sim.op).map(([k, v]) => `${k} = ${v.toPrecision(5)}`).join('\n') : '';
  let xs: number[] = [], series: [string, number[]][] = [], logx = false, unit = 'V';
  if (sim.tran) { xs = sim.tran.t; series = Object.entries(sim.tran.v); }
  else if (sim.ac) { xs = sim.ac.f; series = Object.entries(sim.ac.mag).map(([k, v]) => [k, v.map((m) => 20 * Math.log10(Math.max(1e-30, m)))]); logx = true; unit = 'dB'; }
  if (!xs.length || !series.length) return;
  const L = 52, R = 10, T = 10, B = 22, W = c.width - L - R, H = c.height - T - B;
  const fx = (x: number) => L + ((logx ? Math.log10(x) - Math.log10(xs[0]) : x - xs[0]) / ((logx ? Math.log10(xs[xs.length - 1]) - Math.log10(xs[0]) : xs[xs.length - 1] - xs[0]) || 1)) * W;
  let lo = Infinity, hi = -Infinity; for (const [, v] of series) for (const y of v) if (Number.isFinite(y)) { lo = Math.min(lo, y); hi = Math.max(hi, y); }
  if (hi - lo < 1e-12) { hi += 1; lo -= 1; }
  const fy = (y: number) => T + (1 - (y - lo) / (hi - lo)) * H;
  g.strokeStyle = '#30363d'; g.fillStyle = '#8b949e'; g.font = '11px ui-monospace, monospace'; g.lineWidth = 1;
  for (let i = 0; i <= 4; i++) { const y = lo + ((hi - lo) * i) / 4; g.beginPath(); g.moveTo(L, fy(y)); g.lineTo(L + W, fy(y)); g.stroke(); g.fillText(y.toPrecision(3), 2, fy(y) + 4); }
  g.fillText(`${logx ? 'f (Hz, log)' : 't (s)'}  ${xs[0].toPrecision(3)} … ${xs[xs.length - 1].toPrecision(3)}   ${unit}`, L, c.height - 6);
  const pal = ['#60a5fa', '#f472b6', '#34d399', '#fbbf24', '#a78bfa', '#f87171', '#22d3ee', '#a3e635'];
  series.slice(0, 8).forEach(([name, v], k) => { g.strokeStyle = pal[k]; g.lineWidth = 1.5; g.beginPath(); v.forEach((y, i) => (i ? g.lineTo(fx(xs[i]), fy(y)) : g.moveTo(fx(xs[i]), fy(y)))); g.stroke(); g.fillStyle = pal[k]; g.fillText(name, L + W - 120, T + 12 + k * 13); });
}

/* ---------------------------------------------------------------- symbol editor */
let symEdit: { lib: string; part: string; unit: number; lp: LibPart } | null = null;
function openSymbolEditor(lib?: string, part?: string) {
  const dlg = $<HTMLDialogElement>('dlg-symedit');
  let lp = lib && part ? libPart(st.d, lib, part) : undefined;
  const libName = lp ? lib! : 'design';
  if (!lp) lp = { name: 'NEWPART', refPrefix: 'U', units: [{ normal: { graphics: [{ kind: 'rect', x1: 0, y1: 0, x2: 600, y2: 500 }], pins: [] } }], props: { Value: 'NEWPART' } };
  symEdit = { lib: libName, part: lp.name, unit: 0, lp: JSON.parse(JSON.stringify(lp)) };
  $<HTMLSelectElement>('sym-lib').innerHTML = [...new Set([libName, 'design', ...st.d.libraries.map((l) => l.name)])].map((n) => `<option ${n === libName ? 'selected' : ''}>${esc(n)}</option>`).join('');
  $<HTMLInputElement>('sym-name').value = lp.name; $<HTMLInputElement>('sym-ref').value = lp.refPrefix;
  $<HTMLTextAreaElement>('sym-props').value = Object.entries(lp.props).map(([a, b]) => `${a}=${b}`).join('\n');
  $<HTMLInputElement>('sym-spice').value = lp.spice ?? '';
  $('sym-title').textContent = lib ? `${lib}:${part}` : 'new part';
  fillSymUnits(); loadSymUnit();
  dlg.onclose = () => { if (dlg.returnValue === 'ok') saveSymbol(); };
  dlg.returnValue = ''; dlg.showModal();
}
function fillSymUnits() { const se = symEdit!; $<HTMLSelectElement>('sym-unit').innerHTML = se.lp.units.map((_, i) => `<option value="${i}" ${i === se.unit ? 'selected' : ''}>${unitLetter(i)}</option>`).join(''); }
function loadSymUnit() { const se = symEdit!; const v = se.lp.units[se.unit].normal; $<HTMLTextAreaElement>('sym-pins').value = pinsToText(v.pins); $<HTMLTextAreaElement>('sym-gfx').value = gfxToText(v.graphics); drawSymPreview(); }
function storeSymUnit(): boolean {
  const se = symEdit!;
  try { const v = se.lp.units[se.unit].normal; v.pins = textToPins($<HTMLTextAreaElement>('sym-pins').value); v.graphics = textToGfx($<HTMLTextAreaElement>('sym-gfx').value); return true; } catch (e) { log(`symbol editor: ${(e as Error).message}`); return false; }
}
function drawSymPreview() {
  if (!symEdit || !storeSymUnit()) return;
  const c = $<HTMLCanvasElement>('sym-preview'); const g = c.getContext('2d')!; g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height);
  const tmp: Design = { ...st.d, libraries: [{ name: '__sym', parts: { [symEdit.lp.name]: symEdit.lp } }] };
  const out: Prim[] = []; partPrims(tmp, { id: -1, lib: '__sym', part: symEdit.lp.name, unit: symEdit.unit, ref: `${symEdit.lp.refPrefix}?`, x: 0, y: 0, rot: 0, props: {} }, out);
  const b = primBox(out); if (b) drawPrims(g, out, fitXf(b, c.width, c.height, 20));
}
['sym-pins', 'sym-gfx'].forEach((id) => $(id).addEventListener('input', drawSymPreview));
$('sym-unit').addEventListener('change', () => { storeSymUnit(); symEdit!.unit = Number($<HTMLSelectElement>('sym-unit').value); loadSymUnit(); });
$('sym-add-unit').onclick = () => { storeSymUnit(); const se = symEdit!; se.lp.units.push(JSON.parse(JSON.stringify(se.lp.units[se.unit]))); se.unit = se.lp.units.length - 1; fillSymUnits(); loadSymUnit(); };
$('sym-gen').onclick = () => {
  const lines = $<HTMLTextAreaElement>('sym-pins').value.split('\n').filter((l) => l.trim()).map((l) => l.trim().split(/\s+/));
  // accepts either the full pin form (number name type ...) or the short `number name type side`
  const v = generateBox(lines.map((f) => `${f[0]} ${f[1] ?? f[0]} ${f[2] ?? 'passive'} ${['left', 'right', 'top', 'bottom'].includes(f[3]) ? f[3] : ''}`).join('\n'));
  $<HTMLTextAreaElement>('sym-pins').value = pinsToText(v.pins); $<HTMLTextAreaElement>('sym-gfx').value = gfxToText(v.graphics); drawSymPreview();
};
function saveSymbol() {
  const se = symEdit!; if (!storeSymUnit()) return;
  const lp = se.lp; lp.name = $<HTMLInputElement>('sym-name').value.trim() || lp.name; lp.refPrefix = $<HTMLInputElement>('sym-ref').value.trim() || 'U';
  lp.props = Object.fromEntries($<HTMLTextAreaElement>('sym-props').value.split('\n').map((l) => l.trim()).filter((l) => l.includes('=')).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
  const sp = $<HTMLInputElement>('sym-spice').value.trim(); if (sp) lp.spice = sp; else delete lp.spice;
  const libName = $<HTMLSelectElement>('sym-lib').value;
  edit(() => { let l = st.d.libraries.find((x) => x.name === libName); if (!l) { l = { name: libName, parts: {} }; st.d.libraries.push(l); } l.parts[lp.name] = lp; });
  log(`saved ${libName}:${lp.name} (${lp.units.length} unit(s), ${lp.units[0].normal.pins.length} pins)`); fillLibrary();
}
$('btn-symedit').onclick = () => openSymbolEditor(st.libSel?.lib, st.libSel?.part);

/* ---------------------------------------------------------------- SKILL console */
const skill = schSkill(st.d, { print: (s) => conOut(s), changed: () => changed(), page: () => ({ sch: st.sch, page: page().name }) });
function conOut(s: string) { const el = $('con-out'); el.textContent += s + '\n'; el.scrollTop = el.scrollHeight; }
$<HTMLInputElement>('con-in').addEventListener('keydown', (e) => {
  if (e.key !== 'Enter') return; const inp = e.target as HTMLInputElement; const src = inp.value; inp.value = '';
  conOut(`> ${src}`);
  try { const sk = schSkill(st.d, { print: (s) => conOut(s), changed: () => { snapshotOnce(); changed(); }, page: () => ({ sch: st.sch, page: page().name }) }); for (const [k, v] of skill.global.vars) if (!sk.global.vars.has(k)) sk.global.def(k, v); const v = sk.run(src); for (const [k, val] of sk.global.vars) skill.global.def(k, val); conOut(show(v)); } catch (err) { conOut(`*Error* ${(err as Error).message}`); }
  snapped = false;
});
let snapped = false; function snapshotOnce() { if (!snapped) { snapshot(); snapped = true; } }

/* ---------------------------------------------------------------- bottom panes */
function showPane(p: string) { document.querySelectorAll('#bottom-tabs button').forEach((b) => b.classList.toggle('active', (b as HTMLElement).dataset.pane === p)); document.querySelectorAll('.pane').forEach((x) => x.classList.toggle('active', x.id === `pane-${p}`)); if (p === 'sim') plotSim(); }
document.querySelectorAll<HTMLButtonElement>('#bottom-tabs button').forEach((b) => (b.onclick = () => showPane(b.dataset.pane!)));

/* ---------------------------------------------------------------- more design tools */
function textDialog(title: string, hint: string, body: string): Promise<string | null> {
  const dlg = $<HTMLDialogElement>('dlg-text'); $('text-title').textContent = title; $('text-hint').innerHTML = hint; const ta = $<HTMLTextAreaElement>('text-body'); ta.value = body;
  return new Promise((res) => { dlg.onclose = () => res(dlg.returnValue === 'ok' ? ta.value : null); dlg.returnValue = ''; dlg.showModal(); });
}
async function constraintManager() {
  const t = await textDialog('Constraint manager', 'One rule per line (mm): <code>class NAME width=0.15 clearance=0.2 diffGap=0.16 layers=F.Cu,In2</code> · <code>net NAME class=HS width=0.2 minLength=10 maxLength=50 current=1 impedance=50 diffPair=USB matchGroup=DDR</code> · <code>pair NAME gap tolerance maxUncoupled maxSkew</code> · <code>group NAME tolerance</code>. Forward annotation (Tools &gt; Create netlist) carries them to OpenBoard.', constraintsToText(st.d.constraints));
  if (t === null) return;
  try { const c = textToConstraints(t); edit(() => { st.d.constraints = c; }); log(`constraints: ${c.classes.length} classes, ${Object.keys(c.nets).length} nets, ${c.pairs.length} pairs, ${c.groups.length} groups`); } catch (e) { log(`constraints: ${(e as Error).message}`); }
}
async function netClassOfHighlight() {
  if (!st.highlight) { log('highlight a net first (Nets list or Ctrl+click)'); return; }
  const cur = st.d.constraints?.nets[st.highlight];
  const s = await ask(`Net ${st.highlight}: key=value … (class width clearance minLength maxLength current impedance diffPair matchGroup)`, cur ? Object.entries(cur).map(([a, b]) => `${a}=${b}`).join(' ') : 'class=');
  if (s === null) return;
  try { const all = textToConstraints(`${constraintsToText(st.d.constraints)}\nnet ${st.highlight} ${s}`); edit(() => { st.d.constraints = all; }); } catch (e) { log((e as Error).message); }
}
function propertySheet() {
  const dlg = $<HTMLDialogElement>('dlg-sheet'); const table = $<HTMLTableElement>('sheet');
  const rows = allPages(st.d).flatMap(({ sch, page: pg }) => pg.parts.filter((pi) => { const lp = libPart(st.d, pi.lib, pi.part); return !lp?.kind || lp.kind === 'part'; }).map((pi) => ({ pi, where: `${sch.name}/${pg.name}` })));
  const cols = new Set<string>(['Value', 'PCB Footprint']);
  for (const { pi } of rows) { for (const k of Object.keys(pi.props)) cols.add(k); for (const k of Object.keys(libPart(st.d, pi.lib, pi.part)?.props ?? {})) cols.add(k); }
  const colList = [...cols];
  const draw = () => {
    const q = $<HTMLInputElement>('sheet-filter').value.toLowerCase();
    table.innerHTML = `<tr><th>Reference</th><th>Part</th><th>Page</th>${colList.map((c) => `<th>${esc(c)}</th>`).join('')}</tr>` + rows.filter((r) => !q || `${r.pi.ref} ${r.pi.part} ${Object.values(r.pi.props).join(' ')}`.toLowerCase().includes(q)).map((r, i) => `<tr data-i="${rows.indexOf(r)}"><td contenteditable data-k="__ref">${esc(r.pi.ref)}</td><td>${esc(r.pi.part)}</td><td>${esc(r.where)}</td>${colList.map((c) => `<td contenteditable data-k="${esc(c)}">${esc(propOf(st.d, r.pi, c) ?? '')}</td>`).join('')}</tr>`).join('');
    table.querySelectorAll<HTMLTableCellElement>('td[contenteditable]').forEach((td) => (td.oninput = () => td.classList.add('changed'))); void 0;
  };
  $('sheet-filter').oninput = draw;
  $('sheet-addcol').onclick = async () => { const n = await ask('New property column', 'Manufacturer'); if (n && !colList.includes(n)) { colList.push(n); draw(); } };
  draw();
  dlg.onclose = () => {
    if (dlg.returnValue !== 'ok') return;
    const edits: { pi: PartInst; k: string; v: string }[] = [];
    table.querySelectorAll<HTMLTableCellElement>('td.changed').forEach((td) => { const i = Number(td.parentElement!.dataset.i); edits.push({ pi: rows[i].pi, k: td.dataset.k!, v: td.textContent!.trim() }); });
    if (!edits.length) return;
    edit(() => { for (const e of edits) { if (e.k === '__ref') e.pi.ref = e.v; else e.pi.props[e.k] = e.v; } });
    log(`property editor: ${edits.length} cell(s) changed`);
  };
  dlg.returnValue = ''; dlg.showModal();
}
async function compareWithFile() {
  const [f] = await pickFiles('.json', false); if (!f) return;
  try { const other = normalizeDesign(JSON.parse(await f.text()) as Design); const r = compareDesigns(other, st.d); log(`design differences (${f.name} -> this design):`); for (const l of r.text.split('\n')) log(`  ${l}`); } catch (e) { log(`compare: ${(e as Error).message}`); }
}
async function partDatabase() {
  const [f] = await pickFiles('.csv', false); if (!f) return;
  const rows = parseCsv(await f.text()); if (!rows.length) { log('part database: no rows'); return; }
  const m = await ask(`Match columns (${Object.keys(rows[0]).join(', ')})`, 'Value'); if (!m) return;
  const onlySel = [...st.sel].filter((k) => k.startsWith('part:')).map((k) => objOf(k)!.o as unknown as PartInst);
  edit(() => { const r = linkPartDatabase(st.d, rows, { match: m.split(',').map((x) => x.trim()), only: onlySel.length ? new Set(onlySel) : undefined }); log(`part database ${f.name}: ${r.linked.length} parts linked${r.unmatched.length ? `; no row for ${r.unmatched.join(' ')}` : ''}`); });
}
async function findReplace() {
  const s = await ask('Replace (find => replace) in properties, net names and texts', 'old => new'); if (!s || !s.includes('=>')) return;
  const [a, b] = s.split('=>').map((x) => x.trim()); if (!a) return;
  edit(() => { log(`replaced ${replaceInDesign(st.d, a, b)} value(s)`); });
}
async function ercMatrix() {
  const TYPES: PinType[] = ['input', 'output', 'bidirectional', 'tristate', 'passive', 'power', 'open_collector', 'open_emitter', 'unspecified'];
  const cur = st.d.erc ?? {};
  const lines = Object.entries(cur).flatMap(([a, row]) => Object.entries(row ?? {}).map(([b, v]) => `${a} ${b} ${v}`));
  const t = await textDialog('ERC matrix overrides', `One pin-type pair per line: <code>output output error</code> (ok | warning | error). Types: ${TYPES.join(', ')}. Empty = the default Capture matrix.`, lines.join('\n'));
  if (t === null) return;
  const m: NonNullable<Design['erc']> = {};
  for (const l of t.split('\n').map((x) => x.trim()).filter(Boolean)) { const [a, b, v] = l.split(/\s+/) as [PinType, PinType, 'ok' | 'warning' | 'error']; if (!TYPES.includes(a) || !TYPES.includes(b) || !['ok', 'warning', 'error'].includes(v)) { log(`ERC matrix: bad line "${l}"`); return; } (m[a] ??= {})[b] = v; (m[b] ??= {})[a] = v; }
  edit(() => { st.d.erc = m; }); log('ERC matrix updated');
}
async function teamConnect() {
  const s = await ask('Team design server and your name (start one with: openpcb sch-collab-serve design.opensch.json)', `ws://localhost:7778 ${localStorage.getItem('opensch.user') ?? 'designer'}`);
  if (!s) return; const [url, ...name] = s.split(/\s+/); const user = name.join(' ') || 'designer';
  try { localStorage.setItem('opensch.user', user); } catch { /* ignore */ }
  team.connect(url, user);
}

/* ---------------------------------------------------------------- tools / keys */
function setTool(t: Tool) {
  if (st.pts.length) finishPath();
  st.tool = t; document.querySelectorAll<HTMLButtonElement>('button.tool').forEach((b) => b.classList.toggle('active', b.dataset.tool === t));
  if (t === 'part' && !st.placing && st.libSel) st.placing = { lib: st.libSel.lib, part: st.libSel.part, unit: 0, rot: 0, mirror: false };
  render();
}
document.querySelectorAll<HTMLButtonElement>('button.tool').forEach((b) => (b.onclick = () => setTool(b.dataset.tool as Tool)));
window.addEventListener('keydown', (e) => {
  if ((e.target as HTMLElement).closest('input, textarea, select, dialog')) return;
  const k = e.key.toLowerCase();
  if (e.ctrlKey) {
    if (k === 'z') { e.preventDefault(); undo(); } else if (k === 'y') { e.preventDefault(); redo(); } else if (k === 's') { e.preventDefault(); saveDesign(); }
    else if (k === 'c') copySel(); else if (k === 'v') pasteClip(); else if (k === 'x') { copySel(); deleteSel(); }
    else if (k === 'a') { e.preventDefault(); st.sel = new Set(prims.filter((p) => p.obj && p.obj !== 'border' && p.obj !== 'title').map((p) => p.obj!)); render(); fillProps(); }
    else if (k === 'u') ascend(); else if (k === 'f') { e.preventDefault(); $('find').focus(); }
    return;
  }
  const map: Record<string, Tool> = { p: 'part', w: 'wire', b: 'bus', e: 'busentry', n: 'alias', v: 'power', g: 'ground', h: 'port', o: 'offpage', q: 'nc', j: 'junction', k: 'block', t: 'text', l: 'line' };
  if (k === 'escape') { if (st.pts.length) { st.pts = []; render(); } else { setTool('select'); st.sel.clear(); fillProps(); render(); } }
  else if (k === 'r') rotateSel(); else if (k === 'x') mirrorSel(); else if (k === 'delete' || k === 'backspace') deleteSel();
  else if (k === '/' || k === ' ') { st.hv = !st.hv; render(); }
  else if (k === 'f') fitPage(); else if (k === 'enter') finishPath();
  else if (k === 'pageup') { if (st.page > 0) openPage(st.sch, st.page - 1); } else if (k === 'pagedown') { if (st.page < schematicOf(st.d, st.sch)!.pages.length - 1) openPage(st.sch, st.page + 1); }
  else if (map[k]) setTool(map[k]);
});
$('btn-up').onclick = ascend;
$('lib-search').addEventListener('input', fillLibrary); $('lib-filter').addEventListener('change', fillLibrary); $('net-filter').addEventListener('input', fillNets);
$('btn-add-sch').onclick = async () => { const n = await ask('New schematic folder', `SCHEMATIC${st.d.schematics.length + 1}`); if (!n) return; edit(() => st.d.schematics.push({ name: n, pages: [newPage('PAGE1')] })); fillTree(); };
$('btn-add-page').onclick = async () => { const s = schematicOf(st.d, st.sch)!; const n = await ask('New page', `PAGE${s.pages.length + 1}`); if (!n) return; edit(() => s.pages.push(newPage(n, page().size))); openPage(s.name, s.pages.length - 1); };

/* ---------------------------------------------------------------- menus */
type Item = [string, () => void, string?] | '-';
const MENUS: Record<string, Item[]> = {
  File: [
    ['New design', () => setDesign(newDesign('untitled'), 'untitled.opensch.json')], ['Open…', openDesign, 'Ctrl+O'], ['Save', saveDesign, 'Ctrl+S'], '-',
    ['Import design (OrCAD .DSN / System Capture .sdax / KiCad / Altium .SchDoc)…', importDesign], ['Import Design Entry HDL project (folder)…', importDeHdlFolder], ['Import library (.kicad_sym / .OLB)…', importLibrary], '-',
    ['Export PDF (all pages)', () => download(`${st.d.name}.pdf`, designPdf(st.d), 'application/pdf')],
    ['Export SVG (this page)', () => download(`${st.d.name}_${page().name}.svg`, pageSvg(st.d, st.sch, page().name), 'image/svg+xml')],
    ['Export netlist: KiCad', () => exportNetlist('kicad')], ['Export netlist: Telesis (Allegro)', () => exportNetlist('telesis')], ['Export netlist: EDIF 2 0 0', () => exportNetlist('edif')], ['Export netlist: SPICE', () => exportNetlist('spice')],
    ['Bill of materials (CSV)', () => download(`${st.d.name}_bom.csv`, bom(st.d, { variant: st.variant || undefined }).csv, 'text/csv')],
    ['Cross reference', () => download(`${st.d.name}_xref.txt`, crossReference(st.d))],
  ],
  Edit: [['Undo', undo, 'Ctrl+Z'], ['Redo', redo, 'Ctrl+Y'], '-', ['Copy', copySel, 'Ctrl+C'], ['Paste', pasteClip, 'Ctrl+V'], ['Delete', deleteSel, 'Del'], ['Select all', () => { st.sel = new Set(prims.filter((p) => p.obj && p.obj !== 'border' && p.obj !== 'title').map((p) => p.obj!)); render(); }, 'Ctrl+A'], '-', ['Rotate', rotateSel, 'R'], ['Mirror', mirrorSel, 'X'], '-', ['Find…', () => $('find').focus(), 'Ctrl+F']],
  Place: [['Part', () => setTool('part'), 'P'], ['Wire', () => setTool('wire'), 'W'], ['Bus', () => setTool('bus'), 'B'], ['Bus entry', () => setTool('busentry'), 'E'], ['Net alias', () => setTool('alias'), 'N'], ['Power', () => setTool('power'), 'V'], ['Ground', () => setTool('ground'), 'G'], ['Hierarchical port', () => setTool('port'), 'H'], ['Hierarchical block', () => setTool('block'), 'K'], ['Off-page connector', () => setTool('offpage'), 'O'], ['No connect', () => setTool('nc'), 'Q'], ['Junction', () => setTool('junction'), 'J'], ['Text', () => setTool('text'), 'T'], ['Line', () => setTool('line'), 'L'], ['Rectangle', () => setTool('rect')]],
  View: [['Fit page', fitPage, 'F'], ['Zoom in', () => zoomAt(canvas.width / 2, canvas.height / 2, 1.25)], ['Zoom out', () => zoomAt(canvas.width / 2, canvas.height / 2, 0.8)], '-', ['Up the hierarchy', ascend, 'Ctrl+U'], ['Previous page', () => st.page > 0 && openPage(st.sch, st.page - 1), 'PgUp'], ['Next page', () => openPage(st.sch, Math.min(st.page + 1, schematicOf(st.d, st.sch)!.pages.length - 1)), 'PgDn'], '-', ['Clear net highlight', () => { st.highlight = ''; render(); fillNets(); }]],
  Tools: [
    ['Annotate', () => doAnnotate(false)], ['Reset and annotate', () => doAnnotate(true)], ['Reset designators', () => edit(() => { log(`${resetAnnotation(st.d)} designators reset`); })], '-',
    ['Design rules check (ERC)', runErcUi], ['Create netlist → OpenBoard (forward annotation)', forwardToBoard], ['Back annotate from a board…', backAnnotateFromBoard], '-',
    ['Variants…', editVariants], ['Toggle DNP of selection in variant', toggleDnpInVariant], '-',
    ['Symbol editor (new part)', () => openSymbolEditor()], ['Edit selected part symbol', () => { const k = [...st.sel].find((x) => x.startsWith('part:')); if (k) { const pi = objOf(k)!.o as unknown as PartInst; openSymbolEditor(pi.lib, pi.part); } }],
    ['Sync all block pins', () => edit(() => { for (const { page: pg } of allPages(st.d)) for (const b of pg.blocks) syncBlockPins(b); })], '-',
    ['Property editor (spreadsheet)…', propertySheet], ['Find and replace…', findReplace], ['Part database (CIS) link…', partDatabase], '-',
    ['Constraint manager…', constraintManager], ['Rules for the highlighted net…', netClassOfHighlight], ['ERC matrix…', ercMatrix], '-',
    ['Compare with another design…', compareWithFile],
  ],
  Team: [
    ['Connect to a team design server…', teamConnect], ['Disconnect', () => team.disconnect()], '-',
    ['Reserve this page', () => team.reserve()], ['Release this page', () => team.release()], '-',
    ['Chat message…', async () => { const t = await ask('Message to the team', ''); if (t) team.chat(t); }],
    ['Save a checkpoint…', async () => { const t = await ask('Checkpoint note', 'before review'); if (t !== null) team.checkpoint(t); }],
    ['List checkpoints', () => team.send({ type: 'history' })],
    ['Restore a checkpoint…', async () => { const t = await ask('Checkpoint id (List checkpoints shows them)', ''); if (t) team.send({ type: 'restore', id: t }); }],
  ],
  Simulate: [['Simulation profile and run…', simDialog], ['Show results', () => showPane('sim')], ['Export SPICE netlist', () => exportNetlist('spice')]],
  Help: [['Keys', () => log('Keys: P part · W wire · B bus · E bus entry · N alias · V power · G ground · H port · K block · O off-page · Q no-connect · J junction · T text · L line · R rotate · X mirror · Del delete · / corner direction · Enter / double-click / right-click finish · F fit · Ctrl+Z/Y undo/redo · Ctrl+C/V/X · Ctrl+click net highlight · double-click block: descend · Ctrl+U up · wheel zoom · middle/right drag pan')], ['About', () => log('OpenSchematic — part of the OpenPCB suite (OpenBoard, OpenRoute, openpcb CLI).')]],
};
(function buildMenus() {
  const bar = $('menubar'); const pop = $('menu-pop');
  const close = () => { pop.hidden = true; bar.querySelectorAll('button').forEach((b) => b.classList.remove('open')); };
  for (const [name, items] of Object.entries(MENUS)) {
    const b = document.createElement('button'); b.textContent = name; bar.appendChild(b);
    b.onclick = (e) => {
      e.stopPropagation(); const open = !pop.hidden && b.classList.contains('open'); close(); if (open) return;
      pop.innerHTML = ''; for (const it of items) { if (it === '-') { const s = document.createElement('div'); s.className = 'sep'; pop.appendChild(s); continue; } const d = document.createElement('div'); d.className = 'item'; d.innerHTML = `<span>${esc(it[0])}</span>${it[2] ? `<kbd>${it[2]}</kbd>` : ''}`; d.onclick = () => { close(); it[1](); }; pop.appendChild(d); }
      const r = b.getBoundingClientRect(); pop.style.left = `${r.left}px`; pop.style.top = `${r.bottom + 2}px`; pop.hidden = false; b.classList.add('open');
    };
  }
  document.addEventListener('click', close);
})();

/* ---------------------------------------------------------------- cross-probing */
let probeLast = '';
function probeOut() {
  const refs = [...st.sel].filter((k) => k.startsWith('part:')).map((k) => (objOf(k)?.o as unknown as PartInst | undefined)?.ref).filter((r): r is string => !!r && !r.endsWith('?'));
  const key = [...new Set(refs)].sort().join(','); if (key === probeLast) return; probeLast = key;
  if (refs.length) xprobeSend({ type: 'select', refs: [...new Set(refs)], from: 'sch' });
}
xprobeOn('sch', (m) => {
  if (m.type === 'select') {
    // find the first page holding one of the references, select all of them there
    for (const { sch, page: pg } of allPages(st.d)) {
      const hits = pg.parts.filter((pi) => m.refs.includes(pi.ref)); if (!hits.length) continue;
      st.sch = sch.name; st.page = sch.pages.indexOf(pg); st.sel = new Set(hits.map((pi) => `part:${pi.id}`)); probeLast = [...new Set(hits.map((h) => h.ref))].sort().join(',');
      fillTree(); fillTabs(); centerOn(hits[0]); fillProps(); render(); return;
    }
  } else if (m.type === 'net') { st.highlight = m.name; render(); fillNets(); }
});

/* ---------------------------------------------------------------- boot */
new ResizeObserver(resize).observe(canvas);
try {
  const saved = localStorage.getItem('opensch.autosave');
  if (saved) { const j = JSON.parse(saved); setDesign(j.d, j.file); } else setDesign(demoDesign(), 'demo.opensch.json');
} catch { setDesign(demoDesign(), 'demo.opensch.json'); }
log('OpenSchematic ready. Menus: File (import KiCad / OrCAD / Altium), Place, Tools (annotate, ERC, netlist → OpenBoard), Simulate. Keys: Help > Keys.');

/** a small RC filter to start with */
function demoDesign(): Design {
  const d = newDesign('demo'); d.libraries.push(basicLibrary()); const pg = d.schematics[0].pages[0];
  const add = (part: string, ref: string, x: number, y: number, rot: 0 | 90 | 180 | 270, props: Record<string, string>) => pg.parts.push({ id: nid(d), lib: 'OpenSch', part, unit: 0, ref, x, y, rot, props });
  add('VSRC', 'V1', 2000, 3000, 0, { Value: 'SIN(0 1 1k)' });
  add('R', 'R1', 3000, 2500, 90, { Value: '1k' });
  add('C', 'C1', 4000, 3000, 0, { Value: '100n' });
  // wire everything with the actual pin positions
  const pin = (ref: string, n: string) => { const pi = pg.parts.find((p) => p.ref === ref)!; return instPins(d, pi).find((q) => q.pin.number === n)!.at; };
  const v1p = pin('V1', '1'), v1n = pin('V1', '2'), r1a = pin('R1', '1'), r1b = pin('R1', '2'), c1a = pin('C1', '1'), c1b = pin('C1', '2');
  const w = (...pts: Pt[]) => pg.wires.push({ id: nid(d), pts });
  w(v1p, { x: v1p.x, y: r1a.y }, r1a); w(r1b, { x: c1a.x, y: r1b.y }, c1a);
  w(v1n, { x: v1n.x, y: v1n.y + 300 }); w(c1b, { x: c1b.x, y: c1b.y + 300 });
  pg.globals.push({ id: nid(d), at: { x: v1n.x, y: v1n.y + 300 }, net: '0', style: 'ground' }, { id: nid(d), at: { x: c1b.x, y: c1b.y + 300 }, net: '0', style: 'ground' });
  pg.aliases.push({ id: nid(d), at: { x: (r1b.x + c1a.x) / 2, y: r1b.y }, name: 'OUT' }, { id: nid(d), at: { x: v1p.x, y: (v1p.y + r1a.y) / 2 }, name: 'IN', rot: 90 });
  void viewOf; void toPage; void ({} as Global);
  return d;
}
