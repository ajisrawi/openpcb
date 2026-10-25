/**
 * Synthetic test boards: generates a complete Design with footprints, random
 * placement and a netlist, used by the tests and the editor's "new demo board".
 */
import { type Design, emptyDesign, emptyRuleSet } from './model.js';

export interface SynthOptions {
  width?: number;          // mm
  height?: number;         // mm
  layers?: number;         // 2 or 4
  chips?: number;          // number of SOIC/QFP parts
  passives?: number;       // 0603 parts
  nets?: number;           // number of signal nets
  pinsPerNet?: number;
  seed?: number;
  resolutionPerMm?: number;
  blindVias?: boolean;     // 4 layers: add Via[0-1], Via[2-3] microvias and a Via[1-2] buried via
}

export function makeSyntheticDesign(o: SynthOptions = {}): Design {
  const W = o.width ?? 60, H = o.height ?? 40, L = o.layers ?? 2;
  const RES = o.resolutionPerMm ?? 1000;   // 1 um
  const mm = (v: number) => Math.round(v * RES);
  let seed = o.seed ?? 1;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  const d = emptyDesign('synthetic');
  d.resolution = { unit: 'um', value: RES / 1000 };
  d.unit = 'um';
  // layers
  const names = L === 4 ? ['F.Cu', 'In1.Cu', 'In2.Cu', 'B.Cu'] : ['F.Cu', 'B.Cu'];
  names.forEach((n, i) => d.structure.layers.push({ name: n, type: 'signal', direction: i % 2 === 0 ? 'horizontal' : 'vertical', index: i }));
  d.structure.boundary.push({ shape: { kind: 'rect', layer: 'pcb', rect: { x1: 0, y1: 0, x2: mm(W), y2: mm(H) } } });
  d.structure.rule = emptyRuleSet();
  d.structure.rule.width = mm(0.25);
  d.structure.rule.clearance.set('default', mm(0.2));
  d.structure.rule.clearance.set('wire_wire', mm(0.2));
  const through = `Via[0-${names.length - 1}]_800:400_um`;
  d.structure.vias.push(through);
  d.library.padstacks.set(through, { name: through, shapes: names.map((n) => ({ kind: 'circle', layer: n, diameter: mm(0.8), center: { x: 0, y: 0 } })), attach: false });
  if (o.blindVias && L === 4) {
    const add = (b0: number, b1: number, dia: number, drill: number) => {
      const nm = `Via[${b0}-${b1}]_${dia * 1000}:${drill * 1000}_um`;
      d.structure.vias.push(nm);
      d.library.padstacks.set(nm, { name: nm, shapes: names.slice(b0, b1 + 1).map((n) => ({ kind: 'circle', layer: n, diameter: mm(dia), center: { x: 0, y: 0 } })), attach: false });
    };
    add(0, 1, 0.4, 0.2); add(2, 3, 0.4, 0.2); add(1, 2, 0.6, 0.3);
  }
  // padstacks
  d.library.padstacks.set('Rect[T]Pad_1000x1500_um', { name: 'Rect[T]Pad_1000x1500_um', shapes: [{ kind: 'rect', layer: 'F.Cu', rect: { x1: mm(-0.5), y1: mm(-0.75), x2: mm(0.5), y2: mm(0.75) } }], attach: true });
  d.library.padstacks.set('Rect[T]Pad_600x1800_um', { name: 'Rect[T]Pad_600x1800_um', shapes: [{ kind: 'rect', layer: 'F.Cu', rect: { x1: mm(-0.3), y1: mm(-0.9), x2: mm(0.3), y2: mm(0.9) } }], attach: true });
  d.library.padstacks.set('Round[A]Pad_1600_um', { name: 'Round[A]Pad_1600_um', shapes: names.map((n) => ({ kind: 'circle', layer: n, diameter: mm(1.6), center: { x: 0, y: 0 } })), attach: true });
  // images
  d.library.images.set('R_0603', { name: 'R_0603', outline: [{ kind: 'path', layer: 'signal', width: 0, points: [{ x: mm(-1.4), y: mm(-0.8) }, { x: mm(1.4), y: mm(-0.8) }, { x: mm(1.4), y: mm(0.8) }, { x: mm(-1.4), y: mm(0.8) }, { x: mm(-1.4), y: mm(-0.8) }] }],
    pins: [{ padstack: 'Rect[T]Pad_1000x1500_um', pinId: '1', at: { x: mm(-0.8), y: 0 }, rotation: 0 }, { padstack: 'Rect[T]Pad_1000x1500_um', pinId: '2', at: { x: mm(0.8), y: 0 }, rotation: 0 }], keepouts: [] });
  const soic = (n: number) => {
    const pins = [];
    const perSide = n / 2;
    for (let i = 0; i < perSide; i++) pins.push({ padstack: 'Rect[T]Pad_600x1800_um', pinId: String(i + 1), at: { x: mm(-((perSide - 1) * 1.27) / 2 + i * 1.27), y: mm(-2.7) }, rotation: 0 });
    for (let i = 0; i < perSide; i++) pins.push({ padstack: 'Rect[T]Pad_600x1800_um', pinId: String(perSide + i + 1), at: { x: mm(((perSide - 1) * 1.27) / 2 - i * 1.27), y: mm(2.7) }, rotation: 0 });
    const w = (perSide + 1) * 1.27 / 2;
    return { name: `SOIC-${n}`, outline: [{ kind: 'path' as const, layer: 'signal', width: 0, points: [{ x: mm(-w), y: mm(-2) }, { x: mm(w), y: mm(-2) }, { x: mm(w), y: mm(2) }, { x: mm(-w), y: mm(2) }, { x: mm(-w), y: mm(-2) }] }], pins, keepouts: [] };
  };
  d.library.images.set('SOIC-16', soic(16));
  d.library.images.set('SOIC-8', soic(8));
  const header = (n: number) => ({ name: `PinHeader_1x${n}`, outline: [{ kind: 'path' as const, layer: 'signal', width: 0, points: [{ x: mm(-1.27), y: mm(-1.27) }, { x: mm(1.27), y: mm(-1.27) }, { x: mm(1.27), y: mm((n - 1) * 2.54 + 1.27) }, { x: mm(-1.27), y: mm((n - 1) * 2.54 + 1.27) }, { x: mm(-1.27), y: mm(-1.27) }] }],
    pins: Array.from({ length: n }, (_, i) => ({ padstack: 'Round[A]Pad_1600_um', pinId: String(i + 1), at: { x: 0, y: mm(i * 2.54) }, rotation: 0 })), keepouts: [] });
  d.library.images.set('PinHeader_1x6', header(6));
  // placement
  const chips = o.chips ?? 3, passives = o.passives ?? 8;
  let ref = 1;
  const placed: { ref: string; image: string; pins: string[] }[] = [];
  const bodies: { x: number; y: number; w: number; h: number }[] = [];
  const bodyOf = (image: string, rot: number) => { const img = d.library.images.get(image)!; let w = 0, h = 0; for (const p of img.pins) { w = Math.max(w, Math.abs(p.at.x) * 2 + mm(2)); h = Math.max(h, Math.abs(p.at.y) * 2 + mm(2)); } return rot % 180 === 90 ? { w: h + mm(1), h: w + mm(1) } : { w: w + mm(1), h: h + mm(1) }; };
  const place = (image: string, x: number, y: number, rot: number, prefix: string) => {
    // keep parts from overlapping (random placement): nudge until the body is clear
    const b = bodyOf(image, rot);
    for (let tries = 0; tries < 60; tries++) {
      const px = mm(x), py = mm(y);
      const hit = bodies.some((o) => Math.abs(o.x - px) < (o.w + b.w) / 2 && Math.abs(o.y - py) < (o.h + b.h) / 2);
      const inside = px - b.w / 2 > mm(1) && py - b.h / 2 > mm(1) && px + b.w / 2 < mm(W - 1) && py + b.h / 2 < mm(H - 1);
      if (!hit && inside) break;
      x = 4 + rnd() * (W - 8); y = 4 + rnd() * (H - 8);
    }
    bodies.push({ x: mm(x), y: mm(y), w: b.w, h: b.h });
    const r = `${prefix}${ref++}`;
    d.placement.push({ image, ref: r, at: { x: mm(x), y: mm(y) }, side: 'front', rotation: rot, locked: false });
    placed.push({ ref: r, image, pins: d.library.images.get(image)!.pins.map((p) => `${r}-${p.pinId}`) });
  };
  for (let i = 0; i < chips; i++) place(i % 2 === 0 ? 'SOIC-16' : 'SOIC-8', 12 + (i % 3) * 18 + rnd() * 4, 10 + Math.floor(i / 3) * 16 + rnd() * 4, Math.floor(rnd() * 4) * 90, 'U');
  for (let i = 0; i < passives; i++) place('R_0603', 6 + rnd() * (W - 12), 6 + rnd() * (H - 12), Math.floor(rnd() * 2) * 90, 'R');
  place('PinHeader_1x6', 4, H / 2 - 6, 0, 'J');
  // nets: connect random pins
  const allPins = placed.flatMap((p) => p.pins);
  const used = new Set<string>();
  const nNets = o.nets ?? Math.max(4, Math.floor(allPins.length / 3));
  const ppn = o.pinsPerNet ?? 2;
  for (let n = 0; n < nNets; n++) {
    const pins: string[] = [];
    let tries = 0;
    while (pins.length < ppn && tries++ < 50) {
      const p = allPins[Math.floor(rnd() * allPins.length)];
      if (used.has(p)) continue;
      const comp = p.split('-')[0];
      if (pins.some((q) => q.split('-')[0] === comp)) continue;
      used.add(p); pins.push(p);
    }
    if (pins.length >= 2) d.network.nets.set(`N${n + 1}`, { name: `N${n + 1}`, pins });
  }
  return d;
}

