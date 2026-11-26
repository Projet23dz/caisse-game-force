// CashPro — application Windows (Electron).
// Poste « client léger » : la fenêtre affiche l'interface servie par le serveur CashPro (réseau local ou VPN au choix).
// Avantage : une mise à jour du serveur met à jour l'interface de tous les postes.
const { app, BrowserWindow, Menu, ipcMain, shell, net, dialog, safeStorage } = require('electron');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const CONFIG = path.join(app.getPath('userData'), 'config.json');
let win = null;
let currentOrigin = null; // adresse du serveur réellement chargée

// Valeur par défaut fournie par l'installateur serveur (http://localhost:4600) ; sinon l'écran demande l'adresse.
function defaults() {
  try { return JSON.parse(fs.readFileSync(path.join(process.resourcesPath, 'server-default.json'), 'utf8')); } catch { return {}; }
}
function readConfig() {
  try { return { ...defaults(), ...JSON.parse(fs.readFileSync(CONFIG, 'utf8')) }; } catch { return defaults(); }
}
function writeConfig(cfg) {
  fs.mkdirSync(path.dirname(CONFIG), { recursive: true });
  fs.writeFileSync(CONFIG, JSON.stringify(cfg, null, 2));
}
function normalize(url) {
  let u = String(url || '').trim();
  if (!u) return '';
  if (!/^https?:\/\//i.test(u)) u = 'http://' + u;
  const parsed = new URL(u);
  if (!parsed.port && parsed.protocol === 'http:') parsed.port = '4600';
  return parsed.origin;
}

// net.request : disponible aussi dans Electron 22 (version Windows 7), contrairement à net.fetch
function checkServer(origin, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const req = net.request({ url: origin + '/api/health', method: 'GET' });
    req.setHeader('Cache-Control', 'no-cache');
    let body = '';
    const timer = setTimeout(() => { req.abort(); reject(new Error('Délai dépassé')); }, timeoutMs);
    req.on('response', (res) => {
      res.on('data', (c) => { body += c; });
      res.on('end', () => {
        clearTimeout(timer);
        try {
          const j = JSON.parse(body);
          if (res.statusCode !== 200 || !j || j.app !== 'CashPro') return reject(new Error('Réponse inattendue du serveur'));
          resolve(j);
        } catch { reject(new Error('Réponse inattendue du serveur')); }
      });
    });
    req.on('error', (e) => { clearTimeout(timer); reject(e); });
    req.end();
  });
}

function deviceName() {
  return ('cashpro-' + os.hostname()).toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/-+$/, '').slice(0, 60);
}

function status(text) { if (win) win.webContents.send('cashpro:status', text); }

// 1.2.0 : plus de Tailscale intégré. La connexion au serveur (réseau local, Tailscale officiel, ZeroTier…)
// est gérée hors de CashPro ; l'application se contente de l'adresse du serveur.

// ---------------------------------------------------------------- « تذكّرني » : jeton de session chiffré par Windows (DPAPI)
// Le mot de passe n'est jamais gardé. Le jeton est lié au serveur (origine) et illisible sur un autre compte Windows.
const SECRETS = path.join(app.getPath('userData'), 'secrets.json');
const SECRET_KEYS = new Set(['refresh']);
function readSecrets() { try { return JSON.parse(fs.readFileSync(SECRETS, 'utf8')); } catch { return {}; } }
function writeSecrets(o) { fs.mkdirSync(path.dirname(SECRETS), { recursive: true }); fs.writeFileSync(SECRETS, JSON.stringify(o)); }
function secretId(key) { return `${readConfig().server || ''}|${key}`; }
function fromServerPage(e) {
  const url = (e.senderFrame && e.senderFrame.url) || '';
  return !!currentOrigin && url.startsWith(currentOrigin + '/');
}
ipcMain.handle('cashpro:secret-available', () => { try { return safeStorage.isEncryptionAvailable(); } catch { return false; } });
ipcMain.handle('cashpro:secret-get', (e, key) => {
  if (!fromServerPage(e) || !SECRET_KEYS.has(key)) return '';
  const v = readSecrets()[secretId(key)];
  if (!v) return '';
  try { return safeStorage.decryptString(Buffer.from(v, 'base64')); } catch { return ''; }
});
ipcMain.handle('cashpro:secret-set', (e, key, value) => {
  if (!fromServerPage(e) || !SECRET_KEYS.has(key)) return false;
  const all = readSecrets();
  if (!value) delete all[secretId(key)];
  else {
    if (!safeStorage.isEncryptionAvailable()) return false;
    all[secretId(key)] = safeStorage.encryptString(String(value).slice(0, 400)).toString('base64');
  }
  writeSecrets(all);
  return true;
});

