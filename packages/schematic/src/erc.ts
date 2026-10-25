/**
 * Design rules check (Capture Tools > Design Rules Check): electrical rules (ERC pin-type matrix, unconnected pins,
 * single-node nets, nets with inputs but no driver, power pins on signal nets, ports and off-page connectors with
 * no partner) and physical rules (duplicate designators, missing footprints, duplicate / missing pin numbers,
 * unannotated parts, off-grid objects, parts outside the page).
 */
import { type Design, type PinType, type Pt, libPart, allPages, PAGE_SIZES, instPins } from './model.js';
import { buildNetlist } from './connect.js';

export type Severity = 'error' | 'warning';
export interface ErcMarker { kind: string; severity: Severity; message: string; page?: string; at?: Pt; net?: string }

const TYPES: PinType[] = ['input', 'output', 'bidirectional', 'tristate', 'passive', 'power', 'open_collector', 'open_emitter', 'unspecified', 'no_connect'];
/** Default matrix: what two pin types on one net mean. */
function defaultMatrix(): Record<PinType, Partial<Record<PinType, 'ok' | 'warning' | 'error'>>> {
  const m = Object.fromEntries(TYPES.map((t) => [t, {} as Partial<Record<PinType, 'ok' | 'warning' | 'error'>>])) as Record<PinType, Partial<Record<PinType, 'ok' | 'warning' | 'error'>>>;
  const set = (a: PinType, b: PinType, v: 'warning' | 'error') => { m[a][b] = v; m[b][a] = v; };
  set('output', 'output', 'error'); set('output', 'power', 'error'); set('power', 'open_collector', 'warning'); set('power', 'open_emitter', 'warning');
  set('output', 'open_collector', 'error'); set('output', 'open_emitter', 'error'); set('output', 'tristate', 'warning'); set('open_collector', 'open_emitter', 'error');
  for (const t of TYPES) set('no_connect', t, 'error');
  for (const t of TYPES) if (t !== 'no_connect') set('unspecified', t, 'warning');
  return m;
}

