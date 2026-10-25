/**
 * Design tools shared by the CLI and the editor:
 *   constraints   the constraint manager as text (one rule per line) and its forwarding to a board
 *   compare       design differences (parts and connectivity) between two designs (System Capture "Design Differences")
 *   part database link instance properties from a parts database table (Capture CIS): CSV with a header row
 *   replace       find & replace in property values, aliases, ports, off-page names and texts
 */
import type { Project, NetClass, DiffPair, LengthGroup } from '../../editor/src/model.js';
import { type Design, type Constraints, type NetConstraint, type PartInst, allPages, propOf, libPart } from './model.js';
import { buildNetlist } from './connect.js';

/* ---------------------------------------------------------------- constraints */

export const emptyConstraints = (): Constraints => ({ nets: {}, classes: [], pairs: [], groups: [] });

const NUM_KEYS = ['width', 'clearance', 'minLength', 'maxLength', 'current', 'voltage', 'impedance'] as const;

/**
 * Text form:
 *   net NAME key=value ...        keys: class width clearance minLength maxLength current voltage impedance diffPair matchGroup
 *   class NAME key=value ...      keys: width clearance diffGap layers=F.Cu,B.Cu viaTypes=... priority
 *   pair NAME gap tolerance maxUncoupled maxSkew
 *   group NAME tolerance
 */
export function constraintsToText(c: Constraints | undefined): string {
  const k = c ?? emptyConstraints(); const out: string[] = [];
  for (const cl of k.classes) out.push(`class ${cl.name}${cl.width !== undefined ? ` width=${cl.width}` : ''}${cl.clearance !== undefined ? ` clearance=${cl.clearance}` : ''}${cl.diffGap !== undefined ? ` diffGap=${cl.diffGap}` : ''}${cl.layers?.length ? ` layers=${cl.layers.join(',')}` : ''}${cl.viaTypes?.length ? ` viaTypes=${cl.viaTypes.join(',')}` : ''}${cl.priority !== undefined ? ` priority=${cl.priority}` : ''}`);
  for (const p of k.pairs) out.push(`pair ${p.name} ${p.gap} ${p.tolerance} ${p.maxUncoupled} ${p.maxSkew}`);
  for (const g of k.groups) out.push(`group ${g.name} ${g.tolerance}`);
  for (const [n, v] of Object.entries(k.nets)) out.push(`net ${n} ${Object.entries(v).map(([a, b]) => `${a}=${b}`).join(' ')}`);
  return out.join('\n');
}

export function textToConstraints(t: string): Constraints {
  const c = emptyConstraints();
  for (const raw of t.split('\n')) {
    const l = raw.trim(); if (!l || l.startsWith('#')) continue;
    const [kind, name, ...rest] = l.split(/\s+/);
    if (!name) throw new Error(`constraint line needs a name: "${l}"`);
    const kv = Object.fromEntries(rest.filter((x) => x.includes('=')).map((x) => [x.slice(0, x.indexOf('=')), x.slice(x.indexOf('=') + 1)]));
    if (kind === 'net') {
      const nc: NetConstraint = {};
      for (const [a, b] of Object.entries(kv)) { if ((NUM_KEYS as readonly string[]).includes(a)) (nc as Record<string, number>)[a] = Number(b); else if (a === 'class' || a === 'diffPair' || a === 'matchGroup') (nc as Record<string, string>)[a] = b; else throw new Error(`unknown net key ${a}`); }
      c.nets[name] = { ...(c.nets[name] ?? {}), ...nc };
    } else if (kind === 'class') {
      c.classes.push({ name, ...(kv.width ? { width: Number(kv.width) } : {}), ...(kv.clearance ? { clearance: Number(kv.clearance) } : {}), ...(kv.diffGap ? { diffGap: Number(kv.diffGap) } : {}), ...(kv.layers ? { layers: kv.layers.split(',') } : {}), ...(kv.viaTypes ? { viaTypes: kv.viaTypes.split(',') } : {}), ...(kv.priority ? { priority: Number(kv.priority) } : {}) });
    } else if (kind === 'pair') {
      const v = rest.map(Number); c.pairs.push({ name, gap: v[0] ?? 0.15, tolerance: v[1] ?? 0.05, maxUncoupled: v[2] ?? 5, maxSkew: v[3] ?? 0.5 });
    } else if (kind === 'group') c.groups.push({ name, tolerance: Number(rest[0] ?? 1) });
    else throw new Error(`unknown constraint kind "${kind}"`);
  }
  return c;
}

