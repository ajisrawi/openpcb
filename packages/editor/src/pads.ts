/**
 * PADS Layout ASCII import (.asc, "!PADS-POWERPCB-V...!" database file).
 *
 * Units follow the header: BASIC (1/38100 mil), MILS, METRIC (mm) or INCHES. Sections read:
 *   *PCB*        MAXIMUMLAYER
 *   *MISC*       LAYER DATA: names, ROUTING/PLANE types (CAM planes = plane layers), copper and dielectric thickness, Er
 *   *LINES*      BOARD outline (piece coordinates are relative to the item's XLOC/YLOC), KEEPOUT areas
 *   *VIA*        via names, drill, pad sizes, drill span (blind/buried)
 *   *PARTDECAL*  footprints: terminals (T x y ...), pad stacks (PAD pin n: level size shape ...; pin 0 = default),
 *                silkscreen pieces (OPEN/CLOSED/CIRCLE)
 *   *PARTTYPE*   part type -> decal (alternate decals by index)
 *   *PART*       instances: ref, type[@decal], position, rotation, mirror (bottom side), alternate
 *   *NET* / *ROUTE*  signals: pin pairs make the nets; route vertices "x y layer width flags [vianame]" make traces
 *                (layer of the vertex = layer of the segment leaving it; a via name places a via at the vertex)
 *   *POUR*       POUROUT outlines with their net -> zones
 */
import { type Project, type Pt, type Pad, newProject, nextId, LAYER_COLORS } from './model.js';

interface Decal { name: string; terms: { pin: string; x: number; y: number }[]; stacks: Map<string, { size: number; shape: string; drill: number; plated: boolean; w: number; h: number; ori: number }>; outline: Pt[][] }
interface ViaDef { name: string; drill: number; size: number; from?: number; to?: number }

