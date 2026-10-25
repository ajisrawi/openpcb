/**
 * Routing lattice: a regular grid of candidate wire centre-lines per signal
 * layer (any pitch), with
 *   - fixed obstacle maps: for every cell the *effective* distance to the
 *     nearest fixed copper/keepout edge (actual distance minus the pair
 *     clearance that object type requires, plus the pcb default clearance) and
 *     which net owns it, plus the nearest edge of a *different* net — so a net
 *     can pass next to its own pads but keeps the right typed clearance from
 *     everything else. One such map per *via type* serves vias: a via type is a
 *     padstack with a layer span (through, blind or buried), and its map holds
 *     the worst effective distance over the layers it spans.
 *   - dynamic occupancy: routed wire centre-lines (centre), wire *marks* (mark:
 *     all cells within width+clearance of a centre-line), via centres and via
 *     marks — all per routing layer, so a blind via only blocks the layers it
 *     passes. A foreign centre-line inside a mark is a conflict; conflicts are
 *     recorded rather than forbidden, which is what adaptive multi-pass routing
 *     needs. Cells shared by several nets keep an explicit list so removals are
 *     exact.
 */
import type { Board, Item } from '../board.js';
import { geomDistance } from '../drc.js';
import { pointInPolygon, distPointSeg, type Pt } from '../geom.js';

export const NET_NONE = -1;
export const NET_KEEPOUT = -2;
export const NET_MULTI = -3;

export interface LatticeOptions {
  pitch?: number;              // resolution units; default = (min width + min clearance) / 2
  maxCells?: number;           // soft cap on nx*ny*layers
  edgeClearance?: number;      // copper to board outline (resolution units); default = wire clearance
}

/** A usable via padstack: its radius and the routing layers (k0..k1) and board layers (b0..b1) it spans. */
export interface ViaType {
  index: number;
  name: string;
  r: number;
  k0: number; k1: number;      // routing-layer span (inclusive)
  b0: number; b1: number;      // board-layer span (inclusive), for plane reachability
  through: boolean;
  micro: boolean;              // spans exactly two adjacent board layers
}

/** Owner map with counts and explicit multi-net lists. */
class OwnerMap {
  readonly net: Int32Array; readonly cnt: Uint16Array; readonly multi = new Map<number, number[]>();
  constructor(size: number) { this.net = new Int32Array(size).fill(NET_NONE); this.cnt = new Uint16Array(size); }
  add(idx: number, net: number): void {
    const prev = this.net[idx];
    this.cnt[idx]++;
    if (prev === NET_NONE) { this.net[idx] = net; return; }
    if (prev === net) return;
    if (prev === NET_MULTI) { this.multi.get(idx)!.push(net); return; }
    this.net[idx] = NET_MULTI; this.multi.set(idx, [prev, net]);
  }
  remove(idx: number, net: number): void {
    if (this.cnt[idx] === 0) return;
    this.cnt[idx]--;
    if (this.cnt[idx] === 0) { this.net[idx] = NET_NONE; this.multi.delete(idx); return; }
    if (this.net[idx] !== NET_MULTI) return;
    const list = this.multi.get(idx)!;
    const i = list.indexOf(net); if (i >= 0) list.splice(i, 1);
    if (new Set(list).size <= 1) { this.net[idx] = list.length ? list[0] : NET_NONE; this.multi.delete(idx); }
  }
  foreign(idx: number, net: number): boolean { const n = this.net[idx]; return n !== NET_NONE && n !== net; }
  has(idx: number, net: number): boolean { const n = this.net[idx]; return n === net || (n === NET_MULTI && this.multi.get(idx)!.includes(net)); }
  clear(): void { this.net.fill(NET_NONE); this.cnt.fill(0); this.multi.clear(); }
}

