/**
 * Project <-> SPECCTRA bridge (our SPIF): exports the board as a .dsn design
 * for the router and merges a .ses session back into the project.
 */
import { emptyDesign, writeDsn, parseSession, parseDsn, emptyRuleSet, type Design, type Shape, type Padstack, type Image, type Session, type RuleSet } from '@openpcb/router';
import { type Project, type Pad, type Component, type Trace, type ViaDef, nextId, padLayers, netOfPin, findNet, defaultRules, viaTypesOf, viaTypeName, viaLayers, parseViaName, padToBoard } from './model.js';
import { defaultLibrary } from './footprints.js';

const UM = 1000; // resolution units per mm (um)
const um = (mm: number) => Math.round(mm * UM);

function padstackName(pad: Pad): string {
  const w = um(pad.w), h = um(pad.h);
  if (pad.shape === 'circle') return `Round[${pad.th ? 'A' : 'T'}]Pad_${w}_um`;
  if (pad.shape === 'oval') return `Oval[${pad.th ? 'A' : 'T'}]Pad_${w}x${h}_um`;
  return `Rect[${pad.th ? 'A' : 'T'}]Pad_${w}x${h}_um`;
}

function padShape(pad: Pad, layer: string): Shape {
  const w = um(pad.w), h = um(pad.h);
  if (pad.shape === 'circle') return { kind: 'circle', layer, diameter: w, center: { x: 0, y: 0 } };
  if (pad.shape === 'oval') {
    const r = Math.min(w, h) / 2;
    return w >= h ? { kind: 'path', layer, width: 2 * r, points: [{ x: -w / 2 + r, y: 0 }, { x: w / 2 - r, y: 0 }] } : { kind: 'path', layer, width: 2 * r, points: [{ x: 0, y: -h / 2 + r }, { x: 0, y: h / 2 - r }] };
  }
  return { kind: 'rect', layer, rect: { x1: -w / 2, y1: -h / 2, x2: w / 2, y2: h / 2 } };
}

export function viaPadstackName(p: Project): string { return `Via[0-${p.layers.length - 1}]_${um(p.rules.viaDiameter)}:${um(p.rules.viaDrill)}_um`; }

export interface ExportOptions { keepAutorouted?: boolean; holeKeepouts?: boolean; }   // holeKeepouts (default on): drill-rule keep-outs for the router; the DRC checks holes exactly instead

