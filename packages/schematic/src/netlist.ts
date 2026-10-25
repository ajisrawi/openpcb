/**
 * Outputs of the schematic: forward annotation to OpenBoard (create / update a board with an ECO report), netlists
 * (OpenBoard JSON, KiCad .net, Allegro third-party / Telesis, EDIF 2.0.0, SPICE), bill of materials and the cross
 * reference report.
 */
import { applyConstraintsToBoard } from './design_tools.js';
import { type Design, propOf, unitLetter, PAGE_SIZES, allPages, libPart } from './model.js';
import { buildNetlist, type Netlist } from './connect.js';
import { type Project, type Footprint, type Pad, newProject, normalizeProject } from '../../editor/src/model.js';
import { defaultLibrary } from '../../editor/src/footprints.js';

/** A footprint for a part whose PCB Footprint is unknown: its pin numbers as pads on a dual row (1.27 mm pitch). */
export function placeholderFootprint(name: string, pinNumbers: string[]): Footprint {
  const n = pinNumbers.length, rows = Math.ceil(n / 2), pads: Pad[] = [];
  pinNumbers.forEach((num, i) => { const left = i < rows; const k = left ? i : n - 1 - i; pads.push({ id: num, x: left ? -2.5 : 2.5, y: (k - (rows - 1) / 2) * 1.27, w: 1.5, h: 0.6, shape: 'rect', th: false }); });
  return { name, pads, outline: [[{ x: -1.5, y: -rows * 0.65 - 0.3 }, { x: 1.5, y: -rows * 0.65 - 0.3 }, { x: 1.5, y: rows * 0.65 + 0.3 }, { x: -1.5, y: rows * 0.65 + 0.3 }, { x: -1.5, y: -rows * 0.65 - 0.3 }]], body: { w: 3, h: rows * 1.3 + 0.6 } };
}

export interface EcoReport { constraints?: string[]; added: string[]; removed: string[]; footprintChanged: string[]; valueChanged: string[]; netsAdded: string[]; netsRemoved: string[]; netsChanged: string[]; placeholders: string[]; missingPins: string[] }

/**
 * Forward annotation: bring a board (new or existing) in line with the schematic. Parts are matched by reference;
 * new parts are placed in a row beside the board outline; removed parts are deleted unless locked; nets are
 * replaced by the schematic's (net settings of surviving nets are kept). Unknown footprints get a placeholder.
 */
export function toBoard(d: Design, board?: Project, opts: { variant?: string; extraFootprints?: Record<string, Footprint> } = {}): { project: Project; report: EcoReport } {
  const p = board ? normalizeProject(board) : newProject(d.name, 2);
  const nl = buildNetlist(d, { variant: opts.variant });
  const lib: Record<string, Footprint> = { ...defaultLibrary(), ...(opts.extraFootprints ?? {}), ...p.footprints };
  const report: EcoReport = { added: [], removed: [], footprintChanged: [], valueChanged: [], netsAdded: [], netsRemoved: [], netsChanged: [], placeholders: [], missingPins: [] };
  const pinsOf = new Map<string, Set<string>>();
  for (const n of nl.nets) for (const nd of n.nodes) { const s = pinsOf.get(nd.ref) ?? new Set(); s.add(nd.pin); pinsOf.set(nd.ref, s); }
  const want = new Map(nl.parts.map((pp) => [pp.ref, pp]));
  const xs = p.outline.map((q) => q.x), ys = p.outline.map((q) => q.y);
  let px = Math.max(...xs) + 5, py = Math.max(...ys);
  for (const pp of nl.parts) {
    let fpName = pp.footprint;
    // every pin number the symbol uses (all units) must exist as a pad
    const lp = libPart(d, pp.lib, pp.part);
    const nums = [...new Set((lp?.units ?? []).flatMap((u) => u.normal.pins.map((x) => x.number)).filter(Boolean))];
    let fp = fpName ? lib[fpName] : undefined;
    if (!fp) { fpName = fpName ? `${fpName}?` : `PH_${pp.part}`; fp = lib[fpName] ?? placeholderFootprint(fpName, nums.length ? nums : [...(pinsOf.get(pp.ref) ?? [])]); report.placeholders.push(`${pp.ref} (${pp.footprint || 'no footprint'})`); }
    if (!p.footprints[fpName] && !defaultLibrary()[fpName]) p.footprints[fpName] = fp;
    const padIds = new Set(fp.pads.map((x) => x.id));
    for (const pin of pinsOf.get(pp.ref) ?? []) if (!padIds.has(pin)) report.missingPins.push(`${pp.ref}-${pin} (footprint ${fpName})`);
    const c = p.components.find((x) => x.ref === pp.ref);
    if (!c) {
      p.components.push({ ref: pp.ref, footprint: fpName, value: pp.value, x: px, y: py, rot: 0, side: 'front' });
      py -= Math.max(fp.body.h, 2) + 1; if (py < Math.min(...ys)) { py = Math.max(...ys); px += 8; }
      report.added.push(pp.ref);
    } else {
      if (c.footprint !== fpName) { c.footprint = fpName; report.footprintChanged.push(pp.ref); }
      if (c.value !== pp.value) { c.value = pp.value; report.valueChanged.push(pp.ref); }
    }
  }
  for (const c of p.components.slice()) if (!want.has(c.ref) && !c.locked && !/^(TP|FID|MH|H)\d/.test(c.ref) && !c.ref.startsWith('BF_')) { p.components = p.components.filter((x) => x !== c); report.removed.push(c.ref); }
  const oldNets = new Map(p.nets.map((n) => [n.name, n]));
  const newNets = nl.nets.filter((n) => n.nodes.length > 0).map((n) => {
    const pins = [...new Set(n.nodes.map((nd) => `${nd.ref}-${nd.pin}`))];
    const old = oldNets.get(n.name);
    if (!old) report.netsAdded.push(n.name);
    else if (JSON.stringify([...old.pins].sort()) !== JSON.stringify([...pins].sort())) report.netsChanged.push(n.name);
    return { ...(old ?? {}), name: n.name, pins };
  });
  for (const n of p.nets) if (!newNets.some((x) => x.name === n.name)) report.netsRemoved.push(n.name);
  p.nets = newNets;
  // constraint manager rules travel with the netlist
  report.constraints = applyConstraintsToBoard(d, p);
  return { project: p, report };
}

