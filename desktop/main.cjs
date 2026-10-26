// Cadre — desktop app (Electron), macOS and Windows.
// - Starts the engine (Python, ../engine) and restarts it if it stops. The app is what reads the files, so macOS asks
//   for access to protected folders (Documents, iCloud) on behalf of "Cadre".
// - Two modes: "linked" (development repo: engine/.venv already exists) or "standalone" (distributed app: the engine
//   ships in the resources; on first launch, the bundled uv installs Python and the dependencies into the user's
//   data folder; no manual installation).
// - `--background` (launched at login): no window, the engine runs for remote access.
const { app, BrowserWindow, Menu, dialog, ipcMain, shell, nativeTheme, session } = require('electron');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const WIN = process.platform === 'win32';
const MAC = process.platform === 'darwin';
const NAME = 'Cadre';
app.setName(NAME);

const CONF = (() => { try { return JSON.parse(fs.readFileSync(path.join(__dirname, 'app-path.json'), 'utf8')); } catch { return {}; } })();
// root containing engine/ and web/: CADRE_ROOT variable, linked repo (app-path.json), or the app's resources
const ROOT = process.env.CADRE_ROOT || CONF.root || (app.isPackaged ? path.join(process.resourcesPath, 'cadre') : path.resolve(__dirname, '..'));
const ENGINE = path.join(ROOT, 'engine');
const LINKED_PY = path.join(ENGINE, '.venv', WIN ? 'Scripts' : 'bin', WIN ? 'python.exe' : 'python');
const LINKED = fs.existsSync(LINKED_PY);
const USER = app.getPath('userData');                         // ~/Library/Application Support/Cadre, %APPDATA%\Cadre
const ENV_DIR = path.join(USER, 'engine-env');
const PY = LINKED ? LINKED_PY : path.join(ENV_DIR, WIN ? 'Scripts' : 'bin', WIN ? 'python.exe' : 'python');
const UV = [path.join(process.resourcesPath || '', 'bin', WIN ? 'uv.exe' : 'uv'), path.join(__dirname, 'bin', WIN ? 'uv.exe' : 'uv')].find((p) => fs.existsSync(p))
  || (WIN ? 'uv.exe' : 'uv');
const RENDER_DIR = path.join(USER, 'render');                 // render engine copied here (it downloads its browser when needed)
const PORT = 8765;
const URL = `http://127.0.0.1:${PORT}`;
const LOG_DIR = app.getPath('logs');
const LOG = path.join(LOG_DIR, 'cadre.log');
const BACKGROUND = process.argv.includes('--background');
const VERSION = app.getVersion();

let server = null;
let quitting = false;
let win = null;
let target = null;          // cadre://p/<id> link to open
let setupState = null;      // { step, detail, error }

nativeTheme.themeSource = 'dark';
const SYS_LANG = (() => { try { return app.getLocale().slice(0, 2); } catch { return 'fr'; } })();
const L = (fr, en) => (SYS_LANG === 'fr' ? fr : en);
app.setAboutPanelOptions({ applicationName: NAME, applicationVersion: VERSION, copyright: L('Logiciel de montage avec assistant IA', 'Video editor with an AI assistant') });
fs.mkdirSync(LOG_DIR, { recursive: true });
const log = (s) => { try { fs.appendFileSync(LOG, `[${new Date().toISOString()}] ${s}\n`); } catch { /* log unavailable */ } };

/** cadre://p/<id> -> editor page; cadre:// -> home */
function pageFor(link) {
  const m = /^cadre:\/\/(?:p|projet)\/([\w-]+)/.exec(link || '');
  return m ? `${URL}/#/p/${m[1]}` : URL;
}

function health() {
  return new Promise((res) => {
    const req = http.get(`${URL}/api/health`, { timeout: 1500 }, (r) => { r.resume(); res(r.statusCode === 200); });
    req.on('error', () => res(false));
    req.on('timeout', () => { req.destroy(); res(false); });
  });
}

