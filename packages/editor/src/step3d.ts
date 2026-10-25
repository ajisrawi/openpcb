/**
 * STEP AP214 writer for closed planar polyhedra (any orientation): each solid is a vertex list plus faces given as
 * vertex index loops, counter-clockwise seen from outside. Edges are shared between the two faces that use them, in
 * opposite directions, so every shell is closed and consistently oriented. Used for bent rigid-flex boards and wires.
 */
export interface P3 { x: number; y: number; z: number }
export interface Polyhedron { name: string; verts: P3[]; faces: number[][] }

const f = (v: number) => { const s = (Math.round(v * 1e6) / 1e6).toString(); return s.includes('.') || s.includes('e') ? s : s + '.'; };

/** Prism over a polygon (z0..z1) as a polyhedron (polygon made counter-clockwise first). */
export function prism(name: string, poly: { x: number; y: number }[], z0: number, z1: number): Polyhedron {
  let pts = poly.filter((q, i, a) => { const n = a[(i + 1) % a.length]; return Math.hypot(q.x - n.x, q.y - n.y) > 1e-7; });
  let A = 0; for (let i = 0; i < pts.length; i++) { const a = pts[i], b = pts[(i + 1) % pts.length]; A += a.x * b.y - b.x * a.y; }
  if (A < 0) pts = pts.slice().reverse();
  const n = pts.length;
  const verts: P3[] = [...pts.map((q) => ({ x: q.x, y: q.y, z: z0 })), ...pts.map((q) => ({ x: q.x, y: q.y, z: z1 }))];
  const faces: number[][] = [Array.from({ length: n }, (_, i) => n + i), Array.from({ length: n }, (_, i) => n - 1 - i)];
  for (let i = 0; i < n; i++) faces.push([i, (i + 1) % n, n + (i + 1) % n, n + i]);
  return { name, verts, faces };
}

/** Square tube along a 3D polyline (side `s`), closed at both ends: one hexahedron per segment. */
export function tube(name: string, pts: P3[], s: number): Polyhedron[] {
  const out: Polyhedron[] = [];
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i];
    const d = { x: b.x - a.x, y: b.y - a.y, z: b.z - a.z }; const L = Math.hypot(d.x, d.y, d.z); if (L < 1e-9) continue;
    const u = { x: d.x / L, y: d.y / L, z: d.z / L };
    const ref = Math.abs(u.z) < 0.9 ? { x: 0, y: 0, z: 1 } : { x: 1, y: 0, z: 0 };
    const v1 = norm(cross(u, ref)), v2 = cross(u, v1);
    const h = s / 2;
    const corner = (c: P3, sa: number, sb: number) => ({ x: c.x + h * (sa * v1.x + sb * v2.x), y: c.y + h * (sa * v1.y + sb * v2.y), z: c.z + h * (sa * v1.z + sb * v2.z) });
    const sq: [number, number][] = [[-1, -1], [1, -1], [1, 1], [-1, 1]];
    const verts = [...sq.map(([p, q]) => corner(a, p, q)), ...sq.map(([p, q]) => corner(b, p, q))];
    // start cap faces -u, end cap +u; v1 x v2 = u, so the square is counter-clockwise seen from +u
    const faces = [[3, 2, 1, 0], [4, 5, 6, 7], [0, 1, 5, 4], [1, 2, 6, 5], [2, 3, 7, 6], [3, 0, 4, 7]];
    out.push({ name: `${name}_${i}`, verts, faces });
  }
  return out;
}

const cross = (a: P3, b: P3): P3 => ({ x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x });
const norm = (a: P3): P3 => { const l = Math.hypot(a.x, a.y, a.z) || 1; return { x: a.x / l, y: a.y / l, z: a.z / l }; };

