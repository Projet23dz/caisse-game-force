import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import { type Request, Router } from 'express';
import { z } from 'zod';
import { many, one } from '../db';
import { AppError } from '../errors';
import { ctx, type Deps, requireAuth, signToken, zId } from '../http';

// hash factice : même durée de calcul qu'un vrai compte quand l'utilisateur n'existe pas
const DUMMY_HASH = bcrypt.hashSync('cashpro-dummy-password', 10);
export const PASSWORD_RULE = z.string().min(8, '8 caractères minimum').max(128)
  .refine((p) => /[A-Za-z]/.test(p) && /\d/.test(p), 'Le mot de passe doit contenir des lettres et des chiffres');

// « تذكّرني » : jeton aléatoire gardé par le poste (chiffré par Windows) ; la base n'en garde que l'empreinte
export const newDeviceToken = () => crypto.randomBytes(32).toString('base64url');
export const hashDeviceToken = (tok: string) => crypto.createHash('sha256').update(tok).digest('hex');
const clientOf = (req: Request) =>
  `${req.ip ?? '-'} ${String(req.headers['x-cashpro-client'] ?? '').slice(0, 80)}`.trim();
const zDeviceName = z.string().trim().max(80).optional();

async function rememberDevice(deps: Deps, userId: string, deviceName: string | undefined, client: string) {
  const raw = newDeviceToken();
  const row = await deps.db.tx(null, (db) => one<{ id: string; expires_at: Date }>(db,
    'SELECT * FROM auth_device_create($1, $2, $3, $4)', [userId, hashDeviceToken(raw), deviceName ?? null, client]));
  return row ? { refreshToken: raw, refreshExpiresAt: row.expires_at } : { remembered: false };
}

