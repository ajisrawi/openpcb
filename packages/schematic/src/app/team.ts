/**
 * Team design client (OpenSchematic side of `openpcb sch-collab-serve`): keeps the open design in sync with the
 * server page by page, honours page reservations, shows other designers' cursors and relays chat.
 */
import type { Design } from '../model.js';
import { type SchClientMsg, type SchServerMsg, type Reservation, applySchOps, diffDesigns } from '../schcollab.js';

export interface TeamHooks {
  design(): Design;
  replace(d: Design): void;          // a whole design from the server (welcome / restore)
  refresh(): void;                    // redraw after remote changes
  log(s: string): void;
  page(): { sch: string; page: string };
}

export class TeamClient {
  ws: WebSocket | null = null;
  user = '';
  version = 0;
  users: { name: string; color: string }[] = [];
  reservations: Reservation[] = [];
  cursors = new Map<string, { sch: string; page: string; x: number; y: number; color: string }>();
  private synced = '';               // JSON of the design as the server has it
  private timer: ReturnType<typeof setTimeout> | null = null;
  constructor(private h: TeamHooks) {}

  get connected() { return !!this.ws && this.ws.readyState === WebSocket.OPEN; }

  connect(url: string, user: string) {
    this.disconnect();
    this.user = user;
    const ws = new WebSocket(url); this.ws = ws;
    ws.onopen = () => this.send({ type: 'hello', user });
    ws.onmessage = (e) => this.onMessage(JSON.parse(String(e.data)) as SchServerMsg);
    ws.onclose = () => { this.h.log('team design: disconnected'); this.ws = null; this.cursors.clear(); this.h.refresh(); };
    ws.onerror = () => this.h.log(`team design: cannot reach ${url}`);
  }
  disconnect() { if (this.ws) { this.ws.onclose = null; this.ws.close(); this.ws = null; } this.cursors.clear(); }
  send(m: SchClientMsg) { if (this.connected) this.ws!.send(JSON.stringify(m)); }

  /** local edits: send what changed since the last sync (debounced) */
  changed() {
    if (!this.connected) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.push(), 250);
  }
  private push() {
    this.timer = null; if (!this.connected) return;
    const base = JSON.parse(this.synced) as Design, cur = this.h.design();
    const ops = diffDesigns(base, cur);
    // pages reserved by someone else stay as they were
    const blocked = ops.filter((o) => o.kind === 'page' && this.reservedByOther(o.sch, o.page));
    if (blocked.length) this.h.log(`team design: ${blocked.map((o) => o.kind === 'page' ? `${o.sch}/${o.page}` : '').join(', ')} reserved by another designer — local edits there are not sent`);
    const send = ops.filter((o) => !blocked.includes(o));
    if (!send.length) return;
    this.send({ type: 'ops', base: this.version, ops: send });
    this.synced = JSON.stringify(cur);
  }
  reservedByOther(sch: string, page: string) { return this.reservations.some((r) => r.sch === sch && r.page === page && r.owner !== this.user); }
  reserve() { const p = this.h.page(); this.send({ type: 'reserve', ...p }); }
  release() { const p = this.h.page(); this.send({ type: 'release', ...p }); }
  cursor(x: number, y: number) { if (this.connected) { const p = this.h.page(); this.send({ type: 'cursor', ...p, x, y }); } }
  chat(text: string) { this.send({ type: 'chat', text }); }
  checkpoint(note: string) { this.send({ type: 'checkpoint', note }); }

  private onMessage(m: SchServerMsg) {
    switch (m.type) {
      case 'welcome': this.version = m.version; this.users = m.users; this.reservations = m.reservations; this.h.replace(m.design); this.synced = JSON.stringify(m.design); this.h.log(`team design: joined as ${m.you}; online: ${m.users.map((u) => u.name).join(', ')}`); for (const c of m.chat) this.h.log(`  [${c.user}] ${c.text}`); break;
      case 'ops': {
        this.version = m.version;
        applySchOps(this.h.design(), m.ops);
        const s = JSON.parse(this.synced) as Design; applySchOps(s, m.ops); this.synced = JSON.stringify(s);
        this.h.log(`team design: ${m.user} changed ${m.ops.map((o) => (o.kind === 'page' ? `${o.sch}/${o.page}` : o.name)).join(', ')}`);
        this.h.refresh(); break;
      }
      case 'ack': this.version = Math.max(this.version, m.version); break;
      case 'reject': {
        this.version = Math.max(this.version, m.version);
        // take the server's state for what was rejected
        const fix = m.op.kind === 'page' ? { ...m.op, obj: m.current as never } : { ...m.op, value: m.current };
        applySchOps(this.h.design(), [fix]); const s = JSON.parse(this.synced) as Design; applySchOps(s, [fix]); this.synced = JSON.stringify(s);
        this.h.log(`team design: not applied — ${m.reason}`); this.h.refresh(); break;
      }
      case 'users': this.users = m.users; this.h.log(`team design: online ${m.users.map((u) => u.name).join(', ')}`); break;
      case 'reservations': this.reservations = m.reservations; this.h.refresh(); break;
      case 'cursor': { const u = this.users.find((x) => x.name === m.user); this.cursors.set(m.user, { sch: m.sch, page: m.page, x: m.x, y: m.y, color: u?.color ?? '#f0f' }); this.h.refresh(); break; }
      case 'chat': this.h.log(`[${m.user}] ${m.text}`); break;
      case 'history': this.h.log(`checkpoints: ${m.versions.map((v) => `${v.id} (${v.note})`).join(', ') || 'none'}`); break;
      case 'reload': this.version = m.version; this.h.replace(m.design); this.synced = JSON.stringify(m.design); this.h.log('team design: design restored from a checkpoint'); break;
    }
  }
}
