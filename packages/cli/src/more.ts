/**
 * openpcb commands beyond the core set (constraints, editing, exports, fabrication documentation, analysis).
 * Each returns an exit code, or undefined when the command is not one of these.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { type Project, type Pt, nextId } from '../../editor/src/model.js';
import { tuneProject, detuneProject, smoothProject, stitchVias, viaFence, saveStructure, placeStructure } from '../../editor/src/tools.js';
import { exportDxf, exportPdf, exportGdsii, exportOdb, exportIpc2581 } from '../../editor/src/exports.js';
import { exportIdxChanges, importIdx } from '../../editor/src/idx.js';
import { exportStep, checkStep, exportIdf, exportIdx, exportKicadNetlist, exportTelesisNetlist, renameRefdes, wasIsText } from '../../editor/src/mcad.js';
import { importGerber, importEagle, importKicadPcb } from '../../editor/src/imports.js';
import { importAltiumPcb } from '../../editor/src/altium.js';
import { importPadsAscii } from '../../editor/src/pads.js';
import { zipFiles } from '../../editor/src/fab.js';
import { panelize, backdrillFiles, addCoupon, thievingDots } from '../../editor/src/fabdoc.js';
import { normalizeProject, drcKey, findNet } from '../../editor/src/model.js';
import { siReport, irDrop, emiCheck, currentCheck, clearance3d, compareProjects } from '../../editor/src/analysis.js';
import { projectDrcAll } from '../../editor/src/drc.js';
import { thermalAnalysis, thermalSvg } from '../../editor/src/thermal.js';
import { startCollabServer } from './collab.js';
import { CollabClient } from '../../editor/src/collab.js';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { addFlexZone, addBend, addStiffener, flexDrc, exportBentStep } from '../../editor/src/flex.js';
import { bondFingers, addBondWire, bondDrc, bondReport } from '../../editor/src/bond.js';
import { rfLine, rfStub, rfTaper, rfCoupled, rfVoid, rfRegenerate, rfSimulate, exportOpenEms } from '../../editor/src/rf.js';
import { fieldImpedance, fieldSiReport, widthForImpedance, lineParams } from '../../editor/src/fieldsolver.js';
import { pushShove, shoveVictims } from '../../editor/src/interactive.js';

export interface Ctx {
  load: (path: string) => Project;
  save: (path: string, p: Project) => void;
  emit: (o: unknown) => void;
  num: (v: string | true | undefined, d: number) => number;
}
type Opts = Record<string, string | true>;

const str = (v: string | true | undefined): string | undefined => (typeof v === 'string' ? v : undefined);
const list = (v: string | true | undefined): string[] | undefined => (typeof v === 'string' && v ? v.split(',').map((s) => s.trim()).filter(Boolean) : undefined);
/** "x1,y1,x2,y2,..." -> points; four numbers make a rectangle. */
export function parsePoints(s: string): Pt[] {
  const v = s.split(/[,\s]+/).filter(Boolean).map(Number);
  if (v.some((x) => !Number.isFinite(x))) throw new Error(`bad coordinates: ${s}`);
  if (v.length === 4) return [{ x: v[0], y: v[1] }, { x: v[2], y: v[1] }, { x: v[2], y: v[3] }, { x: v[0], y: v[3] }];
  if (v.length < 6 || v.length % 2) throw new Error('need x1,y1,x2,y2 (rectangle) or at least three x,y points');
  const pts: Pt[] = []; for (let i = 0; i < v.length; i += 2) pts.push({ x: v[i], y: v[i + 1] });
  return pts;
}

