/** SVG (one page) and PDF (all pages, vector) output of a design. */
import { type Design, PAGE_SIZES, allPages } from './model.js';
import { pagePrims, autoJunctions, type Prim } from './render.js';

const arcPts = (c: { x: number; y: number }, r: number, a0: number, a1: number) => { const out = []; let b = a1; while (b < a0) b += 360; const n = Math.max(4, Math.ceil((b - a0) / 10)); for (let k = 0; k <= n; k++) { const a = ((a0 + ((b - a0) * k) / n) * Math.PI) / 180; out.push({ x: c.x + r * Math.cos(a), y: c.y - r * Math.sin(a) }); } return out; };
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export function pageSvg(d: Design, schName: string, pageName: string, opts: { scale?: number } = {}): string {
  const page = d.schematics.find((s) => s.name === schName)?.pages.find((p) => p.name === pageName);
  if (!page) throw new Error(`no page ${schName}/${pageName}`);
  const S = PAGE_SIZES[page.size], k = opts.scale ?? 0.1;
  const prims = pagePrims(d, page);
  for (const j of autoJunctions(page)) prims.push({ t: 'circle', c0: j, r: 25, w: 0, c: '#1a7f1a', fill: true });
  const body = prims.map((p) => svgPrim(p)).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${(S.w * k).toFixed(0)}" height="${(S.h * k).toFixed(0)}" viewBox="0 0 ${S.w} ${S.h}" font-family="Arial, sans-serif"><rect width="100%" height="100%" fill="#fff"/>${body}</svg>`;
}
function svgPrim(p: Prim): string {
  switch (p.t) {
    case 'line': return `<polyline points="${p.pts.map((q) => `${q.x},${q.y}`).join(' ')}" fill="none" stroke="${p.c}" stroke-width="${p.w}" stroke-linecap="round" stroke-linejoin="round"/>`;
    case 'poly': return `<polygon points="${p.pts.map((q) => `${q.x},${q.y}`).join(' ')}" fill="${p.fill ? p.c : 'none'}" stroke="${p.c}" stroke-width="${p.w}"/>`;
    case 'circle': return `<circle cx="${p.c0.x}" cy="${p.c0.y}" r="${p.r}" fill="${p.fill ? p.c : 'none'}" stroke="${p.c}" stroke-width="${p.w}"/>`;
    case 'arc': return `<polyline points="${arcPts(p.c0, p.r, p.a0, p.a1).map((q) => `${q.x.toFixed(1)},${q.y.toFixed(1)}`).join(' ')}" fill="none" stroke="${p.c}" stroke-width="${p.w}"/>`;
    case 'text': return `<text x="${p.at.x}" y="${p.at.y}" font-size="${p.size}" fill="${p.c}" text-anchor="${p.anchor}"${p.bold ? ' font-weight="bold"' : ''}${p.rot ? ` transform="rotate(${-p.rot} ${p.at.x} ${p.at.y})"` : ''}>${esc(p.s)}</text>`;
  }
}

/** Multi-page vector PDF (Helvetica); bytes. */
export function designPdf(d: Design): Uint8Array {
  const objs: string[] = [];
  const add = (s: string) => { objs.push(s); return objs.length; };
  const font = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
  const fontB = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>');
  const pagesId = objs.length + 1; objs.push(''); // placeholder for Pages
  const kids: number[] = [];
  const rgb = (c: string) => { const h = c.replace('#', ''); const v = h.length === 3 ? h.split('').map((x) => parseInt(x + x, 16)) : [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)); return v.map((x) => (x / 255).toFixed(3)).join(' '); };
  for (const { sch, page } of allPages(d)) {
    const S = PAGE_SIZES[page.size], k = 0.072;   // mils -> points
    const W = S.w * k, H = S.h * k;
    const X = (x: number) => (x * k).toFixed(2), Y = (y: number) => (H - y * k).toFixed(2);
    const prims = pagePrims(d, page);
    for (const j of autoJunctions(page)) prims.push({ t: 'circle', c0: j, r: 25, w: 0, c: '#1a7f1a', fill: true });
    const ops: string[] = ['1 J 1 j'];
    for (const p of prims) {
      if (p.t === 'text') {
        const a = ((p.rot ?? 0) * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a), sz = p.size * k * 1.4;
        const w = p.s.length * sz * 0.5, dx = p.anchor === 'middle' ? -w / 2 : p.anchor === 'end' ? -w : 0;
        const tx = p.at.x * k + dx * c, ty = H - p.at.y * k + dx * s;
        ops.push(`BT /${p.bold ? 'F2' : 'F1'} ${sz.toFixed(2)} Tf ${rgb(p.c)} rg ${c.toFixed(4)} ${s.toFixed(4)} ${(-s).toFixed(4)} ${c.toFixed(4)} ${tx.toFixed(2)} ${ty.toFixed(2)} Tm (${p.s.replace(/[\\()]/g, (m) => '\\' + m).replace(/[^\x20-\x7e]/g, '?')}) Tj ET`);
        continue;
      }
      ops.push(`${rgb(p.c)} RG ${rgb(p.c)} rg ${Math.max(0.2, p.w * k).toFixed(2)} w`);
      const path = (pts: { x: number; y: number }[], close: boolean) => pts.map((q, i) => `${X(q.x)} ${Y(q.y)} ${i ? 'l' : 'm'}`).join(' ') + (close ? ' h' : '');
      if (p.t === 'line') ops.push(`${path(p.pts, false)} S`);
      else if (p.t === 'poly') ops.push(`${path(p.pts, true)} ${p.fill ? 'B' : 'S'}`);
      else if (p.t === 'circle') ops.push(`${path(arcPts(p.c0, p.r, 0, 360), true)} ${p.fill ? 'f' : 'S'}`);
      else if (p.t === 'arc') ops.push(`${path(arcPts(p.c0, p.r, p.a0, p.a1), false)} S`);
    }
    const stream = ops.join('\n');
    const content = add(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
    kids.push(add(`<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 ${W.toFixed(1)} ${H.toFixed(1)}] /Resources << /Font << /F1 ${font} 0 R /F2 ${fontB} 0 R >> >> /Contents ${content} 0 R >>`));
    void sch;
  }
  objs[pagesId - 1] = `<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(' ')}] /Count ${kids.length} >>`;
  const catalog = add(`<< /Type /Catalog /Pages ${pagesId} 0 R >>`);
  let pdf = '%PDF-1.4\n%\xe2\xe3\xcf\xd3\n';
  const offs: number[] = [];
  objs.forEach((o, i) => { offs.push(pdf.length); pdf += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = pdf.length;
  pdf += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offs.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objs.length + 1} /Root ${catalog} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  const bytes = new Uint8Array(pdf.length); for (let i = 0; i < pdf.length; i++) bytes[i] = pdf.charCodeAt(i) & 0xff;
  return bytes;
}
