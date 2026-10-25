/**
 * Board = the Design expanded into concrete, absolutely-positioned copper and
 * keepout geometry per layer, with a spatial index. This is the "shape
 * database" that both the DRC and the router read.
 */
import { type Design, type Shape, type Placement, type Image, type Padstack, type Wire, type Via } from './model.js';
import { type Pt, type Box, emptyBox, extendBox, boxesOverlap, growBox, placeTransform, rotate, rectPoly, pointInPolygon } from './geom.js';
import { Rules, type ObjectType } from './rules.js';

export const ALL_LAYERS = -1;

export type Geometry =
  | { type: 'circle'; c: Pt; r: number }
  | { type: 'poly'; pts: Pt[] }
  | { type: 'seg'; a: Pt; b: Pt; hw: number };   // stadium (segment with half-width)

export interface Item {
  id: number;
  kind: 'pad' | 'via' | 'wire' | 'keepout' | 'via_keepout' | 'wire_keepout' | 'plane';
  objType: ObjectType;
  net: string | undefined;        // undefined = no net (keepouts)
  layer: number;                  // layer index or ALL_LAYERS
  geom: Geometry;
  bbox: Box;
  /** for pads: "REF-PIN"; for wires/vias: origin tag */
  ref?: string;
  fixed: boolean;
  /** query stamp (internal: de-duplicates items spanning several index cells) */
  qs?: number;
}

export interface PinTerminal {
  ref: string;            // "U1-3"
  net: string;
  center: Pt;
  layers: number[];       // layer indices with copper (1 for SMD, all for through-hole)
  items: Item[];          // pad items (one per layer)
  isSmd: boolean;
  rotation: number;
}

export class SpatialIndex {
  private cells = new Map<number, number[]>();
  constructor(private readonly cell: number) {}
  private key(cx: number, cy: number): number { return (cx + 1_000_000) * 4_000_003 + (cy + 1_000_000); }
  insert(id: number, b: Box): void {
    const x0 = Math.floor(b.minX / this.cell), x1 = Math.floor(b.maxX / this.cell);
    const y0 = Math.floor(b.minY / this.cell), y1 = Math.floor(b.maxY / this.cell);
    for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) {
      const k = this.key(x, y);
      let a = this.cells.get(k); if (!a) { a = []; this.cells.set(k, a); }
      a.push(id);
    }
  }
  remove(id: number, b: Box): void {
    const x0 = Math.floor(b.minX / this.cell), x1 = Math.floor(b.maxX / this.cell);
    const y0 = Math.floor(b.minY / this.cell), y1 = Math.floor(b.maxY / this.cell);
    for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) {
      const a = this.cells.get(this.key(x, y));
      if (!a) continue;
      const i = a.indexOf(id); if (i >= 0) a.splice(i, 1);
    }
  }
  query(b: Box, out: Set<number>): void {
    const x0 = Math.floor(b.minX / this.cell), x1 = Math.floor(b.maxX / this.cell);
    const y0 = Math.floor(b.minY / this.cell), y1 = Math.floor(b.maxY / this.cell);
    for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) {
      const a = this.cells.get(this.key(x, y));
      if (a) for (const id of a) out.add(id);
    }
  }
}

export class Board {
  readonly rules: Rules;
  readonly items: Item[] = [];
  readonly terminals: PinTerminal[] = [];
  readonly terminalByRef = new Map<string, PinTerminal>();
  readonly signalLayers: number[] = [];
  readonly layerNames: string[];
  readonly boundary: Pt[];       // outline polygon (resolution units)
  readonly bbox: Box;
  readonly index: SpatialIndex;
  private nextId = 1;
  private readonly byId = new Map<number, Item>();
  private readonly grid = new Map<number, Item[]>();
  private gcell = 1;
  private stamp = 0;
  private readonly pos = new Map<number, number>();   // item id -> index in items

  constructor(readonly design: Design) {
    this.rules = new Rules(design);
    this.layerNames = design.structure.layers.map((l) => l.name);
    design.structure.layers.forEach((l) => { if (l.type === 'signal' || l.type === 'mixed' || l.type === 'jumper') this.signalLayers.push(l.index); });
    this.boundary = boundaryPolygon(design);
    const bb = emptyBox();
    for (const p of this.boundary) extendBox(bb, p.x, p.y);
    this.bbox = bb;
    const span = Math.max(bb.maxX - bb.minX, bb.maxY - bb.minY, 1);
    this.index = new SpatialIndex(Math.max(1, Math.round(span / 64)));
    this.gcell = Math.max(1, span / 160);
    this.build();
  }

  layerIndex(name: string): number {
    const i = this.layerNames.indexOf(name);
    return i;
  }

  /** Expand a layer reference used by padstack/keepout shapes into concrete layer indices. */
  layersFor(ref: string, side: 'front' | 'back' = 'front'): number[] {
    const r = ref.toLowerCase();
    const all = this.design.structure.layers.map((l) => l.index);
    if (r === 'pcb' || r === 'all') return all;
    if (r === 'signal') return this.design.structure.layers.filter((l) => l.type === 'signal' || l.type === 'mixed').map((l) => l.index);
    if (r === 'power') return this.design.structure.layers.filter((l) => l.type === 'power').map((l) => l.index);
    const i = this.layerIndex(ref);
    if (i < 0) return [];
    if (side === 'back') return [all.length - 1 - i];   // mirrored stack for back-side images
    return [i];
  }

