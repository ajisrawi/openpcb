/**
 * SPECCTRA design file (.dsn) reader and writer.
 *
 * Reading converts every coordinate to resolution units (integers), honouring
 * `(resolution …)` and `(unit …)` declarations wherever they appear (the
 * language allows them inside structure/placement/library sections).
 */
import { parseSExpr, isList, isAtom, head, children, child, atoms, num, writeSExpr, fmt, type SList, type SNode } from './sexpr.js';
import { type Design, type RuleSet, type Shape, type Keepout, type Layer, type Direction, type LayerType, type Image, type Padstack, type Placement, type Net, type ClassDef, type Wire, type Via, type Resolution, emptyDesign, emptyRuleSet, unitToResolution, type Circuit, type Region} from './model.js';
import type { Pt } from './geom.js';

/* ------------------------------------------------------------------ */
/* reader                                                              */
/* ------------------------------------------------------------------ */

interface Scope { res: Resolution; unit: string; }

export function parseDsn(text: string): Design {
  const forms = parseSExpr(text);
  const pcb = forms.find((f) => head(f) === 'pcb') as SList | undefined;
  if (!pcb) throw new Error('No (pcb …) form found');
  const d = emptyDesign(String(pcb[1] ?? 'board'));

  // parser section
  const parser = child(pcb, 'parser');
  if (parser) {
    const sq = child(parser, 'string_quote'); if (sq) d.parser.stringQuote = String(sq[1]);
    const sp = child(parser, 'space_in_quoted_tokens'); if (sp) d.parser.spaceInQuotedTokens = String(sp[1]).toLowerCase() === 'on';
    const hc = child(parser, 'host_cad'); if (hc) d.parser.hostCad = String(hc[1]);
    const hv = child(parser, 'host_version'); if (hv) d.parser.hostVersion = String(hv[1]);
    const cs = child(parser, 'case_sensitive'); if (cs) d.parser.caseSensitive = String(cs[1]).toLowerCase() !== 'off';
    for (const c of children(parser, 'constant')) d.parser.constants.set(String(c[1]), String(c[2]));
    const wr = child(parser, 'write_resolution'); if (wr) d.parser.writeResolution = { unit: String(wr[1]), value: num(wr[2], 1) };
  }
  const resForm = child(pcb, 'resolution');
  if (resForm) d.resolution = { unit: String(resForm[1]), value: num(resForm[2], 1) };
  else if (d.parser.writeResolution) d.resolution = { ...d.parser.writeResolution };
  const unitForm = child(pcb, 'unit');
  d.unit = unitForm ? String(unitForm[1]) : d.resolution.unit;
  const top: Scope = { res: d.resolution, unit: d.unit };

  const structure = child(pcb, 'structure');
  if (structure) readStructure(d, structure, scoped(structure, top));
  const placement = child(pcb, 'placement');
  if (placement) readPlacement(d, placement, scoped(placement, top));
  const library = child(pcb, 'library');
  if (library) readLibrary(d, library, scoped(library, top));
  const network = child(pcb, 'network');
  if (network) readNetwork(d, network, scoped(network, top));
  const wiring = child(pcb, 'wiring');
  if (wiring) readWiring(d, wiring, scoped(wiring, top));
  return d;
}

/** Apply (resolution)/(unit) declared inside a section. */
function scoped(form: SList, parent: Scope): Scope {
  let res = parent.res, unit = parent.unit;
  const r = child(form, 'resolution'); if (r) res = { unit: String(r[1]), value: num(r[2], 1) };
  const u = child(form, 'unit'); if (u) unit = String(u[1]);
  return { res, unit };
}

function conv(sc: Scope, v: number): number {
  return Math.round(v * unitToResolution(sc.unit, sc.res));
}

/** Merge every (rule …) child of `parent` into one RuleSet (a section may carry several rule forms). */
function readRules(parent: SNode, sc: Scope): RuleSet | undefined {
  const forms = children(parent, 'rule');
  if (!forms.length) return undefined;
  const r = emptyRuleSet();
  for (const form of forms) {
    for (const w of children(form, 'width')) r.width = conv(sc, num(w[1]));
    for (const c of [...children(form, 'clearance'), ...children(form, 'clear')]) {
      const val = conv(sc, num(c[1]));
      const types = children(c, 'type');
      if (types.length === 0) r.clearance.set('default', val);
      for (const t of types) for (const a of atoms(t)) r.clearance.set(a.toLowerCase(), val);
    }
  }
  return r;
}

