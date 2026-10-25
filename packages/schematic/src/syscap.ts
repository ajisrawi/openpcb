/**
 * Allegro System Capture design archives (.sdax: a ZIP in the OpenDocument style).
 *
 *   worklib/<cell>/tbl_1/<cell>.xcon   the connectivity (Cadence CSSchema XML): cells (library, name, terms with
 *                                      direction), nets (name, global scope), instances (cell, pins -> nets),
 *                                      differential nets, net groups
 *   worklib/<cell>/tbl_1/<cell>.json   part objects: properties (VALUE, PART_NAME, JEDEC_TYPE, ...) and per instance
 *                                      path ("@worklib.cell(tbl_1):\I17\") the reference designator
 *   worklib/<cell>/tbl_1/page_file_N.ascii, cache/<lib>##<cell>##sym_1.ascii   drawings in the System Capture
 *                                      object serialisation (not read: the import draws the logic itself)
 *
 * The import is exact on the logic — parts, properties, reference designators, nets — and draws it: every part as a
 * box symbol from its terms, placed on a grid, each pin with a short wire carrying its net's alias (global nets get
 * power / ground symbols). Instances of another design of the archive become hierarchical blocks.
 */
import { type Design, type Page, type LibPart, type SymPin, type PinType, type Library, newDesign, newPage, nid } from './model.js';
import { parseXml, type XmlNode } from '../../editor/src/imports.js';
import { unzip } from './unzip.js';

interface XCell { id: string; library: string; name: string; terms: { id: string; name: string; dir: string }[] }
interface XInst { id: string; cell: string; name: string; pins: { term: string; nets: string[] }[] }
interface XDesign { name: string; cells: Map<string, XCell>; nets: Map<string, { name: string; global: boolean }>; insts: XInst[]; pairs: { name: string; p: string; n: string }[]; ports: { name: string; dir: string }[] }

const kids = (n: XmlNode | undefined, tag: string): XmlNode[] => (n ? n.children.filter((c) => c.tag === tag) : []);
const kid = (n: XmlNode | undefined, tag: string): XmlNode | undefined => n?.children.find((c) => c.tag === tag);
const text = (n: XmlNode | undefined, tag: string): string => (kid(n, tag)?.text ?? '').trim();

function readXcon(xml: string): XDesign[] {
  // the document node wraps <schema>, which holds <designs>
  const find = (n: XmlNode, tag: string, depth = 0): XmlNode | undefined => (n.tag === tag ? n : depth > 3 ? undefined : n.children.map((c) => find(c, tag, depth + 1)).find(Boolean));
  const designsNode = find(parseXml(xml), 'designs');
  const out: XDesign[] = [];
  for (const dn of kids(designsNode, 'design')) {
    const cells = new Map<string, XCell>();
    for (const c of kids(kid(dn, 'cells'), 'cell')) cells.set(text(c, 'id'), { id: text(c, 'id'), library: text(c, 'library'), name: text(c, 'name'), terms: kids(kid(c, 'terms'), 'term').map((t) => ({ id: text(t, 'id'), name: text(t, 'name'), dir: text(t, 'direction') })) });
    const nets = new Map<string, { name: string; global: boolean }>();
    for (const n of kids(kid(dn, 'nets'), 'net')) nets.set(text(n, 'id'), { name: text(n, 'name'), global: text(n, 'scope') === 'global' });
    const insts: XInst[] = kids(kid(dn, 'instances'), 'instance').map((i) => ({ id: text(i, 'id'), cell: text(i, 'cellid'), name: text(i, 'name'), pins: kids(kid(i, 'pins'), 'pin').map((p) => ({ term: text(p, 'termid'), nets: kids(kid(p, 'connections'), 'connection').map((c) => c.attrs.net).filter(Boolean) })) }));
    const pairs = kids(kid(dn, 'differentialnets'), 'differentialnet').map((x) => ({ name: text(x, 'name'), p: text(x, 'positive') || text(x, 'netp'), n: text(x, 'negative') || text(x, 'netn') }));
    const ports = kids(kid(dn, 'terms'), 'term').map((t) => ({ name: text(t, 'name'), dir: text(t, 'direction') }));
    out.push({ name: dn.attrs.name, cells, nets, insts, pairs, ports });
  }
  return out;
}

const PTYPE = (dir: string): PinType => (/^in$|input/i.test(dir) ? 'input' : /^out$|output/i.test(dir) ? 'output' : /power/i.test(dir) ? 'power' : 'passive');
const PORTDIR = (dir: string) => (/^in$|input/i.test(dir) ? 'input' as const : /^out$|output/i.test(dir) ? 'output' as const : 'bidirectional' as const);

