// OpenBoard desktop shell: hosts the PCB editor (OpenBoard) and the schematic editor (OpenSchematic) in their own
// windows, relays cross-probe messages between them, native save dialogs for exported files, and the menus.
// In node mode (ELECTRON_RUN_AS_NODE=1) the same binary runs the openpcb CLI.
const { app, BrowserWindow, Menu, dialog, shell, session, ipcMain } = require('electron');
const path = require('node:path');
const fs = require('node:fs');

const appDir = path.join(__dirname, 'app');
const windows = { board: null, schematic: null };

function createWindow(kind = 'board') {
  if (windows[kind] && !windows[kind].isDestroyed()) { windows[kind].focus(); return windows[kind]; }
  const win = new BrowserWindow({
    width: 1500, height: 950, minWidth: 900, minHeight: 600,
    title: kind === 'board' ? 'OpenBoard + OpenRoute' : 'OpenSchematic',
    backgroundColor: '#16191d',
    icon: path.join(__dirname, 'icons', kind === 'board' ? 'openboard.png' : 'openschematic.png'),
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, sandbox: true },
  });
  win.loadFile(kind === 'board' ? path.join(appDir, 'index.html') : path.join(appDir, 'schematic', 'index.html'));
  win.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' }; });
  win.on('focus', () => buildMenu(win, kind));
  win.on('closed', () => { windows[kind] = null; });
  windows[kind] = win;
  buildMenu(win, kind);
  return win;
}

// downloads from either page (Save, exports) go through a native Save As dialog
function hookDownloads() {
  session.defaultSession.on('will-download', (_event, item, contents) => {
    const win = BrowserWindow.fromWebContents(contents) ?? undefined;
    const target = dialog.showSaveDialogSync(win, { defaultPath: path.join(app.getPath('documents'), item.getFilename()) });
    if (!target) { item.cancel(); return; }
    item.setSavePath(target);
  });
}

// cross-probing: a message from one window goes to every other window
ipcMain.on('xprobe', (e, msg) => {
  for (const w of BrowserWindow.getAllWindows()) if (w.webContents !== e.sender) w.webContents.send('xprobe', msg);
  // forward annotation opens the board window when it is not open yet
  if (msg && msg.type === 'board' && (!windows.board || windows.board.isDestroyed())) {
    const w = createWindow('board');
    w.webContents.once('did-finish-load', () => w.webContents.send('xprobe', msg));
  }
});
ipcMain.on('open-window', (_e, which) => createWindow(which === 'schematic' ? 'schematic' : 'board'));

function buildMenu(win, kind) {
  const cliDir = path.join(process.resourcesPath || __dirname, 'cli');
  const click = (id) => () => win.webContents.executeJavaScript(`document.getElementById('${id}').click()`);
  const windowMenu = { label: 'Window', submenu: [
    { label: 'OpenBoard (PCB editor)', accelerator: 'CmdOrCtrl+1', click: () => createWindow('board') },
    { label: 'OpenSchematic (schematic editor)', accelerator: 'CmdOrCtrl+2', click: () => createWindow('schematic') },
  ] };
  const viewMenu = { label: 'View', submenu: [{ role: 'reload' }, { role: 'toggleDevTools' }, { type: 'separator' }, { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { type: 'separator' }, { role: 'togglefullscreen' }] };
  const cliHelp = [
    'Use openpcb.cmd next to OpenBoard.exe (or run the app with ELECTRON_RUN_AS_NODE=1).',
    `CLI files: ${cliDir}`, '',
    'Board:', '  openpcb new board.openboard.json --layers 2 --width 80 --height 60', '  openpcb route board.openboard.json', '  openpcb drc board.openboard.json', '',
    'Schematic:', '  openpcb sch-import-orcad design.DSN design.opensch.json', '  openpcb sch-erc design.opensch.json', '  openpcb sch-to-board design.opensch.json board.openboard.json', '  openpcb sch-pdf design.opensch.json design.pdf',
  ].join('\n');
  const helpMenu = { label: 'Help', submenu: [
    { label: 'Agent CLI location', click: () => dialog.showMessageBox(win, { message: 'openpcb command line', detail: cliHelp }) },
    { label: 'README', click: () => { const f = path.join(process.resourcesPath || __dirname, 'README.txt'); if (fs.existsSync(f)) shell.openPath(f); } },
  ] };
  const template = kind === 'board' ? [
    { label: 'File', submenu: [
      { label: 'New board', click: click('btn-new') },
      { label: 'Demo board', click: click('btn-demo') },
      { label: 'Open project…', accelerator: 'CmdOrCtrl+O', click: click('btn-open') },
      { label: 'Save project', accelerator: 'CmdOrCtrl+S', click: click('btn-save') },
      { type: 'separator' },
      { label: 'Export DSN (Router)…', click: click('btn-export-dsn') },
      { label: 'Import DSN…', click: click('btn-import-dsn') },
      { label: 'Import SES (Router)…', click: click('btn-import-ses') },
      { type: 'separator' },
      { role: 'quit' },
    ] },
    { label: 'Route', submenu: [
      { label: 'Route Automatic', accelerator: 'F5', click: click('btn-route') },
      { label: 'Route Custom…', click: click('btn-route-custom') },
      { label: 'Unroute all', click: click('btn-unroute') },
      { label: 'DRC', accelerator: 'F7', click: click('btn-drc') },
    ] },
    viewMenu, windowMenu, helpMenu,
  ] : [
    // OpenSchematic keeps its own menu bar in the page (File, Edit, Place, View, Tools, Simulate)
    { label: 'File', submenu: [{ role: 'close' }, { role: 'quit' }] },
    viewMenu, windowMenu, helpMenu,
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

app.whenReady().then(() => {
  hookDownloads();
  // OpenBoard.exe --schematic (the OpenSchematic shortcut) opens the schematic editor first
  createWindow(process.argv.includes('--schematic') ? 'schematic' : 'board');
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow('board'); });
});
app.on('window-all-closed', () => app.quit());
