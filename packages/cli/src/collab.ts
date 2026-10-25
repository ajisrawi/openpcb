/**
 * Collaboration server (openpcb collab-serve): hosts one project for concurrent editing over WebSocket (RFC 6455,
 * implemented here on node:http so there are no dependencies). It validates operations against locks, partitions and
 * per-object versions (see editor/src/collabproto.ts), broadcasts accepted ones, relays presence and chat, saves the
 * project after every change, and keeps checkpoints (named versions) in a history folder that can be restored.
 */
import { createServer, type IncomingMessage } from 'node:http';
import { createHash } from 'node:crypto';
import type { Duplex } from 'node:stream';
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { type Project, normalizeProject } from '../../editor/src/model.js';
import { type ClientMsg, type ServerMsg, type Op, type Lock, type Partition, type Coll, applyOps, getObject, objectLocation, inRect, clone } from '../../editor/src/collabproto.js';

interface Client { id: number; sock: Duplex; user: string; color: string; buf: Buffer }

export interface CollabServer { port: number; close(): Promise<void>; project(): Project; version(): number }

const COLORS = ['#e6194b', '#3cb44b', '#4363d8', '#f58231', '#911eb4', '#46f0f0', '#f032e6', '#bcf60c'];

/** Encode one WebSocket text frame (server frames are not masked). */
export function frame(text: string): Buffer {
  const data = Buffer.from(text, 'utf8');
  const n = data.length;
  const head = n < 126 ? Buffer.from([0x81, n]) : n < 65536 ? Buffer.from([0x81, 126, n >> 8, n & 255]) : (() => { const b = Buffer.alloc(10); b[0] = 0x81; b[1] = 127; b.writeBigUInt64BE(BigInt(n), 2); return b; })();
  return Buffer.concat([head, data]);
}

/** Parse complete frames from a buffer; returns messages and the unconsumed rest. */
export function parseFrames(buf: Buffer): { msgs: { op: number; data: Buffer }[]; rest: Buffer } {
  const msgs: { op: number; data: Buffer }[] = [];
  let o = 0;
  while (buf.length - o >= 2) {
    const b0 = buf[o], b1 = buf[o + 1];
    const op = b0 & 15, masked = (b1 & 128) !== 0;
    let len = b1 & 127, h = 2;
    if (len === 126) { if (buf.length - o < 4) break; len = buf.readUInt16BE(o + 2); h = 4; }
    else if (len === 127) { if (buf.length - o < 10) break; len = Number(buf.readBigUInt64BE(o + 2)); h = 10; }
    const mk = masked ? 4 : 0;
    if (buf.length - o < h + mk + len) break;
    const mask = masked ? buf.subarray(o + h, o + h + 4) : null;
    const data = Buffer.from(buf.subarray(o + h + mk, o + h + mk + len));
    if (mask) for (let i = 0; i < data.length; i++) data[i] ^= mask[i & 3];
    msgs.push({ op, data });
    o += h + mk + len;
  }
  return { msgs, rest: buf.subarray(o) };
}

