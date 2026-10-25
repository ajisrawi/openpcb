/**
 * OpenBoard — browser PCB layout editor.
 * Place footprints, assign nets, draw traces/vias, run DRC, export DSN, run
 * OpenRoute in a worker, import the session (the Allegro "Route Automatic"
 * flow, reimplemented).
 */
import { xprobeSend, xprobeOn } from './xprobe.js';
import { type Project, type Component, type Trace, type ViaDef, type Pt, type Pad, newProject, nextId, uniqueRef, padToBoard, netOfPin, findNet, normalizeProject, LAYER_COLORS } from './model.js';
import { defaultLibrary } from './footprints.js';
import { View, type ViewState } from './view.js';
import { ratsnest, padInstances } from './connectivity.js';
import { projectDrc, drcSummary } from './drc.js';
import { autoplace } from './place.js';
import { exportFabrication, exportAssembly, zipFiles } from './fab.js';
import { addTestPoints } from './testpoints.js';
import { shoveVictims, lengthStatus, pushShove } from './interactive.js';
import { parseKicadFootprint, importKicadNetlist } from './kicad.js';
import { exportDsn, importSession, importDsn } from './dsnio.js';
import { copySelection, pasteClip, measure, autoswapPins, autoswapComponents, type Clip } from './edit.js';
import { tuneProject, detuneProject, smoothProject, stitchVias, viaFence } from './tools.js';
import { exportDxf, exportPdf, exportGdsii, exportOdb, exportIpc2581 } from './exports.js';
import { exportStep, exportIdf, exportIdx, exportKicadNetlist, exportTelesisNetlist, renameRefdes, wasIsText } from './mcad.js';
import { importKicadPcb, importEagle, importGerber } from './imports.js';
import { panelize, addCoupon, backdrillFiles } from './fabdoc.js';
import { siReport, irDrop, emiCheck, currentCheck, clearance3d } from './analysis.js';
import { View3D } from './view3d.js';
import { drcKey } from './model.js';
import { installExtras } from './ui_extra.js';

type Tool = 'select' | 'place' | 'route' | 'via' | 'net' | 'keepout' | 'zone' | 'measure' | 'text' | 'dimension' | 'room';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const canvas = $('board') as HTMLCanvasElement;
const view = new View(canvas);
let project: Project = newProject('demo');
const lib = defaultLibrary();
let tool: Tool = 'select';
const st: ViewState = { activeLayer: 'F.Cu', selectedRefs: new Set(), selectedTraces: new Set(), selectedVias: new Set(), rats: [], drc: [], showRats: true, showDrc: true, showRefs: true };
let undoStack: string[] = [];
let redoStack: string[] = [];
let clip: Clip | null = null;
let cursorWorld: Pt = { x: 0, y: 0 };
let activeNet: string | null = null;
let worker: Worker | null = null;

/* ---------- logging / status ---------- */
const logEl = $('log') as HTMLPreElement;
function log(line: string): void { logEl.textContent += line + '\n'; const c = $('console'); c.scrollTop = c.scrollHeight; }
function status(text: string): void { $('status').textContent = text; }

const RULE_KEYS = ['minTrackWidth', 'minAnnularRing', 'holeToCopper', 'holeToHole', 'silkToCopper', 'silkWidth', 'maskExpansion', 'minMaskSliver', 'viaLength', 'minMicroviaDiameter', 'minMicroviaDrill', 'laserHoleToCopper', 'laserHoleToHole', 'parallelGap', 'parallelLimit', 'tandemGap', 'tandemLimit'] as const;

/* ---------- state helpers ---------- */
function snapshot(): void { undoStack.push(JSON.stringify(project)); if (undoStack.length > 200) undoStack.shift(); redoStack = []; }
function undo(): void { const s = undoStack.pop(); if (s) { redoStack.push(JSON.stringify(project)); project = normalizeProject(JSON.parse(s)); refreshAll(); status(`undo (${undoStack.length} more, ${redoStack.length} to redo)`); } }
function redo(): void { const s = redoStack.pop(); if (s) { undoStack.push(JSON.stringify(project)); project = normalizeProject(JSON.parse(s)); refreshAll(); status(`redo (${redoStack.length} more)`); } }
function ask(title: string, initial = ''): Promise<string | null> {
  const dlg = $('dlg-net') as HTMLDialogElement; const inp = $('net-name') as HTMLInputElement; const h = dlg.querySelector('h3'); const old = h?.textContent ?? '';
  if (h) h.textContent = title; inp.value = initial;
  return new Promise((res) => { onDialogResult(dlg, (ok) => { if (h) h.textContent = old; res(ok ? inp.value.trim() || null : null); }); dlg.showModal(); inp.focus(); });
}
function selectedNets(): string[] {
  const nets = new Set<string>();
  if (st.highlightNet) nets.add(st.highlightNet);
  for (const id of st.selectedTraces) { const t = project.traces.find((x) => x.id === id); if (t?.net) nets.add(t.net); }
  return [...nets];
}
function snap(v: number, g = 0.25): number { return Math.round(v / g) * g; }
function changed(): void { st.rats = ratsnest(project); render(); (window as unknown as { __collabPush?: () => void }).__collabPush?.(); try { localStorage.setItem('openboard.autosave', JSON.stringify(project)); } catch { /* ignore */ } }
function render(): void { view.render(project, st); }
function refreshAll(): void {
  if (!project.layers.some((l) => l.name === st.activeLayer)) st.activeLayer = project.layers[0].name;
  fillLayerSelect(); fillLayerList(); fillNets(); fillRules(); fillProps(); st.drc = []; fillDrc(); changed();
}

/* ---------- geometry picking ---------- */
function componentAt(p: Pt): Component | undefined {
  for (const c of [...project.components].reverse()) {
    const fp = lib[c.footprint] ?? project.footprints[c.footprint]; if (!fp) continue;
    const r = Math.hypot(fp.body.w, fp.body.h) / 2 + 0.3;
    if (Math.hypot(p.x - c.x, p.y - c.y) <= r) return c;
  }
  return undefined;
}
function padAt(p: Pt) { let best: ReturnType<typeof padInstances>[number] | undefined; let bd = Infinity; for (const pd of padInstances(project)) { const d = Math.hypot(pd.center.x - p.x, pd.center.y - p.y); if (d <= Math.max(pd.w, pd.h) / 2 + 0.2 && d < bd) { bd = d; best = pd; } } return best; }
function traceAt(p: Pt): Trace | undefined {
  for (const t of [...project.traces].reverse()) {
    if (t.layer !== st.activeLayer) continue;
    for (let i = 0; i + 1 < t.points.length; i++) { const a = t.points[i], b = t.points[i + 1]; const dx = b.x - a.x, dy = b.y - a.y; const l2 = dx * dx + dy * dy; let s = l2 ? ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2 : 0; s = Math.max(0, Math.min(1, s)); if (Math.hypot(p.x - a.x - dx * s, p.y - a.y - dy * s) <= t.width / 2 + 0.15) return t; }
  }
  return undefined;
}
function viaAt(p: Pt): ViaDef | undefined { return project.vias.find((v) => Math.hypot(v.x - p.x, v.y - p.y) <= v.diameter / 2 + 0.15); }

