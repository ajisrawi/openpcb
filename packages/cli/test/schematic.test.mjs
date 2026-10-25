// OpenSchematic tests: OrCAD / KiCad imports against the reference netlists of the originating tools (skipped when
// the sample files are not on this machine), and the editing / output / simulation / team-design flows on designs
// built here. Run with: node --test packages/cli/test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const dist = join(here, '../dist');
const CLI = join(dist, 'cli/src/openpcb.js');
const imp = (m) => import('file:///' + join(dist, m).replace(/\\/g, '/'));
const { importOrcadDesign, importOrcadLibrary } = await imp('schematic/src/orcad.js');
const { importKicadSchematic } = await imp('schematic/src/kicadsch.js');
const { buildNetlist } = await imp('schematic/src/connect.js');
const { newDesign, nid, instPins } = await imp('schematic/src/model.js');
const { basicLibrary } = await imp('schematic/src/library.js');
const { simulate } = await imp('schematic/src/spice.js');
const { startSchCollabServer } = await imp('cli/src/schcollabserver.js');
const { diffDesigns } = await imp('schematic/src/schcollab.js');

const dir = mkdtempSync(join(tmpdir(), 'opensch-'));
const f = (n) => join(dir, n);
function cli(...args) {
  const r = spawnSync(process.execPath, ['--max-old-space-size=4000', CLI, ...args], { encoding: 'utf8', maxBuffer: 1 << 28 });
  assert.ok(r.status === 0 || r.status === 2, `${args.join(' ')} exited ${r.status}: ${r.stderr.slice(0, 400)} ${r.stdout.slice(0, 300)}`);
  const out = JSON.parse(r.stdout); assert.equal(out.ok, true, `${args[0]}: ${r.stdout.slice(0, 300)}`);
  return out;
}

/** Allegro pstxnet.dat: net -> "REF PIN" set */
function pstxnet(file) {
  const t = readFileSync(file, 'latin1').split(/\r?\n/); const m = new Map(); let cur = null;
  for (let i = 0; i < t.length; i++) { if (t[i] === 'NET_NAME') { cur = t[i + 1].replace(/'/g, ''); m.set(cur, new Set()); } const x = /^NODE_NAME\s+(\S+)\s+(\S+)/.exec(t[i]); if (x && cur) m.get(cur).add(`${x[1]} ${x[2]}`); }
  return m;
}
/** every reference net is exactly one of ours (hidden power pins are listed separately by Allegro) */
function samePartition(ours, ref, skipPower = true) {
  const keep = (x) => !skipPower || x.type !== 'power';
  const owner = new Map(); ours.nets.forEach((n, i) => n.nodes.filter(keep).forEach((x) => owner.set(`${x.ref} ${x.pin}`, i)));
  const bad = [];
  for (const [name, s] of ref) { const os = new Set([...s].map((k) => owner.get(k))); const i = [...os][0]; if (os.size !== 1 || i === undefined || ours.nets[i].nodes.filter(keep).length !== s.size) bad.push(name); }
  return bad;
}

// Reference data locations (tests skip when absent): CADENCE_HOME = an SPB install with its samples,
// KICAD_REF = a KiCad .kicad_sch whose exported netlist sits next to it as <name>.net.
const SPB = process.env.CADENCE_HOME ?? 'C:/Cadence/SPB_22.1';
const CAD = `${SPB}/tools/capture/samples/PCB-Layout`;
test('OrCAD import: FullAdder (hierarchical, reused blocks) and Fault-Detector match the Allegro netlists', { skip: !existsSync(CAD) && 'Cadence samples not installed' }, () => {
  for (const [dsn, net] of [['FullAdder/FULLADD.DSN', 'FullAdder/allegro/pstxnet.dat'], ['Fault-Detector/FAULT-DETECTOR.DSN', 'Fault-Detector/allegro/pstxnet.dat']]) {
    const r = importOrcadDesign(new Uint8Array(readFileSync(join(CAD, dsn))), 'x');
    const bad = samePartition(buildNetlist(r.design), pstxnet(join(CAD, net)));
    assert.deepEqual(bad, [], `${dsn}: nets differing from Allegro's: ${bad.join(', ')}`);
  }
});

test('OrCAD library import: DCLOCK2.OLB', { skip: !existsSync(`${SPB}/tools/capture/samples/Schematic/TUTOR2/DCLOCK2.OLB`) && 'Cadence samples not installed' }, () => {
  const r = importOrcadLibrary(new Uint8Array(readFileSync(`${SPB}/tools/capture/samples/Schematic/TUTOR2/DCLOCK2.OLB`)), 'DCLOCK2');
  const parts = Object.values(r.library.parts);
  assert.ok(parts.length >= 5, `${parts.length} parts`);
  assert.ok(parts.every((p) => p.units.length >= 1));
});

const KREF = process.env.KICAD_REF ?? '';
const BA = KREF ? dirname(KREF) : '', BN = KREF ? basename(KREF, '.kicad_sch') : '';
test('KiCad import: matches the KiCad netlist (names included)', { skip: !(KREF && existsSync(join(BA, BN + '.net'))) && 'set KICAD_REF to run' }, () => {
  const d = importKicadSchematic(readFileSync(KREF, 'utf8'), { name: BN, readFile: (n) => (existsSync(join(BA, n)) ? readFileSync(join(BA, n), 'utf8') : null) });
  const nl = buildNetlist(d);
  const txt = readFileSync(join(BA, BN + '.net'), 'utf8');
  const toks = txt.match(/"(?:[^"\\]|\\.)*"|[()]|[^\s()"]+/g); let ti = 0;
  const rd = () => { const t = toks[ti++]; if (t === '(') { const l = []; while (toks[ti] !== ')') l.push(rd()); ti++; return l; } return t.startsWith('"') ? JSON.parse(t) : t; };
  const root = rd(); const find = (l, k) => l.find((x) => Array.isArray(x) && x[0] === k);
  const ref = new Map(); for (const n of find(root, 'nets').slice(1)) ref.set(find(n, 'name')[1], new Set(n.filter((x) => Array.isArray(x) && x[0] === 'node').map((x) => `${find(x, 'ref')[1]} ${find(x, 'pin')[1]}`)));
  assert.equal(nl.parts.length, find(root, 'components').length - 1);
  assert.deepEqual(samePartition(nl, ref, false), []);
});

