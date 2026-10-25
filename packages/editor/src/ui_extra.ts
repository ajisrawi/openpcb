/**
 * Editor UI for the RF, package (wire bonding), rigid-flex, field solver, thermal, collaboration, scripting and
 * extra import/export features. main.ts hands over its hooks (project access, change/undo, log, dialogs).
 */
import { type Project, type Pt, normalizeProject } from './model.js';
import { fieldImpedance, fieldSiReport, widthForImpedance } from './fieldsolver.js';
import { thermalAnalysis, thermalSvg } from './thermal.js';
import { rfLine, rfStub, rfTaper, rfCoupled, rfVoid, rfRegenerate, rfSimulate, exportOpenEms } from './rf.js';
import { bondFingers, addBondWire, bondDrc, bondReport } from './bond.js';
import { addFlexZone, addBend, addStiffener, flexDrc, exportBentStep } from './flex.js';
import { importAltiumPcb } from './altium.js';
import { importPadsAscii } from './pads.js';
import { exportIdxChanges, importIdx } from './idx.js';
import { CollabClient } from './collab.js';
import { Skill, show } from './skill.js';
import { projectDrc } from './drc.js';
import type { DrcMarker } from './connectivity.js';

export interface Hooks {
  get(): Project; set(p: Project): void;
  snapshot(): void; changed(): void; refresh(): void; render(): void;
  log(s: string): void; ask(title: string, initial?: string): Promise<string | null>;
  download(name: string, data: Uint8Array | string, type?: string): void;
  activeLayer(): string; selectedNets(): string[]; selectedRefs(): string[];
  showMarkers(m: DrcMarker[], title: string): void;
  setCollab(c: { partitions: { rect: { x1: number; y1: number; x2: number; y2: number }; owner: string; color: string; mine: boolean }[]; cursors: { user: string; color: string; x: number; y: number }[] } | undefined): void;
  viewRect(): { x1: number; y1: number; x2: number; y2: number };
}

const pts = (s: string): Pt[] => { const a = s.trim().split(/[\s,;]+/).map(Number).filter((x) => !Number.isNaN(x)); const out: Pt[] = []; for (let i = 0; i + 1 < a.length; i += 2) out.push({ x: a[i], y: a[i + 1] }); return out; };
const $ = (id: string) => document.getElementById(id)!;
function openTab(content: string, type: string) { const u = URL.createObjectURL(new Blob([content], { type })); window.open(u, '_blank'); setTimeout(() => URL.revokeObjectURL(u), 60000); }
function pickBytes(accept: string, cb: (bytes: Uint8Array, name: string) => void) { const inp = document.createElement('input'); inp.type = 'file'; inp.accept = accept; inp.onchange = async () => { const f = inp.files?.[0]; if (f) cb(new Uint8Array(await f.arrayBuffer()), f.name); }; inp.click(); }

/** S11/S21 chart (dB) as SVG. */
function sparamSvg(freqs: number[], s11: [number, number][], s21: [number, number][], title: string): string {
  const W = 760, H = 380, m = 48, db = (c: [number, number]) => 20 * Math.log10(Math.max(1e-12, Math.hypot(c[0], c[1])));
  const ys = [...s11.map(db), ...s21.map(db)], y0 = Math.max(-60, Math.min(...ys)), y1 = Math.max(0, ...ys) + 1;
  const X = (f: number) => m + ((f - freqs[0]) / (freqs[freqs.length - 1] - freqs[0] || 1)) * (W - 2 * m), Y = (v: number) => H - m - ((Math.max(v, y0) - y0) / (y1 - y0)) * (H - 2 * m);
  const line = (vals: number[], col: string) => `<polyline fill="none" stroke="${col}" stroke-width="2" points="${vals.map((v, i) => `${X(freqs[i]).toFixed(1)},${Y(v).toFixed(1)}`).join(' ')}"/>`;
  const grid = Array.from({ length: 7 }, (_, k) => y0 + ((y1 - y0) * k) / 6).map((v) => `<line x1="${m}" x2="${W - m}" y1="${Y(v)}" y2="${Y(v)}" stroke="#ddd"/><text x="6" y="${Y(v) + 4}" font-size="11">${v.toFixed(0)} dB</text>`).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" font-family="sans-serif"><rect width="100%" height="100%" fill="#fff"/>${grid}${line(s11.map(db), '#d33')}${line(s21.map(db), '#26c')}<text x="${m}" y="20" font-size="13">${title}  —  S11 red, S21 blue</text><text x="${W - m - 60}" y="${H - 14}" font-size="11">${freqs[0].toFixed(2)}–${freqs[freqs.length - 1].toFixed(2)} GHz</text></svg>`;
}

