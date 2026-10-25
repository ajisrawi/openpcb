/** Canvas renderer for the board. World units = mm, Y axis up (flipped at draw time). */
import { padInstances } from './connectivity.js';
import { type Project, type Pt, padToBoard, padLayers, netOfPin, padAngle } from './model.js';
import { defaultLibrary } from './footprints.js';
import type { RatLine, DrcMarker } from './connectivity.js';
import { textStrokes, dimensionStrokes } from './fab.js';

export interface ViewState {
  activeLayer: string;
  selectedRefs: Set<string>;
  selectedTraces: Set<number>;
  selectedVias: Set<number>;
  hoverRef?: string;
  preview?: { layer: string; width: number; points: Pt[]; cursor?: Pt };
  rats: RatLine[];
  drc: DrcMarker[];
  showRats: boolean;
  showDrc: boolean;
  showRefs: boolean;
  highlightNet?: string;
  cursor?: Pt;
  measure?: { a: Pt; b?: Pt };       // measure tool: first point, and the second once picked (or the cursor)
  selectedTexts?: Set<number>;
  collab?: { partitions: { rect: { x1: number; y1: number; x2: number; y2: number }; owner: string; color: string; mine: boolean }[]; cursors: { user: string; color: string; x: number; y: number }[] };
}

export class View {
  scale = 8;               // px per mm
  tx = 40; ty = 40;        // screen offset of world origin (px); y flipped
  private ctx: CanvasRenderingContext2D;
  constructor(readonly canvas: HTMLCanvasElement) { this.ctx = canvas.getContext('2d')!; }

  toScreen(p: Pt): Pt { return { x: this.tx + p.x * this.scale, y: this.canvas.height - (this.ty + p.y * this.scale) }; }
  toWorld(s: Pt): Pt { return { x: (s.x - this.tx) / this.scale, y: (this.canvas.height - s.y - this.ty) / this.scale }; }
  zoomAt(s: Pt, factor: number): void {
    const w = this.toWorld(s);
    this.scale = Math.min(400, Math.max(0.5, this.scale * factor));
    const s2 = this.toScreen(w);
    this.tx += s.x - s2.x; this.ty -= s.y - s2.y;
  }
  fit(p: Project): void {
    const xs = p.outline.map((q) => q.x), ys = p.outline.map((q) => q.y);
    const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
    const w = this.canvas.width, h = this.canvas.height;
    this.scale = Math.min((w - 80) / Math.max(1, maxX - minX), (h - 80) / Math.max(1, maxY - minY));
    this.tx = (w - (maxX + minX) * this.scale) / 2;
    this.ty = (h - (maxY + minY) * this.scale) / 2;
  }

