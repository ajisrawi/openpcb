/**
 * Built-in symbol library ("OpenSch"): passives, semiconductors, op-amp, sources, crystal, connectors, generic ICs,
 * and a multi-unit logic part with hidden power pins. Symbols are generated on a 100 mil grid; every part carries a
 * default PCB footprint (OpenBoard / KiCad names) and a SPICE element template.
 *
 * SPICE templates: %r = reference, %v = Value, %1.. = net of pin 1.., %p = all pins in order, %m = Model property.
 */
import type { LibPart, Library, SymPin, Graphic, PinType, Orient, SymbolView } from './model.js';

const pin = (number: string, name: string, x: number, y: number, orient: Orient, type: PinType = 'passive', length = 100, extra: Partial<SymPin> = {}): SymPin => ({ number, name, x, y, orient, type, length, ...extra });
const L = (...xy: number[]): Graphic => { const pts = []; for (let i = 0; i + 1 < xy.length; i += 2) pts.push({ x: xy[i], y: xy[i + 1] }); return { kind: 'line', pts }; };
const box = (x1: number, y1: number, x2: number, y2: number, fill = false): Graphic => ({ kind: 'rect', x1, y1, x2, y2, fill });
const two = (graphics: Graphic[], t1: PinType = 'passive', t2: PinType = 'passive', names = ['1', '2']): SymbolView => ({ graphics, pins: [pin('1', names[0], -200, 0, 'left', t1), pin('2', names[1], 200, 0, 'right', t2)] });
const part = (name: string, refPrefix: string, view: SymbolView, props: Record<string, string>, spice?: string, description?: string): LibPart => ({ name, refPrefix, units: [{ normal: view }], props, ...(spice ? { spice } : {}), ...(description ? { description } : {}) });

