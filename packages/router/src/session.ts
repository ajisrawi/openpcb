/**
 * SPECCTRA session (.ses) and routes (.rte) files.
 *
 *   (session <id>
 *     (base_design <file>)
 *     (placement (resolution …) (component <image> (place <ref> x y side rot)))
 *     (routes (resolution …) (parser …) (library_out (padstack …))
 *             (network_out (net <name> (wire (path L w x y …)) (via <ps> x y)))))
 *
 * Coordinates in a session are written in resolution units (the integers that
 * the (resolution) declares), exactly as Allegro and freerouting do.
 */
import { parseSExpr, head, child, children, num, isAtom, writeSExpr, fmt, type SList } from './sexpr.js';
import type { Design, Session, SessionRoutes, Padstack, Placement, Resolution, Wire, Via, Shape } from './model.js';
import { readWiresInto, type Scope } from './dsn.js';

export function writeSession(d: Design, baseDesign: string, routes: SessionRoutes, placement?: Placement[]): string {
  const res = routes.resolution;
  const u = (v: number) => fmt(Math.round(v), 0);
  const shapeForm = (s: Shape): SList => {
    switch (s.kind) {
      case 'circle': return ['circle', s.layer, u(s.diameter ?? 0), ...(s.center && (s.center.x || s.center.y) ? [u(s.center.x), u(s.center.y)] : [])];
      case 'rect': return ['rect', s.layer, u(s.rect!.x1), u(s.rect!.y1), u(s.rect!.x2), u(s.rect!.y2)];
      case 'path': return ['path', s.layer, u(s.width ?? 0), ...(s.points ?? []).flatMap((p) => [u(p.x), u(p.y)])];
      case 'polygon': return ['polygon', s.layer, u(s.width ?? 0), ...(s.points ?? []).flatMap((p) => [u(p.x), u(p.y)])];
    }
  };
  const ses: SList = ['session', d.id, ['base_design', baseDesign]];
  if (placement && placement.length) {
    const pl: SList = ['placement', ['resolution', res.unit, String(res.value)]];
    const byImage = new Map<string, Placement[]>();
    for (const p of placement) { const a = byImage.get(p.image) ?? []; a.push(p); byImage.set(p.image, a); }
    for (const [image, places] of byImage) {
      const c: SList = ['component', image];
      for (const p of places) c.push(['place', p.ref, u(p.at.x), u(p.at.y), p.side, fmt(p.rotation)]);
      pl.push(c);
    }
    ses.push(pl);
  }
  const rt: SList = ['routes', ['resolution', res.unit, String(res.value)],
    ['parser', ['host_cad', 'OpenRoute'], ['host_version', '0.1']]];
  if (routes.padstacks.length) {
    const lo: SList = ['library_out'];
    for (const ps of routes.padstacks) {
      const f: SList = ['padstack', ps.name];
      for (const s of ps.shapes) f.push(['shape', shapeForm(s)]);
      if (!ps.attach) f.push(['attach', 'off']);
      lo.push(f);
    }
    rt.push(lo);
  }
  // merge the design's fixed/protected wiring into the output: a session describes the whole routing
  const nets = new Map<string, { wires: Wire[]; vias: Via[] }>();
  for (const [name, r] of routes.nets) nets.set(name, { wires: r.wires.slice(), vias: r.vias.slice() });
  const fixedTypes = new Set(['fix', 'protect']);
  for (const w of d.wiring.wires) { if (!w.net || !(w.type === undefined || fixedTypes.has(w.type))) continue; const e = nets.get(w.net) ?? { wires: [], vias: [] }; nets.set(w.net, e); e.wires.push({ ...w, type: w.type ?? 'fix' }); }
  for (const v of d.wiring.vias) { if (!v.net || !(v.type === undefined || fixedTypes.has(v.type))) continue; const e = nets.get(v.net) ?? { wires: [], vias: [] }; nets.set(v.net, e); e.vias.push({ ...v, type: v.type ?? 'fix' }); }
  const lo = rt.find((f) => Array.isArray(f) && f[0] === 'library_out') as SList | undefined;
  const listed = new Set(routes.padstacks.map((ps) => ps.name));
  for (const e of nets.values()) for (const v of e.vias) {
    if (listed.has(v.padstack)) continue;
    const ps = d.library.padstacks.get(v.padstack); if (!ps) continue;
    listed.add(v.padstack);
    const f: SList = ['padstack', ps.name];
    for (const s of ps.shapes) f.push(['shape', shapeForm(s)]);
    if (!ps.attach) f.push(['attach', 'off']);
    if (lo) lo.push(f); else rt.push(['library_out', f]);
  }
  const no: SList = ['network_out'];
  for (const [name, r] of nets) {
    if (!r.wires.length && !r.vias.length) continue;
    const nf: SList = ['net', name];
    for (const w of r.wires) nf.push(['wire', ['path', w.layer, u(w.width), ...w.points.flatMap((p) => [u(p.x), u(p.y)])], ...(w.type ? [['type', w.type] as SList] : [])]);
    for (const v of r.vias) nf.push(['via', v.padstack, u(v.at.x), u(v.at.y), ...(v.type ? [['type', v.type] as SList] : [])]);
    no.push(nf);
  }
  rt.push(no);
  ses.push(rt);
  return writeSExpr(ses) + '\n';
}