  render(p: Project, st: ViewState): void {
    const ctx = this.ctx, W = this.canvas.width, H = this.canvas.height;
    ctx.save();
    ctx.fillStyle = '#101418'; ctx.fillRect(0, 0, W, H);
    this.drawGrid();
    // outline fill
    ctx.beginPath();
    p.outline.forEach((q, i) => { const s = this.toScreen(q); i ? ctx.lineTo(s.x, s.y) : ctx.moveTo(s.x, s.y); });
    ctx.closePath(); ctx.fillStyle = '#1b2a1f'; ctx.fill(); ctx.strokeStyle = '#d9d26b'; ctx.lineWidth = 1.5; ctx.stroke();
    // keepouts
    for (const k of p.keepouts) {
      const a = this.toScreen({ x: k.rect.x1, y: k.rect.y1 }), b = this.toScreen({ x: k.rect.x2, y: k.rect.y2 });
      ctx.fillStyle = 'rgba(255,80,80,0.15)'; ctx.strokeStyle = 'rgba(255,80,80,0.7)'; ctx.lineWidth = 1;
      ctx.fillRect(Math.min(a.x, b.x), Math.min(a.y, b.y), Math.abs(b.x - a.x), Math.abs(b.y - a.y)); ctx.strokeRect(Math.min(a.x, b.x), Math.min(a.y, b.y), Math.abs(b.x - a.x), Math.abs(b.y - a.y));
    }
    // zones (copper pours): hatched fill in the layer colour
    for (const z of p.zones) {
      if (z.points.length < 3) continue;
      const col = p.layers.find((l) => l.name === z.layer)?.color ?? '#888';
      ctx.beginPath(); z.points.forEach((q, i) => { const s = this.toScreen(q); i ? ctx.lineTo(s.x, s.y) : ctx.moveTo(s.x, s.y); }); ctx.closePath();
      ctx.fillStyle = col; ctx.globalAlpha = z.layer === st.activeLayer ? 0.18 : 0.08; ctx.fill(); ctx.globalAlpha = 1;
      ctx.strokeStyle = col; ctx.lineWidth = 1; ctx.setLineDash(z.dynamic ? [6, 4] : []); ctx.stroke(); ctx.setLineDash([]);
      if (this.scale > 2) { const s = this.toScreen(z.points[0]); ctx.fillStyle = col; ctx.font = '11px sans-serif'; ctx.textAlign = 'left'; ctx.textBaseline = 'top'; ctx.fillText(`${z.net} ${z.dynamic ? '(pour)' : '(static)'}`, s.x + 4, s.y + 2); }
    }
    const lib = { ...defaultLibrary(), ...p.footprints };
    const layerColor = new Map(p.layers.map((l) => [l.name, l.color]));
    const visible = new Set(p.layers.filter((l) => l.visible).map((l) => l.name));
    // draw order: inactive layers first (dim), active layer last
    const order = p.layers.map((l) => l.name).filter((n) => n !== st.activeLayer).concat(st.activeLayer);
    for (const layer of order) {
      if (!visible.has(layer)) continue;
      const active = layer === st.activeLayer;
      const color = layerColor.get(layer) ?? '#fff';
      ctx.globalAlpha = active ? 0.95 : 0.45;
      // traces
      for (const t of p.traces) {
        if (t.layer !== layer) continue;
        const sel = st.selectedTraces.has(t.id) || (st.highlightNet && t.net === st.highlightNet);
        ctx.strokeStyle = sel ? '#ffffff' : color; ctx.lineWidth = Math.max(1, t.width * this.scale); ctx.lineCap = 'round'; ctx.lineJoin = 'round';
        ctx.beginPath(); t.points.forEach((q, i) => { const s = this.toScreen(q); i ? ctx.lineTo(s.x, s.y) : ctx.moveTo(s.x, s.y); }); ctx.stroke();
      }
      // pads on this layer
      for (const c of p.components) {
        const fp = lib[c.footprint]; if (!fp) continue;
        for (const pad of fp.pads) {
          if (!padLayers(p, c, pad).includes(layer)) continue;
          const net = netOfPin(p, c.ref, pad.id);
          const sel = st.selectedRefs.has(c.ref) || (st.highlightNet && net?.name === st.highlightNet);
          this.drawPad(c, pad, sel ? '#ffffff' : color, pad.th ? '#101418' : undefined);
        }
      }
    }
    ctx.globalAlpha = 1;
    // vias
    for (const v of p.vias) {
      const s = this.toScreen({ x: v.x, y: v.y });
      const sel = st.selectedVias.has(v.id) || (st.highlightNet && v.net === st.highlightNet);
      ctx.beginPath(); ctx.arc(s.x, s.y, (v.diameter / 2) * this.scale, 0, Math.PI * 2); ctx.fillStyle = sel ? '#fff' : '#c9c9c9'; ctx.fill();
      ctx.beginPath(); ctx.arc(s.x, s.y, (v.drill / 2) * this.scale, 0, Math.PI * 2); ctx.fillStyle = '#101418'; ctx.fill();
      if (v.from && v.to) { ctx.setLineDash([2, 2]); ctx.beginPath(); ctx.arc(s.x, s.y, (v.diameter / 2) * this.scale + 2, 0, Math.PI * 2); ctx.strokeStyle = '#ffd36b'; ctx.lineWidth = 1; ctx.stroke(); ctx.setLineDash([]); }
    }
    // outlines + refs
    for (const c of p.components) {
      const fp = lib[c.footprint]; if (!fp) continue;
      const sel = st.selectedRefs.has(c.ref), hov = st.hoverRef === c.ref;
      ctx.strokeStyle = sel ? '#ffffff' : hov ? '#9fd' : c.side === 'front' ? '#b8c7d9' : '#8a7cc2'; ctx.lineWidth = sel ? 2 : 1;
      for (const pl of fp.outline) { ctx.beginPath(); pl.forEach((q, i) => { const s = this.toScreen(padToBoard(c, q)); i ? ctx.lineTo(s.x, s.y) : ctx.moveTo(s.x, s.y); }); ctx.stroke(); }
      if (fp.outline.length === 0) { const s = this.toScreen({ x: c.x, y: c.y }); ctx.beginPath(); ctx.arc(s.x, s.y, 4, 0, Math.PI * 2); ctx.stroke(); }
      if (st.showRefs && this.scale > 2.5) {
        const s = this.toScreen({ x: c.x, y: c.y });
        ctx.fillStyle = sel ? '#fff' : '#e6eef7'; ctx.font = `${Math.max(9, Math.min(16, this.scale * 1.2))}px sans-serif`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillText(c.ref, s.x, s.y);
      }
    }
    // rooms
    for (const rm of p.rooms ?? []) {
      const a = this.toScreen({ x: rm.rect.x1, y: rm.rect.y1 }), b = this.toScreen({ x: rm.rect.x2, y: rm.rect.y2 });
      ctx.strokeStyle = 'rgba(190,140,255,0.8)'; ctx.lineWidth = 1; ctx.setLineDash([8, 4]);
      ctx.strokeRect(Math.min(a.x, b.x), Math.min(a.y, b.y), Math.abs(b.x - a.x), Math.abs(b.y - a.y)); ctx.setLineDash([]);
      ctx.fillStyle = 'rgba(190,140,255,0.9)'; ctx.font = '11px sans-serif'; ctx.textAlign = 'left'; ctx.textBaseline = 'top';
      ctx.fillText(`room ${rm.name} (${rm.refs.length})`, Math.min(a.x, b.x) + 3, Math.min(a.y, b.y) + 2);
    }
    // rigid-flex: flex zones, bend areas (with the axis), stiffeners; ground voids; bond wires
    const poly = (pts: Pt[], stroke: string, dash: number[], fill?: string) => { if (pts.length < 2) return; ctx.beginPath(); pts.forEach((q, i) => { const s = this.toScreen(q); i ? ctx.lineTo(s.x, s.y) : ctx.moveTo(s.x, s.y); }); ctx.closePath(); if (fill) { ctx.fillStyle = fill; ctx.fill(); } ctx.strokeStyle = stroke; ctx.lineWidth = 1.2; ctx.setLineDash(dash); ctx.stroke(); ctx.setLineDash([]); };
    const label = (q: Pt, text: string, color: string) => { if (this.scale < 2) return; const s = this.toScreen(q); ctx.fillStyle = color; ctx.font = '11px sans-serif'; ctx.textAlign = 'left'; ctx.textBaseline = 'top'; ctx.fillText(text, s.x + 3, s.y + 2); };
    for (const z of p.flexZones ?? []) { poly(z.points, 'rgba(80,220,255,0.9)', [10, 4], 'rgba(80,220,255,0.06)'); label(z.points[0], `flex ${z.name} (${z.layers.join(',')})`, 'rgba(80,220,255,0.95)'); }
    for (const b of p.bends ?? []) {
      poly(b.points, 'rgba(255,170,60,0.95)', [4, 3], 'rgba(255,170,60,0.10)');
      const a = this.toScreen(b.axis[0]), c = this.toScreen(b.axis[1]); ctx.strokeStyle = 'rgba(255,170,60,0.95)'; ctx.setLineDash([12, 3, 2, 3]); ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(c.x, c.y); ctx.stroke(); ctx.setLineDash([]);
      label(b.points[0], `bend ${b.name} ${b.angle}° r${b.radius}`, 'rgba(255,170,60,0.95)');
    }
    for (const s of p.stiffeners ?? []) { poly(s.points, 'rgba(170,170,170,0.9)', [2, 2], 'rgba(170,170,170,0.08)'); label(s.points[0], `stiffener ${s.material} ${s.thickness} (${s.side})`, '#bbb'); }
    for (const v of p.voids ?? []) if (v.layer === st.activeLayer || !layerColor.get(v.layer)) poly(v.points, 'rgba(255,90,90,0.8)', [3, 3]);
    if ((p.bondWires ?? []).length) {
      const pads = padInstances(p); const at = new Map(pads.map((pd) => [`${pd.ref}-${pd.padId}`, pd.center]));
      ctx.strokeStyle = 'rgba(255,205,60,0.95)'; ctx.lineWidth = Math.max(1, 0.025 * this.scale);
      for (const w of p.bondWires ?? []) {
        const a = at.get(`${w.from.ref}-${w.from.pad}`); const b = 'ref' in w.to ? at.get(`${w.to.ref}-${w.to.pad}`) : { x: w.to.x, y: w.to.y };
        if (!a || !b) continue; const sa = this.toScreen(a), sb = this.toScreen(b);
        ctx.beginPath(); ctx.moveTo(sa.x, sa.y); ctx.lineTo(sb.x, sb.y); ctx.stroke();
      }
    }
    // collaboration: partitions (others' are hatched red) and the other users' cursors
    if (st.collab) {
      for (const pt of st.collab.partitions) { const r = pt.rect; poly([{ x: r.x1, y: r.y1 }, { x: r.x2, y: r.y1 }, { x: r.x2, y: r.y2 }, { x: r.x1, y: r.y2 }], pt.color, pt.mine ? [6, 3] : [2, 2], pt.mine ? undefined : 'rgba(255,60,60,0.07)'); label({ x: Math.min(r.x1, r.x2), y: Math.max(r.y1, r.y2) }, `partition: ${pt.owner}`, pt.color); }
      for (const c of st.collab.cursors) { const s = this.toScreen(c); ctx.fillStyle = c.color; ctx.beginPath(); ctx.moveTo(s.x, s.y); ctx.lineTo(s.x + 12, s.y + 5); ctx.lineTo(s.x + 5, s.y + 12); ctx.closePath(); ctx.fill(); ctx.font = '11px sans-serif'; ctx.textAlign = 'left'; ctx.textBaseline = 'top'; ctx.fillText(c.user, s.x + 12, s.y + 10); }
    }
    // text and dimensions (stroke font, as written to the Gerbers)
    const strokeAll = (strokes: Pt[][], color: string, w: number) => { ctx.strokeStyle = color; ctx.lineWidth = Math.max(1, w * this.scale); ctx.lineCap = 'round'; for (const s of strokes) { ctx.beginPath(); s.forEach((q, i) => { const sc = this.toScreen(q); i ? ctx.lineTo(sc.x, sc.y) : ctx.moveTo(sc.x, sc.y); }); ctx.stroke(); } };
    for (const tx of p.texts ?? []) {
      const sel = st.selectedTexts?.has(tx.id);
      const color = sel ? '#ffffff' : tx.layer === 'B.Silk' ? '#c2a7ff' : tx.layer.endsWith('Silk') ? '#f2f2f2' : tx.layer.includes('Fab') ? '#9ad0ff' : (layerColor.get(tx.layer) ?? '#ddd');
      strokeAll(textStrokes(tx, tx.layer === 'B.Silk'), color, Math.max(0.1, tx.size * 0.12));
    }
    for (const dm of p.dimensions ?? []) strokeAll(dimensionStrokes(dm), '#9ad0ff', 0.12);
    // measure ruler
    if (st.measure) {
      const b = st.measure.b ?? st.cursor;
      if (b) {
        const A = this.toScreen(st.measure.a), B = this.toScreen(b);
        ctx.strokeStyle = '#ffe066'; ctx.lineWidth = 1.5; ctx.setLineDash([5, 3]); ctx.beginPath(); ctx.moveTo(A.x, A.y); ctx.lineTo(B.x, B.y); ctx.stroke(); ctx.setLineDash([]);
        const d = Math.hypot(b.x - st.measure.a.x, b.y - st.measure.a.y);
        ctx.fillStyle = '#ffe066'; ctx.font = '12px sans-serif'; ctx.textAlign = 'left'; ctx.textBaseline = 'bottom';
        ctx.fillText(`${d.toFixed(3)} mm  (dx ${(b.x - st.measure.a.x).toFixed(3)}, dy ${(b.y - st.measure.a.y).toFixed(3)})`, B.x + 8, B.y - 4);
      }
    }
    // ratsnest
    if (st.showRats) {
      ctx.strokeStyle = 'rgba(255,255,255,0.55)'; ctx.lineWidth = 1; ctx.setLineDash([4, 3]);
      for (const r of st.rats) { if (st.highlightNet && r.net !== st.highlightNet) continue; const a = this.toScreen(r.a), b = this.toScreen(r.b); ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke(); }
      ctx.setLineDash([]);
    }
    // preview trace
    if (st.preview && st.preview.points.length) {
      const pv = st.preview; const pts = pv.cursor ? [...pv.points, pv.cursor] : pv.points;
      ctx.strokeStyle = layerColor.get(pv.layer) ?? '#fff'; ctx.globalAlpha = 0.8; ctx.lineWidth = Math.max(1, pv.width * this.scale); ctx.lineCap = 'round'; ctx.lineJoin = 'round';
      ctx.beginPath(); pts.forEach((q, i) => { const s = this.toScreen(q); i ? ctx.lineTo(s.x, s.y) : ctx.moveTo(s.x, s.y); }); ctx.stroke(); ctx.globalAlpha = 1;
    }
    // DRC markers
    if (st.showDrc) {
      for (const m of st.drc) { const s = this.toScreen(m.at); ctx.strokeStyle = '#ff3b3b'; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(s.x, s.y, 7, 0, Math.PI * 2); ctx.stroke(); ctx.beginPath(); ctx.moveTo(s.x - 5, s.y - 5); ctx.lineTo(s.x + 5, s.y + 5); ctx.moveTo(s.x + 5, s.y - 5); ctx.lineTo(s.x - 5, s.y + 5); ctx.stroke(); }
    }
    ctx.restore();
  }

