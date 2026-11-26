import { Router } from 'express';
import { z } from 'zod';
import { type Db, many, one, Where } from '../db';
import { AppError, notFound } from '../errors';
import { sendStored, store, uploader } from '../files';
import { ctx, type Deps, pageQuery, param, zDate, zDateTime, zId, zMoney, zOptText, zReason } from '../http';

export const SIMPLE_TYPES = ['income', 'expense', 'purchase', 'deposit', 'withdrawal'] as const;
const ALL_TYPES = [...SIMPLE_TYPES, 'transfer_out', 'transfer_in', 'adjustment_in', 'adjustment_out', 'salary_advance', 'salary_payment'] as const;

export const ledgerFilter = z.object({
  businessId: zId.optional(),
  accountId: zId.optional(),
  categoryId: zId.optional(),
  supplierId: zId.optional(),
  type: z.union([z.enum(ALL_TYPES), z.array(z.enum(ALL_TYPES))]).optional()
    .transform((v) => (v === undefined ? undefined : Array.isArray(v) ? v : [v])),
  from: zDate.optional(),
  to: zDate.optional(),
  status: z.enum(['validated', 'cancelled', 'all']).default('all'),
  q: z.string().trim().max(100).optional(),
  createdBy: zId.optional(),
  opTypeId: z.union([z.literal('none'), zId]).optional(),   // 1.2.0 : type personnalisé ('none' = types de base seulement)
});
export type LedgerFilter = z.infer<typeof ledgerFilter>;

