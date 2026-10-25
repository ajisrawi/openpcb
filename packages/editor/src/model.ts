/**
 * OpenBoard project model. All geometry is in millimetres; the DSN exporter
 * converts to micrometres (resolution um 1) for the router.
 */
export interface Pt { x: number; y: number; }

export type PadShape = 'rect' | 'circle' | 'oval';
export interface Pad {
  id: string;
  x: number; y: number;        // mm, footprint-local
  w: number; h: number;        // mm
  shape: PadShape;
  th: boolean;                 // through-hole (copper on all layers)
  drill?: number;
  rot?: number;                // pad rotation inside the footprint, degrees (multiples of 90 are stored as swapped w/h)
  swap?: string;               // pin-swap group: pins of one part with the same group are electrically interchangeable
  npth?: boolean;              // non-plated hole (mounting/tooling): a drill with no copper on any layer
}

export interface Footprint {
  name: string;
  pads: Pad[];
  outline: Pt[][];             // polylines, mm
  body: { w: number; h: number };
  outlineKind?: 'silk' | 'reference';   // 'reference': imported graphics of unknown layer (courtyard/fab), not checked as silkscreen
  height?: number;             // body height above the board, mm (3D view, height checks, STEP/IDF)
  gateSwap?: string;           // parts with the same gateSwap tag and footprint may swap places (component swap)
}

export interface LayerDef {
  name: string;
  type: 'signal' | 'power';
  color: string;
  direction: 'horizontal' | 'vertical' | 'off';
  visible: boolean;
  copper?: number;             // copper thickness, mm (default 0.035 outer, 0.0175 inner): IR drop, current capacity
  dielectric?: number;         // dielectric thickness to the next layer down, mm (stack-up drawing, impedance)
  er?: number;                 // relative permittivity of that dielectric (default 4.3, FR-4)
  lossTangent?: number;        // its loss tangent (default 0.02)
  mask?: { thickness: number; er: number };   // solder mask over an outer layer (field solver), default 0.02 mm / 3.5
}

export interface Component {
  ref: string;
  footprint: string;
  value: string;
  x: number; y: number;        // mm
  rot: number;                 // degrees
  side: 'front' | 'back';
  locked?: boolean;
  height?: number;             // overrides the footprint body height, mm
  power?: number;              // dissipated power, W (thermal analysis)
}

export interface NetDef {
  name: string;
  pins: string[];              // "REF-PAD"
  width?: number;              // mm override
  clearance?: number;          // mm override
  color?: string;
  minLength?: number;          // routed length limits, mm
  maxLength?: number;
  current?: number;            // design current, A (trace width / temperature-rise check, IR drop loads)
}

/** Net class: shared physical rules for a group of nets (Allegro Constraint Manager physical/spacing class). */
export interface NetClass {
  name: string;
  nets: string[];
  width?: number;              // mm
  clearance?: number;          // mm, to every other net
  viaTypes?: string[];         // allowed via padstack names (Via[a-b]_d:d_um); empty = all
  layers?: string[];           // allowed routing layers; empty = all
  priority?: number;           // routing order (higher first)
  diffGap?: number;            // coupled gap for pairs of this class, mm
}

/** Spacing between two classes (Allegro class-to-class spacing). */
export interface ClassClearance { a: string; b: string; clearance: number; }

/** Constraint region: inside the polygon the width/clearance (optionally only for some classes) change. */
export interface RuleRegion { id: number; name: string; points: Pt[]; width?: number; clearance?: number; classes?: string[]; }

/** Free text on a silkscreen, fabrication or copper layer (stroke font). */
export interface TextItem { id: number; text: string; x: number; y: number; size: number; rot: number; layer: string; }

/** Linear dimension from a to b, drawn offset by `offset` mm on a documentation layer. */
export interface Dimension { id: number; a: Pt; b: Pt; offset: number; layer: string; }

/** Placement room: parts listed in refs are kept inside the rectangle by autoplace. */
export interface Room { id: number; name: string; rect: { x1: number; y1: number; x2: number; y2: number }; side: 'front' | 'back' | 'both'; refs: string[]; }

