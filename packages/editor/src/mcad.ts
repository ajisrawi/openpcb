/**
 * Mechanical and netlist exchange (Allegro File > Export > STEP / IDF / IDX / Netlist, Logic > Auto Rename Refdes):
 *
 *   STEP AP214  closed B-rep solids: the board (its outline extruded by the thickness) and one box per part
 *               (footprint body x height, on its side of the board). Every face is planar; edges are shared by
 *               exactly two faces with opposite orientation, so the shells are watertight.
 *   IDF 3.0     board file (.emn: outline, drilled holes, placement) and library file (.emp: part outlines + heights).
 *   IDX         ProSTEP EDMD baseline (board outline extrusion, component boxes) for ECAD-MCAD collaboration.
 *   Netlists    KiCad (.net s-expression) and Telesis ("third party" netlist read by Allegro).
 *   Rename      reference designators renumbered geographically, with a was/is list for back-annotation.
 */
import { type Project, type Pt, heightOf } from './model.js';
import { defaultLibrary } from './footprints.js';
import { drillHoles } from './fab.js';

const f = (v: number) => { const s = (Math.round(v * 1e6) / 1e6).toString(); return s.includes('.') || s.includes('e') ? s : s + '.'; };
const area = (pts: Pt[]) => { let a = 0; for (let i = 0; i < pts.length; i++) { const p = pts[i], q = pts[(i + 1) % pts.length]; a += p.x * q.y - q.x * p.y; } return a / 2; };

/* ============================== STEP ============================== */

interface Solid { name: string; poly: Pt[]; z0: number; z1: number }

/** Board + part bodies as extruded prisms (mm). Top of the board at z = 0, board below. */
export function mcadSolids(p: Project, thickness = p.rules.viaLength || 1.6): Solid[] {
  const lib = { ...defaultLibrary(), ...p.footprints };
  const solids: Solid[] = [{ name: 'PCB', poly: p.outline.slice(), z0: -thickness, z1: 0 }];
  for (const c of p.components) {
    const fp = lib[c.footprint]; if (!fp) continue;
    const hw = fp.body.w / 2, hh = fp.body.h / 2, a = (c.rot * Math.PI) / 180, cs = Math.cos(a), sn = Math.sin(a);
    const m = c.side === 'back' ? -1 : 1;
    const poly = [[-hw, -hh], [hw, -hh], [hw, hh], [-hw, hh]].map(([x, y]) => ({ x: c.x + m * x * cs - y * sn, y: c.y + m * x * sn + y * cs }));
    const h = heightOf(p, c);
    solids.push(c.side === 'front' ? { name: c.ref, poly, z0: 0, z1: h } : { name: c.ref, poly, z0: -thickness - h, z1: -thickness });
  }
  return solids;
}

