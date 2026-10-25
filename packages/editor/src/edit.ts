/**
 * Editing operations shared by the editor UI and the CLI: copy/paste, pin swap (manual and automatic within swap
 * groups), component swap, measuring (Allegro Edit > Copy, Place > Swap / Autoswap, Display > Measure).
 */
import { type Project, type Pt, type Component, type Trace, type ViaDef, nextId, uniqueRef, padToBoard } from './model.js';
import { defaultLibrary } from './footprints.js';
import { padInstances } from './connectivity.js';

/* ---------- copy / paste ---------- */

export interface Clip { components: Component[]; traces: Omit<Trace, 'id'>[]; vias: Omit<ViaDef, 'id'>[]; origin: Pt; }

/** Copy parts (without their net assignments), traces and vias; positions are kept relative to their centre. */
export function copySelection(p: Project, refs: Iterable<string>, traceIds: Iterable<number>, viaIds: Iterable<number>): Clip {
  const rs = new Set(refs), ts = new Set(traceIds), vs = new Set(viaIds);
  const components = p.components.filter((c) => rs.has(c.ref)).map((c) => ({ ...c }));
  const traces = p.traces.filter((t) => ts.has(t.id)).map(({ id: _id, ...t }) => ({ ...t, points: t.points.map((q) => ({ ...q })) }));
  const vias = p.vias.filter((v) => vs.has(v.id)).map(({ id: _id, ...v }) => ({ ...v }));
  const pts: Pt[] = [...components.map((c) => ({ x: c.x, y: c.y })), ...traces.flatMap((t) => t.points), ...vias.map((v) => ({ x: v.x, y: v.y }))];
  const origin = pts.length ? { x: pts.reduce((s, q) => s + q.x, 0) / pts.length, y: pts.reduce((s, q) => s + q.y, 0) / pts.length } : { x: 0, y: 0 };
  return { components, traces, vias, origin };
}

/** Paste a clip centred at `at`: parts get fresh reference designators (same prefix); copper keeps its nets. */
export function pasteClip(p: Project, clip: Clip, at: Pt): { refs: string[]; traces: number[]; vias: number[] } {
  const dx = at.x - clip.origin.x, dy = at.y - clip.origin.y;
  const refs: string[] = [], traces: number[] = [], vias: number[] = [];
  for (const c of clip.components) {
    const prefix = (/^[A-Za-z]+/.exec(c.ref)?.[0]) ?? 'U';
    const ref = uniqueRef(p, prefix);
    p.components.push({ ...c, ref, x: c.x + dx, y: c.y + dy, locked: false });
    refs.push(ref);
  }
  for (const t of clip.traces) { const id = nextId(p); p.traces.push({ ...t, id, points: t.points.map((q) => ({ x: q.x + dx, y: q.y + dy })), locked: true }); traces.push(id); }
  for (const v of clip.vias) { const id = nextId(p); p.vias.push({ ...v, id, x: v.x + dx, y: v.y + dy, locked: true }); vias.push(id); }
  return { refs, traces, vias };
}

/* ---------- measure ---------- */

export function measure(a: Pt, b: Pt): { distance: number; dx: number; dy: number; angle: number } {
  const dx = b.x - a.x, dy = b.y - a.y;
  return { distance: Math.hypot(dx, dy), dx, dy, angle: (Math.atan2(dy, dx) * 180) / Math.PI };
}

/* ---------- swaps ---------- */

/** Half-perimeter wirelength of a net with the current pin positions. */
function hpwl(p: Project, net: string, padPos: Map<string, Pt>): number {
  const n = p.nets.find((x) => x.name === net); if (!n || n.pins.length < 2) return 0;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const k of n.pins) { const q = padPos.get(k); if (!q) continue; x0 = Math.min(x0, q.x); x1 = Math.max(x1, q.x); y0 = Math.min(y0, q.y); y1 = Math.max(y1, q.y); }
  return x1 - x0 + y1 - y0;
}

/** Swap the nets of two pads of one part (Place > Swap > Pins). */
export function swapPins(p: Project, ref: string, a: string, b: string): void {
  const ka = `${ref}-${a}`, kb = `${ref}-${b}`;
  for (const n of p.nets) n.pins = n.pins.map((k) => (k === ka ? kb : k === kb ? ka : k));
}

/**
 * Autoswap pins: within each part, pads that share a swap group are interchangeable; pairwise swaps that shorten
 * the nets they touch (HPWL) are kept until none helps. Pads with routed copper are left alone.
 */
