# openpcb reference

Detailed documentation for OpenRoute, OpenBoard, OpenSchematic and the `openpcb` CLI. For downloads and a quick start see the [README](../README.md).

Each program covers the workflow of a familiar commercial tool:

| Cadence product | Our version | Package |
|---|---|---|
| Allegro PCB Router 2022 (`specctra.exe`) | **OpenRoute** — adaptive multi-pass autorouter, SPECCTRA design language in/out, do-file scripting, CLI and browser worker | `packages/router` |
| Allegro PCB Editor (`allegro.exe`) + SPIF bridge | **OpenBoard** — browser PCB layout editor with footprints, nets, traces/vias, DRC, DSN export, SES import and a one-click "Route Automatic" flow | `packages/editor` |
| OrCAD Capture (`Capture.exe`) / Allegro System Capture | **OpenSchematic** — schematic capture: editor, hierarchy, symbol editor, ERC, annotation, netlists to OpenBoard / Allegro / KiCad / SPICE, BOM, PDF, variants, SPICE simulation, constraint manager, team design, OpenSKILL; imports OrCAD (.DSN/.OLB), KiCad and Altium designs | `packages/schematic` |

Both are TypeScript. The router has no runtime dependencies; the editor bundles the router into a Web Worker, so routing runs locally in the browser.

## Quick start

```bash
npm install
npm run build
npm test                                  # router unit tests (parser, DRC, routing, do-file interpreter)
npm run editor                            # http://localhost:5174  (OpenBoard)
npm run route -- board.dsn -do route.do   # OpenRoute CLI, writes board.ses
```

CLI usage mirrors the SPECCTRA command line:

```
openroute <design.dsn> [-do file.do] [-ses out.ses] [-passes N] [-quit] [-nog] [-s status.sts] [-pitch units] [-maxcells N] [-fast [w]] [-resume prev.ses] [-edge units]
```

Without `-do`, the router runs `smart_route` (fanout → 25 passes → 2 clean → 50 passes from cost row 16 → 4 clean) and writes `<design>.ses` next to the design.

A do file uses the same vocabulary as an Allegro-generated `<name>_route.do`:

```
unit mil
rule pcb (width 7) (clearance 7 (type wire_wire))
status_file $/route.sts
fanout
route 25
clean 2
route 50 16
clean 4
write session $/final.ses
report status $/final.sts
```

Supported commands: `unit`, `rule pcb|net|class|layer (width …) (clearance … (type …))`, `grid wire|via|smart`, `direction <layer> …`, `set diagonal on|off`, `select net …`, `status_file`, `bestsave on <file>`, `fanout`, `route N [start] [(remove on)]`, `clean N`, `smart_route`, `write session|routes <file>`, `report status|conflicts [<file>]`, `do <file>`, `quit`. Post-route commands of the original (`miter`, `critic`, `spread`, `center`, `testpoint`, …) are accepted and logged as no-ops.

## How OpenRoute works

| Part | OpenRoute module |
|---|---|
| SPECCTRA design language reader/writer and session writer | `sexpr.ts`, `dsn.ts`, `session.ts` — `(resolution)`/`(unit)` scoping, `string_quote`, `circ`/`poly`/`clear` legacy keywords, multiple `(rule)` forms, `(layer … (use_net))` planes |
| Shape database | `board.ts` — placed pads (with back-side layer mirroring and rotation), vias, wires, keepouts, planes as exact geometry (circle / polygon / stadium) in a spatial hash |
| Rule hierarchy | `rules.ts` — pcb < layer < class < net precedence, typed clearances (`wire_wire`, `pin_via`, …), `use_via`, `use_layer`, priority |
| Routing space | `route/lattice.ts` — a routing lattice whose fixed maps store, per cell, the *effective* distance (actual minus typed clearance) to the nearest copper and the nearest copper of a *different* net; dynamic centre-line and mark maps record where routed copper is, allowing conflicts |
| Maze router | `route/astar.ts` — A* over (x, y, layer) with wrong-way, via, bend and conflict costs, windowed search with bounding-box heuristic |
| adaptive passes, cost table, rip-up/reroute, `remove` mode, `clean`, `fanout`, `smart_route`, bestsave | `route/router.ts` — sequential rip-up and reroute against the live board, conflict cost rising 1.6× per pass (the "cost table" row = `start_pass`), clean passes that only accept improvements, plane fanout, best-result checkpointing, SPECCTRA-style status report |
| shape-based DRC (`report conflicts`) | `drc.ts` — exact distance checks between all copper pairs with the resolved pair clearance |
| do-file / did-file interpreter + command dispatch | `commands.ts` |
| `specctra` command line | `cli.ts` |

Design choices: routing search runs on a lattice (pitch defaults to half of width+clearance, so fine-pitch parts are enterable) with exact shape geometry used for obstacle distances and final DRC, instead of corner-stitched tiles; orthogonal routing by default (`set diagonal on` enables 45°).

