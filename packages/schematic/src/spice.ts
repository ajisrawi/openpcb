/**
 * Built-in circuit simulator (PSpice counterpart, small): modified nodal analysis of the schematic's SPICE netlist.
 *
 * Elements: R, C, L, V and I sources (DC value, "DC x", "AC mag", SIN(vo va f [td]), PULSE(v1 v2 td tr tf pw per)),
 * D (Shockley diode, Is / n from the Model property "DMOD(IS=..,N=..)" or defaults; LEDs Vf about 1.8 V),
 * Q (Ebers-Moll NPN/PNP), M (square-law MOSFET, Vt / Kp), X op-amp (VCVS gain 1e5, output resistance 50 ohm,
 * clamped to its supply pins). Analyses: operating point (Newton-Raphson with damping and gmin stepping),
 * transient (trapezoidal companion models, fixed step), AC sweep (linearised at the operating point).
 */
import { type Design } from './model.js';
import { spiceNetlist } from './netlist.js';

type Cx = [number, number];
interface El { kind: string; name: string; n: string[]; v: string; model: string }
export interface SimResult { nodes: string[]; op?: Record<string, number>; tran?: { t: number[]; v: Record<string, number[]> }; ac?: { f: number[]; mag: Record<string, number[]>; phase: Record<string, number[]> }; warnings: string[] }

const SI: Record<string, number> = { t: 1e12, g: 1e9, meg: 1e6, k: 1e3, m: 1e-3, u: 1e-6, 'µ': 1e-6, n: 1e-9, p: 1e-12, f: 1e-15 };
export function num(s: string): number {
  const m = /^([-+]?[0-9]*\.?[0-9]+(?:e[-+]?\d+)?)(meg|[tgkmuµnpf])?/i.exec(s.trim()); if (!m) return NaN;
  return Number(m[1]) * (m[2] ? SI[m[2].toLowerCase()] : 1);
}
const params = (s: string) => { const o: Record<string, number> = {}; for (const m of s.matchAll(/(\w+)\s*=\s*([-+0-9.eE]+[a-zA-Zµ]*)/g)) o[m[1].toUpperCase()] = num(m[2]); return o; };

function parse(text: string): El[] {
  const out: El[] = [];
  for (const raw of text.split('\n')) {
    const l = raw.trim(); if (!l || l.startsWith('*') || l.startsWith('.')) continue;
    const tok = l.split(/\s+/); const name = tok[0], k = name[0].toUpperCase();
    const pinsBy: Record<string, number> = { R: 2, C: 2, L: 2, V: 2, I: 2, D: 2, Q: 3, M: 4, X: 5 };
    const np = pinsBy[k] ?? 2;
    out.push({ kind: k, name, n: tok.slice(1, 1 + np), v: tok.slice(1 + np).join(' '), model: tok.slice(1 + np).join(' ') });
  }
  return out;
}

/** Source value at time t (DC / SIN / PULSE). */
function srcAt(v: string, t: number): number {
  const s = v.toUpperCase();
  const sin = /SIN\s*\(([^)]*)\)/.exec(s); if (sin) { const [vo, va, f, td = 0] = sin[1].split(/[\s,]+/).filter(Boolean).map(num); return t < td ? vo : vo + va * Math.sin(2 * Math.PI * f * (t - td)); }
  const pu = /PULSE\s*\(([^)]*)\)/.exec(s);
  if (pu) { const [v1, v2, td = 0, tr = 1e-9, tf = 1e-9, pw = 1e-3, per = 2e-3] = pu[1].split(/[\s,]+/).filter(Boolean).map(num); if (t < td) return v1; const x = (t - td) % per; if (x < tr) return v1 + ((v2 - v1) * x) / tr; if (x < tr + pw) return v2; if (x < tr + pw + tf) return v2 + ((v1 - v2) * (x - tr - pw)) / tf; return v1; }
  const dc = /DC\s+([^\s]+)/.exec(s); if (dc) return num(dc[1]);
  const n = num(s); return Number.isFinite(n) ? n : 0;
}
const acMag = (v: string) => { const m = /AC\s+([^\s]+)/i.exec(v); return m ? num(m[1]) : 0; };

