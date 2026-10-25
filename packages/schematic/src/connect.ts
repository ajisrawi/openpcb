/**
 * Connectivity and netlist extraction.
 *
 * Within a page: wires join at shared end points and where an end point touches another wire (a T); wires that only
 * cross join at a junction dot. Pins, power/ground symbols, ports, off-page connectors, net aliases, no-connects and
 * block pins join the wire (or pin) they touch. Within a schematic folder, nets with the same alias name or
 * off-page connector name are one net (all its pages). Power and ground symbols and hidden power pins connect by
 * name across the whole design. Bus names "D[0..7]" / "D[7:0]" expand to members D0..D7: a bus port or block pin
 * connects member by member.
 *
 * Hierarchy: the root schematic is flattened; a block instance of a schematic connects its ports (by name) to the
 * block pins, and the child's parts get the instance path ("AMP1/U3") with reference designators from
 * Design.occurrences (or the instance's own when unique).
 */
import { type Design, type Page, type Pt, type PartInst, type PinType, instPins, instSeg, libPart, propOf, schematicOf, unitLetter, viewOf } from './model.js';

export interface NetNode { ref: string; pin: string; pinName: string; type: PinType; part: string; path: string; inst: PartInst; at: Pt; page: string }
export interface FlatNet { name: string; nodes: NetNode[]; named: boolean; global: boolean; ports: string[]; aliases: string[]; offPages: string[]; noConnect: boolean }
export interface PackagedPart { ref: string; path: string; lib: string; part: string; value: string; footprint: string; props: Record<string, string>; units: Set<number>; insts: PartInst[] }
export interface Netlist { nets: FlatNet[]; parts: PackagedPart[]; issues: { kind: string; message: string; page?: string; at?: Pt }[]; pageNets: Map<string, Map<string, string>> }

/** "D[0..7]", "D[7:0]", "D[0-3]" -> D0..D7; other names -> [name]. */
export function expandBus(name: string): string[] {
  const m = /^(.*?)\[(\d+)\s*(?:\.\.|:|-)\s*(\d+)\](.*)$/.exec(name);
  if (!m) return [name];
  const a = Number(m[2]), b = Number(m[3]), out: string[] = [];
  for (let i = a; a <= b ? i <= b : i >= b; a <= b ? i++ : i--) out.push(`${m[1]}${i}${m[4]}`);
  return out;
}

const key = (p: Pt) => `${Math.round(p.x)},${Math.round(p.y)}`;
const onSeg = (p: Pt, a: Pt, b: Pt) => {
  const cr = (b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x);
  if (Math.abs(cr) > 1e-6 * (Math.abs(b.x - a.x) + Math.abs(b.y - a.y) + 1)) return false;
  return p.x >= Math.min(a.x, b.x) - 1e-6 && p.x <= Math.max(a.x, b.x) + 1e-6 && p.y >= Math.min(a.y, b.y) - 1e-6 && p.y <= Math.max(a.y, b.y) + 1e-6;
};

class UF { p: number[] = []; add() { this.p.push(this.p.length); return this.p.length - 1; } find(x: number): number { while (this.p[x] !== x) { this.p[x] = this.p[this.p.length > x ? this.p[x] : x]; x = this.p[x]; } return x; } union(a: number, b: number) { const ra = this.find(a), rb = this.find(b); if (ra !== rb) this.p[ra] = rb; } }

interface PageGraph {
  uf: UF;
  pins: { node: number; inst: PartInst; idx: number; pin: { number: string; name: string; type: PinType; hidden?: boolean; net?: string }; at: Pt }[];
  names: Map<number, { aliases: string[]; globals: string[]; ports: string[]; offPages: string[]; blockPins: { block: number; pin: string }[]; noConnect: boolean }>;
  wireNode: Map<number, number>;
  pointNodes: Map<string, number[]>;
}

