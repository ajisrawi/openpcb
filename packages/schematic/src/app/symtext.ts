/**
 * Symbol editor text forms (one pin / one graphic per line) and the box-symbol generator ("New Part from
 * spreadsheet" in Capture): pins listed as `number name type side` become a rectangle with pins on its sides.
 */
import type { SymPin, Graphic, PinType, Orient, SymbolView } from '../model.js';

const TYPES: PinType[] = ['input', 'output', 'bidirectional', 'tristate', 'passive', 'power', 'open_collector', 'open_emitter', 'unspecified', 'no_connect'];
const tok = (s: string) => s.replace(/\s+/g, '_');

export function pinsToText(pins: SymPin[]): string {
  return pins.map((p) => [p.number || '-', tok(p.name || '~'), p.type, p.x, p.y, p.length, p.orient, p.shape ?? 'line', p.hidden ? `hidden${p.net ? ':' + p.net : ''}` : ''].join(' ').trim()).join('\n');
}

export function textToPins(t: string): SymPin[] {
  const out: SymPin[] = [];
  for (const raw of t.split('\n')) {
    const l = raw.trim(); if (!l || l.startsWith('#')) continue;
    const f = l.split(/\s+/);
    if (f.length < 7) throw new Error(`pin line needs: number name type x y length orient — "${l}"`);
    const type = TYPES.includes(f[2] as PinType) ? (f[2] as PinType) : 'passive';
    const orient = (['left', 'right', 'up', 'down'].includes(f[6]) ? f[6] : 'left') as Orient;
    const hid = f.slice(7).find((x) => x.startsWith('hidden'));
    const shape = (f[7] && !f[7].startsWith('hidden') ? f[7] : 'line') as SymPin['shape'];
    out.push({ number: f[0] === '-' ? '' : f[0], name: f[1] === '~' ? '' : f[1].replace(/_/g, ' '), type, x: Number(f[3]), y: Number(f[4]), length: Number(f[5]), orient, shape, ...(hid ? { hidden: true, net: hid.split(':')[1] ?? (f[1] === '~' ? '' : f[1]) } : {}) });
  }
  return out;
}

export function gfxToText(gs: Graphic[]): string {
  return gs.map((g) => {
    switch (g.kind) {
      case 'rect': return `rect ${g.x1} ${g.y1} ${g.x2} ${g.y2}${g.fill ? ' fill' : ''}`;
      case 'line': return `line ${g.pts.map((p) => `${Math.round(p.x)} ${Math.round(p.y)}`).join(' ')}`;
      case 'polygon': return `poly ${g.pts.map((p) => `${Math.round(p.x)} ${Math.round(p.y)}`).join(' ')}${g.fill ? ' fill' : ''}`;
      case 'circle': return `circle ${g.c.x} ${g.c.y} ${g.r}${g.fill ? ' fill' : ''}`;
      case 'arc': return `arc ${g.c.x} ${g.c.y} ${g.r} ${Math.round(g.a0)} ${Math.round(g.a1)}`;
      case 'text': return `text ${g.at.x} ${g.at.y} ${g.size ?? 50} ${g.text}`;
    }
  }).join('\n');
}

export function textToGfx(t: string): Graphic[] {
  const out: Graphic[] = [];
  for (const raw of t.split('\n')) {
    const l = raw.trim(); if (!l || l.startsWith('#')) continue;
    const [k, ...rest] = l.split(/\s+/);
    const fill = rest[rest.length - 1] === 'fill'; const nums = rest.filter((x) => x !== 'fill').map(Number);
    const pts = () => { const p = []; for (let i = 0; i + 1 < nums.length; i += 2) p.push({ x: nums[i], y: nums[i + 1] }); return p; };
    switch (k) {
      case 'rect': out.push({ kind: 'rect', x1: nums[0], y1: nums[1], x2: nums[2], y2: nums[3], fill }); break;
      case 'line': out.push({ kind: 'line', pts: pts() }); break;
      case 'poly': out.push({ kind: 'polygon', pts: pts(), fill }); break;
      case 'circle': out.push({ kind: 'circle', c: { x: nums[0], y: nums[1] }, r: nums[2], fill }); break;
      case 'arc': out.push({ kind: 'arc', c: { x: nums[0], y: nums[1] }, r: nums[2], a0: nums[3], a1: nums[4] }); break;
      case 'text': out.push({ kind: 'text', at: { x: Number(rest[0]), y: Number(rest[1]) }, size: Number(rest[2]), text: rest.slice(3).join(' ') }); break;
      default: throw new Error(`unknown graphic "${k}"`);
    }
  }
  return out;
}

/** Box symbol from `number name type side` lines (side: left right top bottom; default left for inputs, right for outputs). */
export function generateBox(t: string): SymbolView {
  const rows = t.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#')).map((l) => l.split(/\s+/));
  const sides: Record<'left' | 'right' | 'top' | 'bottom', { number: string; name: string; type: PinType }[]> = { left: [], right: [], top: [], bottom: [] };
  for (const f of rows) {
    const type = TYPES.includes(f[2] as PinType) ? (f[2] as PinType) : 'passive';
    const side = (['left', 'right', 'top', 'bottom'].includes(f[3]) ? f[3] : type === 'output' || type === 'tristate' || type === 'open_collector' ? 'right' : type === 'power' && /GND|VSS|VEE/i.test(f[1] ?? '') ? 'bottom' : type === 'power' ? 'top' : 'left') as 'left';
    sides[side].push({ number: f[0], name: (f[1] ?? f[0]).replace(/_/g, ' '), type });
  }
  const P = 100, L = 300;
  const longest = Math.max(4, ...rows.map((f) => (f[1] ?? '').length));
  const w = Math.max(600, Math.ceil(((sides.top.length + 1) * P) / 100) * 100, Math.ceil((longest * 2 * 45 + 200) / 100) * 100);
  const h = Math.max(400, (Math.max(sides.left.length, sides.right.length) + 1) * P);
  const pins: SymPin[] = [];
  sides.left.forEach((p, i) => pins.push({ ...p, x: -L, y: (i + 1) * P, length: L, orient: 'left' }));
  sides.right.forEach((p, i) => pins.push({ ...p, x: w + L, y: (i + 1) * P, length: L, orient: 'right' }));
  sides.top.forEach((p, i) => pins.push({ ...p, x: (i + 1) * P, y: -L, length: L, orient: 'up' }));
  sides.bottom.forEach((p, i) => pins.push({ ...p, x: (i + 1) * P, y: h + L, length: L, orient: 'down' }));
  return { graphics: [{ kind: 'rect', x1: 0, y1: 0, x2: w, y2: h }], pins };
}