function solve(A: number[][], b: number[]): number[] | null {
  const n = b.length; const M = A.map((r, i) => [...r, b[i]]);
  for (let c = 0; c < n; c++) {
    let p = c; for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    if (Math.abs(M[p][c]) < 1e-30) return null;
    [M[c], M[p]] = [M[p], M[c]];
    for (let r = c + 1; r < n; r++) { const f = M[r][c] / M[c][c]; if (f) for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k]; }
  }
  const x = new Array(n).fill(0);
  for (let r = n - 1; r >= 0; r--) { let s = M[r][n]; for (let k = r + 1; k < n; k++) s -= M[r][k] * x[k]; x[r] = s / M[r][r]; }
  return x;
}
function solveC(A: Cx[][], b: Cx[]): Cx[] | null {
  const n = b.length; const M = A.map((r, i) => [...r.map((z) => [...z] as Cx), [...b[i]] as Cx]);
  const mul = (a: Cx, c: Cx): Cx => [a[0] * c[0] - a[1] * c[1], a[0] * c[1] + a[1] * c[0]], div = (a: Cx, c: Cx): Cx => { const d = c[0] ** 2 + c[1] ** 2; return [(a[0] * c[0] + a[1] * c[1]) / d, (a[1] * c[0] - a[0] * c[1]) / d]; }, ab = (a: Cx) => Math.hypot(a[0], a[1]);
  for (let c = 0; c < n; c++) {
    let p = c; for (let r = c + 1; r < n; r++) if (ab(M[r][c]) > ab(M[p][c])) p = r;
    if (ab(M[p][c]) < 1e-30) return null; [M[c], M[p]] = [M[p], M[c]];
    for (let r = c + 1; r < n; r++) { const f = div(M[r][c], M[c][c]); for (let k = c; k <= n; k++) { const t = mul(f, M[c][k]); M[r][k] = [M[r][k][0] - t[0], M[r][k][1] - t[1]]; } }
  }
  const x: Cx[] = new Array(n).fill(0).map(() => [0, 0]);
  for (let r = n - 1; r >= 0; r--) { let s: Cx = [...M[r][n]] as Cx; for (let k = r + 1; k < n; k++) { const t = mul(M[r][k], x[k]); s = [s[0] - t[0], s[1] - t[1]]; } x[r] = div(s, M[r][r]); }
  return x;
}

export interface SimOptions { op?: boolean; tran?: { step: number; stop: number }; ac?: { fStart: number; fStop: number; points: number /* per decade */ }; probes?: string[]; netlist?: string }