/** Assembly variant: parts not fitted and value substitutions. */
export interface Variant { name: string; dnp: string[]; values?: Record<string, string>; }

/** Reusable via structure (via + escape traces), positions relative to the origin. */
export interface ViaStructure { name: string; vias: { x: number; y: number; diameter: number; drill: number; from?: string; to?: string }[]; traces: { layer: string; width: number; points: Pt[] }[]; }

/** Backdrill: through vias of these nets get their unused stub drilled out from one side. */
export interface Backdrill { nets: string[]; side: 'top' | 'bottom'; mustNotCut?: string; oversize: number; }   // mustNotCut: the drill may not go through this layer

/** DC source / load for IR-drop analysis. */
export interface PowerSource { net: string; ref: string; voltage: number; }
export interface PowerLoad { net: string; ref: string; current: number; }

export interface Trace {
  id: number;
  net: string;
  layer: string;
  width: number;               // mm
  points: Pt[];
  locked?: boolean;            // user-drawn (protected) vs autorouted
}

export interface ViaDef {
  id: number;
  net: string;
  x: number; y: number;
  diameter: number;
  drill: number;
  from?: string; to?: string;  // layer names of a blind/buried span (inclusive); absent = through via
  locked?: boolean;
}

/** A via type the router may use: a padstack with a layer span (through, blind or buried). */
export interface ViaType {
  diameter: number; drill: number;
  from: string; to: string;    // layer names (inclusive span)
}

export interface Keepout {
  id: number;
  layer: string | 'all';
  kind: 'keepout' | 'via_keepout' | 'wire_keepout';
  rect: { x1: number; y1: number; x2: number; y2: number };
}

export interface Rules {
  width: number;               // mm
  clearance: number;           // mm
  viaDiameter: number;
  viaDrill: number;
  edgeClearance: number;
  minTrackWidth: number;       // narrowest trace allowed
  minAnnularRing: number;      // (copper - drill) / 2 for pads and vias
  holeToCopper: number;        // drill edge to copper of another net
  holeToHole: number;          // drill edge to drill edge
  silkToCopper: number;        // silkscreen line to copper (pads) on the same side
  silkWidth: number;           // silkscreen line width
  maskExpansion: number;       // solder-mask opening grows the pad by this much
  minMaskSliver: number;       // narrowest mask web between two openings
  viaLength: number;           // length added per via for length rules (board thickness)
  viaTypes?: ViaType[];        // extra via spans (blind/buried/microvias); the default through via always exists
  minMicroviaDiameter: number; // microvia (span of two adjacent layers) minimum sizes
  minMicroviaDrill: number;
  laserHoleToCopper: number;   // blind (laser-drilled) via hole edge to other-net copper
  laserHoleToHole: number;     // blind via hole edge to any other hole edge, different nets
  laserHoleToHoleSameNet: number; // same, same net (stacked vias at one position are allowed)
  parallelGap: number;         // crosstalk: traces of two nets on one layer closer than this (edge to edge) …
  parallelLimit: number;       // … for longer than this in total are reported (0 = check off)
  tandemGap: number;           // same for traces stacked on adjacent copper layers (horizontal offset)
  tandemLimit: number;
  maxHeightTop?: number;       // tallest part allowed on the top / bottom side, mm (3D clearance check; 0/absent = off)
  maxHeightBottom?: number;
  silkClip?: boolean;          // clip the silkscreen at pads and holes in the Gerber legend (default on)
  thieving?: { pitch: number; size: number; clearance: number };   // copper thieving dots on the outer layers (Gerber only)
}

/** Differential pair constraint between two nets. */
export interface DiffPair {
  name: string;
  p: string; n: string;        // net names
  gap: number;                 // edge-to-edge gap, mm
  tolerance: number;           // allowed gap deviation, mm
  maxUncoupled: number;        // total uncoupled length allowed, mm
  maxSkew: number;             // allowed length mismatch, mm
}

/** Nets whose routed lengths must match within a tolerance. */
export interface LengthGroup { name: string; nets: string[]; tolerance: number; }

