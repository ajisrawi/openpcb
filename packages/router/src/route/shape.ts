/**
 * OpenRoute shape-based (gridless) router — the counterpart of SPECCTRA's shape-based engine.
 *
 * There is no routing grid. For every connection the router builds, inside a search window, a visibility graph whose
 * nodes are the corners of the other-net obstacles inflated by the exact clearance + half wire width (octagon hulls,
 * so every corner sits on a 0/45/90° line), plus the copper points of the source and target islands and via-escape
 * points around the pads. Edges are 45°-legal connections (straight, or a two-leg dogleg) that are checked against
 * the real shapes with the typed clearance rules; layer changes are via placements checked on every layer the via
 * spans (hole rules arrive as via clearances). A* runs lazily over the K nearest nodes of each expanded node.
 *
 * Nets are completed island by island (pads, fixed wiring, routed copper and plane-reaching vias that touch form an
 * island); a plane is an island that any clear via inside the plane outline reaches. A connection that cannot be
 * found with the other nets' routed copper as hard obstacles is searched again with that copper passable at a cost
 * that grows with each net's rip-up history (negotiated congestion); the copper it crosses is ripped up and requeued.
 */
import { Board, shapeToGeom, type Item, type PinTerminal, type Geometry } from '../board.js';
import type { Design, SessionRoutes, Wire, Via, Shape } from '../model.js';
import { geomDistance } from '../drc.js';
import { type Pt, type Box, pointInPolygon, distPointSeg, distSegSeg } from '../geom.js';

export interface ShapeRouterOptions {
  log?: (s: string) => void;
  passes?: number;            // rip-up/reroute passes (default 16)
  viaCost?: number;           // resolution units of length one via costs (default 1.2 mm)
  bendCost?: number;          // per direction change (default 0.05 mm)
  anyAngle?: boolean;         // allow any-angle edges (default: 45° only)
  edgeClearance?: number;     // copper to outline (default: wire-wire clearance)
  selectedNets?: Set<string>;
  maxExpansions?: number;     // per search (default 30000)
  neighbours?: number;        // nearest nodes tried per expansion (default 32)
  existing?: SessionRoutes;   // routed copper to keep (resume / finish another router's work)
  timeLimitMs?: number;
  heuristicWeight?: number;   // weighted A* (default 1.15)
  debug?: boolean;
}

interface ViaKind { name: string; b0: number; b1: number; shapes: { li: number; s: Shape }[]; r: number }
interface Conn { id: number; net: string; wires: Wire[]; vias: Via[]; items: Item[]; imported?: boolean }
interface Piece { elem: number; li: number; g: Geometry; box: Box }
interface Island { elems: number[]; terms: PinTerminal[]; conns: Conn[]; fixed: Item[]; plane: boolean }
interface NetInfo { name: string; terms: PinTerminal[]; planes: { li: number; poly: Pt[] }[]; fixed: Item[]; layers: number[]; vias: ViaKind[]; prio: number }
interface Pnt { x: number; y: number; li: number }
interface CandGrid { pts: Pt[]; x0: number; y0: number; cell: number; nx: number; ny: number; start: Int32Array; idx: Int32Array }
interface SNode { x: number; y: number; li: number; g: number; f: number; parent: number; corner?: Pt; via?: string; dir: number; closed: boolean; goal?: boolean; planeVia?: string }

const SQ2 = Math.SQRT2;

export class ShapeRouter {
  readonly board: Board;
  readonly conns = new Map<number, Conn>();
  private readonly connOfItem = new Map<number, number>();
  private readonly netConns = new Map<string, Conn[]>();
  private readonly nets = new Map<string, NetInfo>();
  private readonly history = new Map<string, number>();
  private readonly viaKinds: ViaKind[] = [];
  private readonly routeLayers: number[];
  private readonly res: number;          // resolution units per mm
  private readonly edge: number;
  private readonly boundaryEdges: [Pt, Pt][] = [];
  private readonly viaAtSmd: boolean;
  private readonly partner = new Map<string, { net: string; gap: number }>();
  private readonly hasRegions: boolean;
  private nextId = 1;
  private t0 = Date.now();
  private maxClr = 0;
  private pass = 0;
  private pairOwn: string | null = null;     // while routing a pair carrier: the partner net counts as own copper
  private hwOverride: number | null = null;  // while routing a pair carrier: the envelope half-width
  stats: { searches: number; expansions: number; ripups: number; failed: number; carriers?: number } = { searches: 0, expansions: 0, ripups: 0, failed: 0 };

  constructor(readonly design: Design, readonly opts: ShapeRouterOptions = {}) {
    this.board = new Board(design);
    const b = this.board;
    this.res = b.rules.mmToRes();
    this.edge = opts.edgeClearance ?? b.rules.clearance(undefined, undefined, 'wire', 'wire');
    this.maxClr = b.rules.extremes().maxClearance;
    this.routeLayers = b.signalLayers.slice();
    for (let i = 0, j = b.boundary.length - 1; i < b.boundary.length; j = i++) this.boundaryEdges.push([b.boundary[j], b.boundary[i]]);
    this.viaAtSmd = (design.structure.control.get('via_at_smd') ?? 'off').toLowerCase().startsWith('on');
    this.hasRegions = !!design.structure.regions?.length;
    this.buildViaKinds();
    this.buildNets();
    for (const pr of design.network.pairs ?? []) {
      const gap = pr.gap ?? b.rules.clearance(pr.p, pr.n);
      this.partner.set(pr.p, { net: pr.n, gap }); this.partner.set(pr.n, { net: pr.p, gap });
    }
    if (opts.existing) { this.importExisting(opts.existing); this.ripViolations(); }
  }

  private log(s: string) { this.opts.log?.(s); }

  /* ------------------------------------------------------------------ setup */

  private buildViaKinds(): void {
    const d = this.design, b = this.board, n = d.structure.layers.length;
    for (const name of d.structure.vias) {
      const ps = d.library.padstacks.get(name); if (!ps) continue;
      const shapes: { li: number; s: Shape }[] = [];
      let b0 = Infinity, b1 = -Infinity, r = 0;
      for (const s of ps.shapes) for (const li of b.layersFor(s.layer)) {
        shapes.push({ li, s }); b0 = Math.min(b0, li); b1 = Math.max(b1, li);
        const g = shapeToGeom(s, { x: 0, y: 0 }, 0, false);
        r = Math.max(r, g.type === 'circle' ? g.r : Math.max(...(g.type === 'poly' ? g.pts : [g.a, g.b]).map((q) => Math.hypot(q.x, q.y))) + (g.type === 'seg' ? g.hw : 0));
      }
      if (!Number.isFinite(b0)) { b0 = 0; b1 = n - 1; }
      if (!this.routeLayers.some((l) => l >= b0 && l <= b1)) continue;
      this.viaKinds.push({ name, b0, b1, shapes, r });
    }
    // smallest span first: a layer change uses the smallest via that covers it
    this.viaKinds.sort((a, c) => (a.b1 - a.b0) - (c.b1 - c.b0) || a.r - c.r);
  }

