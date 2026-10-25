// Bundles the editor (main thread) and the router worker with esbuild.
import { build } from 'esbuild';
import { mkdirSync, copyFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
mkdirSync(join(here, 'dist'), { recursive: true });
const common = { bundle: true, format: 'esm', target: 'es2022', sourcemap: true, logLevel: 'info', minify: false };
await build({ ...common, entryPoints: [join(here, 'src/main.ts')], outfile: join(here, 'dist/app.js') });
await build({ ...common, entryPoints: [join(here, 'src/worker.ts')], outfile: join(here, 'dist/worker.js') });
copyFileSync(join(here, 'src/index.html'), join(here, 'dist/index.html'));
copyFileSync(join(here, 'src/style.css'), join(here, 'dist/style.css'));
copyFileSync(join(here, '../../assets/openboard.svg'), join(here, 'dist/favicon.svg'));
console.log('editor built -> packages/editor/dist');
