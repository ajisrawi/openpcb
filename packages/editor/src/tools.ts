/**
 * Editing tools on the project's copper: interactive length/phase tuning and detuning, via stitching, via fences
 * along RF lines, and reusable via structures (Allegro Route > Delay Tune / Phase Tune / Remove Tuning, Place > Via
 * Array, Shield Generator, Route > Structures).
 */
import { tuneRoutes, smoothRoutes, type SessionRoutes, type Wire, type Via } from '@openpcb/router';
import { type Project, type Pt, type Trace, type ViaDef, nextId, viaLayers, viaTypesOf, viaTypeName, padToBoard, netWidth } from './model.js';
import { projectToDesign } from './dsnio.js';
import { padInstances, distSegPad, type PadInstance } from './connectivity.js';

const UM = 1000;
const um = (v: number) => Math.round(v * UM);
const mmOf = (v: number) => v / UM;

/** The project's copper as router session routes (micrometres). */
export function projectRoutes(p: Project, nets?: Set<string>): SessionRoutes {
  const out: SessionRoutes = { resolution: { unit: 'um', value: 1 }, nets: new Map(), padstacks: [] };
  const types = viaTypesOf(p);
  const nameOf = (v: ViaDef) => {
    if (!v.from || !v.to) return viaTypeName(p, types[0]);
    const ls = viaLayers(p, v);
    const t = types.find((vt) => { const tl = viaLayers(p, vt); return tl[0] === ls[0] && tl[tl.length - 1] === ls[ls.length - 1]; });
    return t ? viaTypeName(p, t) : viaTypeName(p, { diameter: v.diameter, drill: v.drill, from: v.from, to: v.to });
  };
  const entry = (net: string) => { let e = out.nets.get(net); if (!e) { e = { wires: [], vias: [] }; out.nets.set(net, e); } return e; };
  for (const t of p.traces) if (!nets || nets.has(t.net)) entry(t.net).wires.push({ layer: t.layer, width: um(t.width), points: t.points.map((q) => ({ x: um(q.x), y: um(q.y) })), net: t.net, type: 'route' } as Wire);
  for (const v of p.vias) if (!nets || nets.has(v.net)) entry(v.net).vias.push({ padstack: nameOf(v), at: { x: um(v.x), y: um(v.y) }, net: v.net, type: 'route' } as Via);
  return out;
}

export interface TuneResult { net: string; before: number; after: number; target: number; ok: boolean }

/**
 * Tune routed nets to their length rules (min length, length groups, pair skew) or to explicit targets, with
 * serpentines (or low phase bumps for pairs with `phase`). The untuned copper of every changed net is kept in
 * `p.tuneBackup` so `detuneProject` can restore it (Remove Tuning).
 */
export function tuneProject(p: Project, opts: { nets?: string[]; targets?: Record<string, number>; phase?: boolean } = {}): TuneResult[] {
  const d = projectToDesign(p, { keepAutorouted: false });
  for (const [net, L] of Object.entries(opts.targets ?? {})) { const n = d.network.nets.get(net); if (n) n.circuit = { ...(n.circuit ?? {}), length: { ...(n.circuit?.length ?? {}), max: Math.max(n.circuit?.length?.max ?? 0, um(L) * 10), min: um(L) } }; }
  const routes = projectRoutes(p);
  const res = tuneRoutes(d, routes, { viaLength: um(p.rules.viaLength), phase: !!opts.phase });
  const only = opts.nets?.length ? new Set(opts.nets) : null;
  const backup = (p.tuneBackup ??= {});
  const out: TuneResult[] = [];
  for (const r of res.report) {
    if (only && !only.has(r.net)) continue;
    const e = res.routes.nets.get(r.net); if (!e) continue;
    if (!backup[r.net]) backup[r.net] = p.traces.filter((t) => t.net === r.net).map((t) => ({ ...t, points: t.points.map((q) => ({ ...q })) }));
    const locked = p.traces.some((t) => t.net === r.net && t.locked);
    p.traces = p.traces.filter((t) => t.net !== r.net);
    for (const w of e.wires) p.traces.push({ id: nextId(p), net: r.net, layer: w.layer, width: mmOf(w.width), points: w.points.map((q) => ({ x: mmOf(q.x), y: mmOf(q.y) })), ...(locked ? { locked: true } : {}) });
    out.push({ net: r.net, before: mmOf(r.before), after: mmOf(r.after), target: mmOf(r.target), ok: r.ok });
  }
  return out;
}

