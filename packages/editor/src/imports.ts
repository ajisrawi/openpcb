/**
 * Imports from other tools (Allegro File > Import > Artwork / CAD Translators):
 *
 *   Gerber RS-274X  copper artwork onto a layer of the project: draws become traces (no net, locked), flashes become
 *                   small static pours (rectangles/circles as polygons), G36/G37 regions become static pours.
 *                   Apertures C, R, O (and P as a circle), G01/G02/G03 (arcs as chords), %LPD/%LPC (clear areas skipped).
 *   Eagle .brd      XML board: layers 1 (top), 2-15 (inner), 16 (bottom); outline from layer 20 wires; packages with
 *                   smd/pad; elements (R90, MR90 = bottom); signals (contactrefs, wires, vias); polygons as pours.
 *   KiCad .kicad_pcb  layers, Edge.Cuts outline, footprints with pads, nets, segments, arcs (as chords), vias, zones.
 */
import { parseSExpr, isList, isAtom, type SNode as SExpr, type SList } from '@openpcb/router';
import { type Project, type Pt, type Pad, type Footprint, newProject, nextId, defaultRules, LAYER_COLORS } from './model.js';

/* ============================== Gerber ============================== */

export function importGerber(p: Project, text: string, layer: string): { traces: number; pours: number } {
  let fmtX = 6, fmtY = 6, unit = 1;    // decimals; unit scale to mm
  const aps = new Map<number, { t: string; mods: number[] }>();
  let ap = 0, x = 0, y = 0, interp: 'lin' | 'cw' | 'ccw' = 'lin', dark = true, region: Pt[] | null = null;
  let traces = 0, pours = 0;
  const cmd = text.replace(/\r?\n/g, '');
  const tokens = cmd.match(/%[^%]*%|[^*%]+\*/g) ?? [];
  const num = (s: string | undefined, dec: number, prev: number) => (s === undefined ? prev : (Number(s) / 10 ** dec) * unit);
  const addTrace = (pts: Pt[], w: number) => { p.traces.push({ id: nextId(p), net: '', layer, width: w, points: pts, locked: true }); traces++; };
  const addPour = (pts: Pt[]) => { p.zones.push({ id: nextId(p), net: '', layer, points: pts, clearance: p.rules.clearance, dynamic: false }); pours++; };
  const arc = (x0: number, y0: number, x1: number, y1: number, i: number, j: number, cw: boolean): Pt[] => {
    const cx = x0 + i, cy = y0 + j, r = Math.hypot(x0 - cx, y0 - cy);
    let a0 = Math.atan2(y0 - cy, x0 - cx), a1 = Math.atan2(y1 - cy, x1 - cx);
    if (cw) { while (a1 >= a0) a1 -= 2 * Math.PI; } else { while (a1 <= a0) a1 += 2 * Math.PI; }
    const n = Math.max(2, Math.ceil(Math.abs(a1 - a0) / (Math.PI / 18)));
    return Array.from({ length: n }, (_, k) => ({ x: cx + r * Math.cos(a0 + ((a1 - a0) * (k + 1)) / n), y: cy + r * Math.sin(a0 + ((a1 - a0) * (k + 1)) / n) }));
  };
  for (const tk of tokens) {
    if (tk.startsWith('%')) {
      const b = tk.slice(1, -1).replace(/\*$/, '');
      let m: RegExpExecArray | null;
      if ((m = /^FSLAX(\d)(\d)Y(\d)(\d)/.exec(b))) { fmtX = Number(m[2]); fmtY = Number(m[4]); }
      else if (/^MOIN/.test(b)) unit = 25.4; else if (/^MOMM/.test(b)) unit = 1;
      else if ((m = /^ADD(\d+)([A-Z]+),?([\d.Xx]*)/.exec(b))) aps.set(Number(m[1]), { t: m[2], mods: m[3] ? m[3].split(/X/i).map(Number) : [] });
      else if (b === 'LPD') dark = true; else if (b === 'LPC') dark = false;
      continue;
    }
    const s = tk.slice(0, -1);
    if (/^G04/.test(s) || s === 'M02' || s === 'M00') continue;
    if (s === 'G36') { region = []; continue; }
    if (s === 'G37') { if (region && region.length >= 3 && dark) addPour(region); region = null; continue; }
    if (s === 'G74' || s === 'G75') continue;
    let rest = s;
    const g = /^G0?([123])/.exec(rest); if (g) { interp = g[1] === '1' ? 'lin' : g[1] === '2' ? 'cw' : 'ccw'; rest = rest.slice(g[0].length); }
    const dsel = /^D(\d{2,})$/.exec(rest); if (dsel && Number(dsel[1]) >= 10) { ap = Number(dsel[1]); continue; }
    const m = /^(?:X([+-]?\d+))?(?:Y([+-]?\d+))?(?:I([+-]?\d+))?(?:J([+-]?\d+))?(?:D0?([123]))?$/.exec(rest);
    if (!m) continue;
    const nx = num(m[1], fmtX, x), ny = num(m[2], fmtY, y), ii = m[3] ? num(m[3], fmtX, 0) : 0, jj = m[4] ? num(m[4], fmtY, 0) : 0;
    const d = m[5] ? Number(m[5]) : (region ? 1 : 0);
    const seg: Pt[] = interp === 'lin' ? [{ x: nx, y: ny }] : arc(x, y, nx, ny, ii, jj, interp === 'cw');
    if (d === 1) {
      if (region) region.push(...seg);
      else if (dark) { const a = aps.get(ap); const w = a ? (a.t === 'R' ? Math.min(a.mods[0], a.mods[1] ?? a.mods[0]) : a.mods[0]) * unit : 0.1; addTrace([{ x, y }, ...seg], w || 0.1); }
    } else if (d === 2) { if (region) { if (region.length >= 3 && dark) addPour(region); region = []; region.push({ x: nx, y: ny }); } }
    else if (d === 3 && dark) {
      const a = aps.get(ap);
      if (a) {
        const w = a.mods[0] * unit, h = (a.mods[1] ?? a.mods[0]) * unit;
        if (a.t === 'C' || a.t === 'P' || (a.t === 'O' && Math.abs(w - h) < 1e-9)) addPour(Array.from({ length: 24 }, (_, k) => ({ x: nx + (w / 2) * Math.cos((2 * Math.PI * k) / 24), y: ny + (w / 2) * Math.sin((2 * Math.PI * k) / 24) })));
        else if (a.t === 'O') { const d0 = Math.min(w, h), half = (Math.max(w, h) - d0) / 2; addTrace(w >= h ? [{ x: nx - half, y: ny }, { x: nx + half, y: ny }] : [{ x: nx, y: ny - half }, { x: nx, y: ny + half }], d0); }
        else addPour([{ x: nx - w / 2, y: ny - h / 2 }, { x: nx + w / 2, y: ny - h / 2 }, { x: nx + w / 2, y: ny + h / 2 }, { x: nx - w / 2, y: ny + h / 2 }]);
      }
    }
    if (region && d === 1) { /* region continues */ }
    x = nx; y = ny;
  }
  return { traces, pours };
}

