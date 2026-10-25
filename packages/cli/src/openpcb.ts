#!/usr/bin/env node
/**
 * openpcb — command line for AI agents and scripts.
 *
 * Every command reads/writes an OpenBoard project file (*.openboard.json) and
 * prints a JSON result on stdout (errors: JSON on stderr, exit code 1).
 *
 *   openpcb new <project> [--name N] [--layers 2|4] [--width mm] [--height mm]
 *   openpcb info <project>
 *   openpcb footprints
 *   openpcb add <project> <footprint> <ref> <x> <y> [--rot deg] [--side front|back] [--value V]
 *   openpcb move <project> <ref> <x> <y> [--rot deg] [--side front|back]
 *   openpcb remove <project> <ref>
 *   openpcb net <project> <net> <ref-pad> [<ref-pad> ...]        (adds pins to a net; creates it)
 *   openpcb unnet <project> <ref-pad> [...]
 *   openpcb rules <project> [--width mm] [--clearance mm] [--via mm] [--drill mm] [--key value ...]
 *                 [--via-type dia:drill:from:to[,dia:drill:from:to]] [--clear-via-types]   (blind/buried via spans)
 *   openpcb zone <project> <net> <layer> <x1> <y1> <x2> <y2> [--static]
 *   openpcb trace <project> <net> <layer> <width> <x1> <y1> <x2> <y2> [x3 y3 ...]
 *   openpcb trace-shove <project> <net> <layer> <width> <x1> <y1> <x2> <y2> [...]   (adds the trace, pushing other nets' traces/vias aside)
 *   openpcb via <project> <net> <x> <y>
 *   openpcb unroute <project>                                     (removes autorouted copper)
 *   openpcb route <project> [--script file.do] [--passes N] [--keep] [--nets a,b] [--fast w] [--maxcells N] [--log file]
 *   openpcb place <project> [--mode anneal|quick] [--only A,B] [--lock A,B] [--grid mm] [--spacing mm]
 *                 [--iters N] [--seed N] [--no-rotate] [--ignore-nets GND,+3V3] [--density 0.3 [--density-cell mm]]
 *   openpcb gerber <project> <outdir> [--zip] [--name N]                  (Gerber RS-274X X2 + Excellon drill, incl. blind/buried spans)
 *   openpcb assembly <project> <outdir> [--name N]                       (BOM + pick-and-place CSV, JLCPCB format)
 *   openpcb testpoints <project> [--dia mm] [--side back|front] [--spacing mm] [--nets a,b]   (test pad per net without probe access)
 *   openpcb import-footprint <project> <file.kicad_mod | lib.pretty> ...       (KiCad footprints into the project library)
 *   openpcb import-netlist <project> <file.net> [--libs <KiCad footprints dir>]   (KiCad netlist: components + nets)
 *   openpcb ipc356 <project> <out.ipc>                                        (IPC-D-356A test netlist)
 *   openpcb vrml <project> <out.wrl> [--thickness mm]                         (3D model: board + component bodies)
 *   openpcb impedance [--type microstrip|stripline] --w mm --h mm [--t mm] [--er 4.3] [--s gap] [--b mm]
 *   openpcb drc <project>
 *   openpcb ratsnest <project>
 *   openpcb export-dsn <project> <out.dsn>
 *   openpcb import-dsn <in.dsn> <project>
 *   openpcb import-ses <project> <in.ses>
 *   openpcb pourcheck <project> [--net N] [--res mm]   connectivity through real pour fills (islands)
 *   openpcb render <project> <out.svg> [--width px] [--no-rats]
 *   openpcb class <project> <name> [--nets a,b | --match regex] [--width mm] [--clearance mm] [--vias Via[0-1]_250:100_um,...] [--layers F.Cu,In2.Cu] [--priority n] [--gap mm] [--remove]
 *   openpcb class-clearance <project> <classA> <classB> <mm>
 *   openpcb region <project> <name> <x1,y1,x2,y2 | x,y,x,y,x,y...> [--width mm] [--clearance mm] [--classes A,B] [--remove]
 *   openpcb split-plane <project> <layer> <net>=<points> [<net>=<points> ...] [--gap mm]   (first = highest priority)
 *   openpcb tune <project> [--nets a,b] [--target net=mm,...] [--phase]       (serpentines / phase bumps to length rules)
 *   openpcb detune <project> [--nets a,b]                                   (remove tuning: restore untuned copper)
 *   openpcb smooth <project> [--any] [--nets a,b]                           (gridless pull-tight of unlocked copper, 45 deg unless --any)
 *   openpcb stitch <project> --net GND --pitch mm [--in-zone] [--region x1,y1,x2,y2]   (via stitching array)
 *   openpcb fence <project> --net RF [--guard GND] [--spacing mm] [--layers F.Cu]       (guard vias along a net)
 *   openpcb structure-save <project> <name> <x> <y> [--radius mm]   /   structure-place <project> <name> <x> <y> --net N [--rot deg]
 *   openpcb export-dxf|export-pdf|export-gds <project> <out> [--layers F.Cu,B.Cu]   (DXF R12 / PDF plot / GDSII)
 *   openpcb export-odb <project> <out.zip>  /  export-ipc2581 <project> <out.xml>      (fabrication data sets)
 *   openpcb export-step <project> <out.step> [--thickness mm]  /  export-idf <project> <base>  /  export-idx <project> <out.idx>
 *   openpcb export-netlist <project> <out> [--format kicad|telesis]
 *   openpcb rename-refdes <project> [--band mm] [--prefixes R,C] [--out was_is.txt]   (geographic renumbering + back-annotation list)
 *   openpcb import-gerber <project> <file.gbr> [layer]  /  import-eagle <board.brd> <project>  /  import-kicad-pcb <board.kicad_pcb> <project>
 *   openpcb panelize <project> <panel.openboard.json> --nx N --ny N [--gap mm] [--rail mm] [--vscore] [--no-fiducials] [--no-tooling]
 *   openpcb variant <project> <name> [--dnp R1,R2] [--values R3=4k7,C1=1u] [--remove]      (assembly --variant <name> uses it)
 *   openpcb backdrill <project> --nets A,B [--side bottom|top] [--must-not-cut In5.Cu] [--oversize mm]   (report + drill files with gerber)
 *   openpcb thieving <project> [--pitch mm] [--size mm] [--clearance mm] [--off]          (copper balancing dots in the Gerbers)
 *   openpcb coupon <project> <x> <y> --layers F.Cu,In2.Cu [--width mm] [--length mm]       (impedance test coupon)
 *   openpcb si <project> [--nets a,b] [--rise-ps 500] [--z 50]          (impedance, delay, discontinuities, critical length)
 *   openpcb power <project> source <net> <ref> <V> | load <net> <ref> <A> | current <net> <A> | clear
 *   openpcb irdrop <project> <net> [--grid mm]                          (DC IR drop: traces, vias, meshed pours)
 *   openpcb emi <project> [--nets a,b] [--edge mm] [--return-via mm]     (split crossings, references, edges, return vias)
 *   openpcb current <project> [--max-rise C]                            (IPC-2221 temperature rise of current-carrying nets)
 *   openpcb clearance3d <project> [--top mm] [--bottom mm]              (part heights, body collisions)
 *   openpcb compare <old.openboard.json> <new.openboard.json>           (design compare)
 *   openpcb waive <project> --kind K [--match text] | --clear           (DRC waivers)
 *   openpcb batch <project> <commands.json>        (array of argv arrays, applied in order, one save)
 */