/**
 * A BGA escape test board: an n x n BGA (default 8 x 8, 0.8 mm pitch, 0.4 mm balls) in the middle of a 4-layer
 * board, each ball wired to its own 0402 resistor placed in a ring around it (the resistor's other pin goes to a
 * second ring resistor so every net has two pins). Optional blind vias (F.Cu..In1.Cu, In2.Cu..B.Cu).
 */
export function makeBgaDesign(o: { n?: number; pitch?: number; blind?: boolean } = {}): Design {
  const n = o.n ?? 8, pitch = o.pitch ?? 0.8;
  const RES = 1000; const mm = (v: number) => Math.round(v * RES);
  const d = emptyDesign('bga');
  d.resolution = { unit: 'um', value: 1 }; d.unit = 'um';
  const names = ['F.Cu', 'In1.Cu', 'In2.Cu', 'B.Cu'];
  names.forEach((nm, i) => d.structure.layers.push({ name: nm, type: 'signal', direction: i % 2 === 0 ? 'horizontal' : 'vertical', index: i }));
  const W = 40;
  d.structure.boundary.push({ shape: { kind: 'rect', layer: 'pcb', rect: { x1: 0, y1: 0, x2: mm(W), y2: mm(W) } } });
  d.structure.rule = emptyRuleSet();
  d.structure.rule.width = mm(0.1);
  d.structure.rule.clearance.set('default', mm(0.1));
  const via = (b0: number, b1: number, dia: number) => { const nm = `Via[${b0}-${b1}]_${Math.round(dia * 1000)}_um`; d.structure.vias.push(nm); d.library.padstacks.set(nm, { name: nm, shapes: names.slice(b0, b1 + 1).map((l) => ({ kind: 'circle' as const, layer: l, diameter: mm(dia), center: { x: 0, y: 0 } })), attach: false }); };
  via(0, 3, 0.45);
  if (o.blind) { via(0, 1, 0.3); via(2, 3, 0.3); }
  d.library.padstacks.set('Ball', { name: 'Ball', shapes: [{ kind: 'circle', layer: 'F.Cu', diameter: mm(0.4), center: { x: 0, y: 0 } }], attach: false });
  d.library.padstacks.set('R0402', { name: 'R0402', shapes: [{ kind: 'rect', layer: 'F.Cu', rect: { x1: mm(-0.25), y1: mm(-0.25), x2: mm(0.25), y2: mm(0.25) } }], attach: false });
  const balls = [];
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) balls.push({ padstack: 'Ball', pinId: `${String.fromCharCode(65 + r)}${c + 1}`, at: { x: mm((c - (n - 1) / 2) * pitch), y: mm(((n - 1) / 2 - r) * pitch) }, rotation: 0 });
  const half = ((n - 1) / 2) * pitch + 0.6;
  d.library.images.set('BGA', { name: 'BGA', outline: [], pins: balls, keepouts: [] });
  d.library.images.set('R', { name: 'R', outline: [], pins: [{ padstack: 'R0402', pinId: '1', at: { x: mm(-0.5), y: 0 }, rotation: 0 }, { padstack: 'R0402', pinId: '2', at: { x: mm(0.5), y: 0 }, rotation: 0 }], keepouts: [] });
  const cx = W / 2;
  d.placement.push({ image: 'BGA', ref: 'U1', at: { x: mm(cx), y: mm(cx) }, side: 'front', rotation: 0, locked: true });
  // resistors on a square ring 4 mm outside the ball field, evenly spread
  // keep 1.5 mm clear at each corner so resistors of adjacent sides never collide
  const ring = half + 4, per = Math.ceil(balls.length / 4), step = (2 * ring - 3) / per;
  balls.forEach((bl, i) => {
    const side = Math.floor(i / per), k = i % per, t = -ring + 1.5 + (k + 0.5) * step;
    const pos = side === 0 ? { x: t, y: ring } : side === 1 ? { x: ring, y: -t } : side === 2 ? { x: -t, y: -ring } : { x: -ring, y: t };
    const rot = side % 2 === 0 ? 90 : 0;
    d.placement.push({ image: 'R', ref: `R${i + 1}`, at: { x: mm(cx + pos.x), y: mm(cx + pos.y) }, side: 'front', rotation: rot, locked: true });
    d.network.nets.set(`N${i + 1}`, { name: `N${i + 1}`, pins: [`U1-${bl.pinId}`, `R${i + 1}-1`] });
  });
  return d;
}
