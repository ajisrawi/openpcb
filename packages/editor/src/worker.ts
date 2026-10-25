/// <reference lib="webworker" />
/**
 * Router worker: receives the exported DSN and a do script, runs OpenRoute,
 * streams pass records and log lines back, and returns the session.
 */
import { parseDsn, Interpreter } from '@openpcb/router';

interface RunMsg { type: 'run'; dsn: string; script: string; }

self.onmessage = (ev: MessageEvent<RunMsg>) => {
  const msg = ev.data;
  if (msg.type !== 'run') return;
  const post = (m: unknown) => (self as unknown as Worker).postMessage(m);
  try {
    const files = new Map<string, string>();
    const design = parseDsn(msg.dsn);
    const it = new Interpreter(design, {
      files: { read: (p) => files.get(p) ?? '', write: (p, t) => files.set(p, t) },
      designDir: '/', designFile: 'board.dsn',
      log: (s) => post({ type: 'log', line: s }),
      onPass: (rec) => post({ type: 'pass', rec }),
    });
    const t0 = Date.now();
    it.run(msg.script);
    if (!it.wroteSession) it.exec('write session /out.ses');
    const ses = files.get('/out.ses') ?? '';
    const r = it.ensureRouter();
    post({ type: 'done', ses, status: r.statusReport(), seconds: (Date.now() - t0) / 1000, complete: r.connections.every((c) => c.path && c.conflicts === 0) });
  } catch (e) {
    post({ type: 'error', message: (e as Error).message, stack: (e as Error).stack });
  }
};
