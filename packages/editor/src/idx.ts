/**
 * ProSTEP iViP IDX (EDMD 3.0) ECAD-MCAD collaboration.
 *
 *   exportIdx         baseline (EDMDProcessInstructionSendInformation): board outline extrusion, plated and
 *                     non-plated component holes as inverted shapes, one package item per footprint (body outline x
 *                     height, local coordinates) and one placed instance per part (2D transformation, AssembleToName
 *                     TOP/BOTTOM, REFDES user property), keep-out rooms as KEEPOUT_AREA_COMPONENT.
 *   exportIdxChanges  incremental message (EDMDProcessInstructionSendChanges): parts added, removed or moved
 *                     between two versions of the board, as computational:Change records.
 *   importIdx         reads a baseline or change message (ours or an MCAD system's) and applies part positions,
 *                     rotations and sides, and a new board outline, back onto the project.
 *
 * Element and attribute names follow the EDMD 3.0 schema (the same names Allegro's own IDX implementation uses).
 */
import { type Project, type Pt, heightOf } from './model.js';
import { defaultLibrary } from './footprints.js';
import { drillHoles } from './fab.js';
import { parseXml, type XmlNode } from './imports.js';

const V = '3.0';
const NS: Record<string, string> = {
  foundation: `http://www.prostep.org/ecad-mcad/edmd/${V}/foundation`,
  pdm: `http://www.prostep.org/ecad-mcad/edmd/${V}/pdm`,
  d2: `http://www.prostep.org/ecad-mcad/edmd/${V}/geometry.d2`,
  property: `http://www.prostep.org/ecad-mcad/edmd/${V}/property`,
  computational: `http://www.prostep.org/ecad-mcad/edmd/${V}/computational`,
  administration: `http://www.prostep.org/ecad-mcad/edmd/${V}/administration`,
};
/** Every element/attribute name this module writes (checked against the EDMD vocabulary by the tests). */
export const IDX_NAMES = new Set<string>();
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const n6 = (v: number) => String(Math.round(v * 1e6) / 1e6);

class W {
  body: string[] = [];
  private id = 0;
  nid(p: string) { return `${p}_${++this.id}`; }
  el(name: string, inner: string, attrs = ''): string { IDX_NAMES.add(name); return `<${name}${attrs}>${inner}</${name}>`; }
  val(name: string, v: number | string) { return this.el(name, this.el('property:Value', String(v))); }
  point(q: Pt): string { const i = this.nid('PT'); this.body.push(`    ${this.el('foundation:CartesianPoint', this.val('d2:X', n6(q.x)) + this.val('d2:Y', n6(q.y)), ` id="${i}" xsi:type="d2:EDMDCartesianPoint"`)}`); return i; }
  polyline(pts: Pt[]): string { const ids = pts.map((q) => this.point(q)); const i = this.nid('PL'); this.body.push(`    ${this.el('foundation:PolyLine', [...ids, ids[0]].map((x) => this.el('d2:Point', x)).join(''), ` id="${i}" xsi:type="d2:EDMDPolyLine"`)}`); return i; }
  circle(c: Pt, d: number): string { const pc = this.point(c); const i = this.nid('CC'); this.body.push(`    ${this.el('foundation:CircleCenter', this.el('d2:Center', pc) + this.val('d2:Diameter', n6(d)), ` id="${i}" xsi:type="d2:EDMDCircleCenter"`)}`); return i; }
  curveSet(curve: string, z0: number, z1: number): string { const i = this.nid('CS'); this.body.push(`    ${this.el('foundation:CurveSet2d', this.el('pdm:ShapeDescriptionType', 'GeometricModel') + this.val('d2:LowerBound', n6(z0)) + this.val('d2:UpperBound', n6(z1)) + this.el('d2:DetailedGeometricModelElement', curve), ` id="${i}" xsi:type="d2:EDMDCurveSet2d"`)}`); return i; }
  shape(cs: string, inverted = false): string { const i = this.nid('SH'); this.body.push(`    ${this.el('foundation:ShapeElement', this.el('pdm:ShapeElementType', 'FeatureShapeElement') + this.el('pdm:Inverted', String(inverted)) + this.el('pdm:DefiningShape', cs), ` id="${i}" xsi:type="pdm:EDMDShapeElement"`)}`); return i; }
  /** a single (definition) item with a shape */
  single(name: string, shape: string, extra = ''): string { const i = this.nid('ITEM'); this.body.push(`    ${this.el('foundation:Item', this.el('foundation:Name', esc(name)) + this.el('pdm:ItemType', 'single') + this.el('pdm:Shape', shape) + extra, ` id="${i}" xsi:type="pdm:EDMDItem"`)}`); return i; }
  /** an assembly item: one placed instance of a single item */
  instance(name: string, geometryType: string, single: string, tf: { x: number; y: number; rot: number; mirror: boolean }, extra = '', instanceExtra = ''): string {
    IDX_NAMES.add('geometryType');
    const a = (tf.rot * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a), m = tf.mirror ? -1 : 1;
    const t = this.el('pdm:Transformation', this.el('pdm:TransformationType', 'd2') + this.el('pdm:xx', n6(m * c)) + this.el('pdm:xy', n6(-s)) + this.el('pdm:yx', n6(m * s)) + this.el('pdm:yy', n6(c)) + this.val('pdm:tx', n6(tf.x)) + this.val('pdm:ty', n6(tf.y)));
    const inst = this.el('pdm:ItemInstance', this.el('pdm:Item', single) + this.el('pdm:InstanceName', this.el('foundation:SystemScope', 'OpenBoard') + this.el('foundation:ObjectName', esc(name))) + t + instanceExtra);
    const i = this.nid('ITEM');
    this.body.push(`    ${this.el('foundation:Item', this.el('foundation:Name', esc(name)) + this.el('pdm:ItemType', 'assembly') + inst + extra, ` id="${i}" xsi:type="pdm:EDMDItem" geometryType="${geometryType}"`)}`);
    return i;
  }
  userProp(key: string, value: string) { return this.el('foundation:UserProperty', this.el('property:Key', this.el('foundation:SystemScope', 'ECAD') + this.el('foundation:ObjectName', key)) + this.el('property:Value', esc(value)), ' xsi:type="property:EDMDUserSimpleProperty"'); }
}