/* ---------- UI fill ---------- */
function fillFootprints(): void {
  const sel = $('sel-footprint') as HTMLSelectElement; sel.innerHTML = '';
  for (const name of [...Object.keys(lib), ...Object.keys(project.footprints).filter((n) => !lib[n])]) { const o = document.createElement('option'); o.value = name; o.textContent = name; sel.appendChild(o); }
  sel.value = 'R_0603';
}
function fillLayerSelect(): void {
  const sel = $('sel-layer') as HTMLSelectElement; sel.innerHTML = '';
  for (const l of project.layers) { if (l.type !== 'signal') continue; const o = document.createElement('option'); o.value = l.name; o.textContent = l.name; sel.appendChild(o); }
  sel.value = st.activeLayer;
}
function fillLayerList(): void {
  const el = $('layer-list'); el.innerHTML = '';
  for (const l of project.layers) {
    const row = document.createElement('div'); row.className = 'row';
    const vis = document.createElement('input'); vis.type = 'checkbox'; vis.checked = l.visible; vis.onchange = () => { l.visible = vis.checked; render(); };
    const sw = document.createElement('span'); sw.className = 'swatch'; sw.style.background = l.color;
    const name = document.createElement('span'); name.textContent = `${l.name} (${l.type}${l.direction !== 'off' ? ', ' + l.direction[0].toUpperCase() : ''})`; name.style.flex = '1'; name.style.cursor = 'pointer';
    name.onclick = () => { if (l.type === 'signal') { st.activeLayer = l.name; fillLayerSelect(); render(); } };
    if (l.name === st.activeLayer) name.style.fontWeight = '700';
    row.append(vis, sw, name); el.appendChild(row);
  }
}
function fillNets(): void {
  const el = $('net-list'); el.innerHTML = '';
  for (const n of project.nets) {
    const row = document.createElement('div'); row.className = 'row' + (st.highlightNet === n.name ? ' active' : '');
    row.innerHTML = `<span><span class="swatch" style="background:${n.color ?? '#9aa'}"></span>${n.name}</span><span class="muted">${n.pins.length} pins</span>`;
    row.onclick = () => { st.highlightNet = st.highlightNet === n.name ? undefined : n.name; activeNet = n.name; fillNets(); render(); };
    el.appendChild(row);
  }
}
function fillRules(): void {
  ($('rule-width') as HTMLInputElement).value = String(project.rules.width);
  ($('rule-clear') as HTMLInputElement).value = String(project.rules.clearance);
  ($('rule-via') as HTMLInputElement).value = String(project.rules.viaDiameter);
  ($('rule-drill') as HTMLInputElement).value = String(project.rules.viaDrill);
  for (const k of RULE_KEYS) { const el = document.getElementById('rule-' + k) as HTMLInputElement | null; if (el) el.value = String((project.rules as unknown as Record<string, number>)[k]); }
  const xs = project.outline.map((q) => q.x), ys = project.outline.map((q) => q.y);
  ($('rule-w') as HTMLInputElement).value = String(Math.max(...xs) - Math.min(...xs));
  ($('rule-h') as HTMLInputElement).value = String(Math.max(...ys) - Math.min(...ys));
}
function fillProps(): void {
  const el = $('props'); el.innerHTML = '';
  const ref = [...st.selectedRefs][0];
  const c = ref ? project.components.find((x) => x.ref === ref) : undefined;
  const tid = [...st.selectedTraces][0];
  const t = tid !== undefined ? project.traces.find((x) => x.id === tid) : undefined;
  const field = (label: string, value: string | number, onChange: (v: string) => void, type = 'text') => {
    const l = document.createElement('label'); l.textContent = label; const i = document.createElement('input'); i.type = type; i.value = String(value); i.onchange = () => { snapshot(); onChange(i.value); changed(); fillProps(); }; l.appendChild(i); el.appendChild(l);
  };
  if (c) {
    field('Ref', c.ref, (v) => { renameRef(c, v); });
    field('Value', c.value, (v) => { c.value = v; });
    field('Footprint', c.footprint, (v) => { if (lib[v] || project.footprints[v]) c.footprint = v; });
    field('X (mm)', c.x, (v) => { c.x = Number(v); }, 'number');
    field('Y (mm)', c.y, (v) => { c.y = Number(v); }, 'number');
    field('Rotation', c.rot, (v) => { c.rot = Number(v); }, 'number');
    field('Side', c.side, (v) => { c.side = v === 'back' ? 'back' : 'front'; });
    const l = document.createElement('label'); l.textContent = 'Locked'; const i = document.createElement('input'); i.type = 'checkbox'; i.checked = !!c.locked; i.onchange = () => { c.locked = i.checked; }; l.appendChild(i); el.appendChild(l);
    const pins = document.createElement('div'); pins.className = 'hint';
    const fp = lib[c.footprint] ?? project.footprints[c.footprint];
    pins.textContent = fp ? fp.pads.map((p) => `${p.id}:${netOfPin(project, c.ref, p.id)?.name ?? '-'}`).join('  ') : '';
    el.appendChild(pins);
  } else if (t) {
    field('Net', t.net, (v) => { t.net = v; });
    field('Layer', t.layer, (v) => { if (project.layers.some((l) => l.name === v)) t.layer = v; });
    field('Width (mm)', t.width, (v) => { t.width = Number(v); }, 'number');
    const l = document.createElement('label'); l.textContent = 'Locked (protected)'; const i = document.createElement('input'); i.type = 'checkbox'; i.checked = !!t.locked; i.onchange = () => { t.locked = i.checked; }; l.appendChild(i); el.appendChild(l);
  } else {
    el.innerHTML = `<div class="hint">${project.components.length} components · ${project.nets.length} nets · ${project.traces.length} traces · ${project.vias.length} vias · ${st.rats.length} unrouted</div>`;
  }
}
function renameRef(c: Component, newRef: string): void {
  if (!newRef || project.components.some((x) => x !== c && x.ref === newRef)) return;
  for (const n of project.nets) n.pins = n.pins.map((p) => (p.startsWith(c.ref + '-') ? newRef + p.slice(c.ref.length) : p));
  st.selectedRefs.delete(c.ref); c.ref = newRef; st.selectedRefs.add(newRef);
}
function fillDrc(): void {
  const el = $('drc-list'); el.innerHTML = '';
  const waived = (project.waivers ?? []).length;
  if (!st.drc.length) { el.innerHTML = `<div class="hint">no violations${waived ? ` (${waived} waived)` : ''}</div>`; return; }
  for (const m of st.drc.slice(0, 200)) {
    const row = document.createElement('div'); row.className = 'row';
    const txt = document.createElement('span'); txt.textContent = `${m.kind} @${m.layer}: ${m.message}`; txt.style.flex = '1';
    const w = document.createElement('a'); w.textContent = 'waive'; w.href = '#'; w.className = 'muted'; w.title = 'Waive this DRC (Display – Waive DRCs)';
    w.onclick = (e) => { e.preventDefault(); e.stopPropagation(); snapshot(); project.waivers = [...new Set([...(project.waivers ?? []), drcKey(m)])]; st.drc = st.drc.filter((x) => x !== m); fillDrc(); render(); log(`waived: ${m.kind} ${m.message}`); };
    row.append(txt, w);
    row.onclick = () => { view.tx = canvas.width / 2 - m.at.x * view.scale; view.ty = canvas.height / 2 - m.at.y * view.scale; render(); };
    el.appendChild(row);
  }
  if (waived) { const h = document.createElement('div'); h.className = 'hint'; h.textContent = `${waived} waived`; el.appendChild(h); }
}

/* ---------- demo board ---------- */
function demoBoard(): Project {
  // (every pin belongs to exactly one net)
  const p = newProject('demo', 2);
  p.outline = [{ x: 0, y: 0 }, { x: 70, y: 0 }, { x: 70, y: 50 }, { x: 0, y: 50 }];
  const add = (fp: string, ref: string, x: number, y: number, rot = 0, value = '') => p.components.push({ ref, footprint: fp, value, x, y, rot, side: 'front' });
  add('QFP-32', 'U1', 30, 25, 0, 'MCU'); add('SOIC-8', 'U2', 54, 36, 90, 'EEPROM'); add('SOT-23', 'Q1', 54, 14, 0, 'NPN');
  add('R_0603', 'R1', 12, 42, 0, '10k'); add('R_0603', 'R2', 12, 38, 0, '10k'); add('R_0603', 'R3', 46, 8, 90, '1k'); add('R_0603', 'R4', 40, 44, 0, '4k7'); add('R_0603', 'R5', 48, 44, 0, '4k7');
  add('C_0402', 'C1', 18, 30, 90, '100n'); add('C_0402', 'C2', 42, 30, 90, '100n'); add('C_0402', 'C3', 18, 18, 90, '100n'); add('C_0402', 'C4', 42, 18, 90, '100n');
  add('Header_1x6', 'J1', 10, 24, 90, 'ISP'); add('Header_1x4', 'J2', 60, 24, 90, 'I2C');
  const net = (name: string, pins: string[], color?: string) => p.nets.push({ name, pins, color });
  net('VCC', ['U1-5', 'U1-21', 'C1-1', 'C2-1', 'C3-1', 'C4-1', 'J1-2', 'J2-1', 'U2-8', 'R1-1', 'R2-1', 'R4-1', 'R5-1'], '#f87171');
  net('GND', ['U1-6', 'U1-22', 'C1-2', 'C2-2', 'C3-2', 'C4-2', 'J1-6', 'J2-4', 'U2-4', 'Q1-2'], '#60a5fa');
  net('SDA', ['U1-12', 'U2-5', 'J2-2', 'R4-2'], '#fbbf24'); net('SCL', ['U1-13', 'U2-6', 'J2-3', 'R5-2'], '#fbbf24');
  net('MOSI', ['U1-15', 'J1-4'], '#a3e635'); net('MISO', ['U1-16', 'J1-1'], '#a3e635'); net('SCK', ['U1-17', 'J1-3'], '#a3e635'); net('RESET', ['U1-29', 'J1-5', 'R1-2'], '#a3e635');
  net('LED', ['U1-2', 'R3-1'], '#c084fc'); net('BASE', ['R3-2', 'Q1-1'], '#c084fc'); net('OUT', ['Q1-3', 'U1-25'], '#c084fc'); net('PULL', ['R2-2', 'U1-30'], '#c084fc');
  net('INT', ['U1-8', 'U2-7'], '#2dd4bf'); net('WP', ['U1-9', 'U2-3'], '#2dd4bf');
  p.diffPairs.push({ name: 'I2C', p: 'SDA', n: 'SCL', gap: 0.2, tolerance: 0.05, maxUncoupled: 5, maxSkew: 0.5 });
  p.lengthGroups.push({ name: 'SPI', nets: ['MOSI', 'MISO', 'SCK'], tolerance: 2 });
  p.zones.push({ id: nextId(p), net: 'GND', layer: 'B.Cu', points: [{ x: 2, y: 2 }, { x: 68, y: 2 }, { x: 68, y: 48 }, { x: 2, y: 48 }], clearance: 0.2, dynamic: true });
  return p;
}