function readShape(form: SList, sc: Scope): Shape | undefined {
  let k = head(form);
  if (k === 'circ') k = 'circle'; else if (k === 'poly') k = 'polygon';
  const layer = String(form[1] ?? 'pcb');
  const ns = (i: number) => conv(sc, num(form[i]));
  switch (k) {
    case 'circle': return { kind: 'circle', layer, diameter: ns(2), center: form.length > 4 ? { x: ns(3), y: ns(4) } : { x: 0, y: 0 } };
    case 'rect': return { kind: 'rect', layer, rect: { x1: ns(2), y1: ns(3), x2: ns(4), y2: ns(5) } };
    case 'path': case 'polygon': {
      const width = ns(2);
      const pts: Pt[] = [];
      for (let i = 3; i + 1 < form.length; i += 2) {
        if (!isAtom(form[i]) || !isAtom(form[i + 1])) break;
        pts.push({ x: ns(i), y: ns(i + 1) });
      }
      return { kind: k, layer, width, points: pts };
    }
    default: return undefined;
  }
}

function readKeepouts(form: SList, sc: Scope): Keepout[] {
  const out: Keepout[] = [];
  for (const k of (form as SNode[]).filter(isList)) {
    const h = head(k);
    if (h !== 'keepout' && h !== 'via_keepout' && h !== 'wire_keepout' && h !== 'place_keepout') continue;
    let id: string | undefined;
    if (k.length > 1 && isAtom(k[1]) && !isList(k[1])) id = String(k[1]);
    for (const s of k.filter(isList)) {
      const shape = readShape(s, sc);
      if (shape) out.push({ kind: h, id, shape });
    }
  }
  return out;
}

function readStructure(d: Design, s: SList, sc: Scope): void {
  let idx = 0;
  const useNets: { layer: string; net: string }[] = [];
  for (const l of children(s, 'layer')) {
    for (const un of children(l, 'use_net')) for (const n of atoms(un)) useNets.push({ layer: String(l[1]), net: n });
    const lsc = scoped(l, sc);
    const type = (String(child(l, 'type')?.[1] ?? 'signal').toLowerCase()) as LayerType;
    const dirForm = child(l, 'direct') ?? child(l, 'direction');
    const direction = (String(dirForm?.[1] ?? 'off').toLowerCase()) as Direction;
    const layer: Layer = { name: String(l[1]), type, direction, index: idx++, rule: readRules(l, lsc) };
    const prop = child(l, 'property');
    const pi = prop ? child(prop, 'index') : undefined;
    if (pi) layer.index = num(pi[1], layer.index);
    d.structure.layers.push(layer);
  }
  d.structure.layers.sort((a, b) => a.index - b.index);
  d.structure.layers.forEach((l, i) => (l.index = i));

  for (const b of children(s, 'boundary')) {
    for (const sh of b.filter(isList)) { const shape = readShape(sh, sc); if (shape) d.structure.boundary.push({ shape }); }
  }
  const rule = readRules(s, sc);
  if (rule) d.structure.rule = rule;
  for (const v of children(s, 'via')) {
    for (const a of atoms(v)) d.structure.vias.push(a);
    for (const sp of children(v, 'spare')) for (const a of atoms(sp)) d.structure.vias.push(a);
  }
  d.structure.keepouts.push(...readKeepouts(s, sc));
  for (const rg of children(s, 'region')) {
    const id = isAtom(rg[1]) ? String(rg[1]) : `region${(d.structure.regions?.length ?? 0) + 1}`;
    const shapeForm = rg.slice(1).find((x) => isList(x) && ['rect', 'polygon', 'poly', 'circle', 'circ', 'path'].includes(head(x as SList))) as SList | undefined;
    const shape = shapeForm ? readShape(shapeForm, sc) : undefined;
    if (!shape) continue;
    const region: Region = { id, shape, rule: readRules(rg, sc) };
    for (const cr of children(rg, 'region_class_class')) { const cl = child(cr, 'classes'); const r = readRules(cr, sc); if (cl && r) (region.classRules ??= []).push({ classes: atoms(cl), rule: r }); }
    for (const cr of children(rg, 'region_class')) { const r = readRules(cr, sc); if (r) (region.classRules ??= []).push({ classes: atoms(cr), rule: r }); }
    (d.structure.regions ??= []).push(region);
  }
  for (const g of children(s, 'grid')) {
    const what = String(g[1]).toLowerCase();
    if (what === 'wire') d.structure.gridWire = conv(sc, num(g[2]));
    if (what === 'via') d.structure.gridVia = conv(sc, num(g[2]));
  }
  for (const p of children(s, 'plane')) {
    for (const sh of p.filter(isList)) { const shape = readShape(sh, sc); if (shape) d.structure.planes.push({ net: String(p[1]), shape }); }
  }
  for (const c of children(s, 'control')) for (const sub of c.filter(isList)) d.structure.control.set(head(sub), String(sub[1] ?? ''));
  // (layer X (type power) (use_net N)): the whole layer is a plane of net N
  const bnd = d.structure.boundary.find((b) => b.shape.layer.toLowerCase() === 'pcb') ?? d.structure.boundary[0];
  for (const u of useNets) {
    if (d.structure.planes.some((p) => p.net === u.net && p.shape.layer === u.layer)) continue;
    const shape: Shape = bnd ? { ...bnd.shape, layer: u.layer } : { kind: 'rect', layer: u.layer, rect: { x1: -1e9, y1: -1e9, x2: 1e9, y2: 1e9 } };
    d.structure.planes.push({ net: u.net, shape });
  }
}

