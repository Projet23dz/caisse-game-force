import type { ErrorRequestHandler } from 'express';
import { ZodError } from 'zod';

export class AppError extends Error {
  constructor(public status: number, public code: string, message: string, public details?: unknown) {
    super(message);
  }
}

export const notFound = (what = 'Ressource') => new AppError(404, 'NOT_FOUND', `${what} introuvable`);
export const forbidden = (msg = 'Accès refusé') => new AppError(403, 'FORBIDDEN', msg);

// Codes métier levés par la base (CPxxx) → statut HTTP
const FORBIDDEN_CODES = new Set(['CP001', 'CP002', 'CP003', 'CP004', 'CP005', 'CP026', 'CP027', 'CP035']);
const CONFLICT_CODES = new Set(['CP010', 'CP031', 'CP062', 'CP072', 'CP074', 'CP076', 'CP077', 'CP078',
  'CP081', 'CP083', 'CP084', 'CP085', 'CP105']);
const NOT_FOUND_CODES = new Set(['CP050', 'CP060', 'CP071', 'CP091']);

interface PgError { code?: string; message: string; detail?: string; constraint?: string }

export function fromPg(err: PgError): AppError | null {
  const m = /^(CP\d{3}):\s*(.*)$/s.exec(err.message ?? '');
  if (m) {
    const [, code, msg] = m;
    const status = FORBIDDEN_CODES.has(code) ? 403 : CONFLICT_CODES.has(code) ? 409 : NOT_FOUND_CODES.has(code) ? 404 : 422;
    return new AppError(status, code, msg);
  }
  switch (err.code) {
    case '42501': return new AppError(403, 'FORBIDDEN', 'Action non autorisée');
    case '23505': return new AppError(409, 'DUPLICATE', 'Cette valeur existe déjà', err.constraint);
    case '23503': return new AppError(422, 'INVALID_REFERENCE', 'Référence invalide (élément inexistant ou d\'une autre entreprise)', err.constraint);
    case '23514': return new AppError(422, 'CHECK_FAILED', 'Donnée refusée par une règle de contrôle', err.constraint);
    case '23502': return new AppError(422, 'MISSING_FIELD', 'Champ obligatoire manquant', err.message);
    case '22P02': case '22007': case '22008': case '22003':
      return new AppError(422, 'INVALID_VALUE', 'Valeur invalide', err.message);
    default: return null;
  }
}

export const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
  let e: AppError | null = null;
  if (err instanceof AppError) e = err;
  else if (err instanceof ZodError) {
    e = new AppError(422, 'VALIDATION', 'Données invalides',
      err.issues.map((i) => ({ field: i.path.join('.'), message: i.message })));
  } else if (err && typeof err === 'object' && 'type' in err && (err as { type: string }).type === 'entity.parse.failed') {
    e = new AppError(400, 'BAD_JSON', 'JSON invalide');
  } else if (err && typeof err === 'object' && 'code' in err && (err as { code: string }).code === 'LIMIT_FILE_SIZE') {
    e = new AppError(413, 'FILE_TOO_LARGE', 'Fichier trop volumineux');
  } else if (err && typeof err === 'object' && 'message' in err) {
    e = fromPg(err as PgError);
  }
  if (!e) {
    console.error('[cashpro] erreur interne', err);
    e = new AppError(500, 'INTERNAL', 'Erreur interne du serveur');
  }
  res.status(e.status).json({ error: { code: e.code, message: e.message, details: e.details } });
};