// ---------------------------------------------------------------- mise à jour de l'application depuis le serveur
// Le serveur fournit l'installateur des postes (/api/updates/client) : fonctionne sans Internet (LAN / Tailscale).
function isServerPackage() { return fs.existsSync(path.join(process.resourcesPath || '', 'server-default.json')); }
function oldWindows() { return process.platform === 'win32' && parseInt(os.release(), 10) < 10; }
function cmpVersion(a, b) {
  const pa = String(a).split(/[.-]/).map((x) => parseInt(x, 10) || 0), pb = String(b).split(/[.-]/).map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < 3; i++) { const d = (pa[i] || 0) - (pb[i] || 0); if (d) return d; }
  return 0;
}
function getJson(url, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const req = net.request({ url, method: 'GET' });
    let body = '';
    const timer = setTimeout(() => { req.abort(); reject(new Error('Délai dépassé')); }, timeoutMs);
    req.on('response', (res) => {
      res.on('data', (c) => { body += c; });
      res.on('end', () => { clearTimeout(timer); if (res.statusCode !== 200) return resolve(null); try { resolve(JSON.parse(body)); } catch { resolve(null); } });
    });
    req.on('error', (e) => { clearTimeout(timer); reject(e); });
    req.end();
  });
}
function downloadTo(url, file, onProgress) {
  return new Promise((resolve, reject) => {
    const req = net.request({ url, method: 'GET' });
    const out = fs.createWriteStream(file);
    const hash = crypto.createHash('sha512');
    req.on('response', (res) => {
      if (res.statusCode !== 200) { out.destroy(); return reject(new Error('HTTP ' + res.statusCode)); }
      const total = Number(res.headers['content-length']) || 0; let got = 0;
      res.on('data', (c) => { hash.update(c); out.write(c); got += c.length; if (total && onProgress) onProgress(got / total); });
      res.on('end', () => out.end(() => resolve(hash.digest('base64'))));
      res.on('error', (e) => { out.destroy(); reject(e); });
    });
    req.on('error', (e) => { out.destroy(); reject(e); });
    req.end();
  });
}
let updateBusy = false;
async function checkClientUpdate(origin, { manual = false } = {}) {
  if (updateBusy || !origin) return { status: 'busy' };
  if (isServerPackage()) return { status: 'server' };     // le poste serveur se met à jour depuis la page « التحديثات »
  if (oldWindows()) return { status: 'unsupported' };     // Windows 7/8 : version dédiée, mise à jour manuelle
  const info = await getJson(origin + '/api/updates/client').catch(() => null);
  if (!info || !info.version) return { status: 'none' };
  if (cmpVersion(info.version, app.getVersion()) <= 0) return { status: 'uptodate', version: app.getVersion() };
  const r = await dialog.showMessageBox(win, {
    type: 'info', title: 'CashPro', defaultId: 0, cancelId: 1,
    buttons: ['تحديث الآن — Mettre à jour', 'لاحقاً — Plus tard'],
    message: `تحديث CashPro ${info.version} متوفّر\nMise à jour disponible : ${info.version}`,
    detail: `النسخة الحالية / version actuelle : ${app.getVersion()}\nالتحديث يستغرق أقل من دقيقة ثم يُعاد فتح البرنامج.\nLa mise à jour prend moins d'une minute, puis CashPro redémarre.`,
  });
  if (r.response !== 0) return { status: 'later', version: info.version };
  updateBusy = true;
  try {
    const file = path.join(app.getPath('temp'), `CashPro-Setup-${info.version}.exe`);
    status('جارٍ تحميل التحديث… — Téléchargement de la mise à jour…');
    const sha = await downloadTo(origin + (info.url || '/api/updates/client/file'), file, (p) => { if (win) win.setProgressBar(p); });
    if (win) win.setProgressBar(-1);
    if (sha !== info.sha512) { try { fs.unlinkSync(file); } catch {} throw new Error('Empreinte invalide : fichier refusé'); }
    spawn(file, ['/S', '--force-run'], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
    setTimeout(() => app.quit(), 500);
    return { status: 'installing', version: info.version };
  } catch (e) {
    if (win) win.setProgressBar(-1);
    if (manual) throw e;
    dialog.showErrorBox('CashPro', 'تعذّر التحديث / Mise à jour impossible : ' + (e && e.message || e));
    return { status: 'failed' };
  } finally { updateBusy = false; }
}

function showSetup(message, info) {
  win.loadFile(path.join(__dirname, 'setup.html'), { query: { server: readConfig().server || '', error: message || '', info: info || '' } });
}

// Connexion directe à l'adresse du serveur (réseau local ou VPN choisi : Tailscale officiel, ZeroTier…)
async function connect(cfg) {
  await checkServer(cfg.server, 15000);
  return cfg.server;
}

// 1.3.6 — mode hors connexion : l'interface déjà ouverte une fois sur ce poste est gardée (service worker),
// l'application s'ouvre donc même si le serveur est injoignable ; les opérations attendent sur le poste.
function markOfflineReady(origin) {
  const c = readConfig();
  if (c.offlineOrigin === origin) return;
  try { writeConfig({ ...c, offlineOrigin: origin }); } catch { /* */ }
}
let offlineStart = false;
async function openServer() {
  const cfg = readConfig();
  if (!cfg.server) return showSetup('');
  const canOffline = cfg.offlineOrigin === cfg.server;
  try {
    await checkServer(cfg.server, canOffline ? 6000 : 15000);
  } catch (e) {
    if (!canOffline) return showSetup(`Serveur injoignable : ${cfg.server} (${e.message})`);
    offlineStart = true;   // ouverture sur la copie gardée ; en cas d'échec, écran de connexion habituel
  }
  currentOrigin = cfg.server;
  try { await win.loadURL(cfg.server + '/'); } catch { /* did-fail-load affiche l'écran de connexion */ }
  if (!offlineStart) setTimeout(() => { checkClientUpdate(cfg.server).catch(() => {}); }, 4000);
}

function createWindow() {
  win = new BrowserWindow({
    width: 1440, height: 900, minWidth: 1000, minHeight: 640, show: false,
    backgroundColor: '#0A0E27', title: 'CashPro', icon: path.join(__dirname, 'build', 'icon.png'),
    autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true, spellcheck: false },
  });
  win.once('ready-to-show', () => { win.maximize(); win.show(); });

  // Sécurité : la fenêtre ne navigue que vers le serveur configuré ; tout autre lien s'ouvre dans le navigateur.
  const allowed = (url) => url.startsWith('file://') || (currentOrigin && url.startsWith(currentOrigin + '/'));
  win.webContents.on('will-navigate', (e, url) => { if (!allowed(url)) { e.preventDefault(); if (/^https?:/.test(url)) shell.openExternal(url); } });
  win.webContents.setWindowOpenHandler(({ url }) => { if (/^https?:/.test(url)) shell.openExternal(url); return { action: 'deny' }; });
  win.webContents.on('did-fail-load', (_e, code, desc, url, isMainFrame) => {
    if (isMainFrame === false) return;
    if (code !== -3 && !String(url).startsWith('file://')) {
      showSetup(offlineStart ? `Serveur injoignable : ${readConfig().server} (${desc})` : `Connexion perdue (${desc}).`);
      offlineStart = false;
    }
  });
  win.webContents.on('did-finish-load', () => {
    const url = win.webContents.getURL();
    if (currentOrigin && url.startsWith(currentOrigin + '/') && !offlineStart) markOfflineReady(currentOrigin);
  });
  openServer();
}