  private buildNets(): void {
    const d = this.design, b = this.board;
    const realPlanes = d.structure.planes.filter((p) => { const li = b.layerIndex(p.shape.layer); return li >= 0 && !this.routeLayers.includes(li); });
    const fixedByNet = new Map<string, Item[]>();
    for (const it of b.items) if (it.fixed && (it.kind === 'wire' || it.kind === 'via') && it.net) { const a = fixedByNet.get(it.net) ?? []; a.push(it); fixedByNet.set(it.net, a); }
    for (const net of d.network.nets.values()) {
      if (this.opts.selectedNets?.size && !this.opts.selectedNets.has(net.name)) continue;
      const terms = net.pins.map((p) => b.terminalByRef.get(p)).filter((t): t is PinTerminal => !!t && t.layers.some((l) => this.routeLayers.includes(l)));
      const planes = realPlanes.filter((p) => p.net === net.name).map((p) => ({ li: b.layerIndex(p.shape.layer), poly: polyOfShape(p.shape) })).filter((p) => p.poly.length >= 3);
      if (terms.length + (planes.length ? 1 : 0) < 2) continue;
      const use = b.rules.useLayers(net.name);
      const layers = use?.length ? this.routeLayers.filter((l) => use.includes(b.layerNames[l])) : this.routeLayers.slice();
      const allowed = b.rules.vias(net.name);
      const vias = this.viaKinds.filter((v) => !allowed?.length || allowed.includes(v.name));
      this.nets.set(net.name, { name: net.name, terms, planes, fixed: fixedByNet.get(net.name) ?? [], layers: layers.length ? layers : this.routeLayers.slice(), vias: vias.length ? vias : this.viaKinds, prio: b.rules.priority(net) });
    }
  }

  /** Existing copper becomes routed (rip-up-able) connections, one per touching piece. */
  private importExisting(r: SessionRoutes): void {
    const scale = (this.design.resolution.value / r.resolution.value);
    for (const [net, e] of r.nets) {
      if (!this.nets.has(net)) continue;
      const wires = e.wires.filter((w) => w.type !== 'fix' && w.type !== 'protect').map((w) => ({ ...w, net, width: w.width * scale, points: w.points.map((q) => ({ x: q.x * scale, y: q.y * scale })) }));
      const vias = e.vias.filter((v) => v.type !== 'fix' && v.type !== 'protect').map((v) => ({ ...v, net, at: { x: v.at.x * scale, y: v.at.y * scale } }));
      if (!wires.length && !vias.length) continue;
      const c = this.commit(net, wires, vias); c.imported = true;
    }
  }

  /** Imported copper that breaks the current rules (rules tightened since it was routed) is ripped up to be rerouted. */
  private ripViolations(): void {
    let n = 0;
    for (const c of [...this.conns.values()]) {
      let bad = false;
      for (const it of c.items) {
        if (it.kind === 'wire' && it.geom.type === 'seg' && !this.segCheck(c.net, it.layer, it.geom.a, it.geom.b, it.geom.hw - 0.5, false)) { bad = true; break; }
      }
      // a via never blocks itself (same-net concentric copper is skipped by the check)
      if (!bad) for (const v of c.vias) { const k = this.viaKinds.find((x) => x.name === v.padstack); if (k && !this.viaCheck(c.net, k, v.at, false)) { bad = true; break; } }
      if (bad) { this.ripUp(c); this.history.set(c.net, 0); n++; }
    }
    if (n) this.log(`shape route: ${n} imported connections broke the current rules and were ripped up`);
  }

  /* --------------------------------------------------------------- copper db */

  private commit(net: string, wires: Wire[], vias: Via[]): Conn {
    const c: Conn = { id: this.nextId++, net, wires, vias, items: [] };
    for (const w of wires) c.items.push(...this.board.addWire(w, false));
    for (const v of vias) c.items.push(...this.board.addVia(v, false));
    for (const it of c.items) this.connOfItem.set(it.id, c.id);
    this.conns.set(c.id, c);
    const a = this.netConns.get(net) ?? []; a.push(c); this.netConns.set(net, a);
    return c;
  }

  private ripUp(c: Conn): void {
    for (const it of c.items) { this.board.removeItem(it); this.connOfItem.delete(it.id); }
    this.conns.delete(c.id);
    const a = this.netConns.get(c.net); if (a) { const i = a.indexOf(c); if (i >= 0) a.splice(i, 1); }
    this.history.set(c.net, (this.history.get(c.net) ?? 0) + 1);
    this.stats.ripups++;
  }

  /* ----------------------------------------------------------------- islands */

