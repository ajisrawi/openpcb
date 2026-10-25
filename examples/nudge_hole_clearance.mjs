// Fix tiny hole-to-copper misses left by the routing lattice: an interior trace vertex (usually a miter chamfer
// point) that sits a few micrometres too close to another net's via hole is pushed radially away from the via
// until the hole-to-copper rule holds (plus a small margin). Only vertices of other nets' traces on layers the via
// spans are moved, never trace end points (they connect to something), and only by at most --max mm.
// Re-run `openpcb drc` afterwards: every change is reported so it can be checked.
//
// usage: node examples/nudge_hole_clearance.mjs <project.openboard.json> [--max 0.03] [--margin 0.005]
import { readFileSync, writeFileSync } from 'node:fs';
import { normalizeProject, viaLayers } from '../packages/cli/dist/editor/src/model.js';

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? Number(args[i + 1]) : d; };
const file = args[0];
const raw = JSON.parse(readFileSync(file, 'utf8'));
const p = normalizeProject(raw);
const MAX = opt('--max', 0.03), MARGIN = opt('--margin', 0.005);
const R = p.rules;
const allLayers = p.layers.map((l) => l.name);
const changes = [];
for (const v of p.vias) {
  const vl = viaLayers(p, v);
  const laser = vl.length < allLayers.length && (vl[0] === allLayers[0] || vl[vl.length - 1] === allLayers[allLayers.length - 1]);
  const h2c = laser ? R.laserHoleToCopper : R.holeToCopper;
  for (const t of raw.traces) {
    if (t.net === v.net || !vl.includes(t.layer)) continue;
    const need = v.drill / 2 + h2c + t.width / 2 + MARGIN;   // vertex centre to via centre
    for (let i = 1; i < t.points.length - 1; i++) {
      const q = t.points[i], d = Math.hypot(q.x - v.x, q.y - v.y);
      if (d >= need || d === 0 || need - d > MAX) continue;
      const k = need / d, nq = { x: v.x + (q.x - v.x) * k, y: v.y + (q.y - v.y) * k };
      changes.push({ net: t.net, layer: t.layer, from: [+q.x.toFixed(4), +q.y.toFixed(4)], to: [+nq.x.toFixed(4), +nq.y.toFixed(4)], via: v.net, moved: +(need - d).toFixed(4) });
      t.points[i] = nq;
    }
  }
}
writeFileSync(file, JSON.stringify(raw));
console.log(JSON.stringify({ ok: true, moved: changes.length, changes }, null, 1));
