/**
 * KiCad schematic import (.kicad_sch, KiCad 6-8) and symbol library import (.kicad_sym).
 *
 * Embedded lib_symbols become library parts (units from the "<name>_<unit>_<style>" sub-symbols; unit 0 is shared
 * by every unit, style 2 is the DeMorgan view); placed symbols become part instances (power symbols become power /
 * ground globals named by their value); wires, buses, bus entries, junctions, no-connects, local labels (net
 * aliases), global labels (global connections), hierarchical labels (ports) and sheets (hierarchical blocks, whose
 * files are read through `readFile`) are converted. Reference designators come from the symbol's instance for the
 * sheet path it is used at. Millimetres become mils; symbol coordinates (y up) are flipped.
 */
import { parseSExpr, isList, isAtom, type SNode, type SList } from '@openpcb/router';
import { type Design, type Page, type LibPart, type SymPin, type Graphic, type PinType, type Orient, type Pt, type Library, newDesign, newPage, nid } from './model.js';

const MIL = 1000 / 25.4;
const mil = (v: SNode | undefined) => Math.round(Number(String(v ?? 0)) * MIL);
const kids = (l: SList, h: string) => l.filter((c): c is SList => isList(c) && c[0] === h);
const kid = (l: SList, h: string) => kids(l, h)[0];
const str = (v: SNode | undefined) => (v === undefined ? '' : String(v));
const prop = (l: SList, name: string) => str(kids(l, 'property').find((p) => str(p[1]) === name)?.[2]);
const yes = (l: SList | undefined) => !!l && (l.length === 1 || str(l[1]) === 'yes');

const PIN_TYPE: Record<string, PinType> = { input: 'input', output: 'output', bidirectional: 'bidirectional', tri_state: 'tristate', passive: 'passive', free: 'unspecified', unspecified: 'unspecified', power_in: 'power', power_out: 'power', open_collector: 'open_collector', open_emitter: 'open_emitter', no_connect: 'no_connect' };
/** KiCad pin angle (direction from the tip into the body, y up) -> direction the pin points out of the body (y down). */
const ORIENT: Record<number, Orient> = { 0: 'left', 90: 'down', 180: 'right', 270: 'up' };

function graphicsOf(l: SList): Graphic[] {
  const out: Graphic[] = [];
  const P = (xy: SList): Pt => ({ x: mil(xy[1]), y: -mil(xy[2]) });
  const filled = (g: SList) => { const f = kid(g, 'fill'); const t = f ? str(kid(f, 'type')?.[1]) : 'none'; return t === 'outline' || t === 'background'; };
  for (const g of l) {
    if (!isList(g)) continue;
    if (g[0] === 'rectangle') { const s = kid(g, 'start'), e = kid(g, 'end'); out.push({ kind: 'rect', x1: mil(s[1]), y1: -mil(s[2]), x2: mil(e[1]), y2: -mil(e[2]), fill: filled(g) && str(kid(kid(g, 'fill'), 'type')?.[1]) === 'outline' }); }
    else if (g[0] === 'polyline') { const pts = kids(kid(g, 'pts') ?? [], 'xy').map(P); if (pts.length >= 2) out.push(filled(g) && pts.length > 2 ? { kind: 'polygon', pts, fill: str(kid(kid(g, 'fill'), 'type')?.[1]) === 'outline' } : { kind: 'line', pts }); }
    else if (g[0] === 'circle') { const c = kid(g, 'center'); out.push({ kind: 'circle', c: { x: mil(c[1]), y: -mil(c[2]) }, r: mil(kid(g, 'radius')?.[1]), fill: str(kid(kid(g, 'fill'), 'type')?.[1]) === 'outline' }); }
    else if (g[0] === 'arc') {
      const s = kid(g, 'start'), m = kid(g, 'mid'), e = kid(g, 'end');
      if (s && m && e) {
        const a = P(s), b = P(m), c = P(e);
        const d = 2 * (a.x * (b.y - c.y) + b.x * (c.y - a.y) + c.x * (a.y - b.y)); if (Math.abs(d) < 1e-9) { out.push({ kind: 'line', pts: [a, c] }); continue; }
        const ux = ((a.x ** 2 + a.y ** 2) * (b.y - c.y) + (b.x ** 2 + b.y ** 2) * (c.y - a.y) + (c.x ** 2 + c.y ** 2) * (a.y - b.y)) / d;
        const uy = ((a.x ** 2 + a.y ** 2) * (c.x - b.x) + (b.x ** 2 + b.y ** 2) * (a.x - c.x) + (c.x ** 2 + c.y ** 2) * (b.x - a.x)) / d;
        const r = Math.hypot(a.x - ux, a.y - uy);
        // screen angles (y down): counter-clockwise on screen = negative math angle in y-down coordinates
        const ang = (q: Pt) => (Math.atan2(-(q.y - uy), q.x - ux) * 180) / Math.PI;
        let a0 = ang(a), a1 = ang(c), am = ang(b);
        const norm = (x: number) => ((x % 360) + 360) % 360;
        if (norm(am - a0) > norm(a1 - a0)) [a0, a1] = [a1, a0];
        out.push({ kind: 'arc', c: { x: Math.round(ux), y: Math.round(uy) }, r: Math.round(r), a0, a1 });
      }
    } else if (g[0] === 'text') { const at = kid(g, 'at'); out.push({ kind: 'text', at: { x: mil(at[1]), y: -mil(at[2]) }, text: str(g[1]), size: 50 }); }
  }
  return out;
}