  /** Connected copper of a net: terminals, fixed wiring, routed connections and (virtually) its planes. */
  islands(net: string): Island[] {
    const info = this.nets.get(net)!;
    const conns = this.netConns.get(net) ?? [];
    const nT = info.terms.length, nF = info.fixed.length, nC = conns.length, P = nT + nF + nC;
    const parent = Array.from({ length: P + 1 }, (_, i) => i);
    const find = (x: number): number => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; };
    const union = (a: number, c: number) => { const ra = find(a), rc = find(c); if (ra !== rc) parent[ra] = rc; };
    const pieces: Piece[] = [];
    info.terms.forEach((t, i) => { for (const it of t.items) pieces.push({ elem: i, li: it.layer, g: it.geom, box: it.bbox }); });
    info.fixed.forEach((it, i) => pieces.push({ elem: nT + i, li: it.layer, g: it.geom, box: it.bbox }));
    conns.forEach((c, i) => { for (const it of c.items) pieces.push({ elem: nT + nF + i, li: it.layer, g: it.geom, box: it.bbox }); });
    pieces.sort((a, c) => a.box.minX - c.box.minX);
    for (let i = 0; i < pieces.length; i++) {
      const a = pieces[i];
      for (let j = i + 1; j < pieces.length && pieces[j].box.minX <= a.box.maxX + 1; j++) {
        const c = pieces[j];
        if (a.elem === c.elem || (a.li !== c.li && a.li !== -1 && c.li !== -1)) continue;
        if (c.box.minY > a.box.maxY + 1 || c.box.maxY < a.box.minY - 1) continue;
        if (find(a.elem) === find(c.elem)) continue;
        if (geomDistance(a.g, c.g) <= 0.5) union(a.elem, c.elem);
      }
    }
    // planes: TH pads and vias inside the plane outline on the plane layer
    const PL = P;
    if (info.planes.length) {
      const onPlane = (li: number, p: Pt) => info.planes.some((pl) => (li === -1 || pl.li === li) && pointInPolygon(p, pl.poly));
      info.terms.forEach((t, i) => { if (t.items.some((it) => info.planes.some((pl) => (it.layer === pl.li || it.layer === -1) && pointInPolygon(t.center, pl.poly)))) union(i, PL); });
      info.fixed.forEach((it, i) => { if (it.kind === 'via' && onPlane(it.layer, centerOf(it.geom))) union(nT + i, PL); });
      conns.forEach((c, i) => { for (const v of c.vias) { const k = this.viaKinds.find((x) => x.name === v.padstack); if (k && info.planes.some((pl) => pl.li >= k.b0 && pl.li <= k.b1 && pointInPolygon(v.at, pl.poly))) { union(nT + nF + i, PL); break; } } });
    }
    const groups = new Map<number, Island>();
    const get = (r: number) => { let g = groups.get(r); if (!g) { g = { elems: [], terms: [], conns: [], fixed: [], plane: false }; groups.set(r, g); } return g; };
    for (let i = 0; i < P; i++) {
      const g = get(find(i)); g.elems.push(i);
      if (i < nT) g.terms.push(info.terms[i]); else if (i < nT + nF) g.fixed.push(info.fixed[i - nT]); else g.conns.push(conns[i - nT - nF]);
    }
    if (info.planes.length) get(find(PL)).plane = true;
    // islands with no terminal and no plane are dangling copper: not targets
    return [...groups.values()].filter((g) => g.terms.length || g.plane);
  }

  /** Copper points of an island on routing layers (pads, wire vertices + samples, vias): starts / goals. */
  private islandPoints(net: NetInfo, isl: Island): Pnt[] {
    const out: Pnt[] = [];
    const step = 1.0 * this.res;
    const lay = new Set(net.layers);
    for (const t of isl.terms) for (const li of t.layers) if (lay.has(li)) out.push({ x: t.center.x, y: t.center.y, li });
    const addWire = (li: number, pts: Pt[]) => {
      if (!lay.has(li)) return;
      for (let i = 0; i < pts.length; i++) {
        out.push({ x: pts[i].x, y: pts[i].y, li });
        if (i) { const a = pts[i - 1], b = pts[i], L = Math.hypot(b.x - a.x, b.y - a.y), n = Math.floor(L / step); for (let k = 1; k < n; k++) out.push({ x: a.x + ((b.x - a.x) * k) / n, y: a.y + ((b.y - a.y) * k) / n, li }); }
      }
    };
    for (const c of isl.conns) {
      for (const w of c.wires) addWire(this.board.layerIndex(w.layer), w.points);
      for (const v of c.vias) { const k = this.viaKinds.find((x) => x.name === v.padstack); for (const li of net.layers) if (!k || (li >= k.b0 && li <= k.b1)) out.push({ x: v.at.x, y: v.at.y, li }); }
    }
    for (const it of isl.fixed) {
      if (it.geom.type === 'seg') addWire(it.layer, [it.geom.a, it.geom.b]);
      else { const c = centerOf(it.geom); if (it.layer === -1) for (const li of net.layers) out.push({ ...c, li }); else if (lay.has(it.layer)) out.push({ ...c, li: it.layer }); }
    }
    return out;
  }

  /* ------------------------------------------------------------- clearances */

  private hw(net: string, li: number, at?: Pt): number { if (this.hwOverride !== null) return this.hwOverride; return this.board.rules.width(net, this.board.layerNames[li], undefined, this.hasRegions ? at : undefined) / 2; }

  /** Other-net / keepout objects a segment (or point, a === b) of half-width hw on layer li violates.
   *  Returns false when a hard object is hit; otherwise the routed connections it crosses (soft mode) or true. */
  private segCheck(net: string, li: number, a: Pt, c: Pt, hw: number, soft: boolean, blockers?: Set<number>): boolean {
    const b = this.board;
    const pad = hw + this.maxClr + 2;
    const box = { minX: Math.min(a.x, c.x) - pad, minY: Math.min(a.y, c.y) - pad, maxX: Math.max(a.x, c.x) + pad, maxY: Math.max(a.y, c.y) + pad };
    const seg: Geometry = a.x === c.x && a.y === c.y ? { type: 'circle', c: a, r: hw } : { type: 'seg', a, b: c, hw };
    const lname = b.layerNames[li];
    const mid = this.hasRegions ? { x: (a.x + c.x) / 2, y: (a.y + c.y) / 2 } : undefined;
    for (const it of b.query(box, li)) {
      if (it.kind === 'plane' || it.kind === 'via_keepout') continue;
      if ((it.net === net || (this.pairOwn !== null && it.net === this.pairOwn)) && it.net !== undefined) continue;
      const need = it.kind === 'keepout' || it.kind === 'wire_keepout' ? 0.5 : b.rules.clearance(net, it.net, 'wire', it.objType, lname, mid);
      if (geomDistance(seg, it.geom) < need) {
        const cid = this.connOfItem.get(it.id);
        if (soft && cid !== undefined && !it.fixed) { blockers?.add(cid); continue; }
        return false;
      }
    }
    return this.insideBoard(a, hw) && this.insideBoard(c, hw) && this.edgeClear(a, c, hw);
  }

  private insideBoard(p: Pt, r: number): boolean {
    const bd = this.board.boundary;
    if (bd.length < 3) return true;
    if (!pointInPolygon(p, bd)) return false;
    for (const [e0, e1] of this.boundaryEdges) if (distPointSeg(p, e0, e1) < r + this.edge) return false;
    return true;
  }
  private edgeClear(a: Pt, c: Pt, hw: number): boolean {
    for (const [e0, e1] of this.boundaryEdges) if (distSegSeg(a, c, e0, e1) < hw + this.edge) return false;
    return true;
  }

  /** A via of kind k at p for net: clear on every layer it spans (vias of the same net must be concentric or spaced). */
  private viaCheck(net: string, k: ViaKind, p: Pt, soft: boolean, blockers?: Set<number>): boolean {
    const b = this.board;
    if (!this.insideBoard(p, k.r)) return false;
    for (const { li, s } of k.shapes) {
      const g = shapeToGeom(s, p, 0, false);
      const m = k.r + this.maxClr + 2;
      const gb = { minX: p.x - m, minY: p.y - m, maxX: p.x + m, maxY: p.y + m };
      const lname = b.layerNames[li];
      for (const it of b.query(gb, li)) {
        if (it.kind === 'plane' || it.kind === 'wire_keepout') continue;
        let need: number;
        if (it.kind === 'keepout' || it.kind === 'via_keepout') need = 0.5;
        else if (it.net === net && it.net !== undefined) {
          if (it.kind === 'pad' && it.objType === 'smd' && !this.viaAtSmd) need = 0.5;            // no via in an SMD pad
          else if (it.kind === 'via') { const cc = centerOf(it.geom); if (Math.hypot(cc.x - p.x, cc.y - p.y) < 1) continue; need = b.rules.clearance(net, '#other', 'via', 'via', lname); }
          else continue;
        } else need = b.rules.clearance(net, it.net, 'via', it.objType, lname);
        if (geomDistance(g, it.geom) < need) {
          const cid = this.connOfItem.get(it.id);
          if (soft && cid !== undefined && !it.fixed) { blockers?.add(cid); continue; }
          return false;
        }
      }
    }
    return true;
  }

  /* ------------------------------------------------------------------ search */

  /**
   * One connection: from the source island's copper to the target island's copper (or to a plane via).
   * Returns the path as points with layers, plus the via placed at the end when it drops to a plane.
   */
  private search(net: NetInfo, srcPts: Pnt[], goalPts: Pnt[], planeGoal: boolean, win: Box, soft: boolean, budget = 1): { path: Pnt[]; endVia?: string; blockers: Set<number> } | null {
    this.stats.searches++;
    const K = this.opts.neighbours ?? 32;
    const viaCost = this.opts.viaCost ?? 1.2 * this.res;
    const bendCost = this.opts.bendCost ?? 0.05 * this.res;
    const W = this.opts.heuristicWeight ?? 1.15;
    const maxExp = (this.opts.maxExpansions ?? 30000) * budget;
    const eps = Math.max(1, 0.003 * this.res);
    const softPen = (cid: number) => { const c = this.conns.get(cid); return (4 * this.res) * (1 + 2 * (this.history.get(c?.net ?? '') ?? 0)) * (1 + this.pass / 6); };

    // candidate nodes per layer: obstacle octagon corners, island points, via escapes
    const grids = new Map<number, CandGrid>();
    const nodesOn = (li: number): CandGrid => { let g = grids.get(li); if (!g) { g = this.buildCandidates(net, li, win, soft, srcPts, goalPts, eps, lanePts); grids.set(li, g); } return g; };

    // differential pair: lanes at exactly the pair spacing beside the partner's routed copper, cheaper to follow
    const laneNext = new Map<string, Pt[]>();
    const lanePts: Pnt[] = [];
    const pr = this.partner.get(net.name);
    if (pr) for (const c of this.netConns.get(pr.net) ?? []) for (const w of c.wires) {
      const li = this.board.layerIndex(w.layer); if (!net.layers.includes(li)) continue;
      const off = w.width / 2 + this.hw(net.name, li) + pr.gap;
      for (const side of [1, -1]) {
        const lane = offsetPolyline(w.points, off * side).map((q) => ({ x: Math.round(q.x), y: Math.round(q.y) }));
        lane.forEach((q, i) => {
          lanePts.push({ ...q, li });
          const k = `${li}:${q.x}:${q.y}`, a = laneNext.get(k) ?? [];
          if (i > 0) a.push(lane[i - 1]); if (i < lane.length - 1) a.push(lane[i + 1]);
          laneNext.set(k, a);
        });
      }
    }
    const goalsBy = new Map<number, Pnt[]>();
    for (const g of goalPts) { const a = goalsBy.get(g.li) ?? []; a.push(g); goalsBy.set(g.li, a); }
    const goalKey = new Set(goalPts.map((g) => `${g.li}:${Math.round(g.x)}:${Math.round(g.y)}`));
    const h = (x: number, y: number, li: number): number => {
      if (planeGoal) return 0;
      let best = Infinity;
      for (const g of goalPts) { const dx = Math.abs(g.x - x), dy = Math.abs(g.y - y); const d = Math.max(dx, dy) + (SQ2 - 1) * Math.min(dx, dy) + (g.li === li ? 0 : viaCost); if (d < best) best = d; }
      return best;
    };

    const nodes: SNode[] = [];
    const index = new Map<string, number>();
    const heap: number[] = [];
    const push = (i: number) => { heap.push(i); let k = heap.length - 1; while (k > 0) { const p = (k - 1) >> 1; if (nodes[heap[p]].f <= nodes[heap[k]].f) break; [heap[p], heap[k]] = [heap[k], heap[p]]; k = p; } };
    const pop = (): number => { const top = heap[0], last = heap.pop()!; if (heap.length) { heap[0] = last; let k = 0; for (;;) { const l = 2 * k + 1, r = l + 1; let m = k; if (l < heap.length && nodes[heap[l]].f < nodes[heap[m]].f) m = l; if (r < heap.length && nodes[heap[r]].f < nodes[heap[m]].f) m = r; if (m === k) break; [heap[m], heap[k]] = [heap[k], heap[m]]; k = m; } } return top; };
    const nodeAt = (x: number, y: number, li: number): number => {
      const kk = `${li}:${Math.round(x)}:${Math.round(y)}`;
      let i = index.get(kk);
      if (i === undefined) { i = nodes.length; nodes.push({ x, y, li, g: Infinity, f: Infinity, parent: -1, dir: -1, closed: false, goal: goalKey.has(kk) }); index.set(kk, i); }
      return i;
    };
    const relax = (from: number, to: number, g: number, dir: number, corner?: Pt, via?: string, planeVia?: string) => {
      const n = nodes[to];
      if (n.closed || g >= n.g) return;
      n.g = g; n.parent = from; n.dir = dir; n.corner = corner; n.via = via; n.planeVia = planeVia;
      n.f = planeVia ? g : g + W * h(n.x, n.y, n.li);
      push(to);
    };
    for (const s of srcPts) { const i = nodeAt(s.x, s.y, s.li); if (nodes[i].g > 0) { nodes[i].g = 0; nodes[i].f = W * h(s.x, s.y, s.li); push(i); } }
    const blockersOf = new Map<number, Set<number>>();   // soft mode: blockers accumulated along the best path to a node
    let exp = 0;
    while (heap.length) {
      const ui = pop(); const u = nodes[ui];
      if (u.closed) continue;
      u.closed = true;
      if ((u.goal && u.parent >= 0) || u.planeVia) {
        // reconstruct
        const path: Pnt[] = [];
        let i = ui;
        while (i >= 0) { const n = nodes[i]; path.push({ x: n.x, y: n.y, li: n.li }); if (n.corner) path.push({ x: n.corner.x, y: n.corner.y, li: n.li }); i = n.parent; }
        path.reverse();
        this.stats.expansions += exp;
        return { path, endVia: u.planeVia, blockers: blockersOf.get(ui) ?? new Set() };
      }
      if (++exp > maxExp) break;
      const ub = blockersOf.get(ui);
      const uhw = this.hw(net.name, u.li, u);
      // plane drop: a clear via here that reaches the net's plane
      if (planeGoal) for (const k of net.vias) {
        if (u.li < k.b0 || u.li > k.b1) continue;
        if (!net.planes.some((pl) => pl.li >= k.b0 && pl.li <= k.b1 && pointInPolygon(u, pl.poly))) continue;
        const bl = soft ? new Set<number>() : undefined;
        if (!this.viaCheck(net.name, k, u, soft, bl)) continue;
        const ti = nodeAt(u.x, u.y, -100 - u.li);   // pseudo node: "dropped to the plane here"
        let extra = 0; if (bl) for (const c of bl) if (!ub?.has(c)) extra += softPen(c);
        relax(ui, ti, u.g + viaCost * 0.5 + extra, u.dir, undefined, undefined, k.name);
        if (soft && bl?.size) blockersOf.set(ti, new Set([...(ub ?? []), ...bl]));
        break;
      }
      // layer changes
      for (const k of net.vias) {
        if (u.li < k.b0 || u.li > k.b1) continue;
        let checked = 0, ok = false; const bl = soft ? new Set<number>() : undefined;
        for (const l2 of net.layers) {
          if (l2 === u.li || l2 < k.b0 || l2 > k.b1) continue;
          // the smallest kind covering u.li..l2 is used for that change
          const best = net.vias.find((v) => v.b0 <= Math.min(u.li, l2) && v.b1 >= Math.max(u.li, l2));
          if (best !== k) continue;
          if (!checked) { ok = this.viaCheck(net.name, k, u, soft, bl); checked = 1; }
          if (!ok) break;
          const ti = nodeAt(u.x, u.y, l2);
          let extra = 0; if (bl) for (const c of bl) if (!ub?.has(c)) extra += softPen(c);
          const before = nodes[ti].g;
          relax(ui, ti, u.g + viaCost + extra, -1, undefined, k.name);
          if (soft && nodes[ti].g < before && (bl?.size || ub)) blockersOf.set(ti, new Set([...(ub ?? []), ...(bl ?? [])]));
        }
      }
      // same-layer moves to the nearest candidates and the nearest goals
      const grid = nodesOn(u.li);
      const near = this.nearest(grid, u, K);
      const gl = goalsBy.get(u.li);
      if (gl) { const gs = gl.map((g) => ({ g, d: Math.abs(g.x - u.x) + Math.abs(g.y - u.y) })).sort((a, c) => a.d - c.d).slice(0, 6); for (const { g } of gs) near.push(g); }
      const lanes = laneNext.size ? laneNext.get(`${u.li}:${Math.round(u.x)}:${Math.round(u.y)}`) : undefined;
      if (lanes) near.push(...lanes);
      for (const v of near) {
        if (v.x === u.x && v.y === u.y) continue;
        const ti = nodeAt(v.x, v.y, u.li);
        const tn = nodes[ti];
        if (tn.closed) continue;
        const dx = v.x - u.x, dy = v.y - u.y, ax = Math.abs(dx), ay = Math.abs(dy);
        const octLen = Math.max(ax, ay) + (SQ2 - 1) * Math.min(ax, ay);
        if (u.g + octLen >= tn.g) continue;
        const legal = this.opts.anyAngle || ax < 0.5 || ay < 0.5 || Math.abs(ax - ay) < 0.5;
        const options: { corner?: Pt; len: number; d1: number; d2: number }[] = [];
        if (legal) options.push({ len: Math.hypot(dx, dy), d1: dirOf(dx, dy), d2: dirOf(dx, dy) });
        else {
          const d = Math.min(ax, ay), sx = Math.sign(dx), sy = Math.sign(dy);
          const c1 = { x: u.x + sx * d, y: u.y + sy * d }, c2 = { x: v.x - sx * d, y: v.y - sy * d };
          options.push({ corner: c1, len: octLen, d1: dirOf(c1.x - u.x, c1.y - u.y), d2: dirOf(v.x - c1.x, v.y - c1.y) });
          options.push({ corner: c2, len: octLen, d1: dirOf(c2.x - u.x, c2.y - u.y), d2: dirOf(v.x - c2.x, v.y - c2.y) });
        }
        for (const o of options) {
          const bends = (u.dir >= 0 && u.dir !== o.d1 ? 1 : 0) + (o.d1 !== o.d2 ? 1 : 0);
          const g0 = u.g + o.len * (lanes && !o.corner && lanes.includes(v) ? 0.6 : 1) + bends * bendCost;
          if (g0 >= tn.g) continue;
          const bl = soft ? new Set<number>() : undefined;
          const hwv = this.hasRegions ? Math.max(uhw, this.hw(net.name, u.li, v)) : uhw;
          let ok: boolean;
          if (o.corner) ok = this.segCheck(net.name, u.li, u, o.corner, hwv, soft, bl) && this.segCheck(net.name, u.li, o.corner, v, hwv, soft, bl);
          else ok = this.segCheck(net.name, u.li, u, v, hwv, soft, bl);
          if (!ok) continue;
          let extra = 0; if (bl) for (const c of bl) if (!ub?.has(c)) extra += softPen(c);
          const before = tn.g;
          relax(ui, ti, g0 + extra, o.d2, o.corner);
          if (soft && tn.g < before) { if (bl?.size || ub) blockersOf.set(ti, new Set([...(ub ?? []), ...(bl ?? [])])); else blockersOf.delete(ti); }
          break;
        }
      }
    }
    this.stats.expansions += exp;
    return null;
  }

  /** The K nearest candidates plus the nearest few in each of 8 direction sectors (so a dense cluster of corners
   *  never hides the long edges out of it). Ring search over the layer's cell grid. */
  private nearest(G: CandGrid, u: Pt, K: number): Pt[] {
    const S = 3;
    const sect = new Int32Array(8);
    const found: { p: Pt; d: number; s: number }[] = [];
    const cx = Math.floor((u.x - G.x0) / G.cell), cy = Math.floor((u.y - G.y0) / G.cell);
    const rMax = Math.max(cx, cy, G.nx - 1 - cx, G.ny - 1 - cy) + 1;
    let full = 0;
    for (let r = 0; r <= rMax; r++) {
      const y0 = cy - r, y1 = cy + r;
      for (let x = cx - r; x <= cx + r; x++) {
        if (x < 0 || x >= G.nx) continue;
        const step = x === cx - r || x === cx + r ? 1 : y1 - y0 || 1;
        for (let y = y0; y <= y1; y += step) {
          if (y < 0 || y >= G.ny) continue;
          const c = x * G.ny + y;
          for (let q = G.start[c]; q < G.start[c + 1]; q++) {
            const p = G.pts[G.idx[q]];
            const dx = p.x - u.x, dy = p.y - u.y; if (dx === 0 && dy === 0) continue;
            const s = Math.min(7, Math.floor(((Math.atan2(dy, dx) + Math.PI) / (2 * Math.PI)) * 8));
            if (++sect[s] === S) full++;
            found.push({ p, d: dx * dx + dy * dy, s });
          }
        }
      }
      // every point of ring r+1 is at least r cells away: once K points and all sectors are in, nothing nearer remains
      if (r >= 1 && found.length >= K && full === 8) break;
      if (r >= 3 && found.length >= 4 * K && r * G.cell > 25 * this.res) break;
    }
    found.sort((a, c) => a.d - c.d);
    const out: Pt[] = [];
    const per = new Int32Array(8);
    for (let i = 0; i < found.length; i++) { const f = found[i]; if (i < K || per[f.s] < S) { out.push(f.p); per[f.s]++; } }
    return out;
  }

  /** Candidate points of a layer inside the window: corners of the inflated obstacles, island points, via escapes. */
  private buildCandidates(net: NetInfo, li: number, win: Box, soft: boolean, src: Pnt[], goals: Pnt[], eps: number, lanes: Pnt[] = []): CandGrid {
    const b = this.board;
    const hw = this.hw(net.name, li);
    const hwMin = this.hasRegions ? Math.min(hw, ...(this.design.structure.regions ?? []).map((r) => (r.rule?.width ?? hw * 2) / 2)) : hw;
    const lname = b.layerNames[li];
    const raw: Pt[] = [];
    const rr = (net.vias[0]?.r ?? hw) ;
    for (const it of b.query(win, li)) {
      if (it.kind === 'plane' || it.kind === 'via_keepout') continue;
      if (it.net === net.name && it.net !== undefined) continue;
      const need = (it.kind === 'keepout' || it.kind === 'wire_keepout' ? 0 : b.rules.clearance(net.name, it.net, 'wire', it.objType, lname)) + hw + eps;
      octagonCorners(it.geom, need, raw);
      if (hwMin < hw) octagonCorners(it.geom, need - hw + hwMin, raw);   // neck-down corners inside regions
      // via escape corners: a via needs more room than a wire; its corners give via sites between pads
      if (it.kind === 'pad') octagonCorners(it.geom, b.rules.clearance(net.name, it.net, 'via', it.objType, lname) + rr + eps, raw);
    }
    // island points of this layer and escape rings around the terminals
    for (const p of [...src, ...goals, ...lanes]) if (p.li === li) raw.push({ x: p.x, y: p.y });
    const terms = new Set<string>();
    for (const t of net.terms) for (const p of [...src, ...goals]) if (Math.abs(p.x - t.center.x) < 1 && Math.abs(p.y - t.center.y) < 1) terms.add(t.ref);
    for (const ref of terms) {
      const t = b.terminalByRef.get(ref)!;
      // midpoints towards neighbouring pads (BGA dog-bone sites) and an 8-direction ring
      for (const it of b.query({ minX: t.center.x - 1.6 * this.res, minY: t.center.y - 1.6 * this.res, maxX: t.center.x + 1.6 * this.res, maxY: t.center.y + 1.6 * this.res }, li)) {
        if (it.kind !== 'pad' || it.ref === ref) continue;
        const c = centerOf(it.geom); raw.push({ x: (c.x + t.center.x) / 2, y: (c.y + t.center.y) / 2 });
      }
      for (const d of [0.5, 0.8, 1.2]) for (let a = 0; a < 8; a++) raw.push({ x: t.center.x + Math.cos((a * Math.PI) / 4) * d * this.res, y: t.center.y + Math.sin((a * Math.PI) / 4) * d * this.res });
    }
    const pts: Pt[] = [];
    const seen = new Set<string>();
    const islandKeys = new Set([...src, ...goals].filter((p) => p.li === li).map((p) => `${Math.round(p.x)}:${Math.round(p.y)}`));
    for (const p of raw) {
      if (p.x < win.minX || p.x > win.maxX || p.y < win.minY || p.y > win.maxY) continue;
      const q = { x: Math.round(p.x), y: Math.round(p.y) };
      const k = `${q.x}:${q.y}`;
      if (seen.has(k)) continue;
      seen.add(k);
      if (!islandKeys.has(k) && !this.segCheck(net.name, li, q, q, this.hasRegions ? this.hw(net.name, li, q) : hw, soft)) continue;
      pts.push(q);
    }
    // CSR cell grid over the window
    const cell = Math.max(0.5 * this.res, 1);
    const x0 = Math.max(win.minX, this.board.bbox.minX), y0 = Math.max(win.minY, this.board.bbox.minY);
    const nx = Math.max(1, Math.ceil((Math.min(win.maxX, this.board.bbox.maxX) - x0) / cell) + 1), ny = Math.max(1, Math.ceil((Math.min(win.maxY, this.board.bbox.maxY) - y0) / cell) + 1);
    const cellOf = (p: Pt) => Math.min(nx - 1, Math.max(0, Math.floor((p.x - x0) / cell))) * ny + Math.min(ny - 1, Math.max(0, Math.floor((p.y - y0) / cell)));
    const start = new Int32Array(nx * ny + 1);
    for (const p of pts) start[cellOf(p) + 1]++;
    for (let c = 0; c < nx * ny; c++) start[c + 1] += start[c];
    const fill = start.slice(0, nx * ny), idx = new Int32Array(pts.length);
    pts.forEach((p, i) => { idx[fill[cellOf(p)]++] = i; });
    return { pts, x0, y0, cell, nx, ny, start, idx };
  }

  /* ------------------------------------------------------------------ routing */

  /** Wires (one per layer run, split where a region changes the width) and vias of a found path. */
  private toCopper(net: string, path: Pnt[], endVia?: string): { wires: Wire[]; vias: Via[] } {
    const wires: Wire[] = [], vias: Via[] = [];
    let run: Pt[] = [];
    let li = path[0]?.li ?? 0;
    const flush = () => {
      const pts = dedupe(run);
      if (pts.length >= 2) {
        if (!this.hasRegions) wires.push({ layer: this.board.layerNames[li], width: this.hw(net, li) * 2, points: collinear(pts), net, type: 'route' });
        else {
          // one wire per stretch of constant width
          let cur: Pt[] = [pts[0]], w0 = -1;
          for (let i = 1; i < pts.length; i++) {
            const m = { x: (pts[i - 1].x + pts[i].x) / 2, y: (pts[i - 1].y + pts[i].y) / 2 }, w = this.hw(net, li, m) * 2;
            if (w0 >= 0 && w !== w0) { wires.push({ layer: this.board.layerNames[li], width: w0, points: collinear(cur), net, type: 'route' }); cur = [pts[i - 1]]; }
            cur.push(pts[i]); w0 = w;
          }
          wires.push({ layer: this.board.layerNames[li], width: w0, points: collinear(cur), net, type: 'route' });
        }
      }
    };
    for (let i = 0; i < path.length; i++) {
      const p = path[i];
      if (p.li <= -100) break;
      if (p.li !== li) {
        flush();
        const name = this.viaFor(net, li, p.li);
        if (name) vias.push({ padstack: name, at: { x: p.x, y: p.y }, net, type: 'route' });
        run = [{ x: p.x, y: p.y }]; li = p.li;
      } else run.push({ x: p.x, y: p.y });
    }
    flush();
    if (endVia) { const last = path.filter((p) => p.li > -100).pop()!; vias.push({ padstack: endVia, at: { x: last.x, y: last.y }, net, type: 'route' }); }
    return { wires, vias };
  }

  private viaFor(net: string, a: number, c: number): string | undefined {
    const info = this.nets.get(net)!;
    return info.vias.find((v) => v.b0 <= Math.min(a, c) && v.b1 >= Math.max(a, c))?.name;
  }

  /** Try to join two islands of a net. Returns true when copper was added. */
  private connect(net: NetInfo, a: Island, b: Island, allowRipup: boolean): boolean {
    let src = this.islandPoints(net, a);
    let goal = b.plane && !b.terms.length && !b.conns.length ? [] : this.islandPoints(net, b);
    // search out of the smaller island: a lone pad boxed in by other copper is escaped first, the big island is a
    // large easy target (the plane is always the target)
    if (!b.plane && goal.length && goal.length < src.length) [src, goal] = [goal, src];
    const planeGoal = b.plane;
    if (!src.length || (!goal.length && !planeGoal)) { if (this.opts.debug) this.log(`  fail ${net.name}: ${!src.length ? 'source' : 'target'} island has no copper on the net's allowed layers (${net.layers.map((l) => this.board.layerNames[l]).join(',')})`); return false; }
    const all = [...src, ...goal];
    const bb = { minX: Math.min(...all.map((p) => p.x)), minY: Math.min(...all.map((p) => p.y)), maxX: Math.max(...all.map((p) => p.x)), maxY: Math.max(...all.map((p) => p.y)) };
    const diag = Math.hypot(bb.maxX - bb.minX, bb.maxY - bb.minY);
    const board = this.board.bbox;
    const grows = allowRipup ? [Math.max(2 * this.res, 0.3 * diag)] : [Math.max(2 * this.res, 0.3 * diag), Math.max(6 * this.res, diag), Infinity];
    for (const grow of grows) {
      const win = grow === Infinity ? { ...board } : { minX: bb.minX - grow, minY: bb.minY - grow, maxX: bb.maxX + grow, maxY: bb.maxY + grow };
      const r = this.search(net, src, goal, planeGoal, win, false);
      if (r) { const c = this.toCopper(net.name, r.path, r.endVia); this.commit(net.name, c.wires, c.vias); return true; }
      if (grow === Infinity) break;
    }
    if (!allowRipup) return false;
    // negotiated: other nets' routed copper passable at a cost; what the path crosses is ripped up
    const win = { minX: bb.minX - Math.max(3 * this.res, 0.5 * diag), minY: bb.minY - Math.max(3 * this.res, 0.5 * diag), maxX: bb.maxX + Math.max(3 * this.res, 0.5 * diag), maxY: bb.maxY + Math.max(3 * this.res, 0.5 * diag) };
    const e0 = this.stats.expansions;
    const r = this.search(net, src, goal, planeGoal, win, true) ?? this.search(net, src, goal, planeGoal, { ...board }, true, 6);
    if (!r) { if (this.opts.debug) this.log(`  fail ${net.name}: ${src.length} sources, ${goal.length} goals${planeGoal ? ' + plane' : ''}, soft search ${this.stats.expansions - e0} expansions`); return false; }
    for (const cid of r.blockers) { const c = this.conns.get(cid); if (c) this.ripUp(c); }
    const c = this.toCopper(net.name, r.path, r.endVia);
    this.commit(net.name, c.wires, c.vias);
    return true;
  }

  /** Islands still to join for a net, nearest pair first. */
  private nextPair(net: NetInfo, isl: Island[]): [Island, Island] | null {
    if (isl.length < 2) return null;
    const pts = isl.map((g) => g.terms.map((t) => t.center).concat(g.conns.flatMap((c) => c.wires.flatMap((w) => w.points))));
    let best: [Island, Island] | null = null, bd = Infinity;
    for (let i = 0; i < isl.length; i++) for (let j = 0; j < isl.length; j++) {
      if (i === j || isl[i].plane) continue;   // the source is never the plane island
      let d: number;
      if (isl[j].plane && !isl[j].terms.length) d = 0.3 * this.res;
      else { d = Infinity; for (const p of pts[i]) for (const q of pts[j]) { const e = Math.abs(p.x - q.x) + Math.abs(p.y - q.y); if (e < d) d = e; } }
      if (d < bd) { bd = d; best = [isl[i], isl[j]]; }
    }
    return best;
  }

  private incomplete(): NetInfo[] {
    const out: NetInfo[] = [];
    for (const n of this.nets.values()) if (this.islands(n.name).length > 1) out.push(n);
    return out;
  }

  /**
   * Differential pair as one carrier: the centre-line of the pair is routed with the envelope half-width
   * (w + gap / 2), the partner's copper counting as own, between points around the two pad pairs; it is then split
   * into the two traces at +-(w + gap) / 2. The short breakouts from the pads to the lanes are routed normally after.
   * Only for an unrouted two-pin pair whose ends sit side by side; returns false to fall back to net-by-net routing.
   */
  private routeCarrier(P: NetInfo, N: NetInfo, gap: number, soft: boolean): boolean {
    const ip = this.islands(P.name), iN = this.islands(N.name);
    const single = (g: Island[]) => g.length === 2 && g.every((x) => !x.plane && !x.conns.length && x.terms.length === 1);
    if (!single(ip) || !single(iN)) return false;
    const d = (a: Pt, b: Pt) => Math.hypot(a.x - b.x, a.y - b.y);
    const [pa, pb] = ip.map((g) => g.terms[0]);
    let [na, nb] = iN.map((g) => g.terms[0]);
    if (d(na.center, pa.center) > d(nb.center, pa.center)) [na, nb] = [nb, na];
    if (d(pa.center, na.center) > 4 * this.res || d(pb.center, nb.center) > 4 * this.res) return false;
    const Sa = { x: (pa.center.x + na.center.x) / 2, y: (pa.center.y + na.center.y) / 2 }, Sb = { x: (pb.center.x + nb.center.x) / 2, y: (pb.center.y + nb.center.y) / 2 };
    const w = this.board.rules.width(P.name, this.board.layerNames[P.layers[0]]);
    const env = w + gap / 2;
    const ring = (c: Pt, li: number): Pnt[] => { const out: Pnt[] = [{ ...c, li }]; for (let r = 0.4; r <= 5.01; r += 0.4) for (let k = 0; k < 16; k++) out.push({ x: c.x + Math.cos((k * Math.PI) / 8) * r * this.res, y: c.y + Math.sin((k * Math.PI) / 8) * r * this.res, li }); return out; };
    const layers = P.layers.filter((l) => N.layers.includes(l));
    // prefer the layer the pads are on
    layers.sort((a, c) => Number(!pa.layers.includes(a)) - Number(!pa.layers.includes(c)));
    for (const li of layers) {
      this.pairOwn = N.name; this.hwOverride = env;
      let r: ReturnType<ShapeRouter['search']> = null;
      try {
        const src = ring(Sa, li).filter((q) => this.segCheck(P.name, li, q, q, env, soft)), goal = ring(Sb, li).filter((q) => this.segCheck(P.name, li, q, q, env, soft));
        if (!src.length || !goal.length) continue;
        const all = [...src, ...goal], m = Math.max(3 * this.res, 0.3 * d(Sa, Sb));
        const win = { minX: Math.min(...all.map((q) => q.x)) - m, minY: Math.min(...all.map((q) => q.y)) - m, maxX: Math.max(...all.map((q) => q.x)) + m, maxY: Math.max(...all.map((q) => q.y)) + m };
        const saved = P.vias; P.vias = [];   // one layer: a pair carrier changes no layers
        try { r = this.search(P, src, goal, false, win, soft, 2); } finally { P.vias = saved; }
      } finally { this.pairOwn = null; this.hwOverride = null; }
      if (!r || r.path.length < 2) continue;
      const path = dedupe(r.path.map((q) => ({ x: q.x, y: q.y })));
      if (path.length < 2) continue;
      // which side is P: compare the pads' positions across the first carrier direction
      const d0 = { x: path[1].x - path[0].x, y: path[1].y - path[0].y };
      const side = d0.x * (pa.center.y - Sa.y) - d0.y * (pa.center.x - Sa.x) > 0 ? 1 : -1;
      const off = (w + gap) / 2;
      const lp = offsetPolyline(path, side * off).map((q) => ({ x: Math.round(q.x), y: Math.round(q.y) })), ln = offsetPolyline(path, -side * off).map((q) => ({ x: Math.round(q.x), y: Math.round(q.y) }));
      // both lanes must clear everything but each other (rounding may nick a corner)
      const ok = (net: string, pts: Pt[]) => pts.every((q, i) => i === 0 || this.segCheck(net, li, pts[i - 1], q, w / 2, soft, r!.blockers));
      if (!ok(P.name, lp) || !ok(N.name, ln)) continue;
      for (const cid of r.blockers) { const c = this.conns.get(cid); if (c) this.ripUp(c); }
      const layer = this.board.layerNames[li];
      this.commit(P.name, [{ layer, width: w, points: collinear(lp), net: P.name, type: 'route' }], []);
      this.commit(N.name, [{ layer, width: w, points: collinear(ln), net: N.name, type: 'route' }], []);
      this.stats.carriers = (this.stats.carriers ?? 0) + 1;
      return true;
    }
    return false;
  }

  /** Route everything: passes of island joining with negotiated rip-up. Returns true when complete. */
  route(): boolean {
    this.t0 = Date.now();
    const passes = this.opts.passes ?? 16;
    let todo = this.incomplete();
    const span = (n: NetInfo) => { const xs = n.terms.map((t) => t.center.x), ys = n.terms.map((t) => t.center.y); return xs.length ? Math.max(...xs) - Math.min(...xs) + Math.max(...ys) - Math.min(...ys) : 0; };
    for (let pass = 1; pass <= passes && todo.length; pass++) {
      this.pass = pass;
      todo.sort((a, c) => c.prio - a.prio || (this.history.get(c.name) ?? 0) - (this.history.get(a.name) ?? 0) || span(a) - span(c));
      // a pair's second net right after the first, so it can follow it
      for (let i = 0; i < todo.length; i++) { const pr = this.partner.get(todo[i].name); if (!pr) continue; const j = todo.findIndex((x) => x.name === pr.net); if (j > i + 1) { const [m] = todo.splice(j, 1); todo.splice(i + 1, 0, m); } }
      let failed = 0;
      // differential pairs first, each as one coupled carrier
      const tried = new Set<string>();
      for (const n of todo) {
        const pr = this.partner.get(n.name); if (!pr || tried.has(n.name)) continue;
        const m = this.nets.get(pr.net); if (!m) continue;
        tried.add(n.name); tried.add(pr.net);
        this.routeCarrier(n, m, pr.gap, pass > 1);
      }
      for (const n of todo) {
        if (this.opts.timeLimitMs && Date.now() - this.t0 > this.opts.timeLimitMs) break;
        for (let guard = 0; guard < 4 * n.terms.length + 4; guard++) {
          const isl = this.islands(n.name);
          const pr = this.nextPair(n, isl); if (!pr) break;
          if (!this.connect(n, pr[0], pr[1], pass > 1)) { failed++; break; }
        }
      }
      todo = this.incomplete();
      const conflicts = this.conflicts();
      this.log(`shape route pass ${pass}: ${todo.length} nets incomplete, ${this.unrouted()} connections open, ${conflicts} conflicts, ${this.stats.ripups} rip-ups, ${((Date.now() - this.t0) / 1000).toFixed(1)}s`);
      if (this.opts.timeLimitMs && Date.now() - this.t0 > this.opts.timeLimitMs) break;
      void failed;
    }
    this.stats.failed = todo.length;
    return todo.length === 0;
  }

  /** Open connections: islands - 1 summed over nets. */
  unrouted(): number { let n = 0; for (const x of this.nets.values()) n += Math.max(0, this.islands(x.name).length - 1); return n; }

  /** Clearance violations among routed copper (should stay 0: every edge is checked when placed). */
  conflicts(): number {
    let n = 0;
    for (const c of this.conns.values()) for (const it of c.items) {
      if (it.kind !== 'wire' || it.geom.type !== 'seg') continue;
      if (!this.segCheck(c.net, it.layer, it.geom.a, it.geom.b, it.geom.hw - 0.5, false)) n++;
    }
    return n;
  }

  routes(): SessionRoutes {
    const out: SessionRoutes = { resolution: { ...this.design.resolution }, nets: new Map(), padstacks: [] };
    for (const c of this.conns.values()) {
      const e = out.nets.get(c.net) ?? { wires: [], vias: [] };
      e.wires.push(...c.wires); e.vias.push(...c.vias);
      out.nets.set(c.net, e);
    }
    return out;
  }

  statusReport(): string {
    const open = this.unrouted();
    let vias = 0, len = 0;
    for (const c of this.conns.values()) { vias += c.vias.length; for (const w of c.wires) for (let i = 1; i < w.points.length; i++) len += Math.hypot(w.points[i].x - w.points[i - 1].x, w.points[i].y - w.points[i - 1].y); }
    return `shape-based router: ${this.nets.size} nets, ${open} connections open, ${vias} vias, wire length ${(len / this.res).toFixed(1)} mm, ${this.stats.searches} searches, ${this.stats.ripups} rip-ups`;
  }
}

