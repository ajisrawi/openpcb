/**
 * Annotation (Capture Tools > Annotate) and back-annotation.
 *
 *   annotate          number unannotated parts ("R?") per prefix in page order, left-to-right / top-to-bottom; with
 *                     `reset` every part is renumbered. Multi-unit parts are packed: unannotated units of the same
 *                     part fill the free units of a package (A, B, C, D) before a new package is started.
 *                     Blocks instantiated more than once get per-occurrence designators in Design.occurrences.
 *   backAnnotate      apply a board's refdes changes (was/is list), and value / footprint edits made on the board
 */
import { type Design, type PartInst, libPart, allPages, schematicOf, instSeg } from './model.js';

export interface AnnotateResult { changed: { path: string; was: string; is: string }[] }

const prefixOf = (ref: string) => /^[A-Za-z_]+/.exec(ref)?.[0] ?? 'U';
const numOf = (ref: string) => { const m = /(\d+)\??$/.exec(ref); return m ? Number(m[1]) : NaN; };
const unannotated = (ref: string) => /\?$/.test(ref) || !/\d/.test(ref);

/** Every placed instance with its hierarchical path, in page order (schematic folder order, page order, then y, x). */
function instancesInOrder(d: Design): { pi: PartInst; path: string; count: number }[] {
  const out: { pi: PartInst; path: string; count: number }[] = [];
  const uses = new Map<string, number>();
  const countUses = (sch: string, depth: number) => { if (depth > 32) return; for (const pg of schematicOf(d, sch)?.pages ?? []) for (const b of pg.blocks) { uses.set(b.schematic, (uses.get(b.schematic) ?? 0) + 1); countUses(b.schematic, depth + 1); } };
  countUses(d.root, 0);
  const walk = (sch: string, path: string, depth: number) => {
    if (depth > 32) return;
    for (const pg of schematicOf(d, sch)?.pages ?? []) {
      const ps = pg.parts.filter((pi) => { const lp = libPart(d, pi.lib, pi.part); return !lp?.kind || lp.kind === 'part'; }).slice().sort((a, b) => Math.round(a.y / 1000) - Math.round(b.y / 1000) || a.x - b.x || a.y - b.y);
      for (const pi of ps) out.push({ pi, path, count: path ? (uses.get(sch) ?? 1) : 1 });
      for (const b of pg.blocks) walk(b.schematic, path ? `${path}/${b.ref}` : b.ref, depth + 1);
    }
  };
  walk(d.root, '', 0);
  return out;
}

export function annotate(d: Design, opts: { reset?: boolean; start?: number } = {}): AnnotateResult {
  const all = instancesInOrder(d);
  const changed: AnnotateResult['changed'] = [];
  const start = opts.start ?? 1;
  // designators in use (kept parts)
  const taken = new Map<string, Set<number>>();
  const refOf = (x: { pi: PartInst; path: string; count: number }) => (x.count > 1 ? d.occurrences[x.path ? `${x.path}/${instSeg(x.pi)}` : instSeg(x.pi)]?.ref ?? x.pi.ref : x.pi.ref);
  if (!opts.reset) for (const x of all) { const r = refOf(x); if (!unannotated(r)) { const s = taken.get(prefixOf(r)) ?? new Set(); s.add(numOf(r)); taken.set(prefixOf(r), s); } }
  const next = (pf: string) => { const s = taken.get(pf) ?? new Set(); let n = start; while (s.has(n)) n++; s.add(n); taken.set(pf, s); return n; };
  // open packages of multi-unit parts: part name -> { ref, free units }
  const open = new Map<string, { ref: string; free: number[] }[]>();
  if (!opts.reset) for (const x of all) { const lp = libPart(d, x.pi.lib, x.pi.part); const r = refOf(x); if (!lp || lp.units.length < 2 || unannotated(r)) continue; const list = open.get(lp.name) ?? []; let pk = list.find((q) => q.ref === r); if (!pk) { pk = { ref: r, free: lp.units.map((_, i) => i) }; list.push(pk); open.set(lp.name, list); } pk.free = pk.free.filter((u) => u !== x.pi.unit); }
  for (const x of all) {
    const r0 = refOf(x);
    if (!opts.reset && !unannotated(r0)) continue;
    const lp = libPart(d, x.pi.lib, x.pi.part);
    const pf = lp?.refPrefix ?? prefixOf(r0);
    let ref: string;
    if (lp && lp.units.length > 1) {
      const list = open.get(lp.name) ?? [];
      let pk = list.find((q) => q.free.length);
      if (!pk) { pk = { ref: `${pf}${next(pf)}`, free: lp.units.map((_, i) => i) }; list.push(pk); open.set(lp.name, list); }
      const unit = pk.free.includes(x.pi.unit) ? x.pi.unit : pk.free[0];
      pk.free = pk.free.filter((u) => u !== unit);
      x.pi.unit = unit; ref = pk.ref;
    } else ref = `${pf}${next(pf)}`;
    const key = x.path ? `${x.path}/${instSeg(x.pi)}` : instSeg(x.pi);
    if (x.count > 1) { d.occurrences[key] = { ...(d.occurrences[key] ?? { path: key }), path: key, ref }; }
    else { if (x.pi.ref !== ref) changed.push({ path: key, was: x.pi.ref, is: ref }); x.pi.ref = ref; continue; }
    changed.push({ path: key, was: r0, is: ref });
  }
  return { changed };
}