/** Routes-only (.rte) file: the (routes …) form without the session wrapper. */
export function writeRoutes(routes: SessionRoutes): string {
  const u = (v: number) => fmt(Math.round(v), 0);
  const rt: SList = ['routes', ['resolution', routes.resolution.unit, String(routes.resolution.value)], ['parser', ['host_cad', 'OpenRoute'], ['host_version', '0.1']]];
  const no: SList = ['network_out'];
  for (const [name, r] of routes.nets) {
    if (!r.wires.length && !r.vias.length) continue;
    const nf: SList = ['net', name];
    for (const w of r.wires) nf.push(['wire', ['path', w.layer, u(w.width), ...w.points.flatMap((p) => [u(p.x), u(p.y)])]]);
    for (const v of r.vias) nf.push(['via', v.padstack, u(v.at.x), u(v.at.y)]);
    no.push(nf);
  }
  rt.push(no);
  return writeSExpr(rt) + '\n';
}

/** Parse a .ses (or a bare (routes …) .rte) file. */
export function parseSession(text: string, defaultResolution: Resolution): Session {
  const forms = parseSExpr(text);
  let sesForm = forms.find((f) => head(f) === 'session') as SList | undefined;
  let routesForm: SList | undefined;
  if (sesForm) routesForm = child(sesForm, 'routes');
  else routesForm = forms.find((f) => head(f) === 'routes') as SList | undefined;
  const session: Session = {
    id: sesForm ? String(sesForm[1]) : 'routes',
    baseDesign: sesForm ? String(child(sesForm, 'base_design')?.[1] ?? '') : '',
    routes: { resolution: { ...defaultResolution }, nets: new Map(), padstacks: [] },
  };
  if (sesForm) {
    const pl = child(sesForm, 'placement');
    if (pl) {
      const r = child(pl, 'resolution');
      const res = r ? { unit: String(r[1]), value: num(r[2], 1) } : defaultResolution;
      const sc: Scope = { res, unit: res.unit };
      session.placement = [];
      for (const comp of children(pl, 'component')) {
        for (const p of children(comp, 'place')) {
          if (!isAtom(p[2])) continue;
          session.placement.push({ image: String(comp[1]), ref: String(p[1]), at: { x: Math.round(num(p[2])), y: Math.round(num(p[3])) }, side: String(p[4] ?? 'front').toLowerCase() === 'back' ? 'back' : 'front', rotation: num(p[5], 0), locked: false });
          void sc;
        }
      }
    }
  }
  if (!routesForm) return session;
  const r = child(routesForm, 'resolution');
  if (r) session.routes.resolution = { unit: String(r[1]), value: num(r[2], 1) };
  // In session/routes files numbers are already resolution units: scope with unit = res unit and value as declared,
  // so conv() multiplies by 1.
  const sc: Scope = { res: session.routes.resolution, unit: session.routes.resolution.unit };
  const identity: Scope = { res: { unit: sc.res.unit, value: 1 }, unit: sc.res.unit };
  const lo = child(routesForm, 'library_out');
  if (lo) {
    for (const psf of children(lo, 'padstack')) {
      const ps: Padstack = { name: String(psf[1]), shapes: [], attach: true };
      for (const s of children(psf, 'shape')) {
        for (const sh of s.filter((x): x is SList => Array.isArray(x))) {
          const k = head(sh); const layer = String(sh[1]);
          if (k === 'circle') ps.shapes.push({ kind: 'circle', layer, diameter: num(sh[2]), center: { x: num(sh[3]), y: num(sh[4]) } });
          else if (k === 'rect') ps.shapes.push({ kind: 'rect', layer, rect: { x1: num(sh[2]), y1: num(sh[3]), x2: num(sh[4]), y2: num(sh[5]) } });
          else if (k === 'path' || k === 'polygon') {
            const pts = []; for (let i = 3; i + 1 < sh.length; i += 2) pts.push({ x: num(sh[i]), y: num(sh[i + 1]) });
            ps.shapes.push({ kind: k, layer, width: num(sh[2]), points: pts });
          }
        }
      }
      const at = child(psf, 'attach'); if (at) ps.attach = String(at[1]).toLowerCase() !== 'off';
      session.routes.padstacks.push(ps);
    }
  }
  const no = child(routesForm, 'network_out');
  if (no) {
    for (const netf of children(no, 'net')) {
      const name = String(netf[1]);
      const into: { wires: Wire[]; vias: Via[] } = { wires: [], vias: [] };
      readWiresInto(netf, identity, into, name);
      session.routes.nets.set(name, into);
    }
  }
  return session;
}