/* ---------------------------------------------------------------- helpers */

function dirOf(dx: number, dy: number): number {
  const a = Math.atan2(dy, dx);
  return ((Math.round(a / (Math.PI / 4)) % 8) + 8) % 8;
}

function centerOf(g: Geometry): Pt {
  if (g.type === 'circle') return g.c;
  if (g.type === 'seg') return { x: (g.a.x + g.b.x) / 2, y: (g.a.y + g.b.y) / 2 };
  let x = 0, y = 0; for (const p of g.pts) { x += p.x; y += p.y; } return { x: x / g.pts.length, y: y / g.pts.length };
}

/** Corners of the octagon hull of a geometry grown by `need` (axis and diagonal support lines). */
function octagonCorners(g: Geometry, need: number, out: Pt[]): void {
  let pts: Pt[], r = need;
  if (g.type === 'circle') { pts = [g.c]; r += g.r; } else if (g.type === 'seg') { pts = [g.a, g.b]; r += g.hw; } else pts = g.pts;
  let A = Infinity, B = -Infinity, C = Infinity, D = -Infinity, S1 = Infinity, S2 = -Infinity, T1 = Infinity, T2 = -Infinity;
  for (const p of pts) { A = Math.min(A, p.x); B = Math.max(B, p.x); C = Math.min(C, p.y); D = Math.max(D, p.y); S1 = Math.min(S1, p.x + p.y); S2 = Math.max(S2, p.x + p.y); T1 = Math.min(T1, p.x - p.y); T2 = Math.max(T2, p.x - p.y); }
  // a little extra on the diagonals so the corner points are strictly outside
  A -= r; B += r; C -= r; D += r; S1 -= r * SQ2 * 1.0001; S2 += r * SQ2 * 1.0001; T1 -= r * SQ2 * 1.0001; T2 += r * SQ2 * 1.0001;
  out.push({ x: B, y: S2 - B }, { x: S2 - D, y: D }, { x: T1 + D, y: D }, { x: A, y: A - T1 }, { x: A, y: S1 - A }, { x: S1 - C, y: C }, { x: T2 + C, y: C }, { x: B, y: B - T2 });
}

