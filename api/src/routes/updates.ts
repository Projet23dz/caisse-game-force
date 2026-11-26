// Mises à jour de CashPro
//  • Postes Windows : l'installateur de l'application est fourni par le serveur (C:\CashPro\updates\client),
//    sans Internet : l'application compare sa version et propose « تحديث الآن ».
//  • Serveur : l'administrateur cherche la dernière version publiée sur GitHub (Releases), puis l'installe :
//    téléchargement + vérification SHA-256, sauvegarde obligatoire, installation silencieuse, redémarrage des services.
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { type Request, type Response, Router } from 'express';
import { z } from 'zod';
import { AppError } from '../errors';
import { type Deps, requireAdmin, requireAuth } from '../http';

export const DEFAULT_REPO = 'Projet23dz/caisse-game-force';
const SERVER_ASSET = /^CashPro-Server-Setup-[\d.]+\.exe$/;
const AUTO_CHECK = 6 * 3600 * 1000;   // bandeau « تحديث جديد متوفّر » : vérification GitHub toutes les 6 h

/** Compare deux versions x.y.z : >0 si a est plus récente. */
export function compareVersions(a: string, b: string): number {
  const pa = String(a).replace(/^v/, '').split(/[.-]/).map((x) => parseInt(x, 10) || 0);
  const pb = String(b).replace(/^v/, '').split(/[.-]/).map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length, 3); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d) return d;
  }
  return 0;
}

/** Lecture minimale de latest.yml (electron-builder) : version, fichier, sha512, taille. */
export function parseLatestYml(text: string): { version: string; file: string; sha512: string; size: number | null } | null {
  const val = (k: string) => new RegExp(`^\\s*-?\\s*${k}:\\s*['"]?([^'"\\r\\n]+)['"]?\\s*$`, 'm').exec(text)?.[1]?.trim();
  const version = val('version');
  const file = val('path') ?? val('url');
  const sha512 = val('sha512');
  if (!version || !file || !sha512 || /[\\/]/.test(file)) return null;
  const size = Number(val('size'));
  return { version, file, sha512, size: Number.isFinite(size) && size > 0 ? size : null };
}

/** Dossier des scripts Windows : <serveur>\setup (installateur : api\dist\routes → ..\..\..\setup). */
export function findSetupDir(base = __dirname): string {
  const candidates = [path.resolve(base, '../../../setup'), path.resolve(base, '../../setup')];
  return candidates.find((d) => fs.existsSync(path.join(d, 'backup.ps1'))) ?? candidates[0];
}

interface ServerUpdateState {
  repo: string;
  hasToken: boolean;
  current: string;
  checkedAt: string | null;
  latest: { version: string; name: string; notes: string; publishedAt: string; asset: string; size: number } | null;
  available: boolean;
  status: 'idle' | 'checking' | 'downloading' | 'backup' | 'installing' | 'failed';
  progress: number | null;
  error: string | null;
  updatedAt: string | null;
}

interface UpdateConfig { repo?: string; token?: string }
interface ReleaseAsset { id: number; name: string; size: number; digest?: string | null; browser_download_url: string }