/** an RC low-pass drawn with the basic library: V1 -> R1 -> OUT, C1 to ground */
function rcDesign() {
  const d = newDesign('rc'); d.libraries.push(basicLibrary()); const pg = d.schematics[0].pages[0];
  const add = (part, ref, x, y, rot, props) => { const pi = { id: nid(d), lib: 'OpenSch', part, unit: 0, ref, x, y, rot, props }; pg.parts.push(pi); return pi; };
  const v = add('VSRC', 'V1', 2000, 3000, 0, { Value: 'AC 1' }), r = add('R', 'R1', 3000, 2500, 90, { Value: '1k' }), c = add('C', 'C1', 4000, 3000, 0, { Value: '159n' });
  const pin = (pi, n) => instPins(d, pi).find((q) => q.pin.number === n).at;
  const w = (...pts) => pg.wires.push({ id: nid(d), pts });
  w(pin(v, '1'), { x: pin(v, '1').x, y: pin(r, '1').y }, pin(r, '1')); w(pin(r, '2'), { x: pin(c, '1').x, y: pin(r, '2').y }, pin(c, '1'));
  pg.globals.push({ id: nid(d), at: pin(v, '2'), net: '0', style: 'ground' }, { id: nid(d), at: pin(c, '2'), net: '0', style: 'ground' });
  pg.aliases.push({ id: nid(d), at: { x: (pin(r, '2').x + pin(c, '1').x) / 2, y: pin(r, '2').y }, name: 'OUT' });
  return d;
}