const q = (s: string) => `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;

export function kicadNetlist(d: Design, nl = buildNetlist(d)): string {
  const out = ['(export (version "E")', `  (design (source ${q(d.name)}) (tool "OpenSchematic 0.1") (date ${q(new Date().toISOString())}))`, '  (components'];
  for (const pp of nl.parts) out.push(`    (comp (ref ${q(pp.ref)}) (value ${q(pp.value)}) (footprint ${q(pp.footprint)}) (libsource (lib ${q(pp.lib)}) (part ${q(pp.part)})) (sheetpath (names ${q('/' + pp.path.split('/').slice(0, -1).join('/'))})))`);
  out.push('  )', '  (nets');
  nl.nets.forEach((n, i) => { out.push(`    (net (code "${i + 1}") (name ${q(n.name)})`); for (const nd of n.nodes) out.push(`      (node (ref ${q(nd.ref)}) (pin ${q(nd.pin)}) (pinfunction ${q(nd.pinName)}) (pintype ${q(nd.type)}))`); out.push('    )'); });
  out.push('  )', ')', '');
  return out.join('\n');
}

/** Allegro "third-party" (Telesis) netlist: $PACKAGES / $NETS. */
export function telesisNetlist(d: Design, nl = buildNetlist(d)): string {
  const out = ['$PACKAGES'];
  const groups = new Map<string, string[]>();
  for (const pp of nl.parts) { const k = `! '${pp.footprint || pp.part}' ! '${pp.value}'`; (groups.get(k) ?? groups.set(k, []).get(k)!).push(pp.ref); }
  for (const [k, refs] of groups) out.push(`${k}; ${refs.join(' ')}`);
  out.push('$NETS');
  for (const n of nl.nets) { const nodes = n.nodes.map((nd) => `${nd.ref}.${nd.pin}`); const lines: string[] = []; for (let i = 0; i < nodes.length; i += 8) lines.push(nodes.slice(i, i + 8).join(' ')); out.push(`'${n.name}'; ${lines.join(' ,\n ')}`); }
  out.push('$END', '');
  return out.join('\n');
}

/** EDIF 2.0.0 netlist (cell per library part, one design view with instances and nets). */
export function edifNetlist(d: Design, nl = buildNetlist(d)): string {
  const id = (s: string) => /^[A-Za-z][A-Za-z0-9_]*$/.test(s) ? s : `(rename &${s.replace(/[^A-Za-z0-9_]/g, '_')} ${q(s)})`;
  const ref = (s: string) => (/^[A-Za-z][A-Za-z0-9_]*$/.test(s) ? s : `&${s.replace(/[^A-Za-z0-9_]/g, '_')}`);
  const cells = new Map<string, Set<string>>();
  for (const n of nl.nets) for (const nd of n.nodes) { const s = cells.get(nd.part) ?? new Set(); s.add(nd.pin); cells.set(nd.part, s); }
  const lines = ['(edif ' + id(d.name), '  (edifVersion 2 0 0) (edifLevel 0) (keywordMap (keywordLevel 0))', `  (status (written (timeStamp ${new Date().toISOString().slice(0, 19).replace(/[-T:]/g, ' ')}) (program "OpenSchematic")))`, '  (library PARTS (edifLevel 0) (technology (numberDefinition))'];
  for (const [part, pins] of cells) { lines.push(`    (cell ${id(part)} (cellType GENERIC) (view NETLIST (viewType NETLIST) (interface`); for (const pn of pins) lines.push(`      (port ${id('P' + pn)} (direction INOUT))`); lines.push('    ))))'); }
  lines.push('  )', '  (library DESIGN (edifLevel 0) (technology (numberDefinition))', `    (cell ${id(d.name)} (cellType GENERIC) (view NETLIST (viewType NETLIST) (interface) (contents`);
  for (const pp of nl.parts) lines.push(`      (instance ${id(pp.ref)} (viewRef NETLIST (cellRef ${ref(pp.part)} (libraryRef PARTS))) (property VALUE (string ${q(pp.value)})) (property PCB_FOOTPRINT (string ${q(pp.footprint)})))`);
  for (const n of nl.nets) lines.push(`      (net ${id(n.name)} (joined ${n.nodes.map((nd) => `(portRef ${ref('P' + nd.pin)} (instanceRef ${ref(nd.ref)}))`).join(' ')}))`);
  lines.push('    )))', '  )', `  (design ${id(d.name)} (cellRef ${ref(d.name)} (libraryRef DESIGN)))`, ')', '');
  return lines.join('\n');
}

/** SPICE netlist from the parts' SPICE templates (ground nets become node 0). */
export function spiceNetlist(d: Design, opts: { title?: string; analysis?: string[]; models?: string[] } = {}, nl = buildNetlist(d)): { text: string; skipped: string[] } {
  const node = new Map<string, string>();
  for (const n of nl.nets) for (const nd of n.nodes) node.set(`${nd.ref}|${nd.pin}`, /^(GND|0|AGND|DGND|GNDA|VSS)$/i.test(n.name) ? '0' : n.name.replace(/[^A-Za-z0-9_]/g, '_'));
  const out = [`* ${opts.title ?? d.name} — OpenSchematic`];
  const skipped: string[] = [];
  for (const pp of nl.parts) {
    const lp = libPart(d, pp.lib, pp.part);
    const tpl = pp.props.SPICE ?? lp?.spice;
    if (!tpl) { skipped.push(pp.ref); continue; }
    const pins = [...new Set((lp?.units ?? []).flatMap((u) => u.normal.pins.map((x) => x.number)))];
    const line = tpl.replace(/%r/g, pp.ref.replace(/^[A-Za-z]+/, (m) => (tpl.startsWith(m) ? '' : m)) || pp.ref).replace(/%v/g, pp.value).replace(/%m/g, pp.props.Model ?? pp.value).replace(/%p/g, pins.map((pn) => node.get(`${pp.ref}|${pn}`) ?? `NC_${pp.ref}_${pn}`).join(' ')).replace(/%(\d+)/g, (_, k: string) => node.get(`${pp.ref}|${k}`) ?? `NC_${pp.ref}_${k}`);
    out.push(line);
  }
  out.push(...(opts.models ?? []), ...(opts.analysis ?? []), '.end', '');
  return { text: out.join('\n'), skipped };
}

/** Bill of materials (grouped by value + footprint + part), CSV. */
export function bom(d: Design, opts: { variant?: string; onePerLine?: boolean; props?: string[] } = {}): { csv: string; rows: { refs: string[]; value: string; footprint: string; part: string; qty: number; props: Record<string, string> }[] } {
  const nl = buildNetlist(d, { variant: opts.variant });
  const extra = opts.props ?? ['Manufacturer', 'MPN', 'Description'];
  const rows: { refs: string[]; value: string; footprint: string; part: string; qty: number; props: Record<string, string> }[] = [];
  for (const pp of nl.parts) {
    const k = rows.find((r) => !opts.onePerLine && r.value === pp.value && r.footprint === pp.footprint && r.part === pp.part);
    if (k) { k.refs.push(pp.ref); k.qty++; } else rows.push({ refs: [pp.ref], value: pp.value, footprint: pp.footprint, part: pp.part, qty: 1, props: Object.fromEntries(extra.map((e) => [e, pp.props[e] ?? ''])) });
  }
  const esc = (s: string) => (/[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
  const csv = [['Item', 'Quantity', 'Reference', 'Value', 'Part', 'PCB Footprint', ...extra].join(','), ...rows.map((r, i) => [String(i + 1), String(r.qty), r.refs.join(' '), r.value, r.part, r.footprint, ...extra.map((e) => r.props[e])].map(esc).join(','))].join('\n') + '\n';
  return { csv, rows };
}

/** Cross reference: every part with its page and grid zone (A..H rows, 1..8 columns). */
export function crossReference(d: Design): string {
  const lines = ['Reference\tPart\tValue\tPage\tZone'];
  for (const { sch, page } of allPages(d)) {
    const s = PAGE_SIZES[page.size];
    for (const pi of page.parts) { const lp = libPart(d, pi.lib, pi.part); if (lp?.kind && lp.kind !== 'part') continue; const zone = `${String.fromCharCode(65 + Math.min(7, Math.floor((pi.y / s.h) * 4)))}${1 + Math.min(7, Math.floor((pi.x / s.w) * 8))}`; lines.push(`${pi.ref}${lp && lp.units.length > 1 ? unitLetter(pi.unit) : ''}\t${pi.part}\t${propOf(d, pi, 'Value') ?? ''}\t${sch.name}/${page.name}\t${zone}`); }
  }
  return lines.join('\n') + '\n';
}

export type { Netlist };