export function importPadsAscii(text: string, name = 'pads'): Project {
  const lines = text.split(/\r\n|\r|\n/);
  const head = lines[0] ?? '';
  if (!/^!PADS-/i.test(head)) throw new Error('not a PADS ASCII file (no !PADS- header)');
  const U = /-BASIC/i.test(head) ? 0.0254 / 38100 : /-METRIC/i.test(head) ? 1 : /-INCH/i.test(head) ? 25.4 : 0.0254;
  const mm = (v: string | number) => Number(v) * U;
  const tok = (l: string) => l.trim().split(/\s+/).filter(Boolean);
  // split into sections
  const sec = new Map<string, string[][]>();
  let cur = '';
  const blocks: { name: string; lines: string[] }[] = [];
  for (const l of lines.slice(1)) {
    const m = /^\*([A-Z]+)\*/.exec(l);
    if (m && m[1] !== 'SIGNAL' && m[1] !== 'REMARK') { cur = m[1]; blocks.push({ name: cur, lines: [] }); continue; }
    if (/^\*REMARK\*/.test(l)) continue;
    if (blocks.length) blocks[blocks.length - 1].lines.push(l);
  }
  for (const b of blocks) { const a = sec.get(b.name) ?? []; a.push(b.lines); sec.set(b.name, a); }
  const S = (n: string) => (sec.get(n) ?? []).flat();

  // ---- layers
  let maxLayer = 2;
  for (const l of S('PCB')) { const t = tok(l); if (t[0] === 'MAXIMUMLAYER') maxLayer = Number(t[1]) || 2; }
  interface LD { name: string; plane: boolean; cu?: number; diel?: number; er?: number; nets: string[] }
  const ld = new Map<number, LD>();
  {
    const misc = S('MISC');
    let i = misc.findIndex((l) => /^LAYER DATA/.test(l.trim()));
    if (i >= 0) {
      let depth = 0, layer = -1, d: LD | null = null;
      for (i++; i < misc.length; i++) {
        const l = misc[i].trim();
        if (l === '{') { depth++; continue; }
        if (l === '}') { depth--; if (depth === 1 && d && layer >= 0) { ld.set(layer, d); d = null; } if (depth <= 0) break; continue; }
        const t = tok(l);
        if (depth === 1 && t[0] === 'LAYER') { layer = Number(t[1]); d = { name: `L${layer}`, plane: false, nets: [] }; continue; }
        if (!d || depth !== 2) continue;
        if (t[0] === 'LAYER_NAME') d.name = t.slice(1).join(' ');
        else if (t[0] === 'PLANE') d.plane = t[1] === 'CAM';
        else if (t[0] === 'LAYER_TYPE' && t[1] === 'PLANE') d.plane = true;
        else if (t[0] === 'COPPER_THICKNESS') d.cu = mm(t[1]);
        else if (t[0] === 'LAYER_THICKNESS') d.diel = mm(t[1]);
        else if (t[0] === 'DIELECTRIC') d.er = Number(t[1]);
        else if (t[0] === 'NET') d.nets.push(t.slice(1).join(' '));
      }
    }
  }
  const L = Math.max(2, maxLayer);
  const obName = (n: number) => (n === 1 ? 'F.Cu' : n === L ? 'B.Cu' : `In${n - 1}.Cu`);
  const p = newProject(name, 2);
  p.layers = Array.from({ length: L }, (_, k) => {
    const n = k + 1, d = ld.get(n);
    // LAYER_THICKNESS of layer n is the dielectric above it in PADS' stack; use the next layer's as the one below
    const below = ld.get(n + 1)?.diel;
    return { name: obName(n), type: d?.plane ? 'power' as const : 'signal' as const, color: LAYER_COLORS[k % LAYER_COLORS.length], direction: k % 2 === 0 ? 'horizontal' as const : 'vertical' as const, visible: true, ...(d?.cu ? { copper: Math.round(d.cu * 10000) / 10000 } : {}), ...(n < L && below ? { dielectric: Math.round(below * 10000) / 10000 } : {}), ...(d?.er ? { er: d.er } : {}) };
  });
  const layerOf = (n: number) => (n >= 1 && n <= L ? obName(n) : undefined);

  // ---- lines: board outline, keepouts
  {
    const ls = S('LINES');
    for (let i = 0; i < ls.length; i++) {
      const t = tok(ls[i]); if (t.length < 5 || !/^[A-Z]+$/.test(t[1] ?? '')) continue;
      const type = t[1], x0 = Number(t[2]), y0 = Number(t[3]), pieces = Number(t[4]), texts = Number(t[5] ?? 0);
      let j = i + 1;
      const polys: Pt[][] = [];
      for (let k = 0; k < pieces && j < ls.length; k++) {
        const ph = tok(ls[j]); const corners = Number(ph[1]); j++;
        const pts: Pt[] = [];
        for (let c = 0; c < corners && j < ls.length; c++, j++) { const q = tok(ls[j]); pts.push({ x: mm(x0 + Number(q[0])), y: mm(y0 + Number(q[1])) }); }
        polys.push(pts);
      }
      j += texts * 3;
      if (type === 'BOARD' && polys[0]?.length >= 3) { const o = polys[0].slice(); if (o.length > 3 && Math.hypot(o[0].x - o[o.length - 1].x, o[0].y - o[o.length - 1].y) < 1e-6) o.pop(); p.outline = o; }
      i = j - 1;
    }
  }

  // ---- vias
  const vias = new Map<string, ViaDef>();
  {
    const vs = S('VIA');
    for (let i = 0; i < vs.length; i++) {
      const t = tok(vs[i]); if (t.length < 3 || !/^[-\d]/.test(t[1]) || /^[-\d]/.test(t[0])) continue;
      const n = Number(t[2]); const v: ViaDef = { name: t[0], drill: mm(t[1]), size: 0, ...(t[3] ? { from: Number(t[3]), to: Number(t[4]) } : {}) };
      for (let k = 1; k <= n; k++) { const q = tok(vs[i + k] ?? ''); if (q[0] === '-2' || (q[0] === '-1' && !v.size)) v.size = Math.max(v.size, mm(q[1])); }
      vias.set(v.name, v); i += n;
    }
  }

  // ---- decals
  const decals = new Map<string, Decal>();
  {
    const ds = S('PARTDECAL');
    for (let i = 0; i < ds.length; i++) {
      const t = tok(ds[i]);
      if (t.length !== 9 || !/^[IMUN]/.test(t[1]) || !t.slice(2).every((x) => /^-?\d+(\.\d+)?$/.test(x))) continue;
      const [nm] = t; const pieces = Number(t[4]), terms = Number(t[5]), stacks = Number(t[6]), texts = Number(t[7]), labels = Number(t[8]);
      const ox = Number(t[2]), oy = Number(t[3]);
      const dc: Decal = { name: nm, terms: [], stacks: new Map(), outline: [] };
      let j = i + 1;
      for (let k = 0; k < pieces && j < ds.length; k++) {
        const ph = tok(ds[j]); const type = ph[0], corners = Number(ph[1]), level = Number(ph[3]); j++;
        const pts: Pt[] = [];
        for (let c = 0; c < corners && j < ds.length; c++, j++) { const q = tok(ds[j]); pts.push({ x: mm(Number(q[0]) - ox), y: mm(Number(q[1]) - oy) }); }
        const silk = (type === 'OPEN' || type === 'CLOSED' || type === 'CIRCLE') && (level <= 2 || level === 26 || level === 29);
        if (silk && type === 'CIRCLE' && pts.length >= 2) { const c = { x: (pts[0].x + pts[1].x) / 2, y: (pts[0].y + pts[1].y) / 2 }, r = Math.hypot(pts[0].x - c.x, pts[0].y - c.y); dc.outline.push(Array.from({ length: 25 }, (_, a) => ({ x: c.x + r * Math.cos((a * Math.PI) / 12), y: c.y + r * Math.sin((a * Math.PI) / 12) }))); }
        else if (silk && pts.length >= 2) dc.outline.push(type === 'CLOSED' ? [...pts, pts[0]] : pts);
      }
      j += texts * 3 + labels * 3;
      for (let k = 0; k < terms && j < ds.length; k++, j++) {
        const l = ds[j].trim(); if (!l.startsWith('T')) { k--; continue; }
        const q = tok(l.slice(1)); dc.terms.push({ x: mm(Number(q[0]) - ox), y: mm(Number(q[1]) - oy), pin: q[4] ?? String(k + 1) });
      }
      for (let k = 0; k < stacks && j < ds.length; k++) {
        while (j < ds.length && !/^PAD\s/.test(ds[j].trim())) j++;
        const ph = tok(ds[j] ?? ''); const pin = ph[1], n = Number(ph[2]); j++;
        let st: { size: number; shape: string; drill: number; plated: boolean; w: number; h: number; ori: number } | null = null;
        let drill = 0, plated = true;
        for (let c = 0; c < n && j < ds.length; c++, j++) {
          const q = tok(ds[j]); const level = Number(q[0]), size = mm(q[1]), shape = q[2] ?? 'R';
          // round/square/annular: LEVEL SIZE SHAPE [IDIA DRILL [PLATED]]; finger: LEVEL SIZE SHAPE ORI LENGTH OFFSET [DRILL [PLATED]]
          const finger = /F$/.test(shape) || shape === 'RT' || shape === 'ST';
          if (finger) { if (q[6] !== undefined && Number(q[6]) > 0) drill = mm(q[6]); if (q[7] === 'N') plated = false; } else { if (q[4] !== undefined && Number(q[4]) > 0) drill = mm(q[4]); if (q[5] === 'N') plated = false; }
          if (level === -2 || (!st && level === 0)) {
            const ori = finger ? Number(q[3]) || 0 : 0;
            let w = size, h = size;
            if (finger) { const lenF = mm(q[4] ?? 0); if (lenF > 0) { w = lenF; h = size; } }
            if (size > 0 || !st) st = { size, shape, drill: 0, plated: true, w, h, ori };
          }
        }
        if (st) { st.drill = drill; st.plated = plated; dc.stacks.set(pin, st); }
      }
      decals.set(nm, dc);
      i = j - 1;
    }
  }

  // ---- part types
  // header: NAME DECALNM TYPE GATES SIGPINS PINNAMES FLAGS ECO; then gates, SIGPIN lines and PINNAMES pin names
  // (terminal i of the decal is pin name i: BGA balls A1, B2 ...)
  const ptype = new Map<string, string[]>();
  const pinNames = new Map<string, string[]>();
  {
    let curT = '', want = 0, names: string[] = [];
    for (const l of S('PARTTYPE')) {
      const t = tok(l); if (!t.length) continue;
      if (t.length === 8 && /^[A-Z]+$/.test(t[2]) && /^[YN]$/.test(t[7]) && /^\d+$/.test(t[5])) {
        if (curT && names.length) pinNames.set(curT, names.slice(-want));
        curT = t[0]; want = Number(t[5]); names = []; ptype.set(t[0], t[1].split(':')); continue;
      }
      if (!curT || t[0] === 'G' || t[0] === 'SIGPIN' || t.some((x) => x.includes('.'))) continue;
      names.push(...t);
    }
    if (curT && names.length) pinNames.set(curT, names.slice(-want));
  }

  // ---- parts
  const lib: Record<string, true> = {};
  {
    const ps = S('PART');
    for (let i = 0; i < ps.length; i++) {
      const t = tok(ps[i]);
      if (t.length < 7 || !/^-?\d+(\.\d+)?$/.test(t[2]) || !/^-?\d+(\.\d+)?$/.test(t[3]) || !/^[UG]$/.test(t[5] ?? '')) continue;
      const ref = t[0];
      const [ptn, decalName] = t[1].split('@');
      const alt = Number(t[7] ?? 0);
      const dname = decalName ?? (ptype.get(ptn)?.[alt] ?? ptype.get(ptn)?.[0] ?? ptn);
      const dc = decals.get(dname);
      const labels = Number(t[11] ?? 0);
      i += labels * 3;
      if (!dc) continue;
      const back = t[6] === 'M' || t[6] === 'Y';
      const pn = pinNames.get(ptn);
      const pads: Pad[] = dc.terms.map((tm, k) => {
        const st = dc.stacks.get(tm.pin) ?? dc.stacks.get(String(k + 1)) ?? dc.stacks.get('0');
        const th = !!st && st.drill > 0;
        let w = st?.w || st?.size || 0.3, h = st?.h || st?.size || 0.3;
        const o = (((st?.ori ?? 0) % 180) + 180) % 180; if (Math.abs(o - 90) < 1e-6) [w, h] = [h, w];
        const shape: Pad['shape'] = st && (st.shape === 'R' || st.shape === 'A') ? 'circle' : st && st.shape === 'OF' ? 'oval' : 'rect';
        return { id: pn && pn.length === dc.terms.length ? pn[k] : tm.pin, x: Math.round(tm.x * 1e5) / 1e5, y: Math.round(tm.y * 1e5) / 1e5, w, h, shape, th, ...(th ? { drill: st!.drill } : {}), ...(th && st && !st.plated ? { npth: true } : {}) };
      });
      const fkey = pn ? `${dname}@${ptn}` : dname;
      if (!lib[fkey]) {
        let bw = 1, bh = 1; for (const pd of pads) { bw = Math.max(bw, Math.abs(pd.x) * 2 + pd.w); bh = Math.max(bh, Math.abs(pd.y) * 2 + pd.h); }
        p.footprints[fkey] = { name: fkey, pads, outline: dc.outline, body: { w: bw, h: bh }, outlineKind: 'silk' };
        lib[fkey] = true;
      }
      // PADS rotation is counter-clockwise; a mirrored (bottom) part is flipped about its y axis
      p.components.push({ ref, footprint: fkey, value: ptn, x: mm(t[2]), y: mm(t[3]), rot: ((Number(t[4]) % 360) + 360) % 360, side: back ? 'back' : 'front' });
    }
  }

  // ---- nets and routes
  const pinsOf = new Map<string, Set<string>>();
  const addPin = (net: string, rp: string) => { const i = rp.lastIndexOf('.'); if (i <= 0) return; const s = pinsOf.get(net) ?? new Set(); s.add(`${rp.slice(0, i)}-${rp.slice(i + 1)}`); pinsOf.set(net, s); };
  for (const secName of ['NET', 'ROUTE']) {
    const raw = (sec.get(secName) ?? []);
    for (const blk of raw) {
      let net = '';
      let pts: { x: number; y: number; layer: number; width: number; via?: string }[] = [];
      const flush = () => {
        for (let k = 0; k + 1 < pts.length; k++) {
          const a = pts[k], b = pts[k + 1];
          const l = layerOf(a.layer);
          if (l && a.width > 0 && (a.x !== b.x || a.y !== b.y)) p.traces.push({ id: nextId(p), net, layer: l, width: mm(a.width), points: [{ x: mm(a.x), y: mm(a.y) }, { x: mm(b.x), y: mm(b.y) }] });
        }
        for (const q of pts) if (q.via) {
          const v = vias.get(q.via); if (!v) continue;
          const span = v.from && v.to && !(v.from === 1 && v.to === L) ? { from: layerOf(v.from), to: layerOf(v.to) } : {};
          if (!p.vias.some((x) => Math.abs(x.x - mm(q.x)) < 1e-6 && Math.abs(x.y - mm(q.y)) < 1e-6 && x.net === net)) p.vias.push({ id: nextId(p), net, x: mm(q.x), y: mm(q.y), diameter: v.size || p.rules.viaDiameter, drill: v.drill || p.rules.viaDrill, ...(span.from && span.to ? span : {}) });
        }
        pts = [];
      };
      for (const l of blk) {
        const sm = /^\*SIGNAL\*\s+(\S+)/.exec(l.trim());
        if (sm) { flush(); net = sm[1]; continue; }
        const t = tok(l); if (!t.length || !net) continue;
        if (t.every((x) => /\S\.\S/.test(x))) { flush(); for (const x of t) addPin(net, x); continue; }   // pin pair(s)
        if (/^-?\d+$/.test(t[0]) && /^-?\d+$/.test(t[1]) && /^\d+$/.test(t[2] ?? '')) {
          const via = t.slice(5).find((x) => vias.has(x));
          pts.push({ x: Number(t[0]), y: Number(t[1]), layer: Number(t[2]), width: Number(t[3]), ...(via ? { via } : {}) });
        }
      }
      flush();
    }
  }
  for (const [n, pins] of pinsOf) p.nets.push({ name: n, pins: [...pins] });

  // ---- pours
  {
    const ps = S('POUR');
    for (let i = 0; i < ps.length; i++) {
      const t = tok(ps[i]); if (t[1] !== 'POUROUT') continue;
      const x0 = Number(t[2]), y0 = Number(t[3]), pieces = Number(t[4]), net = t[7] ?? '';
      let j = i + 1;
      for (let k = 0; k < pieces && j < ps.length; k++) {
        const ph = tok(ps[j]); const corners = Number(ph[1]), arcs = Number(ph[2]), level = Number(ph[4]); j++;
        const pts: Pt[] = [];
        for (let c = 0; c < corners + arcs && j < ps.length; c++, j++) { const q = tok(ps[j]); if (q.length >= 2) pts.push({ x: mm(x0 + Number(q[0])), y: mm(y0 + Number(q[1])) }); }
        if (pts.length > 3 && Math.hypot(pts[0].x - pts[pts.length - 1].x, pts[0].y - pts[pts.length - 1].y) < 1e-6) pts.pop();
        const l = layerOf(level); if (l && pts.length >= 3) p.zones.push({ id: nextId(p), net, layer: l, points: pts, clearance: p.rules.clearance, dynamic: true });
      }
      i = j - 1;
    }
  }
  // plane layers carry their nets as pours over the whole board
  for (const [n, d] of ld) if (d.plane && d.nets.length && layerOf(n)) for (const net of d.nets.slice(0, 1)) if (!p.zones.some((z) => z.layer === layerOf(n))) p.zones.push({ id: nextId(p), net, layer: layerOf(n)!, points: p.outline.slice(), clearance: p.rules.clearance, dynamic: true });
  // design rules: the first (default) rule set of the *MISC* RULES_SECTION
  {
    const misc = S('MISC');
    const i = misc.findIndex((l) => /^RULE_SET \(1\)/.test(l.trim()));
    if (i >= 0) for (let k = i + 1; k < misc.length && !/^RULE_SET \(2\)/.test(misc[k].trim()); k++) {
      const t = tok(misc[k]); const v = mm(t[1] ?? 0);
      if (!(v > 0)) continue;
      if (t[0] === 'TRACK_TO_TRACK') p.rules.clearance = Math.round(v * 10000) / 10000;
      else if (t[0] === 'REC_TRACK_WIDTH') p.rules.width = Math.round(v * 10000) / 10000;
      else if (t[0] === 'MIN_TRACK_WIDTH') p.rules.minTrackWidth = Math.round(v * 10000) / 10000;
      else if (t[0] === 'DRILL_TO_TRACK' || t[0] === 'DRILL_TO_PAD') p.rules.holeToCopper = Math.min(p.rules.holeToCopper, Math.round(v * 10000) / 10000);
      else if (t[0] === 'DRILL_TO_DRILL') p.rules.holeToHole = Math.round(v * 10000) / 10000;
    }
  }
  const totalH = p.layers.reduce((a, l, i) => a + (l.copper ?? 0.035) + (i < L - 1 ? l.dielectric ?? 0 : 0), 0);
  if (totalH > 0.2) p.rules.viaLength = Math.round(totalH * 1000) / 1000;
  return p;
}