/**
 * Gridless smoothing (Allegro gloss / pull-tight) of the unlocked copper: lattice staircases become direct 45° (or
 * any-angle) runs that keep every rule of the project, hole-to-copper included. Locked traces stay as they are.
 */
export function smoothProject(p: Project, opts: { any?: boolean; nets?: string[] } = {}): { removed: number; shortened: number; before: number; after: number } {
  const only = opts.nets?.length ? new Set(opts.nets) : null;
  const d = projectToDesign(p, { keepAutorouted: false });
  // unlocked copper outside the chosen nets stays as obstacles: export it as protected wiring
  for (const t of p.traces) if (!t.locked && only && !only.has(t.net)) d.wiring.wires.push({ layer: t.layer, width: um(t.width), points: t.points.map((q) => ({ x: um(q.x), y: um(q.y) })), net: t.net, type: 'protect' });
  const vias = p.vias.filter((v) => !v.locked);
  const mine = p.traces.filter((t) => !t.locked && (!only || only.has(t.net)));
  // all unlocked vias go in as routes (they are obstacles and connection points); only the chosen nets' wires change
  const routes = projectRoutes({ ...p, traces: mine, vias });
  const len = (ts: { points: Pt[] }[]) => ts.reduce((s, t) => s + t.points.reduce((a, q, i) => (i ? a + Math.hypot(q.x - t.points[i - 1].x, q.y - t.points[i - 1].y) : 0), 0), 0);
  const before = len(mine);
  const res = smoothRoutes(d, routes, { any: !!opts.any });
  const ids = new Set(mine.map((t) => t.id));
  const fresh: Trace[] = [];
  for (const [net, e] of res.routes.nets) for (const w of e.wires) fresh.push({ id: 0, net, layer: w.layer, width: mmOf(w.width), points: w.points.map((q) => ({ x: mmOf(q.x), y: mmOf(q.y) })) });
  p.traces = p.traces.filter((t) => !ids.has(t.id));
  for (const t of fresh) { t.id = nextId(p); p.traces.push(t); }
  return { removed: res.removed, shortened: res.shortened, before, after: len(fresh) };
}

/** Remove Tuning: restore the copper a net had before it was tuned. */
export function detuneProject(p: Project, nets?: string[]): string[] {
  const backup = p.tuneBackup ?? {};
  const done: string[] = [];
  for (const net of Object.keys(backup)) {
    if (nets?.length && !nets.includes(net)) continue;
    p.traces = p.traces.filter((t) => t.net !== net);
    for (const t of backup[net]) p.traces.push({ ...t, id: nextId(p) });
    delete backup[net]; done.push(net);
  }
  return done;
}

/* ---------- placing vias safely ---------- */

const distPtSeg = (q: Pt, a: Pt, b: Pt) => { const dx = b.x - a.x, dy = b.y - a.y, l2 = dx * dx + dy * dy; let t = l2 ? ((q.x - a.x) * dx + (q.y - a.y) * dy) / l2 : 0; t = Math.max(0, Math.min(1, t)); return Math.hypot(q.x - a.x - dx * t, q.y - a.y - dy * t); };
function inPoly(q: Pt, poly: Pt[]): boolean { let ins = false; for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) { const a = poly[i], b = poly[j]; if ((a.y > q.y) !== (b.y > q.y) && q.x < ((b.x - a.x) * (q.y - a.y)) / (b.y - a.y) + a.x) ins = !ins; } return ins; }
function distToOutline(q: Pt, poly: Pt[]): number { let d = Infinity; for (let i = 0; i < poly.length; i++) d = Math.min(d, distPtSeg(q, poly[i], poly[(i + 1) % poly.length])); return d; }

/**
 * Checks a candidate via (net, position, size, span) against every copper object, the hole rules, keepouts and the
 * board edge. Same-net copper is allowed to touch; holes never come closer than holeToHole.
 */