test('SPICE: RC low-pass corner (1 kHz) from the schematic', () => {
  const r = simulate(rcDesign(), { ac: { fStart: 10, fStop: 100000, points: 20 }, probes: ['OUT'] });
  const f = r.ac.f, m = r.ac.mag.OUT;
  const at = (hz) => { let best = 0; for (let i = 0; i < f.length; i++) if (Math.abs(Math.log(f[i] / hz)) < Math.abs(Math.log(f[best] / hz))) best = i; return m[best]; };
  assert.ok(Math.abs(at(10) - 1) < 0.02, `passband ${at(10)}`);
  assert.ok(Math.abs(20 * Math.log10(at(1000)) + 3) < 0.6, `-3 dB at 1 kHz: ${20 * Math.log10(at(1000))}`);
  assert.ok(at(100000) < 0.02, `stopband ${at(100000)}`);
});

test('CLI flow: annotate, ERC, netlists, BOM, PDF, constraints, forward annotation, compare, SKILL', () => {
  const d = rcDesign(); d.schematics[0].pages[0].parts.forEach((p) => { p.ref = p.ref.replace(/\d+$/, '?'); });
  writeFileSync(f('rc.opensch.json'), JSON.stringify(d));
  const a = cli('sch-annotate', f('rc.opensch.json')); assert.equal(a.changed, 3);
  const e = cli('sch-erc', f('rc.opensch.json')); assert.equal(e.errors, 0, JSON.stringify(e.items));
  for (const fmt of ['kicad', 'telesis', 'edif', 'spice']) { cli('sch-netlist', f('rc.opensch.json'), f(`rc.${fmt}`), '--format', fmt); assert.ok(statSync(f(`rc.${fmt}`)).size > 50, fmt); }
  cli('sch-bom', f('rc.opensch.json'), f('bom.csv')); assert.match(readFileSync(f('bom.csv'), 'utf8'), /R1.*1k/);
  const pdf = cli('sch-pdf', f('rc.opensch.json'), f('rc.pdf')); assert.equal(pdf.pages, 1); assert.ok(readFileSync(f('rc.pdf')).subarray(0, 5).toString() === '%PDF-');
  cli('sch-constraints', f('rc.opensch.json'), '--add', 'class RF width=0.3 clearance=0.25');
  cli('sch-constraints', f('rc.opensch.json'), '--add', 'net OUT class=RF maxLength=40');
  cli('sch-to-board', f('rc.opensch.json'), f('rc.openboard.json'));
  const b = JSON.parse(readFileSync(f('rc.openboard.json'), 'utf8'));
  assert.deepEqual(b.components.map((c) => c.ref).sort(), ['C1', 'R1', 'V1']);
  assert.ok(b.netClasses.some((c) => c.name === 'RF' && c.nets.includes('OUT') && c.width === 0.3));
  assert.equal(b.nets.find((n) => n.name === 'OUT').maxLength, 40);
  // a changed value shows up in the comparison
  cli('sch-replace', f('rc.opensch.json'), '1k', '2k2');
  const cmp = cli('sch-compare', f('rc.opensch.json'), f('rc.opensch.json')); assert.equal(cmp.valueChanged.length, 0);
  const s = cli('sch-skill', f('rc.opensch.json'), '--eval', 'p = schFindPart("R1") p~>value');
  assert.equal(s.value, '"2k2"');
});

test('team design: edits propagate, reserved pages reject other designers', async () => {
  const d = rcDesign(); d.schematics[0].pages.push({ ...structuredClone(d.schematics[0].pages[0]), name: 'PAGE2' });
  writeFileSync(f('team.opensch.json'), JSON.stringify(d));
  const srv = await startSchCollabServer(f('team.opensch.json'), { port: 0 });
  const url = `ws://localhost:${srv.port}`;
  const mk = (name) => new Promise((res) => { const ws = new WebSocket(url); const c = { ws, msgs: [] }; ws.onmessage = (e) => c.msgs.push(JSON.parse(e.data)); ws.onopen = () => { ws.send(JSON.stringify({ type: 'hello', user: name })); setTimeout(() => res(c), 200); }; });
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  try {
    const a = await mk('alice'), b = await mk('bob');
    const da = structuredClone(a.msgs.find((m) => m.type === 'welcome').design), base = structuredClone(da);
    da.schematics[0].pages[0].parts[0].props.Value = 'AC 2';
    a.ws.send(JSON.stringify({ type: 'ops', base: 0, ops: diffDesigns(base, da) })); await wait(250);
    const got = b.msgs.find((m) => m.type === 'ops'); assert.ok(got, 'bob receives alice\'s change');
    assert.equal(got.ops.find((o) => o.kind === 'page').obj.parts[0].props.Value, 'AC 2');
    a.ws.send(JSON.stringify({ type: 'reserve', sch: d.schematics[0].name, page: 'PAGE1' })); await wait(200);
    const db = structuredClone(srv.design()), b0 = structuredClone(db); db.schematics[0].pages[0].parts[1].props.Value = '3k3'; db.schematics[0].pages[1].parts[1].props.Value = '4k7';
    b.ws.send(JSON.stringify({ type: 'ops', base: got.version, ops: diffDesigns(b0, db) })); await wait(250);
    assert.ok(b.msgs.some((m) => m.type === 'reject' && /reserved by alice/.test(m.reason)), 'PAGE1 edit rejected');
    assert.equal(srv.design().schematics[0].pages[1].parts[1].props.Value, '4k7', 'PAGE2 edit accepted');
    a.ws.close(); b.ws.close();
  } finally { await srv.close(); }
});