function readPlacement(d: Design, p: SList, sc: Scope): void {
  for (const comp of children(p, 'component')) {
    const image = String(comp[1]);
    for (const pl of children(comp, 'place')) {
      if (!isAtom(pl[2])) continue; // unplaced component
      const place: Placement = {
        image, ref: String(pl[1]),
        at: { x: conv(sc, num(pl[2])), y: conv(sc, num(pl[3])) },
        side: String(pl[4] ?? 'front').toLowerCase() === 'back' ? 'back' : 'front',
        rotation: num(pl[5], 0),
        locked: false,
      };
      const lt = child(pl, 'lock_type'); if (lt) place.locked = true;
      const pn = child(pl, 'pn'); if (pn) place.partNumber = String(pn[1]);
      d.placement.push(place);
    }
  }
}

function readLibrary(d: Design, lib: SList, sc: Scope): void {
  // (unit …) may be repeated between images; walk sequentially to honour it.
  let cur = sc;
  for (const item of lib.filter(isList)) {
    const h = head(item);
    if (h === 'unit') { cur = { ...cur, unit: String(item[1]) }; continue; }
    if (h === 'resolution') { cur = { ...cur, res: { unit: String(item[1]), value: num(item[2], 1) } }; continue; }
    if (h === 'image') {
      const isc = scoped(item, cur);
      const img: Image = { name: String(item[1]), outline: [], pins: [], keepouts: [] };
      const side = child(item, 'side'); if (side) img.side = String(side[1]).toLowerCase() === 'back' ? 'back' : 'front';
      for (const o of children(item, 'outline')) for (const sh of o.filter(isList)) { const shape = readShape(sh, isc); if (shape) img.outline.push(shape); }
      for (const pin of children(item, 'pin')) {
        // (pin PADSTACK [(rotate deg)] PINID x y)
        let rotation = 0; const rot = child(pin, 'rotate'); if (rot) rotation = num(rot[1]);
        const as = atoms(pin);
        if (as.length < 4) continue;
        img.pins.push({ padstack: as[0], pinId: as[1], at: { x: conv(isc, Number(as[2])), y: conv(isc, Number(as[3])) }, rotation });
      }
      img.keepouts = readKeepouts(item, isc);
      d.library.images.set(img.name, img);
    } else if (h === 'padstack') {
      const psc = scoped(item, cur);
      const ps: Padstack = { name: String(item[1]), shapes: [], attach: true };
      for (const s of children(item, 'shape')) for (const sh of s.filter(isList)) { const shape = readShape(sh, psc); if (shape) ps.shapes.push(shape); }
      const at = child(item, 'attach'); if (at) ps.attach = String(at[1]).toLowerCase() !== 'off';
      d.library.padstacks.set(ps.name, ps);
    }
  }
}