const menu = Menu.buildFromTemplate([
  { label: 'CashPro', submenu: [
    { label: 'Changer de serveur…', accelerator: 'Ctrl+Shift+S', click: () => showSetup('') },
    { label: 'Actualiser', accelerator: 'F5', click: () => win && win.webContents.reload() },
    { label: 'البحث عن تحديث — Rechercher une mise à jour', click: async () => {
      try {
        const r = await checkClientUpdate(currentOrigin, { manual: true });
        if (r.status === 'uptodate') dialog.showMessageBox(win, { type: 'info', title: 'CashPro', message: `CashPro ${app.getVersion()} — آخر نسخة / à jour` });
        else if (r.status === 'none') dialog.showMessageBox(win, { type: 'info', title: 'CashPro', message: 'لا يوجد تحديث على السيرفر — Aucune mise à jour sur le serveur' });
        else if (r.status === 'server') dialog.showMessageBox(win, { type: 'info', title: 'CashPro', message: 'السيرفر يُحدَّث من الإعدادات ← التحديثات — Serveur : Paramètres > Mises à jour' });
      } catch (e) { dialog.showErrorBox('CashPro', String(e && e.message || e)); }
    } },
    { type: 'separator' },
    { label: 'Plein écran', role: 'togglefullscreen' },
    { label: 'Zoom +', role: 'zoomIn' }, { label: 'Zoom −', role: 'zoomOut' }, { label: 'Zoom 100 %', role: 'resetZoom' },
    { type: 'separator' },
    { label: 'Imprimer', accelerator: 'Ctrl+P', click: () => win && win.webContents.print() },
    { label: 'Quitter', role: 'quit' },
  ] },
]);