export class Lattice {
  readonly pitch: number;
  readonly ox: number; readonly oy: number;
  readonly nx: number; readonly ny: number;
  readonly nl: number;                     // number of routing layers
  readonly layers: number[];               // board layer index per routing layer k
  readonly kOf = new Map<number, number>(); // board layer -> k
  readonly size: number;                   // nx*ny
  readonly c0: number;                     // pcb default clearance
  private readonly edgeOffset: number;
  // fixed obstacles (per routing layer), effective distances
  readonly fNetA: Int32Array[]; readonly fDistA: Float32Array[];
  readonly fNetB: Int32Array[]; readonly fDistB: Float32Array[];
  readonly viaBlocked: Uint8Array;         // via keepouts / outside board
  // via types and their fixed maps (per type)
  readonly viaTypes: ViaType[] = [];
  readonly typeFor: Int16Array;            // [k*nl + k'] -> via type index for a layer change k->k', or -1
  readonly maxViaR: Float64Array;          // per routing layer: largest radius of a via type spanning it
  readonly vfNetA: Int32Array[]; readonly vfDistA: Float32Array[]; readonly vfNetB: Int32Array[]; readonly vfDistB: Float32Array[];
  // dynamic occupancy (per routing layer)
  readonly centre: OwnerMap[]; readonly mark: OwnerMap[];
  readonly viaCentre: OwnerMap[]; readonly viaMark: OwnerMap[];
  readonly viaRad: Float32Array[];         // per routing layer: radius of the via(s) centred at each cell (largest)
  viaClr = 0;                              // via-via clearance folded into r2own (set by the router), for same-net spacing
  readonly reach: number;
  readonly netIds = new Map<string, number>();
  readonly netNames: string[] = [];

  constructor(readonly board: Board, opts: LatticeOptions = {}) {
    const ex = board.rules.extremes();
    this.c0 = board.rules.clearance(undefined, undefined, 'wire', 'wire');
    this.edgeOffset = this.c0 - (opts.edgeClearance ?? this.c0);   // effective distance = actual - edge clearance + c0
    let pitch = opts.pitch ?? board.design.structure.gridWire ?? 0;
    if (pitch <= 0) pitch = Math.max(1, (ex.minWidth + this.c0) / 2);   // half of width + wire clearance
    const bb = board.bbox;
    const w = bb.maxX - bb.minX, h = bb.maxY - bb.minY;
    this.layers = board.signalLayers.slice();
    this.nl = this.layers.length;
    const maxCells = opts.maxCells ?? 4_000_000;
    while ((Math.ceil(w / pitch) + 2) * (Math.ceil(h / pitch) + 2) * Math.max(1, this.nl) > maxCells) pitch *= 1.25;
    this.pitch = pitch;
    this.ox = bb.minX; this.oy = bb.minY;
    this.nx = Math.ceil(w / pitch) + 1;
    this.ny = Math.ceil(h / pitch) + 1;
    this.size = this.nx * this.ny;
    this.layers.forEach((l, k) => this.kOf.set(l, k));
    this.buildViaTypes();
    this.reach = ex.maxClearance + ex.maxWidth + this.viaRadius() + pitch;
    this.fNetA = []; this.fDistA = []; this.fNetB = []; this.fDistB = []; this.centre = []; this.mark = []; this.viaCentre = []; this.viaMark = []; this.viaRad = [];
    for (let k = 0; k < this.nl; k++) {
      this.fNetA.push(new Int32Array(this.size).fill(NET_NONE));
      this.fDistA.push(new Float32Array(this.size).fill(Infinity));
      this.fNetB.push(new Int32Array(this.size).fill(NET_NONE));
      this.fDistB.push(new Float32Array(this.size).fill(Infinity));
      this.centre.push(new OwnerMap(this.size));
      this.mark.push(new OwnerMap(this.size));
      this.viaCentre.push(new OwnerMap(this.size));
      this.viaMark.push(new OwnerMap(this.size));
      this.viaRad.push(new Float32Array(this.size));
    }
    this.viaBlocked = new Uint8Array(this.size);
    this.vfNetA = []; this.vfDistA = []; this.vfNetB = []; this.vfDistB = [];
    for (let t = 0; t < this.viaTypes.length; t++) {
      this.vfNetA.push(new Int32Array(this.size).fill(NET_NONE)); this.vfDistA.push(new Float32Array(this.size).fill(Infinity));
      this.vfNetB.push(new Int32Array(this.size).fill(NET_NONE)); this.vfDistB.push(new Float32Array(this.size).fill(Infinity));
    }
    this.typeFor = new Int16Array(this.nl * this.nl).fill(-1);
    this.maxViaR = new Float64Array(this.nl);
    for (let k = 0; k < this.nl; k++) for (let k2 = 0; k2 < this.nl; k2++) {
      if (k === k2) continue;
      const lo = Math.min(k, k2), hi = Math.max(k, k2);
      let best = -1, bestSpan = Infinity;
      for (const t of this.viaTypes) if (t.k0 <= lo && t.k1 >= hi && t.k1 - t.k0 < bestSpan) { best = t.index; bestSpan = t.k1 - t.k0; }
      this.typeFor[k * this.nl + k2] = best;
    }
    for (const t of this.viaTypes) for (let k = t.k0; k <= t.k1; k++) this.maxViaR[k] = Math.max(this.maxViaR[k], t.r);
    for (const n of board.design.network.nets.keys()) this.netId(n);
    this.rasterizeFixed();
  }

