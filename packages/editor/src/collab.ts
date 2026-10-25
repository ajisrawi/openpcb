/**
 * Collaboration client (browser editor and Node scripts; uses the standard WebSocket). It keeps a shadow copy of the
 * shared project: local edits are the difference between the working project and the shadow, sent as operations;
 * remote operations are applied to both. Rejected operations are rolled back from the server's current object.
 */
import type { Project } from './model.js';
import { type ClientMsg, type ServerMsg, type Op, type Lock, type Partition, type Coll, applyOps, diffProjects, clone } from './collabproto.js';

export interface CollabEvents {
  remote?: (ops: Op[], user: string) => void;
  users?: (users: { name: string; color: string }[]) => void;
  cursor?: (user: string, x: number, y: number) => void;
  chat?: (user: string, text: string, at: string) => void;
  locks?: (locks: Lock[]) => void;
  partitions?: (p: Partition[]) => void;
  reject?: (reason: string, op: Op) => void;
  history?: (v: { id: string; version: number; note: string; user: string; at: string }[]) => void;
  reload?: (project: Project) => void;
  closed?: () => void;
}

export class CollabClient {
  private ws: WebSocket | null = null;
  private shadow: Project | null = null;
  version = 0;
  you = '';
  users: { name: string; color: string }[] = [];
  locks: Lock[] = [];
  partitions: Partition[] = [];
  constructor(private getProject: () => Project, private setProject: (p: Project) => void, public on: CollabEvents = {}) {}

  connect(url: string, user: string, color?: string): Promise<Project> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      this.ws = ws;
      ws.onerror = () => reject(new Error(`cannot connect to ${url}`));
      ws.onclose = () => { this.ws = null; this.on.closed?.(); };
      ws.onopen = () => this.send({ type: 'hello', user, ...(color ? { color } : {}) });
      ws.onmessage = (ev) => {
        const m = JSON.parse(String(ev.data)) as ServerMsg;
        switch (m.type) {
          case 'welcome': this.you = m.you; this.version = m.version; this.users = m.users; this.locks = m.locks; this.partitions = m.partitions; this.shadow = clone(m.project); this.setProject(clone(m.project)); for (const c of m.chat) this.on.chat?.(c.user, c.text, c.at); resolve(m.project); break;
          case 'ops': {
            // remote edits apply to the shadow and to the working copy (local unsent edits stay on top)
            applyOps(this.shadow!, m.ops); const p = this.getProject(); applyOps(p, m.ops); this.setProject(p);
            this.version = m.version; this.on.remote?.(m.ops, m.user); break;
          }
          case 'ack': this.version = Math.max(this.version, m.version); break;
          case 'reject': {
            this.version = Math.max(this.version, m.version);
            // roll the object back to the server's state in both copies
            const back: Op[] = m.op.kind === 'section' ? [{ kind: 'section', name: m.op.name, value: m.current }] : m.current === null ? [{ kind: 'remove', coll: m.op.coll, key: m.op.key }] : [{ kind: 'upsert', coll: m.op.coll, key: m.op.key, obj: m.current }];
            applyOps(this.shadow!, back); const p = this.getProject(); applyOps(p, back); this.setProject(p);
            this.on.reject?.(m.reason, m.op); break;
          }
          case 'users': this.users = m.users; this.on.users?.(m.users); break;
          case 'locks': this.locks = m.locks; this.on.locks?.(m.locks); break;
          case 'partitions': this.partitions = m.partitions; this.on.partitions?.(m.partitions); break;
          case 'cursor': this.on.cursor?.(m.user, m.x, m.y); break;
          case 'chat': this.on.chat?.(m.user, m.text, m.at); break;
          case 'history': this.on.history?.(m.versions); break;
          case 'reload': this.version = m.version; this.shadow = clone(m.project); this.setProject(clone(m.project)); this.on.reload?.(m.project); break;
        }
      };
    });
  }

  get connected(): boolean { return !!this.ws && this.ws.readyState === 1; }
  private send(m: ClientMsg) { if (this.ws && this.ws.readyState === 1) this.ws.send(JSON.stringify(m)); }

  /** Send the local edits made since the last call (call after every change). Returns the number of operations. */
  push(): number {
    if (!this.shadow || !this.connected) return 0;
    const p = this.getProject();
    const ops = diffProjects(this.shadow, p);
    if (!ops.length) return 0;
    this.send({ type: 'ops', base: this.version, ops });
    applyOps(this.shadow, ops);
    return ops.length;
  }
  lock(coll: Coll, key: string) { this.send({ type: 'lock', coll, key }); }
  unlock(coll: Coll, key: string) { this.send({ type: 'unlock', coll, key }); }
  partition(rect: Partition['rect'], layers?: string[]) { this.send({ type: 'partition', rect, ...(layers ? { layers } : {}) }); }
  unpartition(id: string) { this.send({ type: 'unpartition', id }); }
  cursor(x: number, y: number) { this.send({ type: 'cursor', x, y }); }
  chat(text: string) { this.send({ type: 'chat', text }); }
  checkpoint(note: string) { this.send({ type: 'checkpoint', note }); }
  history() { this.send({ type: 'history' }); }
  restore(id: string) { this.send({ type: 'restore', id }); }
  close() { this.ws?.close(); }
}
