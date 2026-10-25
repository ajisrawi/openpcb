#!/usr/bin/env node
/**
 * openroute <design.dsn> [-do <file.do>] [-ses <out.ses>] [-passes N] [-quit] [-nog] [-s <status>]
 *
 * Mirrors the SPECCTRA command line: a design file, an optional do file that
 * scripts the session, and switches. Without -do the router runs smart_route
 * and writes <design>.ses next to the design.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, basename, resolve } from 'node:path';
import { parseDsn } from './dsn.js';
import { Interpreter } from './commands.js';

function main(argv: string[]): number {
  if (argv.length === 0 || argv.includes('-h') || argv.includes('--help')) {
    console.log('usage: openroute <design.dsn> [-do file.do] [-ses out.ses] [-passes N] [-quit] [-nog] [-s status.sts] [-pitch units] [-maxcells N] [-fast [w]] [-resume prev.ses] [-edge units] [-via dia:drill:from:to]...');
    return 2;
  }
  let design = '', doFile = '', sesOut = '', status = '';
  let passes = 0; let pitch = 0; let maxCells = 0; let fast = 0; let resume = ''; let edge = 0; const vias: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-do') doFile = argv[++i];
    else if (a === '-ses' || a === '-o') sesOut = argv[++i];
    else if (a === '-passes') passes = Number(argv[++i]);
    else if (a === '-s') status = argv[++i];
    else if (a === '-pitch') pitch = Number(argv[++i]);
    else if (a === '-maxcells') maxCells = Number(argv[++i]);
    else if (a === '-fast') fast = Number(argv[i + 1]) > 1 ? Number(argv[++i]) : 1.5;
    else if (a === '-resume' || a === '-ses-in') resume = argv[++i];
    else if (a === '-edge') edge = Number(argv[++i]);
    else if (a === '-via') vias.push(argv[++i]);
    else if (a.startsWith('-')) { /* -quit, -nog and other SPECCTRA switches accepted */ }
    else design = a;
  }
  if (!design) { console.error('no design file given'); return 2; }
  const designPath = resolve(design);
  const text = readFileSync(designPath, 'utf8');
  const d = parseDsn(text);
  const dir = dirname(designPath);
  const base = basename(designPath).replace(/\.[^.]+$/, '');
  const t0 = Date.now();
  const it = new Interpreter(d, {
    files: { read: (p) => readFileSync(p, 'utf8'), write: (p, t) => writeFileSync(p, t) },
    designDir: dir, designFile: basename(designPath),
    log: (s) => console.log(s),
    router: { ...(pitch ? { pitch } : {}), ...(maxCells ? { maxCells } : {}), ...(fast ? { heuristicWeight: fast } : {}), ...(edge ? { edgeClearance: edge } : {}) },
  });
  console.log(`OpenRoute 0.1 — design ${d.id}: ${d.network.nets.size} nets, ${d.placement.length} components, ${d.structure.layers.length} layers, resolution ${d.resolution.unit} ${d.resolution.value}`);
  if (status) it.exec(`status_file "${resolve(status).split('\\').join('/')}"`);
  if (vias.length) {
    // -via 0.2:0.1:F.Cu:In2.Cu  (diameter:drill:from:to in mm) declares an extra via span before routing
    it.exec('unit mm');
    for (const v of vias) { const [dia, dr, from, to] = v.split(':'); it.exec(`define via ${dia} ${dr} "${from}" "${to}"`); }
    it.unit = d.unit;
  }
  if (resume) it.exec(`read session "${resolve(resume).split('\\').join('/')}"`);
  if (doFile) it.run(readFileSync(resolve(doFile), 'utf8'));
  else {
    const r = it.ensureRouter();
    if (passes > 0) { r.fanout(); r.route(passes); r.clean(2); r.restoreBest(); } else r.smartRoute();
  }
  if (!it.wroteSession) {
    const out = sesOut ? resolve(sesOut) : resolve(dir, base + '.ses');
    it.exec(`write session "${out.replace(/\\/g, '/')}"`);
  }
  console.log(it.ensureRouter().statusReport());
  console.log(`total time ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  const r = it.ensureRouter();
  return r.connections.every((c) => c.path && c.conflicts === 0) ? 0 : 1;
}

process.exitCode = main(process.argv.slice(2));
