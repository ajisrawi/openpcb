/**
 * KiCad interchange: footprint import (.kicad_mod) and netlist import (.net, KiCad's s-expression netlist), so a
 * board can start from a schematic (KiCad / any tool that writes the KiCad netlist) and existing footprint libraries.
 */
import { parseSExpr, isList, type SList, type SNode } from '@openpcb/router';
import type { Project, Footprint, Pad, Pt } from './model.js';
import { nextId } from './model.js';

const head = (f: SNode): string => (isList(f) && typeof f[0] === 'string' ? f[0] : '');
const kids = (f: SList, h: string): SList[] => f.filter((x): x is SList => isList(x) && head(x) === h);
const kid = (f: SList, h: string): SList | undefined => kids(f, h)[0];
const num = (x: SNode | undefined, d = 0): number => (x === undefined ? d : Number(x));
const str = (x: SNode | undefined): string => (x === undefined ? '' : String(x));

/** Parse one KiCad footprint (.kicad_mod, v5 `module` or v6+ `footprint`). KiCad's y axis points down: flipped here. */
export function parseKicadFootprint(text: string, nameOverride?: string): Footprint {
  const top = parseSExpr(text).find((f) => isList(f) && (head(f) === 'footprint' || head(f) === 'module')) as SList | undefined;
  if (!top) throw new Error('not a KiCad footprint (no footprint/module form)');
  const name = nameOverride ?? str(top[1]);
  const pads: Pad[] = [];
  for (const p of kids(top, 'pad')) {
    const id = str(p[1]), kind = str(p[2]), shape = str(p[3]);
    if (kind === 'np_thru_hole' && !kid(p, 'size')) continue;
    const at = kid(p, 'at'), size = kid(p, 'size'), drill = kid(p, 'drill');
    const x = num(at?.[1]), y = -num(at?.[2]), rot = ((num(at?.[3]) % 360) + 360) % 360;
    let w = num(size?.[1], 0.5), h = num(size?.[2], w);
    const quarter = Math.abs(rot / 90 - Math.round(rot / 90)) < 1e-6;
    if (quarter && Math.round(rot / 90) % 2 === 1) [w, h] = [h, w];
    const th = kind === 'thru_hole' || kind === 'np_thru_hole';
    let d: number | undefined;
    if (drill) { const vals = drill.slice(1).filter((v) => !isList(v) && v !== 'oval').map(Number).filter((v) => !Number.isNaN(v)); d = vals.length ? Math.min(...vals) : undefined; }
    pads.push({ id: id || String(pads.length + 1), x, y, w, h, shape: shape === 'circle' ? 'circle' : shape === 'oval' ? 'oval' : 'rect', th, ...(d !== undefined ? { drill: d } : {}), ...(quarter ? {} : { rot: -rot }) });
  }
  // silkscreen graphics on the front/back silk layers become the outline
  const outline: Pt[][] = [];
  const onSilk = (f: SList) => { const l = str(kid(f, 'layer')?.[1]); return /SilkS/.test(l); };
  for (const l of [...kids(top, 'fp_line')]) if (onSilk(l)) { const s = kid(l, 'start'), e = kid(l, 'end'); if (s && e) outline.push([{ x: num(s[1]), y: -num(s[2]) }, { x: num(e[1]), y: -num(e[2]) }]); }
  for (const r of kids(top, 'fp_rect')) if (onSilk(r)) { const s = kid(r, 'start'), e = kid(r, 'end'); if (s && e) { const x1 = num(s[1]), y1 = -num(s[2]), x2 = num(e[1]), y2 = -num(e[2]); outline.push([{ x: x1, y: y1 }, { x: x2, y: y1 }, { x: x2, y: y2 }, { x: x1, y: y2 }, { x: x1, y: y1 }]); } }
  for (const c of kids(top, 'fp_circle')) if (onSilk(c)) { const ce = kid(c, 'center'), e = kid(c, 'end'); if (ce && e) { const cx = num(ce[1]), cy = -num(ce[2]), r = Math.hypot(num(e[1]) - num(ce[1]), num(e[2]) - num(ce[2])); const pl: Pt[] = []; for (let k = 0; k <= 24; k++) pl.push({ x: cx + r * Math.cos((k / 24) * 2 * Math.PI), y: cy + r * Math.sin((k / 24) * 2 * Math.PI) }); outline.push(pl); } }
  for (const pl of kids(top, 'fp_poly')) if (onSilk(pl)) { const pts = kid(pl, 'pts'); if (pts) { const xy = kids(pts, 'xy').map((q) => ({ x: num(q[1]), y: -num(q[2]) })); if (xy.length) outline.push([...xy, xy[0]]); } }
  let bw = 1, bh = 1; for (const pd of pads) { bw = Math.max(bw, Math.abs(pd.x) * 2 + pd.w); bh = Math.max(bh, Math.abs(pd.y) * 2 + pd.h); }
  return { name, pads, outline, body: { w: bw, h: bh }, outlineKind: 'silk' };
}

export interface NetlistImport { components: number; added: number; nets: number; missingFootprints: string[] }

/** KiCad netlist (.net): components (ref, value, footprint) and nets; new parts are placed in a row below the board. */
export function importKicadNetlist(p: Project, text: string): NetlistImport {
  const top = parseSExpr(text).find((f) => isList(f) && head(f) === 'export') as SList | undefined;
  if (!top) throw new Error('not a KiCad netlist (no export form)');
  const comps = kid(top, 'components'), nets = kid(top, 'nets');
  const res: NetlistImport = { components: 0, added: 0, nets: 0, missingFootprints: [] };
  const have = new Set(p.components.map((c) => c.ref));
  const xs = p.outline.map((q) => q.x), ys = p.outline.map((q) => q.y);
  let x = Math.min(...xs), y = Math.min(...ys) - 5;
  for (const c of comps ? kids(comps, 'comp') : []) {
    res.components++;
    const ref = str(kid(c, 'ref')?.[1]), value = str(kid(c, 'value')?.[1]), fp = str(kid(c, 'footprint')?.[1]);
    if (!ref || have.has(ref)) continue;
    const short = fp.includes(':') ? fp.split(':').pop()! : fp;
    const footprint = p.footprints[fp] ? fp : p.footprints[short] ? short : fp;
    if (!p.footprints[footprint]) res.missingFootprints.push(`${ref}:${fp}`);
    p.components.push({ ref, footprint, value, x, y, rot: 0, side: 'front' });
    have.add(ref); res.added++;
    x += 5; if (x > Math.max(...xs)) { x = Math.min(...xs); y -= 5; }
  }
  for (const n of nets ? kids(nets, 'net') : []) {
    const name = str(kid(n, 'name')?.[1]).replace(/^\//, '');
    const pins = kids(n, 'node').map((nd) => `${str(kid(nd, 'ref')?.[1])}-${str(kid(nd, 'pin')?.[1])}`).filter((s) => !s.startsWith('-'));
    if (!name || pins.length < 2) continue;   // single-pin nets (KiCad's unconnected-…) carry no connection
    let net = p.nets.find((x) => x.name === name);
    if (!net) { net = { name, pins: [] }; p.nets.push(net); res.nets++; }
    for (const pin of pins) { for (const other of p.nets) if (other !== net) other.pins = other.pins.filter((q) => q !== pin); if (!net.pins.includes(pin)) net.pins.push(pin); }
  }
  p.nets = p.nets.filter((n) => n.pins.length > 0);
  void nextId;
  return res;
}