// payload : adresse (texte) ou { url } (anciennes options Tailscale ignorées)
function parsePayload(p) {
  const o = typeof p === 'string' ? { url: p } : (p || {});
  return { server: normalize(o.url) };
}
ipcMain.handle('cashpro:test-server', async (_e, p) => {
  const cfg = parsePayload(p);
  const info = await checkServer(cfg.server, 15000);
  return { origin: cfg.server, version: info.version, via: 'direct' };
});
ipcMain.handle('cashpro:save-server', async (_e, p) => {
  const cfg = parsePayload(p);
  await connect(cfg);
  const old = readConfig(); delete old.tailscale;
  writeConfig({ ...old, ...cfg });
  currentOrigin = cfg.server;
  await win.loadURL(cfg.server + '/');
  return cfg.server;
});
ipcMain.handle('cashpro:setup-info', () => {
  const c = readConfig();
  return { server: c.server || '', device: deviceName() };
});
ipcMain.handle('cashpro:change-server', () => showSetup(''));
ipcMain.handle('cashpro:version', () => app.getVersion());
ipcMain.handle('cashpro:check-update', (e) => (fromServerPage(e) ? checkClientUpdate(currentOrigin, { manual: true }) : { status: 'denied' }));

// Service worker (copie de l'interface) : exige une origine « sûre ». Le serveur CashPro est en HTTP sur le réseau
// local / Tailscale : seule son adresse configurée est traitée comme sûre (avant le démarrage de Chromium).
try {
  const srv = readConfig().server;
  if (srv && /^http:\/\//.test(srv)) app.commandLine.appendSwitch('unsafely-treat-insecure-origin-as-secure', srv);
} catch { /* */ }

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });
  app.whenReady().then(() => { Menu.setApplicationMenu(menu); createWindow(); });
  app.on('window-all-closed', () => app.quit());
  process.on('uncaughtException', (e) => dialog.showErrorBox('CashPro', String(e && e.message || e)));
}