  netId(name: string | undefined): number {
    if (!name) return NET_NONE;
    let id = this.netIds.get(name);
    if (id === undefined) { id = this.netNames.length; this.netNames.push(name); this.netIds.set(name, id); }
    return id;
  }

  /** Radius of a padstack (largest shape extent). */
  static padstackRadius(ps: { shapes: { kind: string; diameter?: number; rect?: { x1: number; y1: number; x2: number; y2: number }; points?: Pt[]; width?: number }[] } | undefined): number {
    let r = 0;
    if (ps) for (const s of ps.shapes) {
      if (s.kind === 'circle') r = Math.max(r, (s.diameter ?? 0) / 2);
      else if (s.kind === 'rect' && s.rect) r = Math.max(r, Math.hypot(s.rect.x2 - s.rect.x1, s.rect.y2 - s.rect.y1) / 2);
      else if (s.points) for (const p of s.points) r = Math.max(r, Math.hypot(p.x, p.y) + (s.width ?? 0) / 2);
    }
    return r;
  }

  /** Via types from the design's usable via padstacks: the layers their shapes cover define the span. */
  private buildViaTypes(): void {
    const d = this.board.design;
    const nBoard = d.structure.layers.length;
    for (const name of d.structure.vias) {
      const ps = d.library.padstacks.get(name);
      if (!ps) continue;
      let b0 = Infinity, b1 = -Infinity;
      for (const s of ps.shapes) for (const li of this.board.layersFor(s.layer)) { b0 = Math.min(b0, li); b1 = Math.max(b1, li); }
      if (!Number.isFinite(b0)) { b0 = 0; b1 = nBoard - 1; }
      // routing layers inside the board-layer span
      let k0 = Infinity, k1 = -Infinity;
      this.layers.forEach((li, k) => { if (li >= b0 && li <= b1) { k0 = Math.min(k0, k); k1 = Math.max(k1, k); } });
      if (!Number.isFinite(k0)) continue;   // spans no routing layer: useless for routing
      const r = Lattice.padstackRadius(ps) || this.board.rules.defaultWidth();
      this.viaTypes.push({ index: this.viaTypes.length, name, r, k0, k1, b0, b1, through: b0 === 0 && b1 === nBoard - 1, micro: b1 - b0 === 1 });
    }
    if (!this.viaTypes.length) {
      // no usable via padstack declared: assume one through via of the default width
      this.viaTypes.push({ index: 0, name: d.structure.vias[0] ?? 'VIA', r: this.board.rules.defaultWidth(), k0: 0, k1: Math.max(0, this.nl - 1), b0: 0, b1: nBoard - 1, through: true, micro: false });
    }
  }

  viaTypeByName(name: string): ViaType | undefined { return this.viaTypes.find((t) => t.name === name); }

  /** Smallest via type covering routing layers lo..hi (and, when given, the board layer `reachBoard`). */
  viaTypeCovering(lo: number, hi: number, reachBoard?: number, allowed?: Uint8Array): ViaType | undefined {
    let best: ViaType | undefined;
    for (const t of this.viaTypes) {
      if (allowed && !allowed[t.index]) continue;
      if (t.k0 > lo || t.k1 < hi) continue;
      if (reachBoard !== undefined && (t.b0 > reachBoard || t.b1 < reachBoard)) continue;
      if (!best || t.b1 - t.b0 < best.b1 - best.b0) best = t;
    }
    return best;
  }