function pinsOf(l: SList, hideNumbers: boolean): SymPin[] {
  void hideNumbers;
  return kids(l, 'pin').map((p) => {
    const at = kid(p, 'at'); const ang = ((Math.round(Number(str(at[3] ?? 0))) % 360) + 360) % 360;
    const name = str(kid(p, 'name')?.[1]), number = str(kid(p, 'number')?.[1]);
    const type = PIN_TYPE[str(p[1])] ?? 'unspecified';
    const hidden = p.some((c) => (isAtom(c) && String(c) === 'hide')) || yes(kid(p, 'hide'));
    return { number, name: name === '~' ? '' : name, type, x: mil(at[1]), y: -mil(at[2]), length: mil(kid(p, 'length')?.[1]), orient: ORIENT[ang] ?? 'left', shape: str(p[2]) === 'inverted' ? 'dot' : str(p[2]) === 'clock' ? 'clock' : 'line', ...(hidden && type === 'power' ? { hidden: true, net: name } : hidden ? { hidden: true } : {}) } as SymPin;
  });
}

/** A library part from a KiCad (symbol "lib:name" ...) definition. */
export function kicadSymbolToPart(sym: SList, all?: Map<string, SList>): LibPart {
  let def = sym;
  // (extends "base"): take graphics and pins from the base symbol
  const ext = kid(sym, 'extends'); if (ext && all) { const base = all.get(str(ext[1])); if (base) def = base; }
  const full = str(sym[1]); const name = full.includes(':') ? full.split(':').pop()! : full;
  const subs = kids(def, 'symbol');
  const parse = (s: string) => { const m = /_(\d+)_(\d+)$/.exec(s); return m ? { unit: Number(m[1]), style: Number(m[2]) } : { unit: 0, style: 1 }; };
  const nUnits = Math.max(1, ...subs.map((s) => parse(str(s[1])).unit));
  const hideNums = yes(kid(def, 'pin_numbers') ? kid(kid(def, 'pin_numbers'), 'hide') ?? kid(def, 'pin_numbers') : undefined);
  const viewFor = (u: number, style: number) => {
    const graphics: Graphic[] = [], pins: SymPin[] = [];
    for (const s of subs) { const k = parse(str(s[1])); if ((k.unit === 0 || k.unit === u) && (k.style === 0 || k.style === style)) { graphics.push(...graphicsOf(s)); pins.push(...pinsOf(s, hideNums)); } }
    return { graphics, pins };
  };
  const hasConvert = subs.some((s) => parse(str(s[1])).style === 2);
  const units = Array.from({ length: nUnits }, (_, i) => ({ normal: viewFor(i + 1, 1), ...(hasConvert ? { convert: viewFor(i + 1, 2) } : {}) }));
  const props: Record<string, string> = {};
  for (const p of kids(sym, 'property')) { const k = str(p[1]), v = str(p[2]); if (k === 'Footprint') props['PCB Footprint'] = v; else if (k !== 'Reference') props[k] = v; }
  const power = !!kid(sym, 'power') || !!kid(def, 'power');
  const refPrefix = prop(sym, 'Reference').replace(/[^A-Za-z_#]/g, '') || 'U';
  return { name, refPrefix, units, props, ...(power ? { kind: /gnd|vss|earth/i.test(name) ? 'ground' as const : 'power' as const } : {}), description: props.Description ?? props.ki_description ?? '' };
}

/** Symbols of a .kicad_sym library file. */
export function importKicadSymbolLibrary(text: string, libName: string): Library {
  const top = parseSExpr(text); const root = (top.find((f) => isList(f) && f[0] === 'kicad_symbol_lib') ?? top[0]) as SList;
  const syms = kids(root, 'symbol'); const all = new Map(syms.map((s) => [str(s[1]), s]));
  return { name: libName, parts: Object.fromEntries(syms.map((s) => { const p = kicadSymbolToPart(s, all); return [p.name, p]; })) };
}

export interface KicadImportOptions { readFile?: (name: string) => string | null; name?: string }

export function importKicadSchematic(text: string, opts: KicadImportOptions = {}): Design {
  const d = newDesign(opts.name ?? 'kicad');
  d.schematics = [];
  const lib: Library = { name: 'kicad', parts: {} };
  d.libraries.push(lib);
  const loaded = new Map<string, string>();   // file -> schematic name
  let rootUuid = '';
  // sheet path (uuid chain) -> our block path (sheet names); filled while descending
  const pathNames = new Map<string, string>();
  const refFor = (sym: SList, path: string): { ref: string; unit: number } | null => {
    const inst = kid(sym, 'instances');
    const paths = inst ? kids(inst, 'project').flatMap((pr) => kids(pr, 'path')) : [];
    const hit = paths.find((p) => str(p[1]) === path) ?? paths[0];
    if (!hit) return null;
    return { ref: str(kid(hit, 'reference')?.[1]), unit: Number(str(kid(hit, 'unit')?.[1] ?? '1')) };
  };
  const load = (txt: string, schName: string, uuidPath: string, blockPath: string): void => {
    const top = parseSExpr(txt); const root = (top.find((f) => isList(f) && f[0] === 'kicad_sch') ?? top[0]) as SList;
    if (!root || root[0] !== 'kicad_sch') throw new Error('not a KiCad schematic (no kicad_sch form)');
    const uuid = str(kid(root, 'uuid')?.[1]);
    if (!rootUuid) rootUuid = uuid;
    // instance paths: "/<root uuid>" on the root sheet, "/<root uuid>/<sheet uuid>/..." below it
    if (!uuidPath) uuidPath = `/${uuid}`;
    const paper = str(kid(root, 'paper')?.[1]);
    const page: Page = newPage(schName, (['A4', 'A3', 'A2', 'A1', 'A0'].includes(paper) ? paper : paper === 'USLetter' ? 'A' : paper === 'USLedger' ? 'B' : 'A3') as Page['size']);
    const tb = kid(root, 'title_block'); if (tb) { page.title = { Title: str(kid(tb, 'title')?.[1]) || schName, Date: str(kid(tb, 'date')?.[1]), Revision: str(kid(tb, 'rev')?.[1]), Company: str(kid(tb, 'company')?.[1]) }; }
    const ls = kid(root, 'lib_symbols');
    const defs = new Map<string, SList>(ls ? kids(ls, 'symbol').map((s) => [str(s[1]), s]) : []);
    const partName = new Map<string, string>();
    for (const [full, s] of defs) {
      const lp = kicadSymbolToPart(s, defs);
      // the same name may come from two libraries with different drawings: keep both
      let key = lp.name; if (lib.parts[key] && JSON.stringify(lib.parts[key].units) !== JSON.stringify(lp.units)) key = full.replace(':', '_'); lp.name = key;
      lib.parts[key] ??= lp; partName.set(full, key);
    }
    const P = (at: SList): Pt => ({ x: mil(at[1]), y: mil(at[2]) });
    for (const w of kids(root, 'wire')) { const pts = kids(kid(w, 'pts'), 'xy').map(P); if (pts.length >= 2) page.wires.push({ id: nid(d), pts }); }
    for (const b of kids(root, 'bus')) { const pts = kids(kid(b, 'pts'), 'xy').map(P); if (pts.length >= 2) page.buses.push({ id: nid(d), pts }); }
    for (const e of kids(root, 'bus_entry')) { const at = P(kid(e, 'at')); const sz = kid(e, 'size'); const dx = Number(str(sz?.[1])), dy = Number(str(sz?.[2])); page.busEntries.push({ id: nid(d), at, dir: `${dy < 0 ? 'n' : 's'}${dx < 0 ? 'w' : 'e'}` as 'ne' }); }
    for (const j of kids(root, 'junction')) page.junctions.push({ id: nid(d), at: P(kid(j, 'at')) });
    for (const n of kids(root, 'no_connect')) page.noConnects.push({ id: nid(d), at: P(kid(n, 'at')) });
    for (const l of kids(root, 'label')) { const at = kid(l, 'at'); page.aliases.push({ id: nid(d), at: P(at), name: str(l[1]), rot: Math.round(Number(str(at[3] ?? 0))) % 180 === 90 ? 90 : 0 }); }
    for (const l of kids(root, 'global_label')) { const at = kid(l, 'at'); page.globals.push({ id: nid(d), at: P(at), net: str(l[1]), style: 'label', rot: (Math.round(Number(str(at[3] ?? 0))) % 360) as 0 }); }
    for (const l of kids(root, 'hierarchical_label')) { const at = kid(l, 'at'); const shape = str(kid(l, 'shape')?.[1]); page.ports.push({ id: nid(d), at: P(at), name: str(l[1]), dir: shape === 'input' ? 'input' : shape === 'output' ? 'output' : shape === 'bidirectional' ? 'bidirectional' : 'passive', rot: Math.round(Number(str(at[3] ?? 0))) === 180 ? 180 : 0 }); }
    for (const t of kids(root, 'text')) { const at = kid(t, 'at'); page.texts.push({ id: nid(d), at: P(at), text: str(t[1]), size: 50 }); }
    for (const g of [...kids(root, 'polyline')]) { const pts = kids(kid(g, 'pts'), 'xy').map(P); if (pts.length >= 2) page.graphics.push({ id: nid(d), g: { kind: 'line', pts } }); }
    for (const s of kids(root, 'symbol')) {
      const libId = str(kid(s, 'lib_id')?.[1]); const name = partName.get(libId) ?? libId.split(':').pop()!;
      const lp = lib.parts[name];
      const at = kid(s, 'at'); const rot = ((Math.round(Number(str(at[3] ?? 0))) % 360) + 360) % 360 as 0 | 90 | 180 | 270;
      const mir = str(kid(s, 'mirror')?.[1]);
      const inst = refFor(s, uuidPath);
      const unit = Math.max(0, (inst?.unit ?? Number(str(kid(s, 'unit')?.[1] ?? '1'))) - 1);
      const props: Record<string, string> = {};
      for (const p of kids(s, 'property')) { const k = str(p[1]), v = str(p[2]); if (k === 'Footprint') props['PCB Footprint'] = v; else if (k !== 'Reference') props[k] = v; }
      // (mirror x) flips top-bottom = mirror about the vertical axis then rotate 180
      const pos = P(at);
      if (lp?.kind === 'power' || lp?.kind === 'ground') {
        const net = props.Value || lp.name;
        if (/PWR_FLAG/i.test(lp.name)) continue;
        page.globals.push({ id: nid(d), at: pos, net, style: lp.kind === 'ground' ? 'ground' : 'power_bar', rot: ((rot + (mir === 'x' ? 180 : 0)) % 360) as 0 });
        continue;
      }
      const ref = inst?.ref || prop(s, 'Reference') || `${lp?.refPrefix ?? 'U'}?`;
      page.parts.push({ id: nid(d), lib: lib.name, part: name, unit, ref, x: pos.x, y: pos.y, rot: (mir === 'x' ? (rot + 180) % 360 : rot) as 0, ...(mir ? { mirror: true } : {}), props, ...(yes(kid(s, 'dnp')) ? { dnp: true } : {}), ...(str(kid(s, 'convert')?.[1]) === '2' ? { convert: true } : {}) });
    }
    for (const sh of kids(root, 'sheet')) {
      const at = P(kid(sh, 'at')), sz = kid(sh, 'size'); const w = mil(sz?.[1]), h = mil(sz?.[2]);
      const sname = prop(sh, 'Sheetname') || prop(sh, 'Sheet name') || `SHEET${page.blocks.length + 1}`, file = prop(sh, 'Sheetfile') || prop(sh, 'Sheet file');
      const suuid = str(kid(sh, 'uuid')?.[1]);
      const childSch = file.replace(/\.kicad_sch$/i, '').replace(/[\\/]/g, '_') || sname;
      const pins = kids(sh, 'pin').map((p) => { const pa = P(kid(p, 'at')); const side = pa.x <= at.x + 1 ? 'left' as const : pa.x >= at.x + w - 1 ? 'right' as const : pa.y <= at.y + 1 ? 'top' as const : 'bottom' as const; const dir = str(p[2]); return { name: str(p[1]), dir: (dir === 'input' ? 'input' : dir === 'output' ? 'output' : dir === 'bidirectional' ? 'bidirectional' : 'passive') as 'input', side, offset: side === 'left' || side === 'right' ? pa.y - at.y : pa.x - at.x }; });
      page.blocks.push({ id: nid(d), ref: sname, schematic: childSch, x: at.x, y: at.y, w, h, pins });
      const childPath = `${uuidPath}/${suuid}`;
      pathNames.set(childPath, blockPath ? `${blockPath}/${sname}` : sname);
      if (!loaded.has(file) && opts.readFile) { const t = opts.readFile(file); if (t !== null) { loaded.set(file, childSch); load(t, childSch, childPath, blockPath ? `${blockPath}/${sname}` : sname); } }
      else if (loaded.has(file)) {
        // a second use of the same sheet file: its parts' references for this path are occurrences
        const t = opts.readFile?.(file);
        if (t) { const top2 = parseSExpr(t); const r2 = (top2.find((f) => isList(f) && f[0] === 'kicad_sch') ?? top2[0]) as SList; for (const s2 of kids(r2, 'symbol')) { const i2 = refFor(s2, childPath); const base = refFor(s2, [...pathNames.keys()].find((k) => pathNames.get(k)?.endsWith(`/${loaded.get(file)}`) || false) ?? ''); const r0 = base?.ref ?? prop(s2, 'Reference'); if (i2?.ref && r0) { const key = `${blockPath ? blockPath + '/' : ''}${sname}/${r0}`; d.occurrences[key] = { path: key, ref: i2.ref }; } } }
      }
    }
    const existing = d.schematics.find((x) => x.name === schName);
    if (existing) existing.pages.push(page); else d.schematics.push({ name: schName, pages: [page] });
  };
  const rootName = opts.name ? `${opts.name}` : 'ROOT';
  load(text, rootName, '', '');
  // child sheets are added before their parent: the root is the top file, not the first schematic
  d.root = rootName;
  void rootUuid;
  return d;
}
