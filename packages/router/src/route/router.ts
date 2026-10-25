/**
 * Adaptive multi-pass autorouter.
 *
 *   pass 1..N : route every unrouted connection; conflicts with other nets are
 *               allowed at a cost that grows with the pass number (cost table);
 *               connections involved in conflicts are ripped up one at a time
 *               and rerouted against the *current* state of the board.
 *   clean     : rip up and reroute each connection with vias and bends made
 *               expensive and conflicts forbidden; keep only improvements.
 *   fanout    : connect plane-net SMD pins to the plane with a short escape via; optionally (signal fanout)
 *               escape the inner pins of BGAs / fine-pitch parts to an inner layer with a short dog-bone + via,
 *               before the main passes, like SPECCTRA's `fanout` on SMD pins.
 *
 * Pre-routed fixed/protected wiring in the design counts as connectivity:
 * terminals already joined by fixed copper form one cluster and are not
 * re-routed.
 */
import type { Board, PinTerminal, Item } from '../board.js';
import type { SessionRoutes, Wire, Via } from '../model.js';
import { Lattice, type ViaType } from './lattice.js';
import { Searcher, type SearchCosts, type SearchResult, type SearchRequest } from './astar.js';

/** Vias of a routed connection: centre cell index and via type index, parallel arrays. */
export interface ViaList { idx: number[]; type: number[] }
type RouteResult = SearchResult & { vias?: ViaList };
interface Geo { need: number; markR: number; viaNeed: Float64Array; viaR1: Float64Array; viaR2: Float64Array; viaMarkR: Float64Array; viaAllowed?: Uint8Array; needR?: Float64Array; markRR?: Float64Array }
import { simplifyPolyline, pointInPolygon, type Pt } from '../geom.js';
import { unitInMm as unitMm } from '../model.js';
import { geomDistance } from '../drc.js';

export interface RouterOptions {
  pitch?: number;
  maxCells?: number;
  heuristicWeight?: number;   // weighted A*: 1 = optimal, 1.5 = fast
  edgeClearance?: number;     // copper to board outline, resolution units
  allowDiagonal?: boolean;
  maxExpansions?: number;
  log?: (line: string) => void;
  onPass?: (rec: PassRecord) => void;
  /** Only route these nets (empty/undefined = all). */
  selectedNets?: Set<string>;
}

export interface Connection {
  id: number;
  net: string;
  netId: number;
  a: PinTerminal;
  b: PinTerminal | null;      // null = plane (fanout) target
  priority: number;
  manhattan: number;
  path?: number[];
  wireCells?: number[];       // node ids
  viaIdx?: number[];          // via centre cell indices
  viaType?: number[];         // via type index per via (lattice.viaTypes)
  viaMarks?: number[];        // via mark node ids (for removal)
  imported?: { wires: Wire[]; vias: Via[] };   // copper loaded from a session (emitted verbatim until rerouted)
  escape?: boolean;           // signal fanout piece: pad -> via to another layer (a === b)
  corridor?: number[];        // global route: coarse tiles (dilated) the detail search prefers
  conflicts: number;
  fails: number;
  rippedPasses: number;
}

export interface PassRecord {
  pass: number;
  kind: 'route' | 'clean' | 'fanout';
  routed: number;
  total: number;
  unrouted: number;
  conflicts: number;
  vias: number;
  length: number;           // resolution units
  seconds: number;
  completion: number;       // percent
}

export class Router {
  readonly lat: Lattice;
  readonly searcher: Searcher;
  readonly connections: Connection[] = [];
  readonly history: PassRecord[] = [];
  readonly log: (s: string) => void;
  private termCells = new Map<string, number[]>();   // ref -> node ids
  private clusterOf = new Map<string, string>();     // terminal ref -> cluster root (fixed copper connectivity)
  private clusterCells = new Map<string, number[]>(); // cluster root -> node ids of fixed wires/vias
  private planeClusters = new Set<string>();          // cluster roots that contain a fixed via reaching the net's plane
  private planeNets = new Set<string>();
  private partner = new Map<string, { net: string; gap: number }>();   // differential pairs
  private laneMask: Uint8Array | null = null;
  // global routing
  private gTile = 16; private gx = 0; private gy = 0;
  private gCap: Float32Array | null = null; private gUse: Float32Array | null = null;
  private corridorMask: Uint8Array | null = null;
  corridorsOn = false;
  private laneSet: number[] = [];
  private passCounter = 0;
  private viaR: number;
  private best: { score: number; paths: Map<number, { path: number[]; vias: ViaList }> } | null = null;
  private rng = 12345;
  readonly startTime = Date.now();

  constructor(readonly board: Board, readonly opts: RouterOptions = {}) {
    this.log = opts.log ?? (() => {});
    this.lat = new Lattice(board, { pitch: opts.pitch, maxCells: opts.maxCells, edgeClearance: opts.edgeClearance });
    this.searcher = new Searcher(this.lat);
    this.viaR = this.lat.viaRadius();
    for (const p of this.realPlanes()) this.planeNets.add(p.net);
    for (const pr of board.design.network.pairs ?? []) {
      const gap = pr.gap ?? board.rules.clearance(pr.p, pr.n);
      this.partner.set(pr.p, { net: pr.n, gap }); this.partner.set(pr.n, { net: pr.p, gap });
    }
    // buses: each net of a (bus on) class follows the previous one at minimum spacing
    for (const cls of board.design.network.classes.values()) {
      if (!cls.circuit?.bus) continue;
      for (let i = 1; i < cls.nets.length; i++) if (!this.partner.has(cls.nets[i])) this.partner.set(cls.nets[i], { net: cls.nets[i - 1], gap: board.rules.clearance(cls.nets[i], cls.nets[i - 1]) });
    }
    this.buildRegions();
    this.buildClusters();
    this.buildConnections();
    this.log(`lattice ${this.lat.nx}x${this.lat.ny}x${this.lat.nl} pitch=${this.lat.pitch} connections=${this.connections.length}`);
  }

  /* ---------- setup ---------- */

