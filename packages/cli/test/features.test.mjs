// Integration test of the openpcb CLI: a synthetic board is imported, routed, and every editing, export,
// manufacturing and analysis command is run on it. Run with: node --test packages/cli/test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, statSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeSyntheticDesign } from '../../router/dist/synth.js';
import { writeDsn } from '../../router/dist/dsn.js';

const here = dirname(fileURLToPath(import.meta.url));
const CLI = join(here, '../dist/cli/src/openpcb.js');
const dir = mkdtempSync(join(tmpdir(), 'openpcb-'));
const P = join(dir, 'b.openboard.json');
const f = (n) => join(dir, n);
/** Runs the CLI; exit 0, or 2 for "ran fine, found something", is accepted. Returns the JSON result. */
function cli(...args) {
  const r = spawnSync(process.execPath, ['--max-old-space-size=4000', CLI, ...args], { encoding: 'utf8', maxBuffer: 1 << 28 });
  assert.ok(r.status === 0 || r.status === 2, `${args.join(' ')} exited ${r.status}: ${r.stderr.slice(0, 400)}`);
  const out = JSON.parse(r.stdout);
  assert.equal(out.ok, true, `${args[0]}: ${r.stdout.slice(0, 300)}`);
  return out;
}
const nonEmpty = (n) => assert.ok(existsSync(f(n)) && statSync(f(n)).size > 0, `${n} written`);
const blocking = (d) => d.items.filter((v) => !/sliver|silk/.test(v.kind));

test('setup: synthetic board imported and routed clean', () => {
  writeFileSync(f('s.dsn'), writeDsn(makeSyntheticDesign({ seed: 7, chips: 2, passives: 6, nets: 12 })));
  cli('import-dsn', f('s.dsn'), P);
  const r = cli('route', P, '--passes', '20');
  assert.equal(r.unrouted, 0); assert.equal(r.conflicts, 0);
  const d = cli('drc', P);
  assert.equal(blocking(d).length, 0, JSON.stringify(blocking(d).slice(0, 3)));
});

test('constraints: classes, class spacing and regions are stored and reach the router', () => {
  const p0 = JSON.parse(readFileSync(P, 'utf8'));
  const nets = p0.nets.map((n) => n.name).filter(Boolean);
  cli('class', P, 'PWR', '--nets', nets.slice(0, 2).join(','), '--width', '0.2');
  cli('class', P, 'SIG', '--nets', nets.slice(2, 4).join(','));
  cli('class-clearance', P, 'PWR', 'SIG', '0.2');
  cli('region', P, 'NECK', '5,5,15,15', '--width', '0.12', '--clearance', '0.12');
  const p = JSON.parse(readFileSync(P, 'utf8'));
  assert.ok(p.netClasses.some((c) => c.name === 'PWR')); assert.equal(p.classClearances.length, 1); assert.equal(p.regions.length, 1);
  cli('export-dsn', P, f('c.dsn'));
  const dsn = readFileSync(f('c.dsn'), 'utf8');
  assert.match(dsn, /\(class PWR/); assert.match(dsn, /class_class/); assert.match(dsn, /\(region NECK/);
});

test('route editing: smooth, tune/detune, stitch keep the board clean', () => {
  const s = cli('smooth', P);
  assert.ok(s.after <= s.before + 1e-6, 'smooth never lengthens');
  assert.equal(blocking(cli('drc', P)).length, 0, 'clean after smooth');
  cli('tune', P); cli('detune', P);
  assert.equal(blocking(cli('drc', P)).length, 0, 'clean after tune + detune');
});

test('exports: DXF, PDF, GDSII, ODB++, IPC-2581, STEP, IDF, IDX, netlists, Gerber', () => {
  cli('export-dxf', P, f('b.dxf')); nonEmpty('b.dxf');
  cli('export-pdf', P, f('b.pdf')); nonEmpty('b.pdf'); assert.equal(readFileSync(f('b.pdf')).subarray(0, 5).toString(), '%PDF-');
  cli('export-gds', P, f('b.gds')); nonEmpty('b.gds');
  cli('export-odb', P, f('b.zip')); nonEmpty('b.zip');
  cli('export-ipc2581', P, f('b.xml')); assert.match(readFileSync(f('b.xml'), 'utf8'), /IPC-2581/);
  cli('export-step', P, f('b.step')); assert.match(readFileSync(f('b.step'), 'utf8'), /ISO-10303-21/);
  cli('export-idf', P, f('b')); cli('export-idx', P, f('b.idx')); nonEmpty('b.idx');
  cli('export-netlist', P, f('b.net')); nonEmpty('b.net');
  cli('export-netlist', P, f('b.tel'), '--format', 'telesis'); nonEmpty('b.tel');
  const g = cli('gerber', P, f('fab'));
  assert.ok(g.files.length > 5);
});

test('manufacturing: panel, variant assembly, backdrill, thieving', () => {
  cli('panelize', P, f('panel.openboard.json'), '--nx', '2', '--ny', '2');
  assert.equal(blocking(cli('drc', f('panel.openboard.json'))).length, 0, 'panel is DRC-clean');
  const p = JSON.parse(readFileSync(P, 'utf8'));
  const ref = p.components[0].ref;
  cli('variant', P, 'LITE', '--dnp', ref);
  const a = cli('assembly', P, f('asm'), '--variant', 'LITE');
  const cpl = a.files.find((n) => /CPL/.test(n));
  assert.ok(!readFileSync(join(f('asm'), cpl), 'utf8').split(String.fromCharCode(10)).some((l) => l.startsWith(`${ref},`)), 'DNP part left out of the variant placement file');
  cli('backdrill', P, '--nets', p.nets[0].name);
  cli('thieving', P, '--pitch', '2');
});

test('analysis: SI, current, EMI, 3D clearance, compare, waivers, refdes rename', () => {
  const si = cli('si', P);
  assert.ok(Array.isArray(si.report) && si.report.length > 0 && si.report.every((r) => r.length > 0 && r.delayPs > 0), 'SI report per routed net');
  cli('current', P); cli('emi', P); cli('clearance3d', P);
  copyFileSync(P, f('old.openboard.json'));
  cli('rename-refdes', P, '--out', f('was_is.txt')); nonEmpty('was_is.txt');
  const c = cli('compare', f('old.openboard.json'), P);
  assert.ok(JSON.stringify(c).length > 20, 'compare reports the renamed parts');
  cli('waive', P, '--kind', 'mask-sliver');
  assert.equal(cli('drc', P).items.filter((v) => v.kind === 'mask-sliver').length, 0, 'waived kind hidden');
});
