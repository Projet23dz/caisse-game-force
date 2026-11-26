// Google Sheets (consultation) + copie des sauvegardes vers Google Drive — administrateur
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { Router } from 'express';
import { z } from 'zod';
import { one } from '../db';
import { AppError } from '../errors';
import { ctx, type Deps, requireAdmin } from '../http';
import { APPS_SCRIPT } from '../sheets/apps-script';
import type { SheetsSync } from '../sheets/sync';

// Seule destination acceptée : une application Web Google Apps Script (pas d'envoi vers un autre serveur)
const SCRIPT_URL = /^https:\/\/script\.google\.com\/macros\/s\/[A-Za-z0-9_-]{20,}\/exec$/;

/** Dossiers Google Drive pour ordinateur en mode « Mise en miroir » (visibles par le compte SYSTEM). */
export function driveCandidates(usersDir = 'C:\\Users'): string[] {
  const names = ['My Drive', 'Mon Drive', 'Mon disque', 'Google Drive\\My Drive', 'Google Drive\\Mon Drive', 'Google Drive'];
  const out: string[] = [];
  let users: string[] = [];
  try { users = fs.readdirSync(usersDir); } catch { return out; }
  for (const u of users) {
    if (/^(Public|Default|Default User|All Users)$/i.test(u)) continue;
    for (const n of names) {
      const p = path.join(usersDir, u, n);
      try { if (fs.statSync(p).isDirectory() && !out.some((x) => p.startsWith(x))) out.push(p); } catch { /* absent */ }
    }
  }
  return out;
}

export function sheetsRoutes(deps: Deps, sync: SheetsSync): Router {
  const r = Router();
  r.use('/admin/sheets', requireAdmin());
  r.use('/admin/backup', requireAdmin());

  const view = async () => {
    const [cfg, st] = await Promise.all([sync.config(), sync.state()]);
    let by: string | null = null;
    if (cfg.userId) {
      by = await deps.db.tx({ userId: cfg.userId }, async (db) =>
        (await one<{ n: string }>(db, 'SELECT full_name AS n FROM users WHERE id = $1', [cfg.userId]))?.n ?? null).catch(() => null);
    }
    return { enabled: cfg.enabled, url: cfg.url, intervalMin: cfg.intervalMin, configuredBy: by, state: st };
  };

  r.get('/admin/sheets', async (_req, res) => { res.json(await view()); });

  r.put('/admin/sheets', async (req, res) => {
    const b = z.object({
      enabled: z.boolean().optional(),
      url: z.string().trim().max(300).refine((u) => u === '' || SCRIPT_URL.test(u),
        'Lien invalide : collez l\'URL de l\'application Web (https://script.google.com/macros/s/…/exec)').optional(),
      intervalMin: z.coerce.number().int().min(1).max(1440).optional(),
    }).parse(req.body);
    const cfg = await sync.config();
    if (b.url !== undefined) cfg.url = b.url;
    if (b.intervalMin !== undefined) cfg.intervalMin = b.intervalMin;
    if (b.enabled !== undefined) cfg.enabled = b.enabled;
    if (cfg.enabled && !cfg.url) throw new AppError(422, 'SHEETS_URL_REQUIRED', 'Collez d\'abord le lien de l\'application Web');
    cfg.userId = req.user!.id;          // la synchronisation lit les données avec les droits de cet administrateur
    await sync.saveConfig(cfg);
    await deps.db.tx(ctx(req), (db) => db.query("SELECT log_event('settings', NULL, $1::jsonb)",
      [JSON.stringify({ google_sheets: { enabled: cfg.enabled, interval: cfg.intervalMin } })])).catch(() => undefined);
    res.json(await view());
  });

  r.post('/admin/sheets/run', async (_req, res) => {
    await sync.run(true);
    res.json(await view());
  });

  // Nouveau jeton : l'ancien script ne fonctionne plus (à recoller)
  r.post('/admin/sheets/token', async (_req, res) => {
    const cfg = await sync.config();
    cfg.token = '';
    await sync.saveConfig(cfg);
    await sync.config();
    res.json(await view());
  });

  r.get('/admin/sheets/script', async (_req, res) => {
    const cfg = await sync.config();
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Disposition', 'attachment; filename="CashPro-Sheets.gs"');
    res.end(APPS_SCRIPT.replace('__CASHPRO_TOKEN__', cfg.token));
  });

  // ------------------------------------------------------------------ copie des sauvegardes (Google Drive)
  const backupSetting = async (req: Parameters<typeof ctx>[0]) => deps.db.tx(ctx(req), async (db) =>
    (await one<{ v: Record<string, unknown> | null }>(db, "SELECT value AS v FROM app_settings WHERE key = 'backup'"))?.v ?? {});

  r.get('/admin/backup/offsite', async (req, res) => {
    const s = await backupSetting(req);
    res.json({ path: (s.offsite_path as string | null) ?? null, candidates: process.platform === 'win32' ? driveCandidates() : [] });
  });

  r.put('/admin/backup/offsite', async (req, res) => {
    const b = z.object({ path: z.string().trim().max(260).nullable() }).parse(req.body);
    const p = b.path || null;
    if (p) {
      if (!path.isAbsolute(p)) throw new AppError(422, 'OFFSITE_INVALID', 'Chemin complet attendu (ex. C:\\Users\\…\\My Drive)');
      try {
        if (!(await fsp.stat(p)).isDirectory()) throw new Error('not dir');
        const probe = path.join(p, `.cashpro-test-${process.pid}`);
        await fsp.writeFile(probe, 'ok'); await fsp.unlink(probe);
      } catch {
        throw new AppError(422, 'OFFSITE_UNREACHABLE', 'Dossier introuvable ou non accessible en écriture par le serveur');
      }
    }
    const s = await backupSetting(req);
    const value = { daily_time: '23:30', retention_days: 30, retention_months: 12, ...s, offsite_path: p };
    await deps.db.tx(ctx(req, 'Copie des sauvegardes (Google Drive)'), (db) => db.query(
      `INSERT INTO app_settings (key, value, updated_by) VALUES ('backup', $1::jsonb, current_uid())
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()`, [JSON.stringify(value)]));
    res.json({ path: p, candidates: process.platform === 'win32' ? driveCandidates() : [] });
  });

  return r;
}