import { Skill, show } from '../../editor/src/skill.js';
import { tmpdir } from 'node:os';
import { readFileSync, writeFileSync, existsSync, appendFileSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { resolve, dirname, basename, join } from 'node:path';
import { parseDsn, Interpreter, writeSession } from '@openpcb/router';
import { projectRoutes } from '../../editor/src/tools.js';
import { type Project, newProject, normalizeProject, nextId, defaultRules } from '../../editor/src/model.js';
import { defaultLibrary } from '../../editor/src/footprints.js';
import { ratsnest } from '../../editor/src/connectivity.js';
import { exportDsn, importSession, importDsn } from '../../editor/src/dsnio.js';
import { projectDrc, drcSummary } from '../../editor/src/drc.js';
import { pourConnectivity } from '../../editor/src/pours.js';
import { autoplace } from '../../editor/src/place.js';
import { addTestPoints } from '../../editor/src/testpoints.js';
import { parseKicadFootprint, importKicadNetlist } from '../../editor/src/kicad.js';
import { exportIpc356, exportVrml, impedance } from '../../editor/src/outputs.js';
import { exportFabrication, exportAssembly, zipFiles } from '../../editor/src/fab.js';
import { projectToSvg } from './svg.js';
import { runMore } from './more.js';
import { runSch } from './sch.js';

type Args = { pos: string[]; opt: Record<string, string | true> };
function parseArgs(argv: string[]): Args {
  const pos: string[] = []; const opt: Record<string, string | true> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) { const k = a.slice(2); const v = argv[i + 1]; if (v !== undefined && !v.startsWith('--')) { opt[k] = v; i++; } else opt[k] = true; }
    else pos.push(a);
  }
  return { pos, opt };
}
const num = (v: string | true | undefined, d: number) => (typeof v === 'string' ? Number(v) : d);

