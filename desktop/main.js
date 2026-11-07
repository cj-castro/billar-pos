const { app, BrowserWindow, ipcMain, shell, Menu, Tray, nativeImage } = require('electron');
const fs = require('fs');
const path = require('path');

const DEFAULT_URL = 'http://localhost:8080';
const SETUP = path.join(__dirname, 'setup.html');
const cfgFile = () => path.join(app.getPath('userData'), 'config.json');
// BILLAR_URL / BILLAR_QUIT_MS: test hooks (override URL without saving; auto-quit)
const loadUrl = () => {
  if (process.env.BILLAR_URL) return process.env.BILLAR_URL;
  try { return JSON.parse(fs.readFileSync(cfgFile(), 'utf8')).url || DEFAULT_URL; }
  catch { return DEFAULT_URL; }
};
const isHttp = (u) => { try { return /^https?:$/.test(new URL(u).protocol); } catch { return false; } };
const origin = (u) => { try { return new URL(u).origin; } catch { return null; } };
const log = (...a) => console.log('[desktop]', ...a);

let win;
let serverUrl;
let tray; // module-level so it is not garbage-collected
let isQuitting = false;
let trayHinted = false;

async function healthy(base) {
  try {
    const r = await fetch(new URL('/api/v1/health', base), { signal: AbortSignal.timeout(4000) });
    return r.ok;
  } catch { return false; }
}

function showSetup(err) {
  win.loadFile(SETUP, { query: err ? { err } : {} });
}

function openApp() {
  log('loading', serverUrl);
  win.loadURL(serverUrl).catch(() => {}); // failure handled by did-fail-load
}

// Only the local setup page may call these.
const fromSetup = (e) => e.senderFrame && e.senderFrame.url.startsWith('file://') && e.senderFrame.url.includes('setup.html');

ipcMain.handle('cfg:get', (e) => (fromSetup(e) ? serverUrl : null));
ipcMain.handle('cfg:save', async (e, url) => {
  if (!fromSetup(e)) return { ok: false, error: 'forbidden' };
  if (typeof url !== 'string' || !isHttp(url)) return { ok: false, error: 'Enter an http(s) URL' };
  url = new URL(url).origin;
  if (!(await healthy(url))) return { ok: false, error: 'Server did not answer at ' + url + '/api/v1/health' };
  fs.mkdirSync(app.getPath('userData'), { recursive: true });
  fs.writeFileSync(cfgFile(), JSON.stringify({ url }));
  serverUrl = url;
  openApp();
  return { ok: true };
});
ipcMain.handle('cfg:retry', async (e) => {
  if (!fromSetup(e)) return false;
  if (!(await healthy(serverUrl))) return false;
  openApp();
  return true;
});

function createWindow() {
  win = new BrowserWindow({
    width: 1280, height: 800, show: false, autoHideMenuBar: true,
    icon: path.join(__dirname, 'build', 'icon.png'),
    webPreferences: {
      contextIsolation: true, nodeIntegration: false, sandbox: true,
      preload: path.join(__dirname, 'preload.js'),
    },
  });
  win.once('ready-to-show', () => win.show());
  // Close (X / Alt+F4) hides to tray; real quit only via tray "Salir", app.quit() or OS session end.
  win.on('close', (e) => {
    if (isQuitting) return;
    e.preventDefault();
    win.hide();
    if (!trayHinted && tray) {
      trayHinted = true;
      tray.displayBalloon({ title: 'Billar POS', content: 'Billar POS sigue abierto en la bandeja del sistema' });
    }
  });
  win.on('session-end', () => { isQuitting = true; });
  win.webContents.on('did-finish-load', () => log('loaded', win.webContents.getURL()));
  win.webContents.on('did-fail-load', (_e, code, desc, url, isMain) => {
    if (!isMain || code === -3) return; // -3 = aborted (e.g. redirect/nav interrupted)
    log('fail', code, desc, url);
    showSetup(desc);
  });
  openApp();
}

function showWindow() {
  if (!win || win.isDestroyed()) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

function createTray() {
  const icon = nativeImage.createFromPath(path.join(__dirname, 'build', 'icon.png')).resize({ width: 16, height: 16 });
  tray = new Tray(icon);
  tray.setToolTip('Billar POS');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Abrir', click: showWindow },
    { label: 'Recargar', click: () => { showWindow(); win.webContents.reload(); } },
    { label: 'Configuración', click: () => { showWindow(); showSetup(); } },
    { type: 'separator' },
    { label: 'Salir', click: () => { isQuitting = true; app.quit(); } },
  ]));
  tray.on('click', showWindow);
  tray.on('double-click', showWindow);
}

// Guards for every window we create (main + print/about:blank popups).
app.on('web-contents-created', (_e, wc) => {
  wc.on('will-navigate', (ev, url) => {
    if (url.startsWith('file://') && url.includes('setup.html')) return;
    if (origin(url) === origin(serverUrl)) return;
    ev.preventDefault();
    if (isHttp(url)) shell.openExternal(url);
  });
  wc.setWindowOpenHandler(({ url }) => {
    if (url === '' || url === 'about:blank' || origin(url) === origin(serverUrl)) return { action: 'allow' };
    if (isHttp(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  wc.on('before-input-event', (ev, i) => {
    if (i.type !== 'keyDown' || !win || win.isDestroyed()) return;
    if (i.key === 'F11') { win.setFullScreen(!win.isFullScreen()); ev.preventDefault(); }
    else if (i.key === 'F5') { wc.reload(); ev.preventDefault(); }
    else if (i.control && i.shift && i.key.toLowerCase() === 's') { showSetup(); ev.preventDefault(); }
    else if (i.key === 'F12' && !app.isPackaged) wc.toggleDevTools();
  });
});

// Test hook: isolated userData so a dev run doesn't collide with the installed app's lock/config.
if (process.env.BILLAR_USER_DATA) app.setPath('userData', process.env.BILLAR_USER_DATA);
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', showWindow);
  app.on('before-quit', () => { isQuitting = true; });
  app.whenReady().then(() => {
    serverUrl = loadUrl();
    Menu.setApplicationMenu(null);
    createWindow();
    createTray();
    if (process.env.BILLAR_QUIT_MS) setTimeout(() => app.quit(), +process.env.BILLAR_QUIT_MS);
  });
  app.on('window-all-closed', () => app.quit());
}
