/**
 * Test point insertion (Allegro "Testprep" / SPECCTRA `testpoint`): every net without probe access on the chosen
 * side gets a round SMD test pad, placed on one of the net's through vias (via-in-pad) or on a point of one of its
 * traces on that side, keeping clearance to other-net copper, the board edge, and the minimum probe spacing to
 * other test points. Test pads are TP<n> components (footprint TestPoint_<dia>mm) added to the net.
 */
import { type Project, type Pt, padToBoard, padLayers, padAngle, viaLayers, nextId } from './model.js';
import { defaultLibrary } from './footprints.js';
import { padGeometry } from './drc.js';
import { padInstances } from './connectivity.js';
import { geomDistance, type Geometry } from '@openpcb/router';

export interface TestPointOptions { dia?: number; side?: 'front' | 'back'; spacing?: number; nets?: string[] }
export interface TestPointResult { added: { net: string; ref: string; at: Pt; on: 'via' | 'trace' }[]; accessible: string[]; failed: string[] }

export function addTestPoints(p: Project, o: TestPointOptions = {}): TestPointResult {
  const dia = o.dia ?? 1.0, side = o.side ?? 'back', spacing = o.spacing ?? 2.54;
  const layer = side === 'front' ? p.layers[0].name : p.layers[p.layers.length - 1].name;
  const fpName = `TestPoint_${dia}mm`;
  p.footprints[fpName] ??= { name: fpName, pads: [{ id: '1', x: 0, y: 0, w: dia, h: dia, shape: 'circle', th: false }], outline: [], body: { w: dia, h: dia } };
  const lib = { ...defaultLibrary(), ...p.footprints };
  const R = p.rules;
  const res: TestPointResult = { added: [], accessible: [], failed: [] };
  const pads = padInstances(p);
  const tps: Pt[] = p.components.filter((c) => /^TestPoint_/.test(c.footprint)).map((c) => ({ x: c.x, y: c.y }));
  const inside = (q: Pt) => { let ins = false; const poly = p.outline; for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) { const a = poly[i], b = poly[j]; if ((a.y > q.y) !== (b.y > q.y) && q.x < ((b.x - a.x) * (q.y - a.y)) / (b.y - a.y) + a.x) ins = !ins; } return ins; };
  const edgeDist = (q: Pt) => { let d = Infinity; const poly = p.outline; for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) { const a = poly[j], b = poly[i]; const dx = b.x - a.x, dy = b.y - a.y, l2 = dx * dx + dy * dy; let t = l2 ? ((q.x - a.x) * dx + (q.y - a.y) * dy) / l2 : 0; t = Math.max(0, Math.min(1, t)); d = Math.min(d, Math.hypot(q.x - a.x - dx * t, q.y - a.y - dy * t)); } return d; };
  const fits = (net: string, at: Pt): boolean => {
    if (!inside(at) || edgeDist(at) < dia / 2 + R.edgeClearance) return false;
    if (tps.some((q) => Math.hypot(q.x - at.x, q.y - at.y) < spacing)) return false;
    const g: Geometry = { type: 'circle', c: at, r: dia / 2 };
    for (const pd of pads) { if (pd.net === net || !pd.layers.includes(layer)) continue; if (Math.hypot(pd.center.x - at.x, pd.center.y - at.y) > dia + 6) continue; if (geomDistance(g, padGeometry(pd)) < R.clearance) return false; }
    for (const t of p.traces) { if (t.net === net || t.layer !== layer) continue; for (let i = 1; i < t.points.length; i++) if (geomDistance(g, { type: 'seg', a: t.points[i - 1], b: t.points[i], hw: t.width / 2 }) < R.clearance) return false; }
    for (const v of p.vias) {
      if (v.net === net) continue;
      const vd = Math.hypot(v.x - at.x, v.y - at.y);
      if (viaLayers(p, v).includes(layer) && vd - v.diameter / 2 - dia / 2 < R.clearance) return false;
      // any drilled hole of another net nearby (a through via passes the pad's layer even when blind ones do not)
      if (viaLayers(p, v).includes(layer) && vd - v.drill / 2 - dia / 2 < R.holeToCopper) return false;
    }
    for (const pd of pads) {
      if (pd.net === net) continue;
      if (pd.th && Math.hypot(pd.center.x - at.x, pd.center.y - at.y) - dia / 2 < R.holeToCopper + 0.5) return false;
      // solder-mask web between the test pad opening and a neighbouring pad opening on the same side
      if (pd.layers.includes(layer) && Math.hypot(pd.center.x - at.x, pd.center.y - at.y) < dia + 6 && geomDistance(g, padGeometry(pd)) - 2 * R.maskExpansion < R.minMaskSliver) return false;
    }
    return true;
  };
  let n = 1; const refs = new Set(p.components.map((c) => c.ref)); const nextRef = () => { while (refs.has(`TP${n}`)) n++; refs.add(`TP${n}`); return `TP${n}`; };
  for (const net of p.nets) {
    if (o.nets && !o.nets.includes(net.name)) continue;
    if (net.pins.length < 2) continue;
    const netPads = pads.filter((pd) => pd.net === net.name);
    // already probe-accessible: a through-hole pin or an existing test point on the net
    if (netPads.some((pd) => pd.th || /^TP\d+$/.test(pd.ref))) { res.accessible.push(net.name); continue; }
    const cands: { at: Pt; on: 'via' | 'trace' }[] = [];
    for (const v of p.vias) if (v.net === net.name && viaLayers(p, v).includes(layer)) cands.push({ at: { x: v.x, y: v.y }, on: 'via' });
    for (const t of p.traces) if (t.net === net.name && t.layer === layer) for (let i = 1; i < t.points.length; i++) { const a = t.points[i - 1], b = t.points[i]; cands.push({ at: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, on: 'trace' }, { at: a, on: 'trace' }); }
    const pick = cands.find((c) => fits(net.name, c.at));
    if (!pick) { res.failed.push(net.name); continue; }
    const ref = nextRef();
    p.components.push({ ref, footprint: fpName, value: 'TP', x: pick.at.x, y: pick.at.y, rot: 0, side, locked: true });
    net.pins.push(`${ref}-1`);
    tps.push(pick.at);
    res.added.push({ net: net.name, ref, at: pick.at, on: pick.on });
  }
  void lib; void padToBoard; void padLayers; void padAngle; void nextId;
  return res;
}