/** Copper pour. dynamic = re-filled around other copper by the host (no spacing DRC);
 *  static = fixed copper that other nets must keep `clearance` from. */
export interface Zone {
  id: number;
  net: string;
  layer: string;
  points: Pt[];
  clearance: number;
  dynamic: boolean;
}

export interface Project {
  name: string;
  version: 1;
  layers: LayerDef[];
  outline: Pt[];               // mm, closed polygon
  footprints: Record<string, Footprint>;
  components: Component[];
  nets: NetDef[];
  rules: Rules;
  traces: Trace[];
  vias: ViaDef[];
  keepouts: Keepout[];
  zones: Zone[];
  diffPairs: DiffPair[];
  lengthGroups: LengthGroup[];
  nextId: number;
  netClasses?: NetClass[];
  classClearances?: ClassClearance[];
  regions?: RuleRegion[];
  texts?: TextItem[];
  dimensions?: Dimension[];
  rooms?: Room[];
  variants?: Variant[];
  structures?: ViaStructure[];
  waivers?: string[];          // DRC marker keys (kind|layer|x|y|message) accepted as waived
  backdrill?: Backdrill[];
  sources?: PowerSource[];
  loads?: PowerLoad[];
  tuneBackup?: Record<string, Trace[]>;   // copper of tuned nets before tuning (Remove Tuning restores it)
  cutouts?: Pt[][];            // extra milled paths on the outline layer (panel: each board's outline; V-score lines)
  rfElements?: RfElement[];    // parametric RF copper (lines, stubs, tapers, coupled lines), drawn as static zones
  voids?: Void[];              // pour cut-outs (RF ground voids)
  bondWires?: BondWire[];      // wire bonds (die pad -> bond finger / die pad)
  bondProfiles?: BondProfile[];
  flexZones?: FlexZone[];      // rigid-flex: areas with their own layer stack
  bends?: BendArea[];          // bend areas of flex zones (3D folding, bend rules)
  stiffeners?: Stiffener[];
}

/** Parametric RF element (RF PCB). */
export interface RfElement { id: number; kind: 'line' | 'stub' | 'radial' | 'taper' | 'coupled'; net: string; layer: string; params: Record<string, unknown>; zoneIds: number[]; info: Record<string, number> }
/** Pour cut-out: no pour copper inside the polygon on that layer. */
export interface Void { id: number; layer: string; points: Pt[]; note?: string }
/** A wire bond. `from`/`to` are a part pad (die pad or bond finger) or a free point on a layer (finger copper). */
export interface BondWire { id: number; net: string; from: { ref: string; pad: string }; to: { ref: string; pad: string } | { x: number; y: number; layer: string }; diameter: number; profile?: string; material?: 'Au' | 'Cu' | 'Al' | 'Ag' }
/** JEDEC-style 4-point loop: height above the die pad, the kink distance, and the landing angle. */
export interface BondProfile { name: string; loopHeight: number; kink: number; landingAngle: number; dieHeight?: number }
/** Rigid-flex zone: the copper layers present there; coverlay instead of solder mask on flex. */
export interface FlexZone { id: number; name: string; points: Pt[]; layers: string[]; coverlay?: boolean; thickness?: number }
/** Bend area: the strip that bends, its axis (line), angle (degrees, + folds the far side towards the top) and inner radius. */
export interface BendArea { id: number; name: string; points: Pt[]; axis: [Pt, Pt]; angle: number; radius: number; dynamic?: boolean }
export interface Stiffener { id: number; side: 'front' | 'back'; points: Pt[]; thickness: number; material: string }

export function defaultRules(): Rules {
  return { width: 0.25, clearance: 0.2, viaDiameter: 0.8, viaDrill: 0.4, edgeClearance: 0.5,
    minTrackWidth: 0.1, minAnnularRing: 0.1, holeToCopper: 0.25, holeToHole: 0.25, silkToCopper: 0.15, silkWidth: 0.15,
    maskExpansion: 0.05, minMaskSliver: 0.1, viaLength: 1.6, minMicroviaDiameter: 0.2, minMicroviaDrill: 0.1, laserHoleToCopper: 0.15, laserHoleToHole: 0.24, laserHoleToHoleSameNet: 0.13, parallelGap: 0, parallelLimit: 0, tandemGap: 0, tandemLimit: 0 };
}

