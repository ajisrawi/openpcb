/**
 * A* maze search over the routing lattice (x, y, layer).
 *
 * Costs are in lattice-pitch units. Conflicts with other nets' routed copper
 * are *allowed* at a pass-dependent penalty (adaptive routing); fixed copper,
 * keepouts and the board edge are hard walls (except for the routing net's own
 * pads, which are free to enter).
 *
 * Layer changes use via types: from layer k the search may jump to any layer k'
 * that some via type spans (through, blind or buried); the smallest covering
 * type is used, with its own radius, fixed-obstacle map and occupancy on the
 * layers it passes.
 *
 * The heuristic is the octile distance to the bounding box of the target
 * cells; a search window (bounding box of sources and targets plus a margin)
 * bounds the explored area, and the caller retries without it on failure.
 */
import { Lattice } from './lattice.js';

export interface SearchCosts {
  step: number;        // orthogonal move
  diagonal: number;    // diagonal move
  wrongWay: number;    // multiplier for moving against a layer's preferred direction
  via: number;         // layer change
  bend: number;        // direction change
  conflict: number;    // entering a cell occupied by another net's wire/via
  hardConflict: boolean; // when true conflicts are forbidden instead of penalised
}

export interface SearchRequest {
  net: number;
  sources: number[];            // node ids
  targets: number[];            // node ids (ignored when targetPredicate is given)
  targetPredicate?: (node: number) => boolean;
  need: number;                 // required effective distance from fixed foreign copper for wires
  needR?: Float64Array;         // per constraint region (index from regionOf; 0 = outside every region): need there
  regionOf?: Uint8Array;        // per lattice cell: constraint region index
  viaNeed: Float64Array;        // per via type: same for vias
  viaR1: Float64Array;          // per via type: via centre vs foreign wire centre-lines
  viaR2: Float64Array;          // per via type: via centre vs foreign via centres
  viaAllowed?: Uint8Array;      // per via type (net's use_via); undefined = all
  maxVias?: number;             // via budget for this search (net max_total_vias minus vias already used)
  lane?: Uint8Array;            // per node: 1 = in the coupling lane next to the pair partner (cheaper to follow)
  corridor?: { mask: Uint8Array; tile: number; gx: number; penalty: number };   // global-route corridor (tiles)
  laneFactor?: number;          // step-cost multiplier inside the lane (default 0.35)
  maxLength?: number;           // optional cap on path cost (fanout)
  allowDiagonal: boolean;
  layerAllowed?: Uint8Array;    // per routing layer
  costs: SearchCosts;
  maxExpansions: number;
  window?: { i0: number; j0: number; i1: number; j1: number };
  heuristicWeight?: number;     // >1 = weighted A* (faster, paths up to that factor longer)
}

export interface SearchResult {
  path: number[];
  cost: number;
  conflicts: number;
  expansions: number;
}

class Heap {
  keys: number[] = []; vals: number[] = [];
  get size(): number { return this.keys.length; }
  push(k: number, v: number): void {
    const ks = this.keys, vs = this.vals; ks.push(k); vs.push(v);
    let i = ks.length - 1;
    while (i > 0) { const p = (i - 1) >> 1; if (ks[p] <= ks[i]) break; const tk = ks[p]; ks[p] = ks[i]; ks[i] = tk; const tv = vs[p]; vs[p] = vs[i]; vs[i] = tv; i = p; }
  }
  pop(): number {
    const ks = this.keys, vs = this.vals; const top = vs[0];
    const lk = ks.pop()!, lv = vs.pop()!;
    if (ks.length) {
      ks[0] = lk; vs[0] = lv; let i = 0;
      for (;;) {
        const l = 2 * i + 1, r = l + 1; let m = i;
        if (l < ks.length && ks[l] < ks[m]) m = l;
        if (r < ks.length && ks[r] < ks[m]) m = r;
        if (m === i) break;
        const tk = ks[m]; ks[m] = ks[i]; ks[i] = tk; const tv = vs[m]; vs[m] = vs[i]; vs[i] = tv; i = m;
      }
    }
    return top;
  }
}

const DX = [1, -1, 0, 0, 1, 1, -1, -1];
const DY = [0, 0, 1, -1, 1, -1, 1, -1];