/** A box symbol from a cell's terms: inputs left, outputs right, others split left / right. */
function boxPart(cell: XCell, prefix: string, units = 1): LibPart {
  const left: XCell['terms'] = [], right: XCell['terms'] = [];
  cell.terms.forEach((t, i) => { const ty = PTYPE(t.dir); if (ty === 'output') right.push(t); else if (ty === 'input') left.push(t); else (i % 2 ? right : left).push(t); });
  const P = 100, L = 200, rows = Math.max(left.length, right.length, 1);
  const longest = Math.max(3, ...cell.terms.map((t) => t.name.length));
  const w = Math.max(400, Math.ceil((longest * 2 * 40 + 160) / 100) * 100), h = (rows + 1) * P;
  const numeric = cell.terms.every((t) => /^\d+$/.test(t.name));
  const num = (t: XCell['terms'][number]) => (numeric ? t.name : String(cell.terms.indexOf(t) + 1));
  const pins: SymPin[] = [
    ...left.map((t, i): SymPin => ({ number: num(t), name: t.name, type: PTYPE(t.dir), x: -L, y: (i + 1) * P, length: L, orient: 'left' })),
    ...right.map((t, i): SymPin => ({ number: num(t), name: t.name, type: PTYPE(t.dir), x: w + L, y: (i + 1) * P, length: L, orient: 'right' })),
  ];
  // gates sharing one reference designator are units of one package; pin numbers continue unit after unit (the
  // archive has no physical pin map — the packager assigns it)
  const n = cell.terms.length;
  const unitPins = (u: number): SymPin[] => pins.map((p) => ({ ...p, number: units > 1 ? String(Number(numeric ? p.number : cell.terms.findIndex((t) => t.name === p.name) + 1) + u * n) : p.number }));
  const graphics = [{ kind: 'rect' as const, x1: 0, y1: 0, x2: w, y2: h }, { kind: 'text' as const, at: { x: w / 2, y: h / 2 + 20 }, text: cell.name, size: 50, anchor: 'middle' as const }];
  return { name: `${cell.library}:${cell.name}`, refPrefix: prefix, units: Array.from({ length: units }, (_, u) => ({ normal: { graphics, pins: unitPins(u) } })), props: { Value: cell.name }, kind: 'part', description: `System Capture ${cell.library}/${cell.name}` };
}

const GROUND = /^(0|GND|AGND|DGND|VSS|GND_.*)$/i;

