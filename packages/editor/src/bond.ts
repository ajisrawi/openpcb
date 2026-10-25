/**
 * Wire bonding (Allegro Package Designer / SiP layout counterpart).
 *
 *   bondFingers   bond fingers for a die: one finger per connected die pad, on a ring (or staggered rings) around
 *                 the die at an offset, each pointing back at its die pad, created as the pads of a finger component
 *                 ("BF_<die>") and joined to the die pads by bond wires of the pad's net
 *   addBondWire   a single wire between two pads (die-to-finger or die-to-die)
 *   wirePath      3D centre-line of a wire from its loop profile (JEDEC style: rise to the loop height above the die
 *                 pad, a kink, then a straight descent landing at the finger at the profile's angle)
 *   bondDrc       3D wire-to-wire clearance, plan-view crossings at a similar height, length limits, landing angle
 *                 against the finger axis, a wire passing over another die pad lower than the loop clearance
 *   bondReport    length, net, angle and profile of every wire
 *   bondSolids    wires as watertight square prisms for STEP / 3D
 */
import { type Project, type Pt, type BondWire, type BondProfile, type Pad, nextId, padToBoard } from './model.js';
import { defaultLibrary } from './footprints.js';
import { padInstances, type PadInstance } from './connectivity.js';

export interface P3 { x: number; y: number; z: number }
const DEFAULT_PROFILE: BondProfile = { name: 'STD', loopHeight: 0.15, kink: 0.25, landingAngle: 30, dieHeight: 0.2 };

const profileOf = (p: Project, w: BondWire): BondProfile => p.bondProfiles?.find((x) => x.name === w.profile) ?? DEFAULT_PROFILE;
function padOf(p: Project, ref: string, pad: string, pads = padInstances(p)): PadInstance | undefined { return pads.find((x) => x.ref === ref && x.padId === pad); }
function endPoint(p: Project, e: BondWire['to'], pads: PadInstance[]): { pt: Pt; die: boolean } {
  if ('ref' in e) { const pd = padOf(p, e.ref, e.pad, pads); if (!pd) throw new Error(`no pad ${e.ref}-${e.pad}`); return { pt: pd.center, die: isDie(p, e.ref) }; }
  return { pt: { x: e.x, y: e.y }, die: false };
}
/** A die: footprint marked as a die or a part whose name starts with "DIE"/"U" and which has fingers made for it. */
function isDie(p: Project, ref: string): boolean {
  const c = p.components.find((x) => x.ref === ref); if (!c) return false;
  const fp = { ...defaultLibrary(), ...p.footprints }[c.footprint];
  return !!fp && (/die/i.test(fp.name) || (p.bondWires ?? []).some((w) => w.from.ref === ref));
}

/** 3D centre-line of a wire (mm; z = 0 on the substrate surface, die pads at the die height). */
export function wirePath(p: Project, w: BondWire, pads = padInstances(p)): P3[] {
  const pr = profileOf(p, w);
  const a = endPoint(p, w.from, pads), b = endPoint(p, w.to, pads);
  const za = a.die ? pr.dieHeight ?? 0.2 : 0, zb = b.die ? pr.dieHeight ?? 0.2 : 0;
  const d = { x: b.pt.x - a.pt.x, y: b.pt.y - a.pt.y }, L = Math.hypot(d.x, d.y) || 1e-9, u = { x: d.x / L, y: d.y / L };
  const top = Math.max(za, zb) + pr.loopHeight;
  const kink = Math.min(pr.kink, L * 0.4);
  // descent from the kink towards b at the landing angle (or steeper if the span is short)
  const fall = top - zb, run = Math.max(fall / Math.tan((pr.landingAngle * Math.PI) / 180), 0);
  const kx = Math.min(kink, Math.max(0, L - run));
  return [
    { x: a.pt.x, y: a.pt.y, z: za },
    { x: a.pt.x, y: a.pt.y, z: top },
    { x: a.pt.x + u.x * kx, y: a.pt.y + u.y * kx, z: top },
    { x: b.pt.x, y: b.pt.y, z: zb },
  ];
}
const len3 = (pts: P3[]) => pts.reduce((s, q, i) => (i ? s + Math.hypot(q.x - pts[i - 1].x, q.y - pts[i - 1].y, q.z - pts[i - 1].z) : 0), 0);