export function startCollabServer(file: string, opts: { port?: number; history?: string; log?: (s: string) => void } = {}): Promise<CollabServer> {
  const log = opts.log ?? (() => {});
  let project = normalizeProject(JSON.parse(readFileSync(file, 'utf8')) as Project);
  let version = 0;
  const changedAt = new Map<string, number>();   // coll|key -> version
  const locks: Lock[] = [];
  const partitions: Partition[] = [];
  const chat: { user: string; text: string; at: string }[] = [];
  const clients = new Set<Client>();
  const histDir = opts.history ?? `${file}.history`;
  let nextClient = 1;
  const send = (c: Client, m: ServerMsg) => { try { c.sock.write(frame(JSON.stringify(m))); } catch { /* closed */ } };
  const all = (m: ServerMsg, except?: Client) => { for (const c of clients) if (c !== except) send(c, m); };
  const users = () => [...clients].map((c) => ({ name: c.user, color: c.color }));
  const save = () => writeFileSync(file, JSON.stringify(project, null, 1));

  const check = (c: Client, op: Op, base: number): { ok: true } | { ok: false; reason: string; current?: unknown } => {
    if (op.kind === 'section') {
      const k = `section|${op.name}`, at = changedAt.get(k) ?? 0;
      if (at > base) return { ok: false, reason: `section ${op.name} was changed by someone else (v${at})`, current: (project as unknown as Record<string, unknown>)[op.name] };
      return { ok: true };
    }
    const k = `${op.coll}|${op.key}`;
    const lock = locks.find((l) => l.coll === op.coll && l.key === op.key);
    if (lock && lock.owner !== c.user) return { ok: false, reason: `${op.coll} ${op.key} is locked by ${lock.owner}` };
    const cur = getObject(project, op.coll, op.key);
    for (const o of [cur, op.kind === 'upsert' ? op.obj : undefined]) {
      const q = o ? objectLocation(op.coll, o) : null; if (!q) continue;
      const pt = partitions.find((pp) => pp.owner !== c.user && inRect(q, pp.rect) && (!pp.layers || !(o as { layer?: string }).layer || pp.layers.includes((o as { layer: string }).layer)));
      if (pt) return { ok: false, reason: `${op.coll} ${op.key} lies in partition ${pt.id} owned by ${pt.owner}` };
    }
    const at = changedAt.get(k) ?? 0;
    if (at > base) return { ok: false, reason: `${op.coll} ${op.key} was changed by someone else (v${at})`, current: clone(cur) };
    return { ok: true };
  };

  const handle = (c: Client, m: ClientMsg) => {
    switch (m.type) {
      case 'hello': {
        c.user = m.user || `user${c.id}`; c.color = m.color ?? COLORS[(c.id - 1) % COLORS.length];
        send(c, { type: 'welcome', you: c.user, project, version, users: users(), locks, partitions, chat: chat.slice(-50) });
        all({ type: 'users', users: users() }, c);
        log(`${c.user} joined (${clients.size} online)`);
        break;
      }
      case 'ops': {
        const accepted: Op[] = [];
        for (const op of m.ops) {
          const r = check(c, op, m.base);
          if (!r.ok) { const cur = op.kind === 'section' ? (project as unknown as Record<string, unknown>)[op.name] : getObject(project, op.coll, op.key); send(c, { type: 'reject', reason: r.reason, op, current: cur === undefined ? null : clone(cur), version }); continue; }
          accepted.push(op);
        }
        if (accepted.length) {
          applyOps(project, accepted);
          version++;
          for (const op of accepted) changedAt.set(op.kind === 'section' ? `section|${op.name}` : `${op.coll}|${op.key}`, version);
          save();
          all({ type: 'ops', version, ops: accepted, user: c.user }, c);
        }
        send(c, { type: 'ack', version, applied: accepted.length });
        break;
      }
      case 'lock': {
        const cur = locks.find((l) => l.coll === m.coll && l.key === m.key);
        if (!cur) locks.push({ coll: m.coll as Coll, key: m.key, owner: c.user });
        all({ type: 'locks', locks });
        break;
      }
      case 'unlock': { const i = locks.findIndex((l) => l.coll === m.coll && l.key === m.key && l.owner === c.user); if (i >= 0) locks.splice(i, 1); all({ type: 'locks', locks }); break; }
      case 'partition': { partitions.push({ id: `P${partitions.length + 1}_${Date.now() % 100000}`, owner: c.user, rect: m.rect, ...(m.layers ? { layers: m.layers } : {}) }); all({ type: 'partitions', partitions }); break; }
      case 'unpartition': { const i = partitions.findIndex((p) => p.id === m.id && p.owner === c.user); if (i >= 0) partitions.splice(i, 1); all({ type: 'partitions', partitions }); break; }
      case 'cursor': all({ type: 'cursor', user: c.user, x: m.x, y: m.y }, c); break;
      case 'chat': { const e = { user: c.user, text: String(m.text).slice(0, 2000), at: new Date().toISOString() }; chat.push(e); all({ type: 'chat', ...e }); break; }
      case 'checkpoint': {
        mkdirSync(histDir, { recursive: true });
        const id = `v${String(version).padStart(5, '0')}_${Date.now()}`;
        writeFileSync(join(histDir, `${id}.json`), JSON.stringify({ meta: { id, version, note: m.note, user: c.user, at: new Date().toISOString() }, project }));
        send(c, { type: 'history', versions: history() });
        break;
      }
      case 'history': send(c, { type: 'history', versions: history() }); break;
      case 'restore': {
        const f = join(histDir, `${m.id}.json`); if (!existsSync(f)) break;
        project = normalizeProject((JSON.parse(readFileSync(f, 'utf8')) as { project: Project }).project);
        version++; changedAt.clear(); save();
        all({ type: 'reload', project, version });
        break;
      }
    }
  };
  const history = () => existsSync(histDir) ? readdirSync(histDir).filter((n) => n.endsWith('.json')).map((n) => (JSON.parse(readFileSync(join(histDir, n), 'utf8')) as { meta: { id: string; version: number; note: string; user: string; at: string } }).meta).sort((a, b) => a.version - b.version) : [];

  const server = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json', 'access-control-allow-origin': '*' });
    res.end(JSON.stringify({ ok: true, project: project.name, version, users: users(), partitions, locks }));
  });
  server.on('upgrade', (req: IncomingMessage, sock: Duplex) => {
    const key = req.headers['sec-websocket-key'];
    if (!key) { sock.destroy(); return; }
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
        try { handle(c, JSON.parse(f.data.toString('utf8')) as ClientMsg); } catch (e) { log(`bad message from ${c.user}: ${(e as Error).message}`); }
      }
    });
    const bye = () => { if (!clients.delete(c)) return; for (let i = locks.length - 1; i >= 0; i--) if (locks[i].owner === c.user) locks.splice(i, 1); all({ type: 'users', users: users() }); all({ type: 'locks', locks }); log(`${c.user} left`); };
    sock.on('close', bye); sock.on('error', bye);
  });
  return new Promise((resolve) => server.listen(opts.port ?? 7777, () => {
    const addr = server.address(); const port = typeof addr === 'object' && addr ? addr.port : opts.port ?? 7777;
    log(`collaboration server for ${project.name} on ws://localhost:${port}`);
    resolve({ port, close: () => new Promise((r) => { for (const c of clients) c.sock.destroy(); server.close(() => r()); }), project: () => project, version: () => version });
  }));
}