export function importSystemCapture(data: Uint8Array, name = 'design'): { design: Design; notes: string[] } {
  const files = unzip(data);
  const dec = new TextDecoder();
  const notes: string[] = [];
  const xconFiles = [...files.keys()].filter((k) => /^worklib\/[^/]+\/tbl_\d+\/[^/]+\.xcon$/i.test(k));
  if (!xconFiles.length) throw new Error('no worklib/<cell>/tbl_1/<cell>.xcon in the archive: not a System Capture design');
  const designs = new Map<string, XDesign>();
  for (const f of xconFiles) for (const x of readXcon(dec.decode(files.get(f)!))) designs.set(x.name, x);
  // properties and designators per instance path, from the part objects
  const instProps = new Map<string, { refdes?: string; props: Record<string, string> }>();
  for (const f of [...files.keys()].filter((k) => /^worklib\/[^/]+\/tbl_\d+\/[^/]+\.json$/i.test(k) && !/dx\.json$/i.test(k))) {
    try {
      const j = JSON.parse(dec.decode(files.get(f)!)) as { objects?: { type: string; properties?: Record<string, string>; meta?: { instances?: { name: string; value: string; data?: { name: string; value: string }[] }[] } }[] };
      for (const o of j.objects ?? []) if (o.type === 'part') for (const ins of o.meta?.instances ?? []) {
        const m = /\\([^\\]+)\\?$/.exec(ins.value); if (!m) continue;
        const des = /@\w+\.([^(]+)\(/.exec(ins.value)?.[1] ?? '';
        instProps.set(`${des}|${m[1]}`, { refdes: ins.data?.find((x) => x.name === 'refdes')?.value, props: { ...(o.properties ?? {}) } });
      }
    } catch (e) { notes.push(`${f}: ${(e as Error).message}`); }
  }
  const used = new Set<string>(); for (const x of designs.values()) for (const i of x.insts) { const c = x.cells.get(i.cell); if (c && designs.has(c.name)) used.add(c.name); }
  const rootName = [...designs.keys()].find((k) => !used.has(k) && k.toLowerCase() === name.toLowerCase()) ?? [...designs.keys()].find((k) => !used.has(k)) ?? [...designs.keys()][0];

  const d = newDesign(name); d.schematics = []; d.root = rootName;
  const lib: Library = { name: `${name}_syscap`, parts: {} };
  d.libraries.push(lib);
  const pairs: { name: string; p: string; n: string }[] = [];
  for (const x of designs.values()) {
    const pages: Page[] = [];
    // sheet size by part count: A up to 12 parts, B up to 24, C beyond (35 per page)
    const total = x.insts.length, size: Page['size'] = total <= 12 ? 'A' : total <= 24 ? 'B' : 'C';
    const COLS = size === 'A' ? 4 : size === 'B' ? 6 : 7, PER_PAGE = size === 'A' ? 12 : size === 'B' ? 24 : 35;
    const mkPage = (n: number) => { const pg = newPage(`PAGE${n}`, size); pg.title = { Title: `${x.name} (System Capture import)`, 'Document Number': x.name, Revision: '', Date: '' }; return pg; };
    let page = mkPage(1); pages.push(page);
    let col = 0, row = 0, perPage = 0;
    const COLW = 2400, ROWH = 1400, X0 = 900, Y0 = 900;
    const stub = (at: { x: number; y: number }, dir: number, net: { name: string; global: boolean } | undefined) => {
      if (!net) { page.noConnects.push({ id: nid(d), at }); return; }
      const end = { x: at.x + dir * 200, y: at.y };
      page.wires.push({ id: nid(d), pts: [at, end] });
      if (net.global) page.globals.push({ id: nid(d), at: end, net: net.name, style: GROUND.test(net.name) ? 'ground' : 'power_bar', rot: dir < 0 ? 90 : 270 });
      else page.aliases.push({ id: nid(d), at: { x: Math.min(at.x, end.x) + 20, y: end.y }, name: net.name });
    };
    // instances sharing a designator: their unit index, and the units each cell needs
    const unitOf = new Map<string, number>(), unitsNeeded = new Map<string, number>(), seenRef = new Map<string, number>();
    for (const inst of x.insts) { const r = instProps.get(`${x.name}|${inst.id}`)?.refdes; if (!r) continue; const u = seenRef.get(r) ?? 0; seenRef.set(r, u + 1); unitOf.set(inst.id, u); const c = x.cells.get(inst.cell); if (c) { const k = `${c.library}:${c.name}`; unitsNeeded.set(k, Math.max(unitsNeeded.get(k) ?? 1, u + 1)); } }
    const sorted = x.insts.slice().sort((a, b) => (instProps.get(`${x.name}|${a.id}`)?.refdes ?? a.name).localeCompare(instProps.get(`${x.name}|${b.id}`)?.refdes ?? b.name, undefined, { numeric: true }));
    for (const inst of sorted) {
      if (perPage >= PER_PAGE) { page = mkPage(pages.length + 1); pages.push(page); perPage = 0; col = 0; row = 0; }
      const cell = x.cells.get(inst.cell); if (!cell) { notes.push(`${x.name}: instance ${inst.id} has an unknown cell ${inst.cell}`); continue; }
      const at = { x: X0 + col * COLW, y: Y0 + row * ROWH };
      if (++col >= COLS) { col = 0; row++; } perPage++;
      const netOf = (termId: string) => { const pin = inst.pins.find((p) => p.term === termId); return pin?.nets[0] ? x.nets.get(pin.nets[0]) : undefined; };
      if (designs.has(cell.name)) {
        // a hierarchical block
        const hgt = (Math.max(1, Math.ceil(cell.terms.length / 2)) + 1) * 100;
        const blk = { id: nid(d), ref: inst.name.toUpperCase(), schematic: cell.name, x: at.x, y: at.y, w: 800, h: hgt, pins: cell.terms.map((t, i) => ({ name: t.name, dir: PORTDIR(t.dir), side: (i % 2 ? 'right' : 'left') as 'left', offset: (Math.floor(i / 2) + 1) * 100 })) };
        page.blocks.push(blk);
        cell.terms.forEach((t, i) => { const side = i % 2 ? 1 : -1; stub({ x: side > 0 ? blk.x + blk.w : blk.x, y: blk.y + (Math.floor(i / 2) + 1) * 100 }, side, netOf(t.id)); });
        continue;
      }
      const ip = instProps.get(`${x.name}|${inst.id}`);
      const ref = ip?.refdes ?? `${inst.name.toUpperCase()}`;
      const key = `${cell.library}:${cell.name}`;
      const need = unitsNeeded.get(key) ?? 1;
      if (!lib.parts[key] || lib.parts[key].units.length < need) lib.parts[key] = boxPart(cell, /^[A-Za-z]+/.exec(ref)?.[0] ?? 'U', need);
      const lp = lib.parts[key];
      const props: Record<string, string> = {};
      for (const [k, v] of Object.entries(ip?.props ?? {})) if (v && !k.startsWith('CDS_')) props[k === 'VALUE' ? 'Value' : k === 'JEDEC_TYPE' ? 'PCB Footprint' : k] = v;
      const unit = unitOf.get(inst.id) ?? 0;
      page.parts.push({ id: nid(d), lib: lib.name, part: key, unit, ref, x: at.x, y: at.y, rot: 0, props, occKey: inst.id });
      for (const pin of lp.units[unit].normal.pins) {
        const term = cell.terms.find((t) => t.name === pin.name)!;
        stub({ x: at.x + pin.x, y: at.y + pin.y }, pin.orient === 'left' ? -1 : 1, netOf(term.id));
      }
    }
    // the design's own interface: hierarchical ports on its nets
    if (x.ports.length) {
      let py = Y0; for (const pt of x.ports) { const at = { x: 200, y: py }; py += 200; page.ports.push({ id: nid(d), at, name: pt.name, dir: PORTDIR(pt.dir) }); page.wires.push({ id: nid(d), pts: [at, { x: at.x + 300, y: at.y }] }); page.aliases.push({ id: nid(d), at: { x: at.x + 120, y: at.y }, name: pt.name }); }
    }
    d.schematics.push({ name: x.name, pages });
    for (const pr of x.pairs) { const pn = x.nets.get(pr.p)?.name ?? pr.p, nn = x.nets.get(pr.n)?.name ?? pr.n; if (pn && nn) pairs.push({ name: pr.name || pn, p: pn, n: nn }); }
    notes.push(`${x.name}: ${x.insts.length} instances, ${x.nets.size} nets, ${pages.length} page(s)`);
  }
  if (pairs.length) { d.constraints = { nets: {}, classes: [], pairs: [], groups: [] }; for (const pr of pairs) { d.constraints.nets[pr.p] = { diffPair: pr.name }; d.constraints.nets[pr.n] = { diffPair: pr.name }; } notes.push(`${pairs.length} differential pairs`); }
  return { design: d, notes };
}

/** Logical netlist of a System Capture archive straight from its .xcon (for validation): net name -> "REF TERM" set. */
export function systemCaptureNets(data: Uint8Array, opts: { byInstance?: boolean } = {}): Map<string, Set<string>> {
  const files = unzip(data); const dec = new TextDecoder(); const out = new Map<string, Set<string>>();
  const refs = new Map<string, string>();
  for (const f of [...files.keys()].filter((k) => /tbl_\d+\/[^/]+\.json$/i.test(k) && !/dx\.json$/i.test(k))) {
    const j = JSON.parse(dec.decode(files.get(f)!)) as { objects?: { type: string; meta?: { instances?: { value: string; data?: { name: string; value: string }[] }[] } }[] };
    for (const o of j.objects ?? []) for (const ins of o.meta?.instances ?? []) { const m = /\\([^\\]+)\\?$/.exec(ins.value); const r = ins.data?.find((x) => x.name === 'refdes')?.value; if (m && r) refs.set(m[1], r); }
  }
  for (const f of [...files.keys()].filter((k) => /\.xcon$/i.test(k))) for (const x of readXcon(dec.decode(files.get(f)!))) for (const i of x.insts) {
    const cell = x.cells.get(i.cell); if (!cell) continue;
    for (const p of i.pins) for (const nid2 of p.nets) { const net = x.nets.get(nid2)?.name ?? nid2; const s = out.get(net) ?? new Set(); s.add(`${opts.byInstance ? i.id : refs.get(i.id) ?? i.name.toUpperCase()} ${cell.terms.find((t) => t.id === p.term)?.name ?? p.term}`); out.set(net, s); }
  }
  return out;
}

/** Connectivity of one CSSchema (.xcon) file: net name -> "<instance> <term>" set (instance names as stored). */
export function xconNets(xml: string): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const x of readXcon(xml)) for (const i of x.insts) { const cell = x.cells.get(i.cell); if (!cell) continue; for (const p of i.pins) for (const n of p.nets) { const net = x.nets.get(n)?.name ?? n; const s = out.get(net) ?? new Set(); s.add(`${i.name} ${cell.terms.find((t) => t.id === p.term)?.name ?? p.term}`); out.set(net, s); } }
  return out;
}
