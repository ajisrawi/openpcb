/**
 * Automatic placement — the OpenBoard counterpart of Allegro's Quickplace / Autoplace.
 *
 *   quickplace : spreads the parts in rows (by reference designator) inside the board
 *                outline — the first step after importing a netlist.
 *   autoplace  : simulated annealing that moves, rotates and swaps unlocked parts to
 *                minimise the weighted ratsnest wirelength (half-perimeter per net) while
 *                keeping bodies apart (spacing), inside the outline and clear of locked
 *                parts. Sides are never changed; locked parts never move.
 *
 * Wirelength is the usual HPWL estimate; nets with many pins (power, ground) are
 * down-weighted so that they do not drag every decoupling capacitor to the board centre.
 * Use `ignoreNets` for nets that should not influence placement at all.
 */
import { type Project, type Component, type Footprint, type Pt } from './model.js';
import { defaultLibrary } from './footprints.js';

export interface PlaceOptions {
  mode?: 'anneal' | 'quick';
  only?: string[];           // place only these refs (default: every unlocked part)
  lock?: string[];           // treat these refs as locked for this run
  grid?: number;             // final snap grid, mm (default 0.5)
  spacing?: number;          // body-to-body gap, mm (default 0.5)
  iterations?: number;       // annealing moves per movable part (default 600)
  seed?: number;
  rotate?: boolean;          // allow 90° rotations (default true)
  ignoreNets?: string[];     // nets that carry no wirelength cost
  netWeights?: { pattern: string; weight: number }[];   // per-net wirelength weight by regex (first match wins):
                             // RF and clock nets that must stay short get a high weight
  bigNetPins?: number;       // nets with more pins than this are down-weighted (default 8)
  density?: number;          // target body-area utilisation per density cell (0..1); unset = no density control
  densityCell?: number;      // density cell size, mm (default 10)
  decap?: number;            // decoupling affinity weight (default 2; 0 = off): a cap between a power net and ground is
                             // pulled to its own power pin of an IC (each cap claims the nearest unclaimed pin)
  log?: (s: string) => void;
}

export interface PlaceResult {
  placed: number;
  held: number;
  wirelengthBefore: number;  // mm, weighted HPWL
  wirelengthAfter: number;
  overlaps: number;          // body overlaps left after legalisation
  outside: number;           // parts whose body still crosses the outline
  seconds: number;
}

interface Part {
  c: Component;
  idx: number;
  movable: boolean;
  hw: number; hh: number;                    // half body (rotation 0)
  padOff: { x: number; y: number }[][];      // per rotation index (0..3): pad offsets, board frame
  nets: number[];                            // net indices touching this part
  rotIdx: number;
  th: boolean;                               // has through-hole pads: its body counts on both sides
  room?: { x1: number; y1: number; x2: number; y2: number };   // placement room the part must stay inside
}

interface NetInfo { name: string; weight: number; pins: { part: number; pad: number }[]; fixed: Pt[]; }
interface Decap { id: number; cap: number; capPad: number; ic: number; icPad: number; }

const ROTS = [0, 90, 180, 270];