function baseEnv() {
  const home = os.homedir();
  const extra = WIN ? [] : [path.join(home, '.local/bin'), '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin'];
  const env = {
    ...process.env,
    PATH: [...extra, process.env.PATH || ''].join(path.delimiter),
    CADRE_UV: UV,
    CADRE_NODE: process.execPath,                               // rendering runs on the app's built-in Node
    PYTHONUNBUFFERED: '1',
  };
  if (!LINKED) env.UV_PROJECT_ENVIRONMENT = ENV_DIR;
  if (fs.existsSync(path.join(RENDER_DIR, 'render.mjs'))) { env.CADRE_RENDERER = path.join(RENDER_DIR, 'render.mjs'); env.CADRE_BUNDLE = path.join(RENDER_DIR, 'bundle'); }
  return env;
}

function run(cmd, args, opts, onLine) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { ...opts, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    const feed = (b) => String(b).split(/\r?\n/).forEach((l) => { if (l.trim()) { log(l); onLine?.(l.trim()); } });
    p.stdout.on('data', feed);
    p.stderr.on('data', feed);
    p.on('error', reject);
    p.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(L(`${path.basename(cmd)} a échoué (code ${code})`, `${path.basename(cmd)} failed (code ${code})`)))));
  });
}

/** first launch (standalone mode): Python + engine dependencies, then the render engine */
async function bootstrap() {
  if (LINKED) return;
  const marker = path.join(USER, 'engine-version');
  const done = fs.existsSync(PY) && fs.existsSync(marker) && fs.readFileSync(marker, 'utf8').trim() === VERSION;
  const renderSrc = path.join(ROOT, 'render');
  const renderMarker = path.join(RENDER_DIR, 'version');
  const renderDone = !fs.existsSync(renderSrc) || (fs.existsSync(renderMarker) && fs.readFileSync(renderMarker, 'utf8').trim() === VERSION);
  if (done && renderDone) return;
  fs.mkdirSync(USER, { recursive: true });
  if (!done) {
    setupState = { step: L('Installation du moteur', 'Installing the engine'), detail: L('téléchargement de Python et des composants (une seule fois, quelques minutes)…', 'downloading Python and components (one time only, a few minutes)…') };
    pushSetup();
    await run(UV, ['sync', '--frozen', '--no-dev', '--project', ENGINE, '--python', '3.13'], { cwd: ENGINE, env: { ...baseEnv(), UV_PROJECT_ENVIRONMENT: ENV_DIR } }, (l) => {
      setupState.detail = l.slice(0, 140);
      pushSetup();
    });
    fs.writeFileSync(marker, VERSION);
  }
  if (!renderDone) {
    setupState = { step: L('Préparation du rendu vidéo', 'Preparing video rendering'), detail: L('copie du moteur de rendu…', 'copying the render engine…') };
    pushSetup();
    fs.rmSync(RENDER_DIR, { recursive: true, force: true });
    fs.cpSync(renderSrc, RENDER_DIR, { recursive: true, dereference: true });
    fs.writeFileSync(renderMarker, VERSION);
  }
  setupState = null;
}

async function ensureServer() {
  if (server || quitting) return;
  if (await health()) return;              // an engine is already running (started some other way): use it
  try { await bootstrap(); } catch (e) {
    log(`setup: ${e.message}`);
    setupState = { step: L('Installation impossible', 'Setup failed'), detail: L(`${e.message}. Vérifie la connexion Internet puis relance Cadre. Journal : ${LOG}`, `${e.message}. Check your Internet connection, then restart Cadre. Log: ${LOG}`), error: true };
    pushSetup();
    return;
  }
  const out = fs.openSync(LOG, 'a');
  server = spawn(PY, ['-m', 'cadre_engine.run'], { cwd: ENGINE, env: baseEnv(), stdio: ['ignore', out, out], windowsHide: true });
  log(`engine started (${LINKED ? 'linked' : 'standalone'}): ${PY}`);
  server.on('exit', (code) => {
    log(`engine stopped (code ${code})`);
    server = null;
    if (!quitting) setTimeout(ensureServer, 3000);   // automatic restart
  });
}