export function installExtras(h: Hooks): void {
  let idxBaseline: Project | null = null;
  // ---------------------------------------------------------------- import / export
  const imp = $('sel-import') as HTMLSelectElement;
  for (const o of ['Altium PcbDoc', 'PADS ASCII', 'IDX (apply MCAD changes)']) imp.add(new Option(o));
  imp.addEventListener('change', () => {
    const v = imp.value; if (!['Altium PcbDoc', 'PADS ASCII', 'IDX (apply MCAD changes)'].includes(v)) return;
    imp.value = '';
    if (v === 'Altium PcbDoc') pickBytes('.PcbDoc,.pcbdoc', (b, name) => { try { h.snapshot(); h.set(normalizeProject(importAltiumPcb(b, name.replace(/\.pcbdoc$/i, '')))); h.refresh(); h.log(`imported ${name}: ${h.get().components.length} parts, ${h.get().nets.length} nets, ${h.get().traces.length} traces`); } catch (e) { h.log(`Altium import failed: ${(e as Error).message}`); } });
    else if (v === 'PADS ASCII') pickBytes('.asc', (b, name) => { try { h.snapshot(); h.set(normalizeProject(importPadsAscii(new TextDecoder('latin1').decode(b), name.replace(/\.asc$/i, '')))); h.refresh(); h.log(`imported ${name}: ${h.get().components.length} parts, ${h.get().nets.length} nets`); } catch (e) { h.log(`PADS import failed: ${(e as Error).message}`); } });
    else pickBytes('.idx,.xml', (b, name) => { try { h.snapshot(); const r = importIdx(h.get(), new TextDecoder().decode(b)); h.changed(); h.log(`IDX ${name} (${r.kind}): ${r.moved.length} parts moved${r.outline ? ', board outline updated' : ''}${r.unknown.length ? `; unknown parts ${r.unknown.join(', ')}` : ''}`); } catch (e) { h.log(`IDX import failed: ${(e as Error).message}`); } });
  });
  const exp = $('sel-export') as HTMLSelectElement;
  for (const o of ['IDX baseline (remember for changes)', 'IDX changes since baseline', 'STEP (bent rigid-flex + wires)', 'openEMS model (highlighted nets)']) exp.add(new Option(o));
  exp.addEventListener('change', () => {
    const v = exp.value; const name = h.get().name.replace(/[^\w.-]+/g, '_');
    if (v === 'IDX baseline (remember for changes)') { exp.value = ''; idxBaseline = JSON.parse(JSON.stringify(h.get())); h.log('IDX baseline remembered: export "IDX changes since baseline" after editing'); }
    else if (v === 'IDX changes since baseline') { exp.value = ''; if (!idxBaseline) { h.log('IDX changes: remember a baseline first'); return; } const r = exportIdxChanges(idxBaseline, h.get()); h.download(`${name}-changes.idx`, r.xml, 'application/xml'); h.log(`IDX changes: moved ${r.moved.length}, added ${r.added.length}, removed ${r.removed.length}`); }
    else if (v === 'STEP (bent rigid-flex + wires)') { exp.value = ''; h.download(`${name}-bent.step`, exportBentStep(h.get()), 'model/step'); h.log('bent STEP written'); }
    else if (v === 'openEMS model (highlighted nets)') { exp.value = ''; const nets = h.selectedNets(); if (!nets.length) { h.log('openEMS: highlight the RF net(s) first'); return; } h.ask('Port pads (e.g. J1-1 J2-1) and fmax GHz', 'J1-1 J2-1 10').then((s) => { if (!s) return; const parts = s.split(/\s+/); const fmax = Number(parts[parts.length - 1]); const ports = Number.isFinite(fmax) ? parts.slice(0, -1) : parts; h.download(`${name}-openems.py`, exportOpenEms(h.get(), { nets, ports, fmaxGHz: Number.isFinite(fmax) ? fmax : 10 }), 'text/x-python'); }); }
  });
  // ---------------------------------------------------------------- analyze
  const an = $('sel-analyze') as HTMLSelectElement;
  for (const o of ['Field solver (active layer)', 'Field-solved SI + crosstalk', 'Thermal map', 'RF S-parameters', 'Bond wire DRC', 'Rigid-flex DRC']) an.add(new Option(o));
  an.addEventListener('change', () => {
    const v = an.value; const p = h.get();
    try {
      if (v === 'Field solver (active layer)') { an.value = ''; h.ask('Trace width mm [gap mm for a pair] — or "z=50" for the width of a target', `${p.rules.width}`).then((s) => { if (!s) return; const L = h.activeLayer(); if (/^z\s*=/.test(s)) { const t = Number(s.split('=')[1]); const r = widthForImpedance(p, L, t); h.log(`field solver ${L}: ${t} ohm needs width ${r.width} mm (${r.z.toFixed(1)} ohm)`); return; } const [w, g] = s.split(/\s+/).map(Number); const r = fieldImpedance(p, L, w, { gap: g || undefined, freqsGHz: [1, 5, 10] }); h.log(`field solver ${L} w=${w}${g ? ` gap=${g}` : ''}: Z0 ${r.z0.toFixed(1)} ohm${r.zDiff ? `, Zdiff ${r.zDiff.toFixed(1)} ohm, NEXT ${(100 * (r.kNext ?? 0)).toFixed(1)}%` : ''}, eeff ${r.eeff.toFixed(2)}, ${r.tpdPsPerMm.toFixed(2)} ps/mm, loss ${r.lossDbPerMm.map((l) => `${l.ghz} GHz ${l.total.toFixed(4)}`).join(', ')} dB/mm`); }); }
      else if (v === 'Field-solved SI + crosstalk') { an.value = ''; const nets = h.selectedNets(); const r = fieldSiReport(p, { nets: nets.length ? nets : undefined }); for (const n of r.nets.slice(0, 30)) h.log(`SI ${n.net}: ${n.length.toFixed(1)} mm, ${n.delayPs.toFixed(0)} ps, loss ${n.lossDb.toFixed(2)} dB @1 GHz, Z ${n.zMin.toFixed(1)}-${n.zMax.toFixed(1)} ohm${n.segments.some((s) => s.zDiff) ? `, Zdiff ${n.segments.find((s) => s.zDiff)!.zDiff!.toFixed(1)}` : ''}`); for (const x of r.crosstalk.slice(0, 15)) h.log(`xtalk ${x.a} / ${x.b} on ${x.layer}: ${x.length} mm at ${x.gap} mm, NEXT ${(100 * x.next).toFixed(1)}%, FEXT ${(100 * x.fext).toFixed(1)}%`); }
      else if (v === 'Thermal map') { an.value = ''; h.ask('Ambient °C, h W/m²K, extra power (REF=W …)', '25 12').then((s) => { if (!s) return; const t = s.split(/\s+/); const extra: Record<string, number> = {}; for (const k of t.slice(2)) { const i = k.indexOf('='); if (i > 0) extra[k.slice(0, i)] = Number(k.slice(i + 1)); } const r = thermalAnalysis(h.get(), { ambient: Number(t[0]) || 25, hTop: Number(t[1]) || 12, hBottom: Number(t[1]) || 12, extraPower: extra }); h.log(`thermal: ${r.totalPower.toFixed(2)} W, max ${r.maxTemp.toFixed(1)} °C; ${r.parts.filter((q) => q.power > 0).slice(0, 8).map((q) => `${q.ref} ${q.temp.toFixed(1)}°C`).join(', ')}`); openTab(thermalSvg(h.get(), r, h.activeLayer()), 'image/svg+xml'); }); }
      else if (v === 'RF S-parameters') { an.value = ''; h.ask('Port pads and sweep GHz: P1 P2 fstart fstop', 'J1-1 J2-1 0.1 6').then((s) => { if (!s) return; const [a, b, f0, f1] = s.split(/\s+/); const r = rfSimulate(h.get(), a, b, { fStartGHz: Number(f0) || 0.1, fStopGHz: Number(f1) || 6, points: 201 }); openTab(sparamSvg(r.freqsGHz, r.s11 as [number, number][], r.s21 as [number, number][], `${a} -> ${b}`), 'image/svg+xml'); h.download(`${h.get().name}-${a}-${b}.s2p`, r.touchstone); h.log(`RF ${a} -> ${b}: path ${r.path.length} nodes, ${r.stubs} branches; Touchstone downloaded`); }); }
      else if (v === 'Bond wire DRC') { an.value = ''; const m = bondDrc(p); h.showMarkers(m.map((x) => ({ kind: x.kind, layer: '', at: x.at, message: x.message }) as unknown as DrcMarker), 'bond wires'); }
      else if (v === 'Rigid-flex DRC') { an.value = ''; const m = flexDrc(p); h.showMarkers(m.map((x) => ({ kind: x.kind, layer: '', at: x.at, message: x.message }) as unknown as DrcMarker), 'rigid-flex'); }
    } catch (e) { h.log(`${v} failed: ${(e as Error).message}`); }
  });
  // ---------------------------------------------------------------- RF
  const rf = $('sel-rf') as HTMLSelectElement;
  rf.onchange = () => {
    const v = rf.value; rf.value = ''; if (!v) return;
    const net = h.selectedNets()[0] ?? 'RF', L = h.activeLayer();
    const go = (f: () => unknown) => { try { h.snapshot(); const r = f() as { info?: Record<string, number> }; h.changed(); h.log(`${v}: ${r && r.info ? Object.entries(r.info).map(([k, x]) => `${k} ${Number.isFinite(x) ? Math.round(x * 1000) / 1000 : x}`).join(', ') : 'done'}`); } catch (e) { h.log(`${v} failed: ${(e as Error).message}`); } };
    if (v === 'RF line') h.ask(`RF line on ${L}, net ${net}: Z0 ohm; bend miter|curve|square; points x,y x,y …`, '50 miter 0,0 10,0 10,10').then((s) => { if (!s) return; const [z, bend, ...rest] = s.split(/\s+/); go(() => rfLine(h.get(), { net, layer: L, z0: Number(z), bend: bend as 'miter', points: pts(rest.join(' ')) })); });
    else if (v === 'RF stub' || v === 'Radial stub') h.ask(`${v} on ${L}, net ${net}: x,y angle degrees@GHz [open|short] ${v === 'Radial stub' ? 'sectorDeg' : ''}`, `0,0 90 90@2.4 open ${v === 'Radial stub' ? '60' : ''}`).then((s) => { if (!s) return; const [at, ang, dg, end, sec] = s.split(/\s+/); const [deg, f] = dg.split('@').map(Number); go(() => rfStub(h.get(), { net, layer: L, at: pts(at)[0], angle: Number(ang), degrees: deg, freqGHz: f || 1, z0: 50, end: end === 'short' ? 'short' : 'open', ...(v === 'Radial stub' ? { radial: Number(sec) || 60 } : {}) })); });
    else if (v === 'Taper') h.ask(`Taper on ${L}, net ${net}: from x,y to x,y Z1 Z2 profile(linear|exponential|klopfenstein)`, '0,0 10,0 50 25 klopfenstein').then((s) => { if (!s) return; const [a, b, z1, z2, prof] = s.split(/\s+/); go(() => rfTaper(h.get(), { net, layer: L, from: pts(a)[0], to: pts(b)[0], z1: Number(z1), z2: Number(z2), profile: (prof as 'linear') ?? 'exponential' })); });
    else if (v === 'Coupled lines') h.ask(`Coupled lines on ${L}: net1 net2 width gap points x,y …`, `${net} ${net}_N 0.2 0.15 0,0 10,0`).then((s) => { if (!s) return; const [n1, n2, w, g, ...rest] = s.split(/\s+/); go(() => rfCoupled(h.get(), { net: n1, net2: n2, layer: L, width: Number(w), gap: Number(g), points: pts(rest.join(' ')) })); });
    else if (v === 'Ground void (highlighted net)') h.ask(`Void around ${net}: gap mm, layers`, `0.3 ${h.get().layers[1]?.name ?? 'B.Cu'}`).then((s) => { if (!s) return; const [g, ...ls] = s.split(/\s+/); go(() => ({ info: { voids: rfVoid(h.get(), { layers: ls.join(',').split(','), around: { net, gap: Number(g) } }).length } })); });
    else if (v === 'Edit RF element') h.ask(`RF element id and params (key=value …); ids: ${(h.get().rfElements ?? []).map((e) => `${e.id}:${e.kind}`).join(' ')}`).then((s) => { if (!s) return; const [id, ...kv] = s.split(/\s+/); const e = h.get().rfElements?.find((x) => x.id === Number(id)); if (!e) { h.log('no such RF element'); return; } for (const k of kv) { const i = k.indexOf('='); const val = k.slice(i + 1); (e.params as Record<string, unknown>)[k.slice(0, i)] = isNaN(Number(val)) ? val : Number(val); } go(() => rfRegenerate(h.get(), e.id)); });
  };
  // ---------------------------------------------------------------- package (wire bonding)
  const pk = $('sel-pkg') as HTMLSelectElement;
  pk.onchange = () => {
    const v = pk.value; pk.value = ''; if (!v) return;
    try {
      if (v === 'Bond fingers (selected die)') { const die = h.selectedRefs()[0]; if (!die) { h.log('select the die first'); return; } h.ask(`Fingers for ${die}: offset mm, finger width, length, rows`, '0.5 0.1 0.35 1').then((s) => { if (!s) return; const [o, w, l, r] = s.split(/\s+/).map(Number); h.snapshot(); const res = bondFingers(h.get(), die, { offset: o, fingerW: w, fingerL: l, rows: r }); h.changed(); h.log(`bond fingers: ${res.fingers} fingers, ${res.wires} wires (${res.component})`); }); }
      else if (v === 'Bond wire') h.ask('Wire from pad to pad (e.g. U1-3 BF_U1-3) [diameter mm]', ' 0.025').then((s) => { if (!s) return; const [a, b, d] = s.trim().split(/\s+/); const sp = (k: string) => ({ ref: k.slice(0, k.lastIndexOf('-')), pad: k.slice(k.lastIndexOf('-') + 1) }); h.snapshot(); addBondWire(h.get(), sp(a), sp(b), { diameter: Number(d) || 0.025 }); h.changed(); });
      else if (v === 'Bond profile') h.ask('Profile: name loopHeight kink landingAngle dieHeight (mm, °)', 'STD 0.15 0.25 30 0.2').then((s) => { if (!s) return; const [n, lh, k, a, dh] = s.split(/\s+/); h.snapshot(); const p = h.get(); p.bondProfiles = [...(p.bondProfiles ?? []).filter((x) => x.name !== n), { name: n, loopHeight: Number(lh), kink: Number(k), landingAngle: Number(a), dieHeight: Number(dh) }]; h.changed(); });
      else if (v === 'Bond report') { const r = bondReport(h.get()); h.log(`bond wires: ${r.length}, total ${r.reduce((s, w) => s + w.length, 0).toFixed(2)} mm`); for (const w of r.slice(0, 40)) h.log(`  ${w.from} -> ${w.to} ${w.net}: ${w.length} mm, ${w.diameter * 1000} um ${w.material}, profile ${w.profile}`); }
    } catch (e) { h.log(`${v} failed: ${(e as Error).message}`); }
  };
  // ---------------------------------------------------------------- rigid-flex
  const fx = $('sel-flex') as HTMLSelectElement;
  fx.onchange = () => {
    const v = fx.value; fx.value = ''; if (!v) return;
    const lay = h.get().layers.map((l) => l.name);
    if (v === 'Flex zone') h.ask('Flex zone: name layers(comma) points x,y …', `FLEX1 ${lay[0]},${lay[lay.length - 1]} 0,0 10,0 10,5 0,5`).then((s) => { if (!s) return; const [n, ls, ...rest] = s.split(/\s+/); h.snapshot(); addFlexZone(h.get(), { name: n, layers: ls.split(','), points: pts(rest.join(' ')), coverlay: true }); h.changed(); });
    else if (v === 'Bend area') h.ask('Bend: name angle radius axis x1,y1 x2,y2 then area points x,y …', 'B1 90 1 0,0 0,10 0,0 5,0 5,10 0,10').then((s) => { if (!s) return; const [n, a, r, a1, a2, ...rest] = s.split(/\s+/); const ax = pts(`${a1} ${a2}`); h.snapshot(); addBend(h.get(), { name: n, angle: Number(a), radius: Number(r), axis: [ax[0], ax[1]], points: pts(rest.join(' ')) }); h.changed(); });
    else if (v === 'Stiffener') h.ask('Stiffener: side(front|back) thickness material points x,y …', 'back 0.2 FR4 0,0 5,0 5,5 0,5').then((s) => { if (!s) return; const [side, t, m, ...rest] = s.split(/\s+/); h.snapshot(); addStiffener(h.get(), { side: side === 'front' ? 'front' : 'back', thickness: Number(t), material: m, points: pts(rest.join(' ')) }); h.changed(); });
  };
  // ---------------------------------------------------------------- script console (OpenSKILL)
  const dlgS = $('dlg-script') as HTMLDialogElement;
  $('btn-script').onclick = () => dlgS.showModal();
  $('script-run').onclick = (e) => {
    e.preventDefault();
    const out = $('script-out');
    h.snapshot();
    const sk = new Skill(h.get(), { print: (s) => { out.textContent += s; }, drc: () => projectDrc(h.get()).map((m) => ({ kind: m.kind, message: m.message, x: m.at.x, y: m.at.y })) });
    try { const v = sk.run(($('script-src') as HTMLTextAreaElement).value); out.textContent += `=> ${show(v)}\n`; h.changed(); h.render(); } catch (err) { out.textContent += `*Error* ${(err as Error).message}\n`; }
    out.scrollTop = out.scrollHeight;
  };
  // ---------------------------------------------------------------- collaboration
  const dlgC = $('dlg-collab') as HTMLDialogElement;
  let cl: CollabClient | null = null;
  const cursors = new Map<string, { user: string; color: string; x: number; y: number }>();
  const overlay = () => { if (!cl) { h.setCollab(undefined); return; } h.setCollab({ partitions: cl.partitions.map((pt) => ({ rect: pt.rect, owner: pt.owner, color: cl!.users.find((u) => u.name === pt.owner)?.color ?? '#f80', mine: pt.owner === cl!.you })), cursors: [...cursors.values()] }); h.render(); };
  const chatLog = (s: string) => { const el = $('collab-chat'); el.textContent += s + '\n'; el.scrollTop = el.scrollHeight; };
  const usersEl = () => { $('collab-users').textContent = cl ? cl.users.map((u) => u.name + (u.name === cl!.you ? ' (you)' : '')).join(', ') : 'not connected'; };
  $('btn-collab').onclick = () => { usersEl(); dlgC.showModal(); };
  $('collab-connect').onclick = (e) => {
    e.preventDefault();
    if (cl) { cl.close(); cl = null; usersEl(); overlay(); return; }
    cl = new CollabClient(() => h.get(), (p) => { h.set(normalizeProject(p)); h.refresh(); }, {
      remote: (ops, user) => { h.log(`collab: ${user} changed ${ops.length} object(s)`); },
      users: () => { usersEl(); overlay(); }, locks: () => overlay(), partitions: () => overlay(),
      cursor: (user, x, y) => { cursors.set(user, { user, color: cl!.users.find((u) => u.name === user)?.color ?? '#f80', x, y }); overlay(); },
      chat: (user, text, at) => chatLog(`[${at.slice(11, 16)}] ${user}: ${text}`),
      reject: (reason) => h.log(`collab: change refused — ${reason}`),
      history: (v) => chatLog(`versions: ${v.map((x) => `${x.id} "${x.note}" (${x.user})`).join('; ') || 'none'}`),
      reload: () => h.log('collab: project restored from a checkpoint'),
      closed: () => { h.log('collab: disconnected'); cl = null; usersEl(); overlay(); },
    });
    cl.connect(($('collab-url') as HTMLInputElement).value, ($('collab-name') as HTMLInputElement).value || 'user').then(() => { h.log(`collab: joined ${($('collab-url') as HTMLInputElement).value} as ${cl!.you}`); usersEl(); overlay(); }).catch((err) => { h.log(`collab: ${(err as Error).message}`); cl = null; });
  };
  $('collab-send').onclick = (e) => { e.preventDefault(); const i = $('collab-msg') as HTMLInputElement; if (cl && i.value) { cl.chat(i.value); i.value = ''; } };
  $('collab-partition').onclick = (e) => { e.preventDefault(); if (cl) cl.partition(h.viewRect()); };
  $('collab-lock').onclick = (e) => { e.preventDefault(); if (!cl) return; for (const r of h.selectedRefs()) cl.lock('components', r); };
  $('collab-checkpoint').onclick = (e) => { e.preventDefault(); if (cl) h.ask('Checkpoint note').then((s) => { if (s) cl!.checkpoint(s); }); };
  $('collab-history').onclick = (e) => { e.preventDefault(); if (cl) cl.history(); };
  $('collab-restore').onclick = (e) => { e.preventDefault(); if (cl) h.ask('Version id to restore').then((s) => { if (s) cl!.restore(s.trim()); }); };
  // the editor reports local changes and the cursor
  (window as unknown as { __collabPush?: () => void }).__collabPush = () => { if (cl?.connected) cl.push(); };
  let last = 0;
  (window as unknown as { __collabCursor?: (q: Pt) => void }).__collabCursor = (q) => { const now = Date.now(); if (cl?.connected && now - last > 80) { last = now; cl.cursor(q.x, q.y); } };
}
