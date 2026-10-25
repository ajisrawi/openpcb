// Collects the built editor (app/), the CLI with its dependencies (cli/) and the launcher script
// into this package before electron-builder packs them.
import { cpSync, mkdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..');
const editorDist = join(root, 'packages', 'editor', 'dist');
const schematicDist = join(root, 'packages', 'schematic', 'dist');
const cliDist = join(root, 'packages', 'cli', 'dist');
const routerDist = join(root, 'packages', 'router', 'dist');
if (!existsSync(editorDist) || !existsSync(schematicDist) || !existsSync(cliDist) || !existsSync(routerDist)) throw new Error('run `npm run build` at the repository root first');

rmSync(join(here, 'app'), { recursive: true, force: true });
rmSync(join(here, 'cli'), { recursive: true, force: true });
cpSync(editorDist, join(here, 'app'), { recursive: true });
cpSync(schematicDist, join(here, 'app', 'schematic'), { recursive: true });
// CLI tree: dist/cli/src/openpcb.js + dist/editor/src/*.js, importing @openpcb/router -> node_modules/@openpcb/router/dist
cpSync(cliDist, join(here, 'cli', 'dist'), { recursive: true });
mkdirSync(join(here, 'cli', 'node_modules', '@openpcb', 'router'), { recursive: true });
cpSync(routerDist, join(here, 'cli', 'node_modules', '@openpcb', 'router', 'dist'), { recursive: true });
writeFileSync(join(here, 'cli', 'node_modules', '@openpcb', 'router', 'package.json'), JSON.stringify({ name: '@openpcb/router', version: '0.1.0', type: 'module', main: 'dist/index.js' }, null, 1));
writeFileSync(join(here, 'cli', 'package.json'), JSON.stringify({ name: 'openpcb-cli', type: 'module', private: true }, null, 1));

writeFileSync(join(here, 'openpcb.cmd'), `@echo off\r
rem openpcb agent CLI - runs the OpenBoard binary as Node.js\r
setlocal\r
set ELECTRON_RUN_AS_NODE=1\r
set APPDIR=%~dp0\r
if exist "%APPDIR%OpenBoard.exe" (set EXE=%APPDIR%OpenBoard.exe) else (set EXE=%APPDIR%..\\OpenBoard.exe)\r
if exist "%APPDIR%resources\\cli\\dist\\cli\\src\\openpcb.js" (set CLI=%APPDIR%resources\\cli\\dist\\cli\\src\\openpcb.js) else (set CLI=%APPDIR%cli\\dist\\cli\\src\\openpcb.js)\r
"%EXE%" "%CLI%" %*\r
`);
writeFileSync(join(here, 'OpenSchematic.cmd'), `@echo off\r
rem OpenSchematic - the schematic editor window of OpenBoard.exe\r
set APPDIR=%~dp0\r
if exist "%APPDIR%OpenBoard.exe" (start "" "%APPDIR%OpenBoard.exe" --schematic) else (start "" "%APPDIR%..\\OpenBoard.exe" --schematic)\r
`);
writeFileSync(join(here, 'README.txt'), `OpenBoard + OpenRoute
=====================
OpenBoard.exe      - the PCB editor (File > Export DSN / Import SES, Route > Route Automatic, DRC);
                     Window > OpenSchematic opens the schematic editor (cross-probing between the two)
OpenSchematic.cmd  - starts the schematic editor first (OpenBoard.exe --schematic)
openpcb.cmd        - command line for scripts and AI agents (JSON in / JSON out). Run "openpcb help".
resources\\cli      - the CLI and router code (Node.js modules, executed by OpenBoard.exe in node mode)

Agent quick start:
  openpcb new board.openboard.json --layers 2 --width 80 --height 60
  openpcb footprints
  openpcb add board.openboard.json SOIC-8 U1 20 15 --value MCU
  openpcb add board.openboard.json Header_1x4 J1 8 20 --rot 90
  openpcb net board.openboard.json VCC U1-8 J1-1
  openpcb route board.openboard.json
  openpcb drc board.openboard.json
  openpcb render board.openboard.json board.svg
  openpcb export-dsn board.openboard.json board.dsn

Schematics (OrCAD Capture .DSN/.OLB, KiCad, Altium SchDoc in; netlists, BOM, PDF, board out):
  openpcb sch-import-orcad design.DSN design.opensch.json
  openpcb sch-info design.opensch.json
  openpcb sch-annotate design.opensch.json
  openpcb sch-erc design.opensch.json
  openpcb sch-netlist design.opensch.json design.net --format kicad
  openpcb sch-bom design.opensch.json bom.csv
  openpcb sch-pdf design.opensch.json design.pdf
  openpcb sch-to-board design.opensch.json board.openboard.json
  openpcb sch-simulate design.opensch.json --tran 1u,1m
  openpcb sch-skill design.opensch.json --eval "length(schParts())"
`);
console.log('desktop payload prepared');