export function autoswapPins(p: Project, refs?: string[]): { swaps: number; gain: number } {
  const lib = { ...defaultLibrary(), ...p.footprints };
  const padPos = new Map<string, Pt>(); for (const pd of padInstances(p)) padPos.set(pd.key, pd.center);
  const netOf = new Map<string, string>(); for (const n of p.nets) for (const k of n.pins) netOf.set(k, n.name);
  const routed = new Set<string>(); for (const pd of padInstances(p)) if (p.traces.some((t) => t.net === pd.net && t.points.some((q) => Math.hypot(q.x - pd.center.x, q.y - pd.center.y) < Math.max(pd.w, pd.h) / 2))) routed.add(pd.key);
  let swaps = 0, gain = 0;
  for (const c of p.components) {
    if (refs && !refs.includes(c.ref)) continue;
    const fp = lib[c.footprint]; if (!fp) continue;
    const groups = new Map<string, string[]>();
    for (const pad of fp.pads) if (pad.swap) { const g = groups.get(pad.swap) ?? []; g.push(pad.id); groups.set(pad.swap, g); }
    for (const ids of groups.values()) {
      let improved = true;
      while (improved) {
        improved = false;
        for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) {
          const ka = `${c.ref}-${ids[i]}`, kb = `${c.ref}-${ids[j]}`;
          if (routed.has(ka) || routed.has(kb)) continue;
          const na = netOf.get(ka), nb = netOf.get(kb); if (na === nb) continue;
          const nets = [na, nb].filter((x): x is string => !!x);
          const before = nets.reduce((s, n) => s + hpwl(p, n, padPos), 0);
          swapPins(p, c.ref, ids[i], ids[j]);
          const after = nets.reduce((s, n) => s + hpwl(p, n, padPos), 0);
          if (after < before - 1e-6) { swaps++; gain += before - after; if (na) netOf.set(kb, na); else netOf.delete(kb); if (nb) netOf.set(ka, nb); else netOf.delete(ka); improved = true; }
          else swapPins(p, c.ref, ids[i], ids[j]);
        }
      }
    }
  }
  return { swaps, gain };
}

/** Swap the placement of two parts with the same footprint (Place > Swap > Components). */
export function swapComponents(p: Project, a: string, b: string): void {
  const ca = p.components.find((c) => c.ref === a), cb = p.components.find((c) => c.ref === b);
  if (!ca || !cb) throw new Error('no such part');
  if (ca.footprint !== cb.footprint) throw new Error('parts must share a footprint');
  for (const k of ['x', 'y', 'rot', 'side'] as const) { const t = ca[k]; (ca as unknown as Record<string, unknown>)[k] = cb[k]; (cb as unknown as Record<string, unknown>)[k] = t; }
}

/**
 * Autoswap components (gate swap): parts with the same footprint and the same gateSwap tag (or, without tags, the
 * same footprint and value) trade places when that shortens their nets; locked parts stay.
 */
export function autoswapComponents(p: Project): { swaps: number; gain: number } {
  const lib = { ...defaultLibrary(), ...p.footprints };
  const groups = new Map<string, Component[]>();
  for (const c of p.components) {
    if (c.locked) continue;
    const fp = lib[c.footprint]; if (!fp) continue;
    const key = fp.gateSwap ? `${c.footprint}|${fp.gateSwap}` : `${c.footprint}|${c.value}`;
    const g = groups.get(key) ?? []; g.push(c); groups.set(key, g);
  }
  const netsOf = (c: Component) => p.nets.filter((n) => n.pins.some((k) => k.startsWith(c.ref + '-'))).map((n) => n.name);
  const cost = (cs: Component[]) => { const padPos = new Map<string, Pt>(); for (const pd of padInstances(p)) padPos.set(pd.key, pd.center); const ns = new Set(cs.flatMap(netsOf)); let s = 0; for (const n of ns) s += hpwl(p, n, padPos); return s; };
  let swaps = 0, gain = 0;
  for (const g of groups.values()) {
    if (g.length < 2 || g.length > 40) continue;
    for (let i = 0; i < g.length; i++) for (let j = i + 1; j < g.length; j++) {
      const before = cost([g[i], g[j]]);
      swapComponents(p, g[i].ref, g[j].ref);
      const after = cost([g[i], g[j]]);
      if (after < before - 1e-6) { swaps++; gain += before - after; } else swapComponents(p, g[i].ref, g[j].ref);
    }
  }
  return { swaps, gain };
}

void padToBoard;