export function projectToDesign(p: Project, opts: ExportOptions = {}): Design {
  const d = emptyDesign(p.name.replace(/\s+/g, '_') || 'board');
  d.parser.hostCad = 'OpenBoard'; d.parser.hostVersion = '0.1';
  d.resolution = { unit: 'um', value: 1 }; d.unit = 'um';
  const signal = p.layers.filter((l) => l.type === 'signal').map((l) => l.name);
  p.layers.forEach((l, i) => d.structure.layers.push({ name: l.name, type: l.type, direction: l.direction, index: i }));
  d.structure.boundary.push({ shape: { kind: 'path', layer: 'pcb', width: 0, points: [...p.outline, p.outline[0]].map((q) => ({ x: um(q.x), y: um(q.y) })) } });
  d.structure.rule.width = um(p.rules.width);
  d.structure.rule.clearance.set('default', um(p.rules.clearance));
  for (const k of p.keepouts) {
    const layers = k.layer === 'all' ? ['pcb'] : [k.layer];
    for (const layer of layers) d.structure.keepouts.push({ kind: k.kind, shape: { kind: 'rect', layer, rect: { x1: um(k.rect.x1), y1: um(k.rect.y1), x2: um(k.rect.x2), y2: um(k.rect.y2) } } });
  }
  for (const z of p.zones) if (z.points.length >= 3) d.structure.planes.push({ net: z.net, shape: { kind: 'polygon', layer: z.layer, width: 0, points: z.points.map((q) => ({ x: um(q.x), y: um(q.y) })) } });
  // via types: the through via plus every declared blind/buried span (padstack shapes on the spanned layers)
  const types = viaTypesOf(p);
  const typeNames = types.map((vt) => viaTypeName(p, vt));
  types.forEach((vt, i) => {
    const name = typeNames[i];
    if (d.structure.vias.includes(name)) return;
    d.structure.vias.push(name);
    d.library.padstacks.set(name, { name, shapes: viaLayers(p, vt).map((l) => ({ kind: 'circle', layer: l, diameter: um(vt.diameter), center: { x: 0, y: 0 } })), attach: false });
  });
  // drill rules the router cannot see directly become via clearances: every via type keeps its hole the
  // hole-to-copper distance from other copper and the hole-to-hole distance from other vias (laser rules for
  // blind vias), with a small margin for the lattice; through-hole pad drills get a via keep-out ring
  {
    const R = p.rules, margin = 0.005, last = p.layers.length - 1;
    const isLaser = (vt: { from: string; to: string }) => { const ls = viaLayers(p, vt); return ls.length < p.layers.length && (ls[0] === p.layers[0].name || ls[ls.length - 1] === p.layers[last].name); };
    let cvw = R.clearance, cvv = R.clearance;
    for (const a of types) {
      cvw = Math.max(cvw, (isLaser(a) ? R.laserHoleToCopper : R.holeToCopper) - (a.diameter - a.drill) / 2 + margin);
      for (const b of types) cvv = Math.max(cvv, (a.drill + b.drill) / 2 + (isLaser(a) || isLaser(b) ? R.laserHoleToHole : R.holeToHole) - (a.diameter + b.diameter) / 2 + margin);
      // a via hole must also keep hole-to-copper from the other via's pad
      cvv = Math.max(cvv, (isLaser(a) ? R.laserHoleToCopper : R.holeToCopper) - (a.diameter - a.drill) / 2 + margin);
    }
    const r3 = (v: number) => Math.round(v * 1000) / 1000;
    if (cvw > R.clearance + 1e-9) for (const k of ['via_wire', 'via_smd', 'via_pin']) d.structure.rule.clearance.set(k, um(r3(cvw)));
    if (cvv > R.clearance + 1e-9) d.structure.rule.clearance.set('via_via', um(r3(cvv)));
    const libAll = { ...defaultLibrary(), ...p.footprints };
    const minViaDrill = Math.min(...types.map((vt) => vt.drill)), maxRing = Math.max(...types.map((vt) => (vt.diameter - vt.drill) / 2));
    if (opts.holeKeepouts !== false) for (const c of p.components) {
      const fp = libAll[c.footprint]; if (!fp) continue;
      for (const pad of fp.pads) {
        if (!pad.th) continue;
        const drill = pad.drill ?? Math.min(pad.w, pad.h) / 2;
        // keep-out radius so that a via centre stays drill/2 + holeToHole + viaDrill/2 away (the via's own copper is outside the area)
        const rKeep = drill / 2 + R.holeToHole + minViaDrill / 2 - (minViaDrill / 2 + maxRing);
        if (rKeep <= 0) continue;
        const at = padToBoard(c, pad);
        d.structure.keepouts.push({ kind: 'via_keepout', shape: { kind: 'circle', layer: 'pcb', diameter: um(2 * rKeep), center: { x: um(at.x), y: um(at.y) } } });
      }
    }
  }
  const viaName = typeNames[0];
  const nameForVia = (v: ViaDef): string => {
    const ls = viaLayers(p, v);
    const i = !v.from || !v.to ? 0 : types.findIndex((vt) => { const tl = viaLayers(p, vt); return tl[0] === ls[0] && tl[tl.length - 1] === ls[ls.length - 1]; });
    const vt = i >= 0 ? types[i] : types[0];
    if (Math.abs(vt.diameter - v.diameter) < 1e-6 && Math.abs(vt.drill - v.drill) < 1e-6) return i >= 0 ? typeNames[i] : viaName;
    // a via with its own size gets its own padstack (in the library only, so the router never picks it for new vias)
    const own = viaTypeName(p, { diameter: v.diameter, drill: v.drill, from: ls[0], to: ls[ls.length - 1] });
    if (!d.library.padstacks.has(own)) d.library.padstacks.set(own, { name: own, shapes: ls.map((l) => ({ kind: 'circle', layer: l, diameter: um(v.diameter), center: { x: 0, y: 0 } })), attach: false });
    return own;
  };
  void signal;
  // images and padstacks
  const lib = { ...defaultLibrary(), ...p.footprints };
  const usedFp = new Set(p.components.map((c) => c.footprint));
  for (const name of usedFp) {
    const fp = lib[name]; if (!fp) continue;
    const img: Image = { name: fp.name, outline: fp.outline.map((pl) => ({ kind: 'path', layer: 'signal', width: 0, points: pl.map((q) => ({ x: um(q.x), y: um(q.y) })) })), pins: [], keepouts: [] };
    for (const pad of fp.pads) {
      if (pad.npth) continue;   // non-plated holes are keep-outs (below), not pins
      const psn = padstackName(pad);
      if (!d.library.padstacks.has(psn)) {
        const layers = pad.th ? signal : [signal[0]];
        const ps: Padstack = { name: psn, shapes: layers.map((l) => padShape(pad, l)), attach: true };
        d.library.padstacks.set(psn, ps);
      }
      img.pins.push({ padstack: psn, pinId: pad.id, at: { x: um(pad.x), y: um(pad.y) }, rotation: pad.rot ?? 0 });
    }
    d.library.images.set(img.name, img);
  }
  // non-plated holes: copper keeps holeToCopper from the drill on every layer
  if (opts.holeKeepouts !== false) for (const c of p.components) { const fp = lib[c.footprint]; if (!fp) continue; for (const pad of fp.pads) if (pad.npth) { const at = padToBoard(c, pad); d.structure.keepouts.push({ kind: 'keepout', shape: { kind: 'circle', layer: 'pcb', diameter: um((pad.drill ?? pad.w) + 2 * p.rules.holeToCopper), center: { x: um(at.x), y: um(at.y) } } }); } }
  for (const c of p.components) d.placement.push({ image: c.footprint, ref: c.ref, at: { x: um(c.x), y: um(c.y) }, side: c.side, rotation: c.rot, locked: !!c.locked, partNumber: c.value || undefined });
  for (const n of p.nets) {
    const net = { name: n.name, pins: n.pins.slice(), rule: (n.width || n.clearance) ? { width: n.width ? um(n.width) : undefined, clearance: new Map(n.clearance ? [['default', um(n.clearance)]] : []) } : undefined,
      ...(n.minLength !== undefined || n.maxLength !== undefined ? { circuit: { length: { max: um(n.maxLength ?? 1e6), ...(n.minLength !== undefined ? { min: um(n.minLength) } : {}) } } } : {}) };
    d.network.nets.set(n.name, net);
  }
  // net classes: width/clearance rules, allowed vias and layers, routing priority
  const ruleOf = (w?: number, c?: number): RuleSet | undefined => { if (w === undefined && c === undefined) return undefined; const r = emptyRuleSet(); if (w !== undefined) r.width = um(w); if (c !== undefined) r.clearance.set('default', um(c)); return r; };
  for (const nc of p.netClasses ?? []) {
    const nets = nc.nets.filter((n) => d.network.nets.has(n) && !d.network.nets.get(n)!.className);
    if (!nets.length) continue;
    const viaNames = (nc.viaTypes ?? []).filter((n) => d.structure.vias.includes(n));
    d.network.classes.set(nc.name, { name: nc.name, nets, rule: ruleOf(nc.width, nc.clearance),
      circuit: { ...(viaNames.length ? { useVia: viaNames } : {}), ...(nc.layers?.length ? { useLayer: nc.layers.slice() } : {}), ...(nc.priority !== undefined ? { priority: nc.priority } : {}) } });
    for (const n of nets) d.network.nets.get(n)!.className = nc.name;
  }
  for (const cc of p.classClearances ?? []) if (d.network.classes.has(cc.a) && d.network.classes.has(cc.b)) (d.network.classClass ??= []).push({ classes: [cc.a, cc.b], rule: ruleOf(undefined, cc.clearance)! });
  // constraint regions
  for (const rg of p.regions ?? []) {
    if (rg.points.length < 3) continue;
    const rule = ruleOf(rg.width, rg.clearance); if (!rule) continue;
    const shape: Shape = { kind: 'polygon', layer: 'pcb', width: 0, points: rg.points.map((q) => ({ x: um(q.x), y: um(q.y) })) };
    (d.structure.regions ??= []).push(rg.classes?.length ? { id: rg.name || `R${rg.id}`, shape, classRules: [{ classes: rg.classes.filter((c) => d.network.classes.has(c)), rule }] } : { id: rg.name || `R${rg.id}`, shape, rule });
  }
  // constraints the router acts on: differential pairs (coupled routing + skew tuning) and length-matched groups
  for (const dp of p.diffPairs) if (d.network.nets.has(dp.p) && d.network.nets.has(dp.n)) {
    // a pair without its own gap takes its class's coupled gap
    const gap = dp.gap > 0 ? dp.gap : (p.netClasses ?? []).find((c) => c.nets.includes(dp.p))?.diffGap ?? p.rules.clearance;
    (d.network.pairs ??= []).push({ p: dp.p, n: dp.n, gap: um(gap), tolerance: um(dp.maxSkew) });
  }
  for (const g of p.lengthGroups) {
    const nets = g.nets.filter((n) => d.network.nets.has(n) && !d.network.classes.has(n));
    if (nets.length < 2) continue;
    const name = `LG_${g.name}`.replace(/\s+/g, '_');
    // a net that already has a net class keeps its rules: the length group becomes a combined class
    const base = (n: string) => { const cn = d.network.nets.get(n)!.className; return cn ? d.network.classes.get(cn) : undefined; };
    const b0 = base(nets[0]);
    d.network.classes.set(name, { name, nets, ...(b0?.rule ? { rule: b0.rule } : {}), circuit: { ...(b0?.circuit ?? {}), matchNetLength: { tolerance: um(g.tolerance) } } });
    for (const n of nets) { const prev = base(n); if (prev) prev.nets = prev.nets.filter((x) => x !== n); d.network.nets.get(n)!.className = name; }
  }
  // existing copper: locked traces are protected obstacles+connectivity; autorouted ones are kept only on request
  for (const t of p.traces) {
    if (!t.locked && !opts.keepAutorouted) continue;
    d.wiring.wires.push({ layer: t.layer, width: um(t.width), points: t.points.map((q) => ({ x: um(q.x), y: um(q.y) })), net: t.net, type: t.locked ? 'fix' : 'protect' });
  }
  for (const v of p.vias) {
    if (!v.locked && !opts.keepAutorouted) continue;
    d.wiring.vias.push({ padstack: nameForVia(v), at: { x: um(v.x), y: um(v.y) }, net: v.net, type: v.locked ? 'fix' : 'protect' });
  }
  return d;
}