/* ============================== tiny XML parser (for Eagle) ============================== */

export interface XmlNode { tag: string; attrs: Record<string, string>; children: XmlNode[]; text?: string }
export function parseXml(text: string): XmlNode {
  const root: XmlNode = { tag: '#root', attrs: {}, children: [] };
  const stack = [root];
  const re = /<(\/?)([A-Za-z_][\w:.-]*)((?:\s+[\w:.-]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>|<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!DOCTYPE[^>]*>/g;
  let m: RegExpExecArray | null;
  const decode = (s: string) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
  let last = 0;
  while ((m = re.exec(text))) {
    // character data between tags belongs to the open element
    if (m.index > last) { const s = text.slice(last, m.index); if (s.trim()) { const top = stack[stack.length - 1]; top.text = (top.text ?? '') + decode(s); } }
    last = re.lastIndex;
    if (!m[2]) continue;
    if (m[1]) { if (stack.length > 1) stack.pop(); continue; }
    const attrs: Record<string, string> = {};
    for (const a of (m[3] ?? '').matchAll(/([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) attrs[a[1]] = decode(a[2] ?? a[3] ?? '');
    const node: XmlNode = { tag: m[2], attrs, children: [] };
    stack[stack.length - 1].children.push(node);
    if (!m[4]) stack.push(node);
  }
  return root;
}
const all = (n: XmlNode, tag: string): XmlNode[] => { const out: XmlNode[] = []; const walk = (x: XmlNode) => { for (const c of x.children) { if (c.tag === tag) out.push(c); walk(c); } }; walk(n); return out; };
const first = (n: XmlNode, tag: string): XmlNode | undefined => all(n, tag)[0];

/* ============================== Eagle ============================== */

export function importEagle(text: string, name = 'eagle'): Project {
  const x = parseXml(text);
  const board = first(x, 'board'); if (!board) throw new Error('not an Eagle board file (no <board>)');
  const layerNums = new Set<number>();
  for (const w of all(board, 'wire')) layerNums.add(Number(w.attrs.layer));
  for (const s of all(board, 'smd')) layerNums.add(Number(s.attrs.layer));
  const inner = [...layerNums].filter((n) => n >= 2 && n <= 15).sort((a, b) => a - b);
  const stack = [1, ...inner, 16];
  const lname = (n: number) => (n === 1 ? 'F.Cu' : n === 16 ? 'B.Cu' : `In${inner.indexOf(n) + 1}.Cu`);
  const p = newProject(name, 2);
  p.layers = stack.map((n, i) => ({ name: lname(n), type: 'signal', color: LAYER_COLORS[i % LAYER_COLORS.length], direction: i % 2 === 0 ? 'horizontal' : 'vertical', visible: true }));
  p.rules = { ...defaultRules(), width: 0.2, clearance: 0.2 };
  // outline: layer 20 (Dimension) wires chained
  const dims = all(board.children.find((c) => c.tag === 'plain') ?? board, 'wire').filter((w) => w.attrs.layer === '20').map((w) => [{ x: +w.attrs.x1, y: +w.attrs.y1 }, { x: +w.attrs.x2, y: +w.attrs.y2 }]);
  p.outline = chainOutline(dims) ?? p.outline;
  // packages
  const pkgs = new Map<string, Footprint>();
  for (const lib of all(board, 'library')) for (const pk of all(lib, 'package')) {
    const pads: Pad[] = [];
    for (const s of pk.children.filter((c) => c.tag === 'smd')) { const rot = rotOf(s.attrs.rot); let w = +s.attrs.dx, h = +s.attrs.dy; if (Math.round(rot / 90) % 2) [w, h] = [h, w]; pads.push({ id: s.attrs.name, x: +s.attrs.x, y: +s.attrs.y, w, h, shape: Number(s.attrs.roundness ?? 0) >= 100 ? 'oval' : 'rect', th: false }); }
    for (const s of pk.children.filter((c) => c.tag === 'pad')) { const drill = +s.attrs.drill; const dia = s.attrs.diameter ? +s.attrs.diameter : drill * 1.6 + 0.2; pads.push({ id: s.attrs.name, x: +s.attrs.x, y: +s.attrs.y, w: dia, h: s.attrs.shape === 'long' ? dia * 2 : dia, shape: s.attrs.shape === 'square' ? 'rect' : s.attrs.shape === 'long' ? 'oval' : 'circle', th: true, drill }); }
    const outline = pk.children.filter((c) => c.tag === 'wire' && (c.attrs.layer === '21' || c.attrs.layer === '51')).map((w) => [{ x: +w.attrs.x1, y: +w.attrs.y1 }, { x: +w.attrs.x2, y: +w.attrs.y2 }]);
    let bw = 1, bh = 1; for (const pd of pads) { bw = Math.max(bw, Math.abs(pd.x) * 2 + pd.w); bh = Math.max(bh, Math.abs(pd.y) * 2 + pd.h); }
    const key = `${lib.attrs.name}:${pk.attrs.name}`;
    pkgs.set(key, { name: key, pads, outline, body: { w: bw, h: bh }, outlineKind: 'silk' });
  }
  for (const [k, fp] of pkgs) p.footprints[k] = fp;
  for (const el of all(board, 'element')) {
    const key = `${el.attrs.library}:${el.attrs.package}`;
    const r = el.attrs.rot ?? 'R0';
    p.components.push({ ref: el.attrs.name, footprint: key, value: el.attrs.value ?? '', x: +el.attrs.x, y: +el.attrs.y, rot: rotOf(r), side: r.includes('M') ? 'back' : 'front' });
  }
  for (const sig of all(board, 'signal')) {
    const net = sig.attrs.name;
    const pins = sig.children.filter((c) => c.tag === 'contactref').map((c) => `${c.attrs.element}-${c.attrs.pad}`);
    if (pins.length) p.nets.push({ name: net, pins });
    for (const w of sig.children.filter((c) => c.tag === 'wire')) { const ln = Number(w.attrs.layer); if (!stack.includes(ln)) continue; p.traces.push({ id: nextId(p), net, layer: lname(ln), width: +w.attrs.width, points: [{ x: +w.attrs.x1, y: +w.attrs.y1 }, { x: +w.attrs.x2, y: +w.attrs.y2 }] }); }
    for (const v of sig.children.filter((c) => c.tag === 'via')) { const drill = +v.attrs.drill; p.vias.push({ id: nextId(p), net, x: +v.attrs.x, y: +v.attrs.y, drill, diameter: v.attrs.diameter ? +v.attrs.diameter : drill + 0.3 }); }
    for (const pg of sig.children.filter((c) => c.tag === 'polygon')) { const ln = Number(pg.attrs.layer); if (!stack.includes(ln)) continue; const pts = pg.children.filter((c) => c.tag === 'vertex').map((v) => ({ x: +v.attrs.x, y: +v.attrs.y })); if (pts.length >= 3) p.zones.push({ id: nextId(p), net, layer: lname(ln), points: pts, clearance: pg.attrs.isolate ? +pg.attrs.isolate : p.rules.clearance, dynamic: true }); }
  }
  return p;
}
const rotOf = (r: string | undefined) => Number((r ?? 'R0').replace(/[^\d.]/g, '')) || 0;
function chainOutline(segs: Pt[][]): Pt[] | null {
  if (!segs.length) return null;
  const rest = segs.slice(1); const poly = [...segs[0]];
  const same = (a: Pt, b: Pt) => Math.hypot(a.x - b.x, a.y - b.y) < 1e-3;
  while (rest.length) {
    const end = poly[poly.length - 1];
    const i = rest.findIndex((s) => same(s[0], end) || same(s[1], end)); if (i < 0) break;
    const s = rest.splice(i, 1)[0]; poly.push(same(s[0], end) ? s[1] : s[0]);
  }
  if (same(poly[0], poly[poly.length - 1])) poly.pop();
  return poly.length >= 3 ? poly : null;
}

/* ============================== KiCad .kicad_pcb ============================== */

export function importKicadPcb(text: string, name = 'kicad'): Project {
  const top = parseSExpr(text); const root = (top.find((f) => isList(f) && f[0] === 'kicad_pcb') ?? top[0]) as SList;
  if (!root || !isList(root) || root[0] !== 'kicad_pcb') throw new Error('not a KiCad board file (no kicad_pcb form)');
  const kids = (l: SList, h: string) => l.filter((c): c is SList => isList(c) && c[0] === h);
  const kid = (l: SList, h: string) => kids(l, h)[0];
  const at = (l: SList) => { const a = kid(l, 'at'); return a ? { x: +String(a[1]), y: +String(a[2]), rot: a[3] !== undefined && isAtom(a[3]) ? +String(a[3]) : 0 } : { x: 0, y: 0, rot: 0 }; };
  const str = (v: SExpr | undefined) => (v === undefined ? '' : String(v));
  // KiCad y grows downwards; OpenBoard y grows upwards: mirror y
  const Y = (y: number) => -y;
  const layersDef = kid(root, 'layers');
  const copper = (layersDef ?? []).filter((c): c is SList => isList(c) && /\.Cu$/.test(str(c[1]))).map((c) => ({ name: str(c[1]), type: str(c[2]) }));
  const p = newProject(name, 2);
  p.layers = copper.map((l, i) => ({ name: l.name, type: l.type === 'power' ? 'power' : 'signal', color: LAYER_COLORS[i % LAYER_COLORS.length], direction: i % 2 === 0 ? 'horizontal' : 'vertical', visible: true }));
  const netName = new Map<string, string>();
  for (const n of kids(root, 'net')) netName.set(str(n[1]), str(n[2]));
  const netOf = (l: SList) => { const n = kid(l, 'net'); if (!n) return ''; return n.length >= 3 ? str(n[2]) : netName.get(str(n[1])) ?? str(n[1]); };
  // outline from Edge.Cuts lines/arcs
  const edges: Pt[][] = [];
  for (const g of [...kids(root, 'gr_line'), ...kids(root, 'gr_arc'), ...kids(root, 'gr_rect')]) {
    const layer = str(kid(g, 'layer')?.[1]); if (layer !== 'Edge.Cuts') continue;
    const s = kid(g, 'start'), e = kid(g, 'end');
    if (g[0] === 'gr_rect' && s && e) { const x1 = +str(s[1]), y1 = Y(+str(s[2])), x2 = +str(e[1]), y2 = Y(+str(e[2])); edges.push([{ x: x1, y: y1 }, { x: x2, y: y1 }], [{ x: x2, y: y1 }, { x: x2, y: y2 }], [{ x: x2, y: y2 }, { x: x1, y: y2 }], [{ x: x1, y: y2 }, { x: x1, y: y1 }]); }
    else if (s && e) edges.push([{ x: +str(s[1]), y: Y(+str(s[2])) }, { x: +str(e[1]), y: Y(+str(e[2])) }]);
  }
  p.outline = chainOutline(edges) ?? p.outline;
  const nets = new Map<string, string[]>();
  for (const fp of kids(root, 'footprint')) {
    const fname = str(fp[1]); const pos = at(fp);
    const layer = str(kid(fp, 'layer')?.[1]);
    const ref = (kids(fp, 'property').find((pr) => str(pr[1]) === 'Reference')?.[2]) ?? (kids(fp, 'fp_text').find((t) => str(t[1]) === 'reference')?.[2]);
    const val = (kids(fp, 'property').find((pr) => str(pr[1]) === 'Value')?.[2]) ?? (kids(fp, 'fp_text').find((t) => str(t[1]) === 'value')?.[2]);
    const refS = str(ref) || `X${p.components.length + 1}`;
    const pads: Pad[] = [];
    // a footprint on B.Cu is stored already flipped (pad x mirrored); OpenBoard mirrors back-side parts itself
    const flipX = layer === 'B.Cu' ? -1 : 1;
    for (const pd of kids(fp, 'pad')) {
      const id = str(pd[1]), kind = str(pd[2]), shape = str(pd[3]);
      const padLayersK = (kid(pd, 'layers') ?? []).slice(1).map(str);
      if (kind !== 'np_thru_hole' && !padLayersK.some((l) => /Cu$/.test(l))) continue;   // paste / mask-only windows
      const pa = at(pd); const sz = kid(pd, 'size'); const dr = kid(pd, 'drill');
      let w = sz ? +str(sz[1]) : 0.5, h = sz ? +str(sz[2]) : 0.5;
      // pad angle in KiCad is absolute (includes the footprint angle): make it footprint-relative
      const rel = (((pa.rot - pos.rot) % 360) + 360) % 360;
      if (Math.round(rel / 90) % 2 === 1 && Math.abs(rel / 90 - Math.round(rel / 90)) < 1e-6) [w, h] = [h, w];
      const th = kind === 'thru_hole' || kind === 'np_thru_hole';
      pads.push({ id, x: flipX * pa.x, y: -pa.y, w, h, shape: shape === 'circle' ? 'circle' : shape === 'oval' ? 'oval' : 'rect', th, ...(th && dr ? { drill: +str(dr[1]) } : {}), ...(kind === 'np_thru_hole' ? { npth: true } : {}) });
      const n = netOf(pd); if (n && id) (nets.get(n) ?? nets.set(n, []).get(n)!).push(`${refS}-${id}`);
    }
    const outline = [...kids(fp, 'fp_line')].filter((l) => /SilkS$/.test(str(kid(l, 'layer')?.[1]))).map((l) => { const s = kid(l, 'start')!, e = kid(l, 'end')!; return [{ x: flipX * +str(s[1]), y: -(+str(s[2])) }, { x: flipX * +str(e[1]), y: -(+str(e[2])) }]; });
    let bw = 1, bh = 1; for (const pd of pads) { bw = Math.max(bw, Math.abs(pd.x) * 2 + pd.w); bh = Math.max(bh, Math.abs(pd.y) * 2 + pd.h); }
    const key = p.footprints[fname] && JSON.stringify(p.footprints[fname].pads) !== JSON.stringify(pads) ? `${fname}#${refS}` : fname;
    p.footprints[key] = { name: key, pads, outline, body: { w: bw, h: bh }, outlineKind: 'silk' };
    const back = layer === 'B.Cu';
    // KiCad footprint angle is counter-clockwise in its y-down frame; in the y-up frame it stays counter-clockwise
    p.components.push({ ref: refS, footprint: key, value: str(val), x: pos.x, y: Y(pos.y), rot: ((pos.rot % 360) + 360) % 360, side: back ? 'back' : 'front' });
  }
  for (const [n, pins] of nets) p.nets.push({ name: n, pins });
  for (const s of kids(root, 'segment')) { const a = kid(s, 'start'), b = kid(s, 'end'); if (!a || !b) continue; p.traces.push({ id: nextId(p), net: netOf(s), layer: str(kid(s, 'layer')?.[1]), width: +str(kid(s, 'width')?.[1] ?? '0.2'), points: [{ x: +str(a[1]), y: Y(+str(a[2])) }, { x: +str(b[1]), y: Y(+str(b[2])) }] }); }
  for (const s of kids(root, 'arc')) { const a = kid(s, 'start'), m = kid(s, 'mid'), b = kid(s, 'end'); if (!a || !b || !m) continue; p.traces.push({ id: nextId(p), net: netOf(s), layer: str(kid(s, 'layer')?.[1]), width: +str(kid(s, 'width')?.[1] ?? '0.2'), points: arc3({ x: +str(a[1]), y: Y(+str(a[2])) }, { x: +str(m[1]), y: Y(+str(m[2])) }, { x: +str(b[1]), y: Y(+str(b[2])) }) }); }
  for (const v of kids(root, 'via')) {
    const pos = at(v), ls = kid(v, 'layers'); const names = (ls ?? []).slice(1).map(str);
    const through = !names.length || (names[0] === p.layers[0]?.name && names[names.length - 1] === p.layers[p.layers.length - 1]?.name);
    p.vias.push({ id: nextId(p), net: netOf(v), x: pos.x, y: Y(pos.y), diameter: +str(kid(v, 'size')?.[1] ?? '0.6'), drill: +str(kid(v, 'drill')?.[1] ?? '0.3'), ...(through ? {} : { from: names[0], to: names[names.length - 1] }) });
  }
  for (const z of kids(root, 'zone')) {
    const poly = kid(z, 'polygon'); const pts = poly ? kid(poly, 'pts') : undefined; if (!pts) continue;
    const xy = kids(pts, 'xy').map((q) => ({ x: +str(q[1]), y: Y(+str(q[2])) }));
    const zl = kid(z, 'layer') ? [str(kid(z, 'layer')![1])] : (kid(z, 'layers') ?? []).slice(1).map(str);
    for (const l of zl) if (p.layers.some((x) => x.name === l) && xy.length >= 3) p.zones.push({ id: nextId(p), net: netOf(z), layer: l, points: xy, clearance: +str(kid(kid(z, 'connect_pads') ?? [], 'clearance')?.[1] ?? '0.2'), dynamic: true });
  }
  const setup = kid(root, 'setup');
  void setup;
  return p;
}
function arc3(a: Pt, m: Pt, b: Pt): Pt[] {
  const d = 2 * (a.x * (m.y - b.y) + m.x * (b.y - a.y) + b.x * (a.y - m.y)); if (Math.abs(d) < 1e-12) return [a, b];
  const ux = ((a.x ** 2 + a.y ** 2) * (m.y - b.y) + (m.x ** 2 + m.y ** 2) * (b.y - a.y) + (b.x ** 2 + b.y ** 2) * (a.y - m.y)) / d;
  const uy = ((a.x ** 2 + a.y ** 2) * (b.x - m.x) + (m.x ** 2 + m.y ** 2) * (a.x - b.x) + (b.x ** 2 + b.y ** 2) * (m.x - a.x)) / d;
  const r = Math.hypot(a.x - ux, a.y - uy);
  const ang = (q: Pt) => Math.atan2(q.y - uy, q.x - ux);
  let a0 = ang(a), am = ang(m), a1 = ang(b);
  const norm = (v: number) => { while (v < a0) v += 2 * Math.PI; while (v >= a0 + 2 * Math.PI) v -= 2 * Math.PI; return v; };
  am = norm(am); a1 = norm(a1);
  if (am > a1) a1 -= 2 * Math.PI;   // the mid point decides the sweep direction
  const n = Math.max(2, Math.ceil(Math.abs(a1 - a0) / (Math.PI / 18)));
  return Array.from({ length: n + 1 }, (_, k) => ({ x: ux + r * Math.cos(a0 + ((a1 - a0) * k) / n), y: uy + r * Math.sin(a0 + ((a1 - a0) * k) / n) }));
}