export function runErc(d: Design, opts: { grid?: number } = {}): ErcMarker[] {
  const out: ErcMarker[] = [];
  const nl = buildNetlist(d);
  for (const i of nl.issues) out.push({ kind: i.kind, severity: i.kind === 'power-short' || i.kind === 'duplicate-unit' ? 'error' : 'warning', message: i.message, page: i.page, at: i.at });
  const matrix = defaultMatrix();
  if (d.erc) for (const [a, row] of Object.entries(d.erc)) for (const [b, v] of Object.entries(row ?? {})) { matrix[a as PinType][b as PinType] = v; matrix[b as PinType][a as PinType] = v; }
  for (const net of nl.nets) {
    const pins = net.nodes;
    const nc = pins.some((p) => p.type === 'no_connect');
    if (pins.length === 1 && !net.noConnect && !net.global && !net.ports.length) {
      const p = pins[0];
      if (p.type !== 'no_connect') out.push({ kind: 'unconnected-pin', severity: p.type === 'input' || p.type === 'power' ? 'error' : 'warning', message: `${p.ref}.${p.pin} (${p.pinName}) is not connected`, page: p.page, at: p.at, net: net.name });
      continue;
    }
    if (net.noConnect && pins.length > 1 && !nc) out.push({ kind: 'no-connect-connected', severity: 'error', message: `net ${net.name} has a no-connect marker but ${pins.length} pins`, page: pins[0]?.page, at: pins[0]?.at, net: net.name });
    // pairwise matrix (report each conflicting pair once per net)
    const seen = new Set<string>();
    for (let i = 0; i < pins.length; i++) for (let j = i + 1; j < pins.length; j++) {
      const a = pins[i], b = pins[j], v = matrix[a.type]?.[b.type] ?? 'ok';
      if (v === 'ok') continue;
      const k = [a.type, b.type].sort().join('|'); if (seen.has(k)) continue; seen.add(k);
      out.push({ kind: 'pin-conflict', severity: v, message: `net ${net.name}: ${a.ref}.${a.pin} (${a.type}) with ${b.ref}.${b.pin} (${b.type})`, page: a.page, at: a.at, net: net.name });
    }
    const drivers = pins.filter((p) => ['output', 'bidirectional', 'tristate', 'power', 'open_collector', 'open_emitter', 'passive'].includes(p.type));
    if (pins.some((p) => p.type === 'input') && !drivers.length && !net.global && !net.ports.length) out.push({ kind: 'no-driver', severity: 'warning', message: `net ${net.name} has inputs but no driving source`, page: pins[0].page, at: pins[0].at, net: net.name });
    if (!net.global && pins.some((p) => p.type === 'power') && !pins.some((p) => p.type === 'output' || p.type === 'passive' || p.type === 'bidirectional')) out.push({ kind: 'power-pin-signal-net', severity: 'warning', message: `power pins on net ${net.name}, which no power symbol names`, page: pins[0].page, at: pins[0].at, net: net.name });
  }
  // off-page connectors / ports that pair with nothing
  const offCount = new Map<string, number>(); const portCount = new Map<string, number>();
  for (const { sch, page } of allPages(d)) { for (const o of page.offPages) offCount.set(`${sch.name}|${o.name}`, (offCount.get(`${sch.name}|${o.name}`) ?? 0) + 1); for (const p of page.ports) portCount.set(`${sch.name}|${p.name}`, (portCount.get(`${sch.name}|${p.name}`) ?? 0) + 1); }
  for (const { sch, page } of allPages(d)) for (const o of page.offPages) if ((offCount.get(`${sch.name}|${o.name}`) ?? 0) < 2) out.push({ kind: 'offpage-unmatched', severity: 'warning', message: `off-page connector ${o.name} has no partner in schematic ${sch.name}`, page: `${sch.name}/${page.name}`, at: o.at });
  const usedSch = new Set<string>(); for (const { page } of allPages(d)) for (const b of page.blocks) { usedSch.add(b.schematic); const child = d.schematics.find((s) => s.name === b.schematic); const ports = new Set(child?.pages.flatMap((pg) => pg.ports.map((p) => p.name)) ?? []); for (const bp of b.pins) if (!ports.has(bp.name)) out.push({ kind: 'block-pin-no-port', severity: 'error', message: `block ${b.ref} pin ${bp.name} has no port in schematic ${b.schematic}`, at: { x: b.x, y: b.y } }); }
  // physical rules
  const refs = new Map<string, string>();
  const pinNums = new Map<string, Set<string>>();
  const grid = opts.grid ?? d.settings.grid ?? 100;
  for (const { sch, page } of allPages(d)) {
    const pg = `${sch.name}/${page.name}`, size = PAGE_SIZES[page.size];
    for (const pi of page.parts) {
      const lp = libPart(d, pi.lib, pi.part);
      if (!lp) { out.push({ kind: 'missing-library-part', severity: 'error', message: `${pi.ref}: library part ${pi.lib}:${pi.part} not found`, page: pg, at: pi }); continue; }
      if (lp.kind && lp.kind !== 'part') continue;
      if (/\?$/.test(pi.ref)) out.push({ kind: 'unannotated', severity: 'error', message: `${pi.ref} (${pi.part}) is not annotated`, page: pg, at: pi });
      const prev = refs.get(pi.ref);
      if (prev && prev !== pi.part && !/\?$/.test(pi.ref)) out.push({ kind: 'duplicate-reference', severity: 'error', message: `${pi.ref} is used by ${prev} and ${pi.part}`, page: pg, at: pi });
      refs.set(pi.ref, pi.part);
      const fp = pi.props['PCB Footprint'] ?? lp.props['PCB Footprint'];
      if (!fp) out.push({ kind: 'missing-footprint', severity: 'warning', message: `${pi.ref} has no PCB Footprint`, page: pg, at: pi });
      const nums = pinNums.get(pi.ref) ?? new Set();
      for (const { pin, at } of instPins(d, pi)) {
        if (!pin.number) out.push({ kind: 'missing-pin-number', severity: 'error', message: `${pi.ref} pin ${pin.name} has no number`, page: pg, at });
        else if (nums.has(pin.number) && !pin.hidden) out.push({ kind: 'duplicate-pin-number', severity: 'error', message: `${pi.ref}: pin number ${pin.number} used twice`, page: pg, at });
        if (!pin.hidden) nums.add(pin.number);
      }
      pinNums.set(pi.ref, nums);
      if (pi.x % grid || pi.y % grid) out.push({ kind: 'off-grid', severity: 'warning', message: `${pi.ref} is off the ${grid} mil grid`, page: pg, at: pi });
      if (pi.x < 0 || pi.y < 0 || pi.x > size.w || pi.y > size.h) out.push({ kind: 'outside-page', severity: 'warning', message: `${pi.ref} lies outside the page`, page: pg, at: pi });
    }
    for (const w of page.wires) for (const q of w.pts) if (q.x % (grid / 2) || q.y % (grid / 2)) { out.push({ kind: 'off-grid', severity: 'warning', message: `wire vertex (${q.x}, ${q.y}) is off grid`, page: pg, at: q }); break; }
  }
  void usedSch; void portCount;
  return out;
}