export function ledgerWhere(f: LedgerFilter): Where {
  const w = new Where();
  w.if(f.businessId, 'business_id = ?', f.businessId);
  w.if(f.accountId, 'account_id = ?', f.accountId);
  w.if(f.categoryId, 'category_id = ?', f.categoryId);
  w.if(f.supplierId, 'supplier_id = ?', f.supplierId);
  w.if(f.type, 'transaction_type = ANY(?::txn_type[])', f.type);
  w.if(f.from, 'local_date >= ?::date', f.from);
  w.if(f.to, 'local_date <= ?::date', f.to);
  w.if(f.createdBy, 'created_by = ?', f.createdBy);
  if (f.opTypeId === 'none') w.add('op_type_id IS NULL');
  else w.if(f.opTypeId, 'op_type_id = ?', f.opTypeId);
  if (f.status !== 'all') w.add('status = ?::txn_status', f.status);
  if (f.q) {
    const p = w.param(`%${f.q}%`);
    w.add(`(description ILIKE ${p} OR reference ILIKE ${p} OR notes ILIKE ${p} OR supplier_name ILIKE ${p}
            OR category_name ILIKE ${p} OR employee_name ILIKE ${p} OR ref_no::text = ?)`, f.q.replace(/^#/, ''));
  }
  return w;
}

async function ledgerRow(db: Db, id: string) {
  return one(db, 'SELECT * FROM v_ledger WHERE id = $1', [id]);
}

export function transactionRoutes(deps: Deps): Router {
  const r = Router();
  const up = uploader(deps.maxUploadMb);

  r.get('/transactions', async (req, res) => {
    const f = ledgerFilter.parse(req.query);
    const p = pageQuery.parse(req.query);
    const w = ledgerWhere(f);
    const out = await deps.db.tx(ctx(req), async (db) => {
      const total = await one<{ n: string; total_in: string; total_out: string }>(db,
        `SELECT count(*) AS n,
                coalesce(sum(amount) FILTER (WHERE direction = 1 AND status = 'validated'), 0) AS total_in,
                coalesce(sum(amount) FILTER (WHERE direction = -1 AND status = 'validated'), 0) AS total_out
         FROM v_ledger ${w}`, w.params);
      const items = await many(db,
        `SELECT * FROM v_ledger ${w} ORDER BY transaction_date DESC, ref_no DESC LIMIT ${p.limit} OFFSET ${(p.page - 1) * p.limit}`, w.params);
      return { items, total: Number(total!.n), totalIn: total!.total_in, totalOut: total!.total_out, page: p.page, limit: p.limit };
    });
    res.json(out);
  });

  r.get('/transactions/:id', async (req, res) => {
    const id = param(req, 'id');
    const out = await deps.db.tx(ctx(req), async (db) => {
      const txn = await ledgerRow(db, id);
      if (!txn) return null;
      const attachments = await many(db,
        `SELECT id, kind, file_name, mime_type, size_bytes, uploaded_by, uploaded_at FROM transaction_attachments
         WHERE transaction_id = $1 AND is_active ORDER BY uploaded_at`, [id]);
      // historique visible par toute personne qui voit l'opération (anciennes valeurs conservées)
      const history = await many(db, 'SELECT * FROM txn_history($1)', [id]);
      const corrections = await many(db, 'SELECT id, ref_no, amount, status FROM transactions WHERE corrects_id = $1', [id]);
      return { ...txn, attachments, history, corrections };
    });
    if (!out) throw notFound('Opération');
    res.json(out);
  });

  const createBody = z.object({
    businessId: zId,
    accountId: zId,
    type: z.enum(SIMPLE_TYPES),
    amount: zMoney,
    categoryId: zId.nullish(),
    date: zDateTime.optional(),
    paymentMethodId: zId.nullish(),
    supplierId: zId.nullish(),
    newSupplier: z.object({ name: z.string().trim().min(2).max(120), phone: zOptText(30) }).optional(),
    description: zOptText(300),
    reference: zOptText(100),
    notes: zOptText(1000),
  }).refine((b) => !(b.supplierId && b.newSupplier), { message: 'supplierId ou newSupplier, pas les deux' })
    .refine((b) => (!b.supplierId && !b.newSupplier) || b.type === 'purchase' || b.type === 'expense',
      { message: 'Fournisseur seulement pour un achat ou une dépense' });

  r.post('/transactions', async (req, res) => {
    const b = createBody.parse(req.body);
    const row = await deps.db.tx(ctx(req), async (db) => {
      let supplierId = b.supplierId ?? null;
      if (b.newSupplier) {
        const existing = await one<{ id: string }>(db, 'SELECT id FROM suppliers WHERE business_id = $1 AND lower(name) = lower($2)',
          [b.businessId, b.newSupplier.name]);
        supplierId = existing?.id ?? (await one<{ id: string }>(db,
          'INSERT INTO suppliers (business_id, name, phone) VALUES ($1,$2,$3) RETURNING id',
          [b.businessId, b.newSupplier.name, b.newSupplier.phone]))!.id;
      }
      const t = await one<{ id: string }>(db,
        `INSERT INTO transactions (business_id, account_id, category_id, transaction_type, amount, transaction_date,
           payment_method_id, supplier_id, description, reference, notes)
         VALUES ($1,$2,$3,$4,$5,coalesce($6::timestamptz, now()),$7,$8,$9,$10,$11) RETURNING id`,
        [b.businessId, b.accountId, b.categoryId ?? null, b.type, b.amount, b.date ?? null, b.paymentMethodId ?? null,
          supplierId, b.description, b.reference, b.notes]);
      return ledgerRow(db, t!.id);
    });
    res.status(201).json(row);
  });

  // Ventilation : une dépense / un achat réparti entre plusieurs activités, depuis un même compte
  r.post('/transactions/split', async (req, res) => {
    const b = z.object({
      accountId: zId,
      type: z.enum(['expense', 'purchase']),
      total: zMoney,
      date: zDateTime.optional(),
      paymentMethodId: zId.nullish(),
      description: zOptText(300), reference: zOptText(100), notes: zOptText(1000),
      parts: z.array(z.object({ businessId: zId, categoryId: zId, amount: zMoney, supplierId: zId.nullish() })).min(2).max(20),
    }).parse(req.body);
    const rows = await deps.db.tx(ctx(req), async (db) => {
      const s = await one<{ id: string }>(db, 'SELECT create_split($1,$2,$3::jsonb,coalesce($4::timestamptz, now()),$5,$6,$7,$8,$9) AS id',
        [b.accountId, b.type, JSON.stringify(b.parts), b.date ?? null, b.description, b.reference, b.notes, b.paymentMethodId ?? null, b.total]);
      return many(db, 'SELECT * FROM v_ledger WHERE split_id = $1 ORDER BY business_name', [s!.id]);
    });
    res.status(201).json({ splitId: rows[0]?.split_id ?? null, items: rows });
  });

  r.patch('/transactions/:id', async (req, res) => {
    const b = z.object({
      description: zOptText(300).optional(), reference: zOptText(100).optional(), notes: zOptText(1000).optional(),
      categoryId: zId.optional(), paymentMethodId: zId.nullish(), supplierId: zId.nullish(),
      reason: z.string().trim().max(500).optional(),
    }).parse(req.body);
    const id = param(req, 'id');
    const sets: string[] = [];
    const vals: unknown[] = [id];
    const col = (c: string, v: unknown) => { vals.push(v); sets.push(`${c} = $${vals.length}`); };
    if (b.description !== undefined) col('description', b.description);
    if (b.reference !== undefined) col('reference', b.reference);
    if (b.notes !== undefined) col('notes', b.notes);
    if (b.categoryId !== undefined) col('category_id', b.categoryId);
    if (b.paymentMethodId !== undefined) col('payment_method_id', b.paymentMethodId);
    if (b.supplierId !== undefined) col('supplier_id', b.supplierId);
    if (!sets.length) throw new AppError(422, 'NOTHING_TO_UPDATE', 'Aucun champ à modifier');
    const row = await deps.db.tx(ctx(req, b.reason ?? null), async (db) => {
      const u = await one(db, `UPDATE transactions SET ${sets.join(', ')} WHERE id = $1 RETURNING id`, vals);
      return u ? ledgerRow(db, id) : null;
    });
    if (!row) throw notFound('Opération');
    res.json(row);
  });

  // Annulation « intelligente » : chaque opération liée passe par sa fonction dédiée
  r.post('/transactions/:id/cancel', async (req, res) => {
    const { reason } = z.object({ reason: zReason }).parse(req.body);
    const id = param(req, 'id');
    const row = await deps.db.tx(ctx(req, reason), async (db) => {
      const t = await one<{ transfer_id: string | null; cheque_id: string | null; reconciliation_id: string | null; transaction_type: string; split_id: string | null }>(db,
        'SELECT transfer_id, cheque_id, reconciliation_id, transaction_type, split_id FROM transactions WHERE id = $1', [id]);
      if (!t) return null;
      if (t.split_id) await db.query('SELECT cancel_split($1, $2)', [t.split_id, reason]);
      else if (t.transfer_id) await db.query('SELECT cancel_transfer($1, $2)', [t.transfer_id, reason]);
      else if (t.transaction_type === 'salary_advance' || t.transaction_type === 'salary_payment') {
        await db.query('SELECT cancel_salary_movement($1, $2)', [id, reason]);
      } else if (t.cheque_id) {
        throw new AppError(409, 'CP032', 'Opération liée à un chèque : utilisez l\'action du chèque (rejet ou annulation)');
      } else if (t.reconciliation_id) {
        throw new AppError(409, 'CP032', 'Écart de caisse : seule la réouverture de la journée (admin) l\'annule');
      } else await db.query('SELECT cancel_transaction($1, $2)', [id, reason]);
      return ledgerRow(db, id);
    });
    if (!row) throw notFound('Opération');
    res.json(row);
  });

  // Modification d'une opération simple : l'originale reste visible (annulée, barrée), la nouvelle version la remplace
  r.post('/transactions/:id/correct', async (req, res) => {
    const b = z.object({
      reason: zReason, amount: zMoney.optional(), date: zDateTime.optional(), accountId: zId.optional(), categoryId: zId.optional(),
      supplierId: zId.optional(), paymentMethodId: zId.optional(),
      description: zOptText(300).optional(), reference: zOptText(100).optional(), notes: zOptText(1000).optional(),
    }).refine((x) => x.amount || x.date || x.accountId || x.categoryId || x.supplierId || x.paymentMethodId
      || x.description || x.reference || x.notes, { message: 'Indiquez au moins une valeur corrigée' }).parse(req.body);
    const id = param(req, 'id');
    const row = await deps.db.tx(ctx(req, b.reason), async (db) => {
      const n = await one<{ id: string }>(db, 'SELECT correct_transaction_full($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) AS id',
        [id, b.reason, b.amount ?? null, b.date ?? null, b.accountId ?? null, b.categoryId ?? null, b.supplierId ?? null,
          b.paymentMethodId ?? null, b.description ?? null, b.reference ?? null, b.notes ?? null]);
      return ledgerRow(db, n!.id);
    });
    res.status(201).json(row);
  });

  // ------------------------------------------------------------------ pièces jointes
  r.post('/transactions/:id/attachments', up.single('file'), async (req, res) => {
    if (!req.file) throw new AppError(422, 'FILE_REQUIRED', 'Fichier « file » manquant');
    const id = param(req, 'id');
    const kind = z.enum(['invoice', 'receipt', 'screenshot', 'pdf', 'cheque_scan', 'other']).default('other').parse(req.body?.kind);
    const txn = await deps.db.tx(ctx(req), (db) => one<{ business_id: string }>(db, 'SELECT business_id FROM transactions WHERE id = $1', [id]));
    if (!txn) throw notFound('Opération');
    const s = await store(deps.dataDir, `attachments/${txn.business_id}`, req.file.buffer, ['png', 'jpg', 'webp', 'pdf']);
    const fileName = Buffer.from(req.file.originalname, 'latin1').toString('utf8').replace(/[\\/:*?"<>|]/g, '_').slice(0, 150) || `piece.${s.kind}`;
    const row = await deps.db.tx(ctx(req), (db) => one(db,
      `INSERT INTO transaction_attachments (business_id, transaction_id, kind, storage_key, file_name, mime_type, size_bytes, sha256, uploaded_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,current_uid())
       RETURNING id, kind, file_name, mime_type, size_bytes, uploaded_at`,
      [txn.business_id, id, kind, s.key, fileName, s.mime, s.size, s.sha256]));
    res.status(201).json(row);
  });

  r.get('/attachments/:id', async (req, res) => {
    const a = await deps.db.tx(ctx(req), (db) => one<{ storage_key: string; file_name: string }>(db,
      'SELECT storage_key, file_name FROM transaction_attachments WHERE id = $1 AND is_active', [param(req, 'id')]));
    if (!a) throw notFound('Pièce jointe');
    await sendStored(res, deps.dataDir, a.storage_key, a.file_name);
  });

  r.post('/attachments/:id/deactivate', async (req, res) => {
    const { reason } = z.object({ reason: zReason }).parse(req.body);
    const row = await deps.db.tx(ctx(req, reason), (db) => one(db,
      'UPDATE transaction_attachments SET is_active = false WHERE id = $1 AND is_active RETURNING id', [param(req, 'id')]));
    if (!row) throw notFound('Pièce jointe');
    res.json({ ok: true });
  });

  return r;
}
