import os from 'node:os';
import bcrypt from 'bcryptjs';
import { Router } from 'express';
import { z } from 'zod';
import { many, one } from '../db';
import { AppError, notFound } from '../errors';
import { sendStored, store, uploader } from '../files';
import { ctx, type Deps, param, requireAdmin, zId, zMoney, zOptText, zReason } from '../http';
import { PASSWORD_RULE } from './auth';

export const PERMISSION_KEYS = [
  'add_income', 'add_expense', 'add_purchase', 'deposit_withdrawal', 'transfer', 'cheques', 'payroll',
  'edit_own', 'edit_any', 'cancel', 'view_balances', 'view_all_transactions', 'cash_session', 'adjustment',
  'view_reports', 'export', 'view_audit', 'manage_categories', 'manage_suppliers', 'manage_employees',
] as const;

const SETTING_KEYS = ['app_name', 'default_locale', 'currency', 'currency_symbol', 'date_format', 'default_theme',
  'allow_negative_cash', 'backup', 'notifications', 'remember_me', 'activity_alerts'] as const;

export function adminRoutes(deps: Deps): Router {
  const r = Router();
  const up = uploader(deps.maxUploadMb);

  // ------------------------------------------------------------------ utilisateurs (admin)
  r.get('/users', requireAdmin(), async (req, res) => {
    res.json(await deps.db.tx(ctx(req), (db) => many(db,
      `SELECT u.id, u.username, u.full_name, u.email, u.phone, u.role, u.locale, u.theme, u.is_active, u.last_login_at,
              u.locked_until, u.created_at,
              coalesce((SELECT jsonb_agg(jsonb_build_object('businessId', bu.business_id, 'profile', bu.profile, 'isActive', bu.is_active,
                        'permissions', bu.permissions, 'allowedAccounts', bu.allowed_accounts, 'maxAmount', bu.max_amount))
                        FROM business_users bu WHERE bu.user_id = u.id), '[]') AS businesses
       FROM users u ORDER BY u.role, u.full_name`)));
  });

  const userBody = z.object({
    username: z.string().trim().toLowerCase().regex(/^[a-z0-9._-]{3,40}$/, 'Identifiant : 3 à 40 caractères (lettres, chiffres, . _ -)'),
    fullName: z.string().trim().min(2).max(100),
    password: PASSWORD_RULE,
    role: z.enum(['admin', 'user']).default('user'),
    email: zOptText(100), phone: zOptText(30),
    locale: z.enum(['ar', 'fr', 'en']).default('ar'),
  });

  r.post('/users', requireAdmin(), async (req, res) => {
    const b = userBody.parse(req.body);
    const hash = await bcrypt.hash(b.password, 12);
    const row = await deps.db.tx(ctx(req, 'Création utilisateur'), async (db) => {
      const u = await one<{ id: string }>(db,
        `INSERT INTO users (username, full_name, password_hash, role, email, phone, locale)
         VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id, username, full_name, role, locale, is_active`,
        [b.username, b.fullName, hash, b.role, b.email, b.phone, b.locale]);
      await db.query('SELECT set_force_password_change($1, true)', [u!.id]);
      return u;
    });
    res.status(201).json(row);
  });

  r.patch('/users/:id', requireAdmin(), async (req, res) => {
    const b = z.object({
      fullName: z.string().trim().min(2).max(100).optional(), role: z.enum(['admin', 'user']).optional(),
      email: zOptText(100).optional(), phone: zOptText(30).optional(), locale: z.enum(['ar', 'fr', 'en']).optional(),
      isActive: z.boolean().optional(), unlock: z.boolean().optional(), reason: zReason.optional(),
    }).parse(req.body);
    const id = param(req, 'id');
    if (id === req.user!.id && (b.isActive === false || b.role === 'user')) {
      throw new AppError(422, 'SELF_LOCKOUT', 'Vous ne pouvez pas retirer vos propres droits d\'administrateur');
    }
    const row = await deps.db.tx(ctx(req, b.reason ?? 'Modification utilisateur'), (db) => one(db,
      `UPDATE users SET full_name = coalesce($2,full_name), role = coalesce($3::user_role,role), email = coalesce($4,email),
         phone = coalesce($5,phone), locale = coalesce($6,locale), is_active = coalesce($7,is_active),
         locked_until = CASE WHEN $8 THEN NULL ELSE locked_until END, failed_logins = CASE WHEN $8 THEN 0 ELSE failed_logins END
       WHERE id = $1 RETURNING id, username, full_name, role, email, phone, locale, is_active, locked_until`,
      [id, b.fullName ?? null, b.role ?? null, b.email ?? null, b.phone ?? null, b.locale ?? null, b.isActive ?? null, b.unlock ?? false]));
    if (!row) throw notFound('Utilisateur');
    res.json(row);
  });

  r.post('/users/:id/reset-password', requireAdmin(), async (req, res) => {
    const b = z.object({ newPassword: PASSWORD_RULE }).parse(req.body);
    const id = param(req, 'id');
    await deps.db.tx(ctx(req, 'Réinitialisation mot de passe'), async (db) => {
      await db.query('SELECT set_password($1, $2)', [id, await bcrypt.hash(b.newPassword, 12)]);
      await db.query('SELECT set_force_password_change($1, true)', [id]);
    });
    res.json({ ok: true });
  });

  // Accès à une activité + permissions case par case
  r.put('/users/:id/businesses/:businessId', requireAdmin(), async (req, res) => {
    const b = z.object({
      profile: z.enum(['employee', 'manager']),
      permissions: z.partialRecord(z.enum(PERMISSION_KEYS), z.boolean()).optional(),
      allowedAccounts: z.array(zId).nullish(),
      maxAmount: zMoney.nullish(),
      isActive: z.boolean().default(true),
      resetToDefaults: z.boolean().default(false),
      reason: zReason.optional(),
    }).parse(req.body);
    const userId = param(req, 'id');
    const businessId = param(req, 'businessId');
    const row = await deps.db.tx(ctx(req, b.reason ?? 'Modification des permissions'), async (db) => {
      if (b.allowedAccounts?.length) {
        const n = await one<{ n: string }>(db, 'SELECT count(*) AS n FROM accounts WHERE id = ANY($1::uuid[]) AND account_serves(id, $2)',
          [b.allowedAccounts, businessId]);
        if (Number(n!.n) !== b.allowedAccounts.length) throw new AppError(422, 'INVALID_ACCOUNTS', 'Comptes invalides pour cette activité');
      }
      const perms = JSON.stringify(b.permissions ?? {});
      return one(db,
        `INSERT INTO business_users (business_id, user_id, profile, permissions, allowed_accounts, max_amount, is_active)
         VALUES ($1,$2,$3,$4::jsonb,$5,$6,$7)
         ON CONFLICT (business_id, user_id) DO UPDATE SET
           profile = EXCLUDED.profile,
           permissions = CASE WHEN $8 OR business_users.profile <> EXCLUDED.profile
                              THEN default_permissions(EXCLUDED.profile) || $4::jsonb
                              ELSE business_users.permissions || $4::jsonb END,
           allowed_accounts = EXCLUDED.allowed_accounts, max_amount = EXCLUDED.max_amount, is_active = EXCLUDED.is_active
         RETURNING *`,
        [businessId, userId, b.profile, perms, b.allowedAccounts ?? null, b.maxAmount ?? null, b.isActive, b.resetToDefaults]);
    });
    res.json(row);
  });

  r.get('/permissions/defaults', requireAdmin(), async (req, res) => {
    res.json(await deps.db.tx(ctx(req), async (db) => ({
      keys: PERMISSION_KEYS,
      employee: (await one<{ p: unknown }>(db, "SELECT default_permissions('employee') AS p"))!.p,
      manager: (await one<{ p: unknown }>(db, "SELECT default_permissions('manager') AS p"))!.p,
    })));
  });

  // ------------------------------------------------------------------ paramètres
  // ------------------------------------------------------------------ alertes d'activité (🔔) — administrateurs
  r.get('/alerts/count', requireAdmin(), async (req, res) => {
    res.json(await deps.db.tx(ctx(req), async (db) => ({ unread: (await one<{ n: number }>(db, 'SELECT activity_alerts_unread() AS n'))!.n })));
  });
  r.get('/alerts', requireAdmin(), async (req, res) => {
    const q = z.object({ unread: z.coerce.boolean().optional(), businessId: zId.optional(),
      page: z.coerce.number().int().min(1).default(1), limit: z.coerce.number().int().min(1).max(200).default(50) }).parse(req.query);
    res.json(await deps.db.tx(ctx(req), async (db) => {
      const where = 'WHERE ($1::boolean IS NOT TRUE OR NOT reviewed) AND ($2::uuid IS NULL OR business_id = $2)';
      const args = [q.unread ?? null, q.businessId ?? null];
      const total = (await one<{ n: string }>(db, `SELECT count(*) AS n FROM activity_alerts() ${where}`, args))!.n;
      const items = await many(db, `SELECT * FROM activity_alerts() ${where} ORDER BY occurred_at DESC, id DESC
        LIMIT ${q.limit} OFFSET ${(q.page - 1) * q.limit}`, args);
      const unread = (await one<{ n: number }>(db, 'SELECT activity_alerts_unread() AS n'))!.n;
      return { items, total: Number(total), unread, page: q.page, limit: q.limit };
    }));
  });
  r.post('/alerts/mark', requireAdmin(), async (req, res) => {
    const b = z.object({ ids: z.array(z.coerce.number().int().positive()).max(500).optional() }).parse(req.body ?? {});
    res.json(await deps.db.tx(ctx(req), async (db) => ({
      marked: (await one<{ n: number }>(db, 'SELECT activity_alerts_mark($1::bigint[]) AS n', [b.ids ?? null]))!.n,
      unread: (await one<{ n: number }>(db, 'SELECT activity_alerts_unread() AS n'))!.n,
    })));
  });

  // Adresses du serveur à saisir dans les postes et le téléphone (réseau local + VPN installé à part, ex. Tailscale 100.64.0.0/10)
  r.get('/admin/network', requireAdmin(), (_req, res) => {
    const addrs: { address: string; kind: 'lan' | 'vpn'; iface: string }[] = [];
    for (const [iface, list] of Object.entries(os.networkInterfaces())) {
      for (const a of list ?? []) {
        if (a.family !== 'IPv4' || a.internal || a.address.startsWith('169.254.')) continue;
        const [x, y] = a.address.split('.').map(Number);
        addrs.push({ address: a.address, kind: x === 100 && y >= 64 && y <= 127 ? 'vpn' : 'lan', iface });
      }
    }
    res.json({ hostname: os.hostname().toLowerCase(), port: Number(process.env.PORT) || 4600, addresses: addrs });
  });

  r.get('/settings', async (req, res) => {
    const rows = await deps.db.tx(ctx(req), (db) => many<{ key: string; value: unknown }>(db,
      "SELECT key, value FROM app_settings WHERE key <> 'force_password_change' ORDER BY key"));
    res.json(Object.fromEntries(rows.map((x) => [x.key, x.value])));
  });

  r.put('/settings/:key', requireAdmin(), async (req, res) => {
    const key = z.enum(SETTING_KEYS).parse(req.params.key);
    const { value } = z.object({ value: z.json() }).parse(req.body);
    const row = await deps.db.tx(ctx(req, `Paramètre ${key}`), (db) => one(db,
      `INSERT INTO app_settings (key, value, updated_by) VALUES ($1, $2::jsonb, current_uid())
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()
       RETURNING key, value`, [key, JSON.stringify(value)]));
    res.json(row);
  });

  // Logo du logiciel (barre latérale, écran de connexion, rapports)
  r.get('/settings/logo', async (req, res) => {
    const row = await deps.db.tx(ctx(req), (db) => one<{ v: string | null }>(db, "SELECT value #>> '{}' AS v FROM app_settings WHERE key = 'app_logo'"));
    if (!row?.v) throw notFound('Logo');
    await sendStored(res, deps.dataDir, row.v);
  });

  r.post('/settings/logo', requireAdmin(), up.single('file'), async (req, res) => {
    if (!req.file) throw new AppError(422, 'FILE_REQUIRED', 'Fichier « file » manquant');
    const s = await store(deps.dataDir, 'logos', req.file.buffer, ['png', 'jpg', 'svg', 'webp'], 'app-');
    const row = await deps.db.tx(ctx(req, 'Changement du logo du logiciel'), (db) => one(db,
      `UPDATE app_settings SET value = to_jsonb($1::text), updated_by = current_uid(), updated_at = now()
       WHERE key = 'app_logo' RETURNING key, value`, [s.key]));
    res.json(row);
  });

  return r;
}
