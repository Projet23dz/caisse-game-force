import fs from 'node:fs';
import path from 'node:path';
import dotenv from 'dotenv';
import { z } from 'zod';

// Fichier de configuration : CASHPRO_ENV_FILE, sinon celui créé par install-database.ps1, sinon .env local
const ENV_CANDIDATES = [process.env.CASHPRO_ENV_FILE, 'C:\\CashPro\\config\\cashpro.env', path.resolve(process.cwd(), '.env')];
const envFile = ENV_CANDIDATES.find((f) => f && fs.existsSync(f));
const loaded = envFile ? dotenv.config({ path: envFile, quiet: true }) : null;

const schema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('production'),
  HOST: z.string().default('0.0.0.0'),
  PORT: z.coerce.number().int().min(1).max(65535).default(4600),
  DATABASE_URL: z.string().min(1, 'DATABASE_URL obligatoire (rôle cashpro_app)'),
  JWT_SECRET: z.string().min(32, 'JWT_SECRET doit faire au moins 32 caractères'),
  JWT_TTL: z.string().default('12h'),
  DATA_DIR: z.string().default(process.platform === 'win32' ? 'C:\\CashPro' : path.resolve(process.cwd(), 'data')),
  CORS_ORIGINS: z.string().default('*'),
  MAX_UPLOAD_MB: z.coerce.number().positive().max(20).default(20),
});

export type Config = z.infer<typeof schema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = schema.safeParse({ ...env, PORT: env.PORT ?? env.API_PORT });
  if (!parsed.success) {
    const msg = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('\n');
    const why = loaded?.error ? ` — lecture impossible : ${loaded.error.message}` : '';
    throw new Error(`Configuration invalide (${envFile ?? 'aucun fichier .env'}${why}) :\n${msg}`);
  }
  return parsed.data;
}

export const configFile = envFile ?? null;