/** Apply the design's constraints to a board created / updated from it. Returns notes. */
export function applyConstraintsToBoard(d: Design, p: Project): string[] {
  const c = d.constraints; const notes: string[] = []; if (!c) return notes;
  const netNames = new Set(p.nets.map((n) => n.name));
  for (const n of p.nets) { const k = c.nets[n.name]; if (!k) continue; if (k.width !== undefined) n.width = k.width; if (k.clearance !== undefined) n.clearance = k.clearance; if (k.minLength !== undefined) n.minLength = k.minLength; if (k.maxLength !== undefined) n.maxLength = k.maxLength; if (k.current !== undefined) n.current = k.current; }
  for (const n of Object.keys(c.nets)) if (!netNames.has(n)) notes.push(`constraint for net ${n}: no such net on the board`);
  // classes: the class definitions plus their member nets
  const classes: NetClass[] = c.classes.map((cl) => ({ name: cl.name, nets: [], ...(cl.width !== undefined ? { width: cl.width } : {}), ...(cl.clearance !== undefined ? { clearance: cl.clearance } : {}), ...(cl.diffGap !== undefined ? { diffGap: cl.diffGap } : {}), ...(cl.layers ? { layers: cl.layers } : {}), ...(cl.viaTypes ? { viaTypes: cl.viaTypes } : {}), ...(cl.priority !== undefined ? { priority: cl.priority } : {}) }));
  for (const [n, k] of Object.entries(c.nets)) if (k.class && netNames.has(n)) { let cl = classes.find((x) => x.name === k.class); if (!cl) { cl = { name: k.class, nets: [] }; classes.push(cl); } cl.nets.push(n); }
  p.netClasses = [...(p.netClasses ?? []).filter((x) => !classes.some((y) => y.name === x.name)), ...classes];
  // differential pairs: the two nets naming the same pair; P is the one ending in P / + / _P
  const pairs = new Map<string, string[]>(); for (const [n, k] of Object.entries(c.nets)) if (k.diffPair && netNames.has(n)) pairs.set(k.diffPair, [...(pairs.get(k.diffPair) ?? []), n]);
  const dps: DiffPair[] = [];
  for (const [name, nets] of pairs) {
    if (nets.length !== 2) { notes.push(`differential pair ${name} needs exactly two nets (${nets.join(', ') || 'none'})`); continue; }
    const isP = (s: string) => /(_P|\+|P)$/i.test(s) && !/(_N|-|N)$/i.test(s);
    const [pn, nn] = isP(nets[0]) || !isP(nets[1]) ? [nets[0], nets[1]] : [nets[1], nets[0]];
    const pc = c.pairs.find((x) => x.name === name);
    dps.push({ name, p: pn, n: nn, gap: pc?.gap ?? 0.15, tolerance: pc?.tolerance ?? 0.05, maxUncoupled: pc?.maxUncoupled ?? 5, maxSkew: pc?.maxSkew ?? 0.5 });
  }
  p.diffPairs = [...p.diffPairs.filter((x) => !dps.some((y) => y.name === x.name)), ...dps];
  // match groups
  const groups = new Map<string, string[]>(); for (const [n, k] of Object.entries(c.nets)) if (k.matchGroup && netNames.has(n)) groups.set(k.matchGroup, [...(groups.get(k.matchGroup) ?? []), n]);
  const lgs: LengthGroup[] = [...groups].map(([name, nets]) => ({ name, nets, tolerance: c.groups.find((g) => g.name === name)?.tolerance ?? 1 }));
  p.lengthGroups = [...p.lengthGroups.filter((x) => !lgs.some((y) => y.name === x.name)), ...lgs];
  notes.push(`constraints: ${classes.length} classes, ${dps.length} differential pairs, ${lgs.length} match groups, ${Object.keys(c.nets).length} net rules`);
  return notes;
}

/* ---------------------------------------------------------------- compare */

export interface DesignDiff { partsAdded: string[]; partsRemoved: string[]; valueChanged: { ref: string; a: string; b: string }[]; footprintChanged: { ref: string; a: string; b: string }[]; netsAdded: string[]; netsRemoved: string[]; connectionsChanged: { pin: string; a: string; b: string }[]; text: string }