export function runMore(cmd: string, pos: string[], opt: Opts, h: Ctx): number | undefined {
  switch (cmd) {
    /* ---------- constraints ---------- */
    case 'class': {
      // openpcb class <project> <name> [--nets a,b | --match regex] [--width] [--clearance] [--vias n1,n2] [--layers L1,L2] [--priority n] [--gap mm] [--remove]
      const p = h.load(pos[1]); const name = pos[2]; if (!name) throw new Error('class name required');
      p.netClasses ??= [];
      if (opt.remove) { p.netClasses = p.netClasses.filter((c) => c.name !== name); h.save(pos[1], p); h.emit({ ok: true, classes: p.netClasses.length }); return 0; }
      let c = p.netClasses.find((x) => x.name === name);
      if (!c) { c = { name, nets: [] }; p.netClasses.push(c); }
      const add = list(opt.nets) ?? [];
      if (str(opt.match)) { const re = new RegExp(`^(?:${str(opt.match)})$`); for (const n of p.nets) if (re.test(n.name)) add.push(n.name); }
      for (const n of add) { for (const o of p.netClasses) if (o !== c) o.nets = o.nets.filter((x) => x !== n); if (!c.nets.includes(n)) c.nets.push(n); }
      if (opt.width !== undefined) c.width = h.num(opt.width, 0);
      if (opt.clearance !== undefined) c.clearance = h.num(opt.clearance, 0);
      if (opt.vias !== undefined) c.viaTypes = list(opt.vias) ?? [];
      if (opt.layers !== undefined) c.layers = list(opt.layers) ?? [];
      if (opt.priority !== undefined) c.priority = h.num(opt.priority, 0);
      if (opt.gap !== undefined) c.diffGap = h.num(opt.gap, 0);
      h.save(pos[1], p); h.emit({ ok: true, class: c }); return 0;
    }
    case 'class-clearance': {
      // openpcb class-clearance <project> <classA> <classB> <mm>
      const p = h.load(pos[1]); const [a, b] = [pos[2], pos[3]]; const v = Number(pos[4]);
      if (!a || !b || !Number.isFinite(v)) throw new Error('usage: class-clearance <project> <classA> <classB> <mm>');
      p.classClearances = (p.classClearances ?? []).filter((x) => !((x.a === a && x.b === b) || (x.a === b && x.b === a)));
      p.classClearances.push({ a, b, clearance: v });
      h.save(pos[1], p); h.emit({ ok: true, classClearances: p.classClearances }); return 0;
    }
    case 'region': {
      // openpcb region <project> <name> <x1,y1,x2,y2 | polygon> [--width mm] [--clearance mm] [--classes A,B] [--remove]
      const p = h.load(pos[1]); const name = pos[2]; p.regions ??= [];
      if (opt.remove) { p.regions = p.regions.filter((r) => r.name !== name); h.save(pos[1], p); h.emit({ ok: true, regions: p.regions.length }); return 0; }
      const pts = parsePoints(pos[3] ?? '');
      p.regions = p.regions.filter((r) => r.name !== name);
      p.regions.push({ id: nextId(p), name, points: pts, ...(opt.width !== undefined ? { width: h.num(opt.width, 0) } : {}), ...(opt.clearance !== undefined ? { clearance: h.num(opt.clearance, 0) } : {}), ...(list(opt.classes) ? { classes: list(opt.classes) } : {}) });
      h.save(pos[1], p); h.emit({ ok: true, regions: p.regions }); return 0;
    }
    case 'split-plane': {
      // openpcb split-plane <project> <layer> <net>=<points> [<net>=<points> ...]   (earlier = higher priority; replaces the layer's pours)
      const p = h.load(pos[1]); const layer = pos[2];
      if (!p.layers.some((l) => l.name === layer)) throw new Error(`no such layer ${layer}`);
      const parts = pos.slice(3).map((s) => { const i = s.indexOf('='); if (i < 1) throw new Error(`expected net=points, got ${s}`); return { net: s.slice(0, i), points: parsePoints(s.slice(i + 1)) }; });
      if (!parts.length) throw new Error('give at least one net=points region');
      p.zones = p.zones.filter((z) => z.layer !== layer);
      for (const pt of parts) p.zones.push({ id: nextId(p), net: pt.net, layer, points: pt.points, clearance: Math.max(p.rules.clearance, h.num(opt.gap, p.rules.clearance)), dynamic: true });
      h.save(pos[1], p); h.emit({ ok: true, layer, pours: parts.map((x) => x.net) }); return 0;
    }
    /* ---------- tuning and via tools ---------- */
    case 'tune': {
      // openpcb tune <project> [--nets a,b] [--target net=mm,net=mm] [--phase]
      const p = h.load(pos[1]);
      const targets: Record<string, number> = {};
      for (const s of list(opt.target) ?? []) { const i = s.lastIndexOf('='); targets[s.slice(0, i)] = Number(s.slice(i + 1)); }
      const r = tuneProject(p, { nets: list(opt.nets), targets, phase: !!opt.phase });
      h.save(pos[1], p); h.emit({ ok: true, tuned: r }); return 0;
    }
    case 'smooth': {
      // openpcb smooth <project> [--any] [--nets a,b]
      const p = h.load(pos[1]); const r = smoothProject(p, { any: !!opt.any, nets: list(opt.nets) });
      h.save(pos[1], p); h.emit({ ok: true, ...r }); return 0;
    }
    case 'detune': { const p = h.load(pos[1]); const r = detuneProject(p, list(opt.nets)); h.save(pos[1], p); h.emit({ ok: true, restored: r }); return 0; }
    case 'stitch': {
      // openpcb stitch <project> --net GND --pitch mm [--in-zone] [--region x1,y1,x2,y2]
      const p = h.load(pos[1]); const net = str(opt.net); if (!net) throw new Error('--net required');
      const rg = str(opt.region) ? str(opt.region)!.split(',').map(Number) : undefined;
      const n = stitchVias(p, { net, pitch: h.num(opt.pitch, 2), inZone: !!opt['in-zone'], ...(rg ? { region: { x1: rg[0], y1: rg[1], x2: rg[2], y2: rg[3] } } : {}) });
      h.save(pos[1], p); h.emit({ ok: true, added: n }); return 0;
    }
    case 'fence': {
      // openpcb fence <project> --net RF1 [--guard GND] [--spacing mm] [--layers F.Cu]
      const p = h.load(pos[1]); const net = str(opt.net); if (!net) throw new Error('--net required');
      const n = viaFence(p, { net, guard: str(opt.guard) ?? 'GND', spacing: h.num(opt.spacing, 2), layers: list(opt.layers) });
      h.save(pos[1], p); h.emit({ ok: true, added: n }); return 0;
    }
    case 'structure-save': {
      // openpcb structure-save <project> <name> <x> <y> [--radius mm]
      const p = h.load(pos[1]); const r = saveStructure(p, pos[2], { x: Number(pos[3]), y: Number(pos[4]) }, h.num(opt.radius, 1.5));
      h.save(pos[1], p); h.emit({ ok: true, ...r }); return 0;
    }
    case 'structure-place': {
      // openpcb structure-place <project> <name> <x> <y> --net N [--rot deg]
      const p = h.load(pos[1]); const net = str(opt.net); if (!net) throw new Error('--net required');
      const r = placeStructure(p, pos[2], Number(pos[3]), Number(pos[4]), net, h.num(opt.rot, 0));
      h.save(pos[1], p); h.emit({ ok: true, ...r }); return 0;
    }
    /* ---------- exports ---------- */
    case 'export-dxf': { const p = h.load(pos[1]); const s = exportDxf(p, { layers: list(opt.layers) }); writeFileSync(resolve(pos[2]), s); h.emit({ ok: true, file: pos[2], bytes: s.length }); return 0; }
    case 'export-pdf': { const p = h.load(pos[1]); const b = exportPdf(p, { layers: list(opt.layers) }); writeFileSync(resolve(pos[2]), b); h.emit({ ok: true, file: pos[2], bytes: b.length }); return 0; }
    case 'export-gds': { const p = h.load(pos[1]); const b = exportGdsii(p, { layers: list(opt.layers) }); writeFileSync(resolve(pos[2]), b); h.emit({ ok: true, file: pos[2], bytes: b.length }); return 0; }
    case 'export-odb': { const p = h.load(pos[1]); const files = exportOdb(p); writeFileSync(resolve(pos[2]), zipFiles(files)); h.emit({ ok: true, file: pos[2], files: files.length }); return 0; }
    case 'export-ipc2581': { const p = h.load(pos[1]); const s = exportIpc2581(p); writeFileSync(resolve(pos[2]), s); h.emit({ ok: true, file: pos[2], bytes: s.length }); return 0; }
    case 'export-step': { const p = h.load(pos[1]); const s = exportStep(p, opt.thickness ? { thickness: h.num(opt.thickness, 1.6) } : {}); writeFileSync(resolve(pos[2]), s); h.emit({ ok: true, file: pos[2], bytes: s.length, check: checkStep(s) }); return 0; }
    case 'export-idf': { const p = h.load(pos[1]); const r = exportIdf(p); const base = pos[2].replace(/\.(emn|emp)$/i, ''); writeFileSync(resolve(base + '.emn'), r.emn); writeFileSync(resolve(base + '.emp'), r.emp); h.emit({ ok: true, files: [base + '.emn', base + '.emp'] }); return 0; }
    case 'export-idx': { const p = h.load(pos[1]); const s = exportIdx(p); writeFileSync(resolve(pos[2]), s); h.emit({ ok: true, file: pos[2], bytes: s.length }); return 0; }
    case 'export-netlist': { const p = h.load(pos[1]); const s = str(opt.format) === 'telesis' ? exportTelesisNetlist(p) : exportKicadNetlist(p); writeFileSync(resolve(pos[2]), s); h.emit({ ok: true, file: pos[2], nets: p.nets.length }); return 0; }
    case 'rename-refdes': {
      // openpcb rename-refdes <project> [--band mm] [--prefixes R,C] [--out was_is.txt]
      const p = h.load(pos[1]); const map = renameRefdes(p, { band: h.num(opt.band, 5), prefixes: list(opt.prefixes) });
      if (str(opt.out)) writeFileSync(resolve(str(opt.out)!), wasIsText(map));
      h.save(pos[1], p); h.emit({ ok: true, renamed: map.length, map }); return 0;
    }
    /* ---------- imports ---------- */
    case 'import-gerber': { const p = h.load(pos[1]); const r = importGerber(p, readFileSync(resolve(pos[2]), 'utf8'), pos[3] ?? p.layers[0].name); h.save(pos[1], p); h.emit({ ok: true, ...r }); return 0; }
    case 'import-eagle': { const p = normalizeProject(importEagle(readFileSync(resolve(pos[1]), 'utf8'), str(opt.name) ?? 'eagle')); h.save(pos[2], p); h.emit({ ok: true, project: pos[2], components: p.components.length, nets: p.nets.length, traces: p.traces.length, vias: p.vias.length, layers: p.layers.map((l) => l.name) }); return 0; }
    case 'import-idx': { const p = h.load(pos[1]); const r = importIdx(p, readFileSync(resolve(pos[2]), 'utf8')); h.save(pos[1], p); h.emit({ ok: true, ...r }); return 0; }
    case 'export-idx-changes': { const a = h.load(pos[1]), b = h.load(pos[2]); const r = exportIdxChanges(a, b); writeFileSync(resolve(pos[3]), r.xml); h.emit({ ok: true, file: pos[3], added: r.added, removed: r.removed, moved: r.moved }); return 0; }
    case 'import-altium': { const p = normalizeProject(importAltiumPcb(new Uint8Array(readFileSync(resolve(pos[1]))), str(opt.name) ?? 'altium')); h.save(pos[2], p); h.emit({ ok: true, project: pos[2], components: p.components.length, nets: p.nets.length, traces: p.traces.length, vias: p.vias.length, zones: p.zones.length, layers: p.layers.map((l) => l.name) }); return 0; }
    case 'import-pads': { const p = normalizeProject(importPadsAscii(readFileSync(resolve(pos[1]), 'latin1'), str(opt.name) ?? 'pads')); h.save(pos[2], p); h.emit({ ok: true, project: pos[2], components: p.components.length, nets: p.nets.length, traces: p.traces.length, vias: p.vias.length, zones: p.zones.length, layers: p.layers.map((l) => l.name) }); return 0; }
    case 'import-kicad-pcb': { const p = normalizeProject(importKicadPcb(readFileSync(resolve(pos[1]), 'utf8'), str(opt.name) ?? 'kicad')); h.save(pos[2], p); h.emit({ ok: true, project: pos[2], components: p.components.length, nets: p.nets.length, traces: p.traces.length, vias: p.vias.length, zones: p.zones.length, layers: p.layers.map((l) => l.name) }); return 0; }
    /* ---------- manufacturing preparation ---------- */
    case 'panelize': {
      const p = h.load(pos[1]);
      const P = panelize(p, { nx: h.num(opt.nx, 2), ny: h.num(opt.ny, 2), gap: opt.gap !== undefined ? h.num(opt.gap, 2) : undefined, rail: h.num(opt.rail, 5), separation: opt.vscore ? 'vscore' : 'mousebite', fiducials: !opt['no-fiducials'], toolingHoles: !opt['no-tooling'] });
      h.save(pos[2], P); h.emit({ ok: true, panel: pos[2], outline: P.outline, components: P.components.length, nets: P.nets.length, traces: P.traces.length }); return 0;
    }
    case 'variant': {
      const p = h.load(pos[1]); const name = pos[2]; if (!name) throw new Error('variant name required');
      p.variants = (p.variants ?? []).filter((v) => v.name !== name);
      if (!opt.remove) { const values: Record<string, string> = {}; for (const s of list(opt.values) ?? []) { const i = s.indexOf('='); values[s.slice(0, i)] = s.slice(i + 1); } p.variants.push({ name, dnp: list(opt.dnp) ?? [], ...(Object.keys(values).length ? { values } : {}) }); }
      h.save(pos[1], p); h.emit({ ok: true, variants: p.variants }); return 0;
    }
    case 'backdrill': {
      const p = h.load(pos[1]); const nets = list(opt.nets); if (!nets) throw new Error('--nets required');
      const side = str(opt.side) === 'top' ? 'top' : 'bottom';
      p.backdrill = [{ nets, side, ...(str(opt['must-not-cut']) ? { mustNotCut: str(opt['must-not-cut']) } : {}), oversize: h.num(opt.oversize, 0.2) }];
      const r = backdrillFiles(p);
      h.save(pos[1], p); h.emit({ ok: true, vias: r.report.length, files: r.files.map((f) => f.name), report: r.report.slice(0, 50) }); return 0;
    }
    case 'thieving': {
      const p = h.load(pos[1]);
      if (opt.off) delete p.rules.thieving; else p.rules.thieving = { pitch: h.num(opt.pitch, 2), size: h.num(opt.size, 1), clearance: h.num(opt.clearance, 1) };
      const dots = p.rules.thieving ? [p.layers[0].name, p.layers[p.layers.length - 1].name].map((l) => ({ layer: l, dots: thievingDots(p, l, p.rules.thieving) .length })) : [];
      h.save(pos[1], p); h.emit({ ok: true, thieving: p.rules.thieving ?? null, dots }); return 0;
    }
    case 'coupon': {
      const p = h.load(pos[1]); const layers = list(opt.layers) ?? [p.layers[0].name];
      const n = addCoupon(p, { at: { x: Number(pos[2]), y: Number(pos[3]) }, layers, width: opt.width !== undefined ? h.num(opt.width, 0.1) : undefined, length: h.num(opt.length, 25) });
      h.save(pos[1], p); h.emit({ ok: true, coupons: n }); return 0;
    }
    /* ---------- analysis ---------- */
    case 'rf-line': case 'rf-stub': case 'rf-taper': case 'rf-coupled': case 'rf-void': case 'rf-regen': {
      const p = h.load(pos[1]);
      const pts = (v: string | true | undefined) => { const a = (str(v) ?? '').split(',').map(Number); const out: Pt[] = []; for (let i = 0; i + 1 < a.length; i += 2) out.push({ x: a[i], y: a[i + 1] }); return out; };
      const n = (k: string) => (opt[k] !== undefined ? h.num(opt[k], 0) : undefined);
      let r: unknown;
      if (pos[0] === 'rf-line') r = rfLine(p, { net: str(opt.net)!, layer: str(opt.layer) ?? 'F.Cu', points: pts(opt.points), z0: n('z'), width: n('width'), bend: (str(opt.bend) as 'miter') ?? 'miter', radius: n('radius'), miter: n('miter'), freqGHz: n('freq') });
      else if (pos[0] === 'rf-stub') r = rfStub(p, { net: str(opt.net)!, layer: str(opt.layer) ?? 'F.Cu', at: pts(opt.at)[0], angle: h.num(opt.angle, 90), length: n('length'), degrees: n('deg'), freqGHz: n('freq'), z0: n('z'), width: n('width'), end: opt.short ? 'short' : 'open', radial: n('radial'), ground: str(opt.ground) });
      else if (pos[0] === 'rf-taper') { const a = pts(opt.from)[0], b = pts(opt.to)[0]; r = rfTaper(p, { net: str(opt.net)!, layer: str(opt.layer) ?? 'F.Cu', from: a, to: b, z1: n('z1'), z2: n('z2'), w1: n('w1'), w2: n('w2'), profile: (str(opt.profile) as 'linear') ?? 'exponential', ripple: n('ripple') }); }
      else if (pos[0] === 'rf-coupled') r = rfCoupled(p, { net: str(opt.net)!, net2: str(opt.net2)!, layer: str(opt.layer) ?? 'F.Cu', points: pts(opt.points), width: h.num(opt.width, 0.2), gap: h.num(opt.gap, 0.2), bend: (str(opt.bend) as 'miter') ?? 'miter' });
      else if (pos[0] === 'rf-void') r = rfVoid(p, { layers: list(opt.layers) ?? ['In1.Cu'], ...(opt.points ? { points: pts(opt.points) } : {}), ...(opt.around ? { around: { net: str(opt.around)!, gap: h.num(opt.gap, 0.3) } } : {}) });
      else { const e = p.rfElements?.find((x) => x.id === Number(pos[2])); if (!e) throw new Error('no RF element ' + pos[2]); for (const s of list(opt.set) ?? []) { const i = s.indexOf('='); const v = s.slice(i + 1); e.params[s.slice(0, i)] = isNaN(Number(v)) ? v : Number(v); } r = rfRegenerate(p, e.id); }
      h.save(pos[1], p); h.emit({ ok: true, element: r }); return 0;
    }
    case 'rf-sim': {
      // openpcb rf-sim <project> <port1 pad> <port2 pad> [--fstart GHz] [--fstop GHz] [--points n] [--s2p out.s2p]
      const p = h.load(pos[1]);
      const r = rfSimulate(p, pos[2], pos[3], { fStartGHz: h.num(opt.fstart, 0.1), fStopGHz: h.num(opt.fstop, 6), points: h.num(opt.points, 61) });
      if (str(opt.s2p)) writeFileSync(resolve(str(opt.s2p)!), r.touchstone);
      const db = (c: [number, number]) => Math.round(2000 * Math.log10(Math.max(1e-15, Math.hypot(c[0], c[1])))) / 100;
      const pick = r.freqsGHz.map((f, k) => ({ ghz: Math.round(f * 1000) / 1000, s11dB: db(r.s11[k]), s21dB: db(r.s21[k]) })).filter((_, k, a) => k % Math.max(1, Math.floor(a.length / 12)) === 0 || k === a.length - 1);
      h.emit({ ok: true, path: r.path, stubs: r.stubs, sweep: pick }); return 0;
    }
    case 'rf-openems': {
      // openpcb rf-openems <project> <out.py> --nets a,b --ports J1-1,J2-1 [--fmax GHz]
      const p = h.load(pos[1]); writeFileSync(resolve(pos[2]), exportOpenEms(p, { nets: list(opt.nets) ?? [], ports: list(opt.ports) ?? [], fmaxGHz: h.num(opt.fmax, 10) }));
      h.emit({ ok: true, file: pos[2] }); return 0;
    }
    case 'flex-zone': case 'bend': case 'stiffener': {
      // openpcb flex-zone <project> <name> --points x,y,... --layers F.Cu,B.Cu [--no-coverlay] [--thickness mm]
      // openpcb bend <project> <name> --points x,y,... --axis x1,y1,x2,y2 --angle deg --radius mm [--dynamic]
      // openpcb stiffener <project> --side front|back --points x,y,... [--thickness mm] [--material FR4]
      const p = h.load(pos[1]);
      const pts = (v: string | true | undefined) => { const a = (str(v) ?? '').split(',').map(Number); const out: Pt[] = []; for (let i = 0; i + 1 < a.length; i += 2) out.push({ x: a[i], y: a[i + 1] }); return out; };
      let r: unknown;
      if (pos[0] === 'flex-zone') r = addFlexZone(p, { name: pos[2], points: pts(opt.points), layers: list(opt.layers) ?? [p.layers[0].name], coverlay: !opt['no-coverlay'], ...(opt.thickness !== undefined ? { thickness: h.num(opt.thickness, 0.1) } : {}) });
      else if (pos[0] === 'bend') { const ax = pts(opt.axis); r = addBend(p, { name: pos[2], points: pts(opt.points), axis: [ax[0], ax[1]], angle: h.num(opt.angle, 90), radius: h.num(opt.radius, 1), dynamic: !!opt.dynamic }); }
      else r = addStiffener(p, { side: (str(opt.side) as 'front') ?? 'back', points: pts(opt.points), thickness: h.num(opt.thickness, 0.2), material: str(opt.material) ?? 'FR4' });
      h.save(pos[1], p); h.emit({ ok: true, item: r }); return 0;
    }
    case 'flex-drc': { const p = h.load(pos[1]); const r = flexDrc(p, { angleTolerance: h.num(opt.tolerance, 10) }); h.emit({ ok: true, markers: r.length, items: r }); return r.length ? 2 : 0; }
    case 'export-step-bent': { const p = h.load(pos[1]); const s = exportBentStep(p, { facets: h.num(opt.facets, 8) }); writeFileSync(resolve(pos[2]), s); h.emit({ ok: true, file: pos[2], check: checkStep(s) }); return 0; }
    case 'bond-fingers': { const p = h.load(pos[1]); const r = bondFingers(p, pos[2], { offset: opt.offset !== undefined ? h.num(opt.offset, 0.5) : undefined, fingerW: opt.fw !== undefined ? h.num(opt.fw, 0.1) : undefined, fingerL: opt.fl !== undefined ? h.num(opt.fl, 0.35) : undefined, rows: opt.rows !== undefined ? h.num(opt.rows, 1) : undefined, diameter: opt.diameter !== undefined ? h.num(opt.diameter, 0.025) : undefined, profile: str(opt.profile) }); h.save(pos[1], p); h.emit({ ok: true, ...r }); return 0; }
    case 'bond-wire': { const p = h.load(pos[1]); const [ra, pa] = [pos[2].slice(0, pos[2].lastIndexOf('-')), pos[2].slice(pos[2].lastIndexOf('-') + 1)], [rb, pb] = [pos[3].slice(0, pos[3].lastIndexOf('-')), pos[3].slice(pos[3].lastIndexOf('-') + 1)]; const w = addBondWire(p, { ref: ra, pad: pa }, { ref: rb, pad: pb }, { diameter: opt.diameter !== undefined ? h.num(opt.diameter, 0.025) : undefined, profile: str(opt.profile), material: str(opt.material) as 'Au' | undefined }); h.save(pos[1], p); h.emit({ ok: true, wire: w }); return 0; }
    case 'bond-profile': { const p = h.load(pos[1]); const pr = { name: pos[2], loopHeight: h.num(opt.loop, 0.15), kink: h.num(opt.kink, 0.25), landingAngle: h.num(opt.angle, 30), dieHeight: h.num(opt.die, 0.2) }; p.bondProfiles = [...(p.bondProfiles ?? []).filter((x) => x.name !== pr.name), pr]; h.save(pos[1], p); h.emit({ ok: true, profile: pr }); return 0; }
    case 'bond-drc': { const p = h.load(pos[1]); const r = bondDrc(p, { minSpacing: opt.spacing !== undefined ? h.num(opt.spacing, 0.03) : undefined, maxLength: opt.max !== undefined ? h.num(opt.max, 5) : undefined, minLength: opt.min !== undefined ? h.num(opt.min, 0.3) : undefined, maxAngle: opt.angle !== undefined ? h.num(opt.angle, 30) : undefined }); h.emit({ ok: true, markers: r.length, items: r.slice(0, h.num(opt.limit, 200)) }); return r.length ? 2 : 0; }
    case 'bond-report': { const p = h.load(pos[1]); const r = bondReport(p); h.emit({ ok: true, wires: r.length, totalLength: Math.round(r.reduce((s, w) => s + w.length, 0) * 1000) / 1000, report: r.slice(0, h.num(opt.limit, 500)) }); return 0; }
    case 'collab-serve': {
      // openpcb collab-serve <project> [--port 7777] [--history dir]   (stays running; Ctrl+C to stop)
      void startCollabServer(resolve(pos[1]), { port: opt.port !== undefined ? h.num(opt.port, 7777) : undefined, history: str(opt.history), log: (s) => process.stderr.write(s + '\n') }).then((s) => h.emit({ ok: true, port: s.port, url: `ws://localhost:${s.port}` }));
      return 0;
    }
    case 'collab-run': {
      // openpcb collab-run <ws-url> --user NAME -- <openpcb command on the shared project...>
      // joins the session, runs the command on the shared copy, sends the resulting edits, leaves
      const url = pos[1]; const sep = process.argv.indexOf('--'); const sub = sep >= 0 ? process.argv.slice(sep + 1) : [];
      if (!sub.length) throw new Error('give the command after --');
      const tmp = join(tmpdir(), `openpcb-collab-${process.pid}.json`);
      let proj: Project | null = null;
      const cl = new CollabClient(() => proj!, (p) => { proj = p; }, { reject: (r) => process.stderr.write(`rejected: ${r}\n`) });
      void cl.connect(url, str(opt.user) ?? 'openpcb').then(async () => {
        writeFileSync(tmp, JSON.stringify(proj));
        const r = spawnSync(process.execPath, [process.argv[1], sub[0], tmp, ...sub.slice(1)], { encoding: 'utf8' });
        proj = JSON.parse(readFileSync(tmp, 'utf8')) as Project;
        const n = cl.push();
        await new Promise((res) => setTimeout(res, 300));
        cl.close();
        h.emit({ ok: r.status === 0 || r.status === 2, ops: n, version: cl.version, result: r.stdout ? JSON.parse(r.stdout) : null });
      }).catch((e) => { h.emit({ ok: false, error: String(e) }); process.exitCode = 1; });
      return 0;
    }
    case 'thermal': {
      // openpcb thermal <project> [--cell mm] [--ambient C] [--h-top W/m2K] [--h-bottom W/m2K] [--power U1=2,U3=0.5] [--svg out.svg] [--layer L]
      const p = h.load(pos[1]);
      const extra: Record<string, number> = {};
      for (const s of list(opt.power) ?? []) { const i = s.lastIndexOf('='); extra[s.slice(0, i)] = Number(s.slice(i + 1)); }
      const r = thermalAnalysis(p, { cell: opt.cell !== undefined ? h.num(opt.cell, 0.5) : undefined, ambient: h.num(opt.ambient, 25), hTop: h.num(opt['h-top'], 12), hBottom: h.num(opt['h-bottom'], 12), extraPower: extra });
      if (str(opt.svg)) writeFileSync(resolve(str(opt.svg)!), thermalSvg(p, r, str(opt.layer)));
      h.emit({ ok: true, ambient: r.ambient, maxTemp: r.maxTemp, totalPower: r.totalPower, cell: r.cell, grid: [r.nx, r.ny, r.layers.length], iterations: r.iterations, parts: r.parts.filter((q) => q.power > 0 || q.temp > r.ambient + 1).slice(0, h.num(opt.limit, 50)), hotspots: r.hotspots });
      return 0;
    }
    case 'part-power': {
      // openpcb part-power <project> <ref> <W>   (stored dissipation used by thermal)
      const p = h.load(pos[1]); const c = p.components.find((x) => x.ref === pos[2]); if (!c) throw new Error(`no part ${pos[2]}`);
      c.power = Number(pos[3]); h.save(pos[1], p); h.emit({ ok: true, ref: c.ref, power: c.power }); return 0;
    }
    case 'fieldsolve': {
      // openpcb fieldsolve <project> --layer L --width mm [--gap mm] [--coplanar mm] [--at x,y] [--freq 1,5,10]
      const p = h.load(pos[1]); const layer = str(opt.layer); if (!layer) throw new Error('--layer required');
      const at = str(opt.at) ? (([x, y]) => ({ x, y }))(str(opt.at)!.split(',').map(Number)) : undefined;
      const r = fieldImpedance(p, layer, h.num(opt.width, p.rules.width), { gap: opt.gap !== undefined ? h.num(opt.gap, 0.1) : undefined, coplanar: opt.coplanar !== undefined ? h.num(opt.coplanar, 0.2) : undefined, at, freqsGHz: (list(opt.freq) ?? ['1', '5', '10']).map(Number) });
      h.emit({ ok: true, ...r }); return 0;
    }
    case 'impedance-width': {
      // openpcb impedance-width <project> --layer L --z ohm [--gap mm]   (field-solved width for a target, single or differential)
      const p = h.load(pos[1]); const layer = str(opt.layer); if (!layer) throw new Error('--layer required');
      h.emit({ ok: true, layer, target: h.num(opt.z, 50), ...widthForImpedance(p, layer, h.num(opt.z, 50), { gap: opt.gap !== undefined ? h.num(opt.gap, 0.1) : undefined }) }); return 0;
    }
    case 'field-si': {
      // openpcb field-si <project> [--nets a,b] [--freq GHz] [--rise ns] [--xtalk-gap mm] [--xtalk-min mm]
      const p = h.load(pos[1]);
      const r = fieldSiReport(p, { nets: list(opt.nets), freqGHz: h.num(opt.freq, 1), riseNs: h.num(opt.rise, 0.5), xtalkGap: h.num(opt['xtalk-gap'], 0.3), xtalkMin: h.num(opt['xtalk-min'], 3) });
      h.emit({ ok: true, nets: r.nets.length, report: r.nets.slice(0, h.num(opt.limit, 100)), crosstalk: r.crosstalk.slice(0, h.num(opt.limit, 100)) }); return 0;
    }
    case 'xsection': {
      // openpcb xsection <cross-section.json>   (raw solver: {conductors, slabs, x0, x1, y0, y1, topOpen, bottomOpen})
      const xs = JSON.parse(readFileSync(resolve(pos[1]), 'utf8'));
      h.emit({ ok: true, ...lineParams(xs, { freqsGHz: (list(opt.freq) ?? ['1']).map(Number) }) }); return 0;
    }
    case 'si': { const p = h.load(pos[1]); const r = siReport(p, { nets: list(opt.nets), riseTimePs: h.num(opt['rise-ps'], 500), targetZ: opt.z !== undefined ? h.num(opt.z, 50) : undefined }); h.emit({ ok: true, nets: r.length, report: r.slice(0, h.num(opt.limit, 50)) }); return 0; }
    case 'power': {
      // openpcb power <project> source <net> <ref> <volts>  |  load <net> <ref> <amps>  |  current <net> <amps>  |  clear
      const p = h.load(pos[1]); const kind = pos[2];
      if (kind === 'source') { p.sources = (p.sources ?? []).filter((s) => !(s.net === pos[3] && s.ref === pos[4])); p.sources.push({ net: pos[3], ref: pos[4], voltage: Number(pos[5]) }); }
      else if (kind === 'load') { p.loads = (p.loads ?? []).filter((s) => !(s.net === pos[3] && s.ref === pos[4])); p.loads.push({ net: pos[3], ref: pos[4], current: Number(pos[5]) }); }
      else if (kind === 'current') { const n = findNet(p, pos[3]); if (!n) throw new Error(`no net ${pos[3]}`); n.current = Number(pos[4]); }
      else if (kind === 'clear') { p.sources = []; p.loads = []; }
      else throw new Error('usage: power <project> source|load|current|clear ...');
      h.save(pos[1], p); h.emit({ ok: true, sources: p.sources, loads: p.loads }); return 0;
    }
    case 'irdrop': { const p = h.load(pos[1]); const r = irDrop(p, pos[2], { grid: h.num(opt.grid, 1) }); h.emit({ ok: true, ...r }); return 0; }
    case 'emi': { const p = h.load(pos[1]); const r = emiCheck(p, { nets: list(opt.nets), edgeDistance: h.num(opt.edge, 1), returnViaDistance: h.num(opt['return-via'], 1.5) }); const by: Record<string, number> = {}; for (const m of r) by[m.kind] = (by[m.kind] ?? 0) + 1; h.emit({ ok: true, violations: r.length, summary: by, items: r.slice(0, h.num(opt.limit, 200)) }); return r.length ? 2 : 0; }
    case 'current': { const p = h.load(pos[1]); const r = currentCheck(p, { maxRise: h.num(opt['max-rise'], 10) }); h.emit({ ok: true, violations: r.length, items: r }); return r.length ? 2 : 0; }
    case 'clearance3d': { const p = h.load(pos[1]); if (opt.top !== undefined) p.rules.maxHeightTop = h.num(opt.top, 0); if (opt.bottom !== undefined) p.rules.maxHeightBottom = h.num(opt.bottom, 0); if (opt.top !== undefined || opt.bottom !== undefined) h.save(pos[1], p); const r = clearance3d(p); h.emit({ ok: true, violations: r.length, items: r }); return r.length ? 2 : 0; }
    case 'compare': { const a = h.load(pos[1]), b = h.load(pos[2]); h.emit({ ok: true, ...compareProjects(a, b) }); return 0; }
    case 'waive': {
      // openpcb waive <project> --kind mask-sliver [--match text] | --clear
      const p = h.load(pos[1]);
      if (opt.clear) p.waivers = [];
      else { const all = projectDrcAll(p); const kind = str(opt.kind), match = str(opt.match); const pick = all.filter((m) => (!kind || m.kind === kind) && (!match || m.message.includes(match))); p.waivers = [...new Set([...(p.waivers ?? []), ...pick.map(drcKey)])]; }
      h.save(pos[1], p); h.emit({ ok: true, waived: (p.waivers ?? []).length }); return 0;
    }
    case 'trace-shove': {
      // openpcb trace-shove <project> <net> <layer> <width> x1 y1 x2 y2 [...]   (add a locked trace, pushing other nets aside)
      const p = h.load(pos[1]); const pts: Pt[] = []; for (let i = 5; i + 1 < pos.length; i += 2) pts.push({ x: Number(pos[i]), y: Number(pos[i + 1]) });
      const t = { id: nextId(p), net: pos[2], layer: pos[3], width: Number(pos[4]), points: pts, locked: true };
      p.traces.push(t);
      const r = pushShove(p, t);
      const left = shoveVictims(p, t);
      h.save(pos[1], p); h.emit({ ok: true, pushed: r.pushed.length, movedVias: r.movedVias.length, failed: r.failed, stillCrowding: left.nets }); return 0;
    }
    default: return undefined;
  }
}
void readFileSync; void writeFileSync; void mkdirSync; void resolve; void join;
