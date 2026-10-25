/**
 * Multi-user design collaboration (Allegro Symphony / Pulse counterpart): the shared protocol.
 *
 * A project is edited concurrently by several clients through one server. Every edit travels as object-level
 * operations: upsert/remove of an object in a keyed collection (traces, vias, zones ... by id; components by ref;
 * nets by name; footprints by name) or replacement of a whole section (rules, layers, outline, ...). The server keeps
 * the authoritative project, a version number, the version at which each object last changed, object locks and
 * design partitions (areas owned by one user), and checks every operation against them:
 *
 *   - an object locked by someone else, or lying in a partition owned by someone else, cannot be changed
 *   - an object changed by someone else after the version the client based its edit on is a conflict: the server
 *     answers with the current object so the client can rebase (optimistic concurrency per object)
 */
import type { Project, Pt } from './model.js';

export type Coll = 'traces' | 'vias' | 'zones' | 'keepouts' | 'texts' | 'dimensions' | 'rooms' | 'regions' | 'rfElements' | 'voids' | 'bondWires' | 'flexZones' | 'bends' | 'stiffeners' | 'components' | 'nets' | 'footprints';
export const ID_COLLS: Coll[] = ['traces', 'vias', 'zones', 'keepouts', 'texts', 'dimensions', 'rooms', 'regions', 'rfElements', 'voids', 'bondWires', 'flexZones', 'bends', 'stiffeners'];
export const KEYED: Partial<Record<Coll, string>> = { components: 'ref', nets: 'name' };
export const SECTIONS = ['name', 'layers', 'outline', 'rules', 'diffPairs', 'lengthGroups', 'netClasses', 'classClearances', 'variants', 'structures', 'waivers', 'backdrill', 'sources', 'loads', 'cutouts', 'bondProfiles'] as const;
export type Section = typeof SECTIONS[number];

export type Op =
  | { kind: 'upsert'; coll: Coll; key: string; obj: unknown }
  | { kind: 'remove'; coll: Coll; key: string }
  | { kind: 'section'; name: Section; value: unknown };

export interface Partition { id: string; owner: string; rect: { x1: number; y1: number; x2: number; y2: number }; layers?: string[] }
export interface Lock { coll: Coll; key: string; owner: string }

/** Client -> server messages. */
export type ClientMsg =
  | { type: 'hello'; user: string; color?: string }
  | { type: 'ops'; base: number; ops: Op[] }
  | { type: 'lock'; coll: Coll; key: string } | { type: 'unlock'; coll: Coll; key: string }
  | { type: 'partition'; rect: Partition['rect']; layers?: string[] } | { type: 'unpartition'; id: string }
  | { type: 'cursor'; x: number; y: number }
  | { type: 'chat'; text: string }
  | { type: 'checkpoint'; note: string } | { type: 'history' } | { type: 'restore'; id: string };
/** Server -> client messages. */
export type ServerMsg =
  | { type: 'welcome'; you: string; project: Project; version: number; users: { name: string; color: string }[]; locks: Lock[]; partitions: Partition[]; chat: { user: string; text: string; at: string }[] }
  | { type: 'ops'; version: number; ops: Op[]; user: string }
  | { type: 'ack'; version: number; applied: number }
  | { type: 'reject'; reason: string; op: Op; current?: unknown; version: number }
  | { type: 'locks'; locks: Lock[] } | { type: 'partitions'; partitions: Partition[] }
  | { type: 'users'; users: { name: string; color: string }[] }
  | { type: 'cursor'; user: string; x: number; y: number }
  | { type: 'chat'; user: string; text: string; at: string }
  | { type: 'history'; versions: { id: string; version: number; note: string; user: string; at: string }[] }
  | { type: 'reload'; project: Project; version: number };