function resistor(): LibPart { return part('R', 'R', two([box(-100, -40, 100, 40)]), { Value: '10k', 'PCB Footprint': 'R_0603' }, 'R%r %1 %2 %v', 'Resistor'); }
function capacitor(): LibPart { return part('C', 'C', two([L(-100, 0, -20, 0), L(-20, -80, -20, 80), L(20, -80, 20, 80), L(20, 0, 100, 0)]), { Value: '100n', 'PCB Footprint': 'C_0402' }, 'C%r %1 %2 %v', 'Capacitor'); }
function capPolar(): LibPart { return part('CP', 'C', two([L(-100, 0, -20, 0), L(-20, -80, -20, 80), { kind: 'arc', c: { x: 80, y: 0 }, r: 85, a0: 140, a1: 220 }, L(-5, 0, 100, 0), L(-70, -60, -40, -60), L(-55, -75, -55, -45)]), { Value: '10u', 'PCB Footprint': 'C_1206' }, 'C%r %1 %2 %v', 'Polarized capacitor'); }
function inductor(): LibPart { const g: Graphic[] = [L(-100, 0, -100, 0)]; for (let i = 0; i < 4; i++) g.push({ kind: 'arc', c: { x: -75 + i * 50, y: 0 }, r: 25, a0: 0, a1: 180 }); return part('L', 'L', two(g), { Value: '10u', 'PCB Footprint': 'R_0805' }, 'L%r %1 %2 %v', 'Inductor'); }
function diode(): LibPart { return part('D', 'D', two([L(-100, 0, -40, 0), { kind: 'polygon', pts: [{ x: -40, y: -50 }, { x: -40, y: 50 }, { x: 40, y: 0 }], fill: true }, L(40, -50, 40, 50), L(40, 0, 100, 0)], 'passive', 'passive', ['A', 'K']), { Value: '1N4148', 'PCB Footprint': 'D_SOD-123', Model: 'DMOD' }, 'D%r %1 %2 %m', 'Diode'); }
function led(): LibPart { const p = diode(); p.name = 'LED'; p.props = { Value: 'LED', 'PCB Footprint': 'LED_0603', Model: 'DLED' }; p.units[0].normal.graphics.push(L(10, -70, 50, -110), L(40, -70, 80, -110)); p.description = 'Light emitting diode'; return p; }
function zener(): LibPart { const p = diode(); p.name = 'DZ'; p.props = { Value: 'BZX84C3V3', 'PCB Footprint': 'D_SOT-23', Model: 'DZMOD' }; p.units[0].normal.graphics.push(L(40, -50, 60, -60), L(40, 50, 20, 60)); p.description = 'Zener diode'; return p; }
function bjt(npn: boolean): LibPart {
  const g: Graphic[] = [{ kind: 'circle', c: { x: 20, y: 0 }, r: 90 }, L(-100, 0, -20, 0), L(-20, -60, -20, 60), L(-20, -25, 70, -90), L(-20, 25, 70, 90), L(70, -90, 100, -100), L(70, 90, 100, 100)];
  g.push(npn ? { kind: 'polygon', pts: [{ x: 70, y: 90 }, { x: 35, y: 85 }, { x: 55, y: 60 }], fill: true } : { kind: 'polygon', pts: [{ x: -20, y: 25 }, { x: 15, y: 30 }, { x: -5, y: 55 }], fill: true });
  return part(npn ? 'Q_NPN' : 'Q_PNP', 'Q', { graphics: g, pins: [pin('1', 'B', -200, 0, 'left', 'input'), pin('2', 'C', 100, -200, 'up'), pin('3', 'E', 100, 200, 'down')] }, { Value: npn ? 'MMBT3904' : 'MMBT3906', 'PCB Footprint': 'SOT-23', Model: npn ? 'QNPN' : 'QPNP' }, 'Q%r %2 %1 %3 %m', npn ? 'NPN transistor' : 'PNP transistor');
}
function mos(n: boolean): LibPart {
  const g: Graphic[] = [L(-100, 0, -40, 0), L(-40, -60, -40, 60), L(-20, -70, -20, -30), L(-20, -20, -20, 20), L(-20, 30, -20, 70), L(-20, -50, 100, -50), L(100, -50, 100, -100), L(-20, 50, 100, 50), L(100, 50, 100, 100), L(-20, 0, 100, 0), L(100, 0, 100, 50)];
  g.push(n ? { kind: 'polygon', pts: [{ x: -20, y: 0 }, { x: 15, y: -15 }, { x: 15, y: 15 }], fill: true } : { kind: 'polygon', pts: [{ x: 40, y: 0 }, { x: 5, y: -15 }, { x: 5, y: 15 }], fill: true });
  return part(n ? 'NMOS' : 'PMOS', 'Q', { graphics: g, pins: [pin('1', 'G', -200, 0, 'left', 'input'), pin('3', 'D', 100, -200, 'up'), pin('2', 'S', 100, 200, 'down')] }, { Value: n ? '2N7002' : 'BSS84', 'PCB Footprint': 'SOT-23', Model: n ? 'NMOS1' : 'PMOS1' }, 'M%r %3 %1 %2 %2 %m', n ? 'N-channel MOSFET' : 'P-channel MOSFET');
}
function opamp(): LibPart {
  const g: Graphic[] = [{ kind: 'polygon', pts: [{ x: -100, y: -150 }, { x: -100, y: 150 }, { x: 150, y: 0 }] }, { kind: 'text', at: { x: -80, y: -60 }, text: '+', size: 60 }, { kind: 'text', at: { x: -80, y: 70 }, text: '-', size: 60 }];
  return { name: 'OPAMP', refPrefix: 'U', units: [{ normal: { graphics: g, pins: [pin('3', '+', -200, -50, 'left', 'input'), pin('2', '-', -200, 50, 'left', 'input'), pin('1', 'OUT', 250, 0, 'right', 'output'), pin('8', 'V+', 0, -200, 'up', 'power', 100), pin('4', 'V-', 0, 200, 'down', 'power', 100)] } }], props: { Value: 'LM358', 'PCB Footprint': 'SOIC-8', Model: 'OPAMP1' }, spice: 'X%r %3 %2 %8 %4 %1 %m', description: 'Operational amplifier' };
}
function src(name: string, ref: string, desc: string, spice: string, value: string): LibPart {
  const g: Graphic[] = [{ kind: 'circle', c: { x: 0, y: 0 }, r: 80 }];
  if (ref === 'V') g.push({ kind: 'text', at: { x: 0, y: -30 }, text: '+', size: 50, anchor: 'middle' }, { kind: 'text', at: { x: 0, y: 55 }, text: '-', size: 50, anchor: 'middle' }); else g.push(L(0, 50, 0, -50), { kind: 'polygon', pts: [{ x: 0, y: -55 }, { x: -15, y: -25 }, { x: 15, y: -25 }], fill: true });
  return { name, refPrefix: ref, units: [{ normal: { graphics: g, pins: [pin('1', '+', 0, -200, 'up', 'power', 120), pin('2', '-', 0, 200, 'down', 'power', 120)] } }], props: { Value: value }, spice, description: desc };
}
function crystal(): LibPart { return part('XTAL', 'Y', two([L(-100, 0, -50, 0), L(-50, -60, -50, 60), box(-30, -80, 30, 80), L(50, -60, 50, 60), L(50, 0, 100, 0)]), { Value: '25MHz', 'PCB Footprint': 'Crystal_SMD_3225' }, undefined, 'Crystal'); }
function ferrite(): LibPart { return part('FB', 'FB', two([box(-100, -40, 100, 40, true)]), { Value: '600R@100MHz', 'PCB Footprint': 'R_0603' }, 'R%r %1 %2 0.1', 'Ferrite bead'); }
function fuse(): LibPart { return part('FUSE', 'F', two([box(-100, -30, 100, 30), L(-100, 0, 100, 0)]), { Value: '1A', 'PCB Footprint': 'R_1206' }, 'R%r %1 %2 0.05', 'Fuse'); }
function sw(): LibPart { return part('SW', 'SW', two([L(-100, 0, -60, 0), { kind: 'circle', c: { x: -50, y: 0 }, r: 10 }, L(-45, -5, 60, -50), { kind: 'circle', c: { x: 60, y: 0 }, r: 10 }, L(70, 0, 100, 0)]), { Value: 'SPST', 'PCB Footprint': 'SW_SPST' }, undefined, 'Switch'); }
function battery(): LibPart { return { name: 'BAT', refPrefix: 'BT', units: [{ normal: { graphics: [L(-60, -40, 60, -40), L(-30, -10, 30, -10), L(-60, 20, 60, 20), L(-30, 50, 30, 50), L(0, -40, 0, -100), L(0, 50, 0, 100)], pins: [pin('1', '+', 0, -200, 'up', 'power'), pin('2', '-', 0, 200, 'down', 'power')] } }], props: { Value: '3V', 'PCB Footprint': 'BatteryHolder' }, spice: 'V%r %1 %2 %v', description: 'Battery' }; }

