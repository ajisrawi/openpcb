/**
 * openpcb sch-* commands: OpenSchematic from the command line (designs are .opensch.json files).
 *
 *   sch-new <design> [--name N] [--size A|B|A4|A3]           new design with the built-in symbol library
 *   sch-import-kicad <root.kicad_sch> <design>              KiCad schematic (hierarchical sheets read from the folder)
 *   sch-import-altium <file.SchDoc> <design>                Altium schematic (ASCII or binary)
 *   sch-import-orcad <file.DSN> <design>                    OrCAD Capture design (blocks in other .DSN files are read too)
 *   sch-import-orcad-lib <design> <lib.OLB> [--name L]      add an OrCAD Capture library
 *   sch-import-syscap <file.sdax> <design>                  Allegro System Capture design archive (logic, drawn)
 *   sch-import-dehdl <project.cpm> <design>                 Allegro Design Entry HDL (Concept) project
 *   sch-skill <design> [script.il] [--eval expr] [--save]   OpenSKILL with the sch* API
 *   sch-collab-serve <design> [--port 7778]                 team design server (page reservations)
 *   sch-constraints <design> [--file rules.txt] [--add "net CLK class=HS"]   constraint manager rules (to the board)
 *   sch-compare <a> <b>                                     design differences (parts, values, connectivity)
 *   sch-db-link <design> <parts.csv> [--match Value,Part]   part database (CIS) properties onto parts
 *   sch-replace <design> <find> <replace>                   find & replace in properties, names and texts
 *   sch-import-kicad-lib <design> <lib.kicad_sym> [--name L] add a KiCad symbol library
 *   sch-info <design>                                       pages, parts, nets
 *   sch-add-part <design> <lib:part> <x> <y> [--ref R?] [--rot 0|90|180|270] [--mirror] [--unit n] [--value v] [--footprint f] [--page P]
 *   sch-wire <design> x1 y1 x2 y2 [x3 y3 ...] [--page P]
 *   sch-label <design> <name> <x> <y> [--page P]            net alias
 *   sch-power <design> <net> <x> <y> [--ground] [--page P]
 *   sch-port <design> <name> <x> <y> [--dir input|output|bidirectional] / sch-offpage <design> <name> <x> <y>
 *   sch-noconnect <design> <x> <y>
 *   sch-annotate <design> [--reset]                         reference designators (multi-unit packing)
 *   sch-erc <design>                                        design rules check
 *   sch-netlist <design> <out> [--format kicad|telesis|edif|spice|json]
 *   sch-bom <design> <out.csv> [--variant V]
 *   sch-xref <design> <out.txt>
 *   sch-pdf <design> <out.pdf>   /  sch-svg <design> <out.svg> [--page P]
 *   sch-to-board <design> <board.openboard.json> [--variant V]   forward annotation (creates or updates the board)
 *   sch-back-annotate <design> <board.openboard.json> [--was-is file]   refdes / value / footprint changes back
 *   sch-simulate <design> [--op] [--tran step,stop] [--ac start,stop,points-per-decade] [--probe net,net]   built-in SPICE
 */
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { resolve, dirname, join, basename } from 'node:path';
import type { Project } from '../../editor/src/model.js';
import { type Design, newDesign, normalizeDesign, nid, schematicOf, libPart } from '../../schematic/src/model.js';
import { basicLibrary } from '../../schematic/src/library.js';
import { buildNetlist } from '../../schematic/src/connect.js';
import { annotate, resetAnnotation, backAnnotate } from '../../schematic/src/annotate.js';
import { runErc } from '../../schematic/src/erc.js';
import { toBoard, kicadNetlist, telesisNetlist, edifNetlist, spiceNetlist, bom, crossReference } from '../../schematic/src/netlist.js';
import { importKicadSchematic, importKicadSymbolLibrary } from '../../schematic/src/kicadsch.js';
import { importAltiumSchematic } from '../../schematic/src/altiumsch.js';
import { importOrcadDesign, importOrcadLibrary } from '../../schematic/src/orcad.js';
import { importSystemCapture } from '../../schematic/src/syscap.js';
import { importDeHdl } from '../../schematic/src/dehdl.js';
import { pageSvg, designPdf } from '../../schematic/src/output.js';
import { simulate } from '../../schematic/src/spice.js';
import { schSkill } from '../../schematic/src/schskill.js';
import { constraintsToText, textToConstraints, compareDesigns, parseCsv, linkPartDatabase, replaceInDesign } from '../../schematic/src/design_tools.js';
import { startSchCollabServer } from './schcollabserver.js';
import { show } from '../../editor/src/skill.js';