export class ViaSite {
  private pads: PadInstance[];
  private padDrill = new Map<PadInstance, number>();
  constructor(readonly p: Project) {
    this.pads = padInstances(p);
    const lib = p.footprints;
    for (const pd of this.pads) { const fp = lib[p.components.find((c) => c.ref === pd.ref)?.footprint ?? '']; const pad = fp?.pads.find((x) => x.id === pd.padId); if (pd.th) this.padDrill.set(pd, pad?.drill ?? Math.min(pd.w, pd.h) / 2); }
  }
  ok(net: string, at: Pt, dia: number, drill: number, layers: string[], extra: { vias?: ViaDef[] } = {}): boolean {
    const R = this.p.rules, r = dia / 2;
    if (!inPoly(at, this.p.outline) || distToOutline(at, this.p.outline) < r + R.edgeClearance) return false;
    for (const k of this.p.keepouts) {
      if (k.kind === 'wire_keepout') continue;
      if (k.layer !== 'all' && !layers.includes(k.layer)) continue;
      const x = Math.max(k.rect.x1, Math.min(at.x, k.rect.x2)), y = Math.max(k.rect.y1, Math.min(at.y, k.rect.y2));
      if (Math.hypot(at.x - x, at.y - y) < r) return false;
    }
    const h2c = R.holeToCopper, h2h = R.holeToHole;
    for (const pd of this.pads) {
      const d = distSegPad(pd, at, at);
      if (d > r + Math.max(R.clearance, h2c) + 2) continue;
      const dr = this.padDrill.get(pd);
      if (dr !== undefined && Math.hypot(pd.center.x - at.x, pd.center.y - at.y) - dr / 2 - drill / 2 < h2h) return false;   // hole to hole, any net
      if (pd.net === net && pd.net) continue;
      if (!pd.layers.some((l) => layers.includes(l))) continue;
      if (d - r < R.clearance || d - drill / 2 < h2c) return false;
    }
    for (const t of this.p.traces) {
      if (t.net === net || !layers.includes(t.layer)) continue;
      for (let i = 1; i < t.points.length; i++) { const d = distPtSeg(at, t.points[i - 1], t.points[i]) - t.width / 2; if (d - r < R.clearance || d - drill / 2 < h2c) return false; }
    }
    for (const v of [...this.p.vias, ...(extra.vias ?? [])]) {
      const c = Math.hypot(v.x - at.x, v.y - at.y);
      if (c - v.drill / 2 - drill / 2 < h2h) return false;
      if (v.net === net) continue;
      if (!viaLayers(this.p, v).some((l) => layers.includes(l))) continue;
      if (c - v.diameter / 2 - r < R.clearance || c - v.diameter / 2 - drill / 2 < h2c) return false;
    }
    return true;
  }
}

/**
 * Via stitching (Place > Via Array): a grid of `net` vias every `pitch` mm inside the board — and inside a pour of
 * the net when `inZone` — wherever a via fits every rule.
 */
export function stitchVias(p: Project, opts: { net: string; pitch: number; inZone?: boolean; region?: { x1: number; y1: number; x2: number; y2: number } }): number {
  const site = new ViaSite(p);
  const dia = p.rules.viaDiameter, drill = p.rules.viaDrill, layers = p.layers.map((l) => l.name);
  const xs = p.outline.map((q) => q.x), ys = p.outline.map((q) => q.y);
  const box = opts.region ?? { x1: Math.min(...xs), y1: Math.min(...ys), x2: Math.max(...xs), y2: Math.max(...ys) };
  const zones = p.zones.filter((z) => z.net === opts.net && z.points.length >= 3);
  const added: ViaDef[] = [];
  for (let y = box.y1 + opts.pitch / 2; y <= box.y2; y += opts.pitch) for (let x = box.x1 + opts.pitch / 2; x <= box.x2; x += opts.pitch) {
    const at = { x: Math.round(x * 1000) / 1000, y: Math.round(y * 1000) / 1000 };
    if (opts.inZone && !zones.some((z) => inPoly(at, z.points))) continue;
    if (!site.ok(opts.net, at, dia, drill, layers, { vias: added })) continue;
    added.push({ id: nextId(p), net: opts.net, x: at.x, y: at.y, diameter: dia, drill, locked: true });
  }
  p.vias.push(...added);
  return added.length;
}

