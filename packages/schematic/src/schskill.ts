/**
 * OpenSKILL for schematics: the SKILL interpreter of the board editor with a sch* API (the counterpart of Capture's
 * Tcl and System Capture's SKILL access to the design database). Objects are database handles: part~>ref,
 * part~>value, part~>props, net~>name, net~>pins, ...; assigning part~>value = "10k" edits the design.
 *
 *   schDesign()                         the design handle (~>name ~>root ~>schematics ~>pages)
 *   schPages()                          list of "SCHEMATIC/PAGE" names
 *   schParts([page])                    part handles (all pages, or "SCH/PAGE")
 *   schFindPart(ref)                    the part with that reference
 *   schNets()                           net handles (~>name ~>pins ~>global)
 *   schNet(name)                        one net
 *   schSetProp(part name value)         set an instance property ("Value", "PCB Footprint", any other)
 *   schPlace(lib part ref x y [?rot r] [?page "SCH/PAGE"])   place a library part
 *   schWire(list(x1 y1 x2 y2 ...) [?page])                    draw a wire
 *   schAlias(name x y [?page]) schPower(net x y [?style s] [?page]) schPort(name x y [?dir d] [?page])
 *   schDelete(handle)                   delete a part / wire / ...
 *   schAnnotate([?reset t])  schErc()  schBom()  schNetlist([format])  schLibraries()  schLibParts(lib)
 */
import { Skill, SkillError, type Val, type DbObj, type SkillHost } from '../../editor/src/skill.js';
import type { Project } from '../../editor/src/model.js';
import { type Design, type Page, type PartInst, nid, libPart, propOf, allPages, schematicOf } from './model.js';
import { buildNetlist, type FlatNet } from './connect.js';
import { annotate } from './annotate.js';
import { runErc } from './erc.js';
import { bom, kicadNetlist, telesisNetlist, edifNetlist, spiceNetlist } from './netlist.js';

const S = (s: string) => ({ sym: s });
const nil = null;

export interface SchSkillHost extends SkillHost { changed?: () => void; page?: () => { sch: string; page: string } }