export function updateRoutes(deps: Deps, opts: { currentVersion: string }): Router {
  const r = Router();
  const auth = requireAuth(deps);
  const dir = path.join(deps.dataDir, 'updates');
  const clientDir = path.join(dir, 'client');
  const serverDir = path.join(dir, 'server');
  const cfgFile = path.join(deps.dataDir, 'config', 'update.json');   // dossier réservé aux administrateurs / SYSTEM
  const stateFile = path.join(serverDir, 'state.json');
  let assetCache: ReleaseAsset | null = null;
  let running = false;

  const readCfg = async (): Promise<UpdateConfig> => {
    try { return JSON.parse(await fsp.readFile(cfgFile, 'utf8')) as UpdateConfig; } catch { return {}; }
  };
  const readState = async (): Promise<ServerUpdateState> => {
    const cfg = await readCfg();
    let st: Partial<ServerUpdateState> = {};
    try { st = JSON.parse(await fsp.readFile(stateFile, 'utf8')); } catch { /* premier usage */ }
    const s: ServerUpdateState = {
      checkedAt: null, latest: null, status: 'idle', progress: null, error: null, updatedAt: null, ...st,
      repo: cfg.repo || DEFAULT_REPO, hasToken: Boolean(cfg.token), current: opts.currentVersion, available: false,
    };
    // après l'installation, l'API redémarre en nouvelle version : l'état « installing » est terminé
    if (s.status !== 'idle' && s.status !== 'failed' && !running) {
      const stale = !s.updatedAt || Date.now() - new Date(s.updatedAt).getTime() > 20 * 60 * 1000;
      if (s.status !== 'installing' || stale || (s.latest && compareVersions(opts.currentVersion, s.latest.version) >= 0)) {
        s.status = s.status === 'installing' && s.latest && compareVersions(opts.currentVersion, s.latest.version) < 0 ? 'failed' : 'idle';
        if (s.status === 'failed') s.error = 'L\'installation ne s\'est pas terminée : voir C:\\CashPro\\logs';
        s.progress = null;
      }
    }
    s.available = Boolean(s.latest && compareVersions(s.latest.version, opts.currentVersion) > 0);
    return s;
  };
  const writeState = async (patch: Partial<ServerUpdateState>) => {
    const cur = await readState();
    const next = { ...cur, ...patch, updatedAt: new Date().toISOString() };
    await fsp.mkdir(serverDir, { recursive: true });
    await fsp.writeFile(stateFile, JSON.stringify(next, null, 2));
    return next;
  };

  const github = async (url: string, cfg: UpdateConfig, accept = 'application/vnd.github+json') => {
    if (typeof fetch !== 'function') throw new AppError(501, 'UPDATE_UNSUPPORTED', 'Mise à jour en ligne indisponible sur cette version de Node.js');
    const headers: Record<string, string> = { Accept: accept, 'User-Agent': 'CashPro-Updater', 'X-GitHub-Api-Version': '2022-11-28' };
    if (cfg.token) headers.Authorization = `Bearer ${cfg.token}`;
    return fetch(url, { headers, redirect: 'follow', signal: AbortSignal.timeout(accept.includes('octet') ? 30 * 60 * 1000 : 20_000) });
  };

  const check = async () => {
    const cfg = await readCfg();
    const repo = cfg.repo || DEFAULT_REPO;
    let res: globalThis.Response;
    try { res = await github(`https://api.github.com/repos/${repo}/releases/latest`, cfg); } catch (e) {
      if (e instanceof AppError) throw e;
      throw new AppError(502, 'UPDATE_OFFLINE', 'Serveur de mises à jour injoignable (Internet ?)');
    }
    if (res.status === 404) {
      throw new AppError(404, 'UPDATE_NO_RELEASE', cfg.token
        ? `Aucune version publiée dans ${repo}`
        : `Dépôt ${repo} introuvable ou privé : ajoutez un jeton GitHub (lecture seule) dans les paramètres de mise à jour`);
    }
    if (res.status === 401 || res.status === 403) throw new AppError(502, 'UPDATE_AUTH', 'Jeton GitHub refusé ou expiré');
    if (!res.ok) throw new AppError(502, 'UPDATE_FAILED', `GitHub : réponse ${res.status}`);
    const rel = await res.json() as { tag_name: string; name?: string; body?: string; published_at: string; assets: ReleaseAsset[] };
    const asset = rel.assets.find((a) => SERVER_ASSET.test(a.name));
    if (!asset) throw new AppError(404, 'UPDATE_NO_ASSET', `La version ${rel.tag_name} ne contient pas d'installateur serveur`);
    assetCache = asset;
    return writeState({
      checkedAt: new Date().toISOString(), error: null,
      latest: { version: rel.tag_name.replace(/^v/, ''), name: rel.name || rel.tag_name, notes: String(rel.body ?? '').slice(0, 4000),
        publishedAt: rel.published_at, asset: asset.name, size: asset.size },
    });
  };

  // Délai maximal : un script bloqué (ex. outil en attente d'un mot de passe dans une fenêtre cachée) est arrêté
  // avec tous ses processus enfants, et la mise à jour échoue avec un message clair au lieu de tourner sans fin.
  const runPs = (script: string, args: string[], logName: string, timeoutMs = 5 * 60 * 1000, timeoutMsg?: string) => new Promise<void>((resolve, reject) => {
    const log = fs.openSync(path.join(deps.dataDir, 'logs', logName), 'a');
    const p = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, ...args],
      { windowsHide: true, stdio: ['ignore', log, log] });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      if (p.pid) spawn('taskkill', ['/PID', String(p.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }).on('error', () => p.kill());
      else p.kill();
    }, timeoutMs);
    p.on('error', (e) => { clearTimeout(timer); fs.closeSync(log); reject(e); });
    p.on('exit', (code) => {
      clearTimeout(timer); fs.closeSync(log);
      if (timedOut) reject(new Error(timeoutMsg ?? `${path.basename(script)} : délai dépassé (${Math.round(timeoutMs / 60000)} min)`));
      else if (code === 0) resolve(); else reject(new Error(`${path.basename(script)} : code ${code}`));
    });
  });

  // dernière ligne utile de backup.log, pour expliquer un échec dans l'interface
  const lastBackupLine = async () => {
    try {
      const lines = (await fsp.readFile(path.join(deps.dataDir, 'backups', 'backup.log'), 'utf8')).trim().split(/\r?\n/);
      return (lines[lines.length - 1] ?? '').replace(/^\S+\s+/, '').slice(0, 300);
    } catch { return ''; }
  };

  const install = async () => {
    const cfg = await readCfg();
    const st = await readState();
    if (!st.latest || !st.available) throw new AppError(409, 'UPDATE_NONE', 'Aucune mise à jour à installer');
    if (!assetCache || assetCache.name !== st.latest.asset) await check();
    const asset = assetCache!;
    const repo = cfg.repo || DEFAULT_REPO;
    await fsp.mkdir(serverDir, { recursive: true });
    await fsp.mkdir(path.join(deps.dataDir, 'logs'), { recursive: true });
    const file = path.join(serverDir, asset.name);

    // 1. Téléchargement + empreinte
    await writeState({ status: 'downloading', progress: 0, error: null });
    const res = await github(`https://api.github.com/repos/${repo}/releases/assets/${asset.id}`, cfg, 'application/octet-stream');
    if (!res.ok || !res.body) throw new Error(`Téléchargement impossible (${res.status})`);
    const hash = crypto.createHash('sha256');
    const out = fs.createWriteStream(file + '.part');
    let got = 0; let lastPct = -1;
    const reader = res.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      hash.update(value); got += value.length;
      if (!out.write(value)) await new Promise((ok) => out.once('drain', ok));
      const pct = Math.floor((got / (asset.size || 1)) * 100);
      if (pct >= lastPct + 5) { lastPct = pct; await writeState({ progress: Math.min(pct, 99) }); }
    }
    await new Promise<void>((ok, ko) => out.end((e?: Error | null) => (e ? ko(e) : ok())));
    const sha = hash.digest('hex');
    if (asset.size && got !== asset.size) throw new Error('Fichier incomplet');
    if (asset.digest && asset.digest.toLowerCase() !== `sha256:${sha}`) throw new Error('Empreinte SHA-256 invalide : fichier refusé');
    await fsp.rename(file + '.part', file);

    // 2. Sauvegarde obligatoire avant toute installation
    await writeState({ status: 'backup', progress: null });
    const setupDir = findSetupDir();
    const backup = path.join(setupDir, 'backup.ps1');
    if (!fs.existsSync(backup)) throw new Error('Script de sauvegarde introuvable : mise à jour annulée');
    const pgArgs: string[] = [];
    if (process.env.PG_BIN) pgArgs.push('-PgBin', process.env.PG_BIN);
    if (process.env.PG_PORT) pgArgs.push('-Port', process.env.PG_PORT);
    try {
      await runPs(backup, pgArgs, 'update.log', 15 * 60 * 1000,
        'Sauvegarde trop longue (15 min) : arrêtée, rien n\'a été installé. Voir C:\\CashPro\\backups\\backup.log');
    } catch (e) {
      const last = await lastBackupLine();
      throw new Error(`${e instanceof Error ? e.message : String(e)}${last ? ` — ${last}` : ''}`);
    }

    // 3. Installation silencieuse dans une tâche planifiée distincte (elle survit à l'arrêt de l'API)
    await writeState({ status: 'installing' });
    await runPs(path.join(setupDir, 'run-update.ps1'), ['-Installer', file], 'update.log', 2 * 60 * 1000);
  };

  // ------------------------------------------------------------------ postes Windows (sans connexion)
  const clientInfo = async () => {
    let yml: string;
    try { yml = await fsp.readFile(path.join(clientDir, 'latest.yml'), 'utf8'); } catch { return null; }
    const info = parseLatestYml(yml);
    if (!info || !fs.existsSync(path.join(clientDir, info.file))) return null;
    return info;
  };
  r.get('/client', async (_req, res) => {
    const info = await clientInfo();
    if (!info) throw new AppError(404, 'UPDATE_NO_CLIENT', 'Aucun installateur client sur ce serveur');
    res.json({ ...info, url: '/api/updates/client/file' });
  });
  r.get('/client/file', async (_req, res: Response) => {
    const info = await clientInfo();
    if (!info) throw new AppError(404, 'UPDATE_NO_CLIENT', 'Aucun installateur client sur ce serveur');
    res.download(path.join(clientDir, info.file), info.file);
  });

  // ------------------------------------------------------------------ serveur (administrateur)
  r.get('/server', auth, requireAdmin(), async (_req, res) => {
    let st = await readState();
    // vérification automatique toutes les 6 h, en arrière-plan
    if (!running && (!st.checkedAt || Date.now() - new Date(st.checkedAt).getTime() > AUTO_CHECK)) {
      void check().catch((e) => writeState({ checkedAt: new Date().toISOString(), error: e instanceof Error ? e.message : String(e) }).catch(() => undefined));
    }
    st = await readState();
    res.json(st);
  });

  r.post('/server/check', auth, requireAdmin(), async (_req, res) => {
    if (running) throw new AppError(409, 'UPDATE_RUNNING', 'Mise à jour en cours');
    try { await check(); } catch (e) {
      await writeState({ checkedAt: new Date().toISOString(), error: e instanceof Error ? e.message : String(e) });
      throw e;
    }
    res.json(await readState());
  });

  r.post('/server/install', auth, requireAdmin(), async (req: Request, res) => {
    if (process.platform !== 'win32') throw new AppError(501, 'UPDATE_UNSUPPORTED', 'Installation automatique disponible uniquement sur le serveur Windows');
    if (running) throw new AppError(409, 'UPDATE_RUNNING', 'Mise à jour déjà en cours');
    const st = await readState();
    if (!st.available) throw new AppError(409, 'UPDATE_NONE', 'Aucune mise à jour à installer');
    running = true;
    await writeState({ status: 'downloading', progress: 0, error: null });
    void deps.db.tx({ userId: req.user!.id, reason: `Mise à jour du serveur vers ${st.latest!.version}` },
      (db) => db.query('SELECT log_event($1, NULL, $2::jsonb)', ['server_update_started', JSON.stringify({ from: st.current, to: st.latest!.version })]))
      .catch(() => undefined);
    install()
      .catch((e) => writeState({ status: 'failed', progress: null, error: e instanceof Error ? e.message : String(e) }))
      .finally(() => { running = false; });
    res.status(202).json(await readState());
  });

  r.put('/server/config', auth, requireAdmin(), async (req, res) => {
    const b = z.object({
      repo: z.string().trim().regex(/^[\w.-]+\/[\w.-]+$/, 'Format attendu : propriétaire/dépôt').optional(),
      token: z.string().trim().max(400).nullish(),   // null = supprimer, absent = inchangé
    }).parse(req.body ?? {});
    const cfg = await readCfg();
    if (b.repo) cfg.repo = b.repo;
    if (b.token === null || b.token === '') delete cfg.token; else if (b.token) cfg.token = b.token;
    await fsp.mkdir(path.dirname(cfgFile), { recursive: true });
    await fsp.writeFile(cfgFile, JSON.stringify(cfg, null, 2));
    assetCache = null;
    await writeState({ checkedAt: null, latest: null, error: null });
    res.json(await readState());
  });

  return r;
}