  private add(partial: Omit<Item, 'id' | 'bbox'>): Item {
    const bbox = geomBox(partial.geom);
    const item: Item = { ...partial, id: this.nextId++, bbox };
    this.pos.set(item.id, this.items.length);
    this.items.push(item);
    this.byId.set(item.id, item);
    this.gridEach(bbox, (k) => { const a = this.grid.get(k); if (a) a.push(item); else this.grid.set(k, [item]); });
    return item;
  }

  addWire(w: Wire, fixed = false): Item[] {
    const li = this.layerIndex(w.layer);
    const out: Item[] = [];
    for (let i = 0; i + 1 < w.points.length; i++) {
      out.push(this.add({ kind: 'wire', objType: 'wire', net: w.net, layer: li, geom: { type: 'seg', a: w.points[i], b: w.points[i + 1], hw: w.width / 2 }, fixed }));
    }
    if (w.points.length === 1) out.push(this.add({ kind: 'wire', objType: 'wire', net: w.net, layer: li, geom: { type: 'circle', c: w.points[0], r: w.width / 2 }, fixed }));
    return out;
  }

  addVia(v: Via, fixed = false): Item[] {
    const ps = this.design.library.padstacks.get(v.padstack);
    const out: Item[] = [];
    if (!ps) return out;
    for (const s of ps.shapes) {
      for (const li of this.layersFor(s.layer)) {
        out.push(this.add({ kind: 'via', objType: 'via', net: v.net, layer: li, geom: shapeToGeom(s, v.at, 0, false), fixed, ref: v.padstack }));
      }
    }
    return out;
  }

  removeItem(item: Item): void {
    const i = this.pos.get(item.id);
    if (i === undefined) return;
    // swap-remove: O(1), item order is not meaningful
    const last = this.items[this.items.length - 1];
    this.items[i] = last; this.pos.set(last.id, i);
    this.items.pop(); this.pos.delete(item.id); this.byId.delete(item.id);
    this.gridEach(item.bbox, (k) => { const a = this.grid.get(k); if (!a) return; const j = a.indexOf(item); if (j >= 0) { a[j] = a[a.length - 1]; a.pop(); } });
  }

  private gridEach(b: Box, f: (k: number) => void): void {
    const c = this.gcell;
    const x0 = Math.floor(b.minX / c), x1 = Math.floor(b.maxX / c), y0 = Math.floor(b.minY / c), y1 = Math.floor(b.maxY / c);
    for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) f((x + 100_000) * 400_009 + (y + 100_000));
  }

  /** Items whose bbox intersects `b` (optionally restricted to a layer). */
  query(b: Box, layer?: number): Item[] {
    const s = ++this.stamp;
    const out: Item[] = [];
    const c = this.gcell;
    const x0 = Math.floor(b.minX / c), x1 = Math.floor(b.maxX / c), y0 = Math.floor(b.minY / c), y1 = Math.floor(b.maxY / c);
    for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) {
      const a = this.grid.get((x + 100_000) * 400_009 + (y + 100_000));
      if (!a) continue;
      for (let i = 0; i < a.length; i++) {
        const it = a[i];
        if (it.qs === s) continue;
        it.qs = s;
        if (layer !== undefined && it.layer !== ALL_LAYERS && it.layer !== layer) continue;
        if (it.bbox.maxX >= b.minX && it.bbox.minX <= b.maxX && it.bbox.maxY >= b.minY && it.bbox.minY <= b.maxY) out.push(it);
      }
    }
    return out;
  }

  private build(): void {
    const d = this.design;
    // pads
    for (const pl of d.placement) {
      const img = d.library.images.get(pl.image);
      if (!img) continue;
      this.placeImage(pl, img);
    }
    // keepouts (structure level)
    for (const k of d.structure.keepouts) {
      for (const li of this.layersFor(k.shape.layer)) {
        this.add({ kind: k.kind === 'place_keepout' ? 'keepout' : k.kind, objType: 'area', net: undefined, layer: li, geom: shapeToGeom(k.shape, { x: 0, y: 0 }, 0, false), fixed: true });
      }
    }
    // planes: copper areas of a net
    for (const p of d.structure.planes) {
      for (const li of this.layersFor(p.shape.layer)) this.add({ kind: 'plane', objType: 'area', net: p.net, layer: li, geom: shapeToGeom(p.shape, { x: 0, y: 0 }, 0, false), fixed: true });
    }
    // pre-existing wiring
    for (const w of d.wiring.wires) this.addWire(w, w.type === 'fix' || w.type === 'protect' || w.type === undefined);
    for (const v of d.wiring.vias) this.addVia(v, v.type === 'fix' || v.type === 'protect' || v.type === undefined);
  }

  private placeImage(pl: Placement, img: Image): void {
    const d = this.design;
    const back = pl.side === 'back';
    const netOfPin = new Map<string, string>();
    for (const n of d.network.nets.values()) for (const p of n.pins) netOfPin.set(p, n.name);
    for (const pin of img.pins) {
      const ps: Padstack | undefined = d.library.padstacks.get(pin.padstack);
      if (!ps) continue;
      const ref = `${pl.ref}-${pin.pinId}`;
      const net = netOfPin.get(ref);
      const center = placeTransform(pin.at, pl.at, pl.rotation, back);
      const rot = (back ? -pin.rotation : pin.rotation) + pl.rotation;
      const layersUsed = new Set<number>();
      const items: Item[] = [];
      for (const s of ps.shapes) {
        for (const li of this.layersFor(s.layer, pl.side)) {
          layersUsed.add(li);
          const geom = shapeToGeom(s, center, rot, back);
          items.push(this.add({ kind: 'pad', objType: 'pin', net, layer: li, geom, fixed: true, ref }));
        }
      }
      const layers = [...layersUsed].sort((a, b) => a - b);
      const isSmd = layers.length < d.structure.layers.length;
      for (const it of items) if (isSmd) it.objType = 'smd';
      const term: PinTerminal = { ref, net: net ?? '', center, layers, items, isSmd, rotation: rot };
      this.terminals.push(term);
      this.terminalByRef.set(ref, term);
    }
    for (const k of img.keepouts) {
      for (const li of this.layersFor(k.shape.layer, pl.side)) {
        this.add({ kind: k.kind === 'place_keepout' ? 'keepout' : k.kind, objType: 'area', net: undefined, layer: li, geom: shapeToGeom(k.shape, pl.at, pl.rotation, back), fixed: true });
      }
    }
  }
}

