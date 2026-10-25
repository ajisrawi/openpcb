/**
 * In-memory model of a SPECCTRA design (.dsn) — the subset needed for routing.
 * Coordinates are stored in *resolution units* (integers) exactly as the file
 * declares them; `Design.resolution` gives the unit and divisor.
 *
 * This mirrors the top-level prototype of the Design Language Reference:
 *   (pcb id (parser) (resolution) (unit) (structure) (placement) (library) (network) (wiring))
 */
import type { Pt } from './geom.js';

export type LayerType = 'signal' | 'power' | 'mixed' | 'jumper';
export type Direction = 'horizontal' | 'vertical' | 'orthogonal' | 'diagonal' | 'off' | 'positive_diagonal' | 'negative_diagonal';
export type Side = 'front' | 'back';

export interface Resolution { unit: string; value: number; }

export interface Layer {
  name: string;
  type: LayerType;
  direction: Direction;
  index: number;          // 0 = top (first listed)
  /** optional per-layer rule overrides */
  rule?: RuleSet;
}

/** Clearance rule keyed by object-pair type, e.g. 'wire_wire', 'default'. */
export interface RuleSet {
  width?: number;
  clearance: Map<string, number>;   // key = clearance type ('default', 'wire_wire', 'smd_via', ...)
}

export type ShapeKind = 'circle' | 'rect' | 'path' | 'polygon';
export interface Shape {
  kind: ShapeKind;
  layer: string;        // layer name, or 'signal'/'power'/'pcb' for all-layer shapes
  /** circle: diameter; path: aperture width */
  diameter?: number;
  width?: number;
  /** circle: center offset; rect: corners; path/polygon: vertices */
  center?: Pt;
  rect?: { x1: number; y1: number; x2: number; y2: number };
  points?: Pt[];
}

export interface Padstack {
  name: string;
  shapes: Shape[];
  attach: boolean;      // (attach off) => via may not be placed on the pad
}

export interface ImagePin {
  padstack: string;
  pinId: string;
  at: Pt;
  rotation: number;     // degrees, (rotate <deg>) on the pin
}

export interface Image {
  name: string;
  side?: Side;
  outline: Shape[];
  pins: ImagePin[];
  keepouts: Keepout[];
}

export interface Placement {
  image: string;
  ref: string;          // reference designator
  at: Pt;
  side: Side;
  rotation: number;
  locked: boolean;
  partNumber?: string;
}

export interface Keepout {
  kind: 'keepout' | 'via_keepout' | 'wire_keepout' | 'place_keepout';
  id?: string;
  shape: Shape;
}

export interface Boundary { shape: Shape; }

export interface ClassDef {
  name: string;
  nets: string[];
  rule?: RuleSet;
  circuit?: Circuit;
  layerRules?: Map<string, RuleSet>;   // (layer_rule <layer> (rule …))
}

export interface Circuit {
  useVia?: string[];
  useLayer?: string[];
  priority?: number;
  maxTotalVias?: number;               // (max_total_vias n)
  matchNetLength?: { tolerance?: number };   // (match_net_length on (tolerance t)) on a class: all its nets equal length
  bus?: boolean;                       // (bus on) on a class: its nets are routed side by side in class order
  length?: { max?: number; min?: number };   // (length <max> [<min>]), resolution units
}

/** (fromto <pinA> <pinB> (rule …) (circuit …)) — rules for one pin-to-pin connection of a net. */
export interface FromTo { a: string; b: string; rule?: RuleSet; circuit?: Circuit }

export interface Net {
  name: string;
  pins: string[];       // "REF-PIN"
  className?: string;
  rule?: RuleSet;
  circuit?: Circuit;
  layerRules?: Map<string, RuleSet>;   // (layer_rule <layer> (rule …))
  fromtos?: FromTo[];
}

/** (pair (nets P N) (rule (gap g) (tolerance t))): a differential pair routed coupled and skew-matched. */
export interface PairDef { p: string; n: string; gap?: number; tolerance?: number }

/** (class_class (classes A B …) (rule …)): rules between nets of different classes in the list. */
export interface ClassClassRule { classes: string[]; rule: RuleSet }

/** (region <id> <shape> (rule …)): rules inside an area of the board (e.g. a BGA neck-down region). */
export interface Region { id: string; shape: Shape; rule?: RuleSet; classRules?: { classes: string[]; rule: RuleSet }[] }

export interface Wire {
  layer: string;
  width: number;
  points: Pt[];
  net: string;
  type?: 'fix' | 'route' | 'normal' | 'protect';
}

export interface Via {
  padstack: string;
  at: Pt;
  net: string;
  type?: 'fix' | 'route' | 'normal' | 'protect';
}

export interface Design {
  id: string;
  parser: {
    stringQuote: string;
    spaceInQuotedTokens: boolean;
    hostCad?: string;
    hostVersion?: string;
    constants: Map<string, string>;
    writeResolution?: Resolution;
    caseSensitive: boolean;
  };
  resolution: Resolution;
  unit: string;
  structure: {
    layers: Layer[];
    boundary: Boundary[];
    rule: RuleSet;
    vias: string[];          // padstack names usable as vias
    keepouts: Keepout[];
    gridWire?: number;
    gridVia?: number;
    planes: { net: string; shape: Shape }[];
    regions?: Region[];
    control: Map<string, string>;
  };
  placement: Placement[];
  library: { images: Map<string, Image>; padstacks: Map<string, Padstack> };
  network: { nets: Map<string, Net>; classes: Map<string, ClassDef>; classClass?: ClassClassRule[]; pairs?: PairDef[] };
  wiring: { wires: Wire[]; vias: Via[] };
}

export function emptyRuleSet(): RuleSet { return { clearance: new Map() }; }

export function emptyDesign(id = 'board'): Design {
  return {
    id,
    parser: { stringQuote: '"', spaceInQuotedTokens: true, constants: new Map(), caseSensitive: true },
    resolution: { unit: 'um', value: 10 },
    unit: 'um',
    structure: { layers: [], boundary: [], rule: emptyRuleSet(), vias: [], keepouts: [], planes: [], control: new Map() },
    placement: [],
    library: { images: new Map(), padstacks: new Map() },
    network: { nets: new Map(), classes: new Map() },
    wiring: { wires: [], vias: [] },
  };
}

/** Conversion factor: how many resolution units in one of the named unit. */
export function unitToResolution(unit: string, res: Resolution): number {
  return unitInMm(unit) / unitInMm(res.unit) * res.value;
}

export function unitInMm(unit: string): number {
  switch (unit.toLowerCase()) {
    case 'inch': case 'in': case 'i': return 25.4;
    case 'mil': return 0.0254;
    case 'cm': return 10;
    case 'mm': return 1;
    case 'um': case 'micron': case 'microns': return 0.001;
    default: return 1;
  }
}

/* ---------- session (.ses) model ---------- */

export interface SessionRoutes {
  resolution: Resolution;
  nets: Map<string, { wires: Wire[]; vias: Via[] }>;
  padstacks: Padstack[];        // library_out padstacks used by vias
}

export interface Session {
  id: string;
  baseDesign: string;
  placement?: Placement[];
  routes: SessionRoutes;
}
