// Integration tests of the newer board features: gridless (shape-based) routing, the field solver and thermal
// analysis, RF elements and simulation export, flex / rigid-flex, wire bonding and OpenSKILL.
// Run with: node --test packages/cli/test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeSyntheticDesign } from '../../router/dist/synth.js';
import { writeDsn } from '../../router/dist/dsn.js';

const here = dirname(fileURLToPath(import.meta.url));
const CLI = join(here, '../dist/cli/src/openpcb.js');
const dir = mkdtempSync(join(tmpdir(), 'openpcb-adv-'));
const f = (n) => join(dir, n);
function cli(...args) {
  const r = spawnSync(process.execPath, ['--max-old-space-size=4000', CLI, ...args], { encoding: 'utf8', maxBuffer: 1 << 28 });
  assert.ok(r.status === 0 || r.status === 2, `${args.join(' ')} exited ${r.status}: ${r.stderr.slice(0, 400)} ${r.stdout.slice(0, 300)}`);
  const out = JSON.parse(r.stdout);
  assert.equal(out.ok, true, `${args[0]}: ${r.stdout.slice(0, 300)}`);
  return out;
}
const load = (p) => JSON.parse(readFileSync(p, 'utf8'));

const G = f('g.openboard.json');
test('gridless router: a synthetic board routes completely without conflicts', () => {
  writeFileSync(f('g.dsn'), writeDsn(makeSyntheticDesign({ seed: 11, chips: 2, passives: 5, nets: 10 })));
  cli('import-dsn', f('g.dsn'), G);
  const r = cli('route', G, '--gridless', '--passes', '12', '--time-limit', '240');
  assert.equal(r.engine, 'gridless');
  assert.equal(r.unrouted, 0, `open connections: ${JSON.stringify(r.status)}`);
  assert.equal(r.conflicts, 0);
  const d = cli('drc', G);
  assert.equal(d.items.filter((v) => !/sliver|silk/.test(v.kind)).length, 0, JSON.stringify(d.items.slice(0, 3)));
});

test('field solver: target width for 50 ohm and a cross-section solve agree', () => {
  // microstrip: the bottom layer becomes the ground plane under the top layer
  const p0 = load(G); p0.layers[p0.layers.length - 1].type = 'power'; writeFileSync(G, JSON.stringify(p0));
  const p = load(G); const layer = p.layers[0].name;
  const w = cli('impedance-width', G, '--layer', layer, '--z', '50');
  const width = w.width ?? w.result?.width;
  assert.ok(width > 0.02 && width < 5, `width ${JSON.stringify(w).slice(0, 200)}`);
  const z = cli('fieldsolve', G, '--layer', layer, '--width', String(width));
  const z0 = z.z0 ?? z.result?.z0 ?? z.single?.z0;
  assert.ok(Math.abs(z0 - 50) < 2.5, `solved ${z0} ohm for the 50 ohm width`);
});

test('thermal: dissipation heats the part, energy balance holds', () => {
  const ref = load(G).components[0].ref;
  cli('part-power', G, ref, '1.5');
  const t = cli('thermal', G, '--cell', '1', '--svg', f('t.svg'));
  const max = t.maxTemp ?? t.result?.maxTemp;
  assert.ok(max > (t.ambient ?? 25) + 1, `max temperature ${max}`);
  assert.ok(existsSync(f('t.svg')) && statSync(f('t.svg')).size > 100);
});

test('RF: a 50 ohm line, a stub, an openEMS script', () => {
  const p = load(G); const b = p.outline; const x0 = Math.min(...b.map((q) => q.x)) + 2, y0 = Math.min(...b.map((q) => q.y)) + 2;
  const line = cli('rf-line', G, '--net', 'RF_TEST', '--layer', p.layers[0].name, '--points', `${x0},${y0},${x0 + 10},${y0},${x0 + 10},${y0 + 6}`, '--z', '50');
  assert.ok(line.element, 'line element');
  cli('rf-stub', G, '--net', 'RF_TEST', '--layer', p.layers[0].name, '--at', `${x0 + 5},${y0}`, '--angle', '90', '--deg', '90', '--freq', '2.4', '--z', '50');
  assert.ok((load(G).rfElements ?? []).length >= 2, 'two RF elements stored');
  const o = cli('rf-openems', G, f('sim.py'), '--nets', 'RF_TEST', '--fmax', '6');
  assert.ok(existsSync(f('sim.py')) && readFileSync(f('sim.py'), 'utf8').includes('openEMS'), JSON.stringify(o).slice(0, 200));
});

test('flex: zone, bend, stiffener, flex DRC and a bent STEP', () => {
  const p = load(G); const b = p.outline; const x1 = Math.min(...b.map((q) => q.x)), x2 = Math.max(...b.map((q) => q.x)), y1 = Math.min(...b.map((q) => q.y)), y2 = Math.max(...b.map((q) => q.y));
  const mx = (x1 + x2) / 2;
  cli('flex-zone', G, 'FLEX1', '--points', `${mx - 3},${y1},${mx + 3},${y1},${mx + 3},${y2},${mx - 3},${y2}`, '--layers', p.layers.map((l) => l.name).join(','));
  cli('bend', G, 'B1', '--points', `${mx - 2},${y1},${mx + 2},${y1},${mx + 2},${y2},${mx - 2},${y2}`, '--axis', `${mx},${y1},${mx},${y2}`, '--angle', '90', '--radius', '1');
  cli('stiffener', G, '--side', 'back', '--points', `${x1},${y1},${x1 + 5},${y1},${x1 + 5},${y1 + 5},${x1},${y1 + 5}`);
  cli('flex-drc', G);
  const s = cli('export-step-bent', G, f('bent.step'));
  assert.ok(existsSync(f('bent.step')) && statSync(f('bent.step')).size > 1000, JSON.stringify(s.check).slice(0, 200));
});

test('wire bonding: fingers around a die, a profile, wire DRC and report', () => {
  const p = load(G); const die = p.components.find((c) => /^U/.test(c.ref)) ?? p.components[0];
  cli('bond-profile', G, 'STD', '--loop', '0.15', '--angle', '30');
  const r = cli('bond-fingers', G, die.ref, '--profile', 'STD');
  assert.ok((load(G).bondWires ?? []).length > 0, JSON.stringify(r).slice(0, 200));
  cli('bond-drc', G);
  const rep = cli('bond-report', G);
  assert.ok(rep.wires > 0 && rep.totalLength > 0);
});

test('OpenSKILL: expressions and database access', () => {
  const r = cli('skill', G, '--eval', 'plus(1 2)');
  assert.equal(r.value, '3');
  const n = cli('skill', G, '--eval', 'length(axlDBGetDesign()->components)');
  assert.equal(Number(n.value), load(G).components.length);
});