function readCircuit(form: SNode | undefined, sc?: Scope) {
  if (!form) return undefined;
  const c: Circuit = {};
  const uv = child(form, 'use_via'); if (uv) c.useVia = atoms(uv);
  const ul = child(form, 'use_layer'); if (ul) c.useLayer = atoms(ul);
  const pr = child(form, 'priority'); if (pr) c.priority = num(pr[1]);
  const mv = child(form, 'max_total_vias'); if (mv) c.maxTotalVias = num(mv[1]);
  const bs = child(form, 'bus'); if (bs && String(bs[1] ?? 'on').toLowerCase() !== 'off') c.bus = true;
  const mn = child(form, 'match_net_length');
  if (mn && String(mn[1] ?? 'on').toLowerCase() !== 'off') { const tol = child(mn, 'tolerance'); c.matchNetLength = { tolerance: tol && sc ? conv(sc, num(tol[1])) : undefined }; }
  const ln = child(form, 'length'); if (ln && sc) { c.length = { max: conv(sc, num(ln[1])) }; if (ln.length > 2 && isAtom(ln[2]) && /^[-\d.]+$/.test(String(ln[2]))) c.length.min = conv(sc, num(ln[2])); }
  return c;
}

/** (layer_rule <layer…> (rule …)) children: one RuleSet per named layer. */
function readLayerRules(parent: SNode, sc: Scope): Map<string, RuleSet> | undefined {
  const forms = children(parent, 'layer_rule');
  if (!forms.length) return undefined;
  const m = new Map<string, RuleSet>();
  for (const f of forms) { const r = readRules(f, sc); if (!r) continue; for (const l of atoms(f)) if (l !== 'layer_rule') m.set(l, r); }
  return m;
}

function readNetwork(d: Design, n: SList, sc: Scope): void {
  for (const net of children(n, 'net')) {
    const nd: Net = { name: String(net[1]), pins: [] };
    for (const p of children(net, 'pins')) nd.pins.push(...atoms(p));
    nd.rule = readRules(net, sc);
    nd.circuit = readCircuit(child(net, 'circuit'), sc);
    nd.layerRules = readLayerRules(net, sc);
    for (const ft of children(net, 'fromto')) {
      const pins = ft.slice(1).filter(isAtom).map(String);
      if (pins.length >= 2) (nd.fromtos ??= []).push({ a: pins[0], b: pins[1], rule: readRules(ft, sc), circuit: readCircuit(child(ft, 'circuit'), sc) });
    }
    d.network.nets.set(nd.name, nd);
  }
  for (const cls of children(n, 'class')) {
    const cd: ClassDef = { name: String(cls[1]), nets: atoms(cls).slice(1) };
    cd.rule = readRules(cls, sc);
    cd.circuit = readCircuit(child(cls, 'circuit'), sc);
    cd.layerRules = readLayerRules(cls, sc);
    d.network.classes.set(cd.name, cd);
    for (const nn of cd.nets) { const net = d.network.nets.get(nn); if (net) net.className = cd.name; }
  }
  for (const pr of children(n, 'pair')) {
    const nets = child(pr, 'nets'); if (!nets) continue;
    const [p, q] = atoms(nets); if (!p || !q) continue;
    const rule = child(pr, 'rule');
    const gap = rule ? child(rule, 'gap') : undefined, tol = rule ? child(rule, 'tolerance') : undefined;
    (d.network.pairs ??= []).push({ p, n: q, gap: gap ? conv(sc, num(gap[1])) : undefined, tolerance: tol ? conv(sc, num(tol[1])) : undefined });
  }
  for (const cc of children(n, 'class_class')) {
    const cl = child(cc, 'classes'); const rule = readRules(cc, sc);
    if (cl && rule) (d.network.classClass ??= []).push({ classes: atoms(cl), rule });
  }
}

function readWiring(d: Design, w: SList, sc: Scope): void {
  const wsc = scoped(w, sc);
  readWiresInto(w, wsc, d.wiring, undefined);
}

