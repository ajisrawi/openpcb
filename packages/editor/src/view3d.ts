/**
 * 3D view (Allegro View > 3D Canvas): the board as a slab (outline extruded by the board thickness), outer-layer
 * copper as thin strips on its faces, and every part as a box of its footprint body x height on its side.
 * WebGL 1, one directional light, orbit with the left mouse button, zoom with the wheel, pan with the right button.
 */
import { type Project, type Pt, heightOf } from './model.js';
import { defaultLibrary } from './footprints.js';

type V3 = [number, number, number];

function earClip(poly: Pt[]): number[] {
  const n = poly.length; if (n < 3) return [];
  const idx = poly.map((_, i) => i);
  let area = 0; for (let i = 0; i < n; i++) { const a = poly[i], b = poly[(i + 1) % n]; area += a.x * b.y - b.x * a.y; }
  if (area < 0) idx.reverse();
  const tris: number[] = [];
  const cross = (a: Pt, b: Pt, c: Pt) => (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
  const inside = (p: Pt, a: Pt, b: Pt, c: Pt) => cross(a, b, p) >= 0 && cross(b, c, p) >= 0 && cross(c, a, p) >= 0;
  let guard = 0;
  while (idx.length > 3 && guard++ < 10000) {
    let cut = false;
    for (let i = 0; i < idx.length; i++) {
      const i0 = idx[(i + idx.length - 1) % idx.length], i1 = idx[i], i2 = idx[(i + 1) % idx.length];
      const a = poly[i0], b = poly[i1], c = poly[i2];
      if (cross(a, b, c) <= 0) continue;
      if (idx.some((k) => k !== i0 && k !== i1 && k !== i2 && inside(poly[k], a, b, c))) continue;
      tris.push(i0, i1, i2); idx.splice(i, 1); cut = true; break;
    }
    if (!cut) break;
  }
  if (idx.length === 3) tris.push(idx[0], idx[1], idx[2]);
  return tris;
}

interface Mesh { pos: number[]; nrm: number[]; col: number[] }
function addTri(m: Mesh, a: V3, b: V3, c: V3, col: V3): void {
  const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
  const n: V3 = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
  const l = Math.hypot(...n) || 1; n[0] /= l; n[1] /= l; n[2] /= l;
  for (const p of [a, b, c]) { m.pos.push(...p); m.nrm.push(...n); m.col.push(...col); }
}
function prism(m: Mesh, poly: Pt[], z0: number, z1: number, col: V3, colTop?: V3): void {
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length];
    addTri(m, [a.x, a.y, z0], [b.x, b.y, z0], [b.x, b.y, z1], col); addTri(m, [a.x, a.y, z0], [b.x, b.y, z1], [a.x, a.y, z1], col);
  }
  const t = earClip(poly);
  for (let i = 0; i < t.length; i += 3) {
    const a = poly[t[i]], b = poly[t[i + 1]], c = poly[t[i + 2]];
    addTri(m, [a.x, a.y, z1], [b.x, b.y, z1], [c.x, c.y, z1], colTop ?? col);
    addTri(m, [a.x, a.y, z0], [c.x, c.y, z0], [b.x, b.y, z0], col);
  }
}

export function buildMesh(p: Project): Mesh & { center: V3; size: number } {
  const m: Mesh = { pos: [], nrm: [], col: [] };
  const th = p.rules.viaLength || 1.6;
  let poly = p.outline.slice();
  prism(m, poly, -th, 0, [0.12, 0.35, 0.18], [0.1, 0.42, 0.2]);
  // outer copper strips just above/below the faces
  const first = p.layers[0].name, last = p.layers[p.layers.length - 1].name;
  for (const t of p.traces) {
    if (t.layer !== first && t.layer !== last) continue;
    const z = t.layer === first ? 0.02 : -th - 0.02, hw = t.width / 2;
    for (let i = 1; i < t.points.length; i++) {
      const a = t.points[i - 1], b = t.points[i], L = Math.hypot(b.x - a.x, b.y - a.y); if (L < 1e-6) continue;
      const nx = (-(b.y - a.y) / L) * hw, ny = ((b.x - a.x) / L) * hw;
      const q: V3[] = [[a.x + nx, a.y + ny, z], [b.x + nx, b.y + ny, z], [b.x - nx, b.y - ny, z], [a.x - nx, a.y - ny, z]];
      const col: V3 = [0.85, 0.55, 0.25];
      if (t.layer === first) { addTri(m, q[0], q[2], q[1], col); addTri(m, q[0], q[3], q[2], col); } else { addTri(m, q[0], q[1], q[2], col); addTri(m, q[0], q[2], q[3], col); }
    }
  }
  // parts
  const lib = { ...defaultLibrary(), ...p.footprints };
  for (const c of p.components) {
    const fp = lib[c.footprint]; if (!fp) continue;
    const hw = fp.body.w / 2, hh = fp.body.h / 2, a = (c.rot * Math.PI) / 180, cs = Math.cos(a), sn = Math.sin(a), mx = c.side === 'back' ? -1 : 1;
    const box = [[-hw, -hh], [hw, -hh], [hw, hh], [-hw, hh]].map(([x, y]) => ({ x: c.x + mx * x * cs - y * sn, y: c.y + mx * x * sn + y * cs }));
    const h = heightOf(p, c);
    const col: V3 = /^(C|R|L)\d/.test(c.ref) ? [0.55, 0.45, 0.3] : /^(J|P)\d/.test(c.ref) ? [0.75, 0.75, 0.78] : [0.16, 0.16, 0.18];
    if (c.side === 'front') prism(m, box, 0.03, 0.03 + h, col); else prism(m, box.slice().reverse(), -th - 0.03 - h, -th - 0.03, col);
  }
  const xs = poly.map((q) => q.x), ys = poly.map((q) => q.y);
  return { ...m, center: [(Math.min(...xs) + Math.max(...xs)) / 2, (Math.min(...ys) + Math.max(...ys)) / 2, -th / 2], size: Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys)) };
}