interface Ctx { load: (path: string) => Project; save: (path: string, p: Project) => void; emit: (o: unknown) => void; num: (v: string | true | undefined, d: number) => number }
type Opts = Record<string, string | true>;
const str = (v: string | true | undefined): string | undefined => (typeof v === 'string' ? v : undefined);

const loadD = (f: string): Design => normalizeDesign(JSON.parse(readFileSync(resolve(f), 'utf8')) as Design);
const saveD = (f: string, d: Design) => writeFileSync(resolve(f), JSON.stringify(d));
const pageOf = (d: Design, name?: string) => { const sch = schematicOf(d, d.root)!; const p = name ? d.schematics.flatMap((s) => s.pages).find((x) => x.name === name) : sch.pages[0]; if (!p) throw new Error(`no page ${name}`); return p; };
const ensureBasic = (d: Design) => { if (!d.libraries.some((l) => l.name === 'OpenSch')) d.libraries.push(basicLibrary()); };

export function runSch(cmd: string, pos: string[], opt: Opts, h: Ctx): number | undefined {
  switch (cmd) {
    case 'sch-new': { const d = newDesign(str(opt.name) ?? basename(pos[1]).replace(/\.opensch\.json$|\.json$/i, '')); d.libraries.push(basicLibrary()); if (str(opt.size)) d.schematics[0].pages[0].size = str(opt.size) as 'A'; saveD(pos[1], d); h.emit({ ok: true, design: pos[1], parts: Object.keys(d.libraries[0].parts).length }); return 0; }
    case 'sch-import-kicad': {
      const dir = dirname(resolve(pos[1]));
      const d = importKicadSchematic(readFileSync(resolve(pos[1]), 'utf8'), { name: basename(pos[1]).replace(/\.kicad_sch$/i, ''), readFile: (f) => { const p = join(dir, f); return existsSync(p) ? readFileSync(p, 'utf8') : null; } });
      ensureBasic(d); saveD(pos[2], d);
      const nl = buildNetlist(d); h.emit({ ok: true, design: pos[2], schematics: d.schematics.map((s) => s.name), parts: nl.parts.length, nets: nl.nets.length, issues: nl.issues.slice(0, 20) }); return 0;
    }
    case 'sch-import-altium': { const d = importAltiumSchematic(new Uint8Array(readFileSync(resolve(pos[1]))), basename(pos[1]).replace(/\.schdoc$/i, '')); ensureBasic(d); saveD(pos[2], d); const nl = buildNetlist(d); h.emit({ ok: true, design: pos[2], parts: nl.parts.length, nets: nl.nets.length, issues: nl.issues.slice(0, 20) }); return 0; }
    case 'sch-import-orcad': {
      // blocks implemented by other designs: <name>.DSN next to the design or in a folder of that name
      const dir = dirname(resolve(pos[1]));
      const findDsn = (impl: string): Uint8Array | null => {
        const want = impl.toLowerCase().replace(/\.dsn$/, '');
        const scan = (d: string, depth: number): string | null => { let ents: string[] = []; try { ents = readdirSync(d); } catch { return null; } for (const e of ents) { const f = join(d, e); if (e.toLowerCase() === `${want}.dsn`) return f; } if (depth > 0) for (const e of ents) { const f = join(d, e); try { if (statSync(f).isDirectory()) { const hit = scan(f, depth - 1); if (hit) return hit; } } catch { /* unreadable */ } } return null; };
        const f = scan(dir, 2); return f ? new Uint8Array(readFileSync(f)) : null;
      };
      const r = importOrcadDesign(new Uint8Array(readFileSync(resolve(pos[1]))), basename(pos[1]).replace(/\.dsn$/i, ''), { resolve: findDsn }); ensureBasic(r.design); saveD(pos[2], r.design); const nl = buildNetlist(r.design); h.emit({ ok: true, design: pos[2], schematics: r.design.schematics.map((s) => `${s.name} (${s.pages.length} pages)`), parts: nl.parts.length, nets: nl.nets.length, notes: r.notes.slice(0, 30) }); return 0; }
    case 'sch-constraints': {
      // openpcb sch-constraints <design> [--file rules.txt] [--add "net CLK class=HS width=0.15"]   (no options: show)
      const d = loadD(pos[1]);
      if (typeof opt.file === 'string') d.constraints = textToConstraints(readFileSync(resolve(opt.file), 'utf8'));
      if (typeof opt.add === 'string') { const cur = constraintsToText(d.constraints); d.constraints = textToConstraints(`${cur}\n${opt.add}`); }
      if (opt.file || opt.add) saveD(pos[1], d);
      h.emit({ ok: true, constraints: constraintsToText(d.constraints).split('\n').filter(Boolean) }); return 0;
    }
    case 'sch-compare': { const r = compareDesigns(loadD(pos[1]), loadD(pos[2])); h.emit({ ok: true, summary: r.text.split('\n')[0], ...r, text: undefined }); return 0; }
    case 'sch-db-link': {
      // openpcb sch-db-link <design> <parts.csv> [--match Value,Part]
      const d = loadD(pos[1]); const rows = parseCsv(readFileSync(resolve(pos[2]), 'utf8'));
      const r = linkPartDatabase(d, rows, { match: typeof opt.match === 'string' ? opt.match.split(',') : undefined });
      saveD(pos[1], d); h.emit({ ok: true, rows: rows.length, linked: r.linked.length, unmatched: r.unmatched }); return 0;
    }
    case 'sch-replace': { const d = loadD(pos[1]); const n = replaceInDesign(d, pos[2], pos[3] ?? ''); saveD(pos[1], d); h.emit({ ok: true, replaced: n }); return 0; }
    case 'sch-collab-serve': {
      // openpcb sch-collab-serve <design> [--port 7778] [--history dir]   (stays running; Ctrl+C to stop)
      void startSchCollabServer(resolve(pos[1]), { port: opt.port !== undefined ? h.num(opt.port, 7778) : undefined, history: str(opt.history), log: (s) => process.stderr.write(s + '\n') }).then((sv) => h.emit({ ok: true, port: sv.port, url: `ws://localhost:${sv.port}` }));
      return 0;
    }
    case 'sch-skill': {
      // OpenSKILL on a schematic: a script file and/or --eval expressions; --save writes the edited design back
      const d = loadD(pos[1]); const out: string[] = []; let dirty = false;
      const sk = schSkill(d, { print: (t) => out.push(t), changed: () => { dirty = true; } });
      let v: unknown = null;
      if (pos[2]) v = sk.run(readFileSync(resolve(pos[2]), 'utf8'));
      if (typeof opt.eval === 'string') v = sk.run(opt.eval);
      if (opt.save && dirty) saveD(pos[1], d);
      h.emit({ ok: true, value: show(v as never), output: out, saved: !!(opt.save && dirty) }); return 0;
    }
    case 'sch-import-dehdl': {
      // openpcb sch-import-dehdl <project.cpm> <design> [--install C:/Cadence/SPB_22.1]
      const fsx = { read: (f: string) => { try { return readFileSync(f, 'utf8'); } catch { return null; } }, list: (dd: string) => { try { return readdirSync(dd); } catch { return []; } } };
      const r = importDeHdl(resolve(pos[1]).split('\\').join('/'), fsx, { installDir: str(opt.install) });
      ensureBasic(r.design); saveD(pos[2], r.design); const nl = buildNetlist(r.design);
      h.emit({ ok: true, design: pos[2], schematics: r.design.schematics.map((x) => `${x.name} (${x.pages.length} pages)`), parts: nl.parts.length, nets: nl.nets.length, notes: r.notes.slice(0, 30) }); return 0;
    }
    case 'sch-import-syscap': { const r = importSystemCapture(new Uint8Array(readFileSync(resolve(pos[1]))), basename(pos[1]).replace(/[.]sdax$/i, '')); ensureBasic(r.design); saveD(pos[2], r.design); const nl = buildNetlist(r.design); h.emit({ ok: true, design: pos[2], schematics: r.design.schematics.map((x) => x.name), parts: nl.parts.length, nets: nl.nets.length, notes: r.notes }); return 0; }
    case 'sch-import-orcad-lib': { const d = loadD(pos[1]); const r = importOrcadLibrary(new Uint8Array(readFileSync(resolve(pos[2]))), str(opt.name) ?? basename(pos[2]).replace(/\.olb$/i, '')); d.libraries = d.libraries.filter((l) => l.name !== r.library.name); d.libraries.push(r.library); saveD(pos[1], d); h.emit({ ok: true, library: r.library.name, parts: Object.keys(r.library.parts).length, notes: r.notes }); return 0; }
    case 'sch-import-kicad-lib': { const d = loadD(pos[1]); const lib = importKicadSymbolLibrary(readFileSync(resolve(pos[2]), 'utf8'), str(opt.name) ?? basename(pos[2]).replace(/\.kicad_sym$/i, '')); d.libraries = d.libraries.filter((l) => l.name !== lib.name); d.libraries.push(lib); saveD(pos[1], d); h.emit({ ok: true, library: lib.name, parts: Object.keys(lib.parts).length }); return 0; }
    case 'sch-info': { const d = loadD(pos[1]); const nl = buildNetlist(d); h.emit({ ok: true, name: d.name, root: d.root, schematics: d.schematics.map((s) => ({ name: s.name, pages: s.pages.map((p) => ({ name: p.name, parts: p.parts.length, wires: p.wires.length, blocks: p.blocks.length })) })), libraries: d.libraries.map((l) => `${l.name} (${Object.keys(l.parts).length})`), parts: nl.parts.length, nets: nl.nets.length, issues: nl.issues.length }); return 0; }
    case 'sch-add-part': {
      const d = loadD(pos[1]); ensureBasic(d); const [lib, part] = pos[2].includes(':') ? pos[2].split(':') : ['OpenSch', pos[2]];
      const lp = libPart(d, lib, part); if (!lp) throw new Error(`no part ${pos[2]}`);
      const pi = { id: nid(d), lib, part: lp.name, unit: Math.max(0, h.num(opt.unit, 1) - 1), ref: str(opt.ref) ?? `${lp.refPrefix}?`, x: Number(pos[3]), y: Number(pos[4]), rot: h.num(opt.rot, 0) as 0, ...(opt.mirror ? { mirror: true } : {}), props: { ...(str(opt.value) ? { Value: str(opt.value)! } : {}), ...(str(opt.footprint) ? { 'PCB Footprint': str(opt.footprint)! } : {}) } };
      pageOf(d, str(opt.page)).parts.push(pi); saveD(pos[1], d); h.emit({ ok: true, part: pi }); return 0;
    }
    case 'sch-wire': { const d = loadD(pos[1]); const v = pos.slice(2).map(Number); const pts = []; for (let i = 0; i + 1 < v.length; i += 2) pts.push({ x: v[i], y: v[i + 1] }); if (pts.length < 2) throw new Error('need two points'); pageOf(d, str(opt.page)).wires.push({ id: nid(d), pts }); saveD(pos[1], d); h.emit({ ok: true }); return 0; }
    case 'sch-label': { const d = loadD(pos[1]); pageOf(d, str(opt.page)).aliases.push({ id: nid(d), name: pos[2], at: { x: Number(pos[3]), y: Number(pos[4]) } }); saveD(pos[1], d); h.emit({ ok: true }); return 0; }
    case 'sch-power': { const d = loadD(pos[1]); pageOf(d, str(opt.page)).globals.push({ id: nid(d), net: pos[2], at: { x: Number(pos[3]), y: Number(pos[4]) }, style: opt.ground ? 'ground' : 'power_bar' }); saveD(pos[1], d); h.emit({ ok: true }); return 0; }
    case 'sch-port': { const d = loadD(pos[1]); pageOf(d, str(opt.page)).ports.push({ id: nid(d), name: pos[2], at: { x: Number(pos[3]), y: Number(pos[4]) }, dir: (str(opt.dir) as 'input') ?? 'passive' }); saveD(pos[1], d); h.emit({ ok: true }); return 0; }
    case 'sch-offpage': { const d = loadD(pos[1]); pageOf(d, str(opt.page)).offPages.push({ id: nid(d), name: pos[2], at: { x: Number(pos[3]), y: Number(pos[4]) } }); saveD(pos[1], d); h.emit({ ok: true }); return 0; }
    case 'sch-noconnect': { const d = loadD(pos[1]); pageOf(d, str(opt.page)).noConnects.push({ id: nid(d), at: { x: Number(pos[2]), y: Number(pos[3]) } }); saveD(pos[1], d); h.emit({ ok: true }); return 0; }
    case 'sch-annotate': { const d = loadD(pos[1]); if (opt.reset) resetAnnotation(d); const r = annotate(d, { reset: !!opt.reset }); saveD(pos[1], d); h.emit({ ok: true, changed: r.changed.length, list: r.changed.slice(0, 200) }); return 0; }
    case 'sch-erc': { const d = loadD(pos[1]); const m = runErc(d); const errors = m.filter((x) => x.severity === 'error').length; h.emit({ ok: true, errors, warnings: m.length - errors, summary: Object.entries(m.reduce((s: Record<string, number>, x) => { s[x.kind] = (s[x.kind] ?? 0) + 1; return s; }, {})).map(([k, v]) => `${k} ${v}`).join(', '), items: m.slice(0, h.num(opt.limit, 200)) }); return errors ? 2 : 0; }
    case 'sch-netlist': {
      const d = loadD(pos[1]); const f = str(opt.format) ?? 'kicad'; const nl = buildNetlist(d);
      const text = f === 'telesis' ? telesisNetlist(d, nl) : f === 'edif' ? edifNetlist(d, nl) : f === 'spice' ? spiceNetlist(d, {}, nl).text : f === 'json' ? JSON.stringify({ parts: nl.parts.map((p) => ({ ref: p.ref, value: p.value, footprint: p.footprint, part: p.part })), nets: nl.nets.map((n) => ({ name: n.name, nodes: n.nodes.map((x) => `${x.ref}.${x.pin}`) })) }, null, 1) : kicadNetlist(d, nl);
      writeFileSync(resolve(pos[2]), text); h.emit({ ok: true, file: pos[2], format: f, parts: nl.parts.length, nets: nl.nets.length }); return 0;
    }
    case 'sch-bom': { const d = loadD(pos[1]); const r = bom(d, { variant: str(opt.variant), onePerLine: !!opt['one-per-line'] }); writeFileSync(resolve(pos[2]), r.csv); h.emit({ ok: true, file: pos[2], lines: r.rows.length, parts: r.rows.reduce((s, x) => s + x.qty, 0) }); return 0; }
    case 'sch-xref': { const d = loadD(pos[1]); writeFileSync(resolve(pos[2]), crossReference(d)); h.emit({ ok: true, file: pos[2] }); return 0; }
    case 'sch-pdf': { const d = loadD(pos[1]); const b = designPdf(d); writeFileSync(resolve(pos[2]), b); h.emit({ ok: true, file: pos[2], bytes: b.length, pages: d.schematics.reduce((s, x) => s + x.pages.length, 0) }); return 0; }
    case 'sch-svg': { const d = loadD(pos[1]); const pg = str(opt.page); const sch = pg ? d.schematics.find((s) => s.pages.some((p) => p.name === pg))! : schematicOf(d, d.root)!; writeFileSync(resolve(pos[2]), pageSvg(d, sch.name, pg ?? sch.pages[0].name)); h.emit({ ok: true, file: pos[2] }); return 0; }
    case 'sch-to-board': {
      const d = loadD(pos[1]); const boardFile = resolve(pos[2]);
      const board = existsSync(boardFile) ? h.load(boardFile) : undefined;
      const r = toBoard(d, board, { variant: str(opt.variant) });
      h.save(boardFile, r.project); d.boardLink = { project: boardFile, lastSync: new Date().toISOString() }; saveD(pos[1], d);
      h.emit({ ok: true, board: pos[2], created: !board, ...r.report }); return 0;
    }
    case 'sch-back-annotate': {
      const d = loadD(pos[1]); const p = h.load(pos[2]);
      const renames: { was: string; is: string }[] = [];
      if (str(opt['was-is'])) for (const line of readFileSync(resolve(str(opt['was-is'])!), 'utf8').split(/\r?\n/)) { const m = /^(\S+)\s+(\S+)$/.exec(line.trim()); if (m && !line.startsWith('#')) renames.push({ was: m[1], is: m[2] }); }
      // value / footprint edits made on the board
      const nl = buildNetlist(d); const values: Record<string, string> = {}, footprints: Record<string, string> = {};
      for (const pp of nl.parts) { const c = p.components.find((x) => x.ref === (renames.find((r) => r.was === pp.ref)?.is ?? pp.ref)); if (!c) continue; if (c.value && c.value !== pp.value) values[pp.ref] = c.value; if (c.footprint !== pp.footprint && !c.footprint.endsWith('?') && !c.footprint.startsWith('PH_')) footprints[pp.ref] = c.footprint; }
      const r = backAnnotate(d, { renames, values, footprints }); saveD(pos[1], d); h.emit({ ok: true, ...r }); return 0;
    }
    case 'sch-simulate': {
      const d = loadD(pos[1]); const probe = str(opt.probe)?.split(',');
      const tran = str(opt.tran)?.split(',').map(Number), ac = str(opt.ac)?.split(',').map(Number);
      const r = simulate(d, { op: !!opt.op || (!tran && !ac), ...(tran ? { tran: { step: tran[0], stop: tran[1] } } : {}), ...(ac ? { ac: { fStart: ac[0], fStop: ac[1], points: ac[2] ?? 20 } } : {}), probes: probe });
      h.emit({ ok: true, ...r }); return 0;
    }
  }
  return undefined;
}
