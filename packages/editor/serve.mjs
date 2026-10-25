// Minimal static server for the editor (no dependencies); /schematic/ serves OpenSchematic from the same origin so
// the two windows can cross-probe.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), 'dist');
const schRoot = join(dirname(fileURLToPath(import.meta.url)), '..', 'schematic', 'dist');
const port = Number(process.env.PORT ?? 5174);
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.map': 'application/json', '.json': 'application/json', '.dsn': 'text/plain', '.ses': 'text/plain', '.svg': 'image/svg+xml' };
createServer(async (req, res) => {
  let p = decodeURIComponent((req.url ?? '/').split('?')[0]);
  let base = root;
  if (p === '/schematic') { res.writeHead(302, { location: '/schematic/' }); res.end(); return; }
  if (p.startsWith('/schematic/')) { base = schRoot; p = p.slice('/schematic'.length); }
  if (p === '/') p = '/index.html';
  const file = normalize(join(base, p));
  if (!file.startsWith(base)) { res.writeHead(403); res.end(); return; }
  try {
    const data = await readFile(file);
    res.writeHead(200, { 'content-type': types[extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-store' });
    res.end(data);
  } catch {
    res.writeHead(404); res.end('not found');
  }
}).listen(port, () => console.log(`OpenBoard editor: http://localhost:${port}/   OpenSchematic: http://localhost:${port}/schematic/`));
