// Bundles OpenSchematic (the browser / desktop schematic editor) with esbuild.
import { build } from 'esbuild';
import { mkdirSync, copyFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
mkdirSync(join(here, 'dist'), { recursive: true });
await build({ bundle: true, format: 'esm', target: 'es2022', sourcemap: true, logLevel: 'info', minify: false, entryPoints: [join(here, 'src/app/main.ts')], outfile: join(here, 'dist/app.js') });
copyFileSync(join(here, 'src/app/index.html'), join(here, 'dist/index.html'));
copyFileSync(join(here, 'src/app/style.css'), join(here, 'dist/style.css'));
copyFileSync(join(here, '../../assets/openschematic.svg'), join(here, 'dist/favicon.svg'));
console.log('schematic editor built -> packages/schematic/dist');
