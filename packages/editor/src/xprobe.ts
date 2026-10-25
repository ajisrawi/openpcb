/**
 * Cross-probing between OpenSchematic and OpenBoard (Capture <-> PCB Editor "cross probe"): selecting parts or a net
 * in one window selects them in the other. Inside the desktop app the main process relays the messages between
 * windows (preload bridge); in a browser both pages share a BroadcastChannel (same origin).
 *
 *   { type: 'select', refs: string[], from }        parts selected
 *   { type: 'net', name: string, from }             net highlighted
 *   { type: 'board', project: unknown, from }       a board produced by forward annotation, to be opened
 */
export type XprobeMsg =
  | { type: 'select'; refs: string[]; from: string }
  | { type: 'net'; name: string; from: string }
  | { type: 'board'; project: unknown; from: string };

interface DesktopBridge { xprobeSend?: (m: XprobeMsg) => void; xprobeOn?: (cb: (m: XprobeMsg) => void) => void }

const bridge = (): DesktopBridge | undefined => (globalThis as unknown as { openboardDesktop?: DesktopBridge }).openboardDesktop;
let channel: BroadcastChannel | null = null;
const chan = () => { if (!channel && typeof BroadcastChannel !== 'undefined') channel = new BroadcastChannel('openpcb-xprobe'); return channel; };

export function xprobeSend(m: XprobeMsg): void {
  const b = bridge();
  if (b?.xprobeSend) { b.xprobeSend(m); return; }
  chan()?.postMessage(m);
}

/** Receive messages from the other window (not our own). */
export function xprobeOn(self: string, cb: (m: XprobeMsg) => void): void {
  const b = bridge();
  const f = (m: XprobeMsg) => { if (m && m.from !== self) cb(m); };
  if (b?.xprobeOn) { b.xprobeOn(f); return; }
  const c = chan(); if (c) c.onmessage = (e) => f(e.data as XprobeMsg);
}