/**
 * Via fence (Allegro Shield Generator, RF guard vias): `guard`-net vias on both sides of every trace of `net`,
 * `spacing` mm apart, as close to the trace as the rules allow.
 */
export function viaFence(p: Project, opts: { net: string; guard: string; spacing: number; layers?: string[] }): number {
  const site = new ViaSite(p);
  const dia = p.rules.viaDiameter, drill = p.rules.viaDrill, all = p.layers.map((l) => l.name);
  const added: ViaDef[] = [];
  for (const t of p.traces) {
    if (t.net !== opts.net || (opts.layers && !opts.layers.includes(t.layer))) continue;
    const off = t.width / 2 + Math.max(p.rules.clearance, p.rules.holeToCopper - (dia - drill) / 2) + dia / 2 + 0.01;
    for (let i = 1; i < t.points.length; i++) {
      const a = t.points[i - 1], b = t.points[i], L = Math.hypot(b.x - a.x, b.y - a.y); if (L < 1e-6) continue;
      const u = { x: (b.x - a.x) / L, y: (b.y - a.y) / L }, nrm = { x: -u.y, y: u.x };
      for (let s = 0; s <= L + 1e-9; s += opts.spacing) for (const side of [1, -1]) {
        const at = { x: Math.round((a.x + u.x * s + nrm.x * off * side) * 1000) / 1000, y: Math.round((a.y + u.y * s + nrm.y * off * side) * 1000) / 1000 };
        if (!site.ok(opts.guard, at, dia, drill, all, { vias: added })) continue;
        added.push({ id: nextId(p), net: opts.guard, x: at.x, y: at.y, diameter: dia, drill, locked: true });
      }
    }
  }
  p.vias.push(...added);
  return added.length;
}

/* ---------- via structures ---------- */

/** Route > Structures > Create: the vias and traces within `radius` of `at`, stored relative to `at`. */
export function saveStructure(p: Project, name: string, at: Pt, radius: number): { vias: number; traces: number } {
  const inside = (q: Pt) => Math.hypot(q.x - at.x, q.y - at.y) <= radius;
  const vias = p.vias.filter((v) => inside(v)).map((v) => ({ x: v.x - at.x, y: v.y - at.y, diameter: v.diameter, drill: v.drill, ...(v.from ? { from: v.from, to: v.to } : {}) }));
  const traces = p.traces.filter((t) => t.points.every(inside)).map((t) => ({ layer: t.layer, width: t.width, points: t.points.map((q) => ({ x: q.x - at.x, y: q.y - at.y })) }));
  p.structures = (p.structures ?? []).filter((s) => s.name !== name);
  p.structures.push({ name, vias, traces });
  return { vias: vias.length, traces: traces.length };
}

/** Route > Structures > Place: copy a saved structure to (x, y), rotated by `rot` degrees, on `net`. */
export function placeStructure(p: Project, name: string, x: number, y: number, net: string, rot = 0): { vias: number; traces: number } {
  const s = (p.structures ?? []).find((q) => q.name === name);
  if (!s) throw new Error(`no structure ${name}`);
  const a = (rot * Math.PI) / 180, cs = Math.cos(a), sn = Math.sin(a);
  const tf = (q: Pt) => ({ x: Math.round((x + q.x * cs - q.y * sn) * 1000) / 1000, y: Math.round((y + q.x * sn + q.y * cs) * 1000) / 1000 });
  for (const v of s.vias) { const q = tf(v); p.vias.push({ id: nextId(p), net, x: q.x, y: q.y, diameter: v.diameter, drill: v.drill, ...(v.from ? { from: v.from, to: v.to } : {}), locked: true }); }
  for (const t of s.traces) p.traces.push({ id: nextId(p), net, layer: t.layer, width: t.width, points: t.points.map(tf), locked: true });
  return { vias: s.vias.length, traces: s.traces.length };
}

void padToBoard; void netWidth;