export function addBondWire(p: Project, from: { ref: string; pad: string }, to: BondWire['to'], opts: { diameter?: number; profile?: string; material?: BondWire['material']; net?: string } = {}): BondWire {
  const pads = padInstances(p);
  const net = opts.net ?? padOf(p, from.ref, from.pad, pads)?.net ?? '';
  const w: BondWire = { id: nextId(p), net, from, to, diameter: opts.diameter ?? 0.025, ...(opts.profile ? { profile: opts.profile } : {}), material: opts.material ?? 'Au' };
  (p.bondWires ??= []).push(w);
  // a finger pad that has no net yet joins the wire's net
  if ('ref' in to && net) { const n = p.nets.find((x) => x.name === net); const key = `${to.ref}-${to.pad}`; if (n && !p.nets.some((x) => x.pins.includes(key))) n.pins.push(key); }
  return w;
}

/**
 * Bond fingers around a die: every die pad with a net gets a finger `offset` mm outside the die body edge (rings of
 * `rows`, staggered by half a finger length), oriented along the die-pad -> finger direction.
 */
export function bondFingers(p: Project, dieRef: string, opts: { offset?: number; fingerW?: number; fingerL?: number; rows?: number; rowPitch?: number; diameter?: number; profile?: string } = {}): { component: string; fingers: number; wires: number } {
  const die = p.components.find((c) => c.ref === dieRef); if (!die) throw new Error(`no die ${dieRef}`);
  const lib = { ...defaultLibrary(), ...p.footprints };
  const fp = lib[die.footprint]; if (!fp) throw new Error(`no footprint ${die.footprint}`);
  const offset = opts.offset ?? 0.5, fw = opts.fingerW ?? 0.1, fl = opts.fingerL ?? 0.35, rows = opts.rows ?? 1, rp = opts.rowPitch ?? fl + 0.1;
  const pads = padInstances(p).filter((x) => x.ref === dieRef && x.net);
  const hw = fp.body.w / 2, hh = fp.body.h / 2;
  const fpads: Pad[] = [];
  const ref = `BF_${dieRef}`;
  const wires: [string, string][] = [];
  pads.forEach((pd, k) => {
    // local position of the die pad, pushed straight out through the nearest body edge
    const lp = fp.pads.find((x) => x.id === pd.padId)!;
    const ex = hw - Math.abs(lp.x), ey = hh - Math.abs(lp.y);
    const out = ex < ey ? { x: Math.sign(lp.x) || 1, y: 0 } : { x: 0, y: Math.sign(lp.y) || 1 };
    const row = k % rows;
    const dist = (out.x ? hw - Math.abs(lp.x) : hh - Math.abs(lp.y)) + offset + row * rp + fl / 2;
    const local = { x: lp.x + out.x * dist, y: lp.y + out.y * dist };
    const abs = padToBoard(die, local);
    const id = String(fpads.length + 1);
    // finger long axis along the wire direction, in board coordinates
    const base = padToBoard(die, lp), tip = padToBoard(die, { x: lp.x + out.x, y: lp.y + out.y });
    // the finger component sits at the origin unrotated; a back-side one mirrors x (and pad angles), so store them mirrored
    const mx = die.side === 'back' ? -1 : 1;
    let ang = (Math.atan2(tip.y - base.y, tip.x - base.x) * 180) / Math.PI; ang = ((ang % 180) + 180) % 180;
    const q = ang / 90, near = Math.round(q);
    const finger: Pad = Math.abs(q - near) < 1e-6
      ? { id, x: mx * abs.x, y: abs.y, w: near % 2 ? fw : fl, h: near % 2 ? fl : fw, shape: 'rect', th: false }
      : { id, x: mx * abs.x, y: abs.y, w: fl, h: fw, shape: 'rect', th: false, rot: Math.round(mx * ang * 1e4) / 1e4 };
    fpads.push(finger);
    wires.push([pd.padId, id]);
  });
  // finger component at the origin (pads in board coordinates), on the die's side
  p.footprints[`FINGERS_${dieRef}`] = { name: `FINGERS_${dieRef}`, pads: fpads, outline: [], body: { w: 0.1, h: 0.1 }, outlineKind: 'reference', height: 0 };
  p.components = p.components.filter((c) => c.ref !== ref);
  p.bondWires = (p.bondWires ?? []).filter((w) => !('ref' in w.to && w.to.ref === ref));
  p.components.push({ ref, footprint: `FINGERS_${dieRef}`, value: 'bond fingers', x: 0, y: 0, rot: 0, side: die.side, locked: true });
  for (const [dp, fid] of wires) addBondWire(p, { ref: dieRef, pad: dp }, { ref, pad: fid }, { diameter: opts.diameter, profile: opts.profile });
  return { component: ref, fingers: fpads.length, wires: wires.length };
}