function load(path: string): Project { return normalizeProject(JSON.parse(readFileSync(resolve(path), 'utf8'))); }
function save(path: string, p: Project): void { writeFileSync(resolve(path), JSON.stringify(p, null, 1)); }
function summary(p: Project) {
  const rats = ratsnest(p);
  return { name: p.name, layers: p.layers.map((l) => l.name), outline: p.outline, components: p.components.length, nets: p.nets.length, traces: p.traces.length, vias: p.vias.length, zones: p.zones.length, unrouted: rats.length, rules: p.rules };
}

export function run(argv: string[], io: { out: (s: string) => void } = { out: (s) => process.stdout.write(s + '\n') }): number {
  const { pos, opt } = parseArgs(argv);
  const cmd = pos[0];
  const lib = defaultLibrary();
  const emit = (o: unknown) => io.out(JSON.stringify(o, null, opt.pretty ? 1 : 0));
  try {
    switch (cmd) {
      case 'new': {
        const file = pos[1]; const p = newProject(typeof opt.name === 'string' ? opt.name : basename(file).replace(/\.openboard\.json$|\.json$/, ''), num(opt.layers, 2) === 4 ? 4 : 2);
        const w = num(opt.width, 80), h = num(opt.height, 60); p.outline = [{ x: 0, y: 0 }, { x: w, y: 0 }, { x: w, y: h }, { x: 0, y: h }];
        save(file, p); emit({ ok: true, project: file, ...summary(p) }); return 0;
      }
      case 'info': { const p = load(pos[1]); emit({ ok: true, ...summary(p), componentsList: p.components.map((c) => ({ ref: c.ref, footprint: c.footprint, x: c.x, y: c.y, rot: c.rot, side: c.side, value: c.value })), netsList: p.nets.map((n) => ({ name: n.name, pins: n.pins })) }); return 0; }
      case 'footprints': { emit({ ok: true, footprints: Object.values(lib).map((f) => ({ name: f.name, pads: f.pads.length, body: f.body, padIds: f.pads.map((x) => x.id) })) }); return 0; }
      case 'add': {
        const p = load(pos[1]); const [fp, ref] = [pos[2], pos[3]]; if (!lib[fp] && !p.footprints[fp]) throw new Error(`unknown footprint ${fp}`);
        if (p.components.some((c) => c.ref === ref)) throw new Error(`ref ${ref} exists`);
        p.components.push({ ref, footprint: fp, value: typeof opt.value === 'string' ? opt.value : '', x: Number(pos[4]), y: Number(pos[5]), rot: num(opt.rot, 0), side: opt.side === 'back' ? 'back' : 'front' });
        save(pos[1], p); emit({ ok: true, added: ref, pads: (lib[fp] ?? p.footprints[fp]).pads.map((x) => x.id) }); return 0;
      }
      case 'move': { const p = load(pos[1]); const c = p.components.find((x) => x.ref === pos[2]); if (!c) throw new Error('no such component'); if (pos[3] !== undefined) c.x = Number(pos[3]); if (pos[4] !== undefined) c.y = Number(pos[4]); if (opt.rot) c.rot = num(opt.rot, c.rot); if (opt.side) c.side = opt.side === 'back' ? 'back' : 'front'; save(pos[1], p); emit({ ok: true, component: c }); return 0; }
      case 'remove': { const p = load(pos[1]); const before = p.components.length; p.components = p.components.filter((c) => c.ref !== pos[2]); for (const n of p.nets) n.pins = n.pins.filter((x) => x.split('-')[0] !== pos[2]); p.nets = p.nets.filter((n) => n.pins.length); save(pos[1], p); emit({ ok: true, removed: before - p.components.length }); return 0; }
      case 'net': {
        const p = load(pos[1]); const name = pos[2]; const pins = pos.slice(3);
        for (const pin of pins) { const [ref, pad] = [pin.split('-')[0], pin.split('-').slice(1).join('-')]; const c = p.components.find((x) => x.ref === ref); if (!c) throw new Error(`no component ${ref}`); const fp = lib[c.footprint] ?? p.footprints[c.footprint]; if (!fp.pads.some((x) => x.id === pad)) throw new Error(`no pad ${pin}`); }
        for (const n of p.nets) n.pins = n.pins.filter((x) => !pins.includes(x));
        let n = p.nets.find((x) => x.name === name); if (!n) { n = { name, pins: [] }; p.nets.push(n); }
        n.pins.push(...pins.filter((x) => !n!.pins.includes(x))); p.nets = p.nets.filter((x) => x.pins.length);
        save(pos[1], p); emit({ ok: true, net: n }); return 0;
      }
      case 'unnet': { const p = load(pos[1]); const pins = pos.slice(2); for (const n of p.nets) n.pins = n.pins.filter((x) => !pins.includes(x)); p.nets = p.nets.filter((x) => x.pins.length); save(pos[1], p); emit({ ok: true }); return 0; }
      case 'rules': {
        const p = load(pos[1]); const map: Record<string, keyof typeof p.rules> = { width: 'width', clearance: 'clearance', via: 'viaDiameter', drill: 'viaDrill' };
        for (const [k, v] of Object.entries(opt)) { if (typeof v !== 'string') continue; if (k === 'via-type') continue; const key = (map[k] ?? k) as keyof typeof p.rules; if (key in defaultRules()) (p.rules as unknown as Record<string, number>)[key] = Number(v); }
        if (opt['clear-via-types']) p.rules.viaTypes = [];
        if (typeof opt['via-type'] === 'string') for (const spec of opt['via-type'].split(',')) {
          const [dia, dr, from, to] = spec.split(':'); if (!to) throw new Error('--via-type needs diameter:drill:fromLayer:toLayer');
          if (!p.layers.some((l) => l.name === from) || !p.layers.some((l) => l.name === to)) throw new Error(`unknown layer in via type ${spec}`);
          (p.rules.viaTypes ??= []).push({ diameter: Number(dia), drill: Number(dr), from, to });
        }
        save(pos[1], p); emit({ ok: true, rules: p.rules }); return 0;
      }
      case 'zone': { const p = load(pos[1]); const [net, layer] = [pos[2], pos[3]]; const [x1, y1, x2, y2] = pos.slice(4, 8).map(Number); if (!p.layers.some((l) => l.name === layer)) throw new Error('no such layer'); p.zones.push({ id: nextId(p), net, layer, points: [{ x: x1, y: y1 }, { x: x2, y: y1 }, { x: x2, y: y2 }, { x: x1, y: y2 }], clearance: p.rules.clearance, dynamic: !opt.static }); save(pos[1], p); emit({ ok: true, zones: p.zones.length }); return 0; }
      case 'trace': { const p = load(pos[1]); const [net, layer] = [pos[2], pos[3]]; const width = Number(pos[4]); const pts = []; for (let i = 5; i + 1 < pos.length; i += 2) pts.push({ x: Number(pos[i]), y: Number(pos[i + 1]) }); if (pts.length < 2) throw new Error('need at least two points'); p.traces.push({ id: nextId(p), net, layer, width, points: pts, locked: true }); save(pos[1], p); emit({ ok: true, traces: p.traces.length }); return 0; }
      case 'via': { const p = load(pos[1]); p.vias.push({ id: nextId(p), net: pos[2], x: Number(pos[3]), y: Number(pos[4]), diameter: p.rules.viaDiameter, drill: p.rules.viaDrill, locked: true }); save(pos[1], p); emit({ ok: true, vias: p.vias.length }); return 0; }
      case 'unroute': { const p = load(pos[1]); p.traces = p.traces.filter((t) => t.locked); p.vias = p.vias.filter((v) => v.locked); save(pos[1], p); emit({ ok: true, ...summary(p) }); return 0; }
      case 'route': {
        const p = load(pos[1]); const onlyNets = typeof opt.nets === 'string' ? opt.nets.split(',').map((s) => s.trim()).filter(Boolean) : undefined; const keep = !!opt.keep || !!onlyNets;
        // --gridless: the shape-based router; with --finish the routed copper is kept as rip-up-able routes
        const gridless = !!opt.gridless, finish = gridless && !!opt.finish;
        const dsn = exportDsn(p, { keepAutorouted: keep && !finish });
        const d = parseDsn(dsn);
        // the session the CLI imports stays in memory; every other path a script names (status_file, bestsave,
        // write session, read session) is a real file relative to the project, so long runs leave checkpoints
        const mem = new Map<string, string>(); const log: string[] = [];
        const logFile = typeof opt.log === 'string' ? resolve(opt.log) : null;
        const files = { read: (f: string) => (mem.has(f) ? mem.get(f)! : readFileSync(f, 'utf8')), write: (f: string, txt: string) => { if (f === '/out.ses') mem.set(f, txt); else writeFileSync(f, txt); } };
        const it = new Interpreter(d, { files, designDir: dirname(resolve(pos[1])).split('\\').join('/'), designFile: basename(pos[1]), log: (s) => { log.push(s); if (logFile) appendFileSync(logFile, s + '\n'); }, router: { ...(opt.fast ? { heuristicWeight: num(opt.fast, 1.5) } : {}), ...(opt.maxcells ? { maxCells: num(opt.maxcells, 4_000_000) } : {}) } });
        const t0 = Date.now();
        if (onlyNets) it.exec(`select net ${onlyNets.map((n) => JSON.stringify(n)).join(' ')}`);
        if (gridless) {
          if (finish) { const own = { ...p, traces: p.traces.filter((tr) => !tr.locked), vias: p.vias.filter((v) => !v.locked) }; mem.set('/in.ses', writeSession(d, 'in', projectRoutes(own as Project))); }
          it.run(['unit mm', `rule pcb (width ${p.rules.width}) (clearance ${p.rules.clearance} (type wire_wire))`, finish ? 'read session /in.ses gridless' : '', `shape_route ${num(opt.passes, 25)}${finish ? ' finish' : ''}${opt.any ? ' any' : ''}${opt.debug ? ' debug' : ''}${opt['time-limit'] !== undefined ? ` time ${num(opt['time-limit'], 0)}` : ''}`, typeof opt.script === 'string' ? readFileSync(resolve(opt.script), 'utf8') : '', 'quit'].join('\n'));
        }
        else if (typeof opt.script === 'string') it.run(readFileSync(resolve(opt.script), 'utf8'));
        else if (opt.passes) { const r = it.ensureRouter(); r.fanout(); r.route(num(opt.passes, 25)); r.clean(2); r.restoreBest(); }
        else it.run(`unit mm\nrule pcb (width ${p.rules.width}) (clearance ${p.rules.clearance} (type wire_wire))\nfanout\nroute 25\nclean 2\nroute 50 16\nclean 4\n${p.diffPairs.length || p.lengthGroups.length || p.nets.some((n) => n.minLength !== undefined) ? `tune ${p.rules.viaLength}\n` : ''}quit`);
        it.exec('write session /out.ses');
        const res = importSession(p, mem.get('/out.ses') ?? '', { replaceAll: !keep || finish });
        if (gridless) { save(pos[1], p); const sr = it.shape!; emit({ ok: true, engine: 'gridless', complete: sr.unrouted() === 0, unrouted: sr.unrouted(), conflicts: sr.conflicts(), stats: sr.stats, status: sr.statusReport(), imported: res, seconds: (Date.now() - t0) / 1000, log: opt.verbose ? log : undefined }); return 0; }
        const r = it.ensureRouter();
        save(pos[1], p);
        const last = r.history[r.history.length - 1];
        emit({ ok: true, complete: r.connections.every((c) => c.path && c.conflicts === 0), connections: r.connections.length, unrouted: last?.unrouted ?? 0, conflicts: last?.conflicts ?? 0, vias: last?.vias ?? 0, imported: res, seconds: (Date.now() - t0) / 1000, passes: r.history.map((h) => ({ pass: h.pass, kind: h.kind, unrouted: h.unrouted, conflicts: h.conflicts, vias: h.vias })), log: opt.verbose ? log : undefined, status: r.statusReport() });
        return 0;
      }
      case 'place': {
        const p = load(pos[1]);
        const list = (v: string | true | undefined) => (typeof v === 'string' && v ? v.split(',').map((s) => s.trim()).filter(Boolean) : undefined);
        const res = autoplace(p, { mode: opt.mode === 'quick' ? 'quick' : 'anneal', only: list(opt.only), lock: list(opt.lock), grid: num(opt.grid, 0.5), spacing: num(opt.spacing, 0.5), iterations: num(opt.iters, 600), seed: num(opt.seed, 1), rotate: !opt['no-rotate'], ignoreNets: list(opt['ignore-nets']), ...(opt.decap !== undefined ? { decap: num(opt.decap, 2) } : {}), ...(typeof opt.weight === 'string' ? { netWeights: opt.weight.split(',').map((s) => { const i = s.lastIndexOf('='); return { pattern: s.slice(0, i).trim(), weight: Number(s.slice(i + 1)) }; }).filter((w) => w.pattern && Number.isFinite(w.weight)) } : {}), ...(opt.density ? { density: num(opt.density, 0.3), densityCell: num(opt['density-cell'], 10) } : {}) });
        save(pos[1], p); emit({ ok: true, ...res, unrouted: ratsnest(p).length }); return 0;
      }
      case 'gerber': case 'fab': {
        const p = load(pos[1]); const outDir = resolve(pos[2] ?? '.');
        mkdirSync(outDir, { recursive: true });
        const files = exportFabrication(p, { name: typeof opt.name === 'string' ? opt.name : undefined });
        const written: string[] = [];
        if (opt.zip) { const zname = `${files[0].name.replace(/-[^-]+\.gbr$/, '')}-fab.zip`; writeFileSync(resolve(outDir, zname), zipFiles(files)); written.push(zname); }
        else for (const f of files) { writeFileSync(resolve(outDir, f.name), f.content); written.push(f.name); }
        emit({ ok: true, dir: outDir, files: written, layers: p.layers.length, drillFiles: files.filter((f) => f.name.endsWith('.drl')).map((f) => f.name) }); return 0;
      }
      case 'assembly': case 'bom': {
        const p = load(pos[1]); const outDir = resolve(pos[2] ?? '.'); mkdirSync(outDir, { recursive: true });
        const files = exportAssembly(p, { name: typeof opt.name === 'string' ? opt.name : undefined, variant: typeof opt.variant === 'string' ? opt.variant : undefined });
        for (const f of files) writeFileSync(resolve(outDir, f.name), f.content);
        emit({ ok: true, dir: outDir, files: files.map((f) => f.name), parts: files[1].content.trim().split('\n').length - 1, lines: files[0].content.trim().split('\n').length - 1 }); return 0;
      }
      case 'testpoints': case 'testpoint': {
        const p = load(pos[1]);
        const list = typeof opt.nets === 'string' ? opt.nets.split(',') : undefined;
        const res = addTestPoints(p, { dia: num(opt.dia, 1.0), side: opt.side === 'front' ? 'front' : 'back', spacing: num(opt.spacing, 2.54), nets: list });
        save(pos[1], p); emit({ ok: true, added: res.added.length, accessible: res.accessible.length, failed: res.failed, points: res.added }); return 0;
      }
      case 'import-footprint': case 'import-footprints': {
        // .kicad_mod files or .pretty folders
        const p = load(pos[1]); const added: string[] = [];
        for (const src of pos.slice(2)) {
          const files = statSync(resolve(src)).isDirectory() ? readdirSync(resolve(src)).filter((f) => f.endsWith('.kicad_mod')).map((f) => resolve(src, f)) : [resolve(src)];
          const lib = basename(src).replace(/\.pretty$/, '');
          for (const f of files) { const fp = parseKicadFootprint(readFileSync(f, 'utf8')); const name = opt.prefix === undefined && statSync(resolve(src)).isDirectory() ? `${lib}:${fp.name}` : fp.name; p.footprints[name] = { ...fp, name }; added.push(name); }
        }
        save(pos[1], p); emit({ ok: true, footprints: added.length, names: added.slice(0, 50) }); return 0;
      }
      case 'import-netlist': {
        const p = load(pos[1]); const r = importKicadNetlist(p, readFileSync(resolve(pos[2]), 'utf8'));
        // --libs <KiCad footprints folder>: load each missing Library:Name from <folder>/<Library>.pretty/<Name>.kicad_mod
        if (typeof opt.libs === 'string') {
          const still: string[] = [];
          for (const c of p.components) {
            if (p.footprints[c.footprint] || !c.footprint.includes(':')) continue;
            const [libName, fpName] = c.footprint.split(':');
            // several library roots may be given, separated by ';' (e.g. KiCad's footprints dir;the project's lib dir)
            const f = (opt.libs as string).split(';').map((root) => resolve(root.trim(), `${libName}.pretty`, `${fpName}.kicad_mod`)).find((x) => existsSync(x));
            if (f) p.footprints[c.footprint] = { ...parseKicadFootprint(readFileSync(f, 'utf8')), name: c.footprint };
            else still.push(`${c.ref}:${c.footprint}`);
          }
          r.missingFootprints = still;
        }
        save(pos[1], p); emit({ ok: true, ...r }); return 0;
      }
      case 'ipc356': { const p = load(pos[1]); writeFileSync(resolve(pos[2]), exportIpc356(p)); emit({ ok: true, file: pos[2] }); return 0; }
      case 'vrml': { const p = load(pos[1]); writeFileSync(resolve(pos[2]), exportVrml(p, { thickness: num(opt.thickness, 1.6) })); emit({ ok: true, file: pos[2] }); return 0; }
      case 'impedance': {
        const r = impedance({ type: opt.type === 'stripline' ? 'stripline' : 'microstrip', w: num(opt.w, 0.15), h: num(opt.h, 0.1), t: num(opt.t, 0.035), er: num(opt.er, 4.3), s: typeof opt.s === 'string' ? Number(opt.s) : undefined, b: typeof opt.b === 'string' ? Number(opt.b) : undefined });
        emit({ ok: true, z0: Number(r.z0.toFixed(2)), ...(r.zdiff !== undefined ? { zdiff: Number(r.zdiff.toFixed(2)) } : {}) }); return 0;
      }
      case 'drc': {
        const p = load(pos[1]); const v = projectDrc(p);
        // --pours: also check connectivity through the real pour fills (pads stranded on pour islands)
        if (opt.pours) {
          const pourNets = new Set(p.zones.map((z) => z.net));
          for (const o of pourConnectivity(p).nets) for (const pad of o.pads) v.push({ kind: 'pour-island', at: o.at, layer: '', message: pourNets.has(o.net) ? `${o.net}: pad ${pad} is not connected (the pour copper around it is an island)` : `${o.net}: pad ${pad} is not connected` });
        }
        emit({ ok: true, violations: v.length, summary: drcSummary(v), items: v }); return v.length ? 2 : 0;
      }
      case 'pourcheck': { const p = load(pos[1]); const r = pourConnectivity(p, { res: opt.res ? num(opt.res, 0.03) : undefined, net: typeof opt.net === 'string' ? opt.net : undefined }); emit({ ok: true, ...r }); return r.opens ? 2 : 0; }
      case 'ratsnest': { const p = load(pos[1]); const r = ratsnest(p); emit({ ok: true, unrouted: r.length, connections: r }); return 0; }
      case 'export-dsn': { const p = load(pos[1]); const t = exportDsn(p, { keepAutorouted: true }); writeFileSync(resolve(pos[2]), t); emit({ ok: true, file: pos[2], bytes: t.length }); return 0; }
      case 'import-dsn': { const p = importDsn(readFileSync(resolve(pos[1]), 'utf8')); p.name = basename(pos[1]).replace(/\.dsn$/i, ''); save(pos[2], p); emit({ ok: true, project: pos[2], ...summary(p) }); return 0; }
      case 'import-ses': { const p = load(pos[1]); const r = importSession(p, readFileSync(resolve(pos[2]), 'utf8'), { replaceAll: !opt.keep }); save(pos[1], p); emit({ ok: true, ...r, ...summary(p) }); return 0; }
      case 'render': { const p = load(pos[1]); const svg = projectToSvg(p, { width: num(opt.width, 1200), rats: !opt['no-rats'], layers: typeof opt.layers === 'string' ? opt.layers.split(',') : undefined }); writeFileSync(resolve(pos[2]), svg); emit({ ok: true, file: pos[2], bytes: svg.length }); return 0; }
      case 'skill': {
        // openpcb skill <project> [script.il] [--eval expr] [--save]   (OpenSKILL; axlRun calls any openpcb command)
        const file = pos[1]; let p = load(file);
        const tmp = join(tmpdir(), `openpcb-skill-${process.pid}.json`);
        const out: string[] = [];
        const sk: Skill = new Skill(p, {
          print: (s) => out.push(s),
          drc: (): { kind: string; message: string; x: number; y: number }[] => projectDrc(sk.project).map((m) => ({ kind: m.kind, message: m.message, x: m.at.x, y: m.at.y })),
          run: (cmd, args) => { save(tmp, sk.project); let o = ''; run([cmd, tmp, ...args], { out: (s) => { o += s; } }); sk.project = load(tmp); p = sk.project; try { return JSON.parse(o); } catch { return o; } },
        });
        const src = typeof opt.eval === 'string' ? opt.eval : readFileSync(resolve(pos[2]), 'utf8');
        let value: unknown;
        try { value = show(sk.run(src)); } catch (e) { emit({ ok: false, error: (e as Error).message, output: out.join('') }); return 1; }
        if (opt.save) save(file, sk.project);
        emit({ ok: true, value, output: out.join(''), saved: !!opt.save }); return 0;
      }
      case 'batch': {
        const file = pos[1]; const cmds = JSON.parse(readFileSync(resolve(pos[2]), 'utf8')) as string[][];
        const results: unknown[] = []; let code = 0;
        for (const c of cmds) { const sub = c.slice(); if (!['footprints', 'import-dsn'].includes(sub[0])) sub.splice(1, 0, file); let outp = ''; const rc = run(sub, { out: (s) => { outp += s; } }); results.push({ argv: c, code: rc, result: outp ? JSON.parse(outp) : null }); if (rc === 1) { code = 1; break; } }
        emit({ ok: code === 0, results }); return code;
      }
      case undefined: case 'help': case '--help': case '-h':
        io.out(readFileSync(new URL(import.meta.url)).toString().split('\n').filter((l) => l.startsWith(' *')).map((l) => l.slice(3)).join('\n')); return 0;
      default: { const rc = runMore(cmd, pos, opt, { load, save, emit, num }) ?? runSch(cmd, pos, opt as never, { load, save, emit, num }); if (rc === undefined) throw new Error(`unknown command ${cmd}`); return rc; }
    }
  } catch (e) {
    process.stderr.write(JSON.stringify({ ok: false, error: (e as Error).message }) + '\n');
    return 1;
  }
}

if (process.argv[1] && /openpcb\.js$/.test(process.argv[1].replace(/\\/g, '/'))) process.exitCode = run(process.argv.slice(2));
void existsSync; void dirname;