export function exportStep(p: Project, opts: { thickness?: number } = {}): string {
  const ents: string[] = [];
  const e = (s: string) => { ents.push(s); return `#${ents.length}`; };
  const ctx = (() => {
    const len = e(`(LENGTH_UNIT() NAMED_UNIT(*) SI_UNIT(.MILLI.,.METRE.))`);
    const ang = e(`(NAMED_UNIT(*) PLANE_ANGLE_UNIT() SI_UNIT($,.RADIAN.))`);
    const sol = e(`(NAMED_UNIT(*) SI_UNIT($,.STERADIAN.) SOLID_ANGLE_UNIT())`);
    const unc = e(`UNCERTAINTY_MEASURE_WITH_UNIT(LENGTH_MEASURE(1.E-06),${len},'distance_accuracy_value','confusion accuracy')`);
    return e(`(GEOMETRIC_REPRESENTATION_CONTEXT(3) GLOBAL_UNCERTAINTY_ASSIGNED_CONTEXT((${unc})) GLOBAL_UNIT_ASSIGNED_CONTEXT((${len},${ang},${sol})) REPRESENTATION_CONTEXT('Context #1','3D Context with UNIT and UNCERTAINTY'))`);
  })();
  const pt = (x: number, y: number, z: number) => e(`CARTESIAN_POINT('',(${f(x)},${f(y)},${f(z)}))`);
  const dir = (x: number, y: number, z: number) => e(`DIRECTION('',(${f(x)},${f(y)},${f(z)}))`);
  const axis = (o: [number, number, number], n: [number, number, number], r: [number, number, number]) => e(`AXIS2_PLACEMENT_3D('',${pt(...o)},${dir(...n)},${dir(...r)})`);
  const breps: string[] = [];
  for (const s of mcadSolids(p, opts.thickness)) {
    let poly = s.poly.filter((q, i, arr) => { const n = arr[(i + 1) % arr.length]; return Math.hypot(q.x - n.x, q.y - n.y) > 1e-6; });
    if (poly.length < 3) continue;
    if (area(poly) < 0) poly = poly.slice().reverse();            // counter-clockwise seen from +z
    const n = poly.length;
    const vb = poly.map((q) => e(`VERTEX_POINT('',${pt(q.x, q.y, s.z0)})`)), vt = poly.map((q) => e(`VERTEX_POINT('',${pt(q.x, q.y, s.z1)})`));
    const edge = (a: string, b: string, A: [number, number, number], B: [number, number, number]) => {
      const d: [number, number, number] = [B[0] - A[0], B[1] - A[1], B[2] - A[2]]; const L = Math.hypot(...d);
      const line = e(`LINE('',${pt(...A)},${e(`VECTOR('',${dir(d[0] / L, d[1] / L, d[2] / L)},${f(L)})`)})`);
      return e(`EDGE_CURVE('',${a},${b},${line},.T.)`);
    };
    const P = (i: number, z: number): [number, number, number] => [poly[i % n].x, poly[i % n].y, z];
    const eb: string[] = [], et: string[] = [], ev: string[] = [];
    for (let i = 0; i < n; i++) { eb.push(edge(vb[i], vb[(i + 1) % n], P(i, s.z0), P(i + 1, s.z0))); et.push(edge(vt[i], vt[(i + 1) % n], P(i, s.z1), P(i + 1, s.z1))); ev.push(edge(vb[i], vt[i], P(i, s.z0), P(i, s.z1))); }
    const oe = (ec: string, same: boolean) => e(`ORIENTED_EDGE('',*,*,${ec},${same ? '.T.' : '.F.'})`);
    const face = (edges: string[], plane: string) => e(`ADVANCED_FACE('',(${e(`FACE_OUTER_BOUND('',${e(`EDGE_LOOP('',(${edges.join(',')}))`)},.T.)`)}),${plane},.T.)`);
    const faces: string[] = [];
    // top (+z): loop counter-clockwise from above = top edges forward
    faces.push(face(et.map((x) => oe(x, true)), e(`PLANE('',${axis([poly[0].x, poly[0].y, s.z1], [0, 0, 1], [1, 0, 0])})`)));
    // bottom (-z): bottom edges reversed, in reverse order
    faces.push(face(eb.slice().reverse().map((x) => oe(x, false)), e(`PLANE('',${axis([poly[0].x, poly[0].y, s.z0], [0, 0, -1], [1, 0, 0])})`)));
    // sides: b_i -> b_i+1 -> t_i+1 -> t_i (outward normal = edge direction x z)
    for (let i = 0; i < n; i++) {
      const a = poly[i], b = poly[(i + 1) % n], L = Math.hypot(b.x - a.x, b.y - a.y), ux = (b.x - a.x) / L, uy = (b.y - a.y) / L;
      faces.push(face([oe(eb[i], true), oe(ev[(i + 1) % n], true), oe(et[i], false), oe(ev[i], false)], e(`PLANE('',${axis([a.x, a.y, s.z0], [uy, -ux, 0], [ux, uy, 0])})`)));
    }
    breps.push(e(`MANIFOLD_SOLID_BREP('${s.name.replace(/'/g, '')}',${e(`CLOSED_SHELL('',(${faces.join(',')}))`)})`));
  }
  const origin = axis([0, 0, 0], [0, 0, 1], [1, 0, 0]);
  const rep = e(`ADVANCED_BREP_SHAPE_REPRESENTATION('${p.name.replace(/'/g, '')}',(${[origin, ...breps].join(',')}),${ctx})`);
  const appCtx = e(`APPLICATION_CONTEXT('automotive_design')`);
  e(`APPLICATION_PROTOCOL_DEFINITION('international standard','automotive_design',2000,${appCtx})`);
  const prodCtx = e(`PRODUCT_CONTEXT('',${appCtx},'mechanical')`);
  const prod = e(`PRODUCT('${p.name.replace(/'/g, '')}','${p.name.replace(/'/g, '')}','',(${prodCtx}))`);
  const pdf = e(`PRODUCT_DEFINITION_FORMATION('','',${prod})`);
  const pdCtx = e(`PRODUCT_DEFINITION_CONTEXT('part definition',${appCtx},'design')`);
  const pd = e(`PRODUCT_DEFINITION('design','',${pdf},${pdCtx})`);
  const pds = e(`PRODUCT_DEFINITION_SHAPE('','',${pd})`);
  e(`SHAPE_DEFINITION_REPRESENTATION(${pds},${rep})`);
  e(`PRODUCT_RELATED_PRODUCT_CATEGORY('part',$,(${prod}))`);
  const now = new Date().toISOString().slice(0, 19);
  return ['ISO-10303-21;', 'HEADER;', `FILE_DESCRIPTION(('OpenBoard board and component bodies'),'2;1');`, `FILE_NAME('${p.name.replace(/'/g, '')}.step','${now}',('OpenBoard'),(''),'OpenBoard','OpenBoard','');`, `FILE_SCHEMA(('AUTOMOTIVE_DESIGN { 1 0 10303 214 1 1 1 1 }'));`, 'ENDSEC;', 'DATA;', ...ents.map((s, i) => `#${i + 1}=${s};`), 'ENDSEC;', 'END-ISO-10303-21;', ''].join('\n');
}

