// CashPro — version D'ESSAI pour Windows 7 SP1 (64 bits). Ne pas utiliser comme serveur réel.
// Moteur : le Node.js 16 intégré à CashPro.exe (Electron 22, compatible Windows 7), lancé avec ELECTRON_RUN_AS_NODE=1.
// (Node.js 18 officiel exige EventSetInformation d'ADVAPI32, absent de nombreux Windows 7.)
// Tout reste dans ce dossier (data\) : PostgreSQL 15 démarré à la demande, API sur 127.0.0.1:4600,
// fenêtre CashPro ; à la fermeture de la fenêtre, tout s'arrête.
'use strict';
const { spawn, spawnSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const path = require('node:path');

const ROOT = __dirname;
const EXE = process.platform === 'win32' ? '.exe' : '';
const PG_BIN = process.env.CASHPRO_PG_BIN || path.join(ROOT, 'pgsql', 'bin');
const API = path.join(ROOT, 'api', 'dist', 'server.js');
const SQL = path.join(ROOT, 'database');
const DATA = process.env.CASHPRO_DEMO_DATA || path.join(ROOT, 'data');
const PGDATA = path.join(DATA, 'pgdata');
const LOGS = path.join(DATA, 'logs');
const CFG = path.join(DATA, 'demo.json');
const ENV_FILE = path.join(DATA, 'cashpro.env');
const API_PORT = Number(process.env.CASHPRO_DEMO_PORT || 4600);
const CLIENT = path.join(ROOT, 'app', 'CashPro.exe');
const NO_UI = process.argv.includes('--no-ui');
// Android (Termux) : CASHPRO_DEMO_HOST=0.0.0.0 pour ouvrir aux autres appareils du WiFi
const API_HOST = process.env.CASHPRO_DEMO_HOST || '127.0.0.1';

const bin = (n) => path.join(PG_BIN, n + EXE);
const say = (m) => console.log('[CashPro] ' + m);
function secret(n) {
  const c = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
  return Array.from(crypto.randomBytes(n), (b) => c[b % c.length]).join('');
}
function run(exe, args, what, opts = {}) {
  const r = spawnSync(exe, args, { encoding: 'utf8', windowsHide: true, ...opts });
  if (r.error) throw new Error(`${what} : ${r.error.message}`);
  if (r.status !== 0) throw new Error(`${what} a échoué (code ${r.status})\n${r.stdout || ''}${r.stderr || ''}`);
  return (r.stdout || '').trim();
}
function portFree(p) {
  return new Promise((res) => {
    const s = net.createServer().once('error', () => res(false)).once('listening', () => s.close(() => res(true)));
    s.listen(p, '127.0.0.1');
  });
}
function health() {
  return new Promise((res) => {
    const r = http.get({ host: '127.0.0.1', port: API_PORT, path: '/api/health', timeout: 3000 }, (x) => {
      let b = ''; x.on('data', (c) => (b += c)); x.on('end', () => { try { res(JSON.parse(b).app === 'CashPro'); } catch { res(false); } });
    });
    r.on('error', () => res(false)); r.on('timeout', () => { r.destroy(); res(false); });
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  for (const f of [bin('initdb'), bin('pg_ctl'), bin('psql'), API]) if (!fs.existsSync(f)) throw new Error('Fichier manquant : ' + f);
  fs.mkdirSync(LOGS, { recursive: true });
  for (const d of ['attachments', 'logos', 'backups']) fs.mkdirSync(path.join(DATA, d), { recursive: true });

  // 1. PostgreSQL (initialisation au premier lancement)
  let cfg = fs.existsSync(CFG) ? JSON.parse(fs.readFileSync(CFG, 'utf8')) : null;
  if (!fs.existsSync(path.join(PGDATA, 'PG_VERSION'))) {
    say('Premier lancement : préparation de la base (1 minute)…');
    let port = 55432;
    while (!(await portFree(port))) if (++port > 55460) throw new Error('Aucun port libre pour PostgreSQL');
    cfg = { pgPort: port, superPass: secret(24), appPass: secret(24), bkpPass: secret(24), jwt: secret(64), db: false };
    const pw = path.join(DATA, '.pw.tmp');
    fs.writeFileSync(pw, cfg.superPass);
    try {
      run(bin('initdb'), ['-D', PGDATA, '-U', 'postgres', '-E', 'UTF8', '--no-locale', '--auth=scram-sha-256', '--pwfile=' + pw], 'Initialisation PostgreSQL');
    } finally { fs.rmSync(pw, { force: true }); }
    fs.appendFileSync(path.join(PGDATA, 'postgresql.conf'),
      `\n# --- CashPro (essai) ---\nlisten_addresses = '127.0.0.1'\nport = ${port}\ntimezone = 'Africa/Algiers'\nlog_timezone = 'Africa/Algiers'\nmax_connections = 30\nshared_buffers = 128MB\n`
      + (process.platform === 'win32' ? '' : `unix_socket_directories = '${PGDATA.replace(/'/g, "''")}'\n`));
    fs.writeFileSync(CFG, JSON.stringify(cfg, null, 2));
  }
  if (!cfg) throw new Error('Configuration ' + CFG + ' absente : supprimez le dossier data pour repartir de zéro.');
  const pgEnv = { ...process.env, PGPASSWORD: cfg.superPass };
  const st = spawnSync(bin('pg_ctl'), ['status', '-D', PGDATA], { windowsHide: true });
  if (st.status !== 0) {
    say('Démarrage de PostgreSQL…');
    const pgLog = path.join(LOGS, 'postgresql.log');
    try {
      run(bin('pg_ctl'), ['start', '-D', PGDATA, '-l', pgLog, '-w', '-t', '60'], 'Démarrage PostgreSQL', { stdio: 'ignore' });
    } catch (e) {
      let tail = ''; try { tail = fs.readFileSync(pgLog, 'utf8').split('\n').slice(-15).join('\n'); } catch {}
      throw new Error(e.message + '\n--- ' + pgLog + ' ---\n' + tail);
    }
  }
  const psql = ['-h', '127.0.0.1', '-p', String(cfg.pgPort), '-U', 'postgres', '-v', 'ON_ERROR_STOP=1', '-q'];

  // 2. Base + données initiales
  if (!cfg.db) {
    const exists = run(bin('psql'), [...psql, '-tAc', "SELECT 1 FROM pg_database WHERE datname='cashpro'"], 'Lecture des bases', { env: pgEnv });
    if (exists !== '1') run(bin('psql'), [...psql, '-c', "CREATE DATABASE cashpro ENCODING 'UTF8' TEMPLATE template0"], 'Création de la base', { env: pgEnv });
    for (const f of ['01_schema.sql', '02_logic.sql', '03_security.sql', '04_reports.sql', '05_seed.sql', '06_api.sql']) {
      say('  -> ' + f);
      run(bin('psql'), [...psql, '-d', 'cashpro', '-f', path.join(SQL, f)], 'Script ' + f, { env: pgEnv });
    }
    run(bin('psql'), [...psql, '-d', 'cashpro', '-c', `ALTER ROLE cashpro_app PASSWORD '${cfg.appPass}'; ALTER ROLE cashpro_backup PASSWORD '${cfg.bkpPass}';`], 'Mots de passe', { env: pgEnv });
    cfg.db = true;
    fs.writeFileSync(CFG, JSON.stringify(cfg, null, 2));
  }
  // Mises à jour de la base (07 et suivants, rejouables) : à chaque lancement
  for (const f of fs.readdirSync(SQL).filter((n) => /^(0[7-9]|[1-9]\d)_.*\.sql$/.test(n)).sort()) {
    run(bin('psql'), [...psql, '-d', 'cashpro', '-f', path.join(SQL, f)], 'Mise à jour ' + f, { env: pgEnv });
  }
  fs.writeFileSync(ENV_FILE, [
    '# CashPro — version d\'essai (générée automatiquement)',
    `DATABASE_URL=postgresql://cashpro_app:${cfg.appPass}@127.0.0.1:${cfg.pgPort}/cashpro`,
    `JWT_SECRET=${cfg.jwt}`, 'JWT_TTL=12h', `HOST=${API_HOST}`, `PORT=${API_PORT}`, `DATA_DIR=${DATA}`, '',
  ].join('\n'));

  // 3. API
  if (!(await portFree(API_PORT))) throw new Error(`Le port ${API_PORT} est déjà utilisé (CashPro déjà ouvert ?)`);
  say('Démarrage de CashPro…');
  const log = fs.openSync(path.join(LOGS, 'api.log'), 'a');
  const api = spawn(process.execPath, [API], {
    cwd: path.join(ROOT, 'api'), windowsHide: true, stdio: ['ignore', log, log],
    env: { ...process.env, CASHPRO_ENV_FILE: ENV_FILE, ELECTRON_RUN_AS_NODE: '1', NODE_ENV: 'production' },
  });
  let ok = false;
  for (let i = 0; i < 60 && !ok; i++) { if (api.exitCode !== null) break; ok = await health(); if (!ok) await sleep(1000); }
  if (!ok) { try { api.kill(); } catch {} throw new Error('L\'API ne répond pas — voir ' + path.join(LOGS, 'api.log')); }

  let stopping = false;
  const stop = (code) => {
    if (stopping) return; stopping = true;
    say('Arrêt…');
    try { api.kill(); } catch {}
    spawnSync(bin('pg_ctl'), ['stop', '-D', PGDATA, '-m', 'fast', '-w'], { windowsHide: true, stdio: 'ignore' });
    process.exit(code);
  };
  process.on('SIGINT', () => stop(0));
  process.on('SIGTERM', () => stop(0));
  api.on('exit', (c) => { if (!stopping) { say('L\'API s\'est arrêtée (code ' + c + ') — voir data\\logs\\api.log'); stop(1); } });

  const url = `http://127.0.0.1:${API_PORT}`;
  say('Prêt : ' + url + '   (premier compte : admin / CashPro@2026)');
  if (NO_UI) return;
  if (fs.existsSync(CLIENT)) {
    const uiEnv = { ...process.env }; delete uiEnv.ELECTRON_RUN_AS_NODE;
    const ui = spawn(CLIENT, [], { stdio: 'ignore', env: uiEnv });
    ui.on('exit', () => stop(0));
    say('Fermez la fenêtre CashPro pour tout arrêter.');
  } else if (process.platform === 'win32') {
    spawn('cmd', ['/c', 'start', '', url], { stdio: 'ignore', detached: true }).unref();
    say('Ouvert dans le navigateur (Chrome 109 conseillé). Fermez cette fenêtre noire pour tout arrêter.');
  } else {
    try { spawn('termux-open-url', [url], { stdio: 'ignore', detached: true }).on('error', () => {}).unref(); } catch {}
    say('Ouvrez ' + url + ' dans Chrome. Ctrl+C ici pour tout arrêter.');
  }
}

main().catch((e) => {
  console.error('\n[CashPro] ERREUR : ' + e.message);
  try { fs.appendFileSync(path.join(LOGS, 'demo-errors.log'), new Date().toISOString() + ' ' + e.stack + '\n'); } catch {}
  if (process.platform === 'win32' && !NO_UI) spawnSync('cmd', ['/c', 'pause'], { stdio: 'inherit' });
  process.exit(1);
});