export function exportDsn(p: Project, opts: ExportOptions = {}): string { return writeDsn(projectToDesign(p, opts)); }

/** Diameter, drill and span of a via from its padstack name (KiCad convention) or the session's padstack shapes. */
function viaFromPadstack(p: Project, name: string, padstacks: { name: string; shapes: { kind: string; layer: string; diameter?: number }[] }[], toMm: (v: number) => number): { diameter: number; drill: number; from?: string; to?: string } {
  const last = p.layers.length - 1;
  const parsed = parseViaName(name);
  if (parsed) {
    const span = parsed.b0 === 0 && parsed.b1 >= last ? {} : { from: p.layers[Math.min(parsed.b0, last)].name, to: p.layers[Math.min(parsed.b1, last)].name };
    return { diameter: parsed.diameter, drill: parsed.drill, ...span };
  }
  const ps = padstacks.find((x) => x.name === name);
  if (ps) {
    const idx = ps.shapes.map((s) => p.layers.findIndex((l) => l.name === s.layer)).filter((i) => i >= 0);
    const circle = ps.shapes.find((s) => s.kind === 'circle');
    const dia = circle?.diameter ? toMm(circle.diameter) : p.rules.viaDiameter;
    const matching = (p.rules.viaTypes ?? []).find((vt) => Math.abs(vt.diameter - dia) < 1e-6);
    const drill = matching?.drill ?? (Math.abs(dia - p.rules.viaDiameter) < 1e-6 ? p.rules.viaDrill : dia / 2);
    if (idx.length) { const b0 = Math.min(...idx), b1 = Math.max(...idx); if (!(b0 === 0 && b1 === last)) return { diameter: dia, drill, from: p.layers[b0].name, to: p.layers[b1].name }; }
    return { diameter: dia, drill };
  }
  return { diameter: p.rules.viaDiameter, drill: p.rules.viaDrill };
}