## How OpenBoard works

- `model.ts` project (mm): layers, outline, footprints, components, nets, rules, traces, vias, keepouts.
- `footprints.ts` parametric library (chip, SOIC, DIP, QFP, SOT-23, headers, BGA, mounting hole).
- `view.ts` canvas renderer; `main.ts` tools: Select/move, Place, Trace (V drops a via and switches layer), Via, Net assignment by clicking pads, Keepout, rotate/flip/delete/undo.
- `connectivity.ts` ratsnest from real copper connectivity (union-find over pads, traces, vias).
- `dsnio.ts` is our SPIF: `projectToDesign`/`exportDsn` (user-drawn traces exported as `protect`ed wiring so the router keeps and connects to them), `importSession` (replaces autorouted copper of routed nets), `importDsn` (opens KiCad/Cadence DSN files as projects).
- `drc.ts` runs the router's exact DRC on the exported design.
- `worker.ts` runs OpenRoute in a Web Worker; **Route Automatic** / **Route Custom…** correspond to Allegro's `auto_route` / `custom_route` (the dialog shows the generated do-file for editing, like `<name>_custom_route.do`).

Projects autosave to `localStorage`; **Save/Open** use JSON files.

## OpenBoard DRC

The **DRC** button (F7 in the desktop app) runs the router's exact shape-based clearance check on the exported design plus the checks the router cannot do:

| Check | Rule fields |
|---|---|
| copper clearance (typed pairs), keepouts, copper outside the outline | `width`, `clearance`, keepout rectangles |
| unconnected pads (open ratsnest connections) | — |
| track width minimum (board rule and per-net width) | `minTrackWidth` |
| annular ring of through-hole pads and vias | `minAnnularRing` |
| drill edge to copper of another net, drill edge to drill edge | `holeToCopper`, `holeToHole` |
| static pour to other-net copper (dynamic pours are re-filled by the host and skipped) | zone `clearance`, `static` flag |
| differential pairs: coupling gap, uncoupled length, length skew | Constraints… dialog |
| net length min/max and matched-length groups (vias add `viaLength`) | Constraints… dialog |
| silkscreen to pads, silkscreen off the board, silkscreen over holes | `silkToCopper`, `silkWidth` |
| solder-mask webs between neighbouring openings | `maskExpansion`, `minMaskSliver` |

Rules live in the Rules panel (**Manufacturing rules** disclosure); pairs, length groups, net length limits and zones are edited in **Constraints…** (one entry per line) or drawn with the **Zone** tool (Z).

**Pours and real connectivity.** The live ratsnest treats a copper pour as joining everything of its net inside the pour outline. A real pour is cut back around every other-net pad, trace and via, so a pad deep inside a BGA can sit on a copper island that reaches nothing. `openpcb pourcheck <project>` (and `openpcb drc <project> --pours`, which adds `pour-island` markers) rasterises every pour exactly as the Gerber export draws it and union-finds pads, traces, vias and islands per net. Run it before ordering a board with outer-layer pours. Blind vias (outer layer to an inner one) are laser drilled, as single or stacked microvias, and use the microvia annular-ring rule.

## openpcb — command line for scripts and AI agents

`packages/cli` wraps the editor core (model, footprints, DSN/SES bridge, DRC, SVG render) and the router in a JSON-in/JSON-out CLI, so an agent can build and route a board without a GUI:

```bash
npm run openpcb -- new board.openboard.json --layers 2 --width 80 --height 60
npm run openpcb -- footprints
npm run openpcb -- add board.openboard.json SOIC-8 U1 20 15 --value MCU
npm run openpcb -- add board.openboard.json Header_1x4 J1 8 20 --rot 90
npm run openpcb -- net board.openboard.json VCC U1-8 J1-1
npm run openpcb -- zone board.openboard.json GND B.Cu 1 1 79 59
npm run openpcb -- route board.openboard.json            # or --script route.do, --passes N, --fast 1.5
npm run openpcb -- drc board.openboard.json              # exit code 2 when violations exist
npm run openpcb -- render board.openboard.json board.svg # picture for the agent
npm run openpcb -- export-dsn board.openboard.json board.dsn
npm run openpcb -- batch board.openboard.json commands.json   # [["add","R_0603","R1",5,5],["net","VCC","R1-1","U1-8"],["route"],["drc"]]
```

`openpcb help` prints the full command list (`info`, `move`, `remove`, `unnet`, `rules`, `trace`, `via`, `unroute`, `ratsnest`, `import-dsn`, `import-ses`).

## Windows desktop app

`packages/desktop` is an Electron shell with two windows — OpenBoard (PCB) and OpenSchematic (schematics), switched with *Window* (Ctrl+1 / Ctrl+2) — native Save dialogs, cross-probing between the windows, and the CLI bundled next to it:

