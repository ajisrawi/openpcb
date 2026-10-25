/**
 * OpenSchematic data model (OrCAD Capture DBO / System Capture counterpart).
 *
 * Units: mils (1/1000 inch), y grows downwards (schematic convention), default grid 100 mil.
 *
 *   Design            name, schematics (folders), root schematic, symbol libraries, variants, ERC matrix, settings
 *   Schematic         a folder of pages; a hierarchical block on another page refers to it by name
 *   Page              size, title block, and the objects: part instances, wires, buses, bus entries, junctions,
 *                     net aliases, globals (power / ground), ports (hierarchical), off-page connectors,
 *                     no-connects, hierarchical blocks, texts, graphics, bookmarks
 *   LibPart           a library part: units (sections A, B, ...), each with Normal and optional Convert (DeMorgan)
 *                     graphics and pins, a package (pin numbers per unit), properties (Value, PCB Footprint, ...)
 *   Occurrences       per hierarchical path: reference designators and property values of reused blocks
 */

export interface Pt { x: number; y: number }

export type PinType = 'input' | 'output' | 'bidirectional' | 'tristate' | 'passive' | 'power' | 'open_collector' | 'open_emitter' | 'unspecified' | 'no_connect';
export type PinShape = 'line' | 'dot' | 'clock' | 'dot_clock' | 'short' | 'zero' | 'input_low' | 'output_low';
export type Orient = 'left' | 'right' | 'up' | 'down';   // direction the pin points out of the body

export interface SymPin {
  number: string;                 // pad / pin number (per unit)
  name: string;
  type: PinType;
  x: number; y: number;           // connection point (pin tip), symbol-local mils
  length: number;
  orient: Orient;                 // the pin extends from (x,y) towards the body in the opposite direction
  shape?: PinShape;
  hidden?: boolean;               // hidden power pin: connects implicitly to the net named by `net`
  net?: string;
}

export type Graphic =
  | { kind: 'line'; pts: Pt[]; width?: number }
  | { kind: 'rect'; x1: number; y1: number; x2: number; y2: number; fill?: boolean }
  | { kind: 'circle'; c: Pt; r: number; fill?: boolean }
  | { kind: 'arc'; c: Pt; r: number; a0: number; a1: number }    // degrees, counter-clockwise on screen (y down => clockwise math)
  | { kind: 'polygon'; pts: Pt[]; fill?: boolean }
  | { kind: 'text'; at: Pt; text: string; size?: number; anchor?: 'start' | 'middle' | 'end'; rot?: number };

export interface SymbolView { graphics: Graphic[]; pins: SymPin[] }
export interface LibUnit { normal: SymbolView; convert?: SymbolView }

export interface LibPart {
  name: string;
  refPrefix: string;              // R, C, U, ...
  units: LibUnit[];               // sections A, B, ... (one for a single-unit part)
  props: Record<string, string>;  // Value, PCB Footprint, Description, Manufacturer, ...
  kind?: 'part' | 'power' | 'ground' | 'offpage' | 'port' | 'title';
  description?: string;
  /** pins of every unit that are swappable with each other (pin groups) */
  pinGroups?: string[][];
  /** SPICE model: element template, e.g. "R%r %1 %2 %v" or ".subckt" text */
  spice?: string;
  /** symbol display options (OrCAD part properties) */
  hidePinNames?: boolean;
  hidePinNumbers?: boolean;
}

export interface Library { name: string; parts: Record<string, LibPart> }

export interface PartInst {
  id: number;
  lib: string;                    // library name
  part: string;                   // library part name
  unit: number;                   // 0-based unit index
  convert?: boolean;              // DeMorgan view
  ref: string;                    // reference designator, e.g. "R12" ("R?" unannotated)
  x: number; y: number;
  rot: 0 | 90 | 180 | 270;
  mirror?: boolean;               // mirrored about the vertical axis
  props: Record<string, string>;  // instance properties override library properties (Value, PCB Footprint, ...)
  shownProps?: string[];          // properties displayed next to the part (default Ref + Value)
  dnp?: boolean;
  /** stable key of the instance in hierarchical paths (imported designs: "I505679610"); default: the reference */
  occKey?: string;
}

/** Path segment of an instance in occurrence keys. */
export const instSeg = (pi: { ref: string; occKey?: string }) => pi.occKey ?? pi.ref;