  private drawPad(c: { x: number; y: number; rot: number; side: 'front' | 'back' }, pad: { x: number; y: number; w: number; h: number; shape: string; th: boolean; drill?: number; rot?: number }, color: string, hole?: string): void {
    const ctx = this.ctx;
    const center = this.toScreen(padToBoard(c as never, { x: pad.x, y: pad.y }));
    const rot = padAngle(c, pad);
    ctx.save(); ctx.translate(center.x, center.y); ctx.rotate((-rot * Math.PI) / 180);
    const w = pad.w * this.scale, h = pad.h * this.scale;
    ctx.fillStyle = color;
    if (pad.shape === 'circle') { ctx.beginPath(); ctx.arc(0, 0, w / 2, 0, Math.PI * 2); ctx.fill(); }
    else if (pad.shape === 'oval') { const r = Math.min(w, h) / 2; ctx.beginPath(); (ctx as unknown as { roundRect: (x: number, y: number, w: number, h: number, r: number) => void }).roundRect(-w / 2, -h / 2, w, h, r); ctx.fill(); }
    else ctx.fillRect(-w / 2, -h / 2, w, h);
    if (hole && pad.th) { ctx.fillStyle = hole; ctx.beginPath(); ctx.arc(0, 0, ((pad.drill ?? Math.min(pad.w, pad.h) / 2) / 2) * this.scale, 0, Math.PI * 2); ctx.fill(); }
    ctx.restore();
  }

  private drawGrid(): void {
    const ctx = this.ctx, W = this.canvas.width, H = this.canvas.height;
    const step = this.scale >= 40 ? 1 : this.scale >= 8 ? 5 : this.scale >= 2 ? 10 : 50;   // mm
    const w0 = this.toWorld({ x: 0, y: H }), w1 = this.toWorld({ x: W, y: 0 });
    ctx.strokeStyle = 'rgba(255,255,255,0.06)'; ctx.lineWidth = 1;
    for (let x = Math.floor(w0.x / step) * step; x <= w1.x; x += step) { const s = this.toScreen({ x, y: 0 }); ctx.beginPath(); ctx.moveTo(s.x, 0); ctx.lineTo(s.x, H); ctx.stroke(); }
    for (let y = Math.floor(w0.y / step) * step; y <= w1.y; y += step) { const s = this.toScreen({ x: 0, y }); ctx.beginPath(); ctx.moveTo(0, s.y); ctx.lineTo(W, s.y); ctx.stroke(); }
  }
}