```bash
npm run build          # router, editor, schematic, cli
npm run desktop        # packages/desktop/release/win-unpacked/OpenBoard.exe and OpenBoard-0.1.0-portable.exe
npm run desktop:start  # run from source
```

`openpcb.cmd` (in the `resources` folder next to `OpenBoard.exe`) runs the same CLI through OpenBoard.exe in Node mode (`ELECTRON_RUN_AS_NODE=1`), so no separate Node.js install is needed on the target machine; add that folder to PATH or call it by full path. `OpenSchematic.cmd` (same folder) starts the app with the schematic window (`OpenBoard.exe --schematic`). Resume a long routing run from its best-so-far session with `openroute … -resume prev.ses` (do-file: `read session prev.ses`).

## OpenSchematic (schematic capture)

`packages/schematic` is the OrCAD Capture / System Capture counterpart. In a browser: `npm run schematic` serves OpenBoard at `http://localhost:5174/` and OpenSchematic at `/schematic/` (same origin, so the two pages cross-probe).

**Editor.** Parts from libraries (browser with search and preview), wires (orthogonal, ends automatically on pins), buses and bus entries, net aliases, power / ground, hierarchical ports and blocks (double-click descends, Ctrl+U ascends), off-page connectors, no-connects, junctions, text and graphics; move with rubber-banding wires, rotate (R), mirror (X), copy / paste, undo / redo; project tree of schematic folders and pages; property editor and a spreadsheet property editor for all parts; find and replace; net browser with highlighting across pages (Ctrl+click a wire). *Tools*: annotate / reset, ERC (with an editable pin-type matrix), forward annotation to OpenBoard (*Create netlist*), back annotation from a board, variants (DNP and value overrides), part database (CIS) link from a CSV, constraint manager, design differences, symbol editor (pins and graphics as text, multi-unit, box-symbol generator). *Simulate*: bias point, transient and AC with plots (built-in SPICE: R, L, C, sources, diodes, BJTs, MOSFETs, op-amp macro). *Team*: connect to `openpcb sch-collab-serve`, reserve / release pages, chat, checkpoints. The bottom pane has the session log, an OpenSKILL console (`schParts()`, `schFindPart("R1")~>value = "10k"`, …) and the simulation plot.

**Imports.** Allegro Design Entry HDL (Concept) projects (`.cpm` + `cds.lib` libraries: `.csa` pages and `symbol.css` symbols drawn as in the original, hierarchical cells as blocks; symbol orientation and rotation pivot fitted to the wiring), Allegro System Capture design archives (`.sdax`: the logic from the CSSchema connectivity file and the part objects — parts, properties, reference designators, nets, differential pairs — drawn automatically; gates sharing a designator become units of one package), OrCAD Capture `.DSN` designs and `.OLB` libraries (OLE compound files decoded record by record: symbols, packages with pin numbers per unit, heterogeneous parts, pages, the occurrence tree with per-instance references and units, blocks implemented by other `.DSN` files), KiCad schematics (hierarchical sheets, reused sheets) and symbol libraries, Altium `.SchDoc`.

Checked against the originating tools' own netlists: OrCAD FullAdder (hierarchy with two instances of one block) and Fault-Detector match Allegro's `pstxnet.dat` net for net; on 15 OrCAD sample designs (68 pages) all 1,645 multi-pin page nets agree with the connectivity Capture stored in the files; all 34 Capture libraries (20,151 parts) import; all 11 System Capture sample archives (162 nets) match their stored connectivity; on 56 Design Entry HDL sample projects 633 of 662 multi-pin nets of the stored connectivity come out identical (the rest are mostly bus-member naming); a 4-sheet, 194-part KiCad project matches KiCad's netlist exactly, net names included.

**Command line** (`openpcb sch-…`, JSON out):

| Command | |
|---|---|
| `sch-new`, `sch-import-orcad`, `sch-import-orcad-lib`, `sch-import-syscap`, `sch-import-dehdl`, `sch-import-kicad`, `sch-import-kicad-lib`, `sch-import-altium`, `sch-info` | create / import |
| `sch-add-part`, `sch-wire`, `sch-label`, `sch-power`, `sch-port`, `sch-offpage`, `sch-noconnect` | edit |
| `sch-annotate`, `sch-erc`, `sch-xref`, `sch-compare a b`, `sch-replace d find repl`, `sch-db-link d parts.csv` | check / maintain |
| `sch-netlist --format kicad\|telesis\|edif\|spice\|json`, `sch-bom`, `sch-pdf`, `sch-svg` | outputs |
| `sch-to-board design board.openboard.json`, `sch-back-annotate` | ECO with OpenBoard (constraints travel along: net classes, widths, clearances, length limits, differential pairs, match groups — see `sch-constraints`) |
| `sch-simulate --op / --tran step,stop / --ac start,stop,ppd --probe nets` | SPICE |
| `sch-skill design [script.il] [--eval expr] [--save]` | OpenSKILL with the `sch*` API |
| `sch-collab-serve design [--port 7778]` | team design server (page reservations, versions, checkpoints) |


