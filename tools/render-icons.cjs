// Renders the SVG logos to PNG and the Windows .ico (run with Electron: npx electron tools/render-icons.cjs).
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const assets = path.join(root, 'assets');
const out = path.join(root, 'packages', 'desktop', 'icons');

async function render(win, svgFile, size) {
  const svg = fs.readFileSync(path.join(assets, svgFile), 'utf8');
  const url = 'data:image/svg+xml;base64,' + Buffer.from(svg).toString('base64');
  const dataUrl = await win.webContents.executeJavaScript(`new Promise((ok, fail) => {
    const img = new Image(); img.onerror = fail;
    img.onload = () => { const c = document.createElement('canvas'); c.width = c.height = ${size};
      c.getContext('2d').drawImage(img, 0, 0, ${size}, ${size}); ok(c.toDataURL('image/png')); };
    img.src = ${JSON.stringify(url)}; })`);
  return Buffer.from(dataUrl.split(',')[1], 'base64');
}

/** ICO with PNG-compressed entries (Windows Vista and later). */
function ico(pngs) {
  const head = Buffer.alloc(6 + 16 * pngs.length);
  head.writeUInt16LE(0, 0); head.writeUInt16LE(1, 2); head.writeUInt16LE(pngs.length, 4);
  let off = head.length;
  pngs.forEach(([size, png], i) => {
    const e = 6 + 16 * i;
    head.writeUInt8(size >= 256 ? 0 : size, e); head.writeUInt8(size >= 256 ? 0 : size, e + 1);
    head.writeUInt16LE(1, e + 4); head.writeUInt16LE(32, e + 6);
    head.writeUInt32LE(png.length, e + 8); head.writeUInt32LE(off, e + 12);
    off += png.length;
  });
  return Buffer.concat([head, ...pngs.map(([, png]) => png)]);
}

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false });
  await win.loadURL('data:text/html,<html></html>');
  fs.mkdirSync(out, { recursive: true });
  for (const name of ['icon', 'openboard', 'openroute', 'openschematic']) {
    fs.writeFileSync(path.join(out, `${name}.png`), await render(win, `${name}.svg`, 256));
  }
  const sizes = [16, 24, 32, 48, 64, 128, 256];
  const pngs = [];
  for (const s of sizes) pngs.push([s, await render(win, 'icon.svg', s)]);
  fs.writeFileSync(path.join(out, 'icon.ico'), ico(pngs));
  console.log('wrote', fs.readdirSync(out).join(', '));
  app.quit();
});
