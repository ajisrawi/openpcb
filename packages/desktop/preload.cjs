// Preload bridge: tells the page it runs inside the desktop app and relays cross-probe messages between the
// OpenBoard and OpenSchematic windows through the main process.
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('openboardDesktop', {
  version: process.versions.electron,
  xprobeSend: (msg) => ipcRenderer.send('xprobe', msg),
  xprobeOn: (cb) => ipcRenderer.on('xprobe', (_e, msg) => cb(msg)),
  openWindow: (which) => ipcRenderer.send('open-window', which),
});