## Router options for large boards

`-fast [w]` enables weighted A* (default 1.5: about 3× faster first pass, slightly longer paths); `-maxcells N` raises the lattice cell cap (the default 4 M cells coarsens the pitch on big boards; 17 M was used for a 217 × 187 mm 8-layer board at 0.1 mm); a do-file with `bestsave on <file>` saves the best session after every command, which keeps partial results on multi-hour runs.

To meet a target CAD tool's rules that the DSN does not carry, set them in the do-file before the first routing command. For a KiCad board with `min_hole_clearance 0.25` and `min_copper_edge_clearance 0.5` (via 0.45/0.2 mm):

```
unit mm
rule pcb (clearance 0.13 (type via_via via_smd via_pin via_wire))   # via hole edge keeps 0.25 mm from other copper
set edge_clearance 0.5                                               # copper to board outline
read session $/previous_best.ses                                     # optional: resume; copper that breaks the new rules counts as conflicts and is rerouted
route 3 7
```

`set max_expansions <n>` raises the per-search budget (default 3 M). When an exact search fails, the router retries it once with weighted A* and twice the budget, which is what lets long connections (85 mm JTAG lines across a dense board) through.

**Planes vs pours.** Only a plane polygon on a non-routing (power) layer connects pads. A plane on a routing layer (an outer-layer GND pour) is filled after routing and cannot be trusted to reach a pad, so every SMD pad of a plane net fans out to a real inner plane. Fanouts keep every via they use on the way (a microvia down to the layer a buried via starts from), never place the plane via overlapping one of their own vias unless exactly stacked, and when a pad has no room for a via of its own they join same-net copper that already reaches the plane (a shared via). `clean` keeps connections that ride on other copper joined, and a resumed session's plane fanouts count as connected.

`set edge_clearance <v>` (CLI `-edge <units>`), `set fast <w>` and `set max_expansions <n>` are OpenRoute extensions of the SPECCTRA `set` command. Paths with spaces must be quoted in do-file commands (`read session "C:/My Boards/x.ses"`); the CLI quotes its own paths.

## Results on the Cadence tutorial board

`share/specctra/tutorial/lesson1.dsn` (6 layers, 2 planes, 72 nets, 247 connections, 1.4 M lattice cells): `smart_route` reaches 100 % completion with 0 conflicts and 400 vias in about 4.5 minutes (the first pass takes ~40 s, later passes well under a second; clean passes ~10 s each). `examples/check_connectivity.mjs <dsn> <ses>` verifies a session independently (union-find over the actual copper) and reports 0 open connections for both the tutorial and `examples/demo.dsn`. The synthetic test boards route completely and pass the shape-based DRC.

## Examples

```bash
npm run route -- examples/demo.dsn -do examples/route.do     # writes examples/demo.ses, demo.sts, demo_drc.txt
node examples/check_connectivity.mjs examples/demo.dsn examples/demo.ses
```

## Layout

```
packages/router/src      OpenRoute (library + CLI); tests in src/test
packages/editor/src      OpenBoard (browser app); build.mjs bundles with esbuild, serve.mjs serves dist/
packages/schematic/src   OpenSchematic (browser app + importers); build.mjs, serve.mjs
packages/cli/src         openpcb command line (board and sch-… commands); tests in packages/cli/test
packages/desktop         Electron shell for Windows (OpenBoard + OpenSchematic windows, bundled CLI)
```

### Automatic placement (Quickplace / Autoplace)

OpenBoard has the two placement automations Allegro offers. **Quickplace** (`openpcb place … --mode quick`, editor button *Quickplace*) lays the unlocked parts out in rows by reference designator inside the outline, the usual first step after a netlist import. **Autoplace** (`openpcb place`, editor button *Autoplace*) is a simulated-annealing placer: it moves, rotates (90° steps) and swaps the unlocked parts to minimise the ratsnest wirelength (half-perimeter per net, nets with more than 8 pins down-weighted so power and ground do not pull every capacitor to the centre), keeps bodies `--spacing` apart, inside the outline by the edge clearance, and clear of locked parts. Sides never change. In the editor a selection restricts placement to the selected parts; `Locked` in the properties panel (or `--lock`) holds a part. Results: sensor-node example 387 → 197 mm wirelength, routed 100 %; a 290-part 10-layer board (BGA/DDR/connectors locked) 20 617 → 17 178 mm in 1.7 s with 150 iterations per part. Rooms and side assignment are not implemented; use `--only` and `--lock` to place a region at a time.

