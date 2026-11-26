import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import cors from 'cors';
import express from 'express';
import helmet from 'helmet';
import { AppError, errorHandler } from './errors';
import { type Deps, requireAuth } from './http';
import { adminRoutes } from './routes/admin';
import { authRoutes } from './routes/auth';
import { exportRoutes } from './routes/export';
import { opsRoutes } from './routes/ops';
import { reportRoutes } from './routes/reports';
import { setupRoutes } from './routes/setup';
import { sheetsRoutes } from './routes/sheets';
import { transactionRoutes } from './routes/transactions';
import { updateRoutes } from './routes/updates';
import { SheetsSync } from './sheets/sync';

export const API_VERSION = '1.3.7';

export function createApp(deps: Deps, opts: { corsOrigins?: string; clientDir?: string; backgroundJobs?: boolean } = {}) {
  const app = express();
  // Google Sheets : synchronisation périodique (serveur réel uniquement, pas pendant les tests)
  const sheets = new SheetsSync(deps);
  if (opts.backgroundJobs) sheets.start();
  app.disable('x-powered-by');
  app.set('trust proxy', false);
  // Réseau local / Tailscale en HTTP : pas de HSTS ni d'upgrade-insecure-requests (casserait l'accès)
  app.use(helmet({
    crossOriginResourcePolicy: { policy: 'cross-origin' },
    strictTransportSecurity: false,
    contentSecurityPolicy: {
      useDefaults: false,
      directives: {
        defaultSrc: ["'self'"], scriptSrc: ["'self'"], styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", 'data:', 'blob:'], connectSrc: ["'self'"], fontSrc: ["'self'", 'data:'],
        objectSrc: ["'none'"], frameAncestors: ["'none'"], baseUri: ["'self'"], formAction: ["'self'"],
      },
    },
  }));
  const origins = (opts.corsOrigins ?? '*').split(',').map((s) => s.trim()).filter(Boolean);
  app.use(cors({ origin: origins.includes('*') ? true : origins, exposedHeaders: ['Content-Disposition'] }));
  app.use(express.json({ limit: '1mb' }));
  // Données toujours fraîches : aucune réponse /api n'est mise en cache (WebView Android, proxy)
  app.use('/api', (_req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); });

  // Santé : utilisé par l'application pour trouver le serveur (LAN / Tailscale)
  app.get('/api/health', async (_req, res) => {
    const c = await deps.db.pool.query('SELECT 1').then(() => true).catch(() => false);
    res.status(c ? 200 : 503).json({ ok: c, app: 'CashPro', version: API_VERSION, time: new Date().toISOString() });
  });

  app.use('/api/auth', authRoutes(deps));
  // Mises à jour : installateur des postes (public, réseau local / Tailscale) + mise à jour du serveur (administrateur)
  app.use('/api/updates', updateRoutes(deps, { currentVersion: API_VERSION }));
  const auth = requireAuth(deps);
  app.use('/api', auth, setupRoutes(deps));
  app.use('/api', auth, transactionRoutes(deps));
  app.use('/api', auth, opsRoutes(deps));
  app.use('/api', auth, reportRoutes(deps));
  app.use('/api', auth, adminRoutes(deps));
  app.use('/api', auth, exportRoutes(deps));
  app.use('/api', auth, sheetsRoutes(deps, sheets));

  app.use('/api', (_req, _res, next) => next(new AppError(404, 'NOT_FOUND', 'Route inconnue')));

  // Interface (application web) servie par le même serveur : LAN, Tailscale, et application Windows
  const clientDir = opts.clientDir ?? path.resolve(__dirname, '../../client/public');
  if (fs.existsSync(path.join(clientDir, 'index.html'))) {
    // no-cache partout : le navigateur revalide (ETag, réponse 304 si inchangé). Après une mise à jour du serveur,
    // les postes et le téléphone chargent tout de suite la nouvelle interface (jamais un mélange ancien/nouveau).
    // 1.3.6 — hors connexion : liste des fichiers de l'interface (copie gardée par l'appareil) + service worker
    // dont la version suit les fichiers (une mise à jour du serveur renouvelle la copie des postes).
    const manifest = () => offlineManifest(clientDir);
    app.get('/offline-manifest.json', (_req, res) => { res.setHeader('Cache-Control', 'no-store'); res.json(manifest()); });
    app.get('/sw.js', (_req, res) => {
      const src = fs.readFileSync(path.join(clientDir, 'sw.js'), 'utf8').replace('__CASHPRO_UI_VERSION__', manifest().version);
      res.setHeader('Cache-Control', 'no-cache'); res.type('application/javascript').send(src);
    });
    app.use(express.static(clientDir, { index: 'index.html', etag: true, lastModified: true, setHeaders: (res) => {
      res.setHeader('Cache-Control', 'no-cache');
    } }));
    app.get(/^\/(?!api\/).*/, (_req, res) => res.sendFile(path.join(clientDir, 'index.html'), { headers: { 'Cache-Control': 'no-cache' } }));
  }
  app.use((_req, _res, next) => next(new AppError(404, 'NOT_FOUND', 'Route inconnue')));
  app.use(errorHandler);
  return app;
}

/** Fichiers de l'interface (sans les .map) et empreinte de leur ensemble (taille + date). Recalculée au plus toutes les 30 s. */
let manifestCache: { at: number; dir: string; value: { version: string; files: string[] } } | null = null;
export function offlineManifest(dir: string): { version: string; files: string[] } {
  if (manifestCache && manifestCache.dir === dir && Date.now() - manifestCache.at < 30_000) return manifestCache.value;
  const files: string[] = [];
  const h = crypto.createHash('sha256');
  const walk = (d: string, rel: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(d, e.name); const r = `${rel}/${e.name}`;
      if (e.isDirectory()) walk(full, r);
      else if (!e.name.endsWith('.map') && e.name !== 'sw.js') {
        const st = fs.statSync(full);
        files.push(r); h.update(`${r}:${st.size}:${st.mtimeMs}\n`);
      }
    }
  };
  walk(dir, '');
  const value = { version: h.digest('hex').slice(0, 16), files };
  manifestCache = { at: Date.now(), dir, value };
  return value;
}
