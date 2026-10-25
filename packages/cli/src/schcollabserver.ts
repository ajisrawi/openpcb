/**
 * Team design server for schematics (openpcb sch-collab-serve): hosts one OpenSchematic design over WebSocket.
 * Page reservations keep other designers off a page; a page or section changed since an operation's base version
 * rejects that operation (the sender gets the current state). Saves after every accepted change, relays cursors and
 * chat, and keeps checkpoints that can be restored.
 */
import { createServer, type IncomingMessage } from 'node:http';
import { createHash } from 'node:crypto';
import type { Duplex } from 'node:stream';
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { type Design, normalizeDesign } from '../../schematic/src/model.js';
import { type SchClientMsg, type SchServerMsg, type SchOp, type Reservation, applySchOps, getCurrent, opKey } from '../../schematic/src/schcollab.js';
import { frame, parseFrames } from './collab.js';

interface Client { id: number; sock: Duplex; user: string; color: string; buf: Buffer }
const COLORS = ['#e6194b', '#3cb44b', '#4363d8', '#f58231', '#911eb4', '#46f0f0', '#f032e6', '#bcf60c'];

export interface SchCollabServer { port: number; close(): Promise<void>; design(): Design; version(): number }

export function startSchCollabServer(file: string, opts: { port?: number; history?: string; log?: (s: string) => void } = {}): Promise<SchCollabServer> {
  const log = opts.log ?? (() => {});
  let design = normalizeDesign(JSON.parse(readFileSync(file, 'utf8')) as Design);
  let version = 0;
  const changedAt = new Map<string, number>();
  const reservations: Reservation[] = [];
  const chat: { user: string; text: string; at: string }[] = [];
  const clients = new Set<Client>();
  const histDir = opts.history ?? `${file}.history`;
  let nextClient = 1;
  const send = (c: Client, m: SchServerMsg) => { try { c.sock.write(frame(JSON.stringify(m))); } catch { /* closed */ } };
  const all = (m: SchServerMsg, except?: Client) => { for (const c of clients) if (c !== except) send(c, m); };
  const users = () => [...clients].map((c) => ({ name: c.user, color: c.color }));
  const save = () => writeFileSync(file, JSON.stringify(design));
  const history = () => existsSync(histDir) ? readdirSync(histDir).filter((n) => n.endsWith('.json')).map((n) => (JSON.parse(readFileSync(join(histDir, n), 'utf8')) as { meta: { id: string; version: number; note: string; user: string; at: string } }).meta).sort((a, b) => a.version - b.version) : [];

  const check = (c: Client, op: SchOp, base: number): string | null => {
    if (op.kind === 'page') { const r = reservations.find((x) => x.sch === op.sch && x.page === op.page); if (r && r.owner !== c.user) return `page ${op.sch}/${op.page} is reserved by ${r.owner}`; }
    if (op.kind === 'section' && op.name === 'structure') {
      // removing or renaming a page somebody else reserved is not allowed
      const want = op.value as { name: string; pages: string[] }[];
      for (const r of reservations) if (r.owner !== c.user && !want.some((s) => s.name === r.sch && s.pages.includes(r.page))) return `page ${r.sch}/${r.page} is reserved by ${r.owner}`;
    }
    const at = changedAt.get(opKey(op)) ?? 0;
    if (at > base) return `${op.kind === 'page' ? `page ${op.sch}/${op.page}` : `section ${op.name}`} was changed by someone else (v${at})`;
    return null;
  };

  const handle = (c: Client, m: SchClientMsg) => {
    switch (m.type) {
      case 'hello': {
        c.user = m.user || `user${c.id}`; c.color = m.color ?? COLORS[(c.id - 1) % COLORS.length];
        send(c, { type: 'welcome', you: c.user, design, version, users: users(), reservations, chat: chat.slice(-50) });
        all({ type: 'users', users: users() }, c); log(`${c.user} joined (${clients.size} online)`);
        break;
      }
      case 'ops': {
        const accepted: SchOp[] = [];
        for (const op of m.ops) { const why = check(c, op, m.base); if (why) { send(c, { type: 'reject', reason: why, op, current: getCurrent(design, op), version }); continue; } accepted.push(op); }
        if (accepted.length) {
          applySchOps(design, accepted); version++;
          for (const op of accepted) changedAt.set(opKey(op), version);
          save(); all({ type: 'ops', version, ops: accepted, user: c.user }, c);
        }
        send(c, { type: 'ack', version, applied: accepted.length });
        break;
      }
      case 'reserve': { if (!reservations.some((r) => r.sch === m.sch && r.page === m.page)) reservations.push({ sch: m.sch, page: m.page, owner: c.user }); all({ type: 'reservations', reservations }); break; }
      case 'release': { const i = reservations.findIndex((r) => r.sch === m.sch && r.page === m.page && r.owner === c.user); if (i >= 0) reservations.splice(i, 1); all({ type: 'reservations', reservations }); break; }
      case 'cursor': all({ type: 'cursor', user: c.user, sch: m.sch, page: m.page, x: m.x, y: m.y }, c); break;
      case 'chat': { const e = { user: c.user, text: String(m.text).slice(0, 2000), at: new Date().toISOString() }; chat.push(e); all({ type: 'chat', ...e }); break; }
      case 'checkpoint': {
        mkdirSync(histDir, { recursive: true });
        const id = `v${String(version).padStart(5, '0')}_${Date.now()}`;
        writeFileSync(join(histDir, `${id}.json`), JSON.stringify({ meta: { id, version, note: m.note, user: c.user, at: new Date().toISOString() }, design }));
        send(c, { type: 'history', versions: history() }); break;
      }
      case 'history': send(c, { type: 'history', versions: history() }); break;
      case 'restore': {
        const f = join(histDir, `${m.id}.json`); if (!existsSync(f)) break;
        design = normalizeDesign((JSON.parse(readFileSync(f, 'utf8')) as { design: Design }).design);
        version++; changedAt.clear(); save(); all({ type: 'reload', design, version }); break;
      }
    }
  };

  const server = createServer((_req, res) => { res.writeHead(200, { 'content-type': 'application/json', 'access-control-allow-origin': '*' }); res.end(JSON.stringify({ ok: true, design: design.name, version, users: users(), reservations })); });
  server.on('upgrade', (req: IncomingMessage, sock: Duplex) => {
    const key = req.headers['sec-websocket-key']; if (!key) { sock.destroy(); return; }
    const accept = createHash('sha1').update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');
    sock.write(['HTTP/1.1 101 Switching Protocols', 'Upgrade: websocket', 'Connection: Upgrade', `Sec-WebSocket-Accept: ${accept}`, '', ''].join('\r\n'));
    const c: Client = { id: nextClient++, sock, user: '', color: '#888', buf: Buffer.alloc(0) };
    clients.add(c);
    sock.on('data', (d: Buffer) => {
      c.buf = Buffer.concat([c.buf, d]);
      const { msgs, rest } = parseFrames(c.buf); c.buf = rest;
      for (const f of msgs) {
        if (f.op === 8) { sock.end(); return; }
        if (f.op === 9) { sock.write(Buffer.concat([Buffer.from([0x8a, f.data.length]), f.data])); continue; }
        if (f.op !== 1) continue;
        try { handle(c, JSON.parse(f.data.toString('utf8')) as SchClientMsg); } catch (e) { log(`bad message from ${c.user}: ${(e as Error).message}`); }
      }
    });
    const bye = () => { if (!clients.delete(c)) return; for (let i = reservations.length - 1; i >= 0; i--) if (reservations[i].owner === c.user) reservations.splice(i, 1); all({ type: 'users', users: users() }); all({ type: 'reservations', reservations }); log(`${c.user} left`); };
    sock.on('close', bye); sock.on('error', bye);
  });
  return new Promise((resolve) => server.listen(opts.port ?? 7778, () => {
    const addr = server.address(); const port = typeof addr === 'object' && addr ? addr.port : opts.port ?? 7778;
    log(`schematic team design server for ${design.name} on ws://localhost:${port}`);
    resolve({ port, close: () => new Promise((r) => { for (const c of clients) c.sock.destroy(); server.close(() => r()); }), design: () => design, version: () => version });
  }));
}