/** Connectivity of one page: union-find nodes for wires and pins, names attached to nodes. */
function pageGraph(d: Design, page: Page): PageGraph {
  const uf = new UF();
  const wireNode = new Map<number, number>();
  const segs: { a: Pt; b: Pt; node: number }[] = [];
  for (const w of page.wires) { const n = uf.add(); wireNode.set(w.id, n); for (let i = 1; i < w.pts.length; i++) segs.push({ a: w.pts[i - 1], b: w.pts[i], node: n }); }
  const ends = new Map<string, number[]>();
  const addEnd = (p: Pt, n: number) => { const k = key(p); const a = ends.get(k) ?? []; a.push(n); ends.set(k, a); };
  for (const w of page.wires) { const n = wireNode.get(w.id)!; addEnd(w.pts[0], n); addEnd(w.pts[w.pts.length - 1], n); }
  // shared end points, and an end point on another wire's interior (T)
  for (const [, ns] of ends) for (let i = 1; i < ns.length; i++) uf.union(ns[0], ns[i]);
  for (const w of page.wires) for (const e of [w.pts[0], w.pts[w.pts.length - 1]]) for (const s of segs) if (s.node !== wireNode.get(w.id) && onSeg(e, s.a, s.b)) uf.union(s.node, wireNode.get(w.id)!);
  // junctions join everything passing through them
  for (const j of page.junctions) { const hit = segs.filter((s) => onSeg(j.at, s.a, s.b)); for (let i = 1; i < hit.length; i++) uf.union(hit[0].node, hit[i].node); }
  /** node of whatever is at point p (a wire through it, or a new point node); creates one when nothing is there */
  const pointNodes = new Map<string, number[]>();
  const attach = (p: Pt): number => {
    const hit = segs.find((s) => onSeg(p, s.a, s.b));
    const k = key(p);
    const list = pointNodes.get(k) ?? [];
    let n: number;
    if (hit) n = hit.node; else if (list.length) n = list[0]; else n = uf.add();
    for (const m of list) uf.union(m, n);
    list.push(n); pointNodes.set(k, list);
    return n;
  };
  const pins: PageGraph['pins'] = [];
  for (const pi of page.parts) instPins(d, pi).forEach(({ pin, at }, idx) => {
    // a hidden power pin joins the net of its name; other hidden pins (stacked pads) connect where they are
    if (pin.hidden && pin.net) { pins.push({ node: uf.add(), inst: pi, idx, pin, at }); return; }
    pins.push({ node: attach(at), inst: pi, idx, pin, at });
  });
  const names: PageGraph['names'] = new Map();
  const nm = (n: number) => { let x = names.get(n); if (!x) { x = { aliases: [], globals: [], ports: [], offPages: [], blockPins: [], noConnect: false }; names.set(n, x); } return x; };
  const pending: [number, (x: ReturnType<typeof nm>) => void][] = [];
  for (const a of page.aliases) { const n = a.wire !== undefined && wireNode.has(a.wire) ? wireNode.get(a.wire)! : attach(a.at); pending.push([n, (x) => x.aliases.push(a.name)]); }
  for (const g of page.globals) { const n = attach(g.at); pending.push([n, (x) => x.globals.push(g.net)]); }
  for (const p of page.ports) { const n = attach(p.at); pending.push([n, (x) => x.ports.push(p.name)]); }
  for (const o of page.offPages) { const n = attach(o.at); pending.push([n, (x) => x.offPages.push(o.name)]); }
  for (const c of page.noConnects) { const n = attach(c.at); pending.push([n, (x) => { x.noConnect = true; }]); }
  for (const b of page.blocks) for (const bp of b.pins) { const n = attach(blockPinAt(b, bp)); pending.push([n, (x) => x.blockPins.push({ block: b.id, pin: bp.name })]); }
  // names are keyed by the final root of each node
  for (const [n, f] of pending) f(nm(n));
  const rooted: PageGraph['names'] = new Map();
  for (const [n, x] of names) { const r = uf.find(n); const y = rooted.get(r) ?? { aliases: [], globals: [], ports: [], offPages: [], blockPins: [], noConnect: false }; y.aliases.push(...x.aliases); y.globals.push(...x.globals); y.ports.push(...x.ports); y.offPages.push(...x.offPages); y.blockPins.push(...x.blockPins); y.noConnect ||= x.noConnect; rooted.set(r, y); }
  return { uf, pins, names: rooted, wireNode, pointNodes };
}

/** Page position of a block pin. */
export function blockPinAt(b: { x: number; y: number; w: number; h: number }, p: { side: string; offset: number }): Pt {
  switch (p.side) { case 'left': return { x: b.x, y: b.y + p.offset }; case 'right': return { x: b.x + b.w, y: b.y + p.offset }; case 'top': return { x: b.x + p.offset, y: b.y }; default: return { x: b.x + p.offset, y: b.y + b.h }; }
}