/** A SKILL interpreter bound to a schematic design. */
export function schSkill(d: Design, host: SchSkillHost = {}): Skill {
  const empty: Project = { name: 'schematic', units: 'mm', board: { outline: [] }, layers: [], footprints: {}, components: [], nets: [], traces: [], vias: [], rules: { clearance: 0.2, traceWidth: 0.25, viaDrill: 0.3, viaDiameter: 0.6 } } as unknown as Project;
  const sk = new Skill(empty, host);
  const g = sk.global;
  const def = (name: string, fn: (a: Val[], kw: Record<string, Val>) => Val) => g.def(name, { fn: (a, _e, kw) => fn(a, kw), name });
  const str = (v: Val, what: string): string => { if (typeof v === 'string') return v; if (v && typeof v === 'object' && 'sym' in (v as object)) return (v as { sym: string }).sym; throw new SkillError(`${what}: expected a string`); };
  const numv = (v: Val, what: string): number => { if (typeof v !== 'number') throw new SkillError(`${what}: expected a number`); return v; };
  const changed = () => host.changed?.();
  const pageOf = (spec?: Val): Page => {
    let s: string, p: string;
    if (typeof spec === 'string') [s, p] = spec.includes('/') ? spec.split('/') : [d.root, spec];
    else { const cur = host.page?.(); s = cur?.sch ?? d.root; p = cur?.page ?? schematicOf(d, s)?.pages[0]?.name ?? ''; }
    const pg = schematicOf(d, s)?.pages.find((x) => x.name === p);
    if (!pg) throw new SkillError(`no page ${s}/${p}`);
    return pg;
  };
  const partObj = (pi: PartInst, where: string): DbObj => ({
    db: 'part', raw: pi,
    get: (k) => {
      switch (k) {
        case 'ref': return pi.ref; case 'part': return pi.part; case 'lib': return pi.lib; case 'unit': return pi.unit;
        case 'x': return pi.x; case 'y': return pi.y; case 'rot': return pi.rot; case 'mirror': return pi.mirror ? true : nil;
        case 'value': return propOf(d, pi, 'Value') ?? nil; case 'footprint': return propOf(d, pi, 'PCB Footprint') ?? nil;
        case 'page': return where; case 'dnp': return pi.dnp ? true : nil;
        case 'props': return Object.entries({ ...(libPart(d, pi.lib, pi.part)?.props ?? {}), ...pi.props }).map(([a, b]) => [a, b]);
        case 'pins': return (libPart(d, pi.lib, pi.part)?.units[pi.unit]?.normal.pins ?? []).map((p) => [p.number, p.name]);
        default: return propOf(d, pi, k) ?? nil;
      }
    },
    put: (k, v) => {
      switch (k) {
        case 'ref': pi.ref = str(v, 'ref'); break;
        case 'x': pi.x = numv(v, 'x'); break; case 'y': pi.y = numv(v, 'y'); break;
        case 'rot': pi.rot = (((numv(v, 'rot') % 360) + 360) % 360) as 0; break;
        case 'unit': pi.unit = numv(v, 'unit'); break; case 'mirror': pi.mirror = v !== nil; break; case 'dnp': pi.dnp = v !== nil; break;
        case 'value': pi.props.Value = str(v, 'value'); break; case 'footprint': pi.props['PCB Footprint'] = str(v, 'footprint'); break;
        default: pi.props[k] = typeof v === 'number' ? String(v) : str(v, k);
      }
      changed();
    },
  });
  const netObj = (n: FlatNet): DbObj => ({ db: 'net', raw: n, get: (k) => (k === 'name' ? n.name : k === 'pins' ? n.nodes.map((x) => `${x.ref}-${x.pin}`) : k === 'global' ? (n.global ? true : nil) : k === 'aliases' ? n.aliases : nil) });
  const allParts = (): DbObj[] => allPages(d).flatMap(({ sch, page }) => page.parts.map((pi) => partObj(pi, `${sch.name}/${page.name}`)));

  def('schDesign', () => ({ db: 'design', raw: d, get: (k: string) => (k === 'name' ? d.name : k === 'root' ? d.root : k === 'schematics' ? d.schematics.map((s) => s.name) : k === 'pages' ? allPages(d).map(({ sch, page }) => `${sch.name}/${page.name}`) : k === 'libraries' ? d.libraries.map((l) => l.name) : nil) }) as DbObj);
  def('schPages', () => allPages(d).map(({ sch, page }) => `${sch.name}/${page.name}`));
  def('schParts', (a) => (a[0] ? pageOf(a[0]).parts.map((pi) => partObj(pi, String(a[0]))) : allParts()));
  def('schFindPart', (a) => allParts().find((p) => p.get('ref') === str(a[0], 'schFindPart')) ?? nil);
  def('schNets', () => buildNetlist(d).nets.map(netObj));
  def('schNet', (a) => { const n = buildNetlist(d).nets.find((x) => x.name === str(a[0], 'schNet')); return n ? netObj(n) : nil; });
  def('schSetProp', (a) => { const p = a[0] as DbObj; if (!p || (p as DbObj).db !== 'part') throw new SkillError('schSetProp: expected a part'); p.put!(str(a[1], 'name'), a[2]); return true; });
  def('schLibraries', () => d.libraries.map((l) => l.name));
  def('schLibParts', (a) => Object.keys(d.libraries.find((l) => l.name === str(a[0], 'schLibParts'))?.parts ?? {}));
  def('schPlace', (a, kw) => {
    const lib = str(a[0], 'lib'), part = str(a[1], 'part');
    const lp = libPart(d, lib, part); if (!lp) throw new SkillError(`schPlace: no part ${lib}:${part}`);
    const pg = pageOf(kw.page ?? undefined);
    const pi: PartInst = { id: nid(d), lib, part, unit: 0, ref: a[2] ? str(a[2], 'ref') : `${lp.refPrefix}?`, x: numv(a[3], 'x'), y: numv(a[4], 'y'), rot: ((typeof kw.rot === 'number' ? kw.rot : 0) % 360) as 0, props: {} };
    pg.parts.push(pi); changed();
    return partObj(pi, '');
  });
  def('schWire', (a, kw) => {
    const xs = (a[0] as Val[]).map((v) => numv(v, 'schWire'));
    const pts = []; for (let i = 0; i + 1 < xs.length; i += 2) pts.push({ x: xs[i], y: xs[i + 1] });
    if (pts.length < 2) throw new SkillError('schWire: at least two points');
    const pg = pageOf(kw.page ?? undefined); const w = { id: nid(d), pts }; pg.wires.push(w); changed();
    return { db: 'wire', raw: w, get: (k: string) => (k === 'id' ? w.id : nil) } as DbObj;
  });
  def('schAlias', (a, kw) => { const pg = pageOf(kw.page ?? undefined); pg.aliases.push({ id: nid(d), at: { x: numv(a[1], 'x'), y: numv(a[2], 'y') }, name: str(a[0], 'name') }); changed(); return true; });
  def('schPower', (a, kw) => { const pg = pageOf(kw.page ?? undefined); const net = str(a[0], 'net'); pg.globals.push({ id: nid(d), at: { x: numv(a[1], 'x'), y: numv(a[2], 'y') }, net, style: (kw.style ? str(kw.style, 'style') : /GND|VSS/i.test(net) ? 'ground' : 'power_bar') as 'ground' }); changed(); return true; });
  def('schPort', (a, kw) => { const pg = pageOf(kw.page ?? undefined); pg.ports.push({ id: nid(d), at: { x: numv(a[1], 'x'), y: numv(a[2], 'y') }, name: str(a[0], 'name'), dir: (kw.dir ? str(kw.dir, 'dir') : 'bidirectional') as 'input' }); changed(); return true; });
  def('schDelete', (a) => {
    const h = a[0] as DbObj; if (!h || typeof h !== 'object' || !('db' in h)) throw new SkillError('schDelete: expected a handle');
    for (const { page } of allPages(d)) for (const k of ['parts', 'wires'] as const) { const arr = page[k] as { id: number }[]; const i = arr.indexOf(h.raw as { id: number }); if (i >= 0) { arr.splice(i, 1); changed(); return true; } }
    return nil;
  });
  def('schAnnotate', (_a, kw) => { const r = annotate(d, { reset: kw.reset !== undefined && kw.reset !== nil }); changed(); return r.changed.map((c) => [c.was, c.is]); });
  def('schErc', () => runErc(d).map((m) => [S(m.severity), m.kind, m.message]));
  def('schBom', () => bom(d).rows.map((r) => [r.qty, r.refs.join(' '), r.value, r.footprint]));
  def('schNetlist', (a) => { const f = a[0] ? str(a[0], 'format') : 'kicad'; return f === 'telesis' ? telesisNetlist(d) : f === 'edif' ? edifNetlist(d) : f === 'spice' ? spiceNetlist(d).text : kicadNetlist(d); });
  return sk;
}