export interface Wire { id: number; pts: Pt[] }                       // orthogonal polyline
export interface Bus { id: number; pts: Pt[] }
export interface BusEntry { id: number; at: Pt; dir: 'ne' | 'nw' | 'se' | 'sw' }   // 100 mil diagonal from at
export interface Junction { id: number; at: Pt }
export interface NetAlias { id: number; at: Pt; name: string; rot?: 0 | 90; /** the wire it labels (else whatever wire passes through `at`) */ wire?: number }   // on a wire or bus; bus names like D[0..7]
export interface Global { id: number; at: Pt; net: string; style: 'power_bar' | 'power_arrow' | 'power_circle' | 'ground' | 'ground_signal' | 'ground_earth' | 'label'; rot?: 0 | 90 | 180 | 270 }
export interface Port { id: number; at: Pt; name: string; dir: 'input' | 'output' | 'bidirectional' | 'passive'; rot?: 0 | 180 }   // hierarchical port of the page's schematic
export interface OffPage { id: number; at: Pt; name: string; rot?: 0 | 180 }
export interface NoConnect { id: number; at: Pt }
export interface BlockPin { name: string; dir: Port['dir']; side: 'left' | 'right' | 'top' | 'bottom'; offset: number }   // offset along the side from the block's corner
export interface Block { id: number; ref: string; schematic: string; x: number; y: number; w: number; h: number; pins: BlockPin[] }
export interface SchText { id: number; at: Pt; text: string; size?: number; rot?: number }
export interface SchGraphic { id: number; g: Graphic }
export interface Bookmark { id: number; at: Pt; name: string }

export interface Page {
  name: string;
  size: 'A' | 'B' | 'C' | 'D' | 'E' | 'A4' | 'A3' | 'A2' | 'A1' | 'A0';
  title?: Record<string, string>;  // Title, Document Number, Revision, Date, Company, Sheet ...
  parts: PartInst[];
  wires: Wire[];
  buses: Bus[];
  busEntries: BusEntry[];
  junctions: Junction[];
  aliases: NetAlias[];
  globals: Global[];
  ports: Port[];
  offPages: OffPage[];
  noConnects: NoConnect[];
  blocks: Block[];
  texts: SchText[];
  graphics: SchGraphic[];
  bookmarks: Bookmark[];
}

export interface Schematic { name: string; pages: Page[] }

export interface Variant { name: string; dnp: string[]; values?: Record<string, string> }

/** Constraint manager data carried by the schematic (Allegro System Capture / Constraint Manager): forwarded to the
 *  board as net rules, net classes, differential pairs and match groups. Lengths and widths in mm. */
export interface NetConstraint { class?: string; width?: number; clearance?: number; minLength?: number; maxLength?: number; current?: number; voltage?: number; impedance?: number; diffPair?: string; matchGroup?: string }
export interface ClassConstraint { name: string; width?: number; clearance?: number; diffGap?: number; layers?: string[]; viaTypes?: string[]; priority?: number }
export interface PairConstraint { name: string; gap: number; tolerance: number; maxUncoupled: number; maxSkew: number }
export interface MatchGroup { name: string; tolerance: number }
export interface Constraints { nets: Record<string, NetConstraint>; classes: ClassConstraint[]; pairs: PairConstraint[]; groups: MatchGroup[] }

export interface Occurrence { path: string; ref?: string; unit?: number; props?: Record<string, string> }   // path: "BLOCK1/U3" style; unit: per-occurrence section of a reused block's part

export interface Design {
  name: string;
  version: 1;
  root: string;                   // root schematic name
  schematics: Schematic[];
  libraries: Library[];
  variants: Variant[];
  occurrences: Record<string, Occurrence>;   // key: hierarchical instance path "U1" / "AMP1/U2"
  erc?: ErcMatrixOverride;
  constraints?: Constraints;
  settings: { grid: number; titleDefaults?: Record<string, string>; /** OrCAD net names: within a folder, aliases, ports and off-page connectors of the same name are one net; such a name equal to a power net's joins it */ orcadNames?: boolean };
  nextId: number;
  /** Cross-reference to the board: footprint / pin swaps applied by back-annotation, last forward-annotation time */
  boardLink?: { project?: string; lastSync?: string };
}

export type ErcMatrixOverride = Partial<Record<PinType, Partial<Record<PinType, 'ok' | 'warning' | 'error'>>>>;