/* ---------- routing ---------- */
function defaultScript(): string {
  return `# OpenRoute do-file generated by OpenBoard (same vocabulary as Allegro's <name>_route.do)
unit mm
rule pcb (width ${project.rules.width}) (clearance ${project.rules.clearance} (type wire_wire))
status_file $/route.sts
fanout
route 25
clean 2
route 50 16
clean 4${project.diffPairs.length || project.lengthGroups.length || project.nets.some((n) => n.minLength !== undefined) ? `\ntune ${project.rules.viaLength}` : ''}
write session $/out.ses
report status $/out.sts
quit
`;
}
/** Route only `nets` (everything else stays as fixed copper): Route net, and the reroute half of shove. */
function routeNets(nets: string[], why: string): void {
  if (!nets.length) return;
  log(`${why}: routing ${nets.join(', ')} around the existing copper`);
  runRouter(`unit mm\nrule pcb (width ${project.rules.width}) (clearance ${project.rules.clearance} (type wire_wire))\nselect net ${nets.map((n) => JSON.stringify(n)).join(' ')}\nfanout\nroute 20\nclean 1\nquit`, true);
}
function runRouter(script: string, keep: boolean): void {
  if (worker) { worker.terminate(); worker = null; }
  const dsn = exportDsn(project, { keepAutorouted: keep });
  log(`exported ${dsn.length} bytes of DSN (${project.nets.length} nets); starting OpenRoute…`);
  status('routing…');
  ($('btn-route') as HTMLButtonElement).disabled = true;
  worker = new Worker('worker.js', { type: 'module' });
  const t0 = performance.now();
  worker.onmessage = (ev) => {
    const m = ev.data;
    if (m.type === 'log') log(m.line);
    else if (m.type === 'pass') status(`${m.rec.kind} pass ${m.rec.pass}: unrouted ${m.rec.unrouted}, conflicts ${m.rec.conflicts}, vias ${m.rec.vias}`);
    else if (m.type === 'error') { log('ROUTER ERROR: ' + m.message); status('router error'); ($('btn-route') as HTMLButtonElement).disabled = false; }
    else if (m.type === 'done') {
      snapshot();
      const r = importSession(project, m.ses, { replaceAll: !keep });
      log(m.status);
      log(`imported session: ${r.wires} wires, ${r.vias} vias in ${((performance.now() - t0) / 1000).toFixed(1)}s — ${m.complete ? 'complete' : 'incomplete (see status)'}`);
      status(m.complete ? 'routing complete' : 'routing incomplete');
      ($('btn-route') as HTMLButtonElement).disabled = false;
      changed(); fillProps(); runDrc();
    }
  };
  worker.postMessage({ type: 'run', dsn, script });
}
function runDrc(): void { try { st.drc = projectDrc(project); } catch (e) { log('DRC failed: ' + (e as Error).message); st.drc = []; } fillDrc(); render(); log(`DRC: ${st.drc.length} violation(s)${st.drc.length ? ' — ' + drcSummary(st.drc) : ''}`); }

/* ---------- files ---------- */
function download(name: string, text: string): void { const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([text], { type: 'text/plain' })); a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000); }
function openFile(input: HTMLInputElement, cb: (text: string, name: string) => void): void { input.onchange = () => { const f = input.files?.[0]; if (!f) return; f.text().then((t) => cb(t, f.name)); input.value = ''; }; input.click(); }

/* ---------- interaction ---------- */
let drag: { kind: 'pan'; sx: number; sy: number; tx: number; ty: number } | { kind: 'move'; refs: string[]; start: Pt; orig: Map<string, Pt> } | { kind: 'rect'; start: Pt } | null = null;
let routing: { points: Pt[]; net: string; layer: string; width: number } | null = null;
let spaceDown = false;

function setTool(t: Tool): void { tool = t; routing = null; st.preview = undefined; if (t !== 'measure' && t !== 'dimension') st.measure = undefined; document.querySelectorAll('button.tool').forEach((b) => b.classList.toggle('active', (b as HTMLElement).dataset.tool === t)); render(); }
function finishTrace(): void {
  let shoved: string[] = [];
  if (routing && routing.points.length >= 2) {
    snapshot();
    const tr = { id: nextId(project), net: routing.net, layer: routing.layer, width: routing.width, points: routing.points, locked: true };
    project.traces.push(tr);
    if (($('chk-shove') as HTMLInputElement | null)?.checked) {
      // push-and-shove: crowded traces of other nets are pushed aside geometrically (vias moved); whatever cannot be
      // pushed (crossings, pinned ends, fixed copper in the way) is ripped up and rerouted around the new trace
      const ps = pushShove(project, tr);
      if (ps.pushed.length || ps.movedVias.length) log(`shove: ${ps.pushed.length} traces pushed, ${ps.movedVias.length} vias moved`);
      const v = shoveVictims(project, tr);
      const reroute = v.nets;   // whatever still crowds the new trace after pushing
      const stillCrowded = new Set(reroute);
      if (stillCrowded.size) {
        project.traces = project.traces.filter((x) => !(stillCrowded.has(x.net) && v.traces.includes(x.id)));
        project.vias = project.vias.filter((x) => !(stillCrowded.has(x.net) && v.vias.includes(x.id)));
        shoved = [...stillCrowded];
      }
    }
  }
  routing = null; st.preview = undefined; changed(); fillProps();
  if (shoved.length) routeNets(shoved, 'shove');
}
function widthFor(net: string): number { return findNet(project, net)?.width ?? project.rules.width; }
function netUnder(p: Pt): string { return padAt(p)?.net || traceAt(p)?.net || viaAt(p)?.net || ''; }

