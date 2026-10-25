/**
 * Do-file command interpreter — the scripting surface of OpenRoute, modelled
 * on the SPECCTRA command language so that Allegro-style do files work:
 *
 *   unit mil
 *   rule pcb (width 7) (clearance 7 (type wire_wire))
 *   grid wire 1
 *   fanout
 *   route 25
 *   clean 2
 *   route 50 16
 *   clean 4
 *   write session $/final.ses
 *   report status $/final.sts
 */
import { parseSExpr, isList, isAtom, head, child, children, atoms, num, type SList } from './sexpr.js';
import { type Design, type Direction, unitToResolution, emptyRuleSet, type RuleSet } from './model.js';
import { Board } from './board.js';
import { Router, type RouterOptions, type PassRecord } from './route/router.js';
import { writeSession, writeRoutes, parseSession } from './session.js';
import { runDrc } from './drc.js';
import { applyRoutes } from './apply.js';
import { ShapeRouter } from './route/shape.js';
import { miterRoutes, tuneRoutes, criticRoutes, slideRoutes, fattenRoutes, teardropRoutes, shieldRoutes, arcRoutes, taperRoutes, smoothRoutes } from './post.js';
import type { SessionRoutes } from './model.js';

export interface FileSystemLike {
  read(path: string): string;
  write(path: string, text: string): void;
}

export interface InterpreterOptions {
  files: FileSystemLike;
  designDir: string;
  designFile: string;
  log?: (s: string) => void;
  onPass?: (rec: PassRecord) => void;
  router?: Partial<RouterOptions>;
}

export class Interpreter {
  unit: string;
  router: Router | null = null;
  board: Board | null = null;
  quitRequested = false;
  wroteSession = false;
  statusFile: string | null = null;
  bestsaveFile: string | null = null;
  selected = new Set<string>();
  private diagonal: 'on' | 'off' | 'always' = 'off';   // SPECCTRA default: orthogonal routing
  private miterOn = false;
  private tuneOn = false;
  private tuneViaLength = 0;
  private gloss: { critic?: boolean; center?: boolean; spread?: number; fatten?: number; teardrop?: boolean } = {};
  private shields: { net: string; shieldNet: string; gap?: number }[] = [];
  private miterLength = 0;
  private arcOn = false;
  private arcRadius = 0;
  private taperSteps = 0;
  private tunePhase = false;
  private smoothMode: '' | '45' | 'any' = '';
  private edgeClearance: number | undefined;
  private heuristicWeight: number | undefined;
  private maxExpansions: number | undefined;
  /** routes of the shape-based (gridless) router, once it has run: written instead of the lattice router's */
  private shapeRoutes: SessionRoutes | null = null;
  private readRoutes: SessionRoutes | null = null;
  shape: ShapeRouter | null = null;
  readonly log: (s: string) => void;

  constructor(readonly design: Design, readonly opts: InterpreterOptions) {
    this.unit = design.unit;
    this.log = opts.log ?? (() => {});
  }

  /** Convert a number given in the current command unit to resolution units. */
  private conv(v: number): number { return Math.round(v * unitToResolution(this.unit, this.design.resolution)); }

  resolvePath(p: string): string {
    const dir = this.opts.designDir.replace(/[\\/]+$/, '');
    if (p.startsWith('$/') || p.startsWith('$\\')) return dir + '/' + p.slice(2);
    if (/^([a-zA-Z]:[\\/]|[\\/])/.test(p)) return p;
    return dir + '/' + p;
  }

  ensureRouter(): Router {
    if (!this.router) {
      this.board = new Board(this.design);
      this.router = new Router(this.board, {
        ...this.opts.router,
        log: this.log,
        allowDiagonal: this.diagonal !== 'off',
        ...(this.edgeClearance !== undefined ? { edgeClearance: this.edgeClearance } : {}),
        ...(this.heuristicWeight !== undefined ? { heuristicWeight: this.heuristicWeight } : {}),
        ...(this.maxExpansions !== undefined ? { maxExpansions: this.maxExpansions } : {}),
        selectedNets: this.selected.size ? this.selected : undefined,
        onPass: (rec) => { this.opts.onPass?.(rec); if (this.statusFile) this.appendStatus(rec); },
      });
    }
    return this.router;
  }

