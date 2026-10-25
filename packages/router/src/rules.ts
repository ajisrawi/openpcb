/**
 * Rule resolution following the SPECCTRA precedence (most specific wins)
 *   pcb < layer < region < class < class layer_rule < class_class < net < net layer_rule < fromto
 * and clearance-type lookup (e.g. 'wire_wire' > 'default').
 */
import type { Design, RuleSet, Net } from './model.js';
import type { Pt } from './geom.js';
import { pointInPolygon } from './geom.js';

export type ObjectType = 'wire' | 'via' | 'pin' | 'smd' | 'area';

export class Rules {
  constructor(private readonly d: Design) {}

  /** Trace width for a net (optionally on a layer, for one from-to pin pair, at a point for region rules). */
  width(netName: string | undefined, layerName?: string, fromto?: { a: string; b?: string }, at?: Pt): number {
    const net = netName ? this.d.network.nets.get(netName) : undefined;
    const cls = net?.className ? this.d.network.classes.get(net.className) : undefined;
    const layer = layerName ? this.d.structure.layers.find((l) => l.name === layerName) : undefined;
    const ft = fromto && net?.fromtos?.find((f) => (f.a === fromto.a && f.b === fromto.b) || (f.a === fromto.b && f.b === fromto.a));
    const region = at ? this.regionRule(at, cls?.name) : undefined;
    // precedence: from-to, then a constraint region (it overrides net and class rules inside it, as in Allegro),
    // then the net's and its class's own rules, the layer rule and the board rule
    return ft?.rule?.width ?? region?.width ?? (layerName ? net?.layerRules?.get(layerName)?.width : undefined) ?? net?.rule?.width
      ?? (layerName ? cls?.layerRules?.get(layerName)?.width : undefined) ?? cls?.rule?.width
      ?? layer?.rule?.width ?? this.d.structure.rule.width ?? this.defaultWidth();
  }

  /** Widest width a net can be given anywhere (all layers, all from-tos): what the router reserves. */
  maxWidth(netName: string): number {
    let w = this.width(netName);
    for (const l of this.d.structure.layers) w = Math.max(w, this.width(netName, l.name));
    const net = this.d.network.nets.get(netName);
    for (const f of net?.fromtos ?? []) if (f.rule?.width !== undefined) w = Math.max(w, f.rule.width);
    return w;
  }

  /** The rule of the (last-declared) region containing a point, merged with its class-specific rule. */
  private regionRule(at: Pt, className?: string): RuleSet | undefined {
    const regions = this.d.structure.regions; if (!regions?.length) return undefined;
    for (let i = regions.length - 1; i >= 0; i--) {
      const rg = regions[i], s = rg.shape;
      let inside = false;
      if (s.kind === 'rect' && s.rect) inside = at.x >= Math.min(s.rect.x1, s.rect.x2) && at.x <= Math.max(s.rect.x1, s.rect.x2) && at.y >= Math.min(s.rect.y1, s.rect.y2) && at.y <= Math.max(s.rect.y1, s.rect.y2);
      else if (s.points && s.points.length >= 3) inside = pointInPolygon(at, s.points);
      else if (s.kind === 'circle' && s.diameter) inside = Math.hypot(at.x - (s.center?.x ?? 0), at.y - (s.center?.y ?? 0)) <= s.diameter / 2;
      if (!inside) continue;
      const cr = className ? rg.classRules?.find((c) => c.classes.includes(className))?.rule : undefined;
      return cr ?? rg.rule;
    }
    return undefined;
  }

  defaultWidth(): number {
    // 0.25 mm if the design does not say.
    return Math.round(0.25 * this.mmToRes());
  }

  mmToRes(): number {
    const r = this.d.resolution;
    const unitMm: Record<string, number> = { inch: 25.4, in: 25.4, i: 25.4, mil: 0.0254, cm: 10, mm: 1, um: 0.001, micron: 0.001 };
    return r.value / (unitMm[r.unit.toLowerCase()] ?? 1);
  }

  /** Clearance required between objects of two nets (types a,b). */
  clearance(netA: string | undefined, netB: string | undefined, a: ObjectType = 'wire', b: ObjectType = 'wire', layerName?: string, at?: Pt): number {
    const key1 = `${a}_${b}`, key2 = `${b}_${a}`;
    const pick = (r: RuleSet | undefined): number | undefined => {
      if (!r) return undefined;
      return r.clearance.get(key1) ?? r.clearance.get(key2) ?? r.clearance.get('default');
    };
    const netOf = (name: string | undefined) => (name ? this.d.network.nets.get(name) : undefined);
    const na = netOf(netA), nb = netOf(netB);
    // a constraint region overrides every net/class rule inside it (its class-specific rules included)
    // via clearances written on the pcb rule come from drill rules (hole to copper / hole to hole): fabrication limits
    // that no region, class or net rule relaxes
    const viaFloor = a === 'via' || b === 'via' ? (this.d.structure.rule.clearance.get(key1) ?? this.d.structure.rule.clearance.get(key2) ?? 0) : 0;
    const inRegion = at ? pick(this.regionRule(at, na?.className)) : undefined;
    if (inRegion !== undefined) return Math.max(inRegion, viaFloor);
    // class_class: a rule written for this pair of classes beats the classes' own rules
    const cc = this.d.network.classClass;
    if (cc && na?.className && nb?.className && na.className !== nb.className) {
      for (let i = cc.length - 1; i >= 0; i--) if (cc[i].classes.includes(na.className) && cc[i].classes.includes(nb.className)) { const v = pick(cc[i].rule); if (v !== undefined) return Math.max(v, viaFloor); }
    }
    const forNet = (net: Net | undefined): number | undefined => {
      const cls = net?.className ? this.d.network.classes.get(net.className) : undefined;
      return (layerName ? pick(net?.layerRules?.get(layerName)) : undefined) ?? pick(net?.rule)
        ?? (layerName ? pick(cls?.layerRules?.get(layerName)) : undefined) ?? pick(cls?.rule);
    };
    const layer = layerName ? this.d.structure.layers.find((l) => l.name === layerName) : undefined;
    const base = pick(layer?.rule) ?? pick(this.d.structure.rule) ?? this.defaultClearance();
    const ca = forNet(na), cb = forNet(nb);
    // The more restrictive of the two nets' own rules, falling back to the global (or region) rule.
    return Math.max(ca ?? base, cb ?? base, viaFloor);
  }

