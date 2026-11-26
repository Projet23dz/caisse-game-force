import { Router } from 'express';
import { z } from 'zod';
import { many, one, Where } from '../db';
import { notFound } from '../errors';
import { ctx, type Deps, pageQuery, param, zDate, zDateTime, zId, zMoney, zOptText, zReason } from '../http';

export function opsRoutes(deps: Deps): Router {
  const r = Router();

  // ================================================================== transferts
  r.get('/transfers', async (req, res) => {
    const q = z.object({ businessId: zId.optional(), from: zDate.optional(), to: zDate.optional() }).parse(req.query);
    const p = pageQuery.parse(req.query);
    const w = new Where();
    w.if(q.businessId, '(t.from_business_id = ? OR t.to_business_id = ?)', q.businessId, q.businessId);
    w.if(q.from, "timezone('Africa/Algiers', t.transfer_date)::date >= ?::date", q.from);
    w.if(q.to, "timezone('Africa/Algiers', t.transfer_date)::date <= ?::date", q.to);
    res.json(await deps.db.tx(ctx(req), (db) => many(db,
      `SELECT t.*, fa.name AS from_account_name, ta.name AS to_account_name, fb.name AS from_business_name, tb.name AS to_business_name
       FROM transfers t JOIN accounts fa ON fa.id = t.from_account_id JOIN accounts ta ON ta.id = t.to_account_id
       JOIN businesses fb ON fb.id = t.from_business_id JOIN businesses tb ON tb.id = t.to_business_id
       ${w} ORDER BY t.transfer_date DESC LIMIT ${p.limit} OFFSET ${(p.page - 1) * p.limit}`, w.params)));
  });

  r.post('/transfers', async (req, res) => {
    const b = z.object({
      fromAccountId: zId, toAccountId: zId, amount: zMoney, date: zDateTime.optional(),
      reference: zOptText(100), description: zOptText(300),
      // compte commun : activité de chaque côté (par défaut : activité propriétaire du compte)
      fromBusinessId: zId.optional(), toBusinessId: zId.optional(),
    }).parse(req.body);
    const row = await deps.db.tx(ctx(req), async (db) => {
      const t = await one<{ id: string }>(db, 'SELECT create_transfer($1,$2,$3,coalesce($4::timestamptz, now()),$5,$6,$7,$8) AS id',
        [b.fromAccountId, b.toAccountId, b.amount, b.date ?? null, b.reference, b.description, b.fromBusinessId ?? null, b.toBusinessId ?? null]);
      return one(db, 'SELECT * FROM transfers WHERE id = $1', [t!.id]);
    });
    res.status(201).json(row);
  });

  r.post('/transfers/:id/cancel', async (req, res) => {
    const { reason } = z.object({ reason: zReason }).parse(req.body);
    const id = param(req, 'id');
    const row = await deps.db.tx(ctx(req, reason), async (db) => {
      await db.query('SELECT cancel_transfer($1,$2)', [id, reason]);
      return one(db, 'SELECT * FROM transfers WHERE id = $1', [id]);
    });
    res.json(row);
  });

  // ================================================================== chèques
  r.get('/cheques', async (req, res) => {
    const q = z.object({
      businessId: zId.optional(), direction: z.enum(['received', 'issued']).optional(),
      status: z.enum(['in_portfolio', 'deposited', 'cleared', 'rejected', 'issued', 'cancelled']).optional(),
      pending: z.enum(['true', 'false']).optional(), dueBefore: zDate.optional(),
    }).parse(req.query);
    const w = new Where();
    w.if(q.businessId, 'business_id = ?', q.businessId);
    w.if(q.direction, 'direction = ?::cheque_direction', q.direction);
    w.if(q.status, 'status = ?::cheque_status', q.status);
    if (q.pending) w.add('is_pending = ?', q.pending === 'true');
    w.if(q.dueBefore, 'due_date <= ?::date', q.dueBefore);
    res.json(await deps.db.tx(ctx(req), (db) => many(db,
      `SELECT * FROM v_cheques ${w} ORDER BY is_pending DESC, due_date NULLS LAST, created_at DESC LIMIT 500`, w.params)));
  });

  r.get('/cheques/:id', async (req, res) => {
    const id = param(req, 'id');
    const out = await deps.db.tx(ctx(req), async (db) => {
      const c = await one(db, 'SELECT * FROM v_cheques WHERE id = $1', [id]);
      if (!c) return null;
      const history = await many(db, `SELECT occurred_at, user_name, action, changed, old_values, new_values, reason FROM v_audit
                                      WHERE table_name = 'cheques' AND record_id = $1 ORDER BY occurred_at`, [id]);
      return { ...c, history };
    });
    if (!out) throw notFound('Chèque');
    res.json(out);
  });

  r.post('/cheques/receive', async (req, res) => {
    const b = z.object({
      businessId: zId, number: z.string().trim().min(1).max(40), bank: zOptText(80), drawer: z.string().trim().min(2).max(120),
      amount: zMoney, issueDate: zDate, dueDate: zDate.nullish(), txnType: z.enum(['income', 'deposit']).default('income'),
      categoryId: zId.nullish(), notes: zOptText(500),
    }).parse(req.body);
    const row = await deps.db.tx(ctx(req), async (db) => {
      const c = await one<{ id: string }>(db, 'SELECT cheque_receive($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) AS id',
        [b.businessId, b.number, b.bank, b.drawer, b.amount, b.issueDate, b.dueDate ?? null, b.txnType, b.categoryId ?? null, b.notes]);
      return one(db, 'SELECT * FROM v_cheques WHERE id = $1', [c!.id]);
    });
    res.status(201).json(row);
  });

  r.post('/cheques/issue', async (req, res) => {
    const b = z.object({
      businessId: zId, accountId: zId, number: z.string().trim().min(1).max(40), payee: z.string().trim().min(2).max(120),
      amount: zMoney, issueDate: zDate, dueDate: zDate.nullish(), txnType: z.enum(['expense', 'purchase', 'withdrawal']).default('purchase'),
      categoryId: zId.nullish(), supplierId: zId.nullish(), notes: zOptText(500),
    }).parse(req.body);
    const row = await deps.db.tx(ctx(req), async (db) => {
      const c = await one<{ id: string }>(db, 'SELECT cheque_issue($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) AS id',
        [b.businessId, b.accountId, b.number, b.payee, b.amount, b.issueDate, b.dueDate ?? null, b.txnType,
          b.categoryId ?? null, b.supplierId ?? null, b.notes]);
      return one(db, 'SELECT * FROM v_cheques WHERE id = $1', [c!.id]);
    });
    res.status(201).json(row);
  });

  const chequeAction = (path: string, sql: string, schema: z.ZodType<Record<string, unknown>>, args: (b: Record<string, unknown>) => unknown[], reasonKey?: string) =>
    r.post(`/cheques/:id/${path}`, async (req, res) => {
      const b = schema.parse(req.body ?? {});
      const id = param(req, 'id');
      const row = await deps.db.tx(ctx(req, reasonKey ? String(b[reasonKey]) : null), async (db) => {
        await db.query(sql, [id, ...args(b)]);
        return one(db, 'SELECT * FROM v_cheques WHERE id = $1', [id]);
      });
      res.json(row);
    });
  chequeAction('deposit', 'SELECT cheque_deposit($1,$2,coalesce($3::timestamptz, now()))',
    z.object({ accountId: zId, date: zDateTime.optional() }), (b) => [b.accountId, b.date ?? null]);
  chequeAction('clear', 'SELECT cheque_clear($1,coalesce($2::timestamptz, now()))',
    z.object({ date: zDateTime.optional() }), (b) => [b.date ?? null]);
  chequeAction('reject', 'SELECT cheque_reject($1,$2)', z.object({ reason: zReason }), (b) => [b.reason], 'reason');
  chequeAction('cancel', 'SELECT cheque_cancel($1,$2)', z.object({ reason: zReason }), (b) => [b.reason], 'reason');

  // ================================================================== caisse
  r.get('/cash/status', async (req, res) => {
    const { accountId } = z.object({ accountId: zId }).parse(req.query);
    const out = await deps.db.tx(ctx(req), async (db) => {
      const acc = await one(db, 'SELECT id, business_id, name, kind, requires_session FROM accounts WHERE id = $1', [accountId]);
      if (!acc) return null;
      const today = await one(db, 'SELECT * FROM v_cash_closings WHERE account_id = $1 AND session_date = local_today()', [accountId]);
      const pending = await many(db, `SELECT * FROM v_cash_closings WHERE account_id = $1 AND status IN ('open','reopened','pending_review')
                                      ORDER BY session_date`, [accountId]);
      const bal = await one<{ theoretical: string | null; today_in: string; today_out: string }>(db,
        `SELECT CASE WHEN has_perm($2, 'view_balances') OR has_perm($2, 'cash_session') THEN account_balance($1) END AS theoretical,
                coalesce(sum(amount) FILTER (WHERE direction = 1), 0) AS today_in,
                coalesce(sum(amount) FILTER (WHERE direction = -1), 0) AS today_out
         FROM transactions WHERE account_id = $1 AND status = 'validated' AND local_date = local_today()`,
        [accountId, (acc as { business_id: string }).business_id]);
      return { account: acc, today, pending, ...bal };
    });
    if (!out) throw notFound('Compte');
    res.json(out);
  });

  r.get('/cash/sessions', async (req, res) => {
    const q = z.object({ accountId: zId.optional(), businessId: zId.optional(), from: zDate.optional(), to: zDate.optional() }).parse(req.query);
    const w = new Where();
    w.if(q.accountId, 'account_id = ?', q.accountId);
    w.if(q.businessId, 'business_id = ?', q.businessId);
    w.if(q.from, 'session_date >= ?::date', q.from);
    w.if(q.to, 'session_date <= ?::date', q.to);
    res.json(await deps.db.tx(ctx(req), (db) => many(db, `SELECT * FROM v_cash_closings ${w} ORDER BY session_date DESC LIMIT 400`, w.params)));
  });

  const SESSION_SQL = 'SELECT * FROM v_cash_closings WHERE session_id = $1';

  r.post('/cash/sessions/open', async (req, res) => {
    const b = z.object({ accountId: zId, date: zDate.optional(), declared: zMoney.optional(), notes: zOptText(500) }).parse(req.body);
    const row = await deps.db.tx(ctx(req), async (db) => {
      const s = await one<{ id: string }>(db, 'SELECT open_session($1,$2,$3,$4) AS id', [b.accountId, b.date ?? null, b.declared ?? null, b.notes]);
      return one(db, SESSION_SQL, [s!.id]);
    });
    res.status(201).json(row);
  });

  r.post('/cash/sessions/:id/close', async (req, res) => {
    const b = z.object({ physical: z.union([z.number(), z.string()]).transform(String), reason: zOptText(500) }).parse(req.body);
    const id = param(req, 'id');
    const row = await deps.db.tx(ctx(req, b.reason), async (db) => {
      await db.query('SELECT close_session($1,$2::numeric,$3)', [id, b.physical, b.reason]);
      return one(db, SESSION_SQL, [id]);
    });
    res.json(row);
  });

  r.post('/cash/sessions/:id/approve', async (req, res) => {
    const b = z.object({ reason: zOptText(500) }).parse(req.body ?? {});
    const id = param(req, 'id');
    const row = await deps.db.tx(ctx(req, b.reason), async (db) => {
      await db.query('SELECT approve_session($1,$2)', [id, b.reason]);
      return one(db, SESSION_SQL, [id]);
    });
    res.json(row);
  });

  r.post('/cash/sessions/:id/reopen', async (req, res) => {
    const { reason } = z.object({ reason: zReason }).parse(req.body);
    const id = param(req, 'id');
    const row = await deps.db.tx(ctx(req, reason), async (db) => {
      await db.query('SELECT reopen_session($1,$2)', [id, reason]);
      return one(db, SESSION_SQL, [id]);
    });
    res.json(row);
  });

  // ================================================================== personnel et paie
  r.get('/businesses/:id/employees', async (req, res) => {
    const { all } = z.object({ all: z.coerce.boolean().optional() }).parse(req.query);
    res.json(await deps.db.tx(ctx(req), (db) => many(db,
      `SELECT e.*, payroll_remaining(e.id, local_today()) AS remaining_to_date
       FROM employees e WHERE business_id = $1 AND ($2 OR is_active) ORDER BY full_name`, [param(req, 'id'), all ?? false])));
  });

  const empBody = z.object({
    fullName: z.string().trim().min(2).max(120), jobTitle: zOptText(80), phone: zOptText(30),
    monthlySalary: z.union([z.number(), z.string()]).transform(String).refine((s) => /^\d{1,14}(\.\d{1,2})?$/.test(s), 'Salaire invalide'),
    startDate: zDate, endDate: zDate.nullish(), notes: zOptText(500),
  });
  r.post('/businesses/:id/employees', async (req, res) => {
    const b = empBody.parse(req.body);
    const row = await deps.db.tx(ctx(req), (db) => one(db,
      `INSERT INTO employees (business_id, full_name, job_title, phone, monthly_salary, start_date, end_date, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [param(req, 'id'), b.fullName, b.jobTitle, b.phone, b.monthlySalary, b.startDate, b.endDate ?? null, b.notes]));
    res.status(201).json(row);
  });
  r.patch('/employees/:id', async (req, res) => {
    const b = empBody.partial().extend({ isActive: z.boolean().optional(), reason: zReason.optional() }).parse(req.body);
    const row = await deps.db.tx(ctx(req, b.reason ?? null), (db) => one(db,
      `UPDATE employees SET full_name = coalesce($2,full_name), job_title = coalesce($3,job_title), phone = coalesce($4,phone),
         monthly_salary = coalesce($5::numeric,monthly_salary), start_date = coalesce($6::date,start_date),
         end_date = coalesce($7::date,end_date), notes = coalesce($8,notes), is_active = coalesce($9,is_active)
       WHERE id = $1 RETURNING *`,
      [param(req, 'id'), b.fullName ?? null, b.jobTitle ?? null, b.phone ?? null, b.monthlySalary ?? null, b.startDate ?? null,
        b.endDate ?? null, b.notes ?? null, b.isActive ?? null]));
    if (!row) throw notFound('Employé');
    res.json(row);
  });

  const movement = z.object({ employeeId: zId, period: zDate, amount: zMoney, accountId: zId, date: zDateTime.optional(), notes: zOptText(500) });
  for (const kind of ['advance', 'payment'] as const) {
    r.post(`/payroll/${kind}`, async (req, res) => {
      const b = movement.parse(req.body);
      const row = await deps.db.tx(ctx(req), async (db) => {
        const t = await one<{ id: string }>(db, `SELECT salary_${kind}($1,$2,$3,$4,coalesce($5::timestamptz, now()),$6) AS id`,
          [b.employeeId, b.period, b.amount, b.accountId, b.date ?? null, b.notes]);
        return one(db, 'SELECT * FROM v_ledger WHERE id = $1', [t!.id]);
      });
      res.status(201).json(row);
    });
  }

  r.post('/payroll/items', async (req, res) => {
    const b = z.object({ employeeId: zId, period: zDate, kind: z.enum(['bonus', 'deduction']), amount: zMoney, reason: zReason }).parse(req.body);
    const row = await deps.db.tx(ctx(req, b.reason), async (db) => {
      const p = await one<{ id: string }>(db, 'SELECT payroll_item_add($1,$2,$3,$4,$5) AS id', [b.employeeId, b.period, b.kind, b.amount, b.reason]);
      return one(db, 'SELECT * FROM payroll_items WHERE id = $1', [p!.id]);
    });
    res.status(201).json(row);
  });

  r.post('/payroll/items/:id/cancel', async (req, res) => {
    const { reason } = z.object({ reason: zReason }).parse(req.body);
    const row = await deps.db.tx(ctx(req, reason), (db) => one(db,
      `UPDATE payroll_items SET status = 'cancelled', cancel_reason = $2, cancelled_by = current_uid(), cancelled_at = now()
       WHERE id = $1 AND status = 'validated' RETURNING *`, [param(req, 'id'), reason]));
    if (!row) throw notFound('Prime / retenue');
    res.json(row);
  });

  r.get('/payroll/monthly', async (req, res) => {
    const q = z.object({ businessId: zId.optional(), employeeId: zId.optional(), period: zDate.optional() }).parse(req.query);
    const w = new Where();
    w.if(q.businessId, 'business_id = ?', q.businessId);
    w.if(q.employeeId, 'employee_id = ?', q.employeeId);
    w.if(q.period, "period = date_trunc('month', ?::date)::date", q.period);
    res.json(await deps.db.tx(ctx(req), (db) => many(db, `SELECT * FROM v_payroll_monthly ${w} ORDER BY full_name, period DESC`, w.params)));
  });

  r.get('/employees/:id/statement', async (req, res) => {
    const id = param(req, 'id');
    const out = await deps.db.tx(ctx(req), async (db) => {
      const employee = await one(db, 'SELECT * FROM employees WHERE id = $1', [id]);
      if (!employee) return null;
      const months = await many(db, 'SELECT * FROM v_payroll_monthly WHERE employee_id = $1 ORDER BY period DESC', [id]);
      const movements = await many(db, `SELECT id, ref_no, transaction_type, amount, transaction_date, payroll_period, account_name, status, notes
                                        FROM v_ledger WHERE employee_id = $1 ORDER BY transaction_date DESC`, [id]);
      const items = await many(db, 'SELECT * FROM payroll_items WHERE employee_id = $1 ORDER BY period DESC, created_at DESC', [id]);
      return { employee, months, movements, items };
    });
    if (!out) throw notFound('Employé');
    res.json(out);
  });

  return r;
}