canvas.addEventListener('contextmenu', (e) => e.preventDefault());
canvas.addEventListener('wheel', (e) => { e.preventDefault(); view.zoomAt({ x: e.offsetX, y: e.offsetY }, e.deltaY < 0 ? 1.15 : 1 / 1.15); render(); }, { passive: false });
canvas.addEventListener('mousedown', (e) => {
  const s = { x: e.offsetX, y: e.offsetY }; const w = view.toWorld(s);
  if (e.button === 1 || spaceDown || (e.button === 0 && tool === 'select' && !componentAt(w) && !traceAt(w) && !viaAt(w) && !e.shiftKey)) {
    if (e.button === 0 && tool === 'select') { st.selectedRefs.clear(); st.selectedTraces.clear(); st.selectedVias.clear(); fillProps(); render(); }
    drag = { kind: 'pan', sx: s.x, sy: s.y, tx: view.tx, ty: view.ty }; return;
  }
  if (e.button === 2) { if (tool === 'route') finishTrace(); else setTool('select'); return; }
  if (tool === 'select') {
    const c = componentAt(w);
    if (c) {
      if (!e.shiftKey && !st.selectedRefs.has(c.ref)) { st.selectedRefs.clear(); st.selectedTraces.clear(); st.selectedVias.clear(); }
      st.selectedRefs.add(c.ref);
      const orig = new Map<string, Pt>(); for (const r of st.selectedRefs) { const cc = project.components.find((x) => x.ref === r)!; orig.set(r, { x: cc.x, y: cc.y }); }
      snapshot(); drag = { kind: 'move', refs: [...st.selectedRefs], start: w, orig };
    } else { const t = traceAt(w); const v = viaAt(w); if (!e.shiftKey) { st.selectedRefs.clear(); st.selectedTraces.clear(); st.selectedVias.clear(); } if (t) st.selectedTraces.add(t.id); else if (v) st.selectedVias.add(v.id); }
    fillProps(); render(); return;
  }
  if (tool === 'place') {
    const fp = ($('sel-footprint') as HTMLSelectElement).value; const prefix = ($('inp-prefix') as HTMLInputElement).value || 'U';
    snapshot(); const ref = uniqueRef(project, prefix); project.components.push({ ref, footprint: fp, value: '', x: snap(w.x, 0.5), y: snap(w.y, 0.5), rot: 0, side: 'front' });
    st.selectedRefs = new Set([ref]); changed(); fillProps(); return;
  }
  if (tool === 'route') {
    const pad = padAt(w);
    const pt = pad ? { ...pad.center } : { x: snap(w.x), y: snap(w.y) };
    if (!routing) { const net = pad?.net ?? netUnder(w); routing = { points: [pt], net, layer: st.activeLayer, width: widthFor(net) }; st.preview = { layer: st.activeLayer, width: routing.width, points: routing.points }; if (!net) log('trace started without a net — start on a pad to assign one'); }
    else { routing.points.push(pt); if (pad && routing.points.length >= 2) finishTrace(); }
    render(); return;
  }
  if (tool === 'via') { snapshot(); project.vias.push({ id: nextId(project), net: netUnder(w), x: snap(w.x), y: snap(w.y), diameter: project.rules.viaDiameter, drill: project.rules.viaDrill, locked: true }); changed(); return; }
  if (tool === 'net') {
    const pad = padAt(w); if (!pad) return;
    const assign = (name: string) => {
      snapshot();
      for (const n of project.nets) n.pins = n.pins.filter((p) => p !== pad.key);
      let n = findNet(project, name); if (!n) { n = { name, pins: [], color: LAYER_COLORS[project.nets.length % LAYER_COLORS.length] }; project.nets.push(n); }
      if (pad.net !== name) n.pins.push(pad.key);
      project.nets = project.nets.filter((x) => x.pins.length > 0);
      st.highlightNet = name; fillNets(); changed(); fillProps();
    };
    if (activeNet) assign(activeNet); else askNetName().then((name) => { if (name) { activeNet = name; assign(name); } });
    return;
  }
  if (tool === 'keepout' || tool === 'zone' || tool === 'room') { drag = { kind: 'rect', start: w }; return; }
  if (tool === 'measure') {
    if (!st.measure || st.measure.b) st.measure = { a: { x: snap(w.x, 0.05), y: snap(w.y, 0.05) } };
    else { st.measure.b = { x: snap(w.x, 0.05), y: snap(w.y, 0.05) }; const m = measure(st.measure.a, st.measure.b); log(`measure: ${m.distance.toFixed(3)} mm (dx ${m.dx.toFixed(3)}, dy ${m.dy.toFixed(3)}, ${m.angle.toFixed(1)}°)`); }
    render(); return;
  }
  if (tool === 'text') {
    const at = { x: snap(w.x, 0.25), y: snap(w.y, 0.25) };
    ask('Text (prefix with B: for the bottom silkscreen, F: for the fab drawing)').then((s) => {
      if (!s) return; snapshot();
      const layer = s.startsWith('B:') ? 'B.Silk' : s.startsWith('F:') ? 'Fab' : 'F.Silk';
      (project.texts ??= []).push({ id: nextId(project), text: s.replace(/^[BF]:/, ''), x: at.x, y: at.y, size: 1, rot: 0, layer }); changed();
    });
    return;
  }
  if (tool === 'dimension') {
    const q = { x: snap(w.x, 0.05), y: snap(w.y, 0.05) };
    if (!st.measure || st.measure.b) st.measure = { a: q };
    else { snapshot(); (project.dimensions ??= []).push({ id: nextId(project), a: st.measure.a, b: q, offset: 2, layer: 'Fab' }); st.measure = undefined; changed(); }
    render(); return;
  }
});
canvas.addEventListener('mousemove', (e) => {
  const s = { x: e.offsetX, y: e.offsetY }; const w = view.toWorld(s);
  (window as unknown as { __collabCursor?: (q: Pt) => void }).__collabCursor?.(w);
  status(`x ${w.x.toFixed(2)}  y ${w.y.toFixed(2)} mm   layer ${st.activeLayer}   tool ${tool}${routing ? '  (routing ' + (routing.net || 'no net') + ', Enter/right-click to finish, V = via)' : ''}`);
  cursorWorld = w;
  if ((tool === 'measure' || tool === 'dimension') && st.measure && !st.measure.b) { st.cursor = w; render(); }
  if (drag?.kind === 'pan') { view.tx = drag.tx + (s.x - drag.sx); view.ty = drag.ty - (s.y - drag.sy); render(); return; }
  if (drag?.kind === 'move') { for (const r of drag.refs) { const c = project.components.find((x) => x.ref === r)!; const o = drag.orig.get(r)!; if (c.locked) continue; c.x = snap(o.x + (w.x - drag.start.x), e.ctrlKey ? 0.01 : 0.25); c.y = snap(o.y + (w.y - drag.start.y), e.ctrlKey ? 0.01 : 0.25); } st.rats = ratsnest(project); render(); return; }
  if (routing) {
    const cur = padAt(w)?.center ?? { x: snap(w.x), y: snap(w.y) };
    st.preview = { layer: routing.layer, width: routing.width, points: routing.points, cursor: cur };
    const ls = lengthStatus(project, routing.net, [...routing.points, cur]);
    if (ls) status(`${routing.net}: ${ls}   (Enter/right-click to finish, V = via)`);
    render(); return;
  }
  const hov = componentAt(w)?.ref; if (hov !== st.hoverRef) { st.hoverRef = hov; render(); }
});
canvas.addEventListener('mouseup', (e) => {
  if (drag?.kind === 'rect') {
    const w = view.toWorld({ x: e.offsetX, y: e.offsetY }); const a = drag.start;
    if (Math.abs(w.x - a.x) > 0.5 && Math.abs(w.y - a.y) > 0.5) {
      const x1 = Math.min(a.x, w.x), y1 = Math.min(a.y, w.y), x2 = Math.max(a.x, w.x), y2 = Math.max(a.y, w.y);
      if (tool === 'zone') {
        const addZone = (net: string) => { snapshot(); project.zones.push({ id: nextId(project), net, layer: st.activeLayer, points: [{ x: x1, y: y1 }, { x: x2, y: y1 }, { x: x2, y: y2 }, { x: x1, y: y2 }], clearance: project.rules.clearance, dynamic: true }); changed(); };
        if (activeNet) addZone(activeNet); else askNetName().then((n) => { if (n) { activeNet = n; addZone(n); } });
      } else if (tool === 'room') {
        const refs = [...st.selectedRefs];
        ask(`Room name (${refs.length ? refs.length + ' selected parts go in it' : 'select parts first to assign them'})`).then((name) => { if (!name) return; snapshot(); (project.rooms ??= []).push({ id: nextId(project), name, rect: { x1, y1, x2, y2 }, side: 'both', refs }); changed(); log(`room ${name}: ${refs.length} parts; Autoplace keeps them inside`); });
      } else { snapshot(); project.keepouts.push({ id: nextId(project), layer: 'all', kind: 'keepout', rect: { x1, y1, x2, y2 } }); changed(); }
    }
  }
  if (drag?.kind === 'move') { changed(); fillProps(); }
  drag = null;
});
canvas.addEventListener('dblclick', () => { if (tool === 'route') finishTrace(); });
window.addEventListener('keydown', (e) => {
  if ((e.target as HTMLElement).tagName === 'INPUT' || (e.target as HTMLElement).tagName === 'TEXTAREA') return;
  if (e.key === ' ') { spaceDown = true; e.preventDefault(); return; }
  if (e.key === 'Escape') { routing = null; st.preview = undefined; setTool('select'); return; }
  if (e.key === 'Enter' && routing) { finishTrace(); return; }
  if (e.ctrlKey && (e.key.toLowerCase() === 'y' || (e.shiftKey && e.key.toLowerCase() === 'z'))) { redo(); return; }
  if (e.ctrlKey && e.key.toLowerCase() === 'z') { undo(); return; }
  if (e.ctrlKey && e.key.toLowerCase() === 'c') { clip = copySelection(project, st.selectedRefs, st.selectedTraces, st.selectedVias); log(`copied ${clip.components.length} parts, ${clip.traces.length} traces, ${clip.vias.length} vias`); return; }
  if (e.ctrlKey && e.key.toLowerCase() === 'v' && clip) { snapshot(); const r = pasteClip(project, clip, { x: snap(cursorWorld.x, 0.25), y: snap(cursorWorld.y, 0.25) }); st.selectedRefs = new Set(r.refs); st.selectedTraces = new Set(r.traces); st.selectedVias = new Set(r.vias); changed(); fillProps(); log(`pasted ${r.refs.length} parts (new refs ${r.refs.join(', ')}), ${r.traces.length} traces, ${r.vias.length} vias`); return; }
  const k = e.key.toLowerCase();
  if (k === 'v' && routing) {
    const last = routing.points[routing.points.length - 1];
    snapshot(); project.traces.push({ id: nextId(project), net: routing.net, layer: routing.layer, width: routing.width, points: routing.points, locked: true });
    project.vias.push({ id: nextId(project), net: routing.net, x: last.x, y: last.y, diameter: project.rules.viaDiameter, drill: project.rules.viaDrill, locked: true });
    const signal = project.layers.filter((l) => l.type === 'signal').map((l) => l.name); const i = signal.indexOf(st.activeLayer); st.activeLayer = signal[(i + 1) % signal.length]; fillLayerSelect(); fillLayerList();
    routing = { points: [last], net: routing.net, layer: st.activeLayer, width: routing.width }; st.preview = { layer: st.activeLayer, width: routing.width, points: routing.points }; changed(); return;
  }
  if (k === 'r' && st.selectedRefs.size) { snapshot(); for (const r of st.selectedRefs) { const c = project.components.find((x) => x.ref === r)!; c.rot = (c.rot + 90) % 360; } changed(); fillProps(); return; }
  if (k === 'f' && st.selectedRefs.size) { snapshot(); for (const r of st.selectedRefs) { const c = project.components.find((x) => x.ref === r)!; c.side = c.side === 'front' ? 'back' : 'front'; } changed(); fillProps(); return; }
  if (e.key === 'Delete' || e.key === 'Backspace') {
    snapshot();
    project.components = project.components.filter((c) => !st.selectedRefs.has(c.ref));
    for (const n of project.nets) n.pins = n.pins.filter((p) => !st.selectedRefs.has(p.split('-')[0]));
    project.nets = project.nets.filter((n) => n.pins.length > 0);
    project.traces = project.traces.filter((t) => !st.selectedTraces.has(t.id)); project.vias = project.vias.filter((v) => !st.selectedVias.has(v.id));
    st.selectedRefs.clear(); st.selectedTraces.clear(); st.selectedVias.clear(); fillNets(); changed(); fillProps(); return;
  }
  const map: Record<string, Tool> = { s: 'select', p: 'place', t: 'route', n: 'net', k: 'keepout', z: 'zone', m: 'measure', x: 'text', d: 'dimension', o: 'room' };
  if (k === 'v' && !routing) setTool('via'); else if (map[k]) setTool(map[k]);
  if (e.key === '1' || e.key === '2' || e.key === '3' || e.key === '4') { const signal = project.layers.filter((l) => l.type === 'signal'); const l = signal[Number(e.key) - 1]; if (l) { st.activeLayer = l.name; fillLayerSelect(); fillLayerList(); render(); } }
});
window.addEventListener('keyup', (e) => { if (e.key === ' ') spaceDown = false; });