const splash = () => 'data:text/html;charset=utf-8,' + encodeURIComponent(`<!doctype html><html><head><meta charset="utf-8"></head>
<body style="margin:0;background:#0f1012;color:#e4e5e8;font:13px -apple-system,'Segoe UI',sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;-webkit-app-region:drag;user-select:none">
<div style="text-align:center;max-width:460px;padding:0 24px">
<svg viewBox="0 0 24 24" width="44" height="44"><rect x="1" y="1" width="22" height="22" rx="5" fill="#3a82f7"/><path d="M6.5 9.5V6.5h3 M17.5 9.5V6.5h-3 M6.5 14.5v3h3 M17.5 14.5v3h-3" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>
<div style="font-weight:600;font-size:16px;margin:14px 0 6px">Cadre</div>
<div id="s" style="color:#a4a7ae">${L('Démarrage…', 'Starting…')}</div>
<div id="d" style="color:#6c6f77;font:11px ui-monospace,Menlo,monospace;margin-top:10px;min-height:28px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap"></div>
</div>
<script>window.setup=(s,d,e)=>{document.getElementById('s').textContent=s;document.getElementById('s').style.color=e?'#e5534b':'#a4a7ae';document.getElementById('d').textContent=d||''}</script>
</body></html>`);

function pushSetup() {
  if (!win || !setupState) return;
  const s = setupState;
  win.webContents.executeJavaScript(`window.setup && window.setup(${JSON.stringify(s.step)}, ${JSON.stringify(s.detail || '')}, ${!!s.error})`).catch(() => undefined);
}

const BOUNDS = path.join(USER, 'window.json');
function savedBounds() {
  try {
    const b = JSON.parse(fs.readFileSync(BOUNDS, 'utf8'));
    const { screen } = require('electron');
    const ok = screen.getAllDisplays().some((d) => b.x >= d.bounds.x - 50 && b.y >= d.bounds.y - 50 && b.x < d.bounds.x + d.bounds.width - 100 && b.y < d.bounds.y + d.bounds.height - 100);
    return ok ? b : { width: b.width, height: b.height };
  } catch { return { width: 1600, height: 1000 }; }
}
function rememberBounds() {
  if (!win || win.isDestroyed()) return;
  try { fs.writeFileSync(BOUNDS, JSON.stringify({ ...win.getNormalBounds(), maximized: win.isMaximized() })); } catch { /* disk full? */ }
}