function mulberry(seed: number): () => number {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

function pointInPolygon(q: Pt, poly: Pt[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i], b = poly[j];
    if (a.y > q.y !== b.y > q.y && q.x < ((b.x - a.x) * (q.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

function bodyOf(fp: Footprint): { hw: number; hh: number } {
  let w = fp.body?.w ?? 0, h = fp.body?.h ?? 0;
  for (const pd of fp.pads) { w = Math.max(w, 2 * (Math.abs(pd.x) + pd.w / 2)); h = Math.max(h, 2 * (Math.abs(pd.y) + pd.h / 2)); }
  for (const pl of fp.outline ?? []) for (const q of pl) { w = Math.max(w, 2 * Math.abs(q.x)); h = Math.max(h, 2 * Math.abs(q.y)); }
  return { hw: Math.max(0.3, w / 2), hh: Math.max(0.3, h / 2) };
}

/** Two bodies can collide when on the same side, or when either has through-hole pads. */
function sameSide(a: Part, b: Part): boolean { return a.c.side === b.c.side || a.th || b.th; }

/** Half extents of a part's body for a rotation index. */
function ext(p: Part, r: number): { hw: number; hh: number } { return r % 2 === 0 ? { hw: p.hw, hh: p.hh } : { hw: p.hh, hh: p.hw }; }

class Placer {
  parts: Part[] = [];
  nets: NetInfo[] = [];
  bbox: { minX: number; minY: number; maxX: number; maxY: number };
  isRect: boolean;
  spacing: number;
  rnd: () => number;
  outline: Pt[];
  margin: number;
  // density control: body area accumulated per coarse cell
  dCell = 10; dnx = 1; dny = 1; util: Float64Array = new Float64Array(1); dTarget = -1; dW = 0;
  // decoupling affinity: per part, the cap-to-IC-pin links it takes part in
  decaps: Decap[] = []; decapOf: Decap[][] = []; decapW = 0;

  constructor(readonly p: Project, readonly o: PlaceOptions) {
    const lib = { ...defaultLibrary(), ...p.footprints };
    const lockSet = new Set(o.lock ?? []);
    const onlySet = o.only?.length ? new Set(o.only) : null;
    this.spacing = o.spacing ?? 0.5;
    this.rnd = mulberry(o.seed ?? 1);
    this.outline = p.outline;
    const xs = p.outline.map((q) => q.x), ys = p.outline.map((q) => q.y);
    this.bbox = { minX: Math.min(...xs), minY: Math.min(...ys), maxX: Math.max(...xs), maxY: Math.max(...ys) };
    this.isRect = p.outline.length === 4 && p.outline.every((q, i) => { const n = p.outline[(i + 1) % 4]; return Math.abs(q.x - n.x) < 1e-9 || Math.abs(q.y - n.y) < 1e-9; });
    this.margin = (p.rules?.edgeClearance ?? 0.5) + this.spacing / 2;
    const netIdx = new Map<string, number>();
    const padIndex = new Map<string, { part: number; pad: number }>();
    for (const c of p.components) {
      const fp = lib[c.footprint]; if (!fp) continue;
      const { hw, hh } = bodyOf(fp);
      const padOff: { x: number; y: number }[][] = ROTS.map((deg) => {
        const r = (deg * Math.PI) / 180, cs = Math.cos(r), sn = Math.sin(r);
        return fp.pads.map((pd) => { const m = c.side === 'back' ? { x: -pd.x, y: pd.y } : pd; return { x: m.x * cs - m.y * sn, y: m.x * sn + m.y * cs }; });
      });
      const movable = !c.locked && !lockSet.has(c.ref) && (!onlySet || onlySet.has(c.ref));
      const rotIdx = ((Math.round(c.rot / 90) % 4) + 4) % 4;
      const part: Part = { c, idx: this.parts.length, movable, hw, hh, padOff, nets: [], rotIdx, th: fp.pads.some((pd) => pd.th) };
      c.rot = ROTS[rotIdx];
      fp.pads.forEach((pd, i) => padIndex.set(`${c.ref}-${pd.id}`, { part: part.idx, pad: i }));
      this.parts.push(part);
    }
    const ignore = new Set(o.ignoreNets ?? []);
    const big = o.bigNetPins ?? 8;
    const weights = (o.netWeights ?? []).map((w) => ({ re: new RegExp(`^(?:${w.pattern})$`), weight: w.weight }));
    for (const n of p.nets) {
      if (ignore.has(n.name) || n.pins.length < 2) continue;
      const pins = n.pins.map((k) => padIndex.get(k)).filter((x): x is { part: number; pad: number } => !!x);
      if (pins.length < 2) continue;
      const custom = weights.find((w) => w.re.test(n.name));
      const weight = custom ? custom.weight : pins.length <= big ? 1 : big / pins.length;
      const ni = this.nets.length;
      this.nets.push({ name: n.name, weight, pins, fixed: [] });
      netIdx.set(n.name, ni);
      for (const pin of new Set(pins.map((x) => x.part))) this.parts[pin].nets.push(ni);
    }
    this.setupDecaps(p, padIndex, big);
    // rooms: a part listed in a room is kept inside the room's rectangle
    for (const rm of p.rooms ?? []) for (const ref of rm.refs) { const part = this.parts.find((x) => x.c.ref === ref); if (part) part.room = { x1: Math.min(rm.rect.x1, rm.rect.x2), y1: Math.min(rm.rect.y1, rm.rect.y2), x2: Math.max(rm.rect.x1, rm.rect.x2), y2: Math.max(rm.rect.y1, rm.rect.y2) }; }
    if (o.density !== undefined) {
      this.dTarget = o.density; this.dCell = o.densityCell ?? 10;
      this.dnx = Math.max(1, Math.ceil((this.bbox.maxX - this.bbox.minX) / this.dCell)); this.dny = Math.max(1, Math.ceil((this.bbox.maxY - this.bbox.minY) / this.dCell));
      this.util = new Float64Array(this.dnx * this.dny);
      for (const part of this.parts) this.util[this.cellOf(part.c.x, part.c.y)] += this.area(part);
    }
  }

  /**
   * Decoupling caps: two-pad parts whose nets are a power net and a ground net (both carried by many pins). Each is
   * linked to one power pin of that net on an IC (a part with 8+ pads): caps claim the nearest unclaimed pin, nearest
   * pairs first, and share pins once every pin of the net is taken.
   */
  private setupDecaps(p: Project, padIndex: Map<string, { part: number; pad: number }>, big: number): void {
    this.decapOf = this.parts.map(() => []);
    this.decapW = this.o.decap ?? 2;
    if (this.decapW <= 0) return;
    const isGround = (n: string) => /^(A|D|P|S)?GND|^VSS|^GND/i.test(n);
    const netPins = new Map<string, { part: number; pad: number }[]>();
    for (const n of p.nets) netPins.set(n.name, n.pins.map((k) => padIndex.get(k)).filter((x): x is { part: number; pad: number } => !!x));
    const padNet = new Map<string, string>();
    for (const n of p.nets) for (const k of n.pins) padNet.set(k, n.name);
    const lib = { ...defaultLibrary(), ...p.footprints };
    const cand: { cap: number; capPad: number; net: string }[] = [];
    for (const part of this.parts) {
      const fp = lib[part.c.footprint]; if (!fp || fp.pads.length !== 2) continue;
      const nets = fp.pads.map((pd) => padNet.get(`${part.c.ref}-${pd.id}`) ?? '');
      const gi = nets.findIndex(isGround); if (gi < 0) continue;
      const pi = 1 - gi, net = nets[pi];
      if (!net || isGround(net) || (netPins.get(net)?.length ?? 0) <= big) continue;
      cand.push({ cap: part.idx, capPad: pi, net });
    }
    const pairs: { c: number; ic: { part: number; pad: number }; d: number }[] = [];
    cand.forEach((c, ci) => {
      for (const pin of netPins.get(c.net) ?? []) {
        const ic = this.parts[pin.part]; if (ic.idx === c.cap || ic.padOff[0].length < 8) continue;
        const a = this.padPos(this.parts[c.cap], c.capPad), b = this.padPos(ic, pin.pad);
        pairs.push({ c: ci, ic: pin, d: Math.abs(a.x - b.x) + Math.abs(a.y - b.y) });
      }
    });
    pairs.sort((x, y) => x.d - y.d);
    const linked = new Set<number>(), taken = new Set<string>();
    const link = (ci: number, ic: { part: number; pad: number }) => { const c = cand[ci]; const d: Decap = { id: this.decaps.length, cap: c.cap, capPad: c.capPad, ic: ic.part, icPad: ic.pad }; this.decaps.push(d); this.decapOf[c.cap].push(d); this.decapOf[ic.part].push(d); linked.add(ci); };
    for (const pr of pairs) { const key = `${pr.ic.part}:${pr.ic.pad}`; if (linked.has(pr.c) || taken.has(key)) continue; taken.add(key); link(pr.c, pr.ic); }
    for (const pr of pairs) if (!linked.has(pr.c)) link(pr.c, pr.ic);   // more caps than pins: share the nearest
    this.o.log?.(`autoplace: ${this.decaps.length} decoupling caps linked to IC power pins`);
  }

  decapCost(d: Decap): number { const a = this.padPos(this.parts[d.cap], d.capPad), b = this.padPos(this.parts[d.ic], d.icPad); return this.decapW * (Math.abs(a.x - b.x) + Math.abs(a.y - b.y)); }
  decapTotal(): number { let s = 0; for (const d of this.decaps) s += this.decapCost(d); return s; }

  area(part: Part): number { return (2 * part.hw + this.spacing) * (2 * part.hh + this.spacing); }
  cellOf(x: number, y: number): number {
    const i = Math.min(this.dnx - 1, Math.max(0, Math.floor((x - this.bbox.minX) / this.dCell)));
    const j = Math.min(this.dny - 1, Math.max(0, Math.floor((y - this.bbox.minY) / this.dCell)));
    return j * this.dnx + i;
  }
  /** Over-utilisation penalty (mm2-like) of a set of density cells. */
  densityPen(cells: Iterable<number>): number {
    if (this.dTarget < 0) return 0;
    const cap = this.dTarget * this.dCell * this.dCell; let s = 0;
    for (const c of cells) { const over = this.util[c] - cap; if (over > 0) s += (over * over) / (this.dCell * this.dCell); }
    return s * this.dW;
  }

  padPos(part: Part, pad: number, x = part.c.x, y = part.c.y, r = part.rotIdx): Pt { const o = part.padOff[r][pad]; return { x: x + o.x, y: y + o.y }; }

  hpwl(ni: number): number {
    const n = this.nets[ni];
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const pin of n.pins) { const q = this.padPos(this.parts[pin.part], pin.pad); if (q.x < minX) minX = q.x; if (q.x > maxX) maxX = q.x; if (q.y < minY) minY = q.y; if (q.y > maxY) maxY = q.y; }
    return (maxX - minX + maxY - minY) * n.weight;
  }

  wirelength(): number { let s = 0; for (let i = 0; i < this.nets.length; i++) s += this.hpwl(i); return s; }

  /** Overlap area of part i's body with every other body (plus spacing), and the area outside the board. */
  overlapOf(i: number): number {
    const a = this.parts[i]; const ea = ext(a, a.rotIdx);
    let s = 0;
    for (let j = 0; j < this.parts.length; j++) {
      if (j === i) continue;
      const b = this.parts[j]; if (!sameSide(a, b)) continue;
      const eb = ext(b, b.rotIdx);
      const ox = ea.hw + eb.hw + this.spacing - Math.abs(a.c.x - b.c.x);
      if (ox <= 0) continue;
      const oy = ea.hh + eb.hh + this.spacing - Math.abs(a.c.y - b.c.y);
      if (oy <= 0) continue;
      s += ox * oy;
    }
    return s + this.outsideOf(a);
  }

  outsideOf(a: Part): number {
    const e = ext(a, a.rotIdx); const m = this.margin;
    let s = 0;
    s += Math.max(0, this.bbox.minX + m - (a.c.x - e.hw)) * 2 * e.hh;
    s += Math.max(0, (a.c.x + e.hw) - (this.bbox.maxX - m)) * 2 * e.hh;
    s += Math.max(0, this.bbox.minY + m - (a.c.y - e.hh)) * 2 * e.hw;
    s += Math.max(0, (a.c.y + e.hh) - (this.bbox.maxY - m)) * 2 * e.hw;
    if (a.room) {
      // outside its room counts like outside the board
      s += Math.max(0, a.room.x1 - (a.c.x - e.hw)) * 2 * e.hh + Math.max(0, (a.c.x + e.hw) - a.room.x2) * 2 * e.hh;
      s += Math.max(0, a.room.y1 - (a.c.y - e.hh)) * 2 * e.hw + Math.max(0, (a.c.y + e.hh) - a.room.y2) * 2 * e.hw;
    }
    if (!this.isRect) {
      for (const q of [{ x: a.c.x - e.hw, y: a.c.y - e.hh }, { x: a.c.x + e.hw, y: a.c.y - e.hh }, { x: a.c.x + e.hw, y: a.c.y + e.hh }, { x: a.c.x - e.hw, y: a.c.y + e.hh }]) if (!pointInPolygon(q, this.outline)) s += e.hw * e.hh;
    }
    return s;
  }

  /** Cost contribution of a set of parts: their nets' HPWL plus overlap penalties. */
  localCost(ids: number[], overlapW: number): number {
    const seen = new Set<number>(); let s = 0;
    const seenD = new Set<number>();
    for (const i of ids) {
      for (const ni of this.parts[i].nets) if (!seen.has(ni)) { seen.add(ni); s += this.hpwl(ni); }
      for (const d of this.decapOf[i]) if (!seenD.has(d.id)) { seenD.add(d.id); s += this.decapCost(d); }
      s += overlapW * this.overlapOf(i);
    }
    return s;
  }

  anneal(): void {
    const mov = this.parts.filter((p) => p.movable);
    if (!mov.length) return;
    const iters = Math.max(1, Math.round((this.o.iterations ?? 600) * mov.length));
    const W = this.bbox.maxX - this.bbox.minX, H = this.bbox.maxY - this.bbox.minY;
    const rotate = this.o.rotate ?? true;
    const avgNet = Math.max(1, this.wirelength() / Math.max(1, this.nets.length));
    const overlapW = 4 * avgNet;   // one mm² of overlap costs as much as a few mm of wire
    this.dW = overlapW;
    // initial temperature from a sample of random moves
    let sample = 0, ns = 0;
    for (let k = 0; k < 50; k++) { const d = this.tryMove(mov[Math.floor(this.rnd() * mov.length)], Math.max(W, H) / 4, rotate, overlapW, Infinity, true); if (d !== null) { sample += Math.abs(d); ns++; } }
    const T0 = Math.max(1e-3, (ns ? sample / ns : avgNet) * 0.5);
    const Tend = T0 / 2000;
    const alpha = Math.pow(Tend / T0, 1 / iters);
    let T = T0;
    for (let k = 0; k < iters; k++) {
      const range = Math.max(this.o.grid ?? 0.5, Math.max(W, H) * 0.5 * (T / T0) ** 0.5);
      const m = this.rnd();
      if (m < 0.2 && mov.length > 1) this.trySwap(mov[Math.floor(this.rnd() * mov.length)], mov[Math.floor(this.rnd() * mov.length)], overlapW, T);
      else this.tryMove(mov[Math.floor(this.rnd() * mov.length)], range, rotate, overlapW, T, false);
      T *= alpha;
    }
  }

  private accept(delta: number, T: number): boolean { return delta <= 0 || (T > 0 && this.rnd() < Math.exp(-delta / T)); }

  /** Random translate (and maybe rotate) of one part; returns the delta if evaluated (null = no-op). */
  private tryMove(a: Part, range: number, rotate: boolean, overlapW: number, T: number, probeOnly: boolean): number | null {
    const ox = a.c.x, oy = a.c.y, orot = a.rotIdx;
    const ang = this.rnd() * Math.PI * 2, dist = this.rnd() * range;
    const nx = Math.min(this.bbox.maxX, Math.max(this.bbox.minX, ox + Math.cos(ang) * dist));
    const ny = Math.min(this.bbox.maxY, Math.max(this.bbox.minY, oy + Math.sin(ang) * dist));
    const c0 = this.cellOf(ox, oy), c1 = this.cellOf(nx, ny); const cells = c0 === c1 ? [c0] : [c0, c1];
    const before = this.localCost([a.idx], overlapW) + this.densityPen(cells);
    a.c.x = nx; a.c.y = ny;
    if (rotate && this.rnd() < 0.25) { a.rotIdx = (a.rotIdx + 1 + Math.floor(this.rnd() * 3)) % 4; a.c.rot = ROTS[a.rotIdx]; }
    if (c0 !== c1) { const ar = this.area(a); this.util[c0] -= ar; this.util[c1] += ar; }
    const delta = this.localCost([a.idx], overlapW) + this.densityPen(cells) - before;
    if (probeOnly || !this.accept(delta, T)) { a.c.x = ox; a.c.y = oy; a.rotIdx = orot; a.c.rot = ROTS[orot]; if (c0 !== c1) { const ar = this.area(a); this.util[c1] -= ar; this.util[c0] += ar; } }
    return delta;
  }

  private trySwap(a: Part, b: Part, overlapW: number, T: number): void {
    if (a === b || a.c.side !== b.c.side || a.th !== b.th) return;
    const ca = this.cellOf(a.c.x, a.c.y), cb = this.cellOf(b.c.x, b.c.y); const cells = ca === cb ? [ca] : [ca, cb];
    const dArea = this.area(a) - this.area(b);
    const before = this.localCost([a.idx, b.idx], overlapW) + this.densityPen(cells);
    const ax = a.c.x, ay = a.c.y; a.c.x = b.c.x; a.c.y = b.c.y; b.c.x = ax; b.c.y = ay;
    if (ca !== cb) { this.util[ca] -= dArea; this.util[cb] += dArea; }
    const delta = this.localCost([a.idx, b.idx], overlapW) + this.densityPen(cells) - before;
    if (!this.accept(delta, T)) { b.c.x = a.c.x; b.c.y = a.c.y; a.c.x = ax; a.c.y = ay; if (ca !== cb) { this.util[ca] += dArea; this.util[cb] -= dArea; } }
  }

  /** Push overlapping bodies apart, keep inside the outline, snap to grid. */
  legalize(): { overlaps: number; outside: number } {
    const grid = this.o.grid ?? 0.5;
    const mov = this.parts.filter((p) => p.movable);
    const snap = (v: number) => Math.round(v / grid) * grid;
    for (const a of mov) { a.c.x = snap(a.c.x); a.c.y = snap(a.c.y); }
    for (let round = 0; round < 400; round++) {
      let moved = false;
      for (const a of mov) {
        const ea = ext(a, a.rotIdx);
        const m = this.margin;
        // clamp to grid points that lie inside the margin (snapping must not push a part back out)
        const lo = (v: number) => Math.ceil((v - 1e-9) / grid) * grid, hi = (v: number) => Math.floor((v + 1e-9) / grid) * grid;
        const bx0 = Math.max(this.bbox.minX + m, a.room ? a.room.x1 : -Infinity), bx1 = Math.min(this.bbox.maxX - m, a.room ? a.room.x2 : Infinity);
        const by0 = Math.max(this.bbox.minY + m, a.room ? a.room.y1 : -Infinity), by1 = Math.min(this.bbox.maxY - m, a.room ? a.room.y2 : Infinity);
        const nx = Math.min(hi(bx1 - ea.hw), Math.max(lo(bx0 + ea.hw), a.c.x));
        const ny = Math.min(hi(by1 - ea.hh), Math.max(lo(by0 + ea.hh), a.c.y));
        if (nx !== a.c.x || ny !== a.c.y) { a.c.x = nx; a.c.y = ny; moved = true; }
        for (const b of this.parts) {
          if (a === b || !sameSide(a, b)) continue;
          const eb = ext(b, b.rotIdx);
          const ox = ea.hw + eb.hw + this.spacing - Math.abs(a.c.x - b.c.x);
          const oy = ea.hh + eb.hh + this.spacing - Math.abs(a.c.y - b.c.y);
          if (ox <= 1e-9 || oy <= 1e-9) continue;
          const bMov = b.movable;
          const share = bMov ? 0.5 : 1;
          if (ox < oy) { const s = Math.sign(a.c.x - b.c.x) || (this.rnd() < 0.5 ? 1 : -1); a.c.x = snap(a.c.x + s * ox * share + (share < 1 ? 0 : 0)); if (bMov) b.c.x = snap(b.c.x - s * ox * share); }
          else { const s = Math.sign(a.c.y - b.c.y) || (this.rnd() < 0.5 ? 1 : -1); a.c.y = snap(a.c.y + s * oy * share); if (bMov) b.c.y = snap(b.c.y - s * oy * share); }
          moved = true;
        }
      }
      if (!moved) break;
    }
    let overlaps = 0, outside = 0;
    for (const a of this.parts) {
      const ea = ext(a, a.rotIdx);
      for (const b of this.parts) {
        if (b.idx <= a.idx || !sameSide(a, b)) continue;
        const eb = ext(b, b.rotIdx);
        if (ea.hw + eb.hw - Math.abs(a.c.x - b.c.x) > 1e-6 && ea.hh + eb.hh - Math.abs(a.c.y - b.c.y) > 1e-6) overlaps++;
      }
      if (a.movable && this.outsideOf(a) > 1e-6) outside++;
    }
    return { overlaps, outside };
  }

  /** Rows by reference designator inside the outline (Quickplace). */
  quick(): void {
    const mov = this.parts.filter((p) => p.movable);
    const key = (r: string) => { const m = /^([A-Za-z]+)(\d+)/.exec(r); return m ? [m[1], Number(m[2])] as const : [r, 0] as const; };
    mov.sort((a, b) => { const ka = key(a.c.ref), kb = key(b.c.ref); return ka[0] < kb[0] ? -1 : ka[0] > kb[0] ? 1 : ka[1] - kb[1]; });
    const m = this.margin, gap = this.spacing;
    let x = this.bbox.minX + m, y = this.bbox.minY + m, rowH = 0;
    for (const a of mov) {
      const e = ext(a, a.rotIdx);
      if (x + 2 * e.hw > this.bbox.maxX - m && x > this.bbox.minX + m) { x = this.bbox.minX + m; y += rowH + gap; rowH = 0; }
      a.c.x = x + e.hw; a.c.y = y + e.hh;
      x += 2 * e.hw + gap; rowH = Math.max(rowH, 2 * e.hh);
    }
  }
}

export function autoplace(p: Project, o: PlaceOptions = {}): PlaceResult {
  const t0 = Date.now();
  const pl = new Placer(p, o);
  const before = pl.wirelength();
  if (o.mode === 'quick') pl.quick();
  else pl.anneal();
  const leg = pl.legalize();
  const after = pl.wirelength();
  const placed = pl.parts.filter((x) => x.movable).length;
  o.log?.(`${o.mode === 'quick' ? 'quickplace' : 'autoplace'}: ${placed} parts placed, ${pl.parts.length - placed} held; wirelength ${before.toFixed(1)} -> ${after.toFixed(1)} mm; overlaps ${leg.overlaps}, outside ${leg.outside}`);
  return { placed, held: pl.parts.length - placed, wirelengthBefore: before, wirelengthAfter: after, overlaps: leg.overlaps, outside: leg.outside, seconds: (Date.now() - t0) / 1000 };
}