/** Pin header 1xN (pins down the left side). */
export function connector(n: number): LibPart {
  const pins: SymPin[] = []; for (let i = 0; i < n; i++) pins.push(pin(String(i + 1), String(i + 1), -200, i * 100, 'left'));
  return { name: `CONN_1x${n}`, refPrefix: 'J', units: [{ normal: { graphics: [box(-100, -50, 100, n * 100 - 50)], pins } }], props: { Value: `CONN_1x${n}`, 'PCB Footprint': `Header_1x${n}` }, description: `Connector 1x${n}` };
}

/** Generic IC box with pins down both sides. */
export function genericIc(name: string, pinNames: string[], footprint = ''): LibPart {
  const half = Math.ceil(pinNames.length / 2), w = 400;
  const pins: SymPin[] = pinNames.map((nm, i) => i < half ? pin(String(i + 1), nm, -w / 2 - 200, i * 100, 'left', 'unspecified') : pin(String(i + 1), nm, w / 2 + 200, (pinNames.length - 1 - i) * 100, 'right', 'unspecified'));
  return { name, refPrefix: 'U', units: [{ normal: { graphics: [box(-w / 2 - 100, -100, w / 2 + 100, half * 100)], pins } }], props: { Value: name, 'PCB Footprint': footprint }, description: 'IC' };
}

/** Quad 2-input NAND (74HC00): four units, power pins hidden on VCC / GND. */
function quadNand(): LibPart {
  const pinNums = [[1, 2, 3], [4, 5, 6], [9, 10, 8], [12, 13, 11]];
  const units = pinNums.map(([a, b, y]) => ({
    normal: { graphics: [L(-100, -100, 0, -100), { kind: 'arc', c: { x: 0, y: 0 }, r: 100, a0: -90, a1: 90 } as Graphic, L(0, 100, -100, 100), L(-100, 100, -100, -100), { kind: 'circle', c: { x: 120, y: 0 }, r: 20 } as Graphic], pins: [pin(String(a), 'A', -200, -50, 'left', 'input'), pin(String(b), 'B', -200, 50, 'left', 'input'), pin(String(y), 'Y', 240, 0, 'right', 'output', 100), pin('14', 'VCC', 0, -100, 'up', 'power', 0, { hidden: true, net: 'VCC' }), pin('7', 'GND', 0, 100, 'down', 'power', 0, { hidden: true, net: 'GND' })] },
    convert: { graphics: [L(-100, -100, -40, -100), { kind: 'arc', c: { x: -100, y: 0 }, r: 100, a0: -60, a1: 60 } as Graphic, { kind: 'arc', c: { x: -40, y: 100 }, r: 200, a0: -60, a1: -10 } as Graphic, { kind: 'arc', c: { x: -40, y: -100 }, r: 200, a0: 10, a1: 60 } as Graphic, L(-100, 100, -40, 100)], pins: [pin(String(a), 'A', -200, -50, 'left', 'input', 100, { shape: 'dot' }), pin(String(b), 'B', -200, 50, 'left', 'input', 100, { shape: 'dot' }), pin(String(y), 'Y', 240, 0, 'right', 'output', 140), pin('14', 'VCC', 0, -100, 'up', 'power', 0, { hidden: true, net: 'VCC' }), pin('7', 'GND', 0, 100, 'down', 'power', 0, { hidden: true, net: 'GND' })] },
  }));
  return { name: '74HC00', refPrefix: 'U', units, props: { Value: '74HC00', 'PCB Footprint': 'SOIC-14' }, description: 'Quad 2-input NAND', pinGroups: [['1', '2'], ['4', '5'], ['9', '10'], ['12', '13']] };
}

export function basicLibrary(): Library {
  const parts = [resistor(), capacitor(), capPolar(), inductor(), diode(), led(), zener(), bjt(true), bjt(false), mos(true), mos(false), opamp(), src('VSRC', 'V', 'Voltage source', 'V%r %1 %2 %v', 'DC 5'), src('ISRC', 'I', 'Current source', 'I%r %1 %2 %v', 'DC 1m'), crystal(), ferrite(), fuse(), sw(), battery(), quadNand(), ...[1, 2, 3, 4, 5, 6, 8, 10, 12, 16, 20, 40].map(connector)];
  return { name: 'OpenSch', parts: Object.fromEntries(parts.map((p) => [p.name, p])) };
}