Two placement controls keep autoplace from undoing a board's intent: **decoupling affinity** (`--decap <w>`, default 2) links every two-pad part between a power net and ground to its own power pin of an IC (nearest unclaimed pin first) and charges the annealer for the distance, so caps end up next to the pins they decouple (a back-side cap can sit right under its BGA ball); **net weights** (`--weight "CH\d_(RXP|RXN)=30,CLK_Y\d=6"`, regex = weight, first match wins) keep RF and clock nets short. Lock the parts that define the architecture (connectors, RF chain, big BGAs) with `--lock` and let autoplace re-place the rest.


### Blind, buried and micro vias (via spans)

Every usable via padstack is a *via type* with a layer span: the layers its shapes cover. OpenRoute builds one fixed-obstacle map per via type and keeps via occupancy per layer, so a blind via only blocks the layers it passes, stacked and staggered microvias come out of the search naturally, and a layer change picks the smallest span that covers it (a through via is only used where nothing shorter fits). Per-net `use_via` lists restrict the types a net may use; fanout picks a type that physically reaches the net's plane layer.

Declaring spans:

- do-file / CLI (OpenRoute extension): `define via <diameter> <drill> <fromLayer> <toLayer>` in the current unit, or `openroute … -via 0.25:0.1:F.Cu:In1.Cu -via 0.25:0.1:In2.Cu:B.Cu` (mm). The padstack is named the KiCad way (`Via[0-1]_250:100_um`), so a KiCad session import recovers the layer pair and the drill.
- OpenBoard: *Constraints → Via types* (`diameter drill fromLayer toLayer` per line), or `openpcb rules <project> --via-type 0.25:0.1:F.Cu:In1.Cu,0.4:0.2:In1.Cu:In2.Cu` (`--clear-via-types` resets). The through via from the rules always exists. Imported sessions and DSNs keep each via's span; blind vias draw with a dashed ring.
- Rules: `minMicroviaDiameter` / `minMicroviaDrill` (a microvia spans two adjacent layers) are checked by the DRC (`microvia-size`), together with `via-span`; hole-to-copper and hole-to-hole checks only consider copper on the layers a hole actually passes.

Why it matters: on dense boards the conflicts are often via-to-via in the 0.8 mm BGA field, where every 0.45 mm through via blocks all four signal layers. With `-via 0.25:0.1:F.Cu:In2.Cu` (and the matching B.Cu span) the escapes become microvias that free the inner layers.


### Fabrication output (Gerber + drill)

`openpcb gerber <project> <outdir> [--zip]` (editor button *Gerbers*, downloads a zip) writes what a fab such as JLCPCB needs:

| File | Content |
|---|---|
| `<name>-<layer>.gbr` | one copper layer per stack layer: pours with clearances and thermal reliefs, traces, pads, vias (blind/buried vias only on the layers they span) |
| `<name>-F_Mask.gbr`, `B_Mask` | pad openings grown by `maskExpansion`; vias tented |
| `<name>-F_Paste.gbr`, `B_Paste` | SMD pads |
| `<name>-F_Silkscreen.gbr`, `B_Silkscreen` | footprint outlines (not imported reference graphics) and reference designators (stroke font, mirrored on the bottom) |
| `<name>-Edge_Cuts.gbr` | board outline |
| `<name>-PTH.drl` | through vias and through-hole pads |
| `<name>-<from>-<to>.drl` | one Excellon file per blind/buried via span, as HDI fabs expect |

Gerber is RS-274X with X2 file attributes (4.6 mm); pours are dark regions followed by clear-polarity clearances, with thermal spokes re-cut against other-net clearances, so no polygon library is needed and no spoke can bridge to another net. Excellon is metric, decimal. Checked with an independent Gerber/Excellon rasterizer on the sensor node, a 4-layer HDI test board and board C (8 layers, 6 planes, 5 drill files).

### Post-route: miter

`miter [leg]` in a do-file (OpenBoard: add it to a Route Custom script) turns 60–120° corners into chamfers (default leg 1.5 × width). Every chamfer is clearance-checked against other-net copper, including chamfers already added, and a corner where same-net copper attaches is left square, so mitering never adds a DRC error or breaks a T-junction. Once given, every written session, bestsave and conflict report is mitered; `unmiter` turns it off.

### Assembly output (BOM + pick-and-place)

`openpcb assembly <project> <outdir>` (editor button *BOM/CPL*) writes `<name>-BOM.csv` (`Comment,Designator,Footprint,JLCPCB Part #`, grouped by value and footprint) and `<name>-CPL.csv` (`Designator,Mid X,Mid Y,Layer,Rotation`, in the Gerber coordinate frame). Mounting holes, fiducials and parts valued `DNP` are left out. The part-number column is empty for you to fill in, and rotations are the layout rotations: JLCPCB's preview may need per-footprint rotation corrections, as with any EDA tool.

### Rules, fanout, pairs and tuning (OpenRoute)