  /** Largest via radius among usable via padstacks. */
  viaRadius(): number {
    let r = 0;
    for (const t of this.viaTypes) r = Math.max(r, t.r);
    return r || this.board.rules.defaultWidth();
  }

  idx(i: number, j: number): number { return j * this.nx + i; }
  node(k: number, i: number, j: number): number { return k * this.size + j * this.nx + i; }
  cellX(i: number): number { return this.ox + i * this.pitch; }
  cellY(j: number): number { return this.oy + j * this.pitch; }
  toI(x: number): number { return Math.round((x - this.ox) / this.pitch); }
  toJ(y: number): number { return Math.round((y - this.oy) / this.pitch); }
  inside(i: number, j: number): boolean { return i >= 0 && j >= 0 && i < this.nx && j < this.ny; }

  /** Effective distance from the cell to the nearest fixed object not owned by `net` on layer k. */
  foreignDist(k: number, idx: number, net: number): number {
    const a = this.fNetA[k][idx];
    if (a === NET_NONE) return Infinity;
    if (a !== net) return this.fDistA[k][idx];
    const b = this.fNetB[k][idx];
    return b === NET_NONE ? Infinity : this.fDistB[k][idx];
  }

  private static rec(na: Int32Array, da: Float32Array, nb: Int32Array, db: Float32Array, idx: number, net: number, d: number): void {
    if (d < da[idx]) {
      if (na[idx] !== net && na[idx] !== NET_NONE) { nb[idx] = na[idx]; db[idx] = da[idx]; }
      na[idx] = net; da[idx] = d;
    } else if (net !== na[idx] && d < db[idx]) {
      nb[idx] = net; db[idx] = d;
    }
  }

