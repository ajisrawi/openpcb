/**
 * Allegro Design Entry HDL (Concept) designs: a project file (.cpm: design_name, design_library), cds.lib library
 * definitions, schematic pages as command scripts (<lib>/<cell>/sch_1/page<N>.csa) and symbols in a compact text form
 * (<lib>/<cell>/sym_<ver>/symbol.css). Units are mils with y up; cell directories encode special characters as
 * #xx (space = #20).
 *
 *   page:   FORCEADD <CELL>..<ver> [R n] (x y)      place a symbol (rotation fitted against the stored pin points)
 *           FORCEPROP n LAST <name> <value>         property of the last object (REFDES, VALUE, CDS_LIB, SIG_NAME…)
 *           FORCEPROP n LASTPIN (x y) SIG_NAME s    the net name of the pin at (x y) of the last part
 *           WIRE w s (x1 y1)(x2 y2)                 a wire segment; FORCEPROP … SIG_NAME after it names it
 *           FORCENOTE <text> (x y) r                a note
 *   symbol: C x y "PIN\NAC" …                      a pin (connection point)
 *           L x1 y1 x2 y2 w f                       a line;  A cx cy r a0 a1 f  an arc (degrees, counter-clockwise)
 *           P "NAME" "value" …                      a default property
 * Signal names ending in \G are global. Ports (INPORT / OUTPORT / IOPORT / BUFPORT), off-page connectors and power
 * symbols are named by the SIG_NAME of their pin; cells of the design library with a schematic become hierarchical
 * blocks.
 */
import { type Design, type Page, type LibPart, type SymPin, type Graphic, type Library, type Pt, type Orient, newDesign, newPage, nid, toPage, PAGE_SIZES } from './model.js';

export interface DeHdlFs { read(path: string): string | null; list(dir: string): string[] }

interface Sym { pins: { name: string; x: number; y: number }[]; graphics: Graphic[]; props: Record<string, string>; box: { x1: number; y1: number; x2: number; y2: number } }
interface CInst { cell: string; ver: string; lib?: string; rot: number; mirror: boolean; at: Pt; props: Record<string, string>; sigs: { at: Pt; name: string }[] }
interface CWire { a: Pt; b: Pt; name?: string }

const encCell = (c: string) => c.toLowerCase().replace(/[^a-z0-9_]/g, (ch) => `#${ch.charCodeAt(0).toString(16).padStart(2, '0')}`);
const PORTS = /^(INPORT|OUTPORT|IOPORT|BUFPORT|AOUTPORT|AINPORT)$/i;
const POWER = /^(GROUND|GND|0|VCC.*|VDD.*|VEE.*|VSS.*|POWER|GND_.*|.*_GND|DGND|AGND)$/i;

function parseSymbol(text: string): Sym {
  const pins: Sym['pins'] = []; const graphics: Graphic[] = []; const props: Record<string, string> = {};
  let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity; const ext = (x: number, y: number) => { x1 = Math.min(x1, x); y1 = Math.min(y1, y); x2 = Math.max(x2, x); y2 = Math.max(y2, y); };
  for (const raw of text.split(/\r?\n/)) {
    const l = raw.trim(); if (!l) continue;
    const k = l[0], rest = l.slice(1).trim();
    if (k === 'C' && l[1] === ' ') { const m = /^(-?\d+)\s+(-?\d+)\s+"([^"]*)"/.exec(rest); if (m) { const name = m[3].replace(/\\NAC$/i, '').replace(/\s*<[^>]*>\s*$/, '').trim(); pins.push({ name, x: Number(m[1]), y: -Number(m[2]) }); ext(Number(m[1]), -Number(m[2])); } }
    else if (k === 'L' && l[1] === ' ') { const v = rest.split(/\s+/).map(Number); if (v.length >= 4) { graphics.push({ kind: 'line', pts: [{ x: v[0], y: -v[1] }, { x: v[2], y: -v[3] }] }); ext(v[0], -v[1]); ext(v[2], -v[3]); } }
    else if (k === 'A' && l[1] === ' ') { const v = rest.split(/\s+/).map(Number); if (v.length >= 5) { let a0 = v[3], a1 = v[4]; if (a1 <= a0) a1 += 360; graphics.push({ kind: 'arc', c: { x: v[0], y: -v[1] }, r: v[2], a0, a1 }); ext(v[0] - v[2], -v[1] - v[2]); ext(v[0] + v[2], -v[1] + v[2]); } }
    else if (k === 'P' && l[1] === ' ') { const m = /^"([^"]*)"\s+"([^"]*)"/.exec(rest); if (m) props[m[1]] = m[2]; }
  }
  if (!Number.isFinite(x1)) { x1 = y1 = -50; x2 = y2 = 50; }
  return { pins, graphics, props, box: { x1, y1, x2, y2 } };
}