/* ------------------------------------------------------------------- checks */

function segSeg3(a0: P3, a1: P3, b0: P3, b1: P3): number {
  // closest distance between two 3D segments (clamped parameters)
  const d1 = { x: a1.x - a0.x, y: a1.y - a0.y, z: a1.z - a0.z }, d2 = { x: b1.x - b0.x, y: b1.y - b0.y, z: b1.z - b0.z }, r = { x: a0.x - b0.x, y: a0.y - b0.y, z: a0.z - b0.z };
  const dot = (u: P3, v: P3) => u.x * v.x + u.y * v.y + u.z * v.z;
  const a = dot(d1, d1), e = dot(d2, d2), f = dot(d2, r);
  let s = 0, t = 0;
  if (a < 1e-12 && e < 1e-12) return Math.sqrt(dot(r, r));
  if (a < 1e-12) t = Math.min(1, Math.max(0, f / e));
  else { const c = dot(d1, r); if (e < 1e-12) s = Math.min(1, Math.max(0, -c / a)); else { const b = dot(d1, d2), den = a * e - b * b; s = den > 1e-12 ? Math.min(1, Math.max(0, (b * f - c * e) / den)) : 0; t = (b * s + f) / e; if (t < 0) { t = 0; s = Math.min(1, Math.max(0, -c / a)); } else if (t > 1) { t = 1; s = Math.min(1, Math.max(0, (b - c) / a)); } } }
  const pa = { x: a0.x + d1.x * s, y: a0.y + d1.y * s, z: a0.z + d1.z * s }, pb = { x: b0.x + d2.x * t, y: b0.y + d2.y * t, z: b0.z + d2.z * t };
  return Math.hypot(pa.x - pb.x, pa.y - pb.y, pa.z - pb.z);
}

export interface BondMarker { kind: 'bond-spacing' | 'bond-length' | 'bond-angle' | 'bond-over-pad'; message: string; at: Pt; wires: number[] }