const header = (w: W, p: Project, what: string) => w.el('foundation:Header', w.el('foundation:Description', esc(`${p.name} ${what}`)) + w.el('foundation:CreatorName', 'OpenBoard') + w.el('foundation:CreatorCompany', 'OpenBoard') + w.el('foundation:CreatorSystem', 'OpenBoard 0.1') + w.el('foundation:GlobalUnitLength', 'UNIT_MM') + w.el('foundation:CreationDateTime', new Date().toISOString()), ' xsi:type="foundation:EDMDHeader"');
const open = () => `<foundation:EDMDDataSet ${Object.entries(NS).map(([k, v]) => `xmlns:${k}="${v}"`).join(' ')} xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">`;

/** The items of a board (board, holes, packages, placed parts, keep-outs) into a writer; returns the part items by ref. */
function boardItems(w: W, p: Project, t: number, only?: Set<string>): Map<string, string> {
  const lib = { ...defaultLibrary(), ...p.footprints };
  const parts = new Map<string, string>();
  if (!only) {
    const b = w.single(`${p.name}_board`, w.shape(w.curveSet(w.polyline(p.outline), 0, t)));
    w.instance('BOARD', 'BOARD_OUTLINE', b, { x: 0, y: 0, rot: 0, mirror: false });
    for (const h of drillHoles(p)) {
      if (p.vias.some((v) => Math.abs(v.x - h.x) < 1e-9 && Math.abs(v.y - h.y) < 1e-9)) continue;   // vias are not mechanical holes
      const s = w.single(`HOLE_${n6(h.x)}_${n6(h.y)}`, w.shape(w.curveSet(w.circle({ x: h.x, y: h.y }, h.d), 0, t), true));
      w.instance(`HOLE_${n6(h.x)}_${n6(h.y)}`, h.plated ? 'HOLE_PLATED' : 'HOLE_NON_PLATED', s, { x: 0, y: 0, rot: 0, mirror: false });
    }
    for (const r of p.rooms ?? []) {
      const q = r.rect, pts = [{ x: q.x1, y: q.y1 }, { x: q.x2, y: q.y1 }, { x: q.x2, y: q.y2 }, { x: q.x1, y: q.y2 }];
      const s = w.single(`ROOM_${r.name}`, w.shape(w.curveSet(w.polyline(pts), 0, 25)));
      w.instance(`ROOM_${r.name}`, 'KEEPOUT_AREA_COMPONENT', s, { x: 0, y: 0, rot: 0, mirror: false });
    }
  }
  const pkg = new Map<string, string>();
  for (const c of p.components) {
    if (only && !only.has(c.ref)) continue;
    const fp = lib[c.footprint]; if (!fp) continue;
    const h = heightOf(p, c);
    const key = `${c.footprint}@${h}`;
    let s = pkg.get(key);
    if (!s) {
      const hw = fp.body.w / 2, hh = fp.body.h / 2;
      s = w.single(c.footprint, w.shape(w.curveSet(w.polyline([{ x: -hw, y: -hh }, { x: hw, y: -hh }, { x: hw, y: hh }, { x: -hw, y: hh }]), 0, h)), w.el('pdm:PackageName', w.el('foundation:SystemScope', 'OpenBoard') + w.el('foundation:ObjectName', esc(c.footprint))));
      pkg.set(key, s);
    }
    parts.set(c.ref, w.instance(c.ref, 'COMPONENT', s, { x: c.x, y: c.y, rot: c.rot, mirror: c.side === 'back' }, w.userProp('REFDES', c.ref) + w.userProp('VALUE', c.value ?? ''), w.el('pdm:AssembleToName', c.side === 'back' ? 'BOTTOM' : 'TOP')));
  }
  return parts;
}