export const PAGE_SIZES: Record<Page['size'], { w: number; h: number }> = {
  A: { w: 11000, h: 8500 }, B: { w: 17000, h: 11000 }, C: { w: 22000, h: 17000 }, D: { w: 34000, h: 22000 }, E: { w: 44000, h: 34000 },
  A4: { w: 11693, h: 8268 }, A3: { w: 16535, h: 11693 }, A2: { w: 23386, h: 16535 }, A1: { w: 33110, h: 23386 }, A0: { w: 46811, h: 33110 },
};

export function newPage(name: string, size: Page['size'] = 'A'): Page {
  return { name, size, title: { Title: name, Revision: '1', Date: new Date().toISOString().slice(0, 10) }, parts: [], wires: [], buses: [], busEntries: [], junctions: [], aliases: [], globals: [], ports: [], offPages: [], noConnects: [], blocks: [], texts: [], graphics: [], bookmarks: [] };
}

export function newDesign(name = 'design'): Design {
  return { name, version: 1, root: 'SCHEMATIC1', schematics: [{ name: 'SCHEMATIC1', pages: [newPage('PAGE1')] }], libraries: [], variants: [], occurrences: {}, settings: { grid: 100 }, nextId: 1 };
}

export function nid(d: Design): number { return d.nextId++; }

/** Fill fields missing from designs saved by older versions. */
export function normalizeDesign(d: Design): Design {
  d.libraries ??= []; d.variants ??= []; d.occurrences ??= {}; d.settings ??= { grid: 100 }; d.nextId ??= 1;
  for (const s of d.schematics) for (const p of s.pages) {
    for (const k of ['parts', 'wires', 'buses', 'busEntries', 'junctions', 'aliases', 'globals', 'ports', 'offPages', 'noConnects', 'blocks', 'texts', 'graphics', 'bookmarks'] as (keyof Page)[]) (p as unknown as Record<string, unknown[]>)[k] ??= [];
    for (const k of ['parts', 'wires', 'buses', 'busEntries', 'junctions', 'aliases', 'globals', 'ports', 'offPages', 'noConnects', 'blocks', 'texts', 'graphics', 'bookmarks'] as (keyof Page)[]) for (const o of (p as unknown as Record<string, { id: number }[]>)[k]) if (o.id >= d.nextId) d.nextId = o.id + 1;
  }
  return d;
}

export function libPart(d: Design, lib: string, part: string): LibPart | undefined {
  return d.libraries.find((l) => l.name === lib)?.parts[part] ?? d.libraries.flatMap((l) => Object.values(l.parts)).find((p) => p.name === part);
}

/** Effective property of an instance (instance value, else library value). */
export function propOf(d: Design, pi: PartInst, key: string): string | undefined { return pi.props[key] ?? libPart(d, pi.lib, pi.part)?.props[key]; }

/** Symbol-local -> page coordinates for an instance (rotation counter-clockwise on screen, mirror about x = 0 first). */
export function toPage(pi: { x: number; y: number; rot: number; mirror?: boolean }, q: Pt): Pt {
  const m = pi.mirror ? { x: -q.x, y: q.y } : q;
  // y grows downwards: a counter-clockwise screen rotation by r is (x, y) -> (x cos + y sin, -x sin + y cos)
  const r = (pi.rot * Math.PI) / 180, c = Math.round(Math.cos(r)), s = Math.round(Math.sin(r));
  return { x: pi.x + m.x * c + m.y * s, y: pi.y - m.x * s + m.y * c };
}

/** The view (Normal / Convert) of a unit. */
export function viewOf(lp: LibPart, unit: number, convert?: boolean): SymbolView { const u = lp.units[Math.min(unit, lp.units.length - 1)]; return convert && u.convert ? u.convert : u.normal; }

/** Connection points of an instance: page coordinates of its visible pins. */
export function instPins(d: Design, pi: PartInst): { pin: SymPin; at: Pt }[] {
  const lp = libPart(d, pi.lib, pi.part); if (!lp) return [];
  return viewOf(lp, pi.unit, pi.convert).pins.map((pin) => ({ pin, at: toPage(pi, pin) }));
}

/** Unit letter: 0 -> A. */
export const unitLetter = (u: number) => String.fromCharCode(65 + u);

export function allPages(d: Design): { sch: Schematic; page: Page }[] { return d.schematics.flatMap((sch) => sch.pages.map((page) => ({ sch, page }))); }
export function schematicOf(d: Design, name: string): Schematic | undefined { return d.schematics.find((s) => s.name === name); }
