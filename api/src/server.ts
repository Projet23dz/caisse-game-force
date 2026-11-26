import fs from 'node:fs';
import { createApp } from './app';
import { loadConfig } from './config';
import { Database } from './db';

async function main() {
  const cfg = loadConfig();
  fs.mkdirSync(cfg.DATA_DIR, { recursive: true });
  const db = new Database(cfg.DATABASE_URL);
  await db.pool.query('SELECT 1');           // échoue tôt si la base est injoignable
  const app = createApp({ db, jwtSecret: cfg.JWT_SECRET, jwtTtl: cfg.JWT_TTL, dataDir: cfg.DATA_DIR, maxUploadMb: cfg.MAX_UPLOAD_MB },
    { corsOrigins: cfg.CORS_ORIGINS, backgroundJobs: true });
  const server = app.listen(cfg.PORT, cfg.HOST, () => {
    console.log(`[cashpro] API à l'écoute sur http://${cfg.HOST}:${cfg.PORT}  (données : ${cfg.DATA_DIR})`);
  });
  const stop = () => { server.close(() => { void db.close().then(() => process.exit(0)); }); };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

main().catch((e) => { console.error('[cashpro] démarrage impossible :', e instanceof Error ? e.message : e); process.exit(1); });