  /** Rasterize one item into the wire map of routing layer k (k < 0: none) and the via maps of the given types. */
  private rasterizeItem(item: Item, k: number, net: number, offW: number, offV: number, viaTypes: number[]): void {
    const R = this.reach;
    const i0 = Math.max(0, Math.floor((item.bbox.minX - R - this.ox) / this.pitch));
    const i1 = Math.min(this.nx - 1, Math.ceil((item.bbox.maxX + R - this.ox) / this.pitch));
    const j0 = Math.max(0, Math.floor((item.bbox.minY - R - this.oy) / this.pitch));
    const j1 = Math.min(this.ny - 1, Math.ceil((item.bbox.maxY + R - this.oy) / this.pitch));
    const probe = { type: 'circle' as const, c: { x: 0, y: 0 }, r: 0 };
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        probe.c.x = this.cellX(i); probe.c.y = this.cellY(j);
        const d = geomDistance(probe, item.geom);
        if (d >= R) continue;
        const idx = this.idx(i, j);
        if (k >= 0) Lattice.rec(this.fNetA[k], this.fDistA[k], this.fNetB[k], this.fDistB[k], idx, net, d + offW);
        for (const t of viaTypes) Lattice.rec(this.vfNetA[t], this.vfDistA[t], this.vfNetB[t], this.vfDistB[t], idx, net, d + offV);
      }
    }
  }

  /** Via types whose board-layer span includes board layer `li` (li = -1: every type). */
  private viaTypesOnBoardLayer(li: number): number[] {
    if (li < 0) return this.viaTypes.map((t) => t.index);
    return this.viaTypes.filter((t) => t.b0 <= li && t.b1 >= li).map((t) => t.index);
  }

  private rasterizeFixed(): void {
    const b = this.board;
    const rules = b.rules;
    for (const item of b.items) {
      if (item.kind === 'plane') continue;   // copper pours yield to traces (re-poured by the host); not obstacles
      if (!item.fixed && item.kind !== 'pad') continue;
      if (item.kind === 'via_keepout') { this.markViaKeepout(item); continue; }
      const isKeepout = item.kind === 'keepout' || item.kind === 'wire_keepout';
      const net = isKeepout ? NET_KEEPOUT : this.netId(item.net);
      const n = net === NET_NONE ? NET_KEEPOUT : net;
      // effective distance = actual - typed clearance + default clearance
      const offW = this.c0 - (isKeepout ? 0 : rules.clearance(item.net, undefined, 'wire', item.objType));
      const offV = this.c0 - (isKeepout ? 0 : rules.clearance(item.net, undefined, 'via', item.objType));
      const k = item.layer === -1 ? -1 : (this.kOf.has(item.layer) ? this.kOf.get(item.layer)! : -2);
      const viaTypes = item.kind === 'wire_keepout' ? [] : this.viaTypesOnBoardLayer(item.layer);
      if (item.layer === -1) {
        // all-layer item (through-hole pad, keepout on every layer): every wire map and every via type
        for (let kk = 0; kk < this.nl; kk++) this.rasterizeItem(item, kk, n, offW, offV, kk === 0 ? viaTypes : []);
        if (this.nl === 0) this.rasterizeItem(item, -1, n, offW, offV, viaTypes);
      } else if (k >= 0) this.rasterizeItem(item, k, n, offW, offV, viaTypes);
      else if (viaTypes.length) this.rasterizeItem(item, -1, n, offW, offV, viaTypes);   // plane-layer copper blocks vias passing that layer
      if (item.kind === 'keepout') this.markViaKeepout(item);
    }
    // board boundary: outside = blocked, near edge = distance
    const poly = b.boundary;
    if (poly.length >= 3) {
      const R = this.reach;
      const allTypes = this.viaTypes.map((t) => t.index);
      for (let j = 0; j < this.ny; j++) for (let i = 0; i < this.nx; i++) {
        const p = { x: this.cellX(i), y: this.cellY(j) };
        const idx = this.idx(i, j);
        if (!pointInPolygon(p, poly)) {
          for (let k = 0; k < this.nl; k++) Lattice.rec(this.fNetA[k], this.fDistA[k], this.fNetB[k], this.fDistB[k], idx, NET_KEEPOUT, 0);
          this.viaBlocked[idx] = 1;
          continue;
        }
        let d = Infinity;
        for (let a = 0, bI = poly.length - 1; a < poly.length; bI = a++) d = Math.min(d, distPointSeg(p, poly[bI], poly[a]));
        d += this.edgeOffset;
        if (d < R) {
          for (let k = 0; k < this.nl; k++) Lattice.rec(this.fNetA[k], this.fDistA[k], this.fNetB[k], this.fDistB[k], idx, NET_KEEPOUT, d);
          for (const t of allTypes) Lattice.rec(this.vfNetA[t], this.vfDistA[t], this.vfNetB[t], this.vfDistB[t], idx, NET_KEEPOUT, d);
        }
      }
    }
  }

  private markViaKeepout(item: Item): void {
    // a via may not overlap the keep-out at all: block every centre within the largest via radius of it
    const vr = this.viaTypes.length ? Math.max(...this.viaTypes.map((t) => t.r)) : 0;
    const i0 = Math.max(0, Math.floor((item.bbox.minX - vr - this.ox) / this.pitch));
    const i1 = Math.min(this.nx - 1, Math.ceil((item.bbox.maxX + vr - this.ox) / this.pitch));
    const j0 = Math.max(0, Math.floor((item.bbox.minY - vr - this.oy) / this.pitch));
    const j1 = Math.min(this.ny - 1, Math.ceil((item.bbox.maxY + vr - this.oy) / this.pitch));
    const probe = { type: 'circle' as const, c: { x: 0, y: 0 }, r: vr };
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
      probe.c.x = this.cellX(i); probe.c.y = this.cellY(j);
      if (geomDistance(probe, item.geom) <= 0) this.viaBlocked[this.idx(i, j)] = 1;
    }
  }

  /* ---------- dynamic occupancy ---------- */

  clearDynamic(): void {
    for (let k = 0; k < this.nl; k++) { this.centre[k].clear(); this.mark[k].clear(); this.viaCentre[k].clear(); this.viaMark[k].clear(); this.viaRad[k].fill(0); }
  }

  /** True if the fixed obstacles allow a via of type t for `net` at cell idx. */
  viaFixedOk(idx: number, net: number, need: number, t: number): boolean {
    if (this.viaBlocked[idx]) return false;
    const a = this.vfNetA[t][idx];
    if (a === NET_NONE) return true;
    if (a !== net) return this.vfDistA[t][idx] >= need;
    const b = this.vfNetB[t][idx];
    return b === NET_NONE || this.vfDistB[t][idx] >= need;
  }

  /** Cells within radius r (resolution units) of cell (i,j). */
  disk(i: number, j: number, r: number, out: number[]): void {
    const rc = Math.ceil(r / this.pitch);
    for (let dj = -rc; dj <= rc; dj++) for (let di = -rc; di <= rc; di++) {
      if (Math.hypot(di, dj) * this.pitch > r) continue;
      const ii = i + di, jj = j + dj;
      if (this.inside(ii, jj)) out.push(this.idx(ii, jj));
    }
  }

  /** Register / unregister a via of radius r centred at idx on routing layer k. */
  addVia(k: number, idx: number, net: number, r: number): void { this.viaCentre[k].add(idx, net); if (r > this.viaRad[k][idx]) this.viaRad[k][idx] = r; }
  removeVia(k: number, idx: number, net: number): void { this.viaCentre[k].remove(idx, net); if (this.viaCentre[k].cnt[idx] === 0) this.viaRad[k][idx] = 0; }

  /** Foreign occupancy a via of `net` spanning routing layers k0..k1 at (i,j) would collide with: other nets'
   *  wire centre-lines within r1, and other nets' vias whose copper comes closer than `r2own` (own radius plus
   *  via-via clearance) plus *their* radius — so the test gives the same answer from either via's side. */
  viaConflicts(i: number, j: number, r1: number, r2own: number, net: number, k0: number, k1: number, stopAtFirst: boolean): number {
    let other = 0; for (let k = k0; k <= k1; k++) other = Math.max(other, this.maxViaR[k]);
    const r2 = r2own + other;
    const rc = Math.ceil(Math.max(r1, r2) / this.pitch);
    let n = 0;
    for (let dj = -rc; dj <= rc; dj++) for (let di = -rc; di <= rc; di++) {
      const dd = Math.hypot(di, dj) * this.pitch;
      if (dd > r1 && dd > r2) continue;
      const ii = i + di, jj = j + dj;
      if (!this.inside(ii, jj)) continue;
      const idx = this.idx(ii, jj);
      if (dd <= r2) for (let k = k0; k <= k1; k++) {
        if (this.viaCentre[k].foreign(idx, net) && dd <= r2own + this.viaRad[k][idx]) { n++; break; }
        // same net: a via either stacks exactly on another (dd = 0) or keeps its pad off the other's pad
        if (dd > 0 && this.viaCentre[k].has(idx, net) && dd < r2own - this.viaClr + this.viaRad[k][idx]) { n++; break; }
      }
      if (dd <= r1) for (let k = k0; k <= k1; k++) if (this.centre[k].foreign(idx, net)) { n++; break; }
      if (n && stopAtFirst) return n;
    }
    return n;
  }

  /** True if a wire centre-line of `net` may not be at (k, idx) without conflict. */
  wireConflict(k: number, idx: number, net: number): boolean {
    return this.mark[k].foreign(idx, net) || this.viaMark[k].foreign(idx, net);
  }

  /** Cells whose centre lies inside any of the given items on layer k (pad cells). */
  cellsInside(items: Item[], k: number): number[] {
    const out: number[] = [];
    const probe = { type: 'circle' as const, c: { x: 0, y: 0 }, r: 0 };
    for (const it of items) {
      const i0 = Math.max(0, Math.floor((it.bbox.minX - this.ox) / this.pitch));
      const i1 = Math.min(this.nx - 1, Math.ceil((it.bbox.maxX - this.ox) / this.pitch));
      const j0 = Math.max(0, Math.floor((it.bbox.minY - this.oy) / this.pitch));
      const j1 = Math.min(this.ny - 1, Math.ceil((it.bbox.maxY - this.oy) / this.pitch));
      for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
        probe.c.x = this.cellX(i); probe.c.y = this.cellY(j);
        if (geomDistance(probe, it.geom) <= 0) out.push(this.node(k, i, j));
      }
    }
    return out;
  }

  nodeToPt(node: number): Pt {
    const idx = node % this.size;
    return { x: this.cellX(idx % this.nx), y: this.cellY(Math.floor(idx / this.nx)) };
  }
}
