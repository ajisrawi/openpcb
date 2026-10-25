/** Parametric footprint generators (mm). */
import type { Footprint, Pad, Pt } from './model.js';

const rectOutline = (w: number, h: number): Pt[][] => [[{ x: -w / 2, y: -h / 2 }, { x: w / 2, y: -h / 2 }, { x: w / 2, y: h / 2 }, { x: -w / 2, y: h / 2 }, { x: -w / 2, y: -h / 2 }]];

export function chip(name: string, pitch: number, padW: number, padH: number, bodyW: number, bodyH: number): Footprint {
  const y = padH / 2 + 0.3, x = Math.max(0.2, pitch / 2 - padW / 2 - 0.3);
  const outline: Pt[][] = x > 0.25 ? [[{ x: -x, y }, { x, y }], [{ x: -x, y: -y }, { x, y: -y }]] : [];
  return { name, body: { w: bodyW, h: bodyH }, outline, pads: [
    { id: '1', x: -pitch / 2, y: 0, w: padW, h: padH, shape: 'rect', th: false },
    { id: '2', x: pitch / 2, y: 0, w: padW, h: padH, shape: 'rect', th: false },
  ] };
}

export function soic(n: number, pitch = 1.27, rowSpacing = 5.4, padW = 0.6, padH = 1.8): Footprint {
  const per = n / 2; const pads: Pad[] = [];
  for (let i = 0; i < per; i++) pads.push({ id: String(i + 1), x: -((per - 1) * pitch) / 2 + i * pitch, y: rowSpacing / 2, w: padW, h: padH, shape: 'rect', th: false });
  for (let i = 0; i < per; i++) pads.push({ id: String(per + i + 1), x: ((per - 1) * pitch) / 2 - i * pitch, y: -rowSpacing / 2, w: padW, h: padH, shape: 'rect', th: false });
  const w = per * pitch + 0.5, h = rowSpacing - padH - 0.6;
  return { name: `SOIC-${n}`, body: { w, h }, outline: rectOutline(w, h), pads };
}

export function dip(n: number, pitch = 2.54, rowSpacing = 7.62): Footprint {
  const per = n / 2; const pads: Pad[] = [];
  for (let i = 0; i < per; i++) pads.push({ id: String(i + 1), x: -((per - 1) * pitch) / 2 + i * pitch, y: rowSpacing / 2, w: 1.6, h: 1.6, shape: i === 0 ? 'rect' : 'circle', th: true, drill: 0.8 });
  for (let i = 0; i < per; i++) pads.push({ id: String(per + i + 1), x: ((per - 1) * pitch) / 2 - i * pitch, y: -rowSpacing / 2, w: 1.6, h: 1.6, shape: 'circle', th: true, drill: 0.8 });
  const w = per * pitch + 1, h = rowSpacing - 2.6;
  return { name: `DIP-${n}`, body: { w, h }, outline: rectOutline(w, h), pads };
}

export function qfp(n: number, pitch = 0.8, bodySize = 10, padW = 0.45, padH = 1.5): Footprint {
  const per = n / 4; const pads: Pad[] = [];
  const span = (per - 1) * pitch;
  const off = bodySize / 2 + padH / 2 - 0.2;
  let id = 1;
  for (let i = 0; i < per; i++) pads.push({ id: String(id++), x: -off, y: -span / 2 + i * pitch, w: padH, h: padW, shape: 'rect', th: false });   // left, top to bottom
  for (let i = 0; i < per; i++) pads.push({ id: String(id++), x: -span / 2 + i * pitch, y: off, w: padW, h: padH, shape: 'rect', th: false });    // bottom
  for (let i = 0; i < per; i++) pads.push({ id: String(id++), x: off, y: span / 2 - i * pitch, w: padH, h: padW, shape: 'rect', th: false });     // right
  for (let i = 0; i < per; i++) pads.push({ id: String(id++), x: span / 2 - i * pitch, y: -off, w: padW, h: padH, shape: 'rect', th: false });   // top
  const silk = bodySize - 1.2;   // keep the silk square clear of the pad ends
  return { name: `QFP-${n}`, body: { w: bodySize, h: bodySize }, outline: rectOutline(silk, silk), pads };
}

export function sot23(): Footprint {
  return { name: 'SOT-23', body: { w: 3, h: 1.4 }, outline: rectOutline(3, 0.8), pads: [
    { id: '1', x: -0.95, y: 1.1, w: 0.8, h: 0.9, shape: 'rect', th: false },
    { id: '2', x: 0.95, y: 1.1, w: 0.8, h: 0.9, shape: 'rect', th: false },
    { id: '3', x: 0, y: -1.1, w: 0.8, h: 0.9, shape: 'rect', th: false },
  ] };
}

export function header(rows: number, cols: number, pitch = 2.54): Footprint {
  const pads: Pad[] = []; let id = 1;
  for (let c = 0; c < cols; c++) for (let r = 0; r < rows; r++) pads.push({ id: String(id++), x: (r - (rows - 1) / 2) * pitch, y: (c - (cols - 1) / 2) * pitch, w: 1.7, h: 1.7, shape: id === 2 ? 'rect' : 'circle', th: true, drill: 1.0 });
  const w = rows * pitch, h = cols * pitch;
  return { name: `Header_${rows}x${cols}`, body: { w, h }, outline: rectOutline(w, h), pads };
}

export function mountingHole(d = 3.2, ring = 6): Footprint {
  return { name: `Hole_${d}mm`, body: { w: ring, h: ring }, outline: [], pads: [{ id: '1', x: 0, y: 0, w: ring, h: ring, shape: 'circle', th: true, drill: d }] };
}

export function bga(n: number, pitch = 1.0, ball = 0.5): Footprint {
  const side = Math.round(Math.sqrt(n)); const pads: Pad[] = [];
  const letters = 'ABCDEFGHJKLMNPRTUVWY';
  for (let r = 0; r < side; r++) for (let c = 0; c < side; c++) pads.push({ id: `${letters[r] ?? r}${c + 1}`, x: (c - (side - 1) / 2) * pitch, y: ((side - 1) / 2 - r) * pitch, w: ball, h: ball, shape: 'circle', th: false });
  const s = side * pitch + 1;
  return { name: `BGA-${side * side}`, body: { w: s, h: s }, outline: rectOutline(s, s), pads };
}

export function defaultLibrary(): Record<string, Footprint> {
  const list: Footprint[] = [
    chip('C_0402', 1.0, 0.6, 0.7, 1.6, 0.9), chip('R_0603', 1.6, 0.9, 1.0, 2.6, 1.3), chip('R_0805', 2.0, 1.0, 1.3, 3.2, 1.6), chip('C_1206', 3.0, 1.2, 1.8, 4.4, 2.0),
    sot23(), soic(8), soic(14), soic(16), dip(8), dip(14), dip(16), qfp(32, 0.8, 7), qfp(44, 0.8, 10), qfp(64, 0.5, 10, 0.27, 1.5), bga(36, 1.0), header(1, 4), header(1, 6), header(2, 5), mountingHole(),
  ];
  const out: Record<string, Footprint> = {};
  for (const f of list) out[f.name] = f;
  return out;
}
