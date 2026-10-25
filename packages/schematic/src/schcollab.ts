/**
 * Team design for schematics (the System Capture multi-user model): the unit of change is a page, and a designer
 * can reserve pages so nobody else edits them. Design-wide data (libraries, variants, occurrences, settings, the
 * list of schematic folders and pages) travels as sections. The server keeps a version per page / section and
 * rejects an operation whose base version is older than the last change of that page or section (the client then
 * receives the current state).
 */
import type { Design, Page } from './model.js';

export const SECTIONS = ['libraries', 'variants', 'occurrences', 'settings', 'root', 'name', 'structure'] as const;
export type SchSection = typeof SECTIONS[number];

export type SchOp =
  | { kind: 'page'; sch: string; page: string; obj: Page | null }
  | { kind: 'section'; name: SchSection; value: unknown };

export interface Reservation { sch: string; page: string; owner: string }

export type SchClientMsg =
  | { type: 'hello'; user: string; color?: string }
  | { type: 'ops'; base: number; ops: SchOp[] }
  | { type: 'reserve'; sch: string; page: string }
  | { type: 'release'; sch: string; page: string }
  | { type: 'cursor'; sch: string; page: string; x: number; y: number }
  | { type: 'chat'; text: string }
  | { type: 'checkpoint'; note: string }
  | { type: 'history' }
  | { type: 'restore'; id: string };

export type SchServerMsg =
  | { type: 'welcome'; you: string; design: Design; version: number; users: { name: string; color: string }[]; reservations: Reservation[]; chat: { user: string; text: string; at: string }[] }
  | { type: 'ops'; version: number; ops: SchOp[]; user: string }
  | { type: 'ack'; version: number; applied: number }
  | { type: 'reject'; reason: string; op: SchOp; current: unknown; version: number }
  | { type: 'users'; users: { name: string; color: string }[] }
  | { type: 'reservations'; reservations: Reservation[] }
  | { type: 'cursor'; user: string; sch: string; page: string; x: number; y: number }
  | { type: 'chat'; user: string; text: string; at: string }
  | { type: 'history'; versions: { id: string; version: number; note: string; user: string; at: string }[] }
  | { type: 'reload'; design: Design; version: number };

const clone = <T>(v: T): T => (v === undefined ? v : JSON.parse(JSON.stringify(v)));
export const opKey = (op: SchOp) => (op.kind === 'page' ? `page|${op.sch}|${op.page}` : `section|${op.name}`);

/** The folder / page name lists of a design. */
export function structureOf(d: Design): { name: string; pages: string[] }[] { return d.schematics.map((s) => ({ name: s.name, pages: s.pages.map((p) => p.name) })); }

function sectionValue(d: Design, name: SchSection): unknown {
  if (name === 'structure') return structureOf(d);
  return clone((d as unknown as Record<string, unknown>)[name]);
}

export function getCurrent(d: Design, op: SchOp): unknown {
  if (op.kind === 'section') return sectionValue(d, op.name);
  return clone(d.schematics.find((s) => s.name === op.sch)?.pages.find((p) => p.name === op.page) ?? null);
}

export function applySchOps(d: Design, ops: SchOp[]): void {
  // the folder / page structure first, so that page contents land in existing pages
  for (const op of ops) if (op.kind === 'section' && op.name === 'structure') {
    const want = op.value as { name: string; pages: string[] }[];
    const old = d.schematics;
    d.schematics = want.map((w) => {
      const prev = old.find((s) => s.name === w.name);
      return { name: w.name, pages: w.pages.map((pn) => prev?.pages.find((p) => p.name === pn) ?? emptyPage(pn)) };
    });
  }
  for (const op of ops) {
    if (op.kind === 'section') { if (op.name !== 'structure') (d as unknown as Record<string, unknown>)[op.name] = clone(op.value); continue; }
    let s = d.schematics.find((x) => x.name === op.sch);
    if (!s) { if (!op.obj) continue; s = { name: op.sch, pages: [] }; d.schematics.push(s); }
    const i = s.pages.findIndex((p) => p.name === op.page);
    if (!op.obj) { if (i >= 0) s.pages.splice(i, 1); continue; }
    if (i >= 0) s.pages[i] = clone(op.obj); else s.pages.push(clone(op.obj));
  }
  // ids handed out by any client stay unique
  let max = d.nextId;
  for (const s of d.schematics) for (const p of s.pages) for (const arr of Object.values(p)) if (Array.isArray(arr)) for (const o of arr as { id?: number }[]) if (typeof o?.id === 'number' && o.id >= max) max = o.id + 1;
  d.nextId = max;
}

const emptyPage = (name: string): Page => ({ name, size: 'A', parts: [], wires: [], buses: [], busEntries: [], junctions: [], aliases: [], globals: [], ports: [], offPages: [], noConnects: [], blocks: [], texts: [], graphics: [], bookmarks: [] });

/** Operations turning design a into design b. */
export function diffDesigns(a: Design, b: Design): SchOp[] {
  const ops: SchOp[] = [];
  const sa = JSON.stringify(structureOf(a)), sb = JSON.stringify(structureOf(b));
  if (sa !== sb) ops.push({ kind: 'section', name: 'structure', value: structureOf(b) });
  for (const name of SECTIONS) { if (name === 'structure') continue; if (JSON.stringify(sectionValue(a, name)) !== JSON.stringify(sectionValue(b, name))) ops.push({ kind: 'section', name, value: sectionValue(b, name) }); }
  const pagesA = new Map<string, Page>(); for (const s of a.schematics) for (const p of s.pages) pagesA.set(`${s.name}|${p.name}`, p);
  const seen = new Set<string>();
  for (const s of b.schematics) for (const p of s.pages) {
    const k = `${s.name}|${p.name}`; seen.add(k);
    const pa = pagesA.get(k);
    if (!pa || JSON.stringify(pa) !== JSON.stringify(p)) ops.push({ kind: 'page', sch: s.name, page: p.name, obj: clone(p) });
  }
  for (const [k] of pagesA) if (!seen.has(k)) { const [sch, page] = k.split('|'); ops.push({ kind: 'page', sch, page, obj: null }); }
  return ops;
}