/** Apply a session's routes: replace unlocked traces/vias of the routed nets. */
export function importSession(p: Project, sesText: string, opts: { replaceAll?: boolean } = {}): { wires: number; vias: number } {
  const ses: Session = parseSession(sesText, { unit: 'um', value: 1 });
  const res = ses.routes.resolution;
  const unitMm: Record<string, number> = { inch: 25.4, in: 25.4, mil: 0.0254, cm: 10, mm: 1, um: 0.001, micron: 0.001 };
  const toMm = (v: number) => (v / res.value) * (unitMm[res.unit.toLowerCase()] ?? 0.001);
  const routedNets = new Set(ses.routes.nets.keys());
  p.traces = p.traces.filter((t) => t.locked || (!opts.replaceAll && !routedNets.has(t.net)));
  p.vias = p.vias.filter((v) => v.locked || (!opts.replaceAll && !routedNets.has(v.net)));
  let wires = 0, vias = 0;
  for (const [net, r] of ses.routes.nets) {
    // (type fix) copper is the project's locked copper, still present; (type protect) is kept autorouted copper, re-imported unlocked
    for (const w of r.wires) { if (w.type === 'fix') continue; p.traces.push({ id: nextId(p), net, layer: w.layer, width: toMm(w.width), points: w.points.map((q) => ({ x: toMm(q.x), y: toMm(q.y) })) }); wires++; }
    for (const v of r.vias) { if (v.type === 'fix') continue; p.vias.push({ id: nextId(p), net, x: toMm(v.at.x), y: toMm(v.at.y), ...viaFromPadstack(p, v.padstack, ses.routes.padstacks, toMm) }); vias++; }
  }
  if (ses.placement) for (const pl of ses.placement) { const c = p.components.find((x) => x.ref === pl.ref); if (c) { c.x = toMm(pl.at.x); c.y = toMm(pl.at.y); c.rot = pl.rotation; c.side = pl.side; } }
  return { wires, vias };
}