export class View3D {
  private gl: WebGLRenderingContext;
  private prog: WebGLProgram;
  private n = 0;
  private yaw = -0.6; private pitch = 0.9; private dist = 1; private pan: V3 = [0, 0, 0];
  private center: V3 = [0, 0, 0];
  constructor(readonly canvas: HTMLCanvasElement) {
    const gl = canvas.getContext('webgl', { antialias: true }); if (!gl) throw new Error('WebGL is not available');
    this.gl = gl;
    const vs = `attribute vec3 p; attribute vec3 n; attribute vec3 c; uniform mat4 mvp; varying vec3 vn; varying vec3 vc; void main(){ gl_Position = mvp * vec4(p,1.0); vn = n; vc = c; }`;
    const fs = `precision mediump float; varying vec3 vn; varying vec3 vc; void main(){ vec3 l = normalize(vec3(0.4,0.3,0.85)); float d = abs(dot(normalize(vn), l)); gl_FragColor = vec4(vc*(0.35+0.65*d),1.0); }`;
    const sh = (type: number, src: string) => { const s = gl.createShader(type)!; gl.shaderSource(s, src); gl.compileShader(s); if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) ?? 'shader'); return s; };
    const prog = gl.createProgram()!; gl.attachShader(prog, sh(gl.VERTEX_SHADER, vs)); gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, fs)); gl.linkProgram(prog);
    this.prog = prog;
    let drag: { x: number; y: number; btn: number } | null = null;
    canvas.addEventListener('mousedown', (e) => { drag = { x: e.clientX, y: e.clientY, btn: e.button }; });
    window.addEventListener('mouseup', () => { drag = null; });
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    canvas.addEventListener('mousemove', (e) => {
      if (!drag) return; const dx = e.clientX - drag.x, dy = e.clientY - drag.y; drag.x = e.clientX; drag.y = e.clientY;
      if (drag.btn === 0) { this.yaw -= dx * 0.008; this.pitch = Math.max(0.05, Math.min(Math.PI - 0.05, this.pitch - dy * 0.008)); }
      else { const s = this.dist * 0.0015; this.pan[0] -= dx * s * Math.cos(this.yaw) ; this.pan[1] += dy * s; }
      this.draw();
    });
    canvas.addEventListener('wheel', (e) => { e.preventDefault(); this.dist *= e.deltaY < 0 ? 0.9 : 1.1; this.draw(); }, { passive: false });
  }
  load(p: Project): void {
    const gl = this.gl, m = buildMesh(p);
    const buf = (data: number[], name: string) => { const b = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, b); gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(data), gl.STATIC_DRAW); const loc = gl.getAttribLocation(this.prog, name); gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc, 3, gl.FLOAT, false, 0, 0); };
    gl.useProgram(this.prog); buf(m.pos, 'p'); buf(m.nrm, 'n'); buf(m.col, 'c');
    this.n = m.pos.length / 3; this.center = m.center; this.dist = m.size * 1.6; this.pan = [0, 0, 0];
    this.draw();
  }
  draw(): void {
    const gl = this.gl, W = this.canvas.width, H = this.canvas.height;
    gl.viewport(0, 0, W, H); gl.clearColor(0.06, 0.08, 0.1, 1); gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT); gl.enable(gl.DEPTH_TEST);
    const c: V3 = [this.center[0] + this.pan[0], this.center[1] + this.pan[1], this.center[2]];
    const eye: V3 = [c[0] + this.dist * Math.sin(this.pitch) * Math.cos(this.yaw), c[1] + this.dist * Math.sin(this.pitch) * Math.sin(this.yaw), c[2] + this.dist * Math.cos(this.pitch)];
    const mvp = mul(perspective(0.8, W / Math.max(1, H), this.dist * 0.01, this.dist * 10), lookAt(eye, c, [0, 0, 1]));
    gl.uniformMatrix4fv(gl.getUniformLocation(this.prog, 'mvp'), false, new Float32Array(mvp));
    gl.drawArrays(gl.TRIANGLES, 0, this.n);
  }
}

function perspective(fovy: number, aspect: number, near: number, far: number): number[] {
  const f = 1 / Math.tan(fovy / 2), nf = 1 / (near - far);
  return [f / aspect, 0, 0, 0, 0, f, 0, 0, 0, 0, (far + near) * nf, -1, 0, 0, 2 * far * near * nf, 0];
}
function lookAt(e: V3, c: V3, up: V3): number[] {
  const z = norm([e[0] - c[0], e[1] - c[1], e[2] - c[2]]), x = norm(crs(up, z)), y = crs(z, x);
  return [x[0], y[0], z[0], 0, x[1], y[1], z[1], 0, x[2], y[2], z[2], 0, -dot(x, e), -dot(y, e), -dot(z, e), 1];
}
function mul(a: number[], b: number[]): number[] { const o = new Array(16).fill(0); for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) for (let k = 0; k < 4; k++) o[j * 4 + i] += a[k * 4 + i] * b[j * 4 + k]; return o; }
const crs = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const norm = (a: V3): V3 => { const l = Math.hypot(...a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