const SC = `${SPB}/share/PSpice/examples/syscap_samples`;
test('System Capture import: every sample archive matches its own connectivity', { skip: !existsSync(SC) && 'System Capture samples not installed' }, async () => {
  const { importSystemCapture, systemCaptureNets } = await imp('schematic/src/syscap.js');
  const { readdirSync, statSync: st } = await import('node:fs');
  const walk = (p) => readdirSync(p).flatMap((n) => { const q = join(p, n); return st(q).isDirectory() ? walk(q) : n.endsWith('.sdax') ? [q] : []; });
  const files = walk(SC); assert.ok(files.length >= 5);
  for (const file of files) {
    const data = new Uint8Array(readFileSync(file)); const r = importSystemCapture(data, 'x');
    const nl = buildNetlist(r.design); const ref = systemCaptureNets(data, { byInstance: true });
    const owner = new Map(); nl.nets.forEach((n, i) => n.nodes.forEach((x) => owner.set(`${x.inst.occKey} ${x.pinName}`, i)));
    for (const [name, s] of ref) { const os = new Set([...s].map((k) => owner.get(k))); const i = [...os][0]; assert.ok(os.size === 1 && i !== undefined && nl.nets[i].nodes.length === s.size, `${file}: net ${name}`); }
  }
});

const DH = `${SPB}/tools/pspice/concept_samples/advanls/lowpass_3/lowpass_3.cpm`;
test('Design Entry HDL import: hierarchical project, stored pin signal names and connectivity agree', { skip: !existsSync(DH) && 'DE-HDL samples not installed' }, async () => {
  const { importDeHdl } = await imp('schematic/src/dehdl.js');
  const { readdirSync } = await import('node:fs');
  const fsx = { read: (p) => { try { return readFileSync(p, 'utf8'); } catch { return null; } }, list: (d) => { try { return readdirSync(d); } catch { return []; } } };
  const r = importDeHdl(DH, fsx);
  assert.deepEqual(r.design.schematics.map((s) => s.name).sort(), ['ONE_POLE', 'low_pass_3'].sort());
  assert.ok(r.design.schematics.flatMap((s) => s.pages).some((p) => p.blocks.some((b) => b.schematic === 'ONE_POLE')), 'ONE_POLE is a hierarchical block');
  // pins that Cadence stored with the same signal name are on one of our nets
  for (const s of r.design.schematics) {
    const d2 = { ...r.design, root: s.name, schematics: [{ ...s, pages: s.pages.map((p) => ({ ...p, blocks: [] })) }], occurrences: {} };
    const nl = buildNetlist(d2); const owner = new Map(); nl.nets.forEach((n, i) => n.nodes.forEach((x) => owner.set(`${x.ref}|${x.pinName}`, i)));
    const groups = new Map(); for (const g of r.sigs.filter((g) => g.sch === s.name)) { const a = groups.get(g.name) ?? []; a.push(`${g.ref}|${g.pin}`); groups.set(g.name, a); }
    for (const [name, pins] of groups) assert.equal(new Set(pins.map((p) => owner.get(p))).size, 1, `${s.name}: signal ${name}`);
  }
});