/**
 * Dialog result without relying on the 'close' event (some embedded browsers never deliver it): the form's submit
 * event carries the button that was pressed, and Escape (cancel) counts as cancel. `cb` runs exactly once.
 */
function onDialogResult(dlg: HTMLDialogElement, cb: (ok: boolean) => void): void {
  const form = dlg.querySelector('form');
  let done = false;
  const finish = (ok: boolean) => { if (done) return; done = true; cb(ok); };
  if (form) form.onsubmit = (e) => { const sub = (e as SubmitEvent).submitter as HTMLButtonElement | null; finish(sub?.value === 'ok'); };
  dlg.oncancel = () => finish(false);
  dlg.onclose = () => finish(dlg.returnValue === 'ok');
}

function askNetName(): Promise<string | null> {
  const dlg = $('dlg-net') as HTMLDialogElement; const inp = $('net-name') as HTMLInputElement; inp.value = '';
  return new Promise((res) => { onDialogResult(dlg, (ok) => res(ok ? inp.value.trim() || null : null)); dlg.showModal(); inp.focus(); });
}

/* ---------- toolbar ---------- */
document.querySelectorAll('button.tool').forEach((b) => b.addEventListener('click', () => setTool((b as HTMLElement).dataset.tool as Tool)));
$('btn-new').onclick = () => { snapshot(); project = newProject('untitled'); st.selectedRefs.clear(); refreshAll(); view.fit(project); render(); };
$('btn-demo').onclick = () => { snapshot(); project = demoBoard(); st.selectedRefs.clear(); refreshAll(); view.fit(project); render(); log('demo board loaded: 14 components, 14 nets'); };
$('btn-open').onclick = () => openFile($('file-open') as HTMLInputElement, (t) => { snapshot(); project = normalizeProject(JSON.parse(t)); refreshAll(); view.fit(project); render(); });
$('btn-save').onclick = () => download(`${project.name}.openboard.json`, JSON.stringify(project, null, 1));
$('btn-export-dsn').onclick = () => { const t = exportDsn(project, { keepAutorouted: true }); download(`${project.name}.dsn`, t); log(`exported ${project.name}.dsn (${t.length} bytes)`); };
$('btn-import-dsn').onclick = () => openFile($('file-dsn') as HTMLInputElement, (t, name) => { try { snapshot(); project = importDsn(t); project.name = name.replace(/\.dsn$/i, ''); refreshAll(); view.fit(project); render(); log(`imported ${name}: ${project.components.length} components, ${project.nets.length} nets`); } catch (e) { log('import failed: ' + (e as Error).message); } });
$('btn-import-ses').onclick = () => openFile($('file-ses') as HTMLInputElement, (t, name) => { try { snapshot(); const r = importSession(project, t); changed(); fillProps(); log(`imported ${name}: ${r.wires} wires, ${r.vias} vias`); } catch (e) { log('import failed: ' + (e as Error).message); } });
$('btn-route').onclick = () => runRouter(defaultScript(), false);
$('btn-route-custom').onclick = () => { const dlg = $('dlg-route') as HTMLDialogElement; const ta = $('route-script') as HTMLTextAreaElement; if (!ta.value.trim()) ta.value = defaultScript(); onDialogResult(dlg, (ok) => { if (ok) runRouter(ta.value, ($('chk-keep') as HTMLInputElement).checked); }); dlg.showModal(); };
$('btn-unroute').onclick = () => { snapshot(); project.traces = project.traces.filter((t) => t.locked); project.vias = project.vias.filter((v) => v.locked); changed(); fillProps(); };
$('btn-drc').onclick = () => runDrc();
function pickText(accept: string, cb: (text: string, name: string) => void): void {
  const inp = document.createElement('input'); inp.type = 'file'; inp.accept = accept; inp.multiple = true;
  inp.onchange = async () => { for (const f of Array.from(inp.files ?? [])) cb(await f.text(), f.name); };
  inp.click();
}
$('btn-import-net').onclick = () => pickText('.net', (text, name) => {
  snapshot();
  try { const r = importKicadNetlist(project, text); changed(); fillNets(); fillProps(); log(`netlist ${name}: ${r.added} components added, ${r.nets} nets${r.missingFootprints.length ? `; ${r.missingFootprints.length} footprints missing (import them, e.g. ${r.missingFootprints.slice(0, 3).join(', ')})` : ''}`); }
  catch (e) { log('netlist import failed: ' + (e as Error).message); }
});
$('btn-import-fp').onclick = () => pickText('.kicad_mod', (text, name) => {
  try { const fp = parseKicadFootprint(text); project.footprints[fp.name] = fp; fillFootprints(); log(`footprint ${fp.name} imported from ${name} (${fp.pads.length} pads)`); }
  catch (e) { log('footprint import failed: ' + (e as Error).message); }
});
$('btn-route-net').onclick = () => {
  const nets = new Set<string>();
  if (st.highlightNet) nets.add(st.highlightNet);
  for (const id of st.selectedTraces) { const t = project.traces.find((x) => x.id === id); if (t?.net) nets.add(t.net); }
  for (const ref of st.selectedRefs) for (const n of project.nets) if (n.pins.some((pin) => pin.startsWith(ref + '-'))) nets.add(n.name);
  if (!nets.size) { log('Route net: select a component or trace, or highlight a net first'); return; }
  routeNets([...nets], 'route net');
};
$('btn-testpoints').onclick = () => {
  snapshot();
  const r = addTestPoints(project, { dia: 1.0, side: 'back', spacing: 2.54 });
  changed(); fillProps();
  log(`test points: ${r.added.length} added (${r.added.filter((x) => x.on === 'via').length} on vias), ${r.accessible.length} nets already probe-accessible, ${r.failed.length} without room${r.failed.length ? ': ' + r.failed.slice(0, 8).join(', ') : ''}`);
};
$('btn-assembly').onclick = () => {
  const files = exportAssembly(project);
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([zipFiles(files) as unknown as BlobPart], { type: 'application/zip' }));
  a.download = `${(project.name || 'board').replace(/[^\w.-]+/g, '_')}-assembly.zip`;
  a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  log(`assembly: ${files.map((f) => f.name).join(', ')} -> ${a.download}`);
};
$('btn-gerber').onclick = () => {
  const files = exportFabrication(project);
  const zip = zipFiles(files);
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([zip as unknown as BlobPart], { type: 'application/zip' }));
  a.download = `${(project.name || 'board').replace(/[^\w.-]+/g, '_')}-fab.zip`;
  a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  log(`fabrication: ${files.length} files (${files.filter((f) => f.name.endsWith('.drl')).length} drill) -> ${a.download}`);
  status(`exported ${files.length} Gerber/drill files`);
};
function runPlace(mode: 'anneal' | 'quick'): void {
  snapshot();
  const only = st.selectedRefs.size ? [...st.selectedRefs] : undefined;
  status(mode === 'quick' ? 'quickplace…' : 'autoplace…');
  setTimeout(() => { const r = autoplace(project, { mode, only, grid: 0.5, log }); changed(); fillProps(); status(`${mode === 'quick' ? 'quickplace' : 'autoplace'}: ${r.placed} placed, wirelength ${r.wirelengthBefore.toFixed(0)} → ${r.wirelengthAfter.toFixed(0)} mm, ${r.overlaps} overlaps, ${r.seconds.toFixed(1)}s`); }, 20);
}
$('btn-place').onclick = () => runPlace('anneal');
function downloadBytes(name: string, data: Uint8Array | string, type = 'application/octet-stream'): void { const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([data as unknown as BlobPart], { type })); a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 5000); }
const base = () => (project.name || 'board').replace(/[^\w.-]+/g, '_');
($('sel-export') as HTMLSelectElement).onchange = (e) => {
  const sel = e.target as HTMLSelectElement; const v = sel.value; if (!['DXF', 'PDF', 'GDSII', 'ODB++', 'IPC-2581', 'STEP', 'IDF', 'IDX', 'Netlist (KiCad)', 'Netlist (Telesis)'].includes(v)) return; sel.value = '';
  try {
    if (v === 'DXF') downloadBytes(`${base()}.dxf`, exportDxf(project), 'application/dxf');
    else if (v === 'PDF') downloadBytes(`${base()}.pdf`, exportPdf(project), 'application/pdf');
    else if (v === 'GDSII') downloadBytes(`${base()}.gds`, exportGdsii(project));
    else if (v === 'ODB++') downloadBytes(`${base()}-odb.zip`, zipFiles(exportOdb(project)), 'application/zip');
    else if (v === 'IPC-2581') downloadBytes(`${base()}.xml`, exportIpc2581(project), 'application/xml');
    else if (v === 'STEP') downloadBytes(`${base()}.step`, exportStep(project), 'model/step');
    else if (v === 'IDF') { const r = exportIdf(project); downloadBytes(`${base()}-idf.zip`, zipFiles([{ name: `${base()}.emn`, content: r.emn }, { name: `${base()}.emp`, content: r.emp }]), 'application/zip'); }
    else if (v === 'IDX') downloadBytes(`${base()}.idx`, exportIdx(project), 'application/xml');
    else if (v === 'Netlist (KiCad)') downloadBytes(`${base()}.net`, exportKicadNetlist(project));
    else if (v === 'Netlist (Telesis)') downloadBytes(`${base()}.tel`, exportTelesisNetlist(project));
    log(`export ${v}: done`);
  } catch (err) { log(`export ${v} failed: ${(err as Error).message}`); }
};
($('sel-import') as HTMLSelectElement).onchange = (e) => {
  const sel = e.target as HTMLSelectElement; const v = sel.value; if (!['KiCad PCB', 'Eagle board', 'Gerber (onto active layer)'].includes(v)) return; sel.value = '';
  const accept = v.startsWith('KiCad') ? '.kicad_pcb' : v.startsWith('Eagle') ? '.brd' : '.gbr,.gtl,.gbl,.g1,.g2,.ger,.art';
  pickText(accept, (text, name) => {
    try {
      snapshot();
      if (v.startsWith('KiCad')) { project = normalizeProject(importKicadPcb(text, name.replace(/\.kicad_pcb$/i, ''))); refreshAll(); view.fit(project); }
      else if (v.startsWith('Eagle')) { project = normalizeProject(importEagle(text, name.replace(/\.brd$/i, ''))); refreshAll(); view.fit(project); }
      else { const r = importGerber(project, text, st.activeLayer); changed(); log(`gerber ${name}: ${r.traces} draws, ${r.pours} flashes/regions on ${st.activeLayer}`); return; }
      render(); log(`imported ${name}: ${project.components.length} parts, ${project.nets.length} nets, ${project.traces.length} traces`);
    } catch (err) { log(`import failed: ${(err as Error).message}`); }
  });
};
($('sel-fab') as HTMLSelectElement).onchange = (e) => {
  const sel = e.target as HTMLSelectElement; const v = sel.value; sel.value = ''; if (!v) return;
  if (v === 'Panelize') ask('Panel: columns rows [vscore]', '2 2').then((s) => { if (!s) return; const [nx, ny, mode] = s.split(/\s+/); const P = panelize(project, { nx: Number(nx) || 2, ny: Number(ny) || 2, separation: mode === 'vscore' ? 'vscore' : 'mousebite' }); snapshot(); project = normalizeProject(P); refreshAll(); view.fit(project); render(); log(`panel ${project.name}: ${project.components.length} parts`); });
  else if (v === 'Copper thieving') ask('Thieving: pitch size clearance (mm), or off', '2 1 1').then((s) => { if (!s) return; snapshot(); if (s === 'off') delete project.rules.thieving; else { const [a, b, c] = s.split(/\s+/).map(Number); project.rules.thieving = { pitch: a || 2, size: b || 1, clearance: c || 1 }; } changed(); log(`copper thieving: ${project.rules.thieving ? 'on (written to the outer copper Gerbers)' : 'off'}`); });
  else if (v.startsWith('Backdrill')) { const nets = selectedNets(); if (!nets.length) { log('Backdrill: highlight the nets first'); return; } snapshot(); project.backdrill = [{ nets, side: 'bottom', oversize: 0.2 }]; const r = backdrillFiles(project); log(`backdrill: ${r.report.length} vias of ${nets.join(', ')} (files go with the Gerbers)`); }
  else if (v === 'Impedance coupon') ask('Coupon at x y (mm), layers comma-separated', `0 0 ${st.activeLayer}`).then((s) => { if (!s) return; const [x, y, ls] = s.split(/\s+/); try { snapshot(); const n = addCoupon(project, { at: { x: Number(x), y: Number(y) }, layers: (ls ?? st.activeLayer).split(',') }); changed(); log(`coupon: ${n} added`); } catch (err) { log((err as Error).message); } });
  else if (v === 'Variant BOM/CPL') ask(`Variant name (${(project.variants ?? []).map((x) => x.name).join(', ') || 'none defined: add one with openpcb variant'})`).then((s) => { if (!s) return; try { const files = exportAssembly(project, { variant: s }); downloadBytes(`${base()}-${s}-assembly.zip`, zipFiles(files), 'application/zip'); } catch (err) { log((err as Error).message); } });
  else if (v === 'Rename refdes') { snapshot(); const map = renameRefdes(project); changed(); fillProps(); downloadBytes(`${base()}-was-is.txt`, wasIsText(map)); log(`rename refdes: ${map.length} parts renumbered (was/is list downloaded for back-annotation)`); }
};
($('sel-analyze') as HTMLSelectElement).onchange = (e) => {
  const sel = e.target as HTMLSelectElement; const v = sel.value; if (!['Signal integrity', 'IR drop (highlighted net)', 'EMI rules', 'Current capacity', '3D clearance'].includes(v)) return; sel.value = '';
  try {
    if (v === 'Signal integrity') { const nets = selectedNets(); const r = siReport(project, { nets: nets.length ? nets : undefined }); for (const n of r.slice(0, 30)) log(`SI ${n.net}: ${n.length} mm, ${n.delayPs} ps, ${n.vias} vias, Z ${n.zMin}-${n.zMax} ohm, critical length ${n.criticalLength} mm${n.notes.length ? ' — ' + n.notes.join('; ') : ''}`); }
    else if (v.startsWith('IR drop')) { const net = selectedNets()[0]; if (!net) { log('IR drop: highlight a power net (sources/loads via openpcb power)'); return; } const r = irDrop(project, net); log(`IR drop ${net}: worst ${(r.worstDrop * 1000).toFixed(1)} mV; ${r.loads.map((l) => `${l.ref} ${l.voltage} V`).join(', ')}; peak ${r.maxCurrentDensity} A/mm²`); }
    else { const m = v === 'EMI rules' ? emiCheck(project) : v === 'Current capacity' ? currentCheck(project) : clearance3d(project); st.drc = m; fillDrc(); render(); log(`${v}: ${m.length} finding(s) — shown in the DRC list`); }
  } catch (err) { log(`${v} failed: ${(err as Error).message}`); }
};
let v3: View3D | null = null;
/** The 3D canvas takes its laid-out size (CSS 100% of the board area); redraw on resize. */
function size3d(): void { const c3 = $('board3d') as HTMLCanvasElement; if (c3.hidden) return; const r = c3.getBoundingClientRect(); c3.width = Math.max(200, Math.floor(r.width)); c3.height = Math.max(200, Math.floor(r.height)); v3?.draw(); }
new ResizeObserver(size3d).observe($('board3d'));
$('btn-3d').onclick = () => {
  const c3 = $('board3d') as HTMLCanvasElement; const on = c3.hidden;
  c3.hidden = !on; canvas.hidden = on;
  if (on) { size3d(); try { v3 ??= new View3D(c3); v3.load(project); } catch (err) { log('3D view: ' + (err as Error).message); } }
  ($('btn-3d') as HTMLButtonElement).textContent = on ? '2D' : '3D';
};
$('btn-autoswap').onclick = () => { snapshot(); const a = autoswapPins(project); const b = autoswapComponents(project); changed(); fillProps(); log(`autoswap: ${a.swaps} pin swaps (-${a.gain.toFixed(1)} mm), ${b.swaps} component swaps (-${b.gain.toFixed(1)} mm)`); };
$('btn-tune').onclick = () => { snapshot(); const nets = selectedNets(); const r = tuneProject(project, { nets: nets.length ? nets : undefined, phase: project.diffPairs.length > 0 }); changed(); for (const x of r) log(`tune ${x.net}: ${x.before.toFixed(2)} -> ${x.after.toFixed(2)} mm (target ${x.target.toFixed(2)})${x.ok ? '' : ' NOT MET'}`); if (!r.length) log('tune: nothing to tune (no length rules unmet)'); };
$('btn-smooth').onclick = (e) => { snapshot(); const nets = selectedNets(); const r = smoothProject(project, { any: (e as MouseEvent).shiftKey, nets: nets.length ? nets : undefined }); changed(); log(`smooth: ${r.removed} vertices removed, ${r.shortened} traces shortened, ${(r.before - r.after).toFixed(2)} mm saved`); };
$('btn-detune').onclick = () => { snapshot(); const nets = selectedNets(); const r = detuneProject(project, nets.length ? nets : undefined); changed(); log(`remove tuning: ${r.length ? r.join(', ') : 'no tuned nets'}`); };
$('btn-stitch').onclick = () => ask('Stitch vias: net and pitch (e.g. GND 2)', `${activeNet ?? 'GND'} 2`).then((s) => { if (!s) return; const [net, pitch] = s.split(/\s+/); snapshot(); const n = stitchVias(project, { net, pitch: Number(pitch) || 2, inZone: project.zones.some((z) => z.net === net) }); changed(); log(`stitching: ${n} ${net} vias added`); });
$('btn-fence').onclick = () => { const nets = selectedNets(); if (!nets.length) { log('Fence: highlight or select the net to fence first'); return; } snapshot(); let n = 0; for (const net of nets) n += viaFence(project, { net, guard: 'GND', spacing: 2 }); changed(); log(`via fence: ${n} GND vias along ${nets.join(', ')}`); };
$('btn-quickplace').onclick = () => runPlace('quick');
$('btn-add-net').onclick = () => askNetName().then((n) => { if (n && !findNet(project, n)) { snapshot(); project.nets.push({ name: n, pins: [], color: LAYER_COLORS[project.nets.length % LAYER_COLORS.length] }); activeNet = n; fillNets(); setTool('net'); } });
$('btn-stackup').onclick = () => { snapshot(); const n = project.layers.length === 2 ? 4 : 2; const names = n === 4 ? ['F.Cu', 'In1.Cu', 'In2.Cu', 'B.Cu'] : ['F.Cu', 'B.Cu']; project.layers = names.map((nm, i) => ({ name: nm, type: 'signal', color: LAYER_COLORS[i % LAYER_COLORS.length], direction: i % 2 === 0 ? 'horizontal' : 'vertical', visible: true })); project.traces = project.traces.filter((t) => names.includes(t.layer)); refreshAll(); };
($('sel-layer') as HTMLSelectElement).onchange = (e) => { st.activeLayer = (e.target as HTMLSelectElement).value; fillLayerList(); render(); };
($('chk-rats') as HTMLInputElement).onchange = (e) => { st.showRats = (e.target as HTMLInputElement).checked; render(); };
($('chk-refs') as HTMLInputElement).onchange = (e) => { st.showRefs = (e.target as HTMLInputElement).checked; render(); };
for (const [id, key] of [['rule-width', 'width'], ['rule-clear', 'clearance'], ['rule-via', 'viaDiameter'], ['rule-drill', 'viaDrill'], ...RULE_KEYS.map((k) => ['rule-' + k, k] as const)] as const) { const el = document.getElementById(id) as HTMLInputElement | null; if (el) el.onchange = (e) => { snapshot(); (project.rules as unknown as Record<string, number>)[key] = Number((e.target as HTMLInputElement).value); changed(); }; }
for (const id of ['rule-w', 'rule-h']) ($(id) as HTMLInputElement).onchange = () => { snapshot(); const w = Number(($('rule-w') as HTMLInputElement).value), h = Number(($('rule-h') as HTMLInputElement).value); project.outline = [{ x: 0, y: 0 }, { x: w, y: 0 }, { x: w, y: h }, { x: 0, y: h }]; changed(); };