/** Read (wire …)/(via …) children of `form` into `into`; `net` overrides the per-wire (net …). */
export function readWiresInto(form: SList, sc: Scope, into: { wires: Wire[]; vias: Via[] }, net: string | undefined): void {
  for (const w of children(form, 'wire')) {
    const path = child(w, 'path') ?? child(w, 'polyline_path');
    if (!path) continue;
    const shape = readShape(path, sc);
    if (!shape || !shape.points) continue;
    const nn = net ?? String(child(w, 'net')?.[1] ?? '');
    const t = child(w, 'type');
    into.wires.push({ layer: shape.layer, width: shape.width ?? 0, points: shape.points, net: nn, type: t ? (String(t[1]).toLowerCase() as Wire['type']) : undefined });
  }
  for (const v of children(form, 'via')) {
    const nn = net ?? String(child(v, 'net')?.[1] ?? '');
    const t = child(v, 'type');
    into.vias.push({ padstack: String(v[1]), at: { x: conv(sc, num(v[2])), y: conv(sc, num(v[3])) }, net: nn, type: t ? (String(t[1]).toLowerCase() as Via['type']) : undefined });
  }
}

export type { Scope };

/* ------------------------------------------------------------------ */
/* writer                                                              */
/* ------------------------------------------------------------------ */

