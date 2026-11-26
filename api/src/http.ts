import type { Request, RequestHandler } from 'express';
import jwt from 'jsonwebtoken';
import { z } from 'zod';
import type { Ctx, Database } from './db';
import { AppError } from './errors';

export interface AuthUser { id: string; role: 'admin' | 'user'; mustChangePassword: boolean }

declare global {
  namespace Express {
    interface Request { user?: AuthUser }
  }
}

export interface Deps {
  db: Database;
  jwtSecret: string;
  jwtTtl: string;
  dataDir: string;
  maxUploadMb: number;
}

export function signToken(deps: Deps, u: AuthUser): string {
  return jwt.sign({ role: u.role, mcp: u.mustChangePassword }, deps.jwtSecret,
    { subject: u.id, expiresIn: deps.jwtTtl as jwt.SignOptions['expiresIn'], algorithm: 'HS256' });
}

export function requireAuth(deps: Deps, opts: { allowPasswordChange?: boolean } = {}): RequestHandler {
  return (req, _res, next) => {
    const h = req.headers.authorization ?? '';
    const token = h.startsWith('Bearer ') ? h.slice(7) : '';
    if (!token) return next(new AppError(401, 'UNAUTHENTICATED', 'Connexion requise'));
    try {
      const p = jwt.verify(token, deps.jwtSecret, { algorithms: ['HS256'] }) as jwt.JwtPayload;
      req.user = { id: String(p.sub), role: p.role === 'admin' ? 'admin' : 'user', mustChangePassword: Boolean(p.mcp) };
    } catch {
      return next(new AppError(401, 'TOKEN_INVALID', 'Session expirée, reconnectez-vous'));
    }
    if (req.user.mustChangePassword && !opts.allowPasswordChange) {
      return next(new AppError(403, 'PASSWORD_CHANGE_REQUIRED', 'Changez votre mot de passe avant de continuer'));
    }
    next();
  };
}

export function requireAdmin(): RequestHandler {
  return (req, _res, next) => next(req.user?.role === 'admin' ? undefined : new AppError(403, 'CP004', 'Réservé à l\'administrateur'));
}

export function ctx(req: Request, reason?: string | null): Ctx {
  return {
    userId: req.user!.id,
    reason: reason ?? null,
    client: `${req.ip ?? '-'} ${String(req.headers['x-cashpro-client'] ?? '').slice(0, 80)}`.trim(),
  };
}

// ----------------------------------------------------------------------------
// Validation
// ----------------------------------------------------------------------------
export const zId = z.guid(); // guid : accepte aussi les identifiants fixes du seed (10000000-…)
export const zMoney = z.union([z.number(), z.string()])
  .transform((v) => String(v).trim().replace(/\s/g, '').replace(',', '.'))
  .refine((s) => /^\d{1,16}(\.\d{1,2})?$/.test(s) && Number(s) > 0, 'Montant invalide (positif, 2 décimales max)');
export const zMoneyOrZero = z.union([z.number(), z.string()])
  .transform((v) => String(v).trim().replace(/\s/g, '').replace(',', '.'))
  .refine((s) => /^\d{1,16}(\.\d{1,2})?$/.test(s), 'Montant invalide');
export const zDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Date attendue au format AAAA-MM-JJ');
export const zDateTime = z.iso.datetime({ offset: true });
export const zReason = z.string().trim().min(3, 'Motif obligatoire (3 caractères minimum)').max(500);
export const zText = (max = 500) => z.string().trim().max(max);
export const zOptText = (max = 500) => z.string().trim().max(max).nullish().transform((v) => (v ? v : null));

export const pageQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(500).default(50),
});

export function param(req: Request, name: string): string {
  return zId.parse(req.params[name]);
}