export function boundaryPolygon(d: Design): Pt[] {
  // Prefer a 'pcb' boundary; fall back to any.
  const b = d.structure.boundary.find((x) => x.shape.layer.toLowerCase() === 'pcb') ?? d.structure.boundary[0];
  if (!b) return [];
  const s = b.shape;
  if (s.kind === 'rect' && s.rect) return rectPoly(s.rect.x1, s.rect.y1, s.rect.x2, s.rect.y2);
  if (s.points) {
    const pts = s.points.slice();
    if (pts.length > 1 && pts[0].x === pts[pts.length - 1].x && pts[0].y === pts[pts.length - 1].y) pts.pop();
    return pts;
  }
  return [];
}

/** Convert a padstack/keepout shape (local coordinates) to absolute geometry. */
export function shapeToGeom(s: Shape, origin: Pt, rotDeg: number, mirror: boolean): Geometry {
  const tf = (p: Pt): Pt => {
    const m = mirror ? { x: -p.x, y: p.y } : p;
    const r = rotate(m, rotDeg);
    return { x: origin.x + r.x, y: origin.y + r.y };
  };
  switch (s.kind) {
    case 'circle': return { type: 'circle', c: tf(s.center ?? { x: 0, y: 0 }), r: (s.diameter ?? 0) / 2 };
    case 'rect': { const r = s.rect!; return { type: 'poly', pts: rectPoly(r.x1, r.y1, r.x2, r.y2).map(tf) }; }
    case 'polygon': return { type: 'poly', pts: (s.points ?? []).map(tf) };
    case 'path': {
      const pts = (s.points ?? []).map(tf);
      const hw = (s.width ?? 0) / 2;
      if (pts.length === 1) return { type: 'circle', c: pts[0], r: hw };
      if (pts.length === 2) return { type: 'seg', a: pts[0], b: pts[1], hw };
      // multi-point path: approximate with polygon of the centreline when width is 0, else first segment stadium
      if (hw === 0) return { type: 'poly', pts };
      return { type: 'seg', a: pts[0], b: pts[pts.length - 1], hw };
    }
  }
}

export function geomBox(g: Geometry): Box {
  switch (g.type) {
    case 'circle': return { minX: g.c.x - g.r, minY: g.c.y - g.r, maxX: g.c.x + g.r, maxY: g.c.y + g.r };
    case 'poly': { const b = emptyBox(); for (const p of g.pts) extendBox(b, p.x, p.y); return b; }
    case 'seg': return growBox({ minX: Math.min(g.a.x, g.b.x), minY: Math.min(g.a.y, g.b.y), maxX: Math.max(g.a.x, g.b.x), maxY: Math.max(g.a.y, g.b.y) }, g.hw);
  }
}

export function geomContains(g: Geometry, p: Pt): boolean {
  switch (g.type) {
    case 'circle': return Math.hypot(p.x - g.c.x, p.y - g.c.y) <= g.r;
    case 'poly': return pointInPolygon(p, g.pts);
    case 'seg': return distPtSegFast(p, g.a, g.b) <= g.hw;
  }
}

function distPtSegFast(p: Pt, a: Pt, b: Pt): number {
  const dx = b.x - a.x, dy = b.y - a.y;
  const l2 = dx * dx + dy * dy;
  let t = l2 > 0 ? ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return Math.hypot(p.x - (a.x + dx * t), p.y - (a.y + dy * t));
}