/** Serialise a Design to .dsn text. Coordinates are emitted in resolution units with (unit = resolution unit). */
export function writeDsn(d: Design): string {
  const res = d.resolution;
  const u = (v: number) => fmt(v / res.value, 6);   // value in resolution unit
  const ptList = (pts: Pt[]) => pts.flatMap((p) => [u(p.x), u(p.y)]);
  const shapeForm = (s: Shape): SList => {
    switch (s.kind) {
      case 'circle': return ['circle', s.layer, u(s.diameter ?? 0), ...(s.center && (s.center.x || s.center.y) ? [u(s.center.x), u(s.center.y)] : [])];
      case 'rect': return ['rect', s.layer, u(s.rect!.x1), u(s.rect!.y1), u(s.rect!.x2), u(s.rect!.y2)];
      case 'path': return ['path', s.layer, u(s.width ?? 0), ...ptList(s.points ?? [])];
      case 'polygon': return ['polygon', s.layer, u(s.width ?? 0), ...ptList(s.points ?? [])];
    }
  };
  const ruleForm = (r: RuleSet | undefined): SList[] => {
    if (!r) return [];
    const f: SList = ['rule'];
    if (r.width !== undefined) f.push(['width', u(r.width)]);
    for (const [t, v] of r.clearance) f.push(t === 'default' ? ['clearance', u(v)] : ['clearance', u(v), ['type', t]]);
    return f.length > 1 ? [f] : [];
  };
  const keepoutForm = (k: Keepout): SList => [k.kind, ...(k.id ? [k.id] : []), shapeForm(k.shape)];

  const pcb: SList = ['pcb', d.id,
    ['parser', ['string_quote', d.parser.stringQuote], ['space_in_quoted_tokens', d.parser.spaceInQuotedTokens ? 'on' : 'off'],
      ['host_cad', d.parser.hostCad ?? 'OpenBoard'], ['host_version', d.parser.hostVersion ?? '0.1']],
    ['resolution', res.unit, String(res.value)],
    ['unit', res.unit],
  ];
  const structure: SList = ['structure'];
  for (const l of d.structure.layers) {
    const lf: SList = ['layer', l.name, ['type', l.type], ['property', ['index', String(l.index)]]];
    if (l.direction && l.direction !== 'off') lf.push(['direct', l.direction]);
    lf.push(...ruleForm(l.rule));
    structure.push(lf);
  }
  for (const b of d.structure.boundary) structure.push(['boundary', shapeForm(b.shape)]);
  for (const p of d.structure.planes) structure.push(['plane', p.net, shapeForm(p.shape)]);
  for (const k of d.structure.keepouts) structure.push(keepoutForm(k));
  for (const rg of d.structure.regions ?? []) {
    const f: SList = ['region', rg.id, shapeForm(rg.shape), ...ruleForm(rg.rule)];
    for (const cr of rg.classRules ?? []) f.push(['region_class_class', ['classes', ...cr.classes], ...ruleForm(cr.rule)]);
    structure.push(f);
  }
  if (d.structure.vias.length) structure.push(['via', ...d.structure.vias]);
  structure.push(...ruleForm(d.structure.rule));
  if (d.structure.gridWire) structure.push(['grid', 'wire', u(d.structure.gridWire)]);
  if (d.structure.gridVia) structure.push(['grid', 'via', u(d.structure.gridVia)]);
  for (const [k, v] of d.structure.control) structure.push(['control', [k, v]]);
  pcb.push(structure);

  const placement: SList = ['placement'];
  const byImage = new Map<string, Placement[]>();
  for (const p of d.placement) { const a = byImage.get(p.image) ?? []; a.push(p); byImage.set(p.image, a); }
  for (const [image, places] of byImage) {
    const c: SList = ['component', image];
    for (const p of places) {
      const pf: SList = ['place', p.ref, u(p.at.x), u(p.at.y), p.side, fmt(p.rotation)];
      if (p.partNumber) pf.push(['PN', p.partNumber]);
      if (p.locked) pf.push(['lock_type', 'position']);
      c.push(pf);
    }
    placement.push(c);
  }
  pcb.push(placement);

  const library: SList = ['library'];
  for (const img of d.library.images.values()) {
    const f: SList = ['image', img.name];
    if (img.side) f.push(['side', img.side]);
    for (const o of img.outline) f.push(['outline', shapeForm(o)]);
    for (const p of img.pins) f.push(p.rotation ? ['pin', p.padstack, ['rotate', fmt(p.rotation)], p.pinId, u(p.at.x), u(p.at.y)] : ['pin', p.padstack, p.pinId, u(p.at.x), u(p.at.y)]);
    for (const k of img.keepouts) f.push(keepoutForm(k));
    library.push(f);
  }
  for (const ps of d.library.padstacks.values()) {
    const f: SList = ['padstack', ps.name];
    for (const s of ps.shapes) f.push(['shape', shapeForm(s)]);
    if (!ps.attach) f.push(['attach', 'off']);
    library.push(f);
  }
  pcb.push(library);

  const network: SList = ['network'];
  for (const n of d.network.nets.values()) {
    const f: SList = ['net', n.name, ['pins', ...n.pins]];
    f.push(...ruleForm(n.rule));
    if (n.circuit) f.push(circuitForm(n.circuit));
    network.push(f);
  }
  for (const c of d.network.classes.values()) {
    const f: SList = ['class', c.name, ...c.nets];
    if (c.circuit) f.push(circuitForm(c.circuit));
    f.push(...ruleForm(c.rule));
    network.push(f);
  }
  for (const cc of d.network.classClass ?? []) network.push(['class_class', ['classes', ...cc.classes], ...ruleForm(cc.rule)]);
  for (const pr of d.network.pairs ?? []) {
    const rule: SList = ['rule'];
    if (pr.gap !== undefined) rule.push(['gap', u(pr.gap)]);
    if (pr.tolerance !== undefined) rule.push(['tolerance', u(pr.tolerance)]);
    network.push(['pair', ['nets', pr.p, pr.n], ...(rule.length > 1 ? [rule] : [])]);
  }
  pcb.push(network);

  if (d.wiring.wires.length || d.wiring.vias.length) {
    const wiring: SList = ['wiring'];
    for (const w of d.wiring.wires) wiring.push(['wire', ['path', w.layer, u(w.width), ...ptList(w.points)], ['net', w.net], ['type', w.type ?? 'route']]);
    for (const v of d.wiring.vias) wiring.push(['via', v.padstack, u(v.at.x), u(v.at.y), ['net', v.net], ['type', v.type ?? 'route']]);
    pcb.push(wiring);
  }
  return writeSExpr(pcb) + '\n';
}

function circuitForm(c: Circuit): SList {
  const f: SList = ['circuit'];
  if (c.useVia) f.push(['use_via', ...c.useVia]);
  if (c.useLayer) f.push(['use_layer', ...c.useLayer]);
  if (c.priority !== undefined) f.push(['priority', String(c.priority)]);
  if (c.maxTotalVias !== undefined) f.push(['max_total_vias', String(c.maxTotalVias)]);
  if (c.length) f.push(['length', String(c.length.max ?? 0), ...(c.length.min !== undefined ? [String(c.length.min)] : [])]);
  if (c.bus) f.push(['bus', 'on']);
  if (c.matchNetLength) f.push(['match_net_length', 'on', ...(c.matchNetLength.tolerance !== undefined ? [['tolerance', String(c.matchNetLength.tolerance)] as SList] : [])]);
  return f;
}