/** Import a foreign .dsn (e.g. from KiCad or the Cadence tutorial) as a project. Footprints become generic pads. */
export function importDsn(text: string): Project {
  const d = parseDsn(text);
  const unitMm: Record<string, number> = { inch: 25.4, in: 25.4, mil: 0.0254, cm: 10, mm: 1, um: 0.001, micron: 0.001 };
  const toMm = (v: number) => (v / d.resolution.value) * (unitMm[d.resolution.unit.toLowerCase()] ?? 1);
  const p: Project = {
    name: d.id, version: 1,
    layers: d.structure.layers.map((l, i) => ({ name: l.name, type: l.type === 'power' ? 'power' : 'signal', color: ['#e8492f', '#2fa3e8', '#e8c22f', '#7fe82f', '#c62fe8', '#2fe8d0'][i % 6], direction: l.direction === 'horizontal' || l.direction === 'vertical' ? l.direction : 'off', visible: true })),
    outline: [], footprints: {}, components: [], nets: [], rules: { ...defaultRules(), width: toMm(d.structure.rule.width ?? 250), clearance: toMm(d.structure.rule.clearance.get('default') ?? d.structure.rule.clearance.get('wire_wire') ?? 200) },
    traces: [], vias: [], keepouts: [], zones: [], diffPairs: [], lengthGroups: [], nextId: 1,
  };
  const b = d.structure.boundary.find((x) => x.shape.layer.toLowerCase() === 'pcb') ?? d.structure.boundary[0];
  if (b) {
    if (b.shape.kind === 'rect' && b.shape.rect) { const r = b.shape.rect; p.outline = [{ x: toMm(r.x1), y: toMm(r.y1) }, { x: toMm(r.x2), y: toMm(r.y1) }, { x: toMm(r.x2), y: toMm(r.y2) }, { x: toMm(r.x1), y: toMm(r.y2) }]; }
    else if (b.shape.points) { p.outline = b.shape.points.map((q) => ({ x: toMm(q.x), y: toMm(q.y) })); if (p.outline.length > 1) { const f = p.outline[0], l = p.outline[p.outline.length - 1]; if (Math.abs(f.x - l.x) < 1e-6 && Math.abs(f.y - l.y) < 1e-6) p.outline.pop(); } }
  }
  // via padstacks: the through via sets the default sizes; blind/buried spans become via types
  const viaPs = d.structure.vias.map((n) => d.library.padstacks.get(n)).filter((x): x is NonNullable<typeof x> => !!x);
  const spanOf = (ps: typeof viaPs[number]) => { const idx = ps.shapes.map((s) => p.layers.findIndex((l) => l.name === s.layer)).filter((i) => i >= 0); return idx.length ? { b0: Math.min(...idx), b1: Math.max(...idx) } : { b0: 0, b1: p.layers.length - 1 }; };
  const sizes = (ps: typeof viaPs[number]) => { const parsed = parseViaName(ps.name); const c = ps.shapes.find((s) => s.kind === 'circle'); const dia = c?.diameter ? toMm(c.diameter) : parsed?.diameter ?? 0.45; return { diameter: dia, drill: parsed?.drill ?? dia / 2 }; };
  const through = viaPs.find((ps) => { const s = spanOf(ps); return s.b0 === 0 && s.b1 === p.layers.length - 1; }) ?? viaPs[0];
  if (through) { const s = sizes(through); p.rules.viaDiameter = s.diameter; p.rules.viaDrill = s.drill; }
  for (const ps of viaPs) { if (ps === through) continue; const s = spanOf(ps); const z = sizes(ps); (p.rules.viaTypes ??= []).push({ ...z, from: p.layers[s.b0].name, to: p.layers[s.b1].name }); }
  for (const img of d.library.images.values()) {
    const pads: Pad[] = [];
    for (const pin of img.pins) {
      const ps = d.library.padstacks.get(pin.padstack); if (!ps) continue;
      const th = ps.shapes.length > 1 || ps.shapes.some((s) => ['signal', 'pcb', 'all', 'power'].includes(s.layer.toLowerCase()));
      let w = 0.5, h = 0.5, shape: Pad['shape'] = 'rect';
      const s = ps.shapes[0];
      if (s.kind === 'circle') { w = h = toMm(s.diameter ?? 0); shape = 'circle'; }
      else if (s.kind === 'rect' && s.rect) { w = toMm(s.rect.x2 - s.rect.x1); h = toMm(s.rect.y2 - s.rect.y1); }
      else if (s.points && s.points.length) { let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity; for (const q of s.points) { x0 = Math.min(x0, q.x); y0 = Math.min(y0, q.y); x1 = Math.max(x1, q.x); y1 = Math.max(y1, q.y); } w = toMm(x1 - x0 + (s.width ?? 0)); h = toMm(y1 - y0 + (s.width ?? 0)); if (s.kind === 'path' && s.width) shape = 'oval'; }
      // the pin's (rotate …): quarter turns become swapped width/height (exact); any other angle is kept as pad.rot
      const rot = ((pin.rotation % 360) + 360) % 360;
      const quarter = Math.abs(rot / 90 - Math.round(rot / 90)) < 1e-6;
      if (quarter && Math.round(rot / 90) % 2 === 1) [w, h] = [h, w];
      pads.push({ id: pin.pinId, x: toMm(pin.at.x), y: toMm(pin.at.y), w: Math.max(w, 0.1), h: Math.max(h, 0.1), shape, th, ...(quarter ? {} : { rot }) });
    }
    const outline = img.outline.filter((o) => o.points).map((o) => o.points!.map((q) => ({ x: toMm(q.x), y: toMm(q.y) })));
    let bw = 1, bh = 1; for (const pd of pads) { bw = Math.max(bw, Math.abs(pd.x) * 2 + pd.w); bh = Math.max(bh, Math.abs(pd.y) * 2 + pd.h); }
    // a DSN image outline merges every footprint graphic (courtyard, fab, silk) on one 'signal' layer
    p.footprints[img.name] = { name: img.name, pads, outline, body: { w: bw, h: bh }, outlineKind: 'reference' };
  }
  for (const pl of d.placement) p.components.push({ ref: pl.ref, footprint: pl.image, value: pl.partNumber ?? '', x: toMm(pl.at.x), y: toMm(pl.at.y), rot: pl.rotation, side: pl.side });
  for (const n of d.network.nets.values()) p.nets.push({ name: n.name, pins: n.pins.slice() });
  for (const pl of d.structure.planes) {
    const s = pl.shape; let pts: { x: number; y: number }[] = [];
    if (s.kind === 'rect' && s.rect) pts = [{ x: s.rect.x1, y: s.rect.y1 }, { x: s.rect.x2, y: s.rect.y1 }, { x: s.rect.x2, y: s.rect.y2 }, { x: s.rect.x1, y: s.rect.y2 }].map((q) => ({ x: toMm(q.x), y: toMm(q.y) }));
    else if (s.points) pts = s.points.map((q) => ({ x: toMm(q.x), y: toMm(q.y) }));
    if (pts.length >= 3) p.zones.push({ id: nextId(p), net: pl.net, layer: s.layer, points: pts, clearance: p.rules.clearance, dynamic: true });
  }
  for (const w of d.wiring.wires) p.traces.push({ id: nextId(p), net: w.net, layer: w.layer, width: toMm(w.width), points: w.points.map((q) => ({ x: toMm(q.x), y: toMm(q.y) })), locked: w.type === 'fix' || w.type === undefined });
  for (const v of d.wiring.vias) p.vias.push({ id: nextId(p), net: v.net, x: toMm(v.at.x), y: toMm(v.at.y), ...viaFromPadstack(p, v.padstack, viaPs, toMm), locked: v.type === 'fix' || v.type === undefined });
  return p;
}

export { padLayers, netOfPin, findNet };
export type { Component, Trace, ViaDef };