  private appendStatus(rec: PassRecord): void {
    if (!this.statusFile) return;
    let text = '';
    try { text = this.opts.files.read(this.statusFile); } catch { text = ''; }
    const mm = this.board!.rules.mmToRes();
    text += `${rec.kind} pass ${rec.pass}: unrouted=${rec.unrouted} conflicts=${rec.conflicts} vias=${rec.vias} length=${(rec.length / mm).toFixed(2)}mm completion=${rec.completion.toFixed(2)}% time=${rec.seconds.toFixed(1)}s\n`;
    this.opts.files.write(this.statusFile, text);
  }

  /** Run a whole do file (text). */
  run(text: string): void {
    for (const raw of text.split(/\r?\n/)) {
      if (this.quitRequested) break;
      const line = raw.replace(/#.*$/, '').trim();
      if (!line) continue;
      try { this.exec(line); }
      catch (e) { this.log(`ERROR in "${line}": ${(e as Error).message}`); }
    }
  }

  exec(line: string): void {
    const form = parseSExpr('(' + line + ')')[0] as SList;
    const cmd = head(form);
    const args = form.slice(1);
    const a = (i: number) => (isAtom(args[i]) ? String(args[i]) : '');
    switch (cmd) {
      case 'unit': this.unit = a(0); this.log(`unit ${this.unit}`); break;
      case 'resolution': break;
      case 'rule': this.cmdRule(args); break;
      case 'grid': {
        const what = a(0).toLowerCase();
        if (what === 'smart') { const w = child(form, 'wire'), v = child(form, 'via'); if (w) this.design.structure.gridWire = this.conv(num(w[1])); if (v) this.design.structure.gridVia = this.conv(num(v[1])); }
        else if (what === 'wire') this.design.structure.gridWire = this.conv(num(args[1]));
        else if (what === 'via') this.design.structure.gridVia = this.conv(num(args[1]));
        break;
      }
      case 'direction': {
        const layer = this.design.structure.layers.find((l) => l.name === a(0));
        if (layer) layer.direction = a(1).toLowerCase() as Direction;
        break;
      }
      case 'set': {
        const key = a(0).toLowerCase();
        if (key === 'diagonal') this.diagonal = a(1).toLowerCase() as typeof this.diagonal;
        else if (key === 'edge_clearance') this.edgeClearance = this.conv(num(args[1]));
        else if (key === 'heuristic_weight' || key === 'fast') this.heuristicWeight = num(args[1], 1.5);
        else if (key === 'max_expansions') { this.maxExpansions = Math.max(10_000, Math.round(num(args[1], 3_000_000))); if (this.router) this.router.opts.maxExpansions = this.maxExpansions; }
        else this.log(`set ${key}: accepted (no-op)`);
        break;
      }
      case 'select': { if (a(0).toLowerCase() === 'all') this.selected.clear(); else if (a(0).toLowerCase() === 'net') for (const n of args.slice(1)) if (isAtom(n)) this.selected.add(String(n)); break; }
      case 'unselect': this.selected.clear(); break;
      case 'status_file': this.statusFile = this.resolvePath(a(0)); this.opts.files.write(this.statusFile, ''); break;
      case 'bestsave': this.bestsaveFile = a(0).toLowerCase() === 'on' ? this.resolvePath(a(1) || 'bestsave.ses') : null; break;
      case 'autosave': break;
      case 'fanout': {
        // fanout                      plane nets only (SMD power/ground pins to their plane)
        // fanout signal [minPins] [outerRows] / fanout all   also escape inner signal pins of BGAs / fine-pitch parts
        const mode = a(0).toLowerCase();
        const nums = args.filter((x) => isAtom(x) && /^\d+$/.test(String(x))).map((x) => Number(x));
        if (mode === 'signal' || mode === 'all') this.ensureRouter().fanout({ signal: true, minPins: nums[0], outerRows: nums[1] });
        else this.ensureRouter().fanout();
        break;
      }
      case 'route': {
        const passes = args.length && isAtom(args[0]) && /^\d+$/.test(a(0)) ? Number(a(0)) : 1;
        const start = args.length > 1 && isAtom(args[1]) && /^\d+$/.test(a(1)) ? Number(a(1)) : undefined;
        const remove = !!child(form, 'remove') && String(child(form, 'remove')![1]).toLowerCase() !== 'off';
        this.ensureRouter().route(passes, start, remove);
        this.maybeBestsave();
        break;
      }
      case 'clean': this.ensureRouter().clean(args.length && /^\d+$/.test(a(0)) ? Number(a(0)) : 1); this.maybeBestsave(); break;
      case 'smart_route': this.ensureRouter().smartRoute(); this.maybeBestsave(); break;
      case 'define': {
        if (a(0).toLowerCase() === 'via') this.defineVia(num(args[1]), num(args[2]), a(3), a(4), a(5) || undefined);
        else this.log(`define ${a(0)}: accepted (no-op)`);
        break;
      }
      case 'arc': case 'recorner': {
        // recorner arc [<radius>] / arc [<radius>] — tangent arcs on wire corners; recorner diagonal = miter
        if (head(form) === 'recorner' && !args.some((x) => isAtom(x) && String(x).toLowerCase() === 'arc')) { this.exec(['miter', ...args.filter((x) => isAtom(x) && /^[\d.]+$/.test(String(x))).map(String)].join(' ')); break; }
        const rv = args.find((x) => isAtom(x) && /^[\d.]+$/.test(String(x)));
        this.arcRadius = rv !== undefined ? this.conv(num(rv)) : 0;
        this.arcOn = true; this.miterOn = false;
        const res = arcRoutes(this.design, this.ensureRouter().routes(), this.arcRadius ? { radius: this.arcRadius } : {});
        this.log(`arc: ${res.arcs} corners rounded, ${res.skipped} kept (clearance or a branch at the corner)`);
        break;
      }
      case 'smooth': {
        // smooth [any] — gridless pull-tight: direct shortcuts off the routing lattice (45° only unless 'any')
        this.smoothMode = args.some((x) => isAtom(x) && String(x).toLowerCase() === 'any') ? 'any' : '45';
        const res = smoothRoutes(this.design, this.ensureRouter().routes(), { any: this.smoothMode === 'any' });
        this.log(`smooth: ${res.removed} lattice vertices removed, ${res.shortened} wires shortened`);
        break;
      }
      case 'taper': {
        // taper [<steps>] — stepped transitions where a wire changes width (neck-down regions, width rules)
        const sv = args.find((x) => isAtom(x) && /^\d+$/.test(String(x)));
        this.taperSteps = sv !== undefined ? Math.max(2, Number(sv)) : 3;
        const res = taperRoutes(this.design, this.ensureRouter().routes(), { steps: this.taperSteps });
        this.log(`taper: ${res.tapers} width changes tapered`);
        break;
      }
      case 'miter': {
        // miter [<leg length>] — 45° chamfers on wire corners, clearance-checked; applied to every written session
        const v = args.find((x) => isAtom(x) && /^[\d.]+$/.test(String(x)));
        this.miterLength = v !== undefined ? this.conv(num(v)) : 0;
        this.miterOn = true; this.arcOn = false;
        const res = miterRoutes(this.design, this.ensureRouter().routes(), this.miterLength ? { length: this.miterLength } : {});
        this.log(`miter: ${res.mitered} corners mitered, ${res.skipped} kept square (clearance or a branch at the corner)`);
        break;
      }
      case 'unmiter': this.miterOn = false; this.log('unmiter: square corners'); break;
      case 'tune': {
        // tune — serpentines for pair skew, (match_net_length) classes and minimum lengths; applied to every written session
        // tune [<via length>] — the optional value (current unit) counts each via toward length, like board thickness
        // tune phase [<via length>] — pair members get low bumps near their ends (dynamic phase matching)
        const vl = args.find((x) => isAtom(x) && /^[\d.]+$/.test(String(x)));
        this.tuneViaLength = vl !== undefined ? this.conv(num(vl)) : 0;
        this.tunePhase = args.some((x) => isAtom(x) && String(x).toLowerCase() === 'phase');
        this.tuneOn = false;
        const res = tuneRoutes(this.design, this.finalRoutes(), { viaLength: this.tuneViaLength, phase: this.tunePhase });   // measured on the untuned copper
        this.tuneOn = true;
        const mm = unitToResolution('mm', this.design.resolution);
        for (const r of res.report) this.log(`tune ${r.net}: ${(r.before / mm).toFixed(3)} -> ${(r.after / mm).toFixed(3)} mm (target ${(r.target / mm).toFixed(3)})${r.ok ? '' : ' NOT MET'}`);
        if (!res.report.length) this.log('tune: nothing to tune');
        break;
      }
      case 'critic': { this.gloss.critic = true; const res = criticRoutes(this.design, this.ensureRouter().routes()); this.log(`critic: ${res.trimmed} dangling segments trimmed, ${res.notches} notches removed`); break; }
      case 'filter': { const n = this.ensureRouter().filter(); this.log(`filter: ${n} conflicting connections removed (now unrouted)`); break; }
      case 'center': { this.gloss.center = true; const res = slideRoutes(this.design, this.ensureRouter().routes(), 'center'); this.log(`center: ${res.moved} segments centred between their neighbours`); break; }
      case 'spread': {
        const v = args.find((x) => isAtom(x) && /^[\d.]+$/.test(String(x)));
        this.gloss.spread = v !== undefined ? this.conv(num(v)) : this.ensureRouter().board.rules.clearance(undefined, undefined);
        const res = slideRoutes(this.design, this.ensureRouter().routes(), 'spread', this.gloss.spread);
        this.log(`spread: ${res.moved} segments moved apart (target extra spacing ${this.gloss.spread})`); break;
      }
      case 'fatten': case 'gloss': {
        const v = args.find((x) => isAtom(x) && /^[\d.]+$/.test(String(x)));
        const r = this.ensureRouter();
        this.gloss.fatten = v !== undefined ? this.conv(num(v)) : Math.round(r.board.rules.width(undefined) * 2);
        const res = fattenRoutes(this.design, r.routes(), this.gloss.fatten);
        this.log(`fatten: ${res.fattened} wires/segments widened to ${this.gloss.fatten}`); break;
      }
      case 'shape_route': case 'route_gridless': {
        // shape_route [passes] [any] [finish] [time seconds] — gridless shape-based routing; 'finish' keeps the copper
        // routed so far; 'time' stops after that many seconds with the routes made until then
        const at = (s: string) => args.some((x) => isAtom(x) && String(x).toLowerCase() === s);
        const ti = args.findIndex((x) => isAtom(x) && String(x).toLowerCase() === 'time');
        const timeLimit = ti >= 0 ? Number(String(args[ti + 1])) : NaN;
        const v = args.find((x, i) => isAtom(x) && /^\d+$/.test(String(x)) && i !== ti + 1);
        const existing = at('finish') ? (this.shapeRoutes ?? (this.router ? this.router.routes() : this.readRoutes ?? undefined)) : undefined;
        const sr = new ShapeRouter(this.design, { log: this.log, passes: v !== undefined ? Number(v) : 16, anyAngle: at('any'), ...(Number.isFinite(timeLimit) && timeLimit > 0 ? { timeLimitMs: timeLimit * 1000 } : {}), debug: at('debug'), existing, selectedNets: this.selected.size ? this.selected : undefined, ...(this.edgeClearance !== undefined ? { edgeClearance: this.edgeClearance } : {}), ...(this.maxExpansions !== undefined ? { maxExpansions: this.maxExpansions } : {}) });
        const done = sr.route();
        this.shape = sr; this.shapeRoutes = sr.routes();
        this.log(`${sr.statusReport()}${done ? ' — complete' : ''}`);
        break;
      }
      case 'groute': {
        // groute [rounds] — global routing with negotiated congestion; later route passes prefer the corridors
        const v = args.find((x) => isAtom(x) && /^\d+$/.test(String(x)));
        const res = this.ensureRouter().globalRoute(v !== undefined ? Number(v) : 4);
        this.log(`groute: ${res.tiles} tiles, remaining overflow ${res.overflow.toFixed(0)} tracks; corridors on`);
        break;
      }
      case 'teardrop': { this.gloss.teardrop = true; this.log('teardrop: added to every written session'); break; }
      case 'shield': {
        // shield <net> [<shield_net>] [<gap>] — guard traces of the shield net (default GND) on both sides of the net
        const net = a(0); const shieldNet = args[1] !== undefined && !/^[\d.]+$/.test(a(1)) ? a(1) : 'GND';
        const g = args.find((x, i) => i > 0 && isAtom(x) && /^[\d.]+$/.test(String(x)));
        this.shields.push({ net, shieldNet, gap: g !== undefined ? this.conv(num(g)) : undefined });
        const res = shieldRoutes(this.design, this.ensureRouter().routes(), net, shieldNet, this.shields[this.shields.length - 1].gap);
        this.log(`shield ${net}: ${res.guards} guard traces of ${shieldNet}, ${res.vias} stitching vias`); break;
      }
      case 'testpoint': case 'protect': case 'unprotect': case 'fix': case 'unfix': case 'check': case 'tax': case 'cost': case 'limit': case 'circuit': case 'forget':
        this.log(`${cmd}: accepted (no-op in OpenRoute 0.1)`); break;
      case 'delete': this.router = null; this.board = null; break;
      case 'write': this.cmdWrite(a(0).toLowerCase(), a(1)); break;
      case 'read': {
        const what = a(0).toLowerCase();
        if (what === 'session' || what === 'routes' || what === 'wires' || what === 'wire') {
          const text = this.opts.files.read(this.resolvePath(a(1)));
          const ses = parseSession(text, this.design.resolution);
          this.readRoutes = ses.routes;
          // the gridless router reads sessions itself: only build the lattice when it is (or will be) used
          if (this.router || !args.some((x) => isAtom(x) && String(x).toLowerCase() === 'gridless')) this.ensureRouter().importRoutes(ses.routes);
        } else this.log(`read ${what}: unsupported`);
        break;
      }
      case 'report': this.cmdReport(a(0).toLowerCase(), a(1)); break;
      case 'do': this.run(this.opts.files.read(this.resolvePath(a(0)))); break;
      case 'quit': case 'exit': this.quitRequested = true; break;
      default: this.log(`unknown command: ${cmd}`);
    }
  }

  /**
   * OpenRoute extension: declare a via padstack with a layer span (through, blind or buried) and make it
   * usable by the router. Sizes are in the current unit; layers are board layer names (or indices).
   * The name follows KiCad's convention (Via[from-to]_<diameter>:<drill>_um) so a KiCad session import
   * recovers the drill and the layer pair.
   */
  defineVia(diameter: number, drill: number, fromLayer: string, toLayer: string, name?: string): void {
    const d = this.design;
    const layers = d.structure.layers;
    const li = (s: string) => { const i = layers.findIndex((l) => l.name === s); return i >= 0 ? i : (/^\d+$/.test(s) ? Number(s) : -1); };
    let b0 = li(fromLayer), b1 = li(toLayer);
    if (b0 < 0 || b1 < 0 || b0 >= layers.length || b1 >= layers.length) { this.log(`define via: unknown layer ${fromLayer} / ${toLayer}`); return; }
    if (b0 > b1) [b0, b1] = [b1, b0];
    const dia = this.conv(diameter), dr = this.conv(drill);
    const toUm = (v: number) => Math.round(v / unitToResolution('um', d.resolution));
    const psName = name ?? `Via[${b0}-${b1}]_${toUm(dia)}:${toUm(dr)}_um`;
    const shapes = [];
    for (let i = b0; i <= b1; i++) shapes.push({ kind: 'circle' as const, layer: layers[i].name, diameter: dia, center: { x: 0, y: 0 } });
    d.library.padstacks.set(psName, { name: psName, shapes, attach: false });
    if (!d.structure.vias.includes(psName)) d.structure.vias.push(psName);
    if (this.router) this.log('define via: router already built; the via applies to later sessions only');
    this.log(`define via ${psName}: layers ${layers[b0].name}..${layers[b1].name}`);
  }

  private cmdRule(args: SList): void {
    const level = isAtom(args[0]) ? String(args[0]).toLowerCase() : '';
    let target: RuleSet | undefined;
    let rest: SList;
    if (level === 'pcb') { target = this.design.structure.rule; rest = args.slice(1); }
    else if (level === 'net') { const n = this.design.network.nets.get(String(args[1])); if (n) { n.rule ??= emptyRuleSet(); target = n.rule; } rest = args.slice(2); }
    else if (level === 'class') { const c = this.design.network.classes.get(String(args[1])); if (c) { c.rule ??= emptyRuleSet(); target = c.rule; } rest = args.slice(2); }
    else if (level === 'layer') { const l = this.design.structure.layers.find((x) => x.name === String(args[1])); if (l) { l.rule ??= emptyRuleSet(); target = l.rule; } rest = args.slice(2); }
    else { this.log(`rule: unsupported level ${level}`); return; }
    if (!target) { this.log(`rule: unknown object ${String(args[1])}`); return; }
    if (this.router) this.log('rule: router already built; rule applies to later sessions only');
    for (const f of rest) {
      if (!isList(f)) continue;
      const h = head(f);
      if (h === 'width') target.width = this.conv(num(f[1]));
      else if (h === 'clearance') {
        const v = this.conv(num(f[1]));
        const types = children(f, 'type');
        if (!types.length) target.clearance.set('default', v);
        for (const t of types) for (const k of atoms(t)) target.clearance.set(k.toLowerCase(), v);
      }
    }
  }

  /** The routes as written out: the router's copper, mitered when `miter` was given. */
  finalRoutes(): SessionRoutes {
    let r = this.shapeRoutes ?? this.ensureRouter().routes();
    if (this.gloss.critic) r = criticRoutes(this.design, r).routes;
    if (this.gloss.center) r = slideRoutes(this.design, r, 'center').routes;
    if (this.gloss.spread) r = slideRoutes(this.design, r, 'spread', this.gloss.spread).routes;
    if (this.gloss.fatten) r = fattenRoutes(this.design, r, this.gloss.fatten).routes;
    if (this.smoothMode) r = smoothRoutes(this.design, r, { any: this.smoothMode === 'any' }).routes;
    if (this.taperSteps) r = taperRoutes(this.design, r, { steps: this.taperSteps }).routes;
    if (this.miterOn) r = miterRoutes(this.design, r, this.miterLength ? { length: this.miterLength } : {}).routes;
    if (this.arcOn) r = arcRoutes(this.design, r, this.arcRadius ? { radius: this.arcRadius } : {}).routes;
    if (this.tuneOn) r = tuneRoutes(this.design, r, { viaLength: this.tuneViaLength, phase: this.tunePhase }).routes;
    for (const s of this.shields) r = shieldRoutes(this.design, r, s.net, s.shieldNet, s.gap).routes;
    if (this.gloss.teardrop) r = teardropRoutes(this.design, r).routes;
    return r;
  }

  private bestsaveScore = Infinity;
  /** bestsave: write the session only when the routing is at least as good as the best one saved so far. */
  private maybeBestsave(): void {
    if (!this.bestsaveFile || !this.router) return;
    const s = this.router.score();
    if (s > this.bestsaveScore) { this.log(`bestsave: current state (${s}) worse than saved best (${this.bestsaveScore}); kept the saved session`); return; }
    this.bestsaveScore = s;
    this.opts.files.write(this.bestsaveFile, writeSession(this.design, this.opts.designFile, this.finalRoutes()));
  }

  private cmdWrite(what: string, file: string): void {
    const path = this.resolvePath(file || `${this.design.id}.${what === 'session' ? 'ses' : what === 'routes' ? 'rte' : 'txt'}`);
    if (what === 'session') { this.opts.files.write(path, writeSession(this.design, this.opts.designFile, this.finalRoutes())); this.wroteSession = true; this.log(`wrote session ${path}`); }
    else if (what === 'routes' || what === 'wires' || what === 'wire') { this.opts.files.write(path, writeRoutes(this.finalRoutes())); this.log(`wrote routes ${path}`); }
    else this.log(`write ${what}: unsupported`);
  }

  private cmdReport(what: string, file: string): void {
    const r = this.ensureRouter();
    let text = '';
    if (what === 'status') text = r.statusReport();
    else if (what === 'congestion') text = r.congestionReport();
    else if (what === 'conflicts' || what === 'conflict' || what === 'drc') {
      const b = new Board(this.design);
      applyRoutes(b, this.finalRoutes());
      const v = runDrc(b).filter((x) => x.kind !== 'keepout' || x.a.kind !== 'pad');
      text = `# DRC: ${v.length} violation(s)\n` + v.slice(0, 200).map((x) => `${x.kind} ${x.a.net ?? ''}${x.b ? ' vs ' + (x.b.net ?? x.b.kind) : ''} layer ${this.board!.layerNames[x.layer] ?? x.layer} at (${x.at.x},${x.at.y}) dist=${x.distance.toFixed(0)} need=${x.required}`).join('\n') + '\n';
    } else { this.log(`report ${what}: unsupported`); return; }
    if (file) this.opts.files.write(this.resolvePath(file), text); else this.log(text);
  }
}