/** Fill fields missing from projects saved by older versions. */
export function normalizeProject(p: Project): Project {
  p.rules = { ...defaultRules(), ...(p.rules ?? {}) };
  p.zones ??= []; p.diffPairs ??= []; p.lengthGroups ??= []; p.keepouts ??= []; p.vias ??= []; p.traces ??= [];
  p.footprints ??= {}; p.nets ??= []; p.components ??= [];
  p.nextId ??= 1;
  p.netClasses ??= []; p.classClearances ??= []; p.regions ??= []; p.texts ??= []; p.dimensions ??= []; p.rooms ??= [];
  p.variants ??= []; p.structures ??= []; p.waivers ??= []; p.backdrill ??= []; p.sources ??= []; p.loads ??= [];
  p.rfElements ??= []; p.voids ??= []; p.bondWires ??= []; p.bondProfiles ??= []; p.flexZones ??= []; p.bends ??= []; p.stiffeners ??= [];
  for (const arr of [p.traces, p.vias, p.keepouts, p.zones, p.regions, p.texts, p.dimensions, p.rooms, p.rfElements, p.voids, p.bondWires, p.flexZones, p.bends, p.stiffeners] as { id: number }[][]) for (const o of arr) if (o.id >= p.nextId) p.nextId = o.id + 1;
  return p;
}

/** The net class a net belongs to (first class listing it). */
export function classOf(p: Project, net: string): NetClass | undefined { return p.netClasses?.find((c) => c.nets.includes(net)); }
/** Effective width / clearance of a net: net override, then its class, then the board rule. */
export function netWidth(p: Project, net: string): number { return findNet(p, net)?.width ?? classOf(p, net)?.width ?? p.rules.width; }
export function netClearance(p: Project, net: string): number { return findNet(p, net)?.clearance ?? classOf(p, net)?.clearance ?? p.rules.clearance; }
/** Copper thickness of a layer, mm. */
export function copperOf(p: Project, layer: string): number { const i = layerIndexOf(p, layer); const l = p.layers[i]; return l?.copper ?? (i === 0 || i === p.layers.length - 1 ? 0.035 : 0.0175); }
/** Body height of a placed part, mm. */
export function heightOf(p: Project, c: Component): number { return c.height ?? p.footprints[c.footprint]?.height ?? 1; }
/** Stable key of a DRC marker, used for waivers. */
export function drcKey(m: { kind: string; layer: string; at: Pt; message: string }): string { return `${m.kind}|${m.layer}|${m.at.x.toFixed(3)}|${m.at.y.toFixed(3)}|${m.message}`; }

export const LAYER_COLORS = ['#e8492f', '#2fa3e8', '#e8c22f', '#7fe82f', '#c62fe8', '#2fe8d0'];

export function newProject(name = 'untitled', layerCount = 2): Project {
  const names = layerCount === 4 ? ['F.Cu', 'In1.Cu', 'In2.Cu', 'B.Cu'] : ['F.Cu', 'B.Cu'];
  return {
    name, version: 1,
    layers: names.map((n, i) => ({ name: n, type: 'signal', color: LAYER_COLORS[i % LAYER_COLORS.length], direction: i % 2 === 0 ? 'horizontal' : 'vertical', visible: true })),
    outline: [{ x: 0, y: 0 }, { x: 80, y: 0 }, { x: 80, y: 60 }, { x: 0, y: 60 }],
    footprints: {},
    components: [],
    nets: [],
    rules: defaultRules(),
    traces: [], vias: [], keepouts: [], zones: [], diffPairs: [], lengthGroups: [],
    nextId: 1,
  };
}

export function nextId(p: Project): number { return p.nextId++; }

/** Rotate/mirror/translate a footprint-local point to board space. */
/** Orientation of a placed pad on the board, degrees: the footprint's pad rotation, mirrored on the bottom side,
 *  plus the part rotation. (A rectangle is symmetric under the bottom-side mirror, so only the pad's own angle flips.) */