export function polyhedraToStep(title: string, solids: Polyhedron[]): string {
  const ents: string[] = [];
  const e = (s: string) => { ents.push(s); return `#${ents.length}`; };
  const len = e(`(LENGTH_UNIT() NAMED_UNIT(*) SI_UNIT(.MILLI.,.METRE.))`);
  const ang = e(`(NAMED_UNIT(*) PLANE_ANGLE_UNIT() SI_UNIT($,.RADIAN.))`);
  const sol = e(`(NAMED_UNIT(*) SI_UNIT($,.STERADIAN.) SOLID_ANGLE_UNIT())`);
  const unc = e(`UNCERTAINTY_MEASURE_WITH_UNIT(LENGTH_MEASURE(1.E-06),${len},'distance_accuracy_value','confusion accuracy')`);
  const ctx = e(`(GEOMETRIC_REPRESENTATION_CONTEXT(3) GLOBAL_UNCERTAINTY_ASSIGNED_CONTEXT((${unc})) GLOBAL_UNIT_ASSIGNED_CONTEXT((${len},${ang},${sol})) REPRESENTATION_CONTEXT('Context #1','3D Context with UNIT and UNCERTAINTY'))`);
  const pt = (q: P3) => e(`CARTESIAN_POINT('',(${f(q.x)},${f(q.y)},${f(q.z)}))`);
  const dir = (q: P3) => e(`DIRECTION('',(${f(q.x)},${f(q.y)},${f(q.z)}))`);
  const axis = (o: P3, n: P3, r: P3) => e(`AXIS2_PLACEMENT_3D('',${pt(o)},${dir(n)},${dir(r)})`);
  const breps: string[] = [];
  for (const s of solids) {
    const vp = s.verts.map((q) => e(`VERTEX_POINT('',${pt(q)})`));
    const edges = new Map<string, string>();
    const edgeOf = (a: number, b: number): { id: string; same: boolean } => {
      const k = a < b ? `${a}_${b}` : `${b}_${a}`; let id = edges.get(k);
      const [i, j] = a < b ? [a, b] : [b, a];
      if (!id) {
        const A = s.verts[i], B = s.verts[j], d = { x: B.x - A.x, y: B.y - A.y, z: B.z - A.z }, L = Math.hypot(d.x, d.y, d.z) || 1e-9;
        const line = e(`LINE('',${pt(A)},${e(`VECTOR('',${dir({ x: d.x / L, y: d.y / L, z: d.z / L })},${f(L)})`)})`);
        id = e(`EDGE_CURVE('',${vp[i]},${vp[j]},${line},.T.)`); edges.set(k, id);
      }
      return { id, same: a < b };
    };
    const faces: string[] = [];
    for (const fc of s.faces) {
      const loop = fc.map((a, k) => { const r = edgeOf(a, fc[(k + 1) % fc.length]); return e(`ORIENTED_EDGE('',*,*,${r.id},${r.same ? '.T.' : '.F.'})`); });
      // Newell normal (outward for a counter-clockwise loop)
      let nx = 0, ny = 0, nz = 0;
      for (let k = 0; k < fc.length; k++) { const a = s.verts[fc[k]], b = s.verts[fc[(k + 1) % fc.length]]; nx += (a.y - b.y) * (a.z + b.z); ny += (a.z - b.z) * (a.x + b.x); nz += (a.x - b.x) * (a.y + b.y); }
      const n = norm({ x: nx, y: ny, z: nz });
      const o = s.verts[fc[0]], q = s.verts[fc[1]];
      let r = { x: q.x - o.x, y: q.y - o.y, z: q.z - o.z }; const dn = r.x * n.x + r.y * n.y + r.z * n.z; r = norm({ x: r.x - dn * n.x, y: r.y - dn * n.y, z: r.z - dn * n.z });
      faces.push(e(`ADVANCED_FACE('',(${e(`FACE_OUTER_BOUND('',${e(`EDGE_LOOP('',(${loop.join(',')}))`)},.T.)`)}),${e(`PLANE('',${axis(o, n, r)})`)},.T.)`));
    }
    breps.push(e(`MANIFOLD_SOLID_BREP('${s.name.replace(/'/g, '')}',${e(`CLOSED_SHELL('',(${faces.join(',')}))`)})`));
  }
  const origin = axis({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 1 }, { x: 1, y: 0, z: 0 });
  const t = title.replace(/'/g, '');
  const rep = e(`ADVANCED_BREP_SHAPE_REPRESENTATION('${t}',(${[origin, ...breps].join(',')}),${ctx})`);
  const appCtx = e(`APPLICATION_CONTEXT('automotive_design')`);
  e(`APPLICATION_PROTOCOL_DEFINITION('international standard','automotive_design',2000,${appCtx})`);
  const prodCtx = e(`PRODUCT_CONTEXT('',${appCtx},'mechanical')`);
  const prod = e(`PRODUCT('${t}','${t}','',(${prodCtx}))`);
  const pdf = e(`PRODUCT_DEFINITION_FORMATION('','',${prod})`);
  const pdCtx = e(`PRODUCT_DEFINITION_CONTEXT('part definition',${appCtx},'design')`);
  const pd = e(`PRODUCT_DEFINITION('design','',${pdf},${pdCtx})`);
  const pds = e(`PRODUCT_DEFINITION_SHAPE('','',${pd})`);
  e(`SHAPE_DEFINITION_REPRESENTATION(${pds},${rep})`);
  e(`PRODUCT_RELATED_PRODUCT_CATEGORY('part',$,(${prod}))`);
  const now = new Date().toISOString().slice(0, 19);
  return ['ISO-10303-21;', 'HEADER;', `FILE_DESCRIPTION(('OpenBoard 3D model'),'2;1');`, `FILE_NAME('${t}.step','${now}',('OpenBoard'),(''),'OpenBoard','OpenBoard','');`, `FILE_SCHEMA(('AUTOMOTIVE_DESIGN { 1 0 10303 214 1 1 1 1 }'));`, 'ENDSEC;', 'DATA;', ...ents.map((s, i) => `#${i + 1}=${s};`), 'ENDSEC;', 'END-ISO-10303-21;', ''].join('\n');
}