/* debug hook for tests */
(window as unknown as { openboard: unknown }).openboard = {
  get project() { return project; }, ratsnest, st, importSession, exportDsn,
  /** test hook: commit a hand-drawn trace through the same path as the Trace tool (shove included) */
  drawTrace(net: string, layer: string, points: Pt[]) { routing = { points, net, layer, width: widthFor(net) }; finishTrace(); },
  routeAll() { runRouter(defaultScript(), false); },
};

/* ---------- constraints dialog ---------- */
function constraintsText(): { pairs: string; groups: string; lengths: string; zones: string; vias: string; classes: string; spacing: string; regions: string } {
  return {
    classes: (project.netClasses ?? []).map((c) => [c.name, c.width ?? '-', c.clearance ?? '-', ...(c.viaTypes?.length ? ['vias=' + c.viaTypes.join(',')] : []), ...(c.layers?.length ? ['layers=' + c.layers.join(',')] : []), ...c.nets].join(' ')).join('\n'),
    spacing: (project.classClearances ?? []).map((c) => `${c.a} ${c.b} ${c.clearance}`).join('\n'),
    regions: (project.regions ?? []).map((r) => { const xs = r.points.map((q) => q.x), ys = r.points.map((q) => q.y); return [r.name, Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys), r.width ?? '-', r.clearance ?? '-', ...(r.classes ?? [])].join(' '); }).join('\n'),
    vias: (project.rules.viaTypes ?? []).map((v) => `${v.diameter} ${v.drill} ${v.from} ${v.to}`).join('\n'),
    pairs: project.diffPairs.map((d) => `${d.name} ${d.p} ${d.n} ${d.gap} ${d.tolerance} ${d.maxUncoupled} ${d.maxSkew}`).join('\n'),
    groups: project.lengthGroups.map((g) => `${g.name} ${g.tolerance} ${g.nets.join(' ')}`).join('\n'),
    lengths: project.nets.filter((n) => n.minLength !== undefined || n.maxLength !== undefined).map((n) => `${n.name} ${n.minLength ?? '-'} ${n.maxLength ?? '-'}`).join('\n'),
    zones: project.zones.map((z) => { const xs = z.points.map((q) => q.x), ys = z.points.map((q) => q.y); return `${z.net} ${z.layer} ${Math.min(...xs)} ${Math.min(...ys)} ${Math.max(...xs)} ${Math.max(...ys)}${z.dynamic ? '' : ' static'}`; }).join('\n'),
  };
}
function applyConstraints(pairs: string, groups: string, lengths: string, zones: string, vias = '', classes?: string, spacing?: string, regions?: string): void {
  const lines = (s: string) => s.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#')).map((l) => l.split(/\s+/));
  snapshot();
  const numOr = (s: string | undefined) => (s === undefined || s === '-' ? undefined : Number(s));
  if (classes !== undefined) project.netClasses = lines(classes).filter((f) => f.length >= 3).map((f) => ({ name: f[0], width: numOr(f[1]), clearance: numOr(f[2]), viaTypes: f.find((x) => x.startsWith('vias='))?.slice(5).split(','), layers: f.find((x) => x.startsWith('layers='))?.slice(7).split(','), nets: f.slice(3).filter((x) => !x.includes('=')) }));
  if (spacing !== undefined) project.classClearances = lines(spacing).filter((f) => f.length >= 3).map((f) => ({ a: f[0], b: f[1], clearance: Number(f[2]) }));
  if (regions !== undefined) project.regions = lines(regions).filter((f) => f.length >= 5).map((f) => ({ id: nextId(project), name: f[0], points: [{ x: +f[1], y: +f[2] }, { x: +f[3], y: +f[2] }, { x: +f[3], y: +f[4] }, { x: +f[1], y: +f[4] }], width: numOr(f[5]), clearance: numOr(f[6]), classes: f.slice(7).length ? f.slice(7) : undefined }));
  project.rules.viaTypes = lines(vias).filter((f) => f.length >= 4 && project.layers.some((l) => l.name === f[2]) && project.layers.some((l) => l.name === f[3])).map((f) => ({ diameter: Number(f[0]), drill: Number(f[1]), from: f[2], to: f[3] }));
  project.diffPairs = lines(pairs).filter((f) => f.length >= 3).map((f) => ({ name: f[0], p: f[1], n: f[2], gap: Number(f[3] ?? 0.2), tolerance: Number(f[4] ?? 0.05), maxUncoupled: Number(f[5] ?? 5), maxSkew: Number(f[6] ?? 0.5) }));
  project.lengthGroups = lines(groups).filter((f) => f.length >= 3).map((f) => ({ name: f[0], tolerance: Number(f[1]), nets: f.slice(2) }));
  for (const n of project.nets) { delete n.minLength; delete n.maxLength; }
  for (const f of lines(lengths)) { const n = findNet(project, f[0]); if (!n) continue; if (f[1] && f[1] !== '-') n.minLength = Number(f[1]); if (f[2] && f[2] !== '-') n.maxLength = Number(f[2]); }
  project.zones = lines(zones).filter((f) => f.length >= 6).map((f) => ({ id: nextId(project), net: f[0], layer: f[1], points: [{ x: +f[2], y: +f[3] }, { x: +f[4], y: +f[3] }, { x: +f[4], y: +f[5] }, { x: +f[2], y: +f[5] }], clearance: project.rules.clearance, dynamic: f[6] !== 'static' }));
  changed(); log(`constraints: ${project.diffPairs.length} diff pairs, ${project.lengthGroups.length} length groups, ${project.zones.length} zones`);
}
$('btn-fpedit').onclick = () => {
  const lib = { ...defaultLibrary(), ...project.footprints };
  const sel = [...st.selectedRefs][0]; const comp = sel ? project.components.find((c) => c.ref === sel) : undefined;
  const fp = comp ? lib[comp.footprint] : undefined;
  ($('fp-name') as HTMLInputElement).value = fp?.name ?? 'NewFootprint';
  const r4 = (v: number) => +v.toFixed(4);
  ($('fp-pads') as HTMLTextAreaElement).value = (fp?.pads ?? []).map((p) => [p.id, r4(p.x), r4(p.y), r4(p.w), r4(p.h), p.shape, ...(p.th ? ['th', p.drill ?? Math.min(p.w, p.h) / 2] : []), ...(p.rot ? [p.rot] : [])].join(' ')).join('\n');
  ($('fp-silk') as HTMLTextAreaElement).value = (fp?.outline ?? []).map((pl) => pl.map((q) => `${+q.x.toFixed(4)} ${+q.y.toFixed(4)}`).join(' ')).join('\n');
  const dlg = $('dlg-fpedit') as HTMLDialogElement;
  onDialogResult(dlg, (ok) => {
    if (!ok) return;
    const name = ($('fp-name') as HTMLInputElement).value.trim(); if (!name) return;
    const pads: Pad[] = [];
    for (const line of ($('fp-pads') as HTMLTextAreaElement).value.split(/\r?\n/)) {
      const f = line.trim().split(/\s+/); if (f.length < 6) continue;
      const th = f[6] === 'th';
      const rest = th ? f.slice(8) : f.slice(6);
      pads.push({ id: f[0], x: +f[1], y: +f[2], w: +f[3], h: +f[4], shape: (['rect', 'circle', 'oval'].includes(f[5]) ? f[5] : 'rect') as Pad['shape'], th, ...(th ? { drill: +f[7] } : {}), ...(rest[0] && +rest[0] ? { rot: +rest[0] } : {}) });
    }
    const outline = ($('fp-silk') as HTMLTextAreaElement).value.split(/\r?\n/).map((l) => l.trim().split(/\s+/).map(Number)).filter((a) => a.length >= 4 && a.every((v) => Number.isFinite(v))).map((a) => { const pl = []; for (let i = 0; i + 1 < a.length; i += 2) pl.push({ x: a[i], y: a[i + 1] }); return pl; });
    let bw = 1, bh = 1; for (const pd of pads) { bw = Math.max(bw, Math.abs(pd.x) * 2 + pd.w); bh = Math.max(bh, Math.abs(pd.y) * 2 + pd.h); }
    snapshot();
    project.footprints[name] = { name, pads, outline, body: { w: bw, h: bh }, outlineKind: 'silk' };
    fillFootprints(); changed(); log(`footprint ${name}: ${pads.length} pads, ${outline.length} silkscreen lines saved`);
  });
  dlg.showModal();
};
$('btn-constraints').onclick = () => {
  const dlg = $('dlg-constraints') as HTMLDialogElement; const c = constraintsText();
  ($('cons-pairs') as HTMLTextAreaElement).value = c.pairs; ($('cons-groups') as HTMLTextAreaElement).value = c.groups; ($('cons-lengths') as HTMLTextAreaElement).value = c.lengths; ($('cons-zones') as HTMLTextAreaElement).value = c.zones; ($('cons-vias') as HTMLTextAreaElement).value = c.vias;
  ($('cons-classes') as HTMLTextAreaElement).value = c.classes; ($('cons-spacing') as HTMLTextAreaElement).value = c.spacing; ($('cons-regions') as HTMLTextAreaElement).value = c.regions;
  const v = (id: string) => ($(id) as HTMLTextAreaElement).value;
  onDialogResult(dlg, (ok) => { if (ok) applyConstraints(v('cons-pairs'), v('cons-groups'), v('cons-lengths'), v('cons-zones'), v('cons-vias'), v('cons-classes'), v('cons-spacing'), v('cons-regions')); });
  dlg.showModal();
};