- **Rule hierarchy** (DSN): `(layer_rule <layer> (rule …))` in nets and classes, `(class_class (classes A B) (rule …))`, `(fromto <pin> <pin> (rule (width …)))`, `(region <id> <shape> (rule …))` (plus `region_class`), and circuit limits `(max_total_vias n)`, `(length max [min])`, `(match_net_length on (tolerance t))`. Precedence: pcb < layer < region < class < class layer_rule < class_class < net < net layer_rule < fromto. The router reserves each net's widest width, emits the per-layer / per-from-to width, and enforces `max_total_vias` in the search; region rules apply in the search (per lattice cell), in the output widths and in the checker.
- **Signal fanout**: `fanout signal [minPins] [outerRows]` (or `fanout all`) escapes the pins of BGAs / fine-pitch parts (≥ minPins, default 32) that sit deeper than `outerRows` (default 2) from the part edge with a dog-bone to a via, before the main passes; plain `fanout` still does plane pins only.
- **Differential pairs**: `(pair (nets P N) (rule (gap g) (tolerance t)))` in the network (OpenBoard exports its Constraints → differential pairs this way). Once one net of a pair is routed, the other is pulled into a lane at exactly width + gap from it on the same layer, so the pair runs coupled.
- **Length tuning**: `tune [via_length]` adds clearance-checked serpentines so that the shorter net of each pair matches its partner, every net of a `match_net_length` class matches the longest, and nets reach their `length` minimum; nets that cannot be tuned are reported `NOT MET`. OpenBoard's length groups and net min/max lengths are exported and its default route script ends with `tune <viaLength>` when the board has any, so the router and OpenBoard's length DRC count length the same way.
- **Vias**: same-net vias are either stacked exactly (blind on buried, allowed by HDI fabs) or kept pad-clear, including a path's own consecutive layer changes; redundant vias (same spot, span inside another) are merged on output. OpenBoard's DRC checks laser (blind) holes against `laserHoleToCopper` / `laserHoleToHole` (JLCPCB defaults 0.15 / 0.24 mm, 0.13 mm same net) and only compares holes whose layer spans overlap.

### Post-route, manufacturing prep and signal-integrity rules

| Do-file command (OpenRoute) | Effect |
|---|---|
| `critic` | trims dangling wire ends and removes out-and-back notches (when the shortcut is clear) |
| `filter` | rips up connections that still have conflicts (they become unroutes), as SPECCTRA does |
| `center` | slides wire segments to the middle of their channel |
| `spread [gap]` | slides wire segments away from close neighbours where there is room |
| `fatten [width]` (`gloss`) | widens wires where the wider copper still keeps clearance |
| `miter [leg]` | 45° chamfers on corners |
| `tune [via_length]` | serpentines for pair skew, matched groups and minimum lengths |
| `teardrop` | tapered copper where a wire meets a larger pad or via |
| `shield <net> [shield_net] [gap]` | guard traces of the shield net (default GND) beside the net, stitched with vias |

Every change is clearance-checked against other-net copper (including changes already made), so none of them can add a DRC error; once given, they are applied in that order to every written session. A `(bus on)` class routes its nets side by side, each following the previous one at minimum spacing.

OpenBoard: **Test points** (`openpcb testpoints <project> [--dia] [--side] [--spacing]`) gives every net without probe access a round test pad on the chosen side, on one of its vias or traces, keeping copper, hole-to-copper, mask-sliver, edge and probe-spacing rules; test pads are `TP<n>` components and are left out of the BOM. The DRC has **crosstalk** checks (`parallelGap`/`parallelLimit` on one layer, `tandemGap`/`tandemLimit` on adjacent layers; 0 = off) reporting net pairs coupled longer than the limit, and **laser-hole** rules for blind vias.

### Global routing and interactive routing

- `groute [rounds]` (OpenRoute): global routing on a coarse tile grid (16 × 16 lattice cells per tile) with negotiated congestion — tile capacity from free area, track pitch and layer count; overflow penalised and remembered round to round (PathFinder). Each connection gets its global path, dilated by one tile, as a corridor that the detail search prefers (30 % extra cost outside: a bias, not a wall). `report congestion [file]` lists the most over-subscribed tiles with location, usage and capacity.
- OpenBoard **Route net** autoroutes the highlighted / selected nets while every other trace stays as fixed copper (`openpcb route <project> --nets A,B` does the same from the CLI).
- **Shove** (checkbox, on by default): when a hand-drawn trace crowds other nets' unlocked copper, that copper is pushed aside geometrically (see *Route editing* below); nets that cannot be pushed are ripped up and rerouted around the new trace.
- **Live length feedback**: while drawing a trace on a net with a min/max length, a differential-pair partner or a length group, the status bar shows the net's length (routed + draft + via length) against its target and how much is short or long.

### Libraries, netlists and more outputs (OpenBoard)

