import { Router } from 'express';
import { z } from 'zod';
import { many, one } from '../db';
import { AppError, notFound } from '../errors';
import { listFiles, sendStored, store, uploader } from '../files';
import { ctx, type Deps, param, requireAdmin, zDate, zId, zMoneyOrZero, zOptText, zReason } from '../http';

const zColor = z.string().regex(/^#[0-9A-Fa-f]{6}$/, 'Couleur #RRGGBB').nullish();
const TXN_CAT_TYPES = ['income', 'expense', 'purchase', 'deposit', 'withdrawal'] as const;

export function setupRoutes(deps: Deps): Router {
  const r = Router();
  const up = uploader(deps.maxUploadMb);

  // ------------------------------------------------------------------ businesses
  r.get('/businesses', async (req, res) => {
    res.json(await deps.db.tx(ctx(req), (db) => many(db, 'SELECT * FROM my_businesses()')));
  });

  r.get('/businesses/:id', async (req, res) => {
    const row = await deps.db.tx(ctx(req), (db) => one(db, 'SELECT * FROM businesses WHERE id = $1', [param(req, 'id')]));
    if (!row) throw notFound('Activité');
    res.json(row);
  });

  const bizBody = z.object({
    code: z.string().trim().toUpperCase().regex(/^[A-Z0-9_-]{2,10}$/, 'Code : 2 à 10 lettres/chiffres'),
    name: z.string().trim().min(2).max(100),
    activity: zOptText(200), address: zOptText(300), phone: zOptText(30), email: zOptText(100),
    nif: zOptText(30), rc: zOptText(30), color: zColor, sortOrder: z.number().int().optional(),
    // comptes créés automatiquement avec la nouvelle activité
    withDefaultAccounts: z.boolean().default(true),
    // comptes communs existants que la nouvelle activité utilise aussi (pas de compte propre créé pour ces types)
    sharedAccountIds: z.array(zId).max(50).default([]),
  });

  r.post('/businesses', requireAdmin(), async (req, res) => {
    const b = bizBody.parse(req.body);
    const row = await deps.db.tx(ctx(req, 'Création activité'), async (db) => {
      const biz = await one<{ id: string }>(db,
        `INSERT INTO businesses (code, name, activity, address, phone, email, nif, rc, color, sort_order)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,coalesce($10,(SELECT coalesce(max(sort_order),0)+1 FROM businesses))) RETURNING *`,
        [b.code, b.name, b.activity, b.address, b.phone, b.email, b.nif, b.rc, b.color ?? null, b.sortOrder ?? null]);
      const covered = new Set<string>();
      for (const accId of b.sharedAccountIds) {
        const acc = await one<{ kind: string; ids: string[] }>(db,
          `SELECT a.kind::text AS kind, ARRAY(SELECT ab.business_id FROM account_businesses ab WHERE ab.account_id = a.id) AS ids
           FROM accounts a WHERE a.id = $1 AND a.is_active`, [accId]);
        if (!acc) throw notFound('Compte');
        await db.query('SELECT account_set_businesses($1, $2::uuid[])', [accId, [...acc.ids, biz!.id]]);
        covered.add(acc.kind);
      }
      if (b.withDefaultAccounts) {
        const defs: [string, string, boolean, number][] = [['Caisse principale', 'cash', true, 1], ['Compte bancaire', 'bank', false, 2], ['CCP', 'ccp', false, 3]];
        for (const [name, kind, session, order] of defs.filter((d) => !covered.has(d[1]))) {
          await db.query(`INSERT INTO accounts (business_id, name, kind, requires_session, sort_order) VALUES ($1,$2,$3::account_kind,$4,$5)`,
            [biz!.id, name, kind, session, order]);
        }
      }
      return biz;
    });
    res.status(201).json(row);
  });

  r.patch('/businesses/:id', requireAdmin(), async (req, res) => {
    const b = bizBody.omit({ withDefaultAccounts: true }).partial().extend({ isActive: z.boolean().optional(), reason: zReason.optional() }).parse(req.body);
    const id = param(req, 'id');
    const row = await deps.db.tx(ctx(req, b.reason ?? 'Modification activité'), (db) => one(db,
      `UPDATE businesses SET code = coalesce($2, code), name = coalesce($3, name), activity = coalesce($4, activity),
         address = coalesce($5, address), phone = coalesce($6, phone), email = coalesce($7, email), nif = coalesce($8, nif),
         rc = coalesce($9, rc), color = coalesce($10, color), sort_order = coalesce($11, sort_order), is_active = coalesce($12, is_active)
       WHERE id = $1 RETURNING *`,
      [id, b.code ?? null, b.name ?? null, b.activity ?? null, b.address ?? null, b.phone ?? null, b.email ?? null,
        b.nif ?? null, b.rc ?? null, b.color ?? null, b.sortOrder ?? null, b.isActive ?? null]));
    if (!row) throw notFound('Activité');
    res.json(row);
  });

  // ------------------------------------------------------------------ logos (activité)
  r.get('/businesses/:id/logo', async (req, res) => {
    const row = await deps.db.tx(ctx(req), (db) => one<{ logo_path: string | null }>(db, 'SELECT logo_path FROM businesses WHERE id = $1', [param(req, 'id')]));
    if (!row?.logo_path) throw notFound('Logo');
    await sendStored(res, deps.dataDir, row.logo_path);
  });

  r.post('/businesses/:id/logo', requireAdmin(), up.single('file'), async (req, res) => {
    if (!req.file) throw new AppError(422, 'FILE_REQUIRED', 'Fichier « file » manquant');
    const id = param(req, 'id');
    const exists = await deps.db.tx(ctx(req), (db) => one(db, 'SELECT 1 FROM businesses WHERE id = $1', [id]));
    if (!exists) throw notFound('Activité');
    const s = await store(deps.dataDir, 'logos', req.file.buffer, ['png', 'jpg', 'svg', 'webp'], `${id}-`);
    const row = await deps.db.tx(ctx(req, 'Changement de logo'), (db) =>
      one(db, 'UPDATE businesses SET logo_path = $2 WHERE id = $1 RETURNING id, logo_path', [id, s.key]));
    res.json(row);
  });

  r.get('/businesses/:id/logo/history', requireAdmin(), async (req, res) => {
    res.json(await listFiles(deps.dataDir, 'logos', `${param(req, 'id')}-`));
  });

  r.post('/businesses/:id/logo/restore', requireAdmin(), async (req, res) => {
    const id = param(req, 'id');
    const { key } = z.object({ key: z.string() }).parse(req.body);
    const allowed = await listFiles(deps.dataDir, 'logos', `${id}-`);
    if (!allowed.includes(key)) throw notFound('Ancien logo');
    const row = await deps.db.tx(ctx(req, 'Retour à un logo précédent'), (db) =>
      one(db, 'UPDATE businesses SET logo_path = $2 WHERE id = $1 RETURNING id, logo_path', [id, key]));
    res.json(row);
  });

  // ------------------------------------------------------------------ accounts
  r.get('/businesses/:id/accounts', async (req, res) => {
    const id = param(req, 'id');
    const rows = await deps.db.tx(ctx(req), (db) => many(db,
      `SELECT a.id, a.business_id, a.name, a.kind, a.bank_name, a.account_number, a.requires_session, a.is_active, a.sort_order,
              a.opening_date,
              CASE WHEN account_perm(a.id, 'view_balances') THEN a.opening_balance END AS opening_balance,
              CASE WHEN account_perm(a.id, 'view_balances') THEN account_balance(a.id) END AS balance,
              (a.business_id = $1) AS owned,
              ARRAY(SELECT ab.business_id FROM account_businesses ab WHERE ab.account_id = a.id) AS business_ids,
              ARRAY(SELECT b.name FROM account_businesses ab JOIN businesses b ON b.id = ab.business_id
                    WHERE ab.account_id = a.id ORDER BY b.sort_order, b.name) AS business_names,
              (SELECT count(*) FROM account_businesses ab WHERE ab.account_id = a.id) > 1 AS shared
       FROM accounts a WHERE account_serves(a.id, $1) ORDER BY a.sort_order, a.name`, [id]));
    res.json(rows);
  });

  const accBody = z.object({
    name: z.string().trim().min(2).max(80),
    kind: z.enum(['cash', 'bank', 'ccp', 'other']),
    bankName: zOptText(80), accountNumber: zOptText(60),
    openingBalance: zMoneyOrZero.default('0'), openingDate: zDate.optional(),
    requiresSession: z.boolean().optional(), sortOrder: z.number().int().optional(),
    // activités qui utilisent ce compte (compte commun) ; l'activité propriétaire est toujours incluse
    businessIds: z.array(zId).max(50).optional(),
  });

  r.post('/businesses/:id/accounts', requireAdmin(), async (req, res) => {
    const b = accBody.parse(req.body);
    const row = await deps.db.tx(ctx(req, 'Création compte'), async (db) => {
      const a = await one<{ id: string }>(db,
        `INSERT INTO accounts (business_id, name, kind, bank_name, account_number, opening_balance, opening_date, requires_session, sort_order)
         VALUES ($1,$2,$3::account_kind,$4,$5,$6,coalesce($7::date, local_today()),coalesce($8, $3::account_kind = 'cash'),coalesce($9,0)) RETURNING *`,
        [param(req, 'id'), b.name, b.kind, b.bankName, b.accountNumber, b.openingBalance, b.openingDate ?? null,
          b.requiresSession ?? null, b.sortOrder ?? null]);
      if (b.businessIds) await db.query('SELECT account_set_businesses($1, $2::uuid[])', [a!.id, b.businessIds]);
      return a;
    });
    res.status(201).json(row);
  });

  r.patch('/accounts/:id', requireAdmin(), async (req, res) => {
    const b = accBody.partial().extend({ isActive: z.boolean().optional(), reason: zReason.optional() }).parse(req.body);
    const row = await deps.db.tx(ctx(req, b.reason ?? 'Modification compte'), async (db) => {
      if (b.businessIds) await db.query('SELECT account_set_businesses($1, $2::uuid[])', [param(req, 'id'), b.businessIds]);
      return one(db,
      `UPDATE accounts SET name = coalesce($2,name), bank_name = coalesce($3,bank_name), account_number = coalesce($4,account_number),
         opening_balance = coalesce($5::numeric,opening_balance), opening_date = coalesce($6::date,opening_date),
         requires_session = coalesce($7,requires_session), sort_order = coalesce($8,sort_order), is_active = coalesce($9,is_active),
         kind = coalesce($10::account_kind, kind)
       WHERE id = $1 RETURNING *`,
      [param(req, 'id'), b.name ?? null, b.bankName ?? null, b.accountNumber ?? null, b.openingBalance ?? null, b.openingDate ?? null,
        b.requiresSession ?? null, b.sortOrder ?? null, b.isActive ?? null, b.kind ?? null]);
    });
    if (!row) throw notFound('Compte');
    res.json(row);
  });

  // ------------------------------------------------------------------ categories
  // opType : absent = catégories des 5 types de base seulement (si type donné) ; 'any' = toutes ; uuid = d'un type personnalisé
  r.get('/businesses/:id/categories', async (req, res) => {
    const q = z.object({ type: z.enum(TXN_CAT_TYPES).optional(), all: z.coerce.boolean().optional(),
      opType: z.union([z.literal('any'), zId]).optional() }).parse(req.query);
    res.json(await deps.db.tx(ctx(req), (db) => many(db,
      `SELECT c.*, p.name AS parent_name, ot.name AS op_type_name,
              (SELECT count(*) FROM categories k WHERE k.parent_id = c.id)::int AS children
       FROM categories c LEFT JOIN categories p ON p.id = c.parent_id LEFT JOIN op_types ot ON ot.id = c.op_type_id
       WHERE c.business_id = $1 AND ($3 OR c.is_active)
         AND CASE WHEN $4::text = 'any' THEN true
                  WHEN $4::text IS NOT NULL THEN c.op_type_id = $4::uuid
                  ELSE ($2::txn_type IS NULL OR (c.txn_type = $2 AND c.op_type_id IS NULL)) END
       ORDER BY c.txn_type, c.op_type_id NULLS FIRST, coalesce(p.sort_order, c.sort_order), coalesce(p.name, c.name), c.parent_id NULLS FIRST, c.sort_order, c.name`,
      [param(req, 'id'), q.type ?? null, q.all ?? false, q.opType ?? null])));
  });

  const catBody = z.object({
    txnType: z.enum(TXN_CAT_TYPES), name: z.string().trim().min(2).max(80),
    icon: zOptText(40), color: zColor, sortOrder: z.number().int().optional(),
    parentId: zId.nullish(),                 // sous-catégorie d'une catégorie principale
    allBusinesses: z.boolean().optional(),   // créer la même catégorie dans toutes les activités gérables
    opTypeId: zId.nullish(),                 // 1.2.0 : catégorie d'un type d'opération personnalisé
  });
  r.post('/businesses/:id/categories', async (req, res) => {
    const b = catBody.parse(req.body);
    const bizId = param(req, 'id');
    const rows = await deps.db.tx(ctx(req, b.allBusinesses ? 'Catégorie ajoutée à toutes les activités' : null), async (db) => {
      const ot = b.opTypeId ?? null;
      if (ot) {   // la base (revenu / dépense) suit le sens du type
        const t = await one<{ base: string }>(db, 'SELECT op_type_base(direction)::text AS base FROM op_types WHERE id = $1', [ot]);
        if (!t) throw notFound('Type d\'opération');
        b.txnType = t.base as typeof b.txnType;
      }
      const parentName = b.parentId ? (await one<{ name: string }>(db, 'SELECT name FROM categories WHERE id = $1', [b.parentId]))?.name : null;
      if (b.parentId && !parentName) throw notFound('Catégorie principale');
      const targets = b.allBusinesses
        ? (await many<{ id: string }>(db, "SELECT id FROM businesses WHERE is_active AND has_perm(id, 'manage_categories') ORDER BY sort_order"))
          .map((x) => x.id)
        : [bizId];
      if (!targets.includes(bizId) && !b.allBusinesses) targets.push(bizId);
      const out = [];
      for (const target of targets) {
        // même catégorie principale (par nom) dans chaque activité ; créée si absente
        // activité demandée : la catégorie principale choisie telle quelle (le trigger CP046 valide les niveaux)
        let parentId: string | null = target === bizId ? (b.parentId ?? null) : null;
        if (parentName && target !== bizId) {
          parentId = (await one<{ id: string }>(db,
            'SELECT id FROM categories WHERE business_id = $1 AND txn_type = $2 AND name = $3 AND parent_id IS NULL AND op_type_id IS NOT DISTINCT FROM $4::uuid',
            [target, b.txnType, parentName, ot]))?.id
            ?? (await one<{ id: string }>(db,
              'INSERT INTO categories (business_id, txn_type, name, op_type_id) VALUES ($1,$2,$3,$4) RETURNING id', [target, b.txnType, parentName, ot]))?.id ?? null;
        }
        const exists = await one(db, 'SELECT id FROM categories WHERE business_id = $1 AND txn_type = $2 AND name = $3 AND op_type_id IS NOT DISTINCT FROM $4::uuid',
          [target, b.txnType, b.name, ot]);
        if (exists && target !== bizId) continue;      // déjà présente dans une autre activité : ignorée
        const row = await one(db,
          `INSERT INTO categories (business_id, txn_type, name, icon, color, sort_order, parent_id, op_type_id)
           VALUES ($1,$2,$3,$4,$5,coalesce($6,0),$7,$8) RETURNING *`,
          [target, b.txnType, b.name, b.icon, b.color ?? null, b.sortOrder ?? null, parentId, ot]);
        if (!row) throw new AppError(403, 'CP003', 'Permission refusée (manage_categories)');
        out.push(row);
      }
      return out;
    });
    res.status(201).json(b.allBusinesses ? rows : rows[0]);
  });
  r.patch('/categories/:id', async (req, res) => {
    const b = catBody.omit({ txnType: true, allBusinesses: true, opTypeId: true }).partial().extend({ isActive: z.boolean().optional() }).parse(req.body);
    const row = await deps.db.tx(ctx(req), (db) => one(db,
      `UPDATE categories SET name = coalesce($2,name), icon = coalesce($3,icon), color = coalesce($4,color),
         sort_order = coalesce($5,sort_order), is_active = coalesce($6,is_active),
         parent_id = CASE WHEN $7 THEN $8::uuid ELSE parent_id END WHERE id = $1 RETURNING *`,
      [param(req, 'id'), b.name ?? null, b.icon ?? null, b.color ?? null, b.sortOrder ?? null, b.isActive ?? null,
        'parentId' in b, b.parentId ?? null]));
    if (!row) throw notFound('Catégorie');
    res.json(row);
  });

  // ------------------------------------------------------------------ types d'opération (1.2.0) — création / modification : admin
  const opTypeBody = z.object({
    name: z.string().trim().min(2).max(60), direction: z.enum(['in', 'out']), color: zColor, icon: zOptText(40),
    sortOrder: z.number().int().optional(),
  });
  r.get('/op-types', async (req, res) => {
    const q = z.object({ all: z.coerce.boolean().optional() }).parse(req.query);
    res.json(await deps.db.tx(ctx(req), (db) => many(db,
      `SELECT o.*, CASE WHEN o.direction = 1 THEN 'in' ELSE 'out' END AS dir, op_type_base(o.direction) AS base_type,
              (SELECT count(*) FROM transactions t WHERE t.op_type_id = o.id)::int AS used
       FROM op_types o WHERE $1 OR o.is_active ORDER BY o.sort_order, o.name`, [q.all ?? false])));
  });
  r.post('/op-types', requireAdmin(), async (req, res) => {
    const b = opTypeBody.parse(req.body);
    const row = await deps.db.tx(ctx(req, `Nouveau type d'opération : ${b.name}`), (db) => one(db,
      `INSERT INTO op_types (name, direction, color, icon, sort_order) VALUES ($1,$2,$3,$4,coalesce($5,0)) RETURNING *`,
      [b.name, b.direction === 'in' ? 1 : -1, b.color ?? null, b.icon ?? null, b.sortOrder ?? null]));
    res.status(201).json(row);
  });
  r.patch('/op-types/:id', requireAdmin(), async (req, res) => {
    const b = opTypeBody.omit({ direction: true }).partial().extend({ isActive: z.boolean().optional() }).parse(req.body);
    const row = await deps.db.tx(ctx(req), (db) => one(db,
      `UPDATE op_types SET name = coalesce($2,name), color = coalesce($3,color), icon = coalesce($4,icon),
         sort_order = coalesce($5,sort_order), is_active = coalesce($6,is_active) WHERE id = $1 RETURNING *`,
      [param(req, 'id'), b.name ?? null, b.color ?? null, b.icon ?? null, b.sortOrder ?? null, b.isActive ?? null]));
    if (!row) throw notFound('Type d\'opération');
    res.json(row);
  });

  // ------------------------------------------------------------------ suppliers
  r.get('/businesses/:id/suppliers', async (req, res) => {
    const q = z.object({ q: z.string().trim().max(100).optional() }).parse(req.query);
    res.json(await deps.db.tx(ctx(req), (db) => many(db,
      `SELECT * FROM suppliers WHERE business_id = $1 AND is_active AND ($2::text IS NULL OR name ILIKE '%' || $2 || '%')
       ORDER BY name LIMIT 200`, [param(req, 'id'), q.q ?? null])));
  });
  const supBody = z.object({ name: z.string().trim().min(2).max(120), phone: zOptText(30), address: zOptText(300), notes: zOptText(500) });
  r.post('/businesses/:id/suppliers', async (req, res) => {
    const b = supBody.parse(req.body);
    const row = await deps.db.tx(ctx(req), (db) => one(db,
      'INSERT INTO suppliers (business_id, name, phone, address, notes) VALUES ($1,$2,$3,$4,$5) RETURNING *',
      [param(req, 'id'), b.name, b.phone, b.address, b.notes]));
    res.status(201).json(row);
  });
  r.patch('/suppliers/:id', async (req, res) => {
    const b = supBody.partial().extend({ isActive: z.boolean().optional() }).parse(req.body);
    const row = await deps.db.tx(ctx(req), (db) => one(db,
      `UPDATE suppliers SET name = coalesce($2,name), phone = coalesce($3,phone), address = coalesce($4,address),
         notes = coalesce($5,notes), is_active = coalesce($6,is_active) WHERE id = $1 RETURNING *`,
      [param(req, 'id'), b.name ?? null, b.phone ?? null, b.address ?? null, b.notes ?? null, b.isActive ?? null]));
    if (!row) throw notFound('Fournisseur');
    res.json(row);
  });

  // ------------------------------------------------------------------ payment methods
  r.get('/payment-methods', async (req, res) => {
    res.json(await deps.db.tx(ctx(req), (db) => many(db, 'SELECT * FROM payment_methods WHERE is_active ORDER BY business_id NULLS FIRST, code')));
  });

  return r;
}
