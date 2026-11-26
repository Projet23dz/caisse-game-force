import { Pool, type PoolClient, types } from 'pg';

// numeric → string (jamais de float pour l'argent) ; date → 'YYYY-MM-DD' brut
types.setTypeParser(1082, (v) => v);
types.setTypeParser(20, (v) => v); // bigint (ref_no, count) → string

export type Db = PoolClient;

export interface Ctx {
  userId: string;
  reason?: string | null;
  client?: string | null;
}

export class Database {
  readonly pool: Pool;
  constructor(url: string) {
    this.pool = new Pool({
      connectionString: url, max: 20, idleTimeoutMillis: 30_000,
      options: '-c search_path=cashpro,public -c TimeZone=Africa/Algiers',
    });
  }

  /** Exécute fn dans une transaction SQL portant l'identité de l'utilisateur (RLS + audit). */
  async tx<T>(ctx: Ctx | null, fn: (db: Db) => Promise<T>): Promise<T> {
    const c = await this.pool.connect();
    try {
      await c.query('BEGIN');
      await c.query(
        `SELECT set_config('cashpro.user_id', $1, true), set_config('cashpro.reason', $2, true),
                set_config('cashpro.client', $3, true), set_config('cashpro.internal', 'off', true)`,
        [ctx?.userId ?? '', ctx?.reason ?? '', ctx?.client ?? '']);
      const out = await fn(c);
      await c.query('COMMIT');
      return out;
    } catch (e) {
      await c.query('ROLLBACK').catch(() => undefined);
      throw e;
    } finally {
      c.release();
    }
  }

  close() { return this.pool.end(); }
}

export async function one<T = Record<string, unknown>>(db: Db, sql: string, params: unknown[] = []): Promise<T | null> {
  const r = await db.query(sql, params);
  return (r.rows[0] as T) ?? null;
}

export async function many<T = Record<string, unknown>>(db: Db, sql: string, params: unknown[] = []): Promise<T[]> {
  const r = await db.query(sql, params);
  return r.rows as T[];
}

/** Petit constructeur de clauses WHERE paramétrées. */
export class Where {
  private parts: string[] = [];
  readonly params: unknown[] = [];
  add(sqlWithQ: string, ...vals: unknown[]) {
    let s = sqlWithQ;
    for (const v of vals) { this.params.push(v); s = s.replace('?', `$${this.params.length}`); }
    this.parts.push(s);
    return this;
  }
  if(cond: unknown, sqlWithQ: string, ...vals: unknown[]) { if (cond !== undefined && cond !== null && cond !== '') this.add(sqlWithQ, ...vals); return this; }
  param(v: unknown) { this.params.push(v); return `$${this.params.length}`; }
  toString() { return this.parts.length ? 'WHERE ' + this.parts.join(' AND ') : ''; }
}