| Command / button | What it does |
|---|---|
| `openpcb import-footprint <project> <file.kicad_mod \| Lib.pretty> …` / *Import footprint…* | KiCad footprints (pads with shape, size, drill and rotation; silkscreen lines, rectangles, circles, polygons) into the project library; a `.pretty` folder imports as `Lib:Name` |
| `openpcb import-netlist <project> <file.net> [--libs "<kicad footprints>;<project lib>"]` / *Import netlist…* | KiCad netlist: components (ref, value, footprint) and nets with two or more pins; `--libs` loads each missing `Lib:Name` from the given library roots. A 290-part board's netlist imports with all 314 parts, 251 nets and every footprint (KiCad standard + the project's `prc` library), pad-for-pad identical to the DSN import |
| *Footprint editor…* | edit the selected part's footprint as a pad table (`id x y w h shape [th drill] [rot]`) and silkscreen polylines; save under a new name to create a footprint |
| `openpcb ipc356 <project> <out.ipc>` | IPC-D-356A netlist for bare-board electrical test (metric `CUST 1`, 317 through / 327 SMD records with access side, drill, size, rotation, mask; long net names via `NNAME` aliases) |
| `openpcb vrml <project> <out.wrl>` | VRML 2.0 3D model: board outline extruded to its thickness plus component bodies |
| `openpcb impedance --w --h [--t] [--er] [--s] [--type stripline --b]` | trace impedance with the IPC-2141 closed forms (microstrip, stripline) and edge-coupled differential impedance |

### Gridless routing, field solver, thermal

| Command | What it does |
|---|---|
| `openpcb route <project> --gridless [--finish] [--passes N] [--time-limit s]` / do-file `shape_route [passes] [finish] [any] [time s]` | shape-based router: a visibility graph over the octagonal hulls of every obstacle (inflated by clearance + half width), A* with 45° doglegs, via kinds per layer span, negotiated rip-up with history costs, differential pairs routed as one coupled "carrier" and split into P/N, neck-down regions; `--finish` keeps existing copper and rips up only what violates the rules. Cadence tutorial board: 100 % routed, DRC clean |
| `openpcb fieldsolve <project> --layer L --width mm [--gap mm]` | 2-D quasi-static field solver (graded finite-difference mesh, PCG): Z0, εeff, delay, C/L matrices, odd/even/differential impedance, conductor (incremental inductance) and dielectric loss per GHz. Validated: air microstrip 123 Ω, FR-4 microstrip 49.3 Ω, stripline 56.5 Ω, zero FEXT in a homogeneous medium |
| `openpcb impedance-width <project> --layer L --z ohm [--gap mm]` | the field-solved width for a target impedance (single-ended or differential) |
| `openpcb field-si <project>` | impedance of every routed segment, pair impedance at actual spacing, loss, NEXT/FEXT of parallel runs |
| `openpcb part-power <project> <ref> <W>` + `openpcb thermal <project> [--svg]` | 3-D steady-state conduction through the stack-up (copper fill per cell, via barrels, convection on both faces); temperature map per layer; the energy balance closes exactly |

### RF, wire bonding, rigid-flex

| Area | Commands |
|---|---|
| RF | `rf-line` (impedance-controlled lines with optimal miters), `rf-stub` (open/short, radial), `rf-taper` (linear, exponential, Klopfenstein), `rf-coupled`, `rf-void` (reference-plane cut-outs), `rf-regen` (parametric regeneration), `rf-sim` (ABCD cascade, S-parameters, Touchstone .s2p), `rf-openems` (openEMS FDTD script) |
| Wire bonding | `bond-profile`, `bond-fingers` (finger rings around a die, rotated with it), `bond-wire`, `bond-drc` (wire-to-wire spacing in 3-D, length, landing angle), `bond-report`; wires appear in the STEP export |
| Rigid-flex | `flex-zone` (layers, coverlay), `bend` (axis, angle, radius, dynamic), `stiffener`, `flex-drc` (vias / pads / corners in bends, trace angle across bends), `export-step-bent` (the board folded along its bends) |

### Imports, MCAD exchange, collaboration, scripting