export function exportIdx(p: Project, opts: { thickness?: number } = {}): string {
  const t = opts.thickness ?? (p.rules.viaLength || 1.6);
  const w = new W();
  boardItems(w, p, t);
  return ['<?xml version="1.0" encoding="UTF-8"?>', open(), `  ${header(w, p, 'baseline')}`,
    `  <foundation:Body xsi:type="foundation:EDMDDataSetBody">`, ...w.body, '  </foundation:Body>',
    `  ${w.el('foundation:ProcessInstruction', '', ' xsi:type="computational:EDMDProcessInstructionSendInformation"')}`.replace('></foundation:ProcessInstruction>', '/>'),
    '</foundation:EDMDDataSet>', ''].join('\n');
}

/** Incremental message: parts added, deleted or moved between `before` and `after`. */
export function exportIdxChanges(before: Project, after: Project, opts: { thickness?: number } = {}): { xml: string; added: string[]; removed: string[]; moved: string[] } {
  const t = opts.thickness ?? (after.rules.viaLength || 1.6);
  const was = new Map(before.components.map((c) => [c.ref, c]));
  const added: string[] = [], moved: string[] = [], removed: string[] = [];
  for (const c of after.components) { const o = was.get(c.ref); if (!o) added.push(c.ref); else if (Math.abs(o.x - c.x) > 1e-6 || Math.abs(o.y - c.y) > 1e-6 || o.rot !== c.rot || o.side !== c.side) moved.push(c.ref); }
  const now = new Set(after.components.map((c) => c.ref)); for (const c of before.components) if (!now.has(c.ref)) removed.push(c.ref);
  const w = new W();
  const oldItems = boardItems(w, before, t, new Set(moved));
  const newItems = boardItems(w, after, t, new Set([...moved, ...added]));
  const changes: string[] = [];
  for (const r of moved) changes.push(w.el('computational:Change', w.el('computational:PredecessorItem', oldItems.get(r)!) + w.el('computational:NewItem', newItems.get(r)!)));
  for (const r of added) changes.push(w.el('computational:Change', w.el('computational:NewItem', newItems.get(r)!)));
  for (const r of removed) changes.push(w.el('computational:Change', w.el('computational:DeletedInstanceName', w.el('foundation:SystemScope', 'OpenBoard') + w.el('foundation:ObjectName', esc(r)))));
  const pi = w.el('foundation:ProcessInstruction', w.el('computational:Changes', changes.join('')), ' xsi:type="computational:EDMDProcessInstructionSendChanges"');
  return { xml: ['<?xml version="1.0" encoding="UTF-8"?>', open(), `  ${header(w, after, 'changes')}`, `  <foundation:Body xsi:type="foundation:EDMDDataSetBody">`, ...w.body, '  </foundation:Body>', `  ${pi}`, '</foundation:EDMDDataSet>', ''].join('\n'), added, removed, moved };
}

/* ================================ import ================================ */

const local = (tag: string) => tag.replace(/^.*:/, '');
const kids = (n: XmlNode, name: string) => n.children.filter((c) => local(c.tag) === name);
const kid = (n: XmlNode, name: string) => kids(n, name)[0];
const text = (n: XmlNode | undefined): string => { if (!n) return ''; const t = (n as unknown as { text?: string }).text; if (t !== undefined) return t.trim(); return n.children.map(text).join('').trim(); };
const value = (n: XmlNode | undefined) => { if (!n) return NaN; const v = kid(n, 'Value'); return Number(text(v ?? n)); };

export interface IdxPlacement { ref: string; x: number; y: number; rot: number; side: 'front' | 'back' }