/* ---------- boot ---------- */
let fitted = false;
function resize(): void { const r = canvas.getBoundingClientRect(); canvas.width = Math.max(100, Math.floor(r.width)); canvas.height = Math.max(100, Math.floor(r.height)); if (!fitted && r.width > 200) { fitted = true; view.fit(project); } render(); }
new ResizeObserver(resize).observe(canvas);
fillFootprints();
try { const saved = localStorage.getItem('openboard.autosave'); if (saved) project = normalizeProject(JSON.parse(saved)); else project = demoBoard(); } catch { project = demoBoard(); }
refreshAll(); resize(); view.fit(project); render();
log('OpenBoard ready. Tools: Select, Place (P), Trace (T), Via (V), Net (N), Keepout (K). Route Automatic exports DSN → OpenRoute → imports SES.');

installExtras({
  get: () => project, set: (p) => { project = p; },
  snapshot, changed, refresh: () => { refreshAll(); render(); }, render,
  log, ask, download: (n, d, ty) => downloadBytes(n, d, ty),
  activeLayer: () => st.activeLayer, selectedNets, selectedRefs: () => [...st.selectedRefs],
  showMarkers: (m, title) => { st.drc = m; fillDrc(); render(); log(`${title}: ${m.length} finding(s) — shown in the DRC list`); },
  setCollab: (c) => { st.collab = c; },
  viewRect: () => { const a = view.toWorld({ x: 0, y: canvas.height }), b = view.toWorld({ x: canvas.width, y: 0 }); return { x1: a.x, y1: a.y, x2: b.x, y2: b.y }; },
});