  /** Constraint regions: each lattice cell gets the index of the region it lies in (last region wins, as in the
   *  rule lookup); a representative point per region evaluates its rules. */
  regionOf?: Uint8Array;
  private regionPt: Pt[] = [];
  private buildRegions(): void {
    const regions = (this.board.design.structure.regions ?? []).slice(0, 255);
    if (!regions.length) return;
    const lat = this.lat;
    const ro = new Uint8Array(lat.size);
    regions.forEach((rg, ri) => {
      const s = rg.shape; let x0: number, y0: number, x1: number, y1: number;
      let inside: (q: Pt) => boolean;
      if (s.kind === 'rect' && s.rect) { x0 = Math.min(s.rect.x1, s.rect.x2); x1 = Math.max(s.rect.x1, s.rect.x2); y0 = Math.min(s.rect.y1, s.rect.y2); y1 = Math.max(s.rect.y1, s.rect.y2); inside = (q) => q.x >= x0 && q.x <= x1 && q.y >= y0 && q.y <= y1; }
      else if (s.kind === 'circle' && s.diameter) { const c = s.center ?? { x: 0, y: 0 }, r = s.diameter / 2; x0 = c.x - r; x1 = c.x + r; y0 = c.y - r; y1 = c.y + r; inside = (q) => Math.hypot(q.x - c.x, q.y - c.y) <= r; }
      else if (s.points && s.points.length >= 3) { const pts = s.points; x0 = Math.min(...pts.map((q) => q.x)); x1 = Math.max(...pts.map((q) => q.x)); y0 = Math.min(...pts.map((q) => q.y)); y1 = Math.max(...pts.map((q) => q.y)); inside = (q) => pointInPolygon(q, pts); }
      else return;
      const i0 = Math.max(0, lat.toI(x0)), i1 = Math.min(lat.nx - 1, lat.toI(x1)), j0 = Math.max(0, Math.min(lat.toJ(y0), lat.toJ(y1))), j1 = Math.min(lat.ny - 1, Math.max(lat.toJ(y0), lat.toJ(y1)));
      for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) { const idx = lat.idx(i, j); const q = lat.nodeToPt(idx); if (inside(q)) { ro[idx] = ri + 1; this.regionPt[ri + 1] ??= q; } }
    });
    this.regionOf = ro;
    this.log(`constraint regions: ${regions.length}`);
  }

  private rand(): number { this.rng = (this.rng * 1103515245 + 12345) & 0x7fffffff; return this.rng / 0x7fffffff; }

  private cellsOf(t: PinTerminal): number[] {
    let c = this.termCells.get(t.ref);
    if (c) return c;
    c = [];
    for (const layer of t.layers) {
      const k = this.lat.kOf.get(layer);
      if (k === undefined) continue;
      const items = t.items.filter((it) => it.layer === layer);
      const inside = this.lat.cellsInside(items, k);
      if (inside.length) c.push(...inside);
      else {
        const i = Math.min(this.lat.nx - 1, Math.max(0, this.lat.toI(t.center.x)));
        const j = Math.min(this.lat.ny - 1, Math.max(0, this.lat.toJ(t.center.y)));
        c.push(this.lat.node(k, i, j));
      }
    }
    this.termCells.set(t.ref, c);
    return c;
  }

  /** Group terminals that are already connected by fixed wiring (pre-routes). */
  private buildClusters(): void {
    const b = this.board;
    const fixedByNet = new Map<string, Item[]>();
    for (const it of b.items) if ((it.kind === 'wire' || it.kind === 'via') && it.fixed && it.net) { const a = fixedByNet.get(it.net) ?? []; a.push(it); fixedByNet.set(it.net, a); }
    const parent = new Map<string, string>();
    const find = (x: string): string => { let r = x; while (parent.has(r) && parent.get(r) !== r) r = parent.get(r)!; parent.set(x, r); return r; };
    const union = (x: string, y: string) => { const rx = find(x), ry = find(y); if (rx !== ry) parent.set(rx, ry); };
    for (const t of b.terminals) parent.set(t.ref, t.ref);
    const cellsByRoot = new Map<string, number[]>();
    for (const [net, items] of fixedByNet) {
      const terms = b.terminals.filter((t) => t.net === net);
      const keyOf = (it: Item) => `#${it.id}`;
      for (const it of items) parent.set(keyOf(it), keyOf(it));
      // a via is one item per layer it spans: join those copies, so copper on different layers connects through it
      const viaAt = new Map<string, Item>();
      for (const it of items) if (it.kind === 'via') { const key = `${it.bbox.minX},${it.bbox.minY},${it.bbox.maxX},${it.bbox.maxY}`; const first = viaAt.get(key); if (first) union(keyOf(first), keyOf(it)); else viaAt.set(key, it); }
      const touches = (x: Item, y: Item) => (x.layer === -1 || y.layer === -1 || x.layer === y.layer) && geomDistance(x.geom, y.geom) <= 0;
      for (let i = 0; i < items.length; i++) for (let j = i + 1; j < items.length; j++) if (touches(items[i], items[j])) union(keyOf(items[i]), keyOf(items[j]));
      for (const t of terms) for (const it of items) if (t.items.some((p) => touches(p, it))) union(t.ref, keyOf(it));
      // cells of fixed items by root
      for (const it of items) {
        const root = find(keyOf(it));
        const ks = it.layer === -1 ? [...this.lat.kOf.values()] : (this.lat.kOf.has(it.layer) ? [this.lat.kOf.get(it.layer)!] : []);
        const arr = cellsByRoot.get(root) ?? [];
        for (const k of ks) arr.push(...this.lat.cellsInside([it], k));
        cellsByRoot.set(root, arr);
      }
    }
    for (const t of b.terminals) { const r = find(t.ref); this.clusterOf.set(t.ref, r); const cells = cellsByRoot.get(r); if (cells) this.clusterCells.set(r, cells); }
    // a fixed via of a plane net whose copper lies on one of that net's plane layers connects its cluster to the plane
    const planeLayersOf = new Map<string, Set<number>>();
    for (const pl of this.realPlanes()) { const s = planeLayersOf.get(pl.net) ?? new Set<number>(); s.add(b.layerIndex(pl.shape.layer)); planeLayersOf.set(pl.net, s); }
    for (const [net, items] of fixedByNet) {
      const pls = planeLayersOf.get(net); if (!pls) continue;
      for (const it of items) if (it.kind === 'via' && (it.layer === -1 || pls.has(it.layer)) && this.planesOf(net).some((pl) => (it.layer === -1 || pl.li === it.layer) && pl.inside({ x: (it.bbox.minX + it.bbox.maxX) / 2, y: (it.bbox.minY + it.bbox.maxY) / 2 }))) this.planeClusters.add(find(`#${it.id}`));
    }
  }

  private buildConnections(): void {
    const d = this.board.design;
    let id = 0;
    for (const net of d.network.nets.values()) {
      if (this.opts.selectedNets && this.opts.selectedNets.size && !this.opts.selectedNets.has(net.name)) continue;
      const terms = net.pins.map((p) => this.board.terminalByRef.get(p)).filter((t): t is PinTerminal => !!t && t.layers.some((l) => this.lat.kOf.has(l)));
      const netId = this.lat.netId(net.name);
      const prio = this.board.rules.priority(net);
      if (this.planeNets.has(net.name)) {
        const planeLayers = new Set(this.realPlanes().filter((p) => p.net === net.name).map((p) => this.board.layerIndex(p.shape.layer)));
        for (const t of terms) {
          if (!t.isSmd && this.planesOf(net.name).some((pl) => pl.inside(t.center))) continue;   // through-hole pin inside its plane
          if (t.layers.some((l) => planeLayers.has(l))) continue;   // pad sits on its own net's pour
          this.connections.push({ id: id++, net: net.name, netId, a: t, b: null, priority: prio, manhattan: 0, conflicts: 0, fails: 0, rippedPasses: 0 });
        }
        continue;
      }
      if (terms.length < 2) continue;
      // clusters (pre-connected groups) -> MST between clusters using closest terminal pairs
      const groups = new Map<string, PinTerminal[]>();
      for (const t of terms) { const r = this.clusterOf.get(t.ref) ?? t.ref; const g = groups.get(r) ?? []; g.push(t); groups.set(r, g); }
      const gl = [...groups.values()];
      if (gl.length < 2) continue;
      const inTree = new Set<number>([0]);
      while (inTree.size < gl.length) {
        let best = Infinity, bi = -1, bj = -1, ba: PinTerminal | null = null, bb: PinTerminal | null = null;
        for (const i of inTree) for (let j = 0; j < gl.length; j++) {
          if (inTree.has(j)) continue;
          for (const ta of gl[i]) for (const tb of gl[j]) {
            const dd = Math.abs(ta.center.x - tb.center.x) + Math.abs(ta.center.y - tb.center.y);
            if (dd < best) { best = dd; bi = i; bj = j; ba = ta; bb = tb; }
          }
        }
        inTree.add(bj);
        this.connections.push({ id: id++, net: net.name, netId, a: ba!, b: bb!, priority: prio, manhattan: best, conflicts: 0, fails: 0, rippedPasses: 0 });
      }
    }
  }

  /* ---------- occupancy ---------- */

  private geoCache = new Map<string, Geo>();
  /** Geometry parameters of a net for the lattice: wire mark radius, fixed-copper need, and per via type
   *  the via's own need, conflict radii and mark radius; plus the net's allowed via types (use_via). */
  private geo(net: string): Geo {
    const cached = this.geoCache.get(net);
    if (cached) return cached;
    const lat = this.lat;
    const r = this.board.rules;
    const ex = r.extremes();
    const hw = r.maxWidth(net) / 2;   // widest width the net may get (layer rules, from-tos): reserve for it
    const c0 = lat.c0;
    const cww = Math.max(c0, r.maxClearanceFor(net, 'wire', 'wire'));
    const cvw = Math.max(c0, r.maxClearanceFor(net, 'via', 'wire'));
    const cvv = Math.max(c0, r.maxClearanceFor(net, 'via', 'via'));
    const nt = lat.viaTypes.length;
    const viaNeed = new Float64Array(nt), viaR1 = new Float64Array(nt), viaR2 = new Float64Array(nt), viaMarkR = new Float64Array(nt);
    for (const vt of lat.viaTypes) {
      viaNeed[vt.index] = vt.r + cvv;                       // vs fixed copper on the spanned layers
      viaR1[vt.index] = vt.r + cvw + ex.maxWidth / 2;       // via centre vs foreign wire centre-lines
      viaR2[vt.index] = vt.r + cvv;                         // own radius + via-via clearance (the other via's radius is added per via)
      viaMarkR[vt.index] = vt.r + cvw + ex.maxWidth / 2;    // region a foreign wire centre-line may not enter
    }
    const names = r.vias(net);
    let viaAllowed: Uint8Array | undefined;
    if (names && names.length) { viaAllowed = new Uint8Array(nt); for (const n of names) { const vt = lat.viaTypeByName(n); if (vt) viaAllowed[vt.index] = 1; } if (!viaAllowed.some((x) => x)) viaAllowed = undefined; }
    lat.viaClr = Math.max(lat.viaClr, cvv);
    const g: Geo = { need: hw + cww, markR: 2 * hw + cww, viaNeed, viaR1, viaR2, viaMarkR, viaAllowed };
    // constraint regions: the width and clearance that apply inside each region
    if (this.regionOf) {
      const n = this.regionPt.length;
      g.needR = new Float64Array(Math.max(1, n)); g.markRR = new Float64Array(Math.max(1, n));
      g.needR[0] = g.need; g.markRR[0] = g.markR;
      for (let ri = 1; ri < n; ri++) {
        const at = this.regionPt[ri];
        if (!at) { g.needR[ri] = g.need; g.markRR[ri] = g.markR; continue; }
        let w = r.width(net, undefined, undefined, at);
        for (const l of this.board.design.structure.layers) w = Math.max(w, r.width(net, l.name, undefined, at));
        const c = Math.max(c0, r.clearance(net, undefined, 'wire', 'wire', undefined, at));
        g.needR[ri] = w / 2 + c; g.markRR[ri] = w + c;
      }
    }
    this.geoCache.set(net, g);
    return g;
  }

  /** Vias implied by a path: every layer change at one cell is a via of the type that spans it. */
  private viasOf(path: number[]): ViaList {
    const lat = this.lat; const out: ViaList = { idx: [], type: [] };
    for (let i = 1; i < path.length; i++) {
      if (path[i] % lat.size !== path[i - 1] % lat.size) continue;
      const k0 = Math.floor(path[i - 1] / lat.size), k1 = Math.floor(path[i] / lat.size);
      if (k0 === k1) continue;
      let t = lat.typeFor[k0 * lat.nl + k1];
      if (t < 0) t = lat.viaTypeCovering(Math.min(k0, k1), Math.max(k0, k1))?.index ?? 0;
      out.idx.push(path[i] % lat.size); out.type.push(t);
    }
    return out;
  }

  /** Register a routed path (and its vias) in the dynamic maps. */
  private occupy(c: Connection, path: number[], viasIn?: ViaList): void {
    const lat = this.lat;
    const g = this.geo(c.net);
    const vias = viasIn ?? this.viasOf(path);
    const disk: number[] = [];
    const marks: number[] = [];     // node ids of wire marks
    const vmarks: number[] = [];    // node ids of via marks
    for (const n of path) {
      const k = Math.floor(n / lat.size), idx = n % lat.size;
      lat.centre[k].add(idx, c.netId);
      disk.length = 0; lat.disk(idx % lat.nx, Math.floor(idx / lat.nx), g.markRR && this.regionOf ? g.markRR[this.regionOf[idx]] : g.markR, disk);
      for (const ci of disk) { lat.mark[k].add(ci, c.netId); marks.push(k * lat.size + ci); }
    }
    for (let v = 0; v < vias.idx.length; v++) {
      const idx = vias.idx[v]; const vt = lat.viaTypes[vias.type[v]];
      disk.length = 0; lat.disk(idx % lat.nx, Math.floor(idx / lat.nx), g.viaMarkR[vt.index], disk);
      for (let k = vt.k0; k <= vt.k1; k++) {
        lat.addVia(k, idx, c.netId, vt.r);
        for (const ci of disk) { lat.viaMark[k].add(ci, c.netId); vmarks.push(k * lat.size + ci); }
      }
    }
    c.path = path; c.wireCells = marks; c.viaIdx = vias.idx.slice(); c.viaType = vias.type.slice(); c.viaMarks = vmarks;
  }

  private viaListOf(c: Connection): ViaList { return { idx: c.viaIdx ?? [], type: c.viaType ?? [] }; }

  private netTermCells = new Map<string, Set<number>>();
  private terminalCellsOf(net: string): Set<number> {
    let s = this.netTermCells.get(net);
    if (s) return s;
    s = new Set<number>();
    for (const c of this.connections) if (c.net === net) { for (const t of [c.a, c.b]) if (t) for (const n of this.cellsOf(t)) s.add(n); const cl = this.clusterOf.get(c.a.ref); const fc = cl ? this.clusterCells.get(cl) : undefined; if (fc) for (const n of fc) s.add(n); }
    this.netTermCells.set(net, s);
    return s;
  }

  /** Nodes a routed connection owns (path nodes plus its vias on the layers they span). */
  private nodesOf(c: Connection): Set<number> {
    const s = new Set<number>(c.path ?? []);
    const vi = c.viaIdx ?? [], vty = c.viaType ?? [];
    for (let v = 0; v < vi.length; v++) { const vt = this.lat.viaTypes[vty[v]]; for (let k = vt.k0; k <= vt.k1; k++) s.add(k * this.lat.size + vi[v]); }
    return s;
  }

  /** Routed connections of the same net whose path starts or ends on `c`'s copper (not on a pad). */
  dependents(c: Connection): Connection[] {
    if (!c.path) return [];
    const own = this.nodesOf(c);
    const term = this.terminalCellsOf(c.net);
    const out: Connection[] = [];
    for (const o of this.connections) {
      if (o === c || o.net !== c.net || !o.path || o.path.length === 0) continue;
      const a = o.path[0], b = o.path[o.path.length - 1];
      if ((own.has(a) && !term.has(a)) || (own.has(b) && !term.has(b))) out.push(o);
    }
    return out;
  }

  /** Remove a connection's copper from the maps; connections attached to it are ripped up too (cascade). */
  private ripUp(c: Connection): void {
    if (!c.path) return;
    const deps = this.dependents(c);
    const lat = this.lat;
    for (const n of c.path) lat.centre[Math.floor(n / lat.size)].remove(n % lat.size, c.netId);
    for (const n of c.wireCells!) lat.mark[Math.floor(n / lat.size)].remove(n % lat.size, c.netId);
    const vi = c.viaIdx!, vty = c.viaType!;
    for (let v = 0; v < vi.length; v++) { const vt = lat.viaTypes[vty[v]]; for (let k = vt.k0; k <= vt.k1; k++) lat.removeVia(k, vi[v], c.netId); }
    for (const n of c.viaMarks!) lat.viaMark[Math.floor(n / lat.size)].remove(n % lat.size, c.netId);
    c.path = undefined; c.wireCells = undefined; c.viaIdx = undefined; c.viaType = undefined; c.viaMarks = undefined; c.imported = undefined; c.rippedPasses++;
    for (const o of deps) this.ripUp(o);
  }

  private rebuildOccupancy(): void {
    this.lat.clearDynamic();
    for (const c of this.connections) if (c.path) this.occupy(c, c.path, c.viaIdx ? this.viaListOf(c) : undefined);
  }

  /* ---------- resume from a session ---------- */

  /**
   * Load previously routed copper (a .ses/.rte written by this router or another SPECCTRA router) as
   * rip-up-able connections: wires are snapped to lattice nodes, connected pieces become one connection
   * each, and the original wires are emitted verbatim until the piece is rerouted.
   */
  importRoutes(routes: SessionRoutes): { pieces: number; skipped: number } {
    const lat = this.lat;
    const scale = (this.board.design.resolution.value / routes.resolution.value) * (unitMm(routes.resolution.unit) / unitMm(this.board.design.resolution.unit));
    let pieces = 0, skipped = 0;
    let id = this.connections.length ? Math.max(...this.connections.map((c) => c.id)) + 1 : 0;
    for (const [net, r] of routes.nets) {
      const netDef = this.board.design.network.nets.get(net);
      if (!netDef) { skipped++; continue; }
      const netId = lat.netId(net);
      const terms = netDef.pins.map((p) => this.board.terminalByRef.get(p)).filter((x): x is PinTerminal => !!x);
      // snap wires to node lists
      const items: { nodes: number[]; wire?: Wire; via?: Via; viaIdx?: number; viaType?: number }[] = [];
      for (const w of r.wires) {
        if (w.type === 'fix' || w.type === 'protect') continue;   // design wiring, already fixed on the board
        const li = this.board.layerIndex(w.layer); const k = lat.kOf.get(li);
        if (k === undefined) { skipped++; continue; }
        const nodes: number[] = [];
        const pts = w.points.map((q) => ({ x: q.x * scale, y: q.y * scale }));
        for (let i = 0; i < pts.length; i++) {
          const i0 = lat.toI(pts[i].x), j0 = lat.toJ(pts[i].y);
          if (i > 0) {
            const i1 = lat.toI(pts[i - 1].x), j1 = lat.toJ(pts[i - 1].y);
            const n = Math.max(Math.abs(i0 - i1), Math.abs(j0 - j1));
            for (let s = 1; s < n; s++) { const ii = Math.round(i1 + ((i0 - i1) * s) / n), jj = Math.round(j1 + ((j0 - j1) * s) / n); if (lat.inside(ii, jj)) nodes.push(lat.node(k, ii, jj)); }
          }
          if (lat.inside(i0, j0)) nodes.push(lat.node(k, i0, j0));
        }
        if (nodes.length) items.push({ nodes: [...new Set(nodes)], wire: { ...w, points: pts, net } });
      }
      for (const v of r.vias) {
        if (v.type === 'fix' || v.type === 'protect') continue;
        const i = lat.toI(v.at.x * scale), j = lat.toJ(v.at.y * scale);
        if (!lat.inside(i, j)) { skipped++; continue; }
        const idx = lat.idx(i, j); const nodes: number[] = [];
        // via type: by padstack name, else by the span of the session's padstack, else the first type
        let vt = lat.viaTypeByName(v.padstack);
        if (!vt) {
          const ps = routes.padstacks.find((x) => x.name === v.padstack);
          if (ps) { let b0 = Infinity, b1 = -Infinity; for (const s of ps.shapes) for (const li of this.board.layersFor(s.layer)) { b0 = Math.min(b0, li); b1 = Math.max(b1, li); } let k0 = Infinity, k1 = -Infinity; lat.layers.forEach((li, k) => { if (li >= b0 && li <= b1) { k0 = Math.min(k0, k); k1 = Math.max(k1, k); } }); if (Number.isFinite(k0)) vt = lat.viaTypeCovering(k0, k1); }
          vt ??= lat.viaTypes[0];
        }
        for (let k = vt.k0; k <= vt.k1; k++) nodes.push(k * lat.size + idx);
        items.push({ nodes, via: { ...v, at: { x: v.at.x * scale, y: v.at.y * scale }, net }, viaIdx: idx, viaType: vt.index });
      }
      // union pieces sharing nodes
      const parent = items.map((_, i) => i);
      const find = (x: number): number => (parent[x] === x ? x : (parent[x] = find(parent[x])));
      const owner = new Map<number, number>();
      items.forEach((it, i) => { for (const n of it.nodes) { const o = owner.get(n); if (o === undefined) owner.set(n, i); else { const a = find(o), b = find(i); if (a !== b) parent[a] = b; } } });
      const groups = new Map<number, number[]>();
      items.forEach((_, i) => { const r0 = find(i); const g = groups.get(r0) ?? []; g.push(i); groups.set(r0, g); });
      // copper that only overlaps a pad or another piece (a via set off a pad centre, a wire end inside a via's
      // ring) shares no lattice node with it: join those geometrically before dropping anything as dangling
      const shapes = (i: number): { li: number; g: Item['geom'] }[] => {
        const it = items[i];
        if (it.wire) { const li = this.board.layerIndex(it.wire.layer), hw = (it.wire.width * scale) / 2, p = it.wire.points; return p.length === 1 ? [{ li, g: { type: 'circle', c: p[0], r: hw } }] : p.slice(1).map((q, s) => ({ li, g: { type: 'seg' as const, a: p[s], b: q, hw } })); }
        const vt = lat.viaTypes[it.viaType ?? 0], out: { li: number; g: Item['geom'] }[] = [];
        for (let k = vt.k0; k <= vt.k1; k++) out.push({ li: lat.layers[k], g: { type: 'circle', c: it.via!.at, r: vt.r } });
        return out;
      };
      const touches = (a: { li: number; g: Item['geom'] }[], b: { li: number; g: Item['geom'] }[]) => a.some((x) => b.some((y) => x.li === y.li && geomDistance(x.g, y.g) <= 1e-9));
      const glist = [...groups.values()].map((members) => ({ members, touched: [] as PinTerminal[] }));
      for (const g of glist) { const ns = new Set(g.members.flatMap((i) => items[i].nodes)); g.touched = terms.filter((t) => this.cellsOf(t).some((n) => ns.has(n))); }
      for (let changed = true; changed; ) {
        changed = false;
        for (const g of glist) {
          if (g.touched.length || !g.members.length) continue;
          const sh = g.members.flatMap(shapes);
          const pads = terms.filter((t) => touches(sh, t.items.map((it) => ({ li: it.layer, g: it.geom }))));
          if (pads.length) { g.touched = pads; changed = true; continue; }
          const h = glist.find((o) => o !== g && o.members.length && touches(sh, o.members.flatMap(shapes)));
          if (h) { h.members.push(...g.members); g.members = []; changed = true; }
        }
      }
      for (const { members, touched } of glist) {
        if (!members.length) continue;
        const nodes = [...new Set(members.flatMap((i) => items[i].nodes))];
        if (!touched.length) { skipped++; continue; }
        const a = touched[0], b = touched[1] ?? touched[0];
        const c: Connection = { id: id++, net, netId, a, b, priority: this.board.rules.priority(netDef), manhattan: 0, conflicts: 0, fails: 0, rippedPasses: 0,
          imported: { wires: members.map((i) => items[i].wire).filter((w): w is Wire => !!w), vias: members.map((i) => items[i].via).filter((v): v is Via => !!v) } };
        this.connections.push(c);
        const vl: ViaList = { idx: [], type: [] };
        for (const i of members) if (items[i].viaIdx !== undefined) { vl.idx.push(items[i].viaIdx!); vl.type.push(items[i].viaType ?? 0); }
        this.occupy(c, nodes, vl);
        pieces++;
      }
    }
    this.netTermCells.clear();
    this.tallyConflicts();
    this.log(`read routes: ${pieces} pieces of copper loaded, ${skipped} skipped`);
    return { pieces, skipped };
  }

  /** Conflicts of one connection against the current maps: its centre-line cells inside foreign marks,
   *  its via centres inside foreign wire/via neighbourhoods. */
  private conflictsOf(c: Connection): number {
    if (!c.path) return 0;
    const lat = this.lat;
    const g = this.geo(c.net);
    let n = 0;
    for (const node of c.path) {
      const k = Math.floor(node / lat.size), idx = node % lat.size;
      if (lat.wireConflict(k, idx, c.netId)) n++;
      // imported copper may break the (possibly tightened) rules against fixed objects: count that too
      else if (c.imported && lat.foreignDist(k, idx, c.netId) < (g.needR && this.regionOf ? g.needR[this.regionOf[idx]] : g.need)) n++;
    }
    const vi = c.viaIdx!, vty = c.viaType!;
    for (let v = 0; v < vi.length; v++) {
      const idx = vi[v], t = vty[v], vt = lat.viaTypes[t];
      n += lat.viaConflicts(idx % lat.nx, Math.floor(idx / lat.nx), g.viaR1[t], g.viaR2[t], c.netId, vt.k0, vt.k1, false);
      if (c.imported && !lat.viaFixedOk(idx, c.netId, g.viaNeed[t], t)) n++;
    }
    return n;
  }

  /** Conflicts a connection's copper causes on *other* nets: their centre-lines inside its wire or via marks.
   *  (Its own conflictsOf sees the reverse direction; with different widths the two can differ.) */
  private inflictedBy(c: Connection): number {
    const lat = this.lat; let n = 0;
    for (const m of c.wireCells ?? []) if (lat.centre[Math.floor(m / lat.size)].foreign(m % lat.size, c.netId)) n++;
    for (const m of c.viaMarks ?? []) if (lat.centre[Math.floor(m / lat.size)].foreign(m % lat.size, c.netId)) n++;
    return n;
  }

  private tallyConflicts(): number {
    let total = 0;
    for (const c of this.connections) { c.conflicts = this.conflictsOf(c); total += c.conflicts; }
    return total;
  }

  /* ---------- components (multi-source / multi-target) ---------- */

  /**
   * Geometric connectivity of a net: terminals, fixed-copper clusters and routed connections are joined
   * when they share lattice nodes (a path ending on another path, a via on a wire, a wire inside a pad).
   * Returns the component root of every terminal ref and of every routed connection id.
   */
  private components(net: string, exclude: Connection): { term: Map<string, string>; conn: Map<number, string> } {
    const parent = new Map<string, string>();
    const find = (x: string): string => { let r = x; while (parent.has(r) && parent.get(r) !== r) r = parent.get(r)!; parent.set(x, r); return r; };
    const union = (a: string, b: string) => { const ra = find(a), rb = find(b); if (ra !== rb) parent.set(ra, rb); };
    const conns = this.connections.filter((c) => c.net === net && c !== exclude && c.path && c.path.length > 0);
    const terms = new Map<string, PinTerminal>();
    for (const c of this.connections) if (c.net === net) { terms.set(c.a.ref, c.a); if (c.b) terms.set(c.b.ref, c.b); }
    // node -> owners (connection key or cluster key)
    const owner = new Map<number, string[]>();
    const addOwner = (n: number, key: string) => { const a = owner.get(n); if (a) { if (!a.includes(key)) a.push(key); } else owner.set(n, [key]); };
    for (const c of conns) { const key = '#c' + c.id; for (const n of this.nodesOf(c)) addOwner(n, key); }
    for (const [root, cells] of this.clusterCells) { for (const n of cells) addOwner(n, '#k' + root); }
    // terminals join their cluster and whatever owns one of their pad cells
    for (const [ref, t] of terms) {
      const cl = this.clusterOf.get(ref);
      if (cl) union(ref, '#k' + cl);
      for (const n of this.cellsOf(t)) { const o = owner.get(n); if (o) for (const key of o) union(ref, key); }
    }
    // connections/clusters sharing a node are joined
    for (const o of owner.values()) for (let i = 1; i < o.length; i++) union(o[0], o[i]);
    // plane pseudo-terminal: every fanout connection (b === null) and every cluster with a plane via reaches the plane
    for (const c of conns) if (c.b === null) union('#c' + c.id, '#plane');
    // imported copper (a resumed session) reaches the plane when one of its vias spans a real plane layer of the net
    if (this.planeNets.has(net)) {
      for (const c of conns) if (c.imported && (c.viaType ?? []).some((ti, n) => this.planeReaches(net, this.lat.viaTypes[ti], this.lat.nodeToPt(c.viaIdx![n])))) union('#c' + c.id, '#plane');
    }
    for (const root of this.planeClusters) if (this.clusterCells.has(root)) union('#k' + root, '#plane');
    const term = new Map<string, string>();
    for (const ref of terms.keys()) term.set(ref, find(ref));
    term.set('#plane', find('#plane'));
    const conn = new Map<number, string>();
    for (const c of conns) conn.set(c.id, find('#c' + c.id));
    return { term, conn };
  }

  private groupCells(net: string, comp: { term: Map<string, string>; conn: Map<number, string> }, root: string, exclude: Connection): number[] {
    const cells: number[] = [];
    const seenTerm = new Set<string>();
    const seenCluster = new Set<string>();
    for (const c of this.connections) {
      if (c.net !== net) continue;
      for (const t of [c.a, c.b]) {
        if (!t || seenTerm.has(t.ref)) continue;
        if (comp.term.get(t.ref) === root) {
          seenTerm.add(t.ref); cells.push(...this.cellsOf(t));
          const cl = this.clusterOf.get(t.ref);
          if (cl && !seenCluster.has(cl)) { seenCluster.add(cl); const fc = this.clusterCells.get(cl); if (fc) cells.push(...fc); }
        }
      }
      if (c === exclude || !c.path || c.path.length === 0) continue;
      if (comp.conn.get(c.id) === root) {
        cells.push(...c.path);
        const vi = c.viaIdx ?? [], vty = c.viaType ?? [];
        for (let v = 0; v < vi.length; v++) { const vt = this.lat.viaTypes[vty[v]]; for (let k = vt.k0; k <= vt.k1; k++) cells.push(k * this.lat.size + vi[v]); }
      }
    }
    return cells;
  }

  /* ---------- cost table ---------- */

  costsFor(passIndex: number, mode: 'route' | 'clean' | 'fanout'): SearchCosts {
    if (mode === 'clean') return { step: 1, diagonal: Math.SQRT2, wrongWay: 1.15, via: 30, bend: 1.0, conflict: 1e9, hardConflict: true };
    if (mode === 'fanout') return { step: 1, diagonal: Math.SQRT2, wrongWay: 1.0, via: 2, bend: 0.2, conflict: 1e9, hardConflict: true };
    const p = Math.max(1, passIndex);
    const conflict = Math.min(1e6, 6 * Math.pow(1.6, p - 1));
    return {
      step: 1, diagonal: Math.SQRT2,
      wrongWay: Math.max(1.15, 2.0 - 0.1 * p),
      via: Math.min(14, 5 + 0.5 * p),
      bend: 0.3,
      conflict,
      hardConflict: conflict >= 1e5,
    };
  }

  /* ---------- routing one connection ---------- */

  private windowFor(sources: number[], targets: number[], margin: number): SearchRequest['window'] {
    const lat = this.lat;
    let i0 = Infinity, j0 = Infinity, i1 = -Infinity, j1 = -Infinity;
    for (const arr of [sources, targets]) for (const n of arr) { const idx = n % lat.size; const i = idx % lat.nx, j = Math.floor(idx / lat.nx); if (i < i0) i0 = i; if (i > i1) i1 = i; if (j < j0) j0 = j; if (j > j1) j1 = j; }
    const m = Math.max(8, Math.ceil(Math.max(i1 - i0, j1 - j0) * margin));
    return { i0: Math.max(0, i0 - m), j0: Math.max(0, j0 - m), i1: Math.min(lat.nx - 1, i1 + m), j1: Math.min(lat.ny - 1, j1 + m) };
  }

  /**
   * Planes that really connect: a plane polygon on a layer that is also routed (an outer-layer pour) is filled after
   * routing and gets cut back around every other net's pads, wires and vias, so it cannot be trusted to reach a pad
   * (a BGA ball deep in the array ends up on an island). Only planes on non-routing layers join pads and vias.
   */
  private realPlanes() {
    return this.board.design.structure.planes.filter((p) => { const li = this.board.layerIndex(p.shape.layer); return li >= 0 && !this.lat.kOf.has(li); });
  }

  /** For a plane net: per routing layer, the smallest via type that spans it and reaches one of the net's planes. */
  private fanoutTypes(net: string, allowed?: Uint8Array): ViaType[][] {
    const planeLayers = [...new Set(this.planesOf(net).map((p) => p.li))];
    const out: ViaType[][] = [];
    for (let k = 0; k < this.lat.nl; k++) {
      const cands: ViaType[] = [];
      for (const li of planeLayers) { const vt = this.lat.viaTypeCovering(k, k, li, allowed); if (vt && !cands.includes(vt)) cands.push(vt); }
      cands.sort((a, b) => (a.b1 - a.b0) - (b.b1 - b.b0));
      out.push(cands);
    }
    return out;
  }

  /** A net's real planes as (board layer, inside test): a split plane covers only part of its layer. */
  private planeCache = new Map<string, { li: number; inside: (q: Pt) => boolean }[]>();
  private planesOf(net: string): { li: number; inside: (q: Pt) => boolean }[] {
    let pl = this.planeCache.get(net);
    if (pl) return pl;
    pl = [];
    for (const p of this.realPlanes()) {
      if (p.net !== net) continue;
      const li = this.board.layerIndex(p.shape.layer); if (li < 0) continue;
      const s = p.shape;
      if (s.kind === 'rect' && s.rect) { const r = s.rect; pl.push({ li, inside: (q) => q.x >= Math.min(r.x1, r.x2) && q.x <= Math.max(r.x1, r.x2) && q.y >= Math.min(r.y1, r.y2) && q.y <= Math.max(r.y1, r.y2) }); }
      else if (s.kind === 'circle' && s.diameter) { const c = s.center ?? { x: 0, y: 0 }, rr = s.diameter / 2; pl.push({ li, inside: (q) => Math.hypot(q.x - c.x, q.y - c.y) <= rr }); }
      else if (s.points && s.points.length >= 3) { const pts = s.points; pl.push({ li, inside: (q) => pointInPolygon(q, pts) }); }
    }
    this.planeCache.set(net, pl);
    return pl;
  }
  /** True when a via of type vt at q lands inside one of the net's planes on a layer it spans. */
  private planeReaches(net: string, vt: { b0: number; b1: number }, q: Pt): boolean { return this.planesOf(net).some((pl) => pl.li >= vt.b0 && pl.li <= vt.b1 && pl.inside(q)); }

  /**
   * Differential pairs: the cells at exactly (width + gap) from the routed partner's centre-line, on the same layer,
   * form a lane whose steps are cheap, so the second net of a pair follows the first at the coupling distance.
   */
  private laneFor(c: Connection): Uint8Array | undefined {
    const pr = this.partner.get(c.net);
    if (this.laneMask) { for (const n of this.laneSet) this.laneMask[n] = 0; this.laneSet.length = 0; }
    if (!pr) return undefined;
    const ref = this.connections.filter((o) => o.net === pr.net && o.path && o.path.length > 1 && !o.imported);
    if (!ref.length) return undefined;
    const lat = this.lat;
    const R = this.board.rules.width(c.net) / 2 + this.board.rules.width(pr.net) / 2 + pr.gap;   // centre-to-centre
    const half = lat.pitch * 0.75;
    this.laneMask ??= new Uint8Array(lat.size * lat.nl);
    const best = new Map<number, number>();
    const rc = Math.ceil((R + half) / lat.pitch);
    for (const o of ref) for (const node of o.path!) {
      const k = Math.floor(node / lat.size), idx = node % lat.size, i = idx % lat.nx, j = Math.floor(idx / lat.nx);
      for (let dj = -rc; dj <= rc; dj++) for (let di = -rc; di <= rc; di++) {
        const ii = i + di, jj = j + dj; if (!lat.inside(ii, jj)) continue;
        const n = k * lat.size + lat.idx(ii, jj), d = Math.hypot(di, dj) * lat.pitch;
        const prev = best.get(n); if (prev === undefined || d < prev) best.set(n, d);
      }
    }
    for (const [n, d] of best) if (Math.abs(d - R) <= half) { this.laneMask[n] = 1; this.laneSet.push(n); }
    return this.laneSet.length ? this.laneMask : undefined;
  }

  /** Signal fanout: from the pad, the shortest clean way to a via onto any other routing layer. */
  private routeEscape(c: Connection, costs: SearchCosts): RouteResult | null {
    const lat = this.lat;
    const sources = this.cellsOf(c.a);
    if (!sources.length) return null;
    const padKs = new Set(sources.map((n) => Math.floor(n / lat.size)));
    const g = this.geo(c.net);
    const useLayers = this.board.rules.useLayers(c.net);
    let layerAllowed: Uint8Array | undefined;
    if (useLayers) { layerAllowed = new Uint8Array(lat.nl); for (const ln of useLayers) { const li = this.board.layerIndex(ln); const k = li >= 0 ? lat.kOf.get(li) : undefined; if (k !== undefined) layerAllowed[k] = 1; } }
    return this.searcher.search({ net: c.netId, sources, targets: [], targetPredicate: (node) => !padKs.has(Math.floor(node / lat.size)),
      need: g.need, needR: g.needR, regionOf: g.needR ? this.regionOf : undefined, viaNeed: g.viaNeed, viaR1: g.viaR1, viaR2: g.viaR2, viaAllowed: g.viaAllowed, allowDiagonal: this.opts.allowDiagonal ?? false, layerAllowed,
      costs, maxLength: 40 + costs.via * 2, maxExpansions: 400_000 });
  }

  private routeOne(c: Connection, costs: SearchCosts): RouteResult | null {
    if (c.escape) return this.routeEscape(c, costs);
    const lat = this.lat;
    const comp = this.components(c.net, c);
    const ra = comp.term.get(c.a.ref)!;
    const sources = this.groupCells(c.net, comp, ra, c);
    const g = this.geo(c.net);
    const { need } = g;
    const useLayers = this.board.rules.useLayers(c.net);
    let layerAllowed: Uint8Array | undefined;
    if (useLayers) { layerAllowed = new Uint8Array(lat.nl); for (const ln of useLayers) { const li = this.board.layerIndex(ln); const k = li >= 0 ? lat.kOf.get(li) : undefined; if (k !== undefined) layerAllowed[k] = 1; } }
    // max_total_vias: what is left of the net's via budget after its other routed connections
    const maxTotal = this.board.rules.maxTotalVias(c.net);
    let maxVias: number | undefined;
    if (maxTotal !== undefined) { let used = 0; for (const o of this.connections) if (o !== c && o.net === c.net && o.path) used += o.viaIdx?.length ?? 0; maxVias = Math.max(0, maxTotal - used); }
    const lane = this.laneFor(c);
    let corridor: SearchRequest['corridor'];
    if (this.corridorsOn && c.corridor && this.corridorMask) {
      this.corridorMask.fill(0); for (const t of c.corridor) this.corridorMask[t] = 1;
      corridor = { mask: this.corridorMask, tile: this.gTile, gx: this.gx, penalty: 1.3 };
    }
    const base = { net: c.netId, sources, need, needR: g.needR, regionOf: g.needR ? this.regionOf : undefined, viaNeed: g.viaNeed, viaR1: g.viaR1, viaR2: g.viaR2, viaAllowed: g.viaAllowed, maxVias, lane, corridor, allowDiagonal: this.opts.allowDiagonal ?? false, layerAllowed, costs, maxExpansions: this.opts.maxExpansions ?? 3_000_000, heuristicWeight: this.opts.heuristicWeight };
    if (c.b === null) {
      if (comp.term.get(c.a.ref) === comp.term.get('#plane')) return { path: [], cost: 0, conflicts: 0, expansions: 0 };
      const strict = costs.hardConflict;
      const fan = this.fanoutTypes(c.net, g.viaAllowed);
      if (!fan.some((x) => x.length)) return null;   // no via type reaches this net's plane
      // the plane via: the smallest type that spans a layer where the net's plane covers this spot (split planes)
      const chosen = new Map<number, ViaType>();
      const pred = (node: number): boolean => {
        const idx = node % lat.size, k = Math.floor(node / lat.size);
        const q = lat.nodeToPt(idx);
        for (const vt of fan[k]) {
          if (!this.planeReaches(c.net, vt, q)) continue;
          if (!lat.viaFixedOk(idx, c.netId, g.viaNeed[vt.index], vt.index)) continue;
          if (strict && lat.viaConflicts(idx % lat.nx, Math.floor(idx / lat.nx), g.viaR1[vt.index], g.viaR2[vt.index], c.netId, vt.k0, vt.k1, true) !== 0) continue;
          chosen.set(node, vt); return true;
        }
        return false;
      };
      // the plane via is chosen by the predicate, which cannot see the path's own vias: one that overlaps a via of
      // the path without stacking exactly on it (same-net pads must stack or keep clear) is banned and the search rerun
      const banned = new Set<number>();
      const predOk = (node: number) => !banned.has(node % lat.size) && pred(node);
      let res: RouteResult | null = null;
      for (let attempt = 0; attempt < 6; attempt++) {
        res = this.searcher.search({ ...base, targets: [], targetPredicate: predOk, maxLength: strict && costs.via <= 2 ? 40 : 160 });
        if (!res && !strict && c.fails % 3 === 2) res = this.searcher.search({ ...base, targets: [], targetPredicate: predOk, maxLength: 400, maxExpansions: base.maxExpansions * 3 });
        if (!res) break;
        const end = res.path[res.path.length - 1], at = end % lat.size, pvt = chosen.get(end)!;
        const along = res.vias ?? this.viasOf(res.path);
        const overlaps = along.idx.some((ai, n) => ai !== at && Math.hypot((ai % lat.nx) - (at % lat.nx), Math.floor(ai / lat.nx) - Math.floor(at / lat.nx)) * lat.pitch < lat.viaTypes[along.type[n]].r + pvt.r);
        if (!overlaps) break;
        banned.add(at); res = null;
      }
      if (!res) {
        // no room for a via of its own: join same-net copper that already reaches the plane (a neighbouring pad's
        // fanout), as a fanout sharing a via
        const planeRoot = comp.term.get('#plane');
        const shared = planeRoot !== undefined ? this.groupCells(c.net, comp, planeRoot, c) : [];
        if (shared.length) {
          const joined = this.searcher.search({ ...base, targets: shared, maxLength: 160 });
          if (joined) return joined;
        }
        return null;
      }
      const last = res.path[res.path.length - 1];
      const k = Math.floor(last / lat.size), idx = last % lat.size;
      const vt = chosen.get(last)!;
      // keep the vias the path already uses to change layer on its way (e.g. a microvia down to the layer the
      // plane via starts from), then add the plane via itself
      const along = res.vias ?? this.viasOf(res.path);
      res.vias = { idx: [...along.idx, idx], type: [...along.type, vt.index] };
      // keep a node on the far routing layer of the span (if any) so the path shows the layer change
      const other = k !== vt.k1 ? vt.k1 : vt.k0;
      if (other !== k) res.path.push(other * lat.size + idx);
      return res;
    }
    const rb = comp.term.get(c.b.ref)!;
    if (ra === rb) return { path: [], cost: 0, conflicts: 0, expansions: 0 };
    const targets = this.groupCells(c.net, comp, rb, c);
    // windowed search first, then unrestricted
    const res = this.searcher.search({ ...base, targets, window: this.windowFor(sources, targets, 0.5) });
    if (res) return res;
    const full = this.searcher.search({ ...base, targets });
    if (full) return full;
    // a failed exact search usually ran out of budget on a long path: weighted A* reaches much further for the same cost
    if (c.fails >= 1) {
      const weighted = this.searcher.search({ ...base, targets, heuristicWeight: Math.max(1.6, base.heuristicWeight ?? 1), maxExpansions: base.maxExpansions * 2 });
      if (weighted) return weighted;
    }
    if (c.fails % 4 !== 3) return null;
    // every fourth failure of a connection earns one search with a much larger budget
    return this.searcher.search({ ...base, targets, maxExpansions: base.maxExpansions * 4 });
  }

  /** A connection routed as "already connected" (empty path) is only valid while its ends stay joined by real copper. */
  private revalidatePhantoms(): void {
    for (const c of this.connections) {
      if (!c.path || c.path.length !== 0) continue;
      const comp = this.components(c.net, c);
      if (c.b === null) { if (comp.term.get(c.a.ref) !== comp.term.get('#plane')) c.path = undefined; continue; }
      if (comp.term.get(c.a.ref) !== comp.term.get(c.b.ref)) c.path = undefined;
    }
  }

  /* ---------- passes ---------- */

  private record(kind: PassRecord['kind'], t0: number): PassRecord {
    this.revalidatePhantoms();
    const real = this.connections.filter((c) => !c.escape);   // fanout escapes are copper, not connections to complete
    const total = real.length;
    const routed = real.filter((c) => !!c.path).length;
    const conflicts = this.tallyConflicts();
    let vias = 0, length = 0;
    for (const c of this.connections) if (c.path) { vias += c.viaIdx!.length; length += this.lengthOf(c); }
    const clean = real.filter((c) => c.path && c.conflicts === 0).length;
    const rec: PassRecord = { pass: this.passCounter, kind, routed, total, unrouted: total - routed, conflicts, vias, length, seconds: (Date.now() - t0) / 1000, completion: total ? (100 * clean) / total : 100 };
    this.history.push(rec);
    this.log(`${kind.padEnd(6)} pass ${String(rec.pass).padStart(3)} | routed ${routed}/${total} | unrouted ${rec.unrouted} | conflicts ${conflicts} | vias ${vias} | length ${(length / this.board.rules.mmToRes()).toFixed(1)}mm | ${rec.seconds.toFixed(1)}s`);
    this.opts.onPass?.(rec);
    const score = rec.unrouted * 1e6 + conflicts * 1e3 + vias;
    if (!this.best || score < this.best.score) {
      const paths = new Map<number, { path: number[]; vias: ViaList }>();
      for (const c of this.connections) if (c.path) paths.set(c.id, { path: c.path.slice(), vias: { idx: (c.viaIdx ?? []).slice(), type: (c.viaType ?? []).slice() } });
      this.best = { score, paths };
    }
    return rec;
  }

  /** Routed length of a connection: imported copper is measured on its wires (its node list is unordered). */
  lengthOf(c: Connection): number {
    if (!c.imported) return this.pathLength(c.path ?? []);
    let L = 0;
    for (const w of c.imported.wires) for (let i = 1; i < w.points.length; i++) L += Math.hypot(w.points[i].x - w.points[i - 1].x, w.points[i].y - w.points[i - 1].y);
    return L;
  }

  /** Score of the current state (lower is better): unrouted, then conflicts, then vias. */
  score(): number { const r = this.history[this.history.length - 1]; return r ? r.unrouted * 1e6 + r.conflicts * 1e3 + r.vias : Infinity; }

  pathLength(path: number[]): number {
    let L = 0;
    for (let i = 1; i < path.length; i++) {
      const a = this.lat.nodeToPt(path[i - 1]), b = this.lat.nodeToPt(path[i]);
      L += Math.hypot(a.x - b.x, a.y - b.y);
    }
    return L;
  }

  /** Standard routing passes. Returns true when the design is complete (no unroutes, no conflicts). */
  route(passes: number, startPass?: number, remove = false): boolean {
    for (let p = 0; p < passes; p++) {
      const t0 = Date.now();
      this.passCounter++;
      const costIndex = (startPass ?? 1) + p;
      const costs = this.costsFor(costIndex, 'route');
      for (const c of this.connections) c.conflicts = this.conflictsOf(c);
      this.revalidatePhantoms();
      const todo = this.connections.filter((c) => (!c.path || c.conflicts > 0) && !(c.escape && !c.path && c.fails >= 2));
      if (todo.length === 0) { this.log('nothing to route'); return true; }
      todo.sort((a, b) => (b.priority - a.priority) || ((a.path ? 1 : 0) - (b.path ? 1 : 0)) || (a.manhattan - b.manhattan));
      if (p > 0) for (let i = todo.length - 1; i > 0; i--) { if (this.rand() < 0.3) { const j = Math.floor(this.rand() * (i + 1)); [todo[i], todo[j]] = [todo[j], todo[i]]; } }
      const attempt = (c: Connection) => {
        // sequential rip-up and reroute against the live board state
        this.ripUp(c);
        const res = this.routeOne(c, costs);
        if (!res) { c.fails++; return; }
        this.occupy(c, res.path, res.vias);
      };
      for (const c of todo) attempt(c);
      // connections ripped up by cascades are retried in the same pass
      for (let round = 0; round < 3; round++) {
        const left = this.connections.filter((c) => !c.path && !todo.includes(c) && !(c.escape && c.fails >= 2));
        if (!left.length) break;
        for (const c of left) attempt(c);
      }
      const rec = this.record('route', t0);
      if (remove && costIndex >= 5) {
        let removed = 0;
        for (const c of this.connections) if (c.path && c.conflicts > 0 && c.fails > 3 && c.priority < 200) { this.ripUp(c); removed++; }
        if (removed) this.tallyConflicts();
      }
      if (rec.unrouted === 0 && rec.conflicts === 0) return true;
    }
    return false;
  }

  /** Clean passes: rip up and reroute each connection one at a time, keeping improvements. */
  clean(passes: number): void {
    const costs = this.costsFor(1, 'clean');
    for (let p = 0; p < passes; p++) {
      const t0 = Date.now();
      this.passCounter++;
      // imported copper is skipped: a piece may join three or more pads, and rerouting it between two would drop the rest
      const routed = this.connections.filter((c) => c.path && c.conflicts === 0 && !c.imported && !c.escape).sort((a, b) => (b.viaIdx!.length - a.viaIdx!.length) || (this.pathLength(b.path!) - this.pathLength(a.path!)));
      let improved = 0;
      for (const c of routed) {
        if (c.path!.length === 0) continue;          // "already connected" placeholder
        if (this.dependents(c).length) continue;   // others attach to this copper; leave it
        const old = c.path!; const oldVias = this.viaListOf(c);
        const oldScore = this.pathLength(old) / this.lat.pitch + oldVias.idx.length * costs.via;
        this.ripUp(c);
        const res = this.routeOne(c, costs);
        if (res && res.path.length && res.conflicts === 0) {
          const vias = (res.vias ?? this.viasOf(res.path)).idx.length;
          const score = this.pathLength(res.path) / this.lat.pitch + vias * costs.via;
          if (score < oldScore - 1e-6) {
            // connections counted "already connected" may ride on this copper: the new path must keep them joined
            const phantoms = this.connections.filter((o) => o !== c && o.net === c.net && o.path && o.path.length === 0);
            this.occupy(c, res.path, res.vias);
            this.revalidatePhantoms();
            const orphaned = phantoms.filter((o) => !o.path);
            if (!orphaned.length && this.conflictsOf(c) === 0 && this.inflictedBy(c) === 0) { improved++; continue; }
            for (const o of orphaned) o.path = [];
            this.ripUp(c);   // the new path conflicts with, crowds, or disconnects other copper: keep the old one
          }
        }
        this.occupy(c, old, oldVias);
      }
      this.record('clean', t0);
      this.log(`clean: improved ${improved} connections`);
      if (improved === 0) break;
    }
  }

  /**
   * Fanout: connect SMD pins of plane nets to the plane with a via. With `signal`, also escape signal SMD pins of
   * parts with at least `minPins` pins (BGAs, fine-pitch QFPs) that sit deeper than `outerRows` rows from the part
   * edge — the pins that cannot leave on the surface layer — with a dog-bone to a via onto another layer.
   */
  fanout(opts: { signal?: boolean; minPins?: number; outerRows?: number } = {}): void {
    const t0 = Date.now();
    this.passCounter++;
    const costs = this.costsFor(1, 'fanout');
    if (opts.signal) this.addEscapes(opts.minPins ?? 32, opts.outerRows ?? 2);
    let escaped = 0, escapeFailed = 0;
    for (const c of this.connections) {
      if (!(c.b === null || c.escape) || c.path) continue;
      const res = this.routeOne(c, costs);
      if (res) { this.occupy(c, res.path, res.vias); if (c.escape) escaped++; } else { c.fails++; if (c.escape) escapeFailed++; }
    }
    if (opts.signal) this.log(`fanout: ${escaped} signal pins escaped, ${escapeFailed} could not be escaped`);
    this.record('fanout', t0);
  }

  private addEscapes(minPins: number, outerRows: number): void {
    const b = this.board;
    const byComp = new Map<string, PinTerminal[]>();
    for (const t of b.terminals) { const comp = t.ref.slice(0, t.ref.lastIndexOf('-')); const a = byComp.get(comp) ?? []; a.push(t); byComp.set(comp, a); }
    const wanted = new Set<string>();
    for (const c of this.connections) if (c.b !== null && !c.escape && !c.imported) { wanted.add(c.a.ref); wanted.add(c.b.ref); }
    const have = new Set(this.connections.filter((c) => c.escape).map((c) => c.a.ref));
    let id = this.connections.length ? Math.max(...this.connections.map((c) => c.id)) + 1 : 0;
    for (const [, terms] of byComp) {
      const smd = terms.filter((t) => t.isSmd);
      if (smd.length < minPins) continue;
      // pitch: smallest centre spacing; inner pins are more than outerRows pitches from the part's pin bounding box
      let pitch = Infinity;
      for (let i = 0; i < smd.length; i++) for (let j = i + 1; j < smd.length; j++) { const d = Math.hypot(smd[i].center.x - smd[j].center.x, smd[i].center.y - smd[j].center.y); if (d > 0 && d < pitch) pitch = d; }
      if (!Number.isFinite(pitch)) continue;
      const x0 = Math.min(...smd.map((t) => t.center.x)), x1 = Math.max(...smd.map((t) => t.center.x));
      const y0 = Math.min(...smd.map((t) => t.center.y)), y1 = Math.max(...smd.map((t) => t.center.y));
      for (const t of smd) {
        if (!wanted.has(t.ref) || have.has(t.ref) || this.planeNets.has(t.net)) continue;
        const edge = Math.min(t.center.x - x0, x1 - t.center.x, t.center.y - y0, y1 - t.center.y);
        if (edge < outerRows * pitch - pitch * 0.25) continue;
        this.connections.push({ id: id++, net: t.net, netId: this.lat.netId(t.net), a: t, b: t, escape: true, priority: this.board.rules.priority(this.board.design.network.nets.get(t.net)!), manhattan: 0, conflicts: 0, fails: 0, rippedPasses: 0 });
      }
    }
    this.netTermCells.clear();
  }

  /**
   * Global routing (SPECCTRA `groute`): the board is cut into tiles of `gTile` x `gTile` lattice cells; each tile's
   * capacity is the number of tracks that fit through it over all routing layers, scaled by its free (not fixed-
   * copper) area. Every connection is maze-routed tile to tile with negotiated congestion (overflow is penalised
   * and history accumulates, several rounds, PathFinder style). Each connection keeps its tiles, dilated by one,
   * as a corridor: the detail search then pays 30 % more outside it — a bias, not a wall.
   */
  globalRoute(rounds = 4): { overflow: number; tiles: number } {
    const lat = this.lat, T = this.gTile;
    this.gx = Math.ceil(lat.nx / T); this.gy = Math.ceil(lat.ny / T);
    const nT = this.gx * this.gy;
    const cap = new Float32Array(nT), use = new Float32Array(nT), hist = new Float32Array(nT);
    // capacity: tracks per tile per layer (tile width / track pitch) x free fraction, summed over layers
    const ex = this.board.rules.extremes();
    const trackCells = Math.max(1, Math.round((ex.maxWidth + ex.maxClearance) / lat.pitch));
    const need = ex.minWidth / 2 + lat.c0;
    for (let ty = 0; ty < this.gy; ty++) for (let tx = 0; tx < this.gx; tx++) {
      let free = 0, all = 0;
      for (let j = ty * T; j < Math.min(lat.ny, (ty + 1) * T); j += 2) for (let i = tx * T; i < Math.min(lat.nx, (tx + 1) * T); i += 2) {
        for (let k = 0; k < lat.nl; k++) { all++; if (lat.foreignDist(k, lat.idx(i, j), -999) >= need) free++; }
      }
      cap[ty * this.gx + tx] = all ? (T / trackCells) * lat.nl * (free / all) : 0;
    }
    const tileOf = (p: Pt) => { const i = Math.min(this.gx - 1, Math.max(0, Math.floor(lat.toI(p.x) / T))), j = Math.min(this.gy - 1, Math.max(0, Math.floor(lat.toJ(p.y) / T))); return j * this.gx + i; };
    const conns = this.connections.filter((c) => c.b && !c.escape && !c.imported);
    const paths = new Map<Connection, number[]>();
    const costOf = (t: number) => 1 + hist[t] + (use[t] + 1 > cap[t] ? 4 * (use[t] + 1 - cap[t]) / Math.max(1, cap[t]) : 0) + (cap[t] < 0.5 ? 50 : 0);
    const route = (a: number, b: number): number[] => {
      // Dijkstra on the tile grid (small)
      const dist = new Float32Array(nT).fill(Infinity), prev = new Int32Array(nT).fill(-1), done = new Uint8Array(nT);
      const heap: [number, number][] = [[0, a]]; dist[a] = 0;
      while (heap.length) {
        let bi = 0; for (let h = 1; h < heap.length; h++) if (heap[h][0] < heap[bi][0]) bi = h;
        const [d, t] = heap[bi]; heap[bi] = heap[heap.length - 1]; heap.pop();
        if (done[t]) continue; done[t] = 1; if (t === b) break;
        const tx = t % this.gx, ty = Math.floor(t / this.gx);
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const nx = tx + dx, ny = ty + dy; if (nx < 0 || ny < 0 || nx >= this.gx || ny >= this.gy) continue;
          const n = ny * this.gx + nx; const nd = d + costOf(n);
          if (nd < dist[n]) { dist[n] = nd; prev[n] = t; heap.push([nd, n]); }
        }
      }
      const out: number[] = []; for (let t = b; t >= 0; t = prev[t]) { out.push(t); if (t === a) break; }
      return out.reverse();
    };
    let overflow = 0;
    for (let round = 0; round < rounds; round++) {
      for (const c of conns) {
        const old = paths.get(c); if (old) for (const t of old) use[t]--;
        const p = route(tileOf(c.a.center), tileOf(c.b!.center));
        for (const t of p) use[t]++;
        paths.set(c, p);
      }
      overflow = 0;
      for (let t = 0; t < nT; t++) if (use[t] > cap[t]) { overflow += use[t] - cap[t]; hist[t] += 0.5 * (use[t] - cap[t]) / Math.max(1, cap[t]); }
      this.log(`groute round ${round + 1}: overflow ${overflow.toFixed(0)} tracks over ${[...use].filter((u, t) => u > cap[t]).length} tiles`);
      if (overflow === 0) break;
    }
    // corridors: tiles of the global path dilated by one
    for (const c of conns) {
      const set = new Set<number>();
      for (const t of paths.get(c) ?? []) { const tx = t % this.gx, ty = Math.floor(t / this.gx); for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) { const x = tx + dx, y = ty + dy; if (x >= 0 && y >= 0 && x < this.gx && y < this.gy) set.add(y * this.gx + x); } }
      c.corridor = [...set];
    }
    this.gCap = cap; this.gUse = use;
    this.corridorMask = new Uint8Array(nT);
    this.corridorsOn = true;
    return { overflow, tiles: nT };
  }

  /** Congestion report from the global route: the most over-subscribed tiles (usage / capacity) with their location. */
  congestionReport(top = 20): string {
    if (!this.gCap || !this.gUse) return '# congestion: run groute first\n';
    const mm = this.board.rules.mmToRes();
    const rows: { t: number; r: number }[] = [];
    for (let t = 0; t < this.gCap.length; t++) if (this.gUse[t] > 0) rows.push({ t, r: this.gUse[t] / Math.max(0.5, this.gCap[t]) });
    rows.sort((a, b) => b.r - a.r);
    const lines = [`# congestion (tiles of ${this.gTile} x ${this.gTile} cells = ${(this.gTile * this.lat.pitch / mm).toFixed(2)} mm, all routing layers)`, '#   x(mm)    y(mm)   used  capacity  ratio'];
    for (const { t, r } of rows.slice(0, top)) {
      const tx = t % this.gx, ty = Math.floor(t / this.gx);
      const x = (this.lat.ox + (tx + 0.5) * this.gTile * this.lat.pitch) / mm, y = (this.lat.oy + (ty + 0.5) * this.gTile * this.lat.pitch) / mm;
      lines.push(`${x.toFixed(1).padStart(9)} ${y.toFixed(1).padStart(8)} ${this.gUse[t].toFixed(0).padStart(6)} ${this.gCap[t].toFixed(1).padStart(9)} ${r.toFixed(2).padStart(6)}`);
    }
    const over = rows.filter((x) => x.r > 1).length;
    lines.push(`# ${over} tiles over capacity`);
    return lines.join('\n') + '\n';
  }

  /** filter (SPECCTRA): connections still in conflict are ripped up and left unrouted. Returns how many. */
  filter(): number {
    let n = 0;
    for (const c of this.connections) { c.conflicts = this.conflictsOf(c); }
    for (const c of this.connections) if (c.path && c.path.length && c.conflicts > 0) { this.ripUp(c); n++; }
    this.passCounter++; this.record('route', Date.now());
    return n;
  }

  /** smart_route: fanout, 25 passes, 2 clean, 50 passes from cost row 16, 4 clean; stops early when done. */
  smartRoute(opts: { maxPasses?: number } = {}): boolean {
    this.fanout();
    const first = Math.min(25, opts.maxPasses ?? 25);
    let done = this.route(first);
    if (!done) { this.clean(2); done = this.route(Math.max(0, (opts.maxPasses ?? 75) - first), 16); }
    this.clean(done ? 4 : 2);
    this.restoreBest();
    return this.connections.every((c) => c.path && c.conflicts === 0);
  }

  restoreBest(): void {
    if (!this.best) return;
    const r = this.history[this.history.length - 1];
    const currentScore = r ? r.unrouted * 1e6 + r.conflicts * 1e3 + r.vias : Infinity;
    if (currentScore <= this.best.score) return;
    for (const c of this.connections) { const b = this.best.paths.get(c.id); c.path = b ? b.path.slice() : undefined; c.viaIdx = b ? b.vias.idx.slice() : undefined; c.viaType = b ? b.vias.type.slice() : undefined; }
    this.rebuildOccupancy(); this.tallyConflicts();
    this.log('restored best routing');
  }

  /* ---------- output ---------- */

  /** Convert routed paths to wires and vias (resolution units). */
  routes(): SessionRoutes {
    const lat = this.lat;
    const d = this.board.design;
    const out: SessionRoutes = { resolution: { ...d.resolution }, nets: new Map(), padstacks: [] };
    const usedPadstacks = new Set<string>();
    for (const c of this.connections) {
      if (!c.path || c.path.length === 0) continue;
      const entry = out.nets.get(c.net) ?? { wires: [], vias: [] };
      out.nets.set(c.net, entry);
      if (c.imported) {
        for (const w of c.imported.wires) entry.wires.push({ ...w, net: c.net, type: 'route' });
        for (const v of c.imported.vias) { entry.vias.push({ ...v, net: c.net, type: 'route' }); usedPadstacks.add(v.padstack); }
        continue;
      }
      const width = (layer: number, at?: Pt) => this.board.rules.width(c.net, this.board.layerNames[layer], { a: c.a.ref, b: c.b?.ref }, at);
      const regionAt = (n: number) => (this.regionOf ? this.regionOf[n % lat.size] : 0);
      const vi = c.viaIdx ?? [], vty = c.viaType ?? [];
      for (let v = 0; v < vi.length; v++) { const vt = lat.viaTypes[vty[v]]; entry.vias.push({ padstack: vt.name, at: lat.nodeToPt(vi[v]), net: c.net, type: 'route' } as Via); usedPadstacks.add(vt.name); }
      let run: Pt[] = []; let runK = Math.floor(c.path[0] / lat.size); let runR = regionAt(c.path[0]);
      const startCells = new Set(this.cellsOf(c.a));
      const endCells = c.b ? new Set(this.cellsOf(c.b)) : null;
      const flush = (k: number) => {
        if (run.length === 0) return;
        const pts = simplifyPolyline(run);
        if (pts.length >= 2) entry.wires.push({ layer: this.board.layerNames[lat.layers[k]], width: width(lat.layers[k], runR ? this.regionPt[runR] : undefined), points: pts, net: c.net, type: 'route' } as Wire);
        run = [];
      };
      for (let i = 0; i < c.path.length; i++) {
        const n = c.path[i];
        const k = Math.floor(n / lat.size);
        const p = lat.nodeToPt(n);
        if (i === 0 && startCells.has(n) && (c.a.center.x !== p.x || c.a.center.y !== p.y)) run.push({ ...c.a.center });
        if (k !== runK) { flush(runK); runK = k; runR = regionAt(n); }
        else if (regionAt(n) !== runR) {
          // a constraint region boundary: the wire continues with that region's width
          const joint = run[run.length - 1]; flush(runK); if (joint) run.push(joint); runR = regionAt(n);
        }
        run.push(p);
      }
      const lastN = c.path[c.path.length - 1];
      if (endCells && endCells.has(lastN)) { const lp = lat.nodeToPt(lastN); if (c.b!.center.x !== lp.x || c.b!.center.y !== lp.y) run.push({ ...c.b!.center }); }
      flush(runK);
    }
    // merge redundant vias: same net and position, span inside another via's span (two connections dropping a
    // via on the same spot, or a blind via inside a through via) — one drill hit, not two
    for (const [, e] of out.nets) {
      const span = (v: Via) => { const t = lat.viaTypeByName(v.padstack); return t ? [t.b0, t.b1] : [0, Infinity]; };
      const keep: Via[] = [];
      for (const v of e.vias) {
        const [a0, a1] = span(v);
        const dup = keep.findIndex((k) => k.at.x === v.at.x && k.at.y === v.at.y);
        if (dup < 0) { keep.push(v); continue; }
        const [b0, b1] = span(keep[dup]);
        if (a0 >= b0 && a1 <= b1) continue;               // inside the kept one
        if (b0 >= a0 && b1 <= a1) { keep[dup] = v; continue; }   // kept one is inside this
        keep.push(v);                                      // a genuine stack (adjacent spans)
      }
      e.vias = keep;
    }
    for (const name of usedPadstacks) { const ps = d.library.padstacks.get(name); if (ps) out.padstacks.push(ps); }
    return out;
  }

  statusReport(title = this.board.design.id): string {
    const last = this.history[this.history.length - 1];
    const total = this.connections.length;
    const routed = this.connections.filter((c) => c.path).length;
    const mm = this.board.rules.mmToRes();
    const lines: string[] = [];
    lines.push(`#ROUTING STATUS <<< ${title} >>>`);
    lines.push(`Nets         = ${String(this.board.design.network.nets.size).padStart(8)}   Connections         = ${String(total).padStart(8)}`);
    lines.push(`Completion   = ${(last?.completion ?? 0).toFixed(2).padStart(7)}%   Unconnections       = ${String(total - routed).padStart(8)}`);
    lines.push(`Conflicts    = ${String(last?.conflicts ?? 0).padStart(8)}   Total Vias          = ${String(last?.vias ?? 0).padStart(8)}`);
    lines.push(`Routed length= ${((last?.length ?? 0) / mm).toFixed(3).padStart(10)} mm`);
    lines.push(`# Overall Routing Time: ${((Date.now() - this.startTime) / 1000).toFixed(1)}s`);
    lines.push('');
    lines.push('  Kind   Pass | Unroutes | Conflicts |  Vias |  Length(mm) |   Time');
    for (const r of this.history) lines.push(`  ${r.kind.padEnd(6)} ${String(r.pass).padStart(4)} | ${String(r.unrouted).padStart(8)} | ${String(r.conflicts).padStart(9)} | ${String(r.vias).padStart(5)} | ${(r.length / mm).toFixed(2).padStart(11)} | ${r.seconds.toFixed(1).padStart(6)}s`);
    return lines.join('\n') + '\n';
  }
}