function polyOfShape(s: Shape): Pt[] {
  if (s.kind === 'rect' && s.rect) { const r = s.rect; return [{ x: r.x1, y: r.y1 }, { x: r.x2, y: r.y1 }, { x: r.x2, y: r.y2 }, { x: r.x1, y: r.y2 }]; }
  if (s.kind === 'circle') { const c = s.center ?? { x: 0, y: 0 }, r = (s.diameter ?? 0) / 2; return Array.from({ length: 16 }, (_, i) => ({ x: c.x + r * Math.cos((i * Math.PI) / 8), y: c.y + r * Math.sin((i * Math.PI) / 8) })); }
  return (s.points ?? []).slice();
}

/** A polyline moved sideways by d (left of the direction of travel for d > 0), mitred at the corners. */
function offsetPolyline(pts: Pt[], d: number): Pt[] {
  const n = (a: Pt, b: Pt) => { const L = Math.hypot(b.x - a.x, b.y - a.y) || 1; return { x: -(b.y - a.y) / L, y: (b.x - a.x) / L }; };
  const out: Pt[] = [];
  for (let i = 0; i < pts.length; i++) {
    const n0 = i > 0 ? n(pts[i - 1], pts[i]) : n(pts[0], pts[1] ?? pts[0]);
    const n1 = i < pts.length - 1 ? n(pts[i], pts[i + 1]) : n0;
    let m = { x: n0.x + n1.x, y: n0.y + n1.y }; const L = Math.hypot(m.x, m.y) || 1; m = { x: m.x / L, y: m.y / L };
    const c = Math.max(0.35, m.x * n1.x + m.y * n1.y);
    out.push({ x: pts[i].x + (m.x * d) / c, y: pts[i].y + (m.y * d) / c });
  }
  return out;
}

function dedupe(pts: Pt[]): Pt[] { const out: Pt[] = []; for (const p of pts) { const q = out[out.length - 1]; if (!q || Math.abs(q.x - p.x) > 0.01 || Math.abs(q.y - p.y) > 0.01) out.push(p); } return out; }

function collinear(pts: Pt[]): Pt[] {
  if (pts.length < 3) return pts;
  const out = [pts[0]];
  for (let i = 1; i < pts.length - 1; i++) {
    const a = out[out.length - 1], b = pts[i], c = pts[i + 1];
    const cr = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x);
    const L = Math.hypot(b.x - a.x, b.y - a.y) * Math.hypot(c.x - b.x, c.y - b.y);
    if (L > 0 && Math.abs(cr) / L < 1e-6 && (b.x - a.x) * (c.x - b.x) + (b.y - a.y) * (c.y - b.y) > 0) continue;
    out.push(b);
  }
  out.push(pts[pts.length - 1]);
  return out;
}