/** Placements (and the board outline, if present) read from an IDX message. */
export function readIdx(xml: string): { kind: 'baseline' | 'changes' | 'unknown'; placements: IdxPlacement[]; deleted: string[]; outline?: Pt[] } {
  const root = parseXml(xml);
  const ds = local(root.tag) === 'EDMDDataSet' ? root : root.children.find((c) => local(c.tag) === 'EDMDDataSet') ?? root;
  const body = kid(ds, 'Body'); if (!body) throw new Error('IDX: no Body');
  const byId = new Map<string, XmlNode>();
  const walk = (n: XmlNode) => { if (n.attrs.id) byId.set(n.attrs.id, n); n.children.forEach(walk); };
  walk(body);
  const pi = kid(ds, 'ProcessInstruction');
  const kind = /SendChanges/.test(pi?.attrs['xsi:type'] ?? '') ? 'changes' : /SendInformation/.test(pi?.attrs['xsi:type'] ?? '') ? 'baseline' : 'unknown';
  const placements: IdxPlacement[] = []; const deleted: string[] = [];
  let outline: Pt[] | undefined;
  const ptOf = (id: string): Pt => { const n = byId.get(id)!; return { x: value(kid(n, 'X')), y: value(kid(n, 'Y')) }; };
  const polyOf = (shapeId: string): Pt[] | undefined => {
    const se = byId.get(shapeId); const cs = se ? byId.get(text(kid(se, 'DefiningShape'))) : undefined; if (!cs) return undefined;
    const pl = byId.get(text(kid(cs, 'DetailedGeometricModelElement'))); if (!pl || local(pl.tag) !== 'PolyLine') return undefined;
    const pts = kids(pl, 'Point').map((q) => ptOf(text(q))); if (pts.length > 2 && pts[0].x === pts[pts.length - 1].x && pts[0].y === pts[pts.length - 1].y) pts.pop(); return pts;
  };
  const changed = kind === 'changes' ? new Set<string>() : null;
  if (changed && pi) for (const ch of kids(kid(pi, 'Changes') ?? pi, 'Change')) { const ni = kid(ch, 'NewItem'); if (ni) changed.add(text(ni)); const del = kid(ch, 'DeletedInstanceName'); if (del) deleted.push(text(kid(del, 'ObjectName'))); }
  for (const it of kids(body, 'Item')) {
    if (changed && !changed.has(it.attrs.id)) continue;
    const gt = it.attrs.geometryType ?? '';
    const inst = kid(it, 'ItemInstance'); if (!inst) continue;
    const name = text(kid(kid(inst, 'InstanceName') ?? inst, 'ObjectName')) || text(kid(it, 'Name'));
    const tf = kid(inst, 'Transformation');
    const xx = tf ? Number(text(kid(tf, 'xx'))) : 1, yx = tf ? Number(text(kid(tf, 'yx'))) : 0, xy = tf ? Number(text(kid(tf, 'xy'))) : 0, yy = tf ? Number(text(kid(tf, 'yy'))) : 1;
    const tx = tf ? value(kid(tf, 'tx')) : 0, ty = tf ? value(kid(tf, 'ty')) : 0;
    if (gt === 'COMPONENT' || /^COMPONENT/.test(gt)) {
      const det = xx * yy - xy * yx, mirror = det < 0;
      // [m*c, -s; m*s, c]: rotation from the second column, mirror from the determinant
      const rot = ((Math.round((Math.atan2(-xy, yy) * 180) / Math.PI * 1e4) / 1e4) % 360 + 360) % 360;
      const side = mirror || /BOTTOM/i.test(text(kid(inst, 'AssembleToName'))) ? 'back' : 'front';
      placements.push({ ref: name, x: tx, y: ty, rot, side });
    } else if (gt === 'BOARD_OUTLINE') {
      const single = byId.get(text(kid(inst, 'Item'))); const sh = single ? text(kid(single, 'Shape')) : '';
      const pts = sh ? polyOf(sh) : undefined; if (pts) outline = pts.map((q) => ({ x: xx * q.x + xy * q.y + tx, y: yx * q.x + yy * q.y + ty }));
    }
  }
  return { kind, placements, deleted, outline };
}

/** Apply an IDX message to the project (parts moved/rotated/flipped by the MCAD side, new board outline). */
export function importIdx(p: Project, xml: string): { kind: string; moved: string[]; unknown: string[]; outline: boolean } {
  const r = readIdx(xml);
  const moved: string[] = [], unknown: string[] = [];
  for (const pl of r.placements) {
    const c = p.components.find((x) => x.ref === pl.ref); if (!c) { unknown.push(pl.ref); continue; }
    if (Math.abs(c.x - pl.x) > 1e-6 || Math.abs(c.y - pl.y) > 1e-6 || Math.abs(c.rot - pl.rot) > 1e-6 || c.side !== pl.side) { c.x = pl.x; c.y = pl.y; c.rot = pl.rot; c.side = pl.side; moved.push(c.ref); }
  }
  if (r.outline && r.outline.length >= 3) p.outline = r.outline;
  return { kind: r.kind, moved, unknown, outline: !!r.outline };
}