/* ---------- cross-probing with OpenSchematic ---------- */
let probeSel = '', probeNet = '';
function probeOut(): void {
  const refs = [...st.selectedRefs].sort(); const k = refs.join(',');
  if (k !== probeSel) { probeSel = k; if (refs.length) xprobeSend({ type: 'select', refs, from: 'board' }); }
  const n = st.highlightNet ?? '';
  if (n !== probeNet) { probeNet = n; if (n) xprobeSend({ type: 'net', name: n, from: 'board' }); }
}
canvas.addEventListener('mouseup', () => setTimeout(probeOut, 0));
document.addEventListener('click', () => setTimeout(probeOut, 0));
xprobeOn('board', (m) => {
  if (m.type === 'select') {
    const comps = project.components.filter((c) => m.refs.includes(c.ref));
    st.selectedRefs = new Set(comps.map((c) => c.ref)); probeSel = [...st.selectedRefs].sort().join(',');
    if (comps.length) {
      // centre the view on the probed parts, keeping the zoom
      const cx = comps.reduce((a, c) => a + c.x, 0) / comps.length, cy = comps.reduce((a, c) => a + c.y, 0) / comps.length;
      view.tx = canvas.width / 2 - cx * view.scale; view.ty = canvas.height / 2 - cy * view.scale;
    }
    fillProps(); render();
  } else if (m.type === 'net') { st.highlightNet = m.name; probeNet = m.name; render(); }
  else if (m.type === 'board') { snapshot(); project = normalizeProject(m.project as Project); st.selectedRefs.clear(); refreshAll(); view.fit(project); render(); log(`board from OpenSchematic: ${project.components.length} components, ${project.nets.length} nets`); }
});