| Area | Commands |
|---|---|
| Imports | `import-altium <file.PcbDoc>` (OLE compound file, ASCII and binary records, rules from DXP rule records), `import-pads <file.asc>` (PADS ASCII: parts, part types, pin names, routes, rule sets) |
| MCAD (IDX) | `export-idx` writes EDMD 3.0 (vocabulary checked against Allegro's own IDX writer), `import-idx` applies MCAD moves / proposals, `export-idx-changes` an incremental proposal between two versions |
| Collaboration | `collab-serve <project> [--port]`: several OpenBoard windows edit one board over WebSocket — object-level operations with versions, locks, partitions (areas owned by one designer), cursors, chat, checkpoints and restore (Symphony / Pulse counterpart) |
| OpenSKILL | `skill <project> [script.il] [--eval expr] [--save]`: a SKILL interpreter (C-call and Lisp syntax, `procedure`, `foreach`, `let`, `~>`, `->`) with the `axl*` database API (`axlDBGetDesign`, `axlRun` runs any openpcb command); the editor has a script console |

### Constraints: net classes, class spacing, regions, split planes

| Command / dialog | What it does |
|---|---|
| `openpcb class <project> <name> [--nets a,b \| --match regex] [--width] [--clearance] [--vias …] [--layers …]` / *Constraints → Net classes* | net class with width, clearance, allowed via types and layers, priority; exported as DSN `(class …)` |
| `openpcb class-clearance <project> <A> <B> <mm>` / *Constraints → Class spacing* | class-to-class spacing (`class_class`); the router reserves it conservatively, the DRC checks it exactly |
| `openpcb region <project> <name> <rect \| polygon> [--width] [--clearance] [--classes A,B]` / *Constraints → Regions* | constraint area (neck-down under a BGA): inside it, its width/clearance override net and class rules, in the router's search (per cell), its output widths (wires are split at the boundary) and the DRC |
| `openpcb split-plane <project> <layer> <net>=<points> …` | split plane: several nets on one plane layer, earlier zone wins, with a gap; fanout vias are placed where the via actually reaches its own net's copper |

Hole rules reach the router too: `via_wire`/`via_smd`/`via_pin`/`via_via` clearances are derived from hole-to-copper / hole-to-hole (and the laser rules for microvias), and through-hole drills get via keep-out rings. NPTH pads (`Pad.npth`) have no copper and their own drill file.

### Route editing

| Command / button | What it does |
|---|---|
| `smooth [any]` (do-file) / `openpcb smooth <project> [--any] [--nets]` / *Smooth* (Shift = any angle) | gridless pull-tight: lattice staircases become direct 45° (or any-angle) runs off the 0.1 mm grid; every shortcut keeps the full rule set (hole rules included) and stays on any same-net pad, via or T-junction it touched. On two dense test boards 133 and 493 vertices were removed; both stay DRC-clean and fully connected |
| `arc [radius]` / `recorner arc` | arcs (polyline-approximated) instead of 45° chamfers |
| `taper [steps]` | stepped width transitions where a wide wire meets a narrow one |
| `tune phase` / `openpcb tune --phase` / *Tune*, *Detune* | low phase bumps for pair skew; *Detune* (Remove Tuning) restores the untuned copper |
| `openpcb trace-shove …` / editor trace tool with *Shove* | geometric push-and-shove: crowded traces of other nets are pushed aside to exactly the clearance (3 levels deep), vias move with their trace ends; what cannot be pushed is ripped up and rerouted |
| `openpcb stitch` / `fence` / `structure-save` / `structure-place` | via stitching arrays, guard-via fences along RF nets, reusable via structures |
| editor | copy/paste (Ctrl+C/V), redo (Ctrl+Y), measure (M), text (X), dimensions (D), rooms (O), pin/gate swap and component swap (*Autoswap*), DRC waivers, WebGL 3D view |

`set max_expansions N` raises the A* search budget; a failed exact search is retried weighted.

### Outputs, imports, manufacturing and analysis

| Area | Commands |
|---|---|
| Plots and data | `export-dxf`, `export-pdf` (one page per layer + assembly), `export-gds`, `export-odb` (ODB++ tree, zipped), `export-ipc2581`, fabrication drawing (drill chart + stack-up cross-section) in the Gerber set |
| MCAD | `export-step` (board + bodies; 290-part board: 229 solids, closed shells), `export-idf`, `export-idx` |
| Netlists, back-annotation | `export-netlist --format kicad\|telesis`, `rename-refdes` (geographic, writes a was/is list) |
| Imports | `import-gerber`, `import-eagle`, `import-kicad-pcb` (a 10-layer KiCad test board imports pad-for-pad identical to its DSN) |
| Manufacturing | `panelize` (mouse bites, V-score, rails, tooling holes, fiducials; DRC-clean panel), `variant` + `assembly --variant`, `backdrill` (must-not-cut layer, drill files), `thieving`, `coupon` |
| Analysis | `si` (impedance per layer from the stack-up, delay, reflections, critical length), `power` + `irdrop` (DC IR drop over traces, vias and meshed pours), `emi` (split crossings, missing references, return vias), `current` (IPC-2221 temperature rise), `clearance3d` (part heights), `compare`, `waive` |

Tests: `npm test` in `packages/router` (22 router tests) and `packages/cli` (integration tests: every board command on a synthetic board; gridless routing, field solver, thermal, RF, flex, wire bonding and OpenSKILL; and the schematic flows — OrCAD / KiCad imports against the reference netlists when those files are present, SPICE, the CLI flow, team design).