/**
 * Flatten the design from the root schematic. Returns nets (with their pins), packaged parts and connectivity issues.
 */
export function buildNetlist(d: Design, opts: { variant?: string } = {}): Netlist {
  const issues: Netlist['issues'] = [];
  // global union over (instance path, schematic, page, local node) keys
  const uf = new UF();
  const ids = new Map<string, number>();
  const id = (k: string) => { let v = ids.get(k); if (v === undefined) { v = uf.add(); ids.set(k, v); } return v; };
  const meta = new Map<number, { aliases: Set<string>; globals: Set<string>; ports: Set<string>; childPorts: Set<string>; offPages: Set<string>; noConnect: boolean; local: boolean; path: string }>();
  const metaOf = (n: number, path: string) => { let m = meta.get(n); if (!m) { m = { aliases: new Set(), globals: new Set(), ports: new Set(), childPorts: new Set(), offPages: new Set(), noConnect: false, local: true, path }; meta.set(n, m); } return m; };
  const nodes: { n: number; node: NetNode }[] = [];
  const pageNets = new Map<string, Map<string, string>>();
  const pageNodeKeys: { page: string; path: string; graph: PageGraph; prefix: string }[] = [];
  const namedNodes: [number, string][] = [];
  const variant = opts.variant ? d.variants.find((v) => v.name === opts.variant) : undefined;
  const visit = (schName: string, path: string, depth: number, portMap: Map<string, number>) => {
    if (depth > 32) { issues.push({ kind: 'hierarchy', message: `hierarchy deeper than 32 at ${path}: recursive blocks?` }); return; }
    const sch = schematicOf(d, schName); if (!sch) { issues.push({ kind: 'hierarchy', message: `schematic ${schName} not found (${path || 'root'})` }); return; }
    const folder = `${path}|${schName}`;
    for (const page of sch.pages) {
      const g = pageGraph(d, page);
      const prefix = `${folder}|${page.name}`;
      pageNodeKeys.push({ page: `${schName}/${page.name}`, path, graph: g, prefix });
      const nodeId = (n: number) => id(`${prefix}#${g.uf.find(n)}`);
      for (const pin of g.pins) {
        const ipath = path ? `${path}/${instSeg(pin.inst)}` : instSeg(pin.inst);
        const occ = d.occurrences[ipath];
        const ref = occ?.ref ?? pin.inst.ref;
        // a reused block's part may be a different section per occurrence: same symbol pin, that unit's number
        let number = pin.pin.number;
        if (occ?.unit !== undefined && occ.unit !== pin.inst.unit) { const lp = libPart(d, pin.inst.lib, pin.inst.part); const alt = lp ? viewOf(lp, occ.unit, pin.inst.convert).pins[pin.idx] : undefined; if (alt) number = alt.number; }
        const node: NetNode = { ref, pin: number, pinName: pin.pin.name, type: pin.pin.type, part: pin.inst.part, path: ipath, inst: pin.inst, at: pin.at, page: `${schName}/${page.name}` };
        if (variant?.dnp.includes(ref)) continue;
        if (pin.pin.hidden && pin.pin.net) {
          // POWER_GROUP "VCC=+15V;GND=-15V" maps a hidden power pin to another net (OrCAD)
          const pg = occ?.props?.POWER_GROUP ?? pin.inst.props.POWER_GROUP;
          let net = pin.pin.net;
          if (pg) for (const kv of pg.split(/[;,]/)) { const [k, v] = kv.split('=').map((t) => t.trim()); if (k && v && k.toUpperCase() === net.toUpperCase()) net = v; }
          const gn = id(`global|${net}`); metaOf(gn, '').globals.add(net); nodes.push({ n: gn, node }); continue;
        }
        nodes.push({ n: nodeId(pin.node), node });
      }
      for (const [root, x] of g.names) {
        const n = id(`${prefix}#${root}`);
        const m = metaOf(n, path);
        const on = d.settings.orcadNames;
        // a bus name ("D[0..7]") never joins its node to the members: members join by name, member by member
        const memberKey = (mem: string) => id(`${folder}|${on ? 'name' : 'alias'}|${mem}`);
        for (const a of x.aliases) { const mems = expandBus(a); if (mems.length > 1) continue; m.aliases.add(a); uf.union(n, memberKey(a)); if (on) namedNodes.push([n, a]); }
        for (const o of x.offPages) {
          const mems = expandBus(o); const k = (mem: string) => id(`${folder}|${on ? 'name' : 'offpage'}|${mem}`);
          if (mems.length > 1) { for (const mem of mems) uf.union(k(mem), memberKey(mem)); continue; }
          m.offPages.add(o); uf.union(n, k(o)); if (on) namedNodes.push([n, o]);
        }
        for (const gl of x.globals) { m.globals.add(gl); uf.union(n, id(`global|${gl}`)); }
        // same-named ports of one schematic folder are one net; a root-level port names the net (design I/O), a
        // block's port only names it as "<path>/<port>" fallback
        for (const p of x.ports) {
          const mems = expandBus(p); const k = (mem: string) => id(`${folder}|${on ? 'name' : 'port'}|${mem}`);
          if (mems.length > 1) { for (const mem of mems) { uf.union(k(mem), memberKey(mem)); const up = portMap.get(mem); if (up !== undefined) uf.union(memberKey(mem), up); } continue; }
          if (!path) m.ports.add(p); else m.childPorts.add(`${path}/${p}`);
          uf.union(n, k(p)); if (on) namedNodes.push([n, p]);
          const up = portMap.get(p); if (up !== undefined) uf.union(n, up);
        }
        if (x.noConnect) m.noConnect = true;
        for (const bp of x.blockPins) {
          // remember the outer node of every block pin; a bus pin joins the parent's member names
          const key2 = `${prefix}|block${bp.block}|${bp.pin}`;
          const mems = expandBus(bp.pin);
          if (mems.length > 1) { for (const mem of mems) uf.union(id(`${key2}|${mem}`), id(`${folder}|${d.settings.orcadNames ? 'name' : 'alias'}|${mem}`)); }
          else uf.union(n, id(`${key2}|${mems[0]}`));
        }
      }
      // descend into blocks
      for (const b of page.blocks) {
        const childPath = path ? `${path}/${b.ref}` : b.ref;
        const pm = new Map<string, number>();
        for (const bp of b.pins) for (const mem of expandBus(bp.name)) pm.set(mem, id(`${prefix}|block${b.id}|${bp.name}|${mem}`));
        visit(b.schematic, childPath, depth + 1, pm);
      }
    }
  };
  visit(d.root, '', 0, new Map());
  // OrCAD: an alias / port / off-page connector named like a power net is on that power net
  if (d.settings.orcadNames) { const globalNames = new Set([...ids.keys()].filter((k) => k.startsWith('global|')).map((k) => k.slice(7))); for (const [n, name] of namedNodes) if (globalNames.has(name)) uf.union(n, id(`global|${name}`)); }

  // group pins by net
  const byRoot = new Map<number, NetNode[]>();
  for (const { n, node } of nodes) { const r = uf.find(n); const a = byRoot.get(r) ?? []; a.push(node); byRoot.set(r, a); }
  const metaRoot = new Map<number, { aliases: Set<string>; globals: Set<string>; ports: Set<string>; childPorts: Set<string>; offPages: Set<string>; noConnect: boolean; paths: Set<string> }>();
  for (const [n, m] of meta) {
    const r = uf.find(n);
    const x = metaRoot.get(r) ?? { aliases: new Set(), globals: new Set(), ports: new Set(), childPorts: new Set(), offPages: new Set(), noConnect: false, paths: new Set() };
    m.aliases.forEach((a) => x.aliases.add(a)); m.globals.forEach((a) => x.globals.add(a)); m.ports.forEach((a) => x.ports.add(a)); m.childPorts.forEach((a) => x.childPorts.add(a)); m.offPages.forEach((a) => x.offPages.add(a)); x.noConnect ||= m.noConnect; x.paths.add(m.path);
    metaRoot.set(r, x);
  }
  const nets: FlatNet[] = [];
  const used = new Set<string>();
  let auto = 1;
  const roots = new Set<number>([...byRoot.keys(), ...metaRoot.keys()]);
  for (const r of roots) {
    const pins = byRoot.get(r) ?? [];
    const m = metaRoot.get(r);
    const global = !!m && m.globals.size > 0;
    const pathPrefix = (p: string | undefined) => (p ? `${p}/` : '');
    const anyPath = m ? [...m.paths].sort((a, b) => a.length - b.length)[0] : pins[0]?.path.split('/').slice(0, -1).join('/');
    let name = '';
    if (m?.globals.size) name = [...m.globals].sort()[0];
    else if (m?.ports.size && !anyPath) name = [...m.ports].sort()[0];
    else if (m?.aliases.size) name = pathPrefix(anyPath) + [...m.aliases].sort()[0];
    else if (m?.offPages.size) name = pathPrefix(anyPath) + [...m.offPages].sort()[0];
    else if (m?.childPorts.size) name = [...m.childPorts].sort((a, b) => a.split('/').length - b.split('/').length || a.localeCompare(b))[0];
    const named = !!name;
    if (!name) { if (!pins.length) continue; do name = `N${String(auto++).padStart(5, '0')}`; while (used.has(name)); }
    if (used.has(name)) { issues.push({ kind: 'duplicate-net-name', message: `two different nets are both called ${name}` }); let k = 2; while (used.has(`${name}_${k}`)) k++; name = `${name}_${k}`; }
    used.add(name);
    if (m && m.globals.size > 1) issues.push({ kind: 'power-short', message: `power nets ${[...m.globals].join(', ')} are connected together` });
    if (m && m.aliases.size > 1) issues.push({ kind: 'multiple-aliases', message: `net ${name} has several aliases: ${[...m.aliases].join(', ')}` });
    if (!pins.length && !global) continue;
    nets.push({ name, nodes: pins, named, global, ports: m ? [...m.ports] : [], aliases: m ? [...m.aliases] : [], offPages: m ? [...m.offPages] : [], noConnect: !!m?.noConnect });
  }
  // per-page net names for highlighting: local node root -> net name
  const nameOfRoot = new Map<number, string>();
  for (const net of nets) for (const nd of net.nodes) { const k = nodes.find((x) => x.node === nd); if (k) nameOfRoot.set(uf.find(k.n), net.name); }
  for (const { page, graph, prefix } of pageNodeKeys) {
    const map = pageNets.get(page) ?? new Map<string, string>();
    for (const [wid, n] of graph.wireNode) { const v = ids.get(`${prefix}#${graph.uf.find(n)}`); const name = v !== undefined ? nameOfRoot.get(uf.find(v)) : undefined; if (name) map.set(`w${wid}`, name); }
    pageNets.set(page, map);
  }
  // packaged parts: units of one reference designator are one package
  const parts = new Map<string, PackagedPart>();
  const seenInst = new Set<PartInst>();
  const addPart = (pi: PartInst, path: string) => {
    const ipath = path ? `${path}/${instSeg(pi)}` : instSeg(pi); const occ = d.occurrences[ipath]; const ref = occ?.ref ?? pi.ref; const unit = occ?.unit ?? pi.unit;
    if (variant?.dnp.includes(ref) || pi.dnp) return;
    const lp = libPart(d, pi.lib, pi.part); if (lp?.kind && lp.kind !== 'part') return;
    let pp = parts.get(ref);
    const value = variant?.values?.[ref] ?? occ?.props?.Value ?? propOf(d, pi, 'Value') ?? pi.part;
    if (!pp) { pp = { ref, path: ipath, lib: pi.lib, part: pi.part, value, footprint: propOf(d, pi, 'PCB Footprint') ?? '', props: { ...(lp?.props ?? {}), ...pi.props, ...(occ?.props ?? {}) }, units: new Set(), insts: [] }; parts.set(ref, pp); }
    else if (pp.part !== pi.part) issues.push({ kind: 'package-mismatch', message: `${ref}: units of different parts (${pp.part}, ${pi.part})` });
    if (pp.units.has(unit)) issues.push({ kind: 'duplicate-unit', message: `${ref}${unitLetter(unit)} is placed more than once` });
    pp.units.add(unit); pp.insts.push(pi); seenInst.add(pi);
  };
  const walk = (schName: string, path: string, depth: number) => { if (depth > 32) return; const sch = schematicOf(d, schName); if (!sch) return; for (const pg of sch.pages) { for (const pi of pg.parts) addPart(pi, path); for (const b of pg.blocks) walk(b.schematic, path ? `${path}/${b.ref}` : b.ref, depth + 1); } };
  walk(d.root, '', 0);
  return { nets: nets.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true })), parts: [...parts.values()].sort((a, b) => a.ref.localeCompare(b.ref, undefined, { numeric: true })), issues, pageNets };
}
