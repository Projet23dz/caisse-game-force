import { Router } from 'express';
import { z } from 'zod';
import { type Db, many, one, Where } from '../db';
import { forbidden } from '../errors';
import { ctx, type Deps, pageQuery, zDate, zId } from '../http';

interface MyBiz { id: string; code: string; name: string; color: string | null; logo_path: string | null; permissions: Record<string, boolean> }

export async function assertPerm(db: Db, businessId: string, perm: string) {
  const ok = await one<{ ok: boolean }>(db, 'SELECT has_perm($1, $2) AS ok', [businessId, perm]);
  if (!ok?.ok) throw forbidden(`Permission refusée (${perm})`);
}

/** Entreprises visibles ayant la permission demandée (toutes si businessId absent). */
async function scope(db: Db, perm: string, businessId?: string): Promise<string[]> {
  if (businessId) { await assertPerm(db, businessId, perm); return [businessId]; }
  const rows = await many<MyBiz>(db, 'SELECT * FROM my_businesses()');
  return rows.filter((b) => b.permissions?.[perm]).map((b) => b.id);
}

const pct = (now: number, before: number) => (before === 0 ? null : Math.round(((now - before) / Math.abs(before)) * 1000) / 10);

export function reportRoutes(deps: Deps): Router {
  const r = Router();

  // Tableau de bord : cartes KPI, cartes d'activité, courbe 30 jours, alertes
  r.get('/dashboard', async (req, res) => {
    const out = await deps.db.tx(ctx(req), async (db) => {
      const bizs = await many<MyBiz>(db, 'SELECT * FROM my_businesses()');
      const todayStr = (await one<{ d: string }>(db, 'SELECT local_today() AS d'))!.d;
      const cards = [];
      const sumToday = { income: 0, expenses: 0, purchases: 0, salaries: 0 };
      const sumYesterday = { income: 0, expenses: 0, purchases: 0, salaries: 0 };
      let globalBalance: number | null = null;
      let globalBalanceMonthStart: number | null = null;
      const reportIds: string[] = [];
      for (const b of bizs) {
        const canBal = Boolean(b.permissions?.view_balances);
        const canRep = Boolean(b.permissions?.view_reports);
        // comptes propres à l'activité / comptes communs avec d'autres activités (affichés à part)
        const bal = canBal ? await one<{ now: string; shared: string; shared_names: string[] }>(db,
          `SELECT coalesce(sum(account_balance(x.id)) FILTER (WHERE NOT x.sh), 0) AS now,
                  coalesce(sum(account_balance(x.id)) FILTER (WHERE x.sh), 0) AS shared,
                  coalesce(array_agg(x.name) FILTER (WHERE x.sh), '{}') AS shared_names
           FROM (SELECT a.id, a.name, (SELECT count(*) FROM account_businesses ab WHERE ab.account_id = a.id) > 1 AS sh
                 FROM accounts a WHERE a.is_active AND account_serves(a.id, $1)) x`, [b.id]) : null;
        const days = canRep ? await many<{ local_date: string; income: string; expenses: string; purchases: string; salaries: string }>(db,
          `SELECT local_date, income, expenses, purchases, salaries FROM v_daily_summary
           WHERE business_id = $1 AND local_date IN (local_today(), local_today() - 1)`, [b.id]) : [];
        const t = days.find((d) => d.local_date === todayStr);
        const y = days.find((d) => d.local_date !== todayStr);
        if (canRep) {
          reportIds.push(b.id);
          for (const k of ['income', 'expenses', 'purchases', 'salaries'] as const) {
            sumToday[k] += Number(t?.[k] ?? 0); sumYesterday[k] += Number(y?.[k] ?? 0);
          }
        }
        cards.push({
          id: b.id, code: b.code, name: b.name, color: b.color, hasLogo: Boolean(b.logo_path),
          balance: bal?.now ?? null, sharedBalance: bal && bal.shared_names.length ? bal.shared : null,
          sharedAccounts: bal?.shared_names ?? [], todayIncome: canRep ? (t?.income ?? '0') : null,
        });
      }
      // solde global : chaque compte une seule fois (un compte commun n'est pas compté deux fois)
      const g = await one<{ n: string; now: string; month_start: string }>(db,
        `SELECT count(*) AS n, coalesce(sum(account_balance(id)),0) AS now,
                coalesce(sum(account_balance(id, (date_trunc('month', local_today()) - interval '1 day')::date)),0) AS month_start
         FROM accounts WHERE is_active AND account_perm(id, 'view_balances')`);
      if (g && Number(g.n) > 0) { globalBalance = Number(g.now); globalBalanceMonthStart = Number(g.month_start); }
      const kpis = {
        globalBalance: globalBalance === null ? null : globalBalance.toFixed(2),
        globalBalanceChangePct: globalBalance === null ? null : pct(globalBalance, globalBalanceMonthStart ?? 0),
        todayIncome: sumToday.income.toFixed(2), todayIncomeChangePct: pct(sumToday.income, sumYesterday.income),
        todayExpenses: sumToday.expenses.toFixed(2), todayExpensesChangePct: pct(sumToday.expenses, sumYesterday.expenses),
        todayPurchases: sumToday.purchases.toFixed(2), todayPurchasesChangePct: pct(sumToday.purchases, sumYesterday.purchases),
      };
      const series = reportIds.length ? await many(db,
        `SELECT d::date AS day, coalesce(sum(s.income),0) AS income,
                coalesce(sum(s.expenses + s.purchases + s.salaries),0) AS outflows
         FROM generate_series(local_today() - 29, local_today(), interval '1 day') d
         LEFT JOIN v_daily_summary s ON s.local_date = d::date AND s.business_id = ANY($1::uuid[])
         GROUP BY d ORDER BY d`, [reportIds]) : [];
      const distribution = reportIds.length ? await many(db,
        `SELECT bucket, sum(total) AS total FROM v_expense_distribution
         WHERE business_id = ANY($1::uuid[]) AND month = date_trunc('month', local_today())::date GROUP BY bucket ORDER BY total DESC`, [reportIds]) : [];
      const cfg = await one<{ v: { cheque_due_days?: number } | null }>(db, "SELECT value AS v FROM app_settings WHERE key = 'notifications'");
      const dueDays = Number(cfg?.v?.cheque_due_days ?? 3);
      const alerts = {
        chequesDue: await many(db, `SELECT id, business_id, business_name, direction, cheque_number, party_name, amount, due_date, is_overdue
                                    FROM v_cheques WHERE is_pending AND due_date <= local_today() + $1::int ORDER BY due_date`, [dueDays]),
        sessionsPendingReview: await many(db, `SELECT session_id, business_id, account_name, session_date, difference, reason, closed_by_name
                                               FROM v_cash_closings WHERE status = 'pending_review' ORDER BY session_date`),
        sessionsNotClosed: await many(db, `SELECT session_id, business_id, account_name, session_date FROM v_cash_closings
                                           WHERE status IN ('open','reopened') AND session_date < local_today() ORDER BY session_date`),
        payrollUnpaid: await many(db, `SELECT business_id, count(*) AS employees, sum(remaining) AS remaining FROM v_payroll_monthly
                                       WHERE period = date_trunc('month', local_today())::date AND remaining > 0 GROUP BY business_id`),
      };
      return { kpis, businesses: cards, series, distribution, alerts };
    });
    res.json(out);
  });

  r.get('/reports/daily', async (req, res) => {
    const q = z.object({ businessId: zId, date: zDate.optional() }).parse(req.query);
    res.json(await deps.db.tx(ctx(req), (db) => one(db, 'SELECT * FROM daily_report($1, $2)', [q.businessId, q.date ?? null])));
  });

  r.get('/reports/summary', async (req, res) => {
    const q = z.object({
      businessId: zId.optional(), from: zDate, to: zDate, groupBy: z.enum(['day', 'month']).default('day'),
    }).parse(req.query);
    const out = await deps.db.tx(ctx(req), async (db) => {
      const ids = await scope(db, 'view_reports', q.businessId);
      const view = q.groupBy === 'day' ? 'v_daily_summary' : 'v_monthly_summary';
      const col = q.groupBy === 'day' ? 'local_date' : 'month';
      const rows = await many(db, `SELECT ${col} AS period, business_id, b.name AS business_name, s.*
                                   FROM ${view} s JOIN businesses b ON b.id = s.business_id
                                   WHERE business_id = ANY($1::uuid[]) AND ${col} BETWEEN date_trunc($4, $2::date)::date AND $3::date
                                   ORDER BY ${col}, b.sort_order`, [ids, q.from, q.to, q.groupBy]);
      const totals = await one(db, `SELECT coalesce(sum(income),0) AS income, coalesce(sum(expenses),0) AS expenses,
             coalesce(sum(purchases),0) AS purchases, coalesce(sum(salaries),0) AS salaries, coalesce(sum(deposits),0) AS deposits,
             coalesce(sum(withdrawals),0) AS withdrawals, coalesce(sum(cash_differences),0) AS cash_differences,
             coalesce(sum(income - expenses - purchases - salaries),0) AS operating_result,
             -- consolidé : les transferts entre activités s'annulent quand toutes sont incluses
             coalesce(sum(net_change),0) AS net_change
           FROM v_daily_summary WHERE business_id = ANY($1::uuid[]) AND local_date BETWEEN $2::date AND $3::date`, [ids, q.from, q.to]);
      return { businesses: ids, rows, totals };
    });
    res.json(out);
  });

  r.get('/reports/expense-distribution', async (req, res) => {
    const q = z.object({ businessId: zId.optional(), from: zDate, to: zDate }).parse(req.query);
    res.json(await deps.db.tx(ctx(req), async (db) => {
      const ids = await scope(db, 'view_reports', q.businessId);
      return many(db, `SELECT m.bucket, coalesce(c.name, CASE m.bucket WHEN 'salaries' THEN 'Salaires' END) AS category_name, c.color,
                              sum(m.amount) AS total
                       FROM v_movements m LEFT JOIN categories c ON c.id = m.category_id
                       WHERE m.business_id = ANY($1::uuid[]) AND m.bucket IN ('expense','purchase','salaries')
                         AND m.local_date BETWEEN $2::date AND $3::date
                       GROUP BY 1, 2, 3 ORDER BY total DESC`, [ids, q.from, q.to]);
    }));
  });

  r.get('/reports/income-by-category', async (req, res) => {
    const q = z.object({ businessId: zId.optional(), from: zDate, to: zDate }).parse(req.query);
    res.json(await deps.db.tx(ctx(req), async (db) => {
      const ids = await scope(db, 'view_reports', q.businessId);
      return many(db, `SELECT b.name AS business_name, c.name AS category_name, c.color, sum(m.amount) AS total
                       FROM v_movements m JOIN businesses b ON b.id = m.business_id LEFT JOIN categories c ON c.id = m.category_id
                       WHERE m.business_id = ANY($1::uuid[]) AND m.bucket = 'income' AND m.local_date BETWEEN $2::date AND $3::date
                       GROUP BY 1, 2, 3 ORDER BY total DESC`, [ids, q.from, q.to]);
    }));
  });

  r.get('/reports/balance-series', async (req, res) => {
    const q = z.object({ businessId: zId, from: zDate, to: zDate }).parse(req.query);
    res.json(await deps.db.tx(ctx(req), (db) => many(db, 'SELECT * FROM balance_series($1,$2,$3)', [q.businessId, q.from, q.to])));
  });

  r.get('/reports/balances', async (req, res) => {
    const q = z.object({ businessId: zId.optional() }).parse(req.query);
    res.json(await deps.db.tx(ctx(req), (db) => many(db,
      `SELECT * FROM v_account_balances WHERE ($1::uuid IS NULL OR business_id = $1) ORDER BY business_name, account_name`, [q.businessId ?? null])));
  });

  // ------------------------------------------------------------------ سجل التعديلات
  r.get('/audit', async (req, res) => {
    const q = z.object({
      businessId: zId.optional(), userId: zId.optional(), table: z.string().max(40).optional(),
      recordId: z.string().max(80).optional(), action: z.string().max(40).optional(), from: zDate.optional(), to: zDate.optional(),
    }).parse(req.query);
    const p = pageQuery.parse(req.query);
    const w = new Where();
    w.if(q.businessId, 'business_id = ?', q.businessId);
    w.if(q.userId, 'user_id = ?', q.userId);
    w.if(q.table, 'table_name = ?', q.table);
    w.if(q.recordId, 'record_id = ?', q.recordId);
    w.if(q.action, 'action = ?', q.action);
    w.if(q.from, "timezone('Africa/Algiers', occurred_at)::date >= ?::date", q.from);
    w.if(q.to, "timezone('Africa/Algiers', occurred_at)::date <= ?::date", q.to);
    const out = await deps.db.tx(ctx(req), async (db) => {
      if (q.businessId) await assertPerm(db, q.businessId, 'view_audit');
      const n = await one<{ n: string }>(db, `SELECT count(*) AS n FROM v_audit ${w}`, w.params);
      const items = await many(db, `SELECT * FROM v_audit ${w} ORDER BY occurred_at DESC, id DESC
                                    LIMIT ${p.limit} OFFSET ${(p.page - 1) * p.limit}`, w.params);
      return { items, total: Number(n!.n), page: p.page, limit: p.limit };
    });
    res.json(out);
  });

  return r;
}