const coll = (p: Project, c: Coll): unknown[] | Record<string, unknown> => {
  if (c === 'footprints') return (p.footprints ??= {});
  const a = (p as unknown as Record<string, unknown[]>)[c]; if (a) return a;
  (p as unknown as Record<string, unknown[]>)[c] = []; return (p as unknown as Record<string, unknown[]>)[c];
};
const keyOf = (c: Coll, o: Record<string, unknown>): string => String(c === 'footprints' ? o.name : o[KEYED[c] ?? 'id']);

/** The object with that key, or undefined. */
export function getObject(p: Project, c: Coll, key: string): unknown {
  const a = coll(p, c);
  if (!Array.isArray(a)) return (a as Record<string, unknown>)[key];
  return a.find((o) => keyOf(c, o as Record<string, unknown>) === key);
}

/** Apply operations in place. */
export function applyOps(p: Project, ops: Op[]): void {
  for (const op of ops) {
    if (op.kind === 'section') { (p as unknown as Record<string, unknown>)[op.name] = clone(op.value); continue; }
    const a = coll(p, op.coll);
    if (!Array.isArray(a)) { if (op.kind === 'remove') delete (a as Record<string, unknown>)[op.key]; else (a as Record<string, unknown>)[op.key] = clone(op.obj); continue; }
    const i = a.findIndex((o) => keyOf(op.coll, o as Record<string, unknown>) === op.key);
    if (op.kind === 'remove') { if (i >= 0) a.splice(i, 1); }
    else if (i >= 0) a[i] = clone(op.obj); else a.push(clone(op.obj));
    if (op.kind === 'upsert' && ID_COLLS.includes(op.coll)) { const id = Number((op.obj as { id?: number }).id); if (id >= p.nextId) p.nextId = id + 1; }
  }
}

/** Operations that turn `a` into `b`. */
export function diffProjects(a: Project, b: Project): Op[] {
  const ops: Op[] = [];
  for (const c of [...ID_COLLS, 'components', 'nets', 'footprints'] as Coll[]) {
    const A = coll(a, c), B = coll(b, c);
    const mapOf = (x: unknown[] | Record<string, unknown>) => Array.isArray(x) ? new Map(x.map((o) => [keyOf(c, o as Record<string, unknown>), o])) : new Map(Object.entries(x));
    const ma = mapOf(A), mb = mapOf(B);
    for (const [k, o] of mb) { const old = ma.get(k); if (old === undefined || JSON.stringify(old) !== JSON.stringify(o)) ops.push({ kind: 'upsert', coll: c, key: k, obj: clone(o) }); }
    for (const k of ma.keys()) if (!mb.has(k)) ops.push({ kind: 'remove', coll: c, key: k });
  }
  for (const s of SECTIONS) {
    const va = (a as unknown as Record<string, unknown>)[s], vb = (b as unknown as Record<string, unknown>)[s];
    if (JSON.stringify(va) !== JSON.stringify(vb)) ops.push({ kind: 'section', name: s, value: clone(vb) });
  }
  return ops;
}

export function clone<T>(v: T): T { return v === undefined ? v : JSON.parse(JSON.stringify(v)); }

/** A representative location of an object (for partition checks). */
export function objectLocation(c: Coll, o: unknown): Pt | null {
  const x = o as Record<string, unknown>;
  if (!x) return null;
  if (typeof x.x === 'number' && typeof x.y === 'number') return { x: x.x as number, y: x.y as number };
  const pts = (x.points as Pt[] | undefined) ?? undefined;
  if (pts?.length) return pts[0];
  const r = x.rect as { x1: number; y1: number; x2: number; y2: number } | undefined;
  if (r) return { x: (r.x1 + r.x2) / 2, y: (r.y1 + r.y2) / 2 };
  void c;
  return null;
}
export const inRect = (q: Pt, r: Partition['rect']) => q.x >= Math.min(r.x1, r.x2) && q.x <= Math.max(r.x1, r.x2) && q.y >= Math.min(r.y1, r.y2) && q.y <= Math.max(r.y1, r.y2);