export function bondDrc(p: Project, opts: { minSpacing?: number; minLength?: number; maxLength?: number; maxAngle?: number; padClearance?: number } = {}): BondMarker[] {
  const pads = padInstances(p);
  const ws = p.bondWires ?? [];
  const paths = ws.map((w) => wirePath(p, w, pads));
  const out: BondMarker[] = [];
  const minLen = opts.minLength ?? 0.3, maxLen = opts.maxLength ?? 5, maxAng = opts.maxAngle ?? 30;
  ws.forEach((w, i) => {
    const L = len3(paths[i]); const at = { x: paths[i][0].x, y: paths[i][0].y };
    if (L < minLen) out.push({ kind: 'bond-length', message: `wire ${w.from.ref}-${w.from.pad}: length ${L.toFixed(3)} mm < ${minLen}`, at, wires: [w.id] });
    if (L > maxLen) out.push({ kind: 'bond-length', message: `wire ${w.from.ref}-${w.from.pad}: length ${L.toFixed(3)} mm > ${maxLen}`, at, wires: [w.id] });
    // landing angle against the finger's long axis (a finger pad: w x h, long side = axis)
    if ('ref' in w.to) {
      const f = pads.find((x) => x.ref === (w.to as { ref: string }).ref && x.padId === (w.to as { pad: string }).pad);
      if (f) {
        const axis = f.w >= f.h ? (f.rot * Math.PI) / 180 : ((f.rot + 90) * Math.PI) / 180;
        const a = paths[i][0], b = paths[i][3];
        const dir = Math.atan2(b.y - a.y, b.x - a.x);
        let dev = (Math.abs(dir - axis) * 180) / Math.PI % 180; if (dev > 90) dev = 180 - dev;
        if (f.w !== f.h && dev > maxAng) out.push({ kind: 'bond-angle', message: `wire ${w.from.ref}-${w.from.pad}: lands ${dev.toFixed(1)}° off the finger axis (> ${maxAng}°)`, at: { x: b.x, y: b.y }, wires: [w.id] });
      }
    }
  });
  // wire-to-wire 3D spacing (different nets)
  ws.forEach((w, i) => {
    const need = opts.minSpacing ?? Math.max(w.diameter * 1.5, 0.02);
    for (let j = i + 1; j < ws.length; j++) {
      const v = ws[j]; if (v.net === w.net && w.net) continue;
      let d = Infinity;
      for (let a = 1; a < paths[i].length; a++) for (let b = 1; b < paths[j].length; b++) d = Math.min(d, segSeg3(paths[i][a - 1], paths[i][a], paths[j][b - 1], paths[j][b]));
      const gap = d - (w.diameter + v.diameter) / 2;
      if (gap < need) out.push({ kind: 'bond-spacing', message: `wires ${w.from.ref}-${w.from.pad} / ${v.from.ref}-${v.from.pad}: ${Math.max(0, gap).toFixed(4)} mm < ${need.toFixed(3)}`, at: { x: paths[i][2].x, y: paths[i][2].y }, wires: [w.id, v.id] });
    }
  });
  // wire over another (other-net) pad lower than the clearance
  const pc = opts.padClearance ?? 0.05;
  ws.forEach((w, i) => {
    for (const pd of pads) {
      if (pd.net === w.net || !isDie(p, pd.ref)) continue;
      for (let a = 1; a < paths[i].length; a++) {
        const s0 = paths[i][a - 1], s1 = paths[i][a];
        const dx = s1.x - s0.x, dy = s1.y - s0.y, l2 = dx * dx + dy * dy; if (!l2) continue;
        const t = Math.max(0, Math.min(1, ((pd.center.x - s0.x) * dx + (pd.center.y - s0.y) * dy) / l2));
        const q = { x: s0.x + dx * t, y: s0.y + dy * t, z: s0.z + (s1.z - s0.z) * t };
        if (Math.abs(q.x - pd.center.x) <= pd.w / 2 && Math.abs(q.y - pd.center.y) <= pd.h / 2 && q.z - (profileOf(p, w).dieHeight ?? 0.2) < pc) { out.push({ kind: 'bond-over-pad', message: `wire ${w.from.ref}-${w.from.pad} passes ${(q.z - (profileOf(p, w).dieHeight ?? 0.2)).toFixed(3)} mm over pad ${pd.key}`, at: pd.center, wires: [w.id] }); break; }
      }
    }
  });
  return out;
}

export function bondReport(p: Project): { id: number; net: string; from: string; to: string; length: number; diameter: number; material: string; profile: string }[] {
  const pads = padInstances(p);
  return (p.bondWires ?? []).map((w) => ({ id: w.id, net: w.net, from: `${w.from.ref}-${w.from.pad}`, to: 'ref' in w.to ? `${w.to.ref}-${w.to.pad}` : `${w.to.x},${w.to.y}@${w.to.layer}`, length: Math.round(len3(wirePath(p, w, pads)) * 10000) / 10000, diameter: w.diameter, material: w.material ?? 'Au', profile: w.profile ?? DEFAULT_PROFILE.name }));
}

/** Wires as square prisms (side = diameter) per path segment, for STEP and the 3D view. z: substrate top = 0. */
export function bondSolids(p: Project): { name: string; pts: P3[]; size: number }[] {
  const pads = padInstances(p);
  return (p.bondWires ?? []).map((w) => ({ name: `BW_${w.from.ref}_${w.from.pad}`, pts: wirePath(p, w, pads), size: w.diameter }));
}