export function authRoutes(deps: Deps): Router {
  const r = Router();

  r.post('/login', async (req, res) => {
    const body = z.object({ username: z.string().trim().min(1).max(100), password: z.string().min(1).max(200),
      remember: z.boolean().optional(), deviceName: zDeviceName }).parse(req.body);
    const client = clientOf(req);
    const u = await deps.db.tx(null, (db) => one<{ id: string; full_name: string; password_hash: string; role: 'admin' | 'user';
      is_active: boolean; locked_until: Date | null; locale: string; theme: string }>(db, 'SELECT * FROM auth_find_user($1)', [body.username]));

    const ok = await bcrypt.compare(body.password, u?.password_hash ?? DUMMY_HASH);
    if (!u) throw new AppError(401, 'BAD_CREDENTIALS', 'Nom d\'utilisateur ou mot de passe incorrect');
    if (!u.is_active) throw new AppError(403, 'ACCOUNT_DISABLED', 'Compte désactivé');
    if (u.locked_until && u.locked_until > new Date()) {
      throw new AppError(423, 'ACCOUNT_LOCKED', 'Compte verrouillé après 5 essais. Réessayez dans 15 minutes.', { until: u.locked_until });
    }
    await deps.db.tx(null, (db) => db.query('SELECT auth_record_login($1, $2, $3)', [u.id, ok, client]));
    if (!ok) throw new AppError(401, 'BAD_CREDENTIALS', 'Nom d\'utilisateur ou mot de passe incorrect');

    const mustChange = await deps.db.tx({ userId: u.id }, async (db) =>
      (await one<{ v: boolean }>(db, 'SELECT must_change_password($1) AS v', [u.id]))!.v);
    const token = signToken(deps, { id: u.id, role: u.role, mustChangePassword: mustChange });
    // mot de passe à changer : l'appareil sera mémorisé après le changement (le jeton serait aussitôt invalide)
    const device = body.remember && !mustChange ? await rememberDevice(deps, u.id, body.deviceName, client) : {};
    res.json({
      token, ...device,
      user: { id: u.id, fullName: u.full_name, role: u.role, locale: u.locale, theme: u.theme, mustChangePassword: mustChange },
    });
  });

  r.get('/me', requireAuth(deps, { allowPasswordChange: true }), async (req, res) => {
    const out = await deps.db.tx(ctx(req), async (db) => {
      const user = await one(db, `SELECT id, username, full_name, email, phone, role, locale, theme, last_login_at
                                  FROM users WHERE id = current_uid()`);
      const businesses = await many(db, 'SELECT * FROM my_businesses()');
      const settings = await many<{ key: string; value: unknown }>(db,
        `SELECT key, value FROM app_settings WHERE key IN ('app_name','app_logo','default_locale','currency','currency_symbol','date_format','default_theme')`);
      return { user, businesses, settings: Object.fromEntries(settings.map((s) => [s.key, s.value])) };
    });
    if (!out.user) throw new AppError(401, 'UNAUTHENTICATED', 'Utilisateur inconnu');
    res.json(out);
  });

  r.patch('/me', requireAuth(deps), async (req, res) => {
    const b = z.object({
      fullName: z.string().trim().min(2).max(100).optional(),
      locale: z.enum(['ar', 'fr', 'en']).optional(),
      theme: z.string().trim().min(2).max(40).optional(),
      email: z.email().nullish(),
      phone: z.string().trim().max(30).nullish(),
    }).parse(req.body);
    const row = await deps.db.tx(ctx(req), (db) => one(db,
      `UPDATE users SET full_name = coalesce($1, full_name), locale = coalesce($2, locale), theme = coalesce($3, theme),
              email = CASE WHEN $6 THEN $4 ELSE email END, phone = CASE WHEN $7 THEN $5 ELSE phone END
       WHERE id = current_uid() RETURNING id, full_name, locale, theme, email, phone`,
      [b.fullName ?? null, b.locale ?? null, b.theme ?? null, b.email ?? null, b.phone ?? null, 'email' in b, 'phone' in b]));
    res.json(row);
  });

  r.post('/change-password', requireAuth(deps, { allowPasswordChange: true }), async (req, res) => {
    const b = z.object({ currentPassword: z.string().min(1), newPassword: PASSWORD_RULE,
      remember: z.boolean().optional(), deviceName: zDeviceName }).parse(req.body);
    if (b.currentPassword === b.newPassword) throw new AppError(422, 'SAME_PASSWORD', 'Le nouveau mot de passe doit être différent');
    const user = req.user!;
    await deps.db.tx(ctx(req, 'Changement de mot de passe'), async (db) => {
      const h = (await one<{ h: string | null }>(db, 'SELECT my_password_hash() AS h'))!.h;
      if (!h || !(await bcrypt.compare(b.currentPassword, h))) {
        throw new AppError(401, 'BAD_CREDENTIALS', 'Mot de passe actuel incorrect');
      }
      await db.query('SELECT set_password(current_uid(), $1)', [await bcrypt.hash(b.newPassword, 12)]);
      await db.query('SELECT set_force_password_change(current_uid(), false)');
    });
    // le changement de mot de passe invalide tous les appareils mémorisés ; celui-ci peut être mémorisé à nouveau
    const device = b.remember ? await rememberDevice(deps, user.id, b.deviceName, clientOf(req)) : {};
    res.json({ token: signToken(deps, { ...user, mustChangePassword: false }), ...device });
  });

  // ------------------------------------------------------------------ appareils mémorisés (« تذكّرني »)
  r.post('/refresh', async (req, res) => {
    const b = z.object({ refreshToken: z.string().min(20).max(200) }).parse(req.body);
    const raw = newDeviceToken();
    const row = await deps.db.tx(null, (db) => one<{ user_id: string; full_name: string; role: 'admin' | 'user'; locale: string; theme: string; expires_at: Date }>(db,
      'SELECT * FROM auth_device_rotate($1, $2, $3)', [hashDeviceToken(b.refreshToken), hashDeviceToken(raw), clientOf(req)]));
    if (!row) throw new AppError(401, 'REFRESH_INVALID', 'Session expirée, reconnectez-vous');
    const mustChange = await deps.db.tx({ userId: row.user_id }, async (db) =>
      (await one<{ v: boolean }>(db, 'SELECT must_change_password($1) AS v', [row.user_id]))!.v);
    res.json({
      token: signToken(deps, { id: row.user_id, role: row.role, mustChangePassword: mustChange }),
      refreshToken: raw, refreshExpiresAt: row.expires_at,
      user: { id: row.user_id, fullName: row.full_name, role: row.role, locale: row.locale, theme: row.theme, mustChangePassword: mustChange },
    });
  });

  r.post('/logout', async (req, res) => {
    const b = z.object({ refreshToken: z.string().max(200).optional() }).parse(req.body ?? {});
    if (b.refreshToken) await deps.db.tx(null, (db) => db.query('SELECT auth_device_logout($1)', [hashDeviceToken(b.refreshToken!)]));
    res.status(204).end();
  });

  // Appareils actifs : les siens, ou ceux d'un utilisateur (administrateur, filtré par la RLS)
  r.get('/devices', requireAuth(deps), async (req, res) => {
    const q = z.object({ userId: zId.optional() }).parse(req.query);
    res.json(await deps.db.tx(ctx(req), (db) => many(db,
      `SELECT id, user_id, device_name, client, created_at, last_used_at, expires_at FROM auth_devices
       WHERE revoked_at IS NULL AND expires_at > now() AND user_id = coalesce($1::uuid, current_uid())
       ORDER BY last_used_at DESC`, [q.userId ?? null])));
  });

  r.post('/devices/revoke', requireAuth(deps), async (req, res) => {
    const b = z.object({ userId: zId.optional(), deviceId: zId.optional() }).parse(req.body ?? {});
    const row = await deps.db.tx(ctx(req, 'Révocation d\'appareils mémorisés'), (db) => one<{ n: number }>(db,
      'SELECT auth_device_revoke(coalesce($1::uuid, current_uid()), $2::uuid, $3) AS n', [b.userId ?? null, b.deviceId ?? null, 'Révoqué depuis CashPro']));
    res.json({ revoked: row?.n ?? 0 });
  });

  return r;
}