  /**
   * The largest clearance a net needs to any other net (types a,b): its own rule, or a larger class-to-class rule
   * against some other class. The routing lattice keeps one clearance per net, so it reserves this one.
   */
  maxClearanceFor(netName: string, a: ObjectType = 'wire', b: ObjectType = 'wire'): number {
    let c = this.clearance(netName, undefined, a, b);
    const own = this.d.network.nets.get(netName)?.className;
    for (const cc of this.d.network.classClass ?? []) {
      if (!own || !cc.classes.includes(own)) continue;
      for (const other of cc.classes) {
        if (other === own) continue;
        const rep = this.d.network.classes.get(other)?.nets[0];
        if (rep) c = Math.max(c, this.clearance(netName, rep, a, b));
      }
    }
    return c;
  }

  /** Net limits from its circuit (or its class's). */
  maxTotalVias(netName: string | undefined): number | undefined {
    const net = netName ? this.d.network.nets.get(netName) : undefined;
    const cls = net?.className ? this.d.network.classes.get(net.className) : undefined;
    return net?.circuit?.maxTotalVias ?? cls?.circuit?.maxTotalVias;
  }

  defaultClearance(): number { return Math.round(0.2 * this.mmToRes()); }

  /** Via padstacks a net may use (its circuit use_via, else its class's); undefined = any usable via. */
  vias(netName: string | undefined): string[] | undefined {
    const net = netName ? this.d.network.nets.get(netName) : undefined;
    const cls = net?.className ? this.d.network.classes.get(net.className) : undefined;
    return net?.circuit?.useVia ?? cls?.circuit?.useVia;
  }

  /** Via padstack name to use for a net. */
  via(netName: string | undefined): string | undefined {
    const net = netName ? this.d.network.nets.get(netName) : undefined;
    const cls = net?.className ? this.d.network.classes.get(net.className) : undefined;
    return net?.circuit?.useVia?.[0] ?? cls?.circuit?.useVia?.[0] ?? this.d.structure.vias[0];
  }

  /** Layers a net may use (names), or undefined for all signal layers. */
  useLayers(netName: string | undefined): string[] | undefined {
    const net = netName ? this.d.network.nets.get(netName) : undefined;
    const cls = net?.className ? this.d.network.classes.get(net.className) : undefined;
    return net?.circuit?.useLayer ?? cls?.circuit?.useLayer;
  }

  priority(net: Net): number {
    const cls = net.className ? this.d.network.classes.get(net.className) : undefined;
    return net.circuit?.priority ?? cls?.circuit?.priority ?? 0;
  }

  /** Largest clearance and width anywhere in the design (used to size the routing lattice). */
  extremes(): { maxClearance: number; minClearance: number; maxWidth: number; minWidth: number } {
    let maxC = 0, minC = Infinity, maxW = 0, minW = Infinity;
    const scan = (r: RuleSet | undefined) => {
      if (!r) return;
      for (const v of r.clearance.values()) { maxC = Math.max(maxC, v); minC = Math.min(minC, v); }
      if (r.width !== undefined) { maxW = Math.max(maxW, r.width); minW = Math.min(minW, r.width); }
    };
    scan(this.d.structure.rule);
    for (const l of this.d.structure.layers) scan(l.rule);
    for (const c of this.d.network.classes.values()) { scan(c.rule); for (const r of c.layerRules?.values() ?? []) scan(r); }
    for (const n of this.d.network.nets.values()) { scan(n.rule); for (const r of n.layerRules?.values() ?? []) scan(r); for (const f of n.fromtos ?? []) scan(f.rule); }
    for (const cc of this.d.network.classClass ?? []) scan(cc.rule);
    for (const rg of this.d.structure.regions ?? []) { scan(rg.rule); for (const c of rg.classRules ?? []) scan(c.rule); }
    if (!Number.isFinite(minC)) minC = maxC = this.defaultClearance();
    if (!Number.isFinite(minW)) minW = maxW = this.defaultWidth();
    return { maxClearance: maxC, minClearance: minC, maxWidth: maxW, minWidth: minW };
  }
}