export function simulateNetlist(text: string, opts: SimOptions): SimResult {
  const els = parse(text);
  const warnings: string[] = [];
  const nodeSet = new Set<string>(); for (const e of els) for (const n of e.n) if (n !== '0') nodeSet.add(n);
  const nodes = [...nodeSet]; const ni = new Map(nodes.map((n, i) => [n, i]));
  const branches = els.filter((e) => e.kind === 'V' || e.kind === 'L' || e.kind === 'X');
  const bi = new Map(branches.map((e, i) => [e.name, nodes.length + i]));
  const N = nodes.length + branches.length;
  const idx = (n: string) => (n === '0' ? -1 : ni.get(n)!);
  const VT = 0.025852;
  const dmodel = (e: El) => { const p = params(e.model); const led = /LED/i.test(e.model); return { Is: p.IS ?? (led ? 1e-20 : 1e-14), n: p.N ?? (led ? 1.8 : 1), Rs: p.RS ?? 0 }; };
  /** stamp everything for a Newton step at solution x (or, with ac, the small-signal admittances at x) */
  const build = (x: number[], t: number, mode: 'dc' | 'tran', dt: number, prev: number[] | null, gmin: number) => {
    const A = Array.from({ length: N }, () => new Array(N).fill(0)); const b = new Array(N).fill(0);
    const V = (n: string) => (n === '0' ? 0 : x[idx(n)]);
    const G = (a: string, c: string, g: number) => { const i = idx(a), j = idx(c); if (i >= 0) A[i][i] += g; if (j >= 0) A[j][j] += g; if (i >= 0 && j >= 0) { A[i][j] -= g; A[j][i] -= g; } };
    const I = (a: string, c: string, cur: number) => { const i = idx(a), j = idx(c); if (i >= 0) b[i] -= cur; if (j >= 0) b[j] += cur; };   // current cur flowing a -> c through the element
    for (let i = 0; i < nodes.length; i++) A[i][i] += gmin;
    for (const e of els) {
      const [a, c] = e.n;
      switch (e.kind) {
        case 'R': { const r = num(e.v); G(a, c, 1 / Math.max(1e-6, Number.isFinite(r) ? r : 1e3)); break; }
        case 'C': { const C = num(e.v); if (mode === 'tran' && prev) { const g = (2 * C) / dt; const vp = (a === '0' ? 0 : prev[idx(a)]) - (c === '0' ? 0 : prev[idx(c)]); const ip = capI.get(e.name) ?? 0; G(a, c, g); I(a, c, -(g * vp + ip)); } else G(a, c, 1e-12); break; }
        case 'L': { const k = bi.get(e.name)!, L = num(e.v), i = idx(a), j = idx(c); if (i >= 0) { A[i][k] += 1; A[k][i] += 1; } if (j >= 0) { A[j][k] -= 1; A[k][j] -= 1; } if (mode === 'tran' && prev) { const R = (2 * L) / dt; A[k][k] -= R; const vp = (a === '0' ? 0 : prev[idx(a)]) - (c === '0' ? 0 : prev[idx(c)]); b[k] += -R * prev[k] - vp; } break; }
        case 'V': { const k = bi.get(e.name)!, i = idx(a), j = idx(c); if (i >= 0) { A[i][k] += 1; A[k][i] += 1; } if (j >= 0) { A[j][k] -= 1; A[k][j] -= 1; } b[k] += srcAt(e.v, t); break; }
        case 'I': I(a, c, srcAt(e.v, t)); break;
        case 'D': {
          const { Is, n } = dmodel(e); const vd = Math.min(V(a) - V(c), 1.2 * n);
          const ex = Math.exp(vd / (n * VT)); const id = Is * (ex - 1), gd = (Is * ex) / (n * VT) + 1e-12;
          G(a, c, gd); I(a, c, id - gd * vd); break;
        }
        case 'Q': {
          const [cn, bn, en] = e.n; const pnp = /PNP/i.test(e.model); const s = pnp ? -1 : 1; const p = params(e.model);
          const Is = p.IS ?? 1e-15, bf = p.BF ?? 100, br = p.BR ?? 1;
          const vbe = Math.min(s * (V(bn) - V(en)), 0.9), vbc = Math.min(s * (V(bn) - V(cn)), 0.9);
          const ef = Math.exp(vbe / VT), er = Math.exp(vbc / VT);
          const If = Is * (ef - 1), Ir = Is * (er - 1);
          const gf = (Is * ef) / VT + 1e-12, gr = (Is * er) / VT + 1e-12;
          // Ebers-Moll transport: Ic = If - Ir*(1+1/br), Ib = If/bf + Ir/br
          const ic = If - Ir * (1 + 1 / br), ib = If / bf + Ir / br;
          // linearised: currents into collector / base, derivatives wrt vbe, vbc
          const dic_dvbe = gf, dic_dvbc = -gr * (1 + 1 / br), dib_dvbe = gf / bf, dib_dvbc = gr / br;
          const stampVCCS = (out: string, outRef: string, cp: string, cm: string, g: number) => { const o = idx(out), oo = idx(outRef), p1 = idx(cp), m1 = idx(cm); for (const [r, sr] of [[o, 1], [oo, -1]] as const) { if (r < 0) continue; if (p1 >= 0) A[r][p1] += sr * g; if (m1 >= 0) A[r][m1] -= sr * g; } };
          // collector current flows from cn to en (npn), base current from bn to en
          stampVCCS(cn, en, bn, en, dic_dvbe); stampVCCS(cn, en, bn, cn, dic_dvbc);
          stampVCCS(bn, en, bn, en, dib_dvbe); stampVCCS(bn, en, bn, cn, dib_dvbc);
          const ic0 = s * (ic - dic_dvbe * vbe - dic_dvbc * vbc), ib0 = s * (ib - dib_dvbe * vbe - dib_dvbc * vbc);
          I(cn, en, ic0); I(bn, en, ib0);
          break;
        }
        case 'M': {
          const [dn, gn, sn] = e.n; const pm = /PMOS|BSS84/i.test(e.model); const s = pm ? -1 : 1; const p = params(e.model);
          const vt = p.VTO ?? 1.5, kp = p.KP ?? 0.2, lam = p.LAMBDA ?? 0.01;
          let vgs = s * (V(gn) - V(sn)), vds = s * (V(dn) - V(sn)); let swap = false;
          if (vds < 0) { swap = true; vds = -vds; vgs = s * (V(gn) - V(dn)); }
          const vov = vgs - vt; let id = 0, gm = 0, gds = 1e-9;
          if (vov > 0) { if (vds < vov) { id = kp * (vov * vds - (vds * vds) / 2) * (1 + lam * vds); gm = kp * vds * (1 + lam * vds); gds = kp * (vov - vds) * (1 + lam * vds) + kp * (vov * vds - vds * vds / 2) * lam; } else { id = (kp / 2) * vov * vov * (1 + lam * vds); gm = kp * vov * (1 + lam * vds); gds = (kp / 2) * vov * vov * lam; } }
          const D = swap ? sn : dn, S = swap ? dn : sn;
          G(D, S, gds + 1e-12);
          const o = idx(D), oo = idx(S), g1 = idx(gn), s1 = idx(S); for (const [r, sr] of [[o, 1], [oo, -1]] as const) { if (r < 0) continue; if (g1 >= 0) A[r][g1] += sr * gm; if (s1 >= 0) A[r][s1] -= sr * gm; }
          I(D, S, s * (id - gm * vgs - gds * vds));
          break;
        }
        case 'X': {
          // op-amp: pins +, -, V+, V-, OUT -> VCVS with gain A and output resistance, clamped to the rails
          const [inp, inn, vp, vn, out] = e.n; const k = bi.get(e.name)!; const Ag = 1e5, Ro = 50;
          const vin = V(inp) - V(inn), hi = V(vp) - 0.1, lo = V(vn) + 0.1;
          let vo = Ag * vin, g = Ag; if (vo > hi && hi > lo) { vo = hi; g = 0; } if (vo < lo && hi > lo) { vo = lo; g = 0; }
          // branch k carries the output current; v(out) - Ro*i = vo(x) linearised
          const o = idx(out); if (o >= 0) { A[o][k] += 1; A[k][o] += 1; }
          A[k][k] -= Ro;
          const ip = idx(inp), im = idx(inn); if (ip >= 0) A[k][ip] -= g; if (im >= 0) A[k][im] += g;
          b[k] += vo - g * vin;
          break;
        }
      }
    }
    return { A, b };
  };
  const capI = new Map<string, number>();
  const newton = (x0: number[], t: number, mode: 'dc' | 'tran', dt: number, prev: number[] | null): number[] | null => {
    let x = x0.slice();
    for (const gmin of mode === 'dc' ? [1e-3, 1e-5, 1e-7, 1e-9, 1e-12] : [1e-12]) {
      let ok = false;
      for (let it = 0; it < 200; it++) {
        const { A, b } = build(x, t, mode, dt, prev, gmin);
        const xn = solve(A, b); if (!xn) return null;
        let dmax = 0; for (let i = 0; i < N; i++) { let dx = xn[i] - x[i]; if (i < nodes.length) dx = Math.max(-0.5, Math.min(0.5, dx)); x[i] += dx; dmax = Math.max(dmax, Math.abs(dx)); }
        if (dmax < 1e-7) { ok = true; break; }
      }
      if (!ok && gmin === 1e-12 && mode === 'dc') warnings.push('operating point did not fully converge');
    }
    return x;
  };
  const res: SimResult = { nodes, warnings };
  const x0 = newton(new Array(N).fill(0), 0, 'dc', 0, null);
  if (!x0) { warnings.push('singular circuit matrix (floating node or source loop?)'); return res; }
  const probes = (opts.probes?.length ? opts.probes : nodes).filter((p) => ni.has(p) || p === '0');
  if (opts.op !== false) res.op = Object.fromEntries(nodes.map((n, i) => [n, x0[i]]));
  if (opts.tran) {
    const { step, stop } = opts.tran; const t: number[] = [0]; const v: Record<string, number[]> = Object.fromEntries(probes.map((p) => [p, [p === '0' ? 0 : x0[ni.get(p)!]]]));
    let x = x0.slice(); for (const e of els) if (e.kind === 'C') capI.set(e.name, 0);
    const steps = Math.min(200000, Math.ceil(stop / step));
    for (let s = 1; s <= steps; s++) {
      const tt = s * step; const prev = x;
      const xn = newton(x, tt, 'tran', step, prev); if (!xn) { warnings.push(`transient failed at ${tt}`); break; }
      // capacitor currents for the trapezoidal rule
      for (const e of els) if (e.kind === 'C') { const C = num(e.v), g = (2 * C) / step; const vn = (e.n[0] === '0' ? 0 : xn[idx(e.n[0])]) - (e.n[1] === '0' ? 0 : xn[idx(e.n[1])]); const vp = (e.n[0] === '0' ? 0 : prev[idx(e.n[0])]) - (e.n[1] === '0' ? 0 : prev[idx(e.n[1])]); capI.set(e.name, g * (vn - vp) - (capI.get(e.name) ?? 0)); }
      x = xn; t.push(tt); for (const p of probes) v[p].push(p === '0' ? 0 : x[ni.get(p)!]);
    }
    res.tran = { t, v };
  }
  if (opts.ac) {
    const { fStart, fStop, points } = opts.ac; const f: number[] = []; const mag: Record<string, number[]> = Object.fromEntries(probes.map((p) => [p, []])), phase: Record<string, number[]> = Object.fromEntries(probes.map((p) => [p, []]));
    const { A: G0 } = build(x0, 0, 'dc', 0, null, 1e-12);
    // .AC DEC: `points` per decade from fStart up to fStop
    const total = Math.max(1, Math.floor(Math.log10(fStop / fStart) * points + 1e-9) + 1);
    for (let k = 0; k < total; k++) {
      const fr = fStart * Math.pow(10, k / points), w = 2 * Math.PI * fr;
      const A: Cx[][] = G0.map((r) => r.map((g) => [g, 0] as Cx)); const b: Cx[] = new Array(N).fill(0).map(() => [0, 0] as Cx);
      // the DC stamp of C (1e-12) is replaced by jwC; L branch gets -jwL; sources: AC magnitudes
      for (const e of els) {
        const [a, c] = e.n; const i = idx(a), j = idx(c);
        if (e.kind === 'C') { const y = w * num(e.v); const add = (r: number, s: number, val: number) => { if (r >= 0 && s >= 0) A[r][s][1] += val; }; add(i, i, y); add(j, j, y); add(i, j, -y); add(j, i, -y); }
        if (e.kind === 'L') { const kk = bi.get(e.name)!; A[kk][kk][1] -= w * num(e.v); }
        if (e.kind === 'V') { const kk = bi.get(e.name)!; b[kk] = [acMag(e.v), 0]; }
        if (e.kind === 'I') { const m = acMag(e.v); if (i >= 0) b[i][0] -= m; if (j >= 0) b[j][0] += m; }
      }
      const xs = solveC(A, b); if (!xs) { warnings.push(`AC solve failed at ${fr} Hz`); break; }
      f.push(fr); for (const p of probes) { const z = p === '0' ? [0, 0] : xs[ni.get(p)!]; mag[p].push(Math.hypot(z[0], z[1])); phase[p].push((Math.atan2(z[1], z[0]) * 180) / Math.PI); }
    }
    res.ac = { f, mag, phase };
  }
  return res;
}

/** Simulate a schematic: its SPICE netlist (from the parts' templates) through the built-in engine. */
export function simulate(d: Design, opts: SimOptions): SimResult & { skipped: string[]; netlist: string } {
  const nl = spiceNetlist(d);
  const r = simulateNetlist(nl.text, opts);
  // compact output: round, and decimate long transients
  if (r.tran && r.tran.t.length > 400) { const k = Math.ceil(r.tran.t.length / 400); r.tran.t = r.tran.t.filter((_, i) => i % k === 0); for (const p of Object.keys(r.tran.v)) r.tran.v[p] = r.tran.v[p].filter((_, i) => i % k === 0); }
  return { ...r, skipped: nl.skipped, netlist: nl.text };
}