/** Mark every part unannotated ("R?"), keeping units. */
export function resetAnnotation(d: Design): number { let n = 0; for (const { page } of allPages(d)) for (const pi of page.parts) { const lp = libPart(d, pi.lib, pi.part); if (lp?.kind && lp.kind !== 'part') continue; pi.ref = `${lp?.refPrefix ?? prefixOf(pi.ref)}?`; n++; } d.occurrences = {}; return n; }

/** Back-annotation: refdes renames (was/is), and Value / PCB Footprint edits from the board. */
export function backAnnotate(d: Design, changes: { renames?: { was: string; is: string }[]; values?: Record<string, string>; footprints?: Record<string, string> }): { renamed: number; values: number; footprints: number; unknown: string[] } {
  const unknown: string[] = [];
  let renamed = 0, values = 0, footprints = 0;
  const insts = (ref: string) => { const out: PartInst[] = []; for (const { page } of allPages(d)) for (const pi of page.parts) if (pi.ref === ref) out.push(pi); for (const [k, o] of Object.entries(d.occurrences)) if (o.ref === ref) out.push({ ref: k } as PartInst); return out; };
  // renames through temporary names so swaps cannot collide
  const tmp = (changes.renames ?? []).map((r) => ({ ...r, t: `__BA_${r.was}` }));
  for (const r of tmp) { const xs = insts(r.was); if (!xs.length) { unknown.push(r.was); continue; } for (const { page } of allPages(d)) for (const pi of page.parts) if (pi.ref === r.was) pi.ref = r.t; for (const o of Object.values(d.occurrences)) if (o.ref === r.was) o.ref = r.t; }
  for (const r of tmp) { for (const { page } of allPages(d)) for (const pi of page.parts) if (pi.ref === r.t) { pi.ref = r.is; renamed++; } for (const o of Object.values(d.occurrences)) if (o.ref === r.t) { o.ref = r.is; renamed++; } }
  for (const [ref, v] of Object.entries(changes.values ?? {})) { let hit = false; for (const { page } of allPages(d)) for (const pi of page.parts) if (pi.ref === ref) { pi.props.Value = v; hit = true; } if (hit) values++; else unknown.push(ref); }
  for (const [ref, f] of Object.entries(changes.footprints ?? {})) { let hit = false; for (const { page } of allPages(d)) for (const pi of page.parts) if (pi.ref === ref) { pi.props['PCB Footprint'] = f; hit = true; } if (hit) footprints++; else unknown.push(ref); }
  return { renamed, values, footprints, unknown: [...new Set(unknown)] };
}