/** Statements of a .csa page (each ends with ';'). */
function statements(text: string): string[] { return text.split(';').map((s) => s.replace(/\r/g, '').trim()).filter(Boolean); }
const PT = /\((-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)\)/g;

function parsePage(text: string): { insts: CInst[]; wires: CWire[]; notes: { at: Pt; text: string }[] } {
  const insts: CInst[] = [], wires: CWire[] = [], notes: { at: Pt; text: string }[] = [];
  let last: { kind: 'inst'; i: CInst } | { kind: 'wire'; w: CWire } | null = null;
  for (const st of statements(text)) {
    const lines = st.split('\n'); const head = lines[0].trim();
    const pts = [...st.matchAll(PT)].map((m) => ({ x: Number(m[1]), y: Number(m[2]) }));
    if (head.startsWith('FORCEADD ')) {
      const m = /^FORCEADD\s+(.+?)\.\.(\d+)/.exec(head); if (!m) continue;
      const rl = lines.find((x) => /^R\s+\d/.test(x.trim())); const mirror = lines.some((x) => /^M(\s|$)/.test(x.trim()));
      const i: CInst = { cell: m[1].trim(), ver: m[2], rot: rl ? Number(rl.trim().split(/\s+/)[1]) : 0, mirror, at: pts[pts.length - 1] ?? { x: 0, y: 0 }, props: {}, sigs: [] };
      insts.push(i); last = { kind: 'inst', i };
    } else if (head.startsWith('FORCEPROP ')) {
      const pin = /^FORCEPROP\s+\d+\s+LASTPIN\s+\((-?\d+)\s+(-?\d+)\)\s+(\S+)\s*(.*)$/.exec(head);
      if (pin) { if (last?.kind === 'inst' && pin[3] === 'SIG_NAME') last.i.sigs.push({ at: { x: Number(pin[1]), y: Number(pin[2]) }, name: pin[4].trim() }); continue; }
      const pr = /^FORCEPROP\s+\d+\s+LAST\s+(\S+)\s*(.*)$/.exec(head);
      if (pr) { if (last?.kind === 'inst') { if (pr[1] === 'CDS_LIB') last.i.lib = pr[2].trim(); else last.i.props[pr[1]] = pr[2].trim(); } else if (last?.kind === 'wire' && pr[1] === 'SIG_NAME') last.w.name = pr[2].trim(); }
    } else if (head.startsWith('WIRE ')) {
      if (pts.length >= 2) { const w: CWire = { a: pts[0], b: pts[1] }; wires.push(w); last = { kind: 'wire', w }; }
    } else if (head.startsWith('FORCENOTE')) {
      const body = lines.slice(1).filter((x) => !/\(-?\d/.test(x)).join(' ').trim();
      if (body && pts.length) notes.push({ at: pts[0], text: body });
    }
  }
  return { insts, wires, notes };
}

export interface DeHdlImport { design: Design; notes: string[]; sigs: { sch: string; ref: string; pin: string; name: string }[] }

/**
 * Import a DE-HDL project. `project` is the .cpm path; `fs` reads files (paths with '/'); `installDir` resolves
 * $CONCEPT_INST_DIR in cds.lib.
 */
export function importDeHdl(project: string, fs: DeHdlFs, opts: { installDir?: string } = {}): DeHdlImport {
  const notes: string[] = [];
  const dir = project.replace(/\\/g, '/').replace(/\/[^/]*$/, '');
  const cpm = fs.read(project) ?? '';
  const designName = /design_name\s+'([^']+)'/i.exec(cpm)?.[1] ?? '';
  const designLib = /design_library\s+'([^']+)'/i.exec(cpm)?.[1] ?? 'worklib';
  if (!designName) throw new Error('no design_name in the project file');
  // libraries from cds.lib (DEFINE name path; INCLUDE file)
  const libs = new Map<string, string>();
  const readCdsLib = (file: string, base: string, depth: number) => {
    const t = fs.read(file); if (!t || depth > 4) return;
    for (const raw of t.split(/\r?\n/)) {
      const l = raw.replace(/#.*$/, '').trim(); const m = /^(DEFINE|INCLUDE)\s+(\S+)(?:\s+(\S+))?/i.exec(l); if (!m) continue;
      const fix = (p: string) => { let q = p.replace(/\$CONCEPT_INST_DIR|\$\{CONCEPT_INST_DIR\}|%CONCEPT_INST_DIR%/gi, (opts.installDir ?? 'C:/Cadence/SPB_22.1')).replace(/\\/g, '/'); if (!/^([a-z]:)?\//i.test(q)) q = `${base}/${q.replace(/^\.\//, '')}`; return q.replace(/\/+$/, ''); };
      if (m[1].toUpperCase() === 'DEFINE' && m[3]) libs.set(m[2].toLowerCase(), fix(m[3]));
      else if (m[1].toUpperCase() === 'INCLUDE') { const f = fix(m[2]); readCdsLib(f, f.replace(/\/[^/]*$/, ''), depth + 1); }
    }
  };
  readCdsLib(`${dir}/cds.lib`, dir, 0);
  const libDir = (lib: string) => libs.get(lib.toLowerCase()) ?? (lib.toLowerCase() === designLib.toLowerCase() ? `${dir}/worklib` : undefined);
  const designDir = libDir(designLib) ?? `${dir}/worklib`;

  const d = newDesign(designName); d.schematics = []; d.root = designName;
  const lib: Library = { name: `${designName}_hdl`, parts: {} }; d.libraries.push(lib);
  const symCache = new Map<string, Sym | null>();
  const symbolOf = (cell: string, ver: string, libName?: string): { sym: Sym; lib: string } | null => {
    const tryLibs = libName ? [libName, designLib, ...libs.keys()] : [designLib, ...libs.keys()];
    for (const L of tryLibs) {
      const ld = libDir(L); if (!ld) continue;
      const key = `${L}|${cell}|${ver}`;
      if (!symCache.has(key)) { const t = fs.read(`${ld}/${encCell(cell)}/sym_${ver}/symbol.css`) ?? fs.read(`${ld}/${encCell(cell)}/sym_1/symbol.css`); symCache.set(key, t ? parseSymbol(t) : null); }
      const s = symCache.get(key); if (s) return { sym: s, lib: L };
    }
    return null;
  };
  const hasSchematic = (cell: string) => fs.list(`${designDir}/${encCell(cell)}/sch_1`).some((f) => /^page\d+\.csa$/i.test(f));
  const sigsOut: DeHdlImport['sigs'] = [];
  const done = new Set<string>();

  const loadDesign = (cell: string, depth: number) => {
    if (done.has(cell.toLowerCase()) || depth > 16) return; done.add(cell.toLowerCase());
    const pages = fs.list(`${designDir}/${encCell(cell)}/sch_1`).filter((f) => /^page\d+\.csa$/i.test(f)).sort((a, b) => Number(/\d+/.exec(a)![0]) - Number(/\d+/.exec(b)![0]));
    const sch = { name: cell, pages: [] as Page[] }; d.schematics.push(sch);
    for (const pf of pages) {
      const pg = parsePage(fs.read(`${designDir}/${encCell(cell)}/sch_1/${pf}`) ?? '');
      // page bounds (y up) -> our sheet (y down, positive)
      let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity; const ext = (p: Pt) => { x1 = Math.min(x1, p.x); y1 = Math.min(y1, p.y); x2 = Math.max(x2, p.x); y2 = Math.max(y2, p.y); };
      for (const w of pg.wires) { ext(w.a); ext(w.b); } for (const i of pg.insts) if (!/SIZE PAGE/i.test(i.cell)) ext(i.at);
      if (!Number.isFinite(x1)) { x1 = y1 = 0; x2 = y2 = 1000; }
      const W = x2 - x1 + 1600, H = y2 - y1 + 1600;
      const size = (Object.entries(PAGE_SIZES).find(([k, v]) => /^[A-E]$/.test(k) && v.w >= W && v.h >= H)?.[0] ?? 'E') as Page['size'];
      const S = PAGE_SIZES[size]; const ox = (S.w - (x2 - x1)) / 2 - x1, oy = (S.h - (y2 - y1)) / 2 + y2;
      const P = (p: Pt): Pt => ({ x: Math.round(p.x + ox), y: Math.round(oy - p.y) });
      const page = newPage(pf.replace(/\.csa$/i, '').toUpperCase(), size); page.title = { Title: `${cell} ${pf.replace(/\.csa$/i, '')}`, 'Document Number': designName };
      for (const w of pg.wires) { const id = nid(d); page.wires.push({ id, pts: [P(w.a), P(w.b)] }); if (w.name && !/^UN\$/i.test(w.name)) addName(page, P(w.a), w.name, id); }
      for (const n of pg.notes) page.texts.push({ id: nid(d), at: P(n.at), text: n.text, size: 60 });
      for (const ci of pg.insts) {
        if (/SIZE PAGE|^PAGE$/i.test(ci.cell)) continue;
        const found = symbolOf(ci.cell, ci.ver, ci.lib);
        if (!found) { notes.push(`${cell}/${pf}: symbol ${ci.lib ?? '?'}:${ci.cell}..${ci.ver} not found`); continue; }
        const { sym, lib: libName } = found;
        // orientation: the one that puts the symbol pins on the stored pin points
        const fit = fitPlacement(sym, ci, pg.wires);
        if ((globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env?.DEHDL_DEBUG) notes.push(`debug ${cell}/${pf} ${ci.props.PATH ?? ''} ${ci.cell} R${ci.rot}${ci.mirror ? 'M' : ''} at ${ci.at.x},${ci.at.y} -> rot ${fit.rot} mirror ${fit.mirror} pivot ${fit.pivot.x},${fit.pivot.y} score ${(fit as { score?: number }).score} pins ${JSON.stringify(sym.pins)}`);
        const placed = sym.pins.map((pn) => ({ name: pn.name, at: P(toY(xf(fit.rot, fit.mirror, { x: pn.x, y: pn.y }, fit.pivot), ci.at)) }));
        const sigAt = (q: Pt) => ci.sigs.find((s) => { const pq = P(s.at); return Math.abs(pq.x - q.x) < 1 && Math.abs(pq.y - q.y) < 1; })?.name;
        const ref = ci.props.REFDES ?? ci.props.LOCATION ?? ci.props.$PSPICE_LOCATION ?? ci.props.$LOCATION ?? `I${pg.insts.indexOf(ci) + 1}`;
        if (PORTS.test(ci.cell) || /^OFFPAGE$/i.test(ci.cell) || (!sym.pins.length)) {
          if (!sym.pins.length) continue;
          const at = placed[0].at, name = (sigAt(at) ?? ci.props.SIG_NAME ?? ref).replace(/\\[Gg]$/, '');
          if (/^OFFPAGE$/i.test(ci.cell)) page.offPages.push({ id: nid(d), at, name });
          else page.ports.push({ id: nid(d), at, name, dir: /^IN/i.test(ci.cell) || /^AIN/i.test(ci.cell) ? 'input' : /OUT/i.test(ci.cell) ? 'output' : 'bidirectional' });
          continue;
        }
        if (sym.pins.length === 1 && (POWER.test(ci.cell) || /\\G$/i.test(ci.sigs[0]?.name ?? ''))) {
          const at = placed[0].at, net = (sigAt(at) ?? ci.props.SIG_NAME ?? ci.cell).replace(/\\[Gg]$/, '');
          page.globals.push({ id: nid(d), at, net, style: /GND|GROUND|^0$|VSS/i.test(net) ? 'ground' : 'power_bar' });
          continue;
        }
        if (hasSchematic(ci.cell) && libName.toLowerCase() === designLib.toLowerCase()) {
          // a hierarchical block: body from the symbol, pins on its outline
          const b = sym.box; const r = toY(xf(fit.rot, fit.mirror, { x: b.x1, y: b.y1 }, fit.pivot), ci.at), s2 = toY(xf(fit.rot, fit.mirror, { x: b.x2, y: b.y2 }, fit.pivot), ci.at);
          const A = P(r), B = P(s2); const bx = Math.min(A.x, B.x), by = Math.min(A.y, B.y), bw = Math.abs(B.x - A.x) || 200, bh = Math.abs(B.y - A.y) || 200;
          const pins = placed.map((p) => { const dl = Math.abs(p.at.x - bx), dr = Math.abs(p.at.x - (bx + bw)), dt = Math.abs(p.at.y - by), db = Math.abs(p.at.y - (by + bh)); const m = Math.min(dl, dr, dt, db); const side = (m === dl ? 'left' : m === dr ? 'right' : m === dt ? 'top' : 'bottom') as 'left'; return { name: p.name, dir: 'bidirectional' as const, side, offset: side === 'left' || side === 'right' ? p.at.y - by : p.at.x - bx, at: p.at }; });
          page.blocks.push({ id: nid(d), ref: ref.toUpperCase(), schematic: ci.cell, x: bx, y: by, w: bw, h: bh, pins: pins.map(({ at: _a, ...q }) => q) });
          for (const p of pins) { const e = sideEdge(bx, by, bw, bh, p.side, p.offset); if (Math.abs(e.x - p.at.x) + Math.abs(e.y - p.at.y) > 0.5) page.wires.push({ id: nid(d), pts: [e, p.at] }); const sname = sigAt(p.at); if (sname && !/^UN\$/i.test(sname)) addName(page, p.at, sname); }
          loadDesign(ci.cell, depth + 1);
          continue;
        }
        const key = `${libName}:${ci.cell}`;
        lib.parts[key] ??= libPartOf(key, sym);
        const pi = { id: nid(d), lib: lib.name, part: key, unit: 0, ref, x: 0, y: 0, rot: fit.rot as 0, ...(fit.mirror ? { mirror: true } : {}), props: { ...(ci.props.VALUE ? { Value: ci.props.VALUE } : {}), ...Object.fromEntries(Object.entries(ci.props).filter(([k]) => !/^(VALUE|REFDES|PATH|\$.*|CDS_.*)$/.test(k))) }, ...(ci.props.PATH ? { occKey: ci.props.PATH } : {}) };
        const o = P(ci.at), sh = xf(fit.rot, fit.mirror, { x: 0, y: 0 }, fit.pivot); pi.x = o.x + sh.x; pi.y = o.y + sh.y;
        page.parts.push(pi);
        for (const p of placed) { const s = sigAt(p.at); if (s) { sigsOut.push({ sch: cell, ref, pin: p.name, name: s }); if (!/^UN\$/i.test(s)) addName(page, p.at, s); } }
      }
      sch.pages.push(page);
    }
    if (!pages.length) notes.push(`${cell}: no schematic pages`);
  };
  /** a signal name at a point: a global symbol for \G names, else a net alias */
  function addName(page: Page, at: Pt, name: string, wire?: number) {
    if (/\\G$/i.test(name)) page.globals.push({ id: nid(d), at, net: name.replace(/\\[Gg]$/, ''), style: 'label' });
    else page.aliases.push({ id: nid(d), at, name, ...(wire !== undefined ? { wire } : {}) });
  }
  loadDesign(designName, 0);
  notes.push(`${d.schematics.length} schematics, ${d.schematics.reduce((n, s) => n + s.pages.length, 0)} pages, ${Object.keys(lib.parts).length} symbols`);
  return { design: d, notes, sigs: sigsOut };
}

/** symbol-local point (y down) -> offset from the placement point (y down) for a rotation / mirror about a pivot */
const xf = (rot: number, mirror: boolean, q: Pt, pivot: Pt = { x: 0, y: 0 }): Pt => { const T = (v: Pt) => toPage({ x: 0, y: 0, rot, mirror }, v); const a = T(q), c = T(pivot); return { x: pivot.x - c.x + a.x, y: pivot.y - c.y + a.y }; };
/** the same offset applied to a Concept placement point (y up) -> absolute Concept coordinates */
const toY = (q: Pt, at: Pt): Pt => ({ x: at.x + q.x, y: at.y - q.y });
const sideEdge = (bx: number, by: number, bw: number, bh: number, side: string, off: number): Pt => (side === 'left' ? { x: bx, y: by + off } : side === 'right' ? { x: bx + bw, y: by + off } : side === 'top' ? { x: bx + off, y: by } : { x: bx + off, y: by + bh });

/**
 * Orientation and rotation pivot of a placed symbol: the symbol files do not say about which point Concept turns a
 * symbol, so the candidates (origin, the 50-grid centre of the pins and of the body, (50, -50)) and the eight
 * orientations are scored by the pins that land on wires and on the stored pin points; the stored rotation wins ties.
 */
function fitPlacement(sym: Sym, ci: CInst, wires: CWire[]): { rot: 0 | 90 | 180 | 270; mirror: boolean; pivot: Pt } {
  // R 0..3: 0 / 90 / 180 / 270 degrees; R 4..7: the same mirrored (learned from the samples' wiring). The origin is the
  // preferred pivot when the wires cannot tell.
  const hint = { rot: (((ci.rot % 4) + 4) % 4) * 90 as 0 | 90 | 180 | 270, mirror: ci.mirror || ci.rot >= 4 };
  const hintPivot = 0;
  if (!sym.pins.length) return { ...hint, pivot: { x: 0, y: 0 } };
  const snap = (v: number) => Math.round(v / 50) * 50;
  const px = sym.pins.map((p) => p.x), py = sym.pins.map((p) => p.y);
  const pivots: Pt[] = [{ x: 0, y: 0 }, { x: 50, y: 50 }, { x: snap((Math.min(...px) + Math.max(...px)) / 2), y: snap((Math.min(...py) + Math.max(...py)) / 2) }, { x: snap((sym.box.x1 + sym.box.x2) / 2), y: snap((sym.box.y1 + sym.box.y2) / 2) }];
  const onWire = (q: Pt) => wires.some((w) => { const minx = Math.min(w.a.x, w.b.x) - 0.5, maxx = Math.max(w.a.x, w.b.x) + 0.5, miny = Math.min(w.a.y, w.b.y) - 0.5, maxy = Math.max(w.a.y, w.b.y) + 0.5; if (q.x < minx || q.x > maxx || q.y < miny || q.y > maxy) return false; return Math.abs((w.b.x - w.a.x) * (q.y - w.a.y) - (w.b.y - w.a.y) * (q.x - w.a.x)) < 1; });
  const sigAt = (q: Pt) => ci.sigs.some((g) => Math.abs(g.at.x - q.x) < 1 && Math.abs(g.at.y - q.y) < 1);
  let best = { ...hint, pivot: { x: 0, y: 0 }, score: -Infinity };
  for (const mirror of [false, true]) for (const rot of [0, 90, 180, 270] as const) for (const [k, pv] of pivots.entries()) {
    let score = 0;
    for (const pn of sym.pins) { const r = toY(xf(rot, mirror, { x: pn.x, y: pn.y }, pv), ci.at); if (sigAt(r)) score += 2; else if (onWire(r)) score += 1; }
    score += (rot === hint.rot && mirror === hint.mirror ? 0.5 : 0) + (k === hintPivot ? 0.05 : -k * 0.01);
    if (score > best.score) best = { rot, mirror, pivot: pv, score };
  }
  return best;
}

function libPartOf(name: string, sym: Sym): LibPart {
  const cx = (sym.box.x1 + sym.box.x2) / 2, cy = (sym.box.y1 + sym.box.y2) / 2;
  const pins: SymPin[] = sym.pins.map((p, i) => {
    const dx = p.x - cx, dy = p.y - cy;
    const orient: Orient = Math.abs(dx) >= Math.abs(dy) ? (dx < 0 ? 'left' : 'right') : dy < 0 ? 'up' : 'down';
    return { number: /^\d+$/.test(p.name) ? p.name : String(i + 1), name: p.name, type: 'passive', x: p.x, y: p.y, length: 0, orient };
  });
  return { name, refPrefix: (sym.props.REFDES ?? sym.props.LOCATION ?? 'U').replace(/[?\d]+$/, '') || 'U', units: [{ normal: { graphics: sym.graphics, pins } }], props: { ...(sym.props.VALUE && sym.props.VALUE !== '?' ? { Value: sym.props.VALUE } : {}) }, kind: 'part', description: `Design Entry HDL ${name}` };
}