/** Self-check of a STEP file written by exportStep: every reference resolves and every edge is used by two
 *  faces in opposite directions (closed, consistently oriented shells). */
export function checkStep(text: string): { entities: number; solids: number; badRefs: number; openEdges: number } {
  const ents = new Map<string, string>();
  for (const m of text.matchAll(/^#(\d+)=(.*);$/gm)) ents.set(m[1], m[2]);
  let badRefs = 0;
  for (const v of ents.values()) for (const r of v.matchAll(/#(\d+)/g)) if (!ents.has(r[1])) badRefs++;
  const use = new Map<string, number>();
  for (const v of ents.values()) { const m = /^ORIENTED_EDGE\('',\*,\*,#(\d+),\.(T|F)\.\)$/.exec(v); if (m) use.set(m[1], (use.get(m[1]) ?? 0) + (m[2] === 'T' ? 1 : -1) * 1000 + 1); }
  let openEdges = 0;
  for (const [, k] of use) if (k !== 2) openEdges++;   // exactly one .T. and one .F. => +1000 -1000 + 2
  return { entities: ents.size, solids: [...ents.values()].filter((v) => v.startsWith('MANIFOLD_SOLID_BREP')).length, badRefs, openEdges };
}

/* ============================== IDF 3.0 ============================== */

export function exportIdf(p: Project, opts: { thickness?: number } = {}): { emn: string; emp: string } {
  const lib = { ...defaultLibrary(), ...p.footprints };
  const t = opts.thickness ?? (p.rules.viaLength || 1.6);
  const date = new Date(); const z = (v: number) => String(v).padStart(2, '0');
  const ds = `${date.getFullYear()}/${z(date.getMonth() + 1)}/${z(date.getDate())}.${z(date.getHours())}:${z(date.getMinutes())}:${z(date.getSeconds())}`;
  const n = (v: number) => v.toFixed(4);
  let poly = p.outline.slice(); if (area(poly) < 0) poly = poly.reverse();
  const emn: string[] = ['.HEADER', `BOARD_FILE 3.0 "OpenBoard 0.1" ${ds} 1`, `"${p.name}" MM`, '.END_HEADER', '.BOARD_OUTLINE ECAD', n(t), ...[...poly, poly[0]].map((q) => `0 ${n(q.x)} ${n(q.y)} 0`), '.END_BOARD_OUTLINE', '.DRILLED_HOLES'];
  for (const h of drillHoles(p)) if (h.from === p.layers[0].name && h.to === p.layers[p.layers.length - 1].name) emn.push(`${n(h.d)} ${n(h.x)} ${n(h.y)} ${h.plated ? 'PTH' : 'NPTH'} BOARD ${h.net ? 'PIN' : 'MTG'} ECAD`);
  emn.push('.END_DRILLED_HOLES', '.PLACEMENT');
  for (const c of p.components) emn.push(`"${c.footprint}" "${c.value || c.footprint}" ${c.ref}`, `${n(c.x)} ${n(c.y)} 0 ${n(c.rot)} ${c.side === 'front' ? 'TOP' : 'BOTTOM'} PLACED`);
  emn.push('.END_PLACEMENT', '');
  const emp: string[] = ['.HEADER', `LIBRARY_FILE 3.0 "OpenBoard 0.1" ${ds} 1`, '.END_HEADER'];
  const seen = new Set<string>();
  for (const c of p.components) {
    const key = `${c.footprint}|${c.value || c.footprint}`; if (seen.has(key)) continue; seen.add(key);
    const fp = lib[c.footprint]; if (!fp) continue;
    const hw = fp.body.w / 2, hh = fp.body.h / 2;
    emp.push('.ELECTRICAL', `"${c.footprint}" "${c.value || c.footprint}" MM ${n(heightOf(p, c))}`, ...[[-hw, -hh], [hw, -hh], [hw, hh], [-hw, hh], [-hw, -hh]].map(([x, y]) => `0 ${n(x)} ${n(y)} 0`), '.END_ELECTRICAL');
  }
  emp.push('');
  return { emn: emn.join('\n'), emp: emp.join('\n') };
}

/* ============================== IDX (EDMD baseline) ============================== */

export { exportIdx, exportIdxChanges, importIdx, readIdx } from './idx.js';

/* ============================== netlists ============================== */

export function exportKicadNetlist(p: Project): string {
  const q = (s: string) => `"${s.replace(/"/g, '\\"')}"`;
  const out = ['(export (version "E")', '  (design (source "OpenBoard") (tool "OpenBoard 0.1"))', '  (components'];
  for (const c of p.components) out.push(`    (comp (ref ${q(c.ref)}) (value ${q(c.value || '~')}) (footprint ${q(c.footprint)}))`);
  out.push('  )', '  (nets');
  p.nets.forEach((n, i) => { out.push(`    (net (code "${i + 1}") (name ${q(n.name)})`); for (const k of n.pins) { const j = k.lastIndexOf('-'); out.push(`      (node (ref ${q(k.slice(0, j))}) (pin ${q(k.slice(j + 1))}))`); } out.push('    )'); });
  out.push('  )', ')', '');
  return out.join('\n');
}

/** Telesis netlist (Allegro "third-party netlist" import format). */
export function exportTelesisNetlist(p: Project): string {
  const out = ['$PACKAGES'];
  const groups = new Map<string, string[]>();
  for (const c of p.components) { const k = `! '${c.footprint}' ! '${c.value || c.footprint}'`; (groups.get(k) ?? groups.set(k, []).get(k)!).push(c.ref); }
  for (const [k, refs] of groups) out.push(`${k}; ${refs.join(' ')}`);
  out.push('$NETS');
  for (const n of p.nets) {
    const nodes = n.pins.map((k) => { const j = k.lastIndexOf('-'); return `${k.slice(0, j)}.${k.slice(j + 1)}`; });
    const lines: string[] = []; for (let i = 0; i < nodes.length; i += 8) lines.push(nodes.slice(i, i + 8).join(' '));
    out.push(`'${n.name}'; ${lines.join(' ,\n ')}`);
  }
  out.push('$END', '');
  return out.join('\n');
}

/* ============================== refdes renumbering ============================== */

/**
 * Auto Rename Refdes: renumber parts per prefix in reading order (top-to-bottom bands, left-to-right; bottom-side
 * parts after the top side), starting at `start`. Returns the was/is list for back-annotating the schematic.
 */
export function renameRefdes(p: Project, opts: { band?: number; start?: number; prefixes?: string[] } = {}): { was: string; is: string }[] {
  const band = opts.band ?? 5, start = opts.start ?? 1;
  const prefixOf = (r: string) => /^[A-Za-z_]+/.exec(r)?.[0] ?? '';
  const byPrefix = new Map<string, typeof p.components>();
  for (const c of p.components) { const pf = prefixOf(c.ref); if (!pf || (opts.prefixes && !opts.prefixes.includes(pf))) continue; (byPrefix.get(pf) ?? byPrefix.set(pf, []).get(pf)!).push(c); }
  const ys = p.outline.map((q) => q.y); const top = Math.max(...ys);
  const map: { was: string; is: string }[] = [];
  for (const [pf, cs] of byPrefix) {
    cs.sort((a, b) => (a.side === b.side ? 0 : a.side === 'front' ? -1 : 1) || (Math.floor((top - a.y) / band) - Math.floor((top - b.y) / band)) || (a.x - b.x));
    cs.forEach((c, i) => { const is = `${pf}${start + i}`; if (is !== c.ref) map.push({ was: c.ref, is }); });
  }
  // apply through temporary names so swaps like R1<->R2 cannot collide
  const tmp = new Map(map.map((m) => [m.was, `__RN_${m.was}`]));
  const rename = (from: string, to: string) => { const c = p.components.find((x) => x.ref === from); if (c) c.ref = to; for (const n of p.nets) n.pins = n.pins.map((k) => (k.startsWith(from + '-') ? to + k.slice(from.length) : k)); for (const rm of p.rooms ?? []) rm.refs = rm.refs.map((r) => (r === from ? to : r)); };
  for (const m of map) rename(m.was, tmp.get(m.was)!);
  for (const m of map) rename(tmp.get(m.was)!, m.is);
  return map;
}

/** Was/is file for back-annotation (one "was is" pair per line, Allegro .chg-style). */
export function wasIsText(map: { was: string; is: string }[]): string { return ['# OpenBoard refdes back-annotation: WAS IS', ...map.map((m) => `${m.was} ${m.is}`), ''].join('\n'); }