export class Searcher {
  private g: Float32Array;
  private parent: Int32Array;
  private gen: Uint32Array;
  private closed: Uint8Array;
  private isTarget: Uint8Array;
  private curGen = 0;
  private dirH: Int8Array;
  private lastVia: Int32Array;   // per node: cell of the most recent via on the best path to it (-1 none)
  private lastViaR: Float32Array;
  private viaCnt: Uint16Array;   // per node: vias on the best path to it

  constructor(readonly lat: Lattice) {
    const n = lat.size * lat.nl;
    this.g = new Float32Array(n); this.parent = new Int32Array(n); this.gen = new Uint32Array(n); this.closed = new Uint8Array(n);
    this.lastVia = new Int32Array(n); this.lastViaR = new Float32Array(n); this.viaCnt = new Uint16Array(n);
    this.isTarget = new Uint8Array(n);
    this.dirH = new Int8Array(lat.nl);
    lat.layers.forEach((l, k) => {
      const dir = lat.board.design.structure.layers[l].direction;
      this.dirH[k] = dir === 'horizontal' ? 1 : dir === 'vertical' ? -1 : 0;
    });
  }

  search(req: SearchRequest): SearchResult | null {
    const lat = this.lat;
    const { nx, ny, size, nl } = lat;
    const c = req.costs;
    this.curGen++;
    if (this.curGen === 0xffffffff) { this.gen.fill(0); this.curGen = 1; }
    const gen = this.curGen;
    const heap = new Heap();
    const usePred = !!req.targetPredicate;
    let tI0 = Infinity, tJ0 = Infinity, tI1 = -Infinity, tJ1 = -Infinity;
    if (!usePred) {
      for (const t of req.targets) {
        this.isTarget[t] = 1;
        const idx = t % size; const i = idx % nx, j = Math.floor(idx / nx);
        if (i < tI0) tI0 = i; if (i > tI1) tI1 = i; if (j < tJ0) tJ0 = j; if (j > tJ1) tJ1 = j;
      }
    }
    const diagExtra = c.diagonal - c.step;
    const hw = req.heuristicWeight ?? 1;
    const h = (i: number, j: number): number => {
      if (usePred || tI0 === Infinity) return 0;
      const dx = i < tI0 ? tI0 - i : i > tI1 ? i - tI1 : 0;
      const dy = j < tJ0 ? tJ0 - j : j > tJ1 ? j - tJ1 : 0;
      return hw * (req.allowDiagonal ? Math.max(dx, dy) * c.step + Math.min(dx, dy) * diagExtra : (dx + dy) * c.step);
    };
    const win = req.window;
    const wi0 = win ? win.i0 : 0, wj0 = win ? win.j0 : 0, wi1 = win ? win.i1 : nx - 1, wj1 = win ? win.j1 : ny - 1;
    const sourceSet = new Set(req.sources);
    for (const s of req.sources) {
      this.gen[s] = gen; this.g[s] = 0; this.parent[s] = -1; this.closed[s] = 0; this.lastVia[s] = -1; this.viaCnt[s] = 0;
      const idx = s % size; heap.push(h(idx % nx, Math.floor(idx / nx)), s);
    }
    let expansions = 0;
    let found = -1;
    const wrongWayOf = (k: number, d: number): number => {
      const dh = this.dirH[k];
      if (dh === 0) return 1;
      if (d >= 4) return (1 + c.wrongWay) / 2;
      return (dh === 1) === (d < 2) ? 1 : c.wrongWay;
    };
    const dirOf = (from: number, to: number): number => {
      const fi = from % size, ti = to % size;
      if (fi === ti) return 8;
      const di = (ti % nx) - (fi % nx), dj = Math.floor(ti / nx) - Math.floor(fi / nx);
      for (let d = 0; d < 8; d++) if (DX[d] === di && DY[d] === dj) return d;
      return 9;
    };
    const types = lat.viaTypes, typeFor = lat.typeFor;

    while (heap.size) {
      const cur = heap.pop();
      if (this.closed[cur] && this.gen[cur] === gen) continue;
      this.closed[cur] = 1;
      expansions++;
      if (expansions > req.maxExpansions) break;
      const k = Math.floor(cur / size), idx = cur % size, i = idx % nx, j = Math.floor(idx / nx);
      const gcur = this.g[cur];
      if (usePred ? (req.targetPredicate!(cur) && !sourceSet.has(cur)) : this.isTarget[cur]) { found = cur; break; }
      if (req.maxLength !== undefined && gcur > req.maxLength) continue;
      const prevDir = this.parent[cur] >= 0 ? dirOf(this.parent[cur], cur) : -1;

      const nMoves = req.allowDiagonal ? 8 : 4;
      for (let d = 0; d < nMoves; d++) {
        const ni = i + DX[d], nj = j + DY[d];
        if (ni < wi0 || nj < wj0 || ni > wi1 || nj > wj1) continue;
        const nidx = nj * nx + ni;
        const nn = k * size + nidx;
        if (this.gen[nn] === gen && this.closed[nn]) continue;
        const needAt = (cell: number) => (req.needR ? req.needR[req.regionOf![cell]] : req.need);
        if (lat.foreignDist(k, nidx, req.net) < needAt(nidx)) continue;
        let step = (d < 4 ? c.step : c.diagonal) * wrongWayOf(k, d);
        if (req.lane && req.lane[nn]) step *= req.laneFactor ?? 0.35;
        if (req.corridor && !req.corridor.mask[Math.floor(nj / req.corridor.tile) * req.corridor.gx + Math.floor(ni / req.corridor.tile)]) step *= req.corridor.penalty;
        let conflict = lat.wireConflict(k, nidx, req.net) ? 1 : 0;
        if (d >= 4) {
          const a = nj * nx + i, b = j * nx + ni;
          if (lat.foreignDist(k, a, req.net) < needAt(a) || lat.foreignDist(k, b, req.net) < needAt(b)) continue;
          if (lat.wireConflict(k, a, req.net) || lat.wireConflict(k, b, req.net)) conflict++;
        }
        if (conflict) { if (c.hardConflict) continue; step += conflict * c.conflict; }
        if (prevDir >= 0 && prevDir !== d && prevDir !== 8) step += c.bend;
        const ng = gcur + step;
        if (this.gen[nn] !== gen || ng < this.g[nn]) {
          this.gen[nn] = gen; this.g[nn] = ng; this.parent[nn] = cur; this.closed[nn] = 0;
          this.lastVia[nn] = this.lastVia[cur]; this.lastViaR[nn] = this.lastViaR[cur]; this.viaCnt[nn] = this.viaCnt[cur];
          heap.push(ng + h(ni, nj), nn);
        }
      }
      if (nl > 1) {
        for (let nk = 0; nk < nl; nk++) {
          if (nk === k) continue;
          const t = typeFor[k * nl + nk];
          if (t < 0) continue;
          if (req.viaAllowed && !req.viaAllowed[t]) continue;
          if (req.layerAllowed && !req.layerAllowed[nk]) continue;
          const nn = nk * size + idx;
          if (this.gen[nn] === gen && this.closed[nn]) continue;
          if (!lat.viaFixedOk(idx, req.net, req.viaNeed[t], t)) continue;
          const vt = types[t];
          if (req.maxVias !== undefined && this.viaCnt[cur] >= req.maxVias) continue;
          // own previous via: stack on it exactly, or keep the pads apart (no staggered vias closer than their pads)
          const lv = this.lastVia[cur];
          if (lv >= 0 && lv !== idx && Math.hypot((lv % nx) - i, Math.floor(lv / nx) - j) * lat.pitch < vt.r + this.lastViaR[cur]) continue;
          const conflict = lat.viaConflicts(i, j, req.viaR1[t], req.viaR2[t], req.net, vt.k0, vt.k1, c.hardConflict);
          if (conflict && c.hardConflict) continue;
          // a longer span costs a little more, so a blind via wins over a through via where both fit
          const ng = gcur + c.via * (1 + 0.1 * (vt.k1 - vt.k0)) + conflict * c.conflict;
          if (this.gen[nn] !== gen || ng < this.g[nn]) {
            this.gen[nn] = gen; this.g[nn] = ng; this.parent[nn] = cur; this.closed[nn] = 0;
            this.lastVia[nn] = idx; this.lastViaR[nn] = vt.r; this.viaCnt[nn] = this.viaCnt[cur] + 1;
            heap.push(ng + h(i, j), nn);
          }
        }
      }
    }
    if (!usePred) for (const t of req.targets) this.isTarget[t] = 0;
    if (found < 0) return null;
    const path: number[] = [];
    for (let n = found; n >= 0; n = this.parent[n]) path.push(n);
    path.reverse();
    let conflicts = 0;
    for (const n of path) if (lat.wireConflict(Math.floor(n / size), n % size, req.net)) conflicts++;
    return { path, cost: this.g[found], conflicts, expansions };
  }
}