export function padAngle(c: { rot: number; side: 'front' | 'back' }, pad: { rot?: number }): number {
  return c.side === 'back' ? c.rot - (pad.rot ?? 0) : c.rot + (pad.rot ?? 0);
}

export function padToBoard(c: Component, p: Pt): Pt {
  const m = c.side === 'back' ? { x: -p.x, y: p.y } : p;
  const r = (c.rot * Math.PI) / 180;
  const cs = Math.cos(r), sn = Math.sin(r);
  return { x: c.x + m.x * cs - m.y * sn, y: c.y + m.x * sn + m.y * cs };
}

/** Copper layers a pad touches (names). Back-side components mirror the stack. */
export function padLayers(p: Project, c: Component, pad: Pad): string[] {
  if (pad.npth) return [];
  if (pad.th) return p.layers.filter((l) => l.type === 'signal').map((l) => l.name);
  const idx = c.side === 'front' ? 0 : p.layers.length - 1;
  return [p.layers[idx].name];
}

export function netOfPin(p: Project, ref: string, padId: string): NetDef | undefined {
  const key = `${ref}-${padId}`;
  return p.nets.find((n) => n.pins.includes(key));
}

export function findNet(p: Project, name: string): NetDef | undefined { return p.nets.find((n) => n.name === name); }

export function uniqueRef(p: Project, prefix: string): string {
  let i = 1;
  while (p.components.some((c) => c.ref === `${prefix}${i}`)) i++;
  return `${prefix}${i}`;
}

/* ---------- via spans ---------- */

/** Index of a layer name in the stack (-1 when unknown). */
export function layerIndexOf(p: Project, name: string): number { return p.layers.findIndex((l) => l.name === name); }

/** Every via type of a project: the through via from the rules first, then the declared spans. */
export function viaTypesOf(p: Project): ViaType[] {
  const through: ViaType = { diameter: p.rules.viaDiameter, drill: p.rules.viaDrill, from: p.layers[0].name, to: p.layers[p.layers.length - 1].name };
  const extra = (p.rules.viaTypes ?? []).filter((v) => layerIndexOf(p, v.from) >= 0 && layerIndexOf(p, v.to) >= 0);
  return [through, ...extra];
}

/** KiCad-style padstack name of a via type: Via[from-to]_<diameter>:<drill>_um. */
export function viaTypeName(p: Project, vt: ViaType): string {
  const a = layerIndexOf(p, vt.from), b = layerIndexOf(p, vt.to);
  const um = (v: number) => Math.round(v * 1000);
  return `Via[${Math.min(a, b)}-${Math.max(a, b)}]_${um(vt.diameter)}:${um(vt.drill)}_um`;
}

/** Layer names a via (or via type) spans; all layers for a through via. */
export function viaLayers(p: Project, v: { from?: string; to?: string }): string[] {
  if (!v.from || !v.to) return p.layers.map((l) => l.name);
  let a = layerIndexOf(p, v.from), b = layerIndexOf(p, v.to);
  if (a < 0 || b < 0) return p.layers.map((l) => l.name);
  if (a > b) [a, b] = [b, a];
  return p.layers.slice(a, b + 1).map((l) => l.name);
}

/** True when the via spans exactly two adjacent layers (a microvia). */
export function isMicrovia(p: Project, v: { from?: string; to?: string }): boolean { return viaLayers(p, v).length === 2 && p.layers.length > 2; }

/** Parse a KiCad-style via padstack name into a span (layer indices) and sizes in mm. */
export function parseViaName(name: string): { b0: number; b1: number; diameter: number; drill: number } | null {
  const m = /Via\[(\d+)-(\d+)\]_(\d+(?:\.\d+)?):(\d+(?:\.\d+)?)_um/.exec(name);
  if (!m) return null;
  return { b0: Number(m[1]), b1: Number(m[2]), diameter: Number(m[3]) / 1000, drill: Number(m[4]) / 1000 };
}