async function createWindow() {
  if (win) { win.show(); win.focus(); return; }
  if (MAC) app.dock.show();
  const b = savedBounds();
  win = new BrowserWindow({
    ...b, minWidth: 1100, minHeight: 700, show: false, backgroundColor: '#0f1012', title: NAME,
    ...(MAC ? { titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 14, y: 12 } } : { autoHideMenuBar: true }),
    icon: path.join(__dirname, 'icon.png'),
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, sandbox: false, backgroundThrottling: false },
  });
  win.once('ready-to-show', () => { if (b.maximized) win.maximize(); win.show(); });
  let t = null;
  const later = () => { clearTimeout(t); t = setTimeout(rememberBounds, 400); };
  win.on('resize', later); win.on('move', later); win.on('close', rememberBounds);
  win.webContents.setVisualZoomLevelLimits(1, 1).catch(() => undefined);
  win.webContents.on('will-navigate', (e, url) => { if (!url.startsWith(URL) && !url.startsWith('data:')) { e.preventDefault(); if (/^https?:\/\//.test(url)) shell.openExternal(url); } });
  win.on('focus', () => buildMenu());
  win.on('closed', () => {
    win = null;
    if (MAC && !quitting) app.dock.hide();   // the engine keeps running in the background
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith(URL)) return { action: 'allow' };
    if (/^https?:\/\//.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  await win.loadURL(splash());
  pushSetup();
  for (let i = 0; i < 1200 && !(await health()); i++) {
    if (setupState?.error) return;
    await new Promise((r) => setTimeout(r, 500));
  }
  if (win) win.loadURL(pageFor(target));
  target = null;
}

app.on('open-url', async (e, link) => {
  e.preventDefault();
  if (win) { win.show(); win.focus(); win.loadURL(pageFor(link)); return; }
  target = link;
  if (app.isReady()) createWindow();
});

function send(action) {
  const w = BrowserWindow.getFocusedWindow() || win;
  if (w) w.webContents.send('menu', action);
}

let recent = [];
function fetchRecent() {
  return new Promise((res) => {
    const req = http.get(`${URL}/api/projects`, { timeout: 1500 }, (r) => {
      let d = '';
      r.on('data', (c) => { d += c; });
      r.on('end', () => { try { recent = JSON.parse(d).slice(0, 8); } catch { /* engine not ready */ } res(); });
    });
    req.on('error', () => res());
    req.on('timeout', () => { req.destroy(); res(); });
  });
}

async function buildMenu() {
  await fetchRecent();
  const cmd = (k) => (MAC ? `Cmd+${k}` : `Ctrl+${k}`);
  const open = (hash) => { if (win) { win.show(); win.loadURL(`${URL}/${hash}`); } else { target = null; createWindow().then(() => win && win.loadURL(`${URL}/${hash}`)); } };
  const tpl = [
    ...(MAC ? [{ label: NAME, submenu: [
      { label: L(`À propos de ${NAME}`, `About ${NAME}`), role: 'about' },
      { type: 'separator' },
      { label: L('Réglages…', 'Settings…'), accelerator: 'Cmd+,', click: () => send('settings') },
      { type: 'separator' },
      { label: L(`Masquer ${NAME}`, `Hide ${NAME}`), role: 'hide' }, { label: L('Masquer les autres', 'Hide Others'), role: 'hideOthers' }, { label: L('Tout afficher', 'Show All'), role: 'unhide' },
      { type: 'separator' },
      { label: L(`Quitter ${NAME}`, `Quit ${NAME}`), accelerator: 'Cmd+Q', role: 'quit' },
    ] }] : []),
    { label: L('Fichier', 'File'), submenu: [
      { label: L('Projets', 'Projects'), accelerator: cmd('Shift+H'), click: () => open('#/') },
      { label: L('Ouvrir récent', 'Open Recent'), submenu: recent.length ? recent.map((p) => ({ label: p.name, click: () => open(`#/p/${p.id}`) })) : [{ label: L('Aucun projet', 'No projects'), enabled: false }] },
      { type: 'separator' },
      { label: L('Importer des médias…', 'Import Media…'), accelerator: cmd('I'), click: () => send('import') },
      { label: L('Exporter…', 'Export…'), accelerator: cmd('E'), click: () => send('export') },
      { type: 'separator' },
      { label: L('Ouvrir le dossier des données', 'Open Data Folder'), click: () => shell.openPath(USER) },
      { label: L('Ouvrir le journal', 'Open Log'), click: () => shell.openPath(LOG) },
      { type: 'separator' },
      { label: L('Fermer la fenêtre', 'Close Window'), accelerator: cmd('W'), click: () => win && win.close() },
      ...(WIN ? [{ label: L('Réglages', 'Settings'), accelerator: 'Ctrl+,', click: () => send('settings') }, { label: L('Quitter', 'Exit'), role: 'quit' }] : []),
    ] },
    { label: L('Édition', 'Edit'), submenu: [
      { label: L('Annuler', 'Undo'), accelerator: cmd('Z'), click: () => send('undo') },
      { label: L('Rétablir', 'Redo'), accelerator: cmd('Shift+Z'), click: () => send('redo') },
      { type: 'separator' },
      { label: L('Couper', 'Cut'), role: 'cut' }, { label: L('Copier', 'Copy'), role: 'copy' }, { label: L('Coller', 'Paste'), role: 'paste' },
      { label: L('Tout sélectionner', 'Select All'), role: 'selectAll' },
      { type: 'separator' },
      { label: L('Couper à la tête de lecture', 'Split at Playhead'), click: () => send('split') },
      { label: L('Dupliquer', 'Duplicate'), accelerator: cmd('D'), click: () => send('duplicate') },
      { label: L('Ajouter un marqueur', 'Add Marker'), click: () => send('marker') },
      { label: L('Supprimer la sélection', 'Delete Selection'), click: () => send('delete') },
    ] },
    { label: L('Lecture', 'Playback'), submenu: [
      { label: L('Lecture / pause', 'Play / Pause'), click: () => send('play') },
      { label: L('Assistant', 'Assistant'), accelerator: cmd('K'), click: () => send('ai') },
    ] },
    { label: L('Affichage', 'View'), submenu: [
      { label: L('Recharger', 'Reload'), accelerator: cmd('R'), role: 'reload' },
      { label: L('Taille réelle', 'Actual Size'), role: 'resetZoom' }, { label: L('Agrandir', 'Zoom In'), role: 'zoomIn' }, { label: L('Réduire', 'Zoom Out'), role: 'zoomOut' },
      { type: 'separator' },
      { label: L('Plein écran', 'Toggle Full Screen'), role: 'togglefullscreen' },
      { label: L('Outils de développement', 'Developer Tools'), accelerator: MAC ? 'Alt+Cmd+I' : 'Ctrl+Shift+I', role: 'toggleDevTools' },
    ] },
    { label: L('Fenêtre', 'Window'), role: 'windowMenu' },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(tpl));
  if (MAC) app.dock.setMenu(Menu.buildFromTemplate(recent.slice(0, 5).map((p) => ({ label: p.name, click: () => open(`#/p/${p.id}`) }))));
}

ipcMain.handle('pick-files', async (_e, opts = {}) => {
  const r = await dialog.showOpenDialog(win, {
    title: L('Importer des médias', 'Import Media'), properties: ['openFile', 'multiSelections'],
    filters: opts.images ? [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif'] }]
      : [{ name: L('Médias', 'Media'), extensions: ['mp4', 'mov', 'mkv', 'webm', 'm4v', 'avi', 'mts', 'm2ts', 'ts', 'flv', 'mxf', 'mp3', 'wav', 'm4a', 'aac', 'flac', 'ogg', 'aif', 'aiff', 'png', 'jpg', 'jpeg', 'webp', 'gif', 'heic'] }],
  });
  return r.canceled ? [] : r.filePaths;
});
ipcMain.handle('pick-folder', async () => {
  const r = await dialog.showOpenDialog(win, { title: L('Choisir un dossier', 'Choose a Folder'), properties: ['openDirectory'] });
  return r.canceled ? null : r.filePaths[0];
});
ipcMain.on('reveal', (_e, p) => shell.showItemInFolder(p));
ipcMain.on('open-external', (_e, u) => { if (/^https?:\/\//.test(u)) shell.openExternal(u); });

// launch at login, without a window (engine available for remote access);
// restarted by macOS if the app crashes (not when it is quit normally)
function loginItem() {
  if (!app.isPackaged) return;
  if (MAC) {
    const plist = path.join(os.homedir(), 'Library', 'LaunchAgents', 'app.cadre.plist');
    const body = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>app.cadre</string>
<key>ProgramArguments</key><array><string>${process.execPath}</string><string>--background</string></array>
<key>RunAtLoad</key><true/>
<key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
<key>ThrottleInterval</key><integer>15</integer>
<key>ProcessType</key><string>Interactive</string>
</dict></plist>
`;
    try { if (!fs.existsSync(plist) || fs.readFileSync(plist, 'utf8') !== body) fs.writeFileSync(plist, body); } catch (e) { log(`login item: ${e.message}`); }
  } else {
    app.setLoginItemSettings({ openAtLogin: true, args: ['--background'] });
  }
}

if (!app.requestSingleInstanceLock()) app.quit();
app.on('second-instance', (_e, argv) => {
  const link = argv.find((a) => a.startsWith('cadre://'));
  if (link) target = link;
  createWindow().then(() => { if (link && win) win.loadURL(pageFor(link)); });
});
app.on('activate', () => createWindow());
app.on('window-all-closed', () => { /* stay alive: engine for remote access */ });
app.on('before-quit', () => {
  quitting = true;
  if (server) {
    const s = server;
    s.kill('SIGTERM');
    setTimeout(() => { try { s.kill('SIGKILL'); } catch { /* already stopped */ } }, 2500);
  }
});

app.setAsDefaultProtocolClient('cadre');

app.whenReady().then(async () => {
  buildMenu();
  loginItem();
  session.defaultSession.setPermissionRequestHandler((_wc, perm, cb) => cb(['media', 'fullscreen', 'clipboard-sanitized-write', 'clipboard-read'].includes(perm)));
  const link = process.argv.find((a) => a.startsWith('cadre://'));
  if (link) target = link;
  const started = ensureServer();
  if (BACKGROUND && !target) { if (MAC) app.dock.hide(); await started; }
  else { createWindow(); await started; }
});