/** Differences between two designs: packaged parts and pin-to-net connectivity (net names may differ). */
export function compareDesigns(a: Design, b: Design): DesignDiff {
  const na = buildNetlist(a), nb = buildNetlist(b);
  const pa = new Map(na.parts.map((p) => [p.ref, p])), pb = new Map(nb.parts.map((p) => [p.ref, p]));
  const r: DesignDiff = { partsAdded: [], partsRemoved: [], valueChanged: [], footprintChanged: [], netsAdded: [], netsRemoved: [], connectionsChanged: [], text: '' };
  for (const [ref, p] of pb) { const q = pa.get(ref); if (!q) { r.partsAdded.push(ref); continue; } if (q.value !== p.value) r.valueChanged.push({ ref, a: q.value, b: p.value }); if (q.footprint !== p.footprint) r.footprintChanged.push({ ref, a: q.footprint, b: p.footprint }); }
  for (const ref of pa.keys()) if (!pb.has(ref)) r.partsRemoved.push(ref);
  // connectivity: a pin changes when the set of pins sharing its net differs
  const groups = (nl: typeof na) => { const m = new Map<string, { name: string; key: string }>(); for (const n of nl.nets) { const key = n.nodes.map((x) => `${x.ref}-${x.pin}`).sort().join(' '); for (const x of n.nodes) m.set(`${x.ref}-${x.pin}`, { name: n.name, key }); } return m; };
  const ga = groups(na), gb = groups(nb);
  for (const [pin, g] of gb) { const h = ga.get(pin); if (h && h.key !== g.key) r.connectionsChanged.push({ pin, a: h.name, b: g.name }); }
  const na2 = new Set(na.nets.map((n) => n.name)), nb2 = new Set(nb.nets.map((n) => n.name));
  r.netsAdded = [...nb2].filter((n) => !na2.has(n)); r.netsRemoved = [...na2].filter((n) => !nb2.has(n));
  const L: string[] = [];
  L.push(`parts: +${r.partsAdded.length} -${r.partsRemoved.length}, ${r.valueChanged.length} values, ${r.footprintChanged.length} footprints changed; nets: +${r.netsAdded.length} -${r.netsRemoved.length}; ${r.connectionsChanged.length} pins changed connection`);
  if (r.partsAdded.length) L.push(`added: ${r.partsAdded.join(' ')}`);
  if (r.partsRemoved.length) L.push(`removed: ${r.partsRemoved.join(' ')}`);
  for (const v of r.valueChanged) L.push(`value ${v.ref}: ${v.a} -> ${v.b}`);
  for (const v of r.footprintChanged) L.push(`footprint ${v.ref}: ${v.a} -> ${v.b}`);
  for (const v of r.connectionsChanged.slice(0, 200)) L.push(`pin ${v.pin}: ${v.a} -> ${v.b}`);
  r.text = L.join('\n');
  return r;
}

/* ---------------------------------------------------------------- part database */

export function parseCsv(t: string): Record<string, string>[] {
  const rows: string[][] = []; let row: string[] = [], cell = '', q = false;
  for (let i = 0; i < t.length; i++) {
    const ch = t[i];
    if (q) { if (ch === '"' && t[i + 1] === '"') { cell += '"'; i++; } else if (ch === '"') q = false; else cell += ch; continue; }
    if (ch === '"') q = true; else if (ch === ',') { row.push(cell); cell = ''; } else if (ch === '\n' || ch === '\r') { if (ch === '\r' && t[i + 1] === '\n') i++; row.push(cell); cell = ''; if (row.some((x) => x !== '')) rows.push(row); row = []; } else cell += ch;
  }
  row.push(cell); if (row.some((x) => x !== '')) rows.push(row);
  const head = rows.shift() ?? [];
  return rows.map((r) => Object.fromEntries(head.map((h, i) => [h.trim(), (r[i] ?? '').trim()])));
}

/**
 * Link parts to database rows: a row matches a part when every `match` column equals the part's property (Value by
 * default; "Part" compares the symbol name). The row's other columns become instance properties.
 */
export function linkPartDatabase(d: Design, rows: Record<string, string>[], opts: { match?: string[]; only?: Set<PartInst> } = {}): { linked: string[]; unmatched: string[] } {
  const match = opts.match ?? ['Value'];
  const linked: string[] = [], unmatched: string[] = [];
  for (const { page } of allPages(d)) for (const pi of page.parts) {
    if (opts.only && !opts.only.has(pi)) continue;
    const val = (k: string) => (k === 'Part' ? pi.part : propOf(d, pi, k) ?? '');
    const row = rows.find((r) => match.every((k) => (r[k] ?? '').toLowerCase() === val(k).toLowerCase() && (r[k] ?? '') !== ''));
    if (!row) { if (!pi.ref.endsWith('?')) unmatched.push(pi.ref); continue; }
    for (const [k, v] of Object.entries(row)) if (v && !match.includes(k) && k !== 'Part' && k !== 'Symbol') pi.props[k] = v;
    linked.push(pi.ref);
  }
  return { linked, unmatched: [...new Set(unmatched)] };
}

/* ---------------------------------------------------------------- replace */

export function replaceInDesign(d: Design, find: string, replace: string, opts: { props?: boolean; names?: boolean; texts?: boolean } = { props: true, names: true, texts: true }): number {
  let n = 0; const rep = (s: string) => { if (!s.includes(find)) return s; n++; return s.split(find).join(replace); };
  for (const { page } of allPages(d)) {
    // effective values: a library value that changes becomes an instance override
    if (opts.props) for (const pi of page.parts) { const lib = libPart(d, pi.lib, pi.part)?.props ?? {}; for (const k of new Set([...Object.keys(lib), ...Object.keys(pi.props)])) { const cur = pi.props[k] ?? lib[k] ?? ''; const nv = rep(cur); if (nv !== cur) pi.props[k] = nv; } }
    if (opts.names) { for (const a of page.aliases) a.name = rep(a.name); for (const p of page.ports) p.name = rep(p.name); for (const o of page.offPages) o.name = rep(o.name); for (const g of page.globals) g.net = rep(g.net); }
    if (opts.texts) for (const t of page.texts) t.text = rep(t.text);
  }
  return n;
}
