-- =====================================================================
-- CashPro 1.2.0 — 10_types.sql  (rejouable : exécuté à chaque installation / mise à jour)
--  1. Types d'opération créés par l'administrateur (أنواع عمليات جديدة)
--     ex. « Transport », « Vente à crédit » : un nom + un sens (entrée / sortie).
--     En base, une opération d'un type personnalisé reste un income (entrée) ou un expense (sortie) :
--     soldes, clôtures, rapports et permissions (add_income / add_expense) restent justes.
--     Le type est porté par la catégorie (categories.op_type_id) et recopié sur l'opération.
--  2. Alertes d'activité pour les administrateurs (🔔) : ajouts / modifications / annulations faits
--     par les autres utilisateurs, avec « vu / تمّت المراجعة » par administrateur.
-- =====================================================================
SET search_path = cashpro, public;

-- ---------------------------------------------------------------------
-- 1. Types d'opération
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS op_types (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 60),
  direction   smallint NOT NULL CHECK (direction IN (1, -1)),   -- 1 = entrée (comme un revenu), -1 = sortie (comme une dépense)
  color       text,
  icon        text,
  is_active   boolean NOT NULL DEFAULT true,
  sort_order  int NOT NULL DEFAULT 0,
  created_by  uuid REFERENCES users(id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS op_types_name_uq ON op_types (lower(btrim(name)));

-- base de l'opération selon le sens
CREATE OR REPLACE FUNCTION op_type_base(p_direction smallint) RETURNS txn_type
LANGUAGE sql IMMUTABLE AS $$ SELECT CASE WHEN p_direction = 1 THEN 'income'::cashpro.txn_type ELSE 'expense'::cashpro.txn_type END $$;

CREATE OR REPLACE FUNCTION trg_op_type_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = cashpro, public AS $$
BEGIN
  IF NOT is_admin() THEN
    RAISE EXCEPTION 'CP004: réservé à l''administrateur' USING ERRCODE = 'insufficient_privilege';
  END IF;
  NEW.name := btrim(NEW.name);
  IF TG_OP = 'INSERT' THEN
    NEW.created_by := current_uid();
  ELSIF NEW.direction <> OLD.direction THEN
    RAISE EXCEPTION 'CP100: le sens (entrée / sortie) d''un type ne change pas — créez un autre type' USING ERRCODE = 'check_violation';
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS op_types_guard ON op_types;
CREATE TRIGGER op_types_guard BEFORE INSERT OR UPDATE ON op_types FOR EACH ROW EXECUTE FUNCTION trg_op_type_guard();
DROP TRIGGER IF EXISTS op_types_audit ON op_types;
CREATE TRIGGER op_types_audit AFTER INSERT OR UPDATE ON op_types FOR EACH ROW EXECUTE FUNCTION trg_audit();

ALTER TABLE op_types ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS op_types_select ON op_types;
DROP POLICY IF EXISTS op_types_insert ON op_types;
DROP POLICY IF EXISTS op_types_update ON op_types;
CREATE POLICY op_types_select ON op_types FOR SELECT USING (current_uid() IS NOT NULL);
CREATE POLICY op_types_insert ON op_types FOR INSERT WITH CHECK (is_admin());
CREATE POLICY op_types_update ON op_types FOR UPDATE USING (is_admin()) WITH CHECK (is_admin());

-- catégories et opérations portent le type
ALTER TABLE categories   ADD COLUMN IF NOT EXISTS op_type_id uuid REFERENCES op_types(id);
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS op_type_id uuid REFERENCES op_types(id);
CREATE INDEX IF NOT EXISTS categories_op_type_idx   ON categories (op_type_id) WHERE op_type_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS transactions_op_type_idx ON transactions (op_type_id, local_date) WHERE op_type_id IS NOT NULL;

-- même nom de catégorie permis dans deux types différents (ex. « Divers » en dépense et en « Transport »)
ALTER TABLE categories DROP CONSTRAINT IF EXISTS categories_business_id_txn_type_name_key;
CREATE UNIQUE INDEX IF NOT EXISTS categories_name_uq
  ON categories (business_id, txn_type, coalesce(op_type_id, '00000000-0000-0000-0000-000000000000'::uuid), name);

-- Catégorie d'un type personnalisé : base = sens du type ; sous-catégorie = même type que sa principale
CREATE OR REPLACE FUNCTION trg_category_op_type() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = cashpro, public AS $$
DECLARE v_ot op_types; v_parent categories;
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.op_type_id IS DISTINCT FROM OLD.op_type_id
     AND EXISTS (SELECT 1 FROM transactions t WHERE t.category_id = NEW.id) THEN
    RAISE EXCEPTION 'CP102: catégorie déjà utilisée : son type ne change plus' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.op_type_id IS NOT NULL THEN
    SELECT * INTO v_ot FROM op_types WHERE id = NEW.op_type_id;
    IF NEW.txn_type <> op_type_base(v_ot.direction) THEN
      RAISE EXCEPTION 'CP101: la catégorie doit suivre le sens du type « % »', v_ot.name USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF NEW.parent_id IS NOT NULL THEN
    SELECT * INTO v_parent FROM categories WHERE id = NEW.parent_id;
    IF v_parent.op_type_id IS DISTINCT FROM NEW.op_type_id THEN
      RAISE EXCEPTION 'CP046: la catégorie principale doit être du même type' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS categories_op_type ON categories;
CREATE TRIGGER categories_op_type BEFORE INSERT OR UPDATE OF op_type_id, txn_type, parent_id ON categories
FOR EACH ROW EXECUTE FUNCTION trg_category_op_type();

-- Opération : le type vient de la catégorie (jamais saisi à la main) ; il ne change pas après coup
CREATE OR REPLACE FUNCTION trg_txn_op_type() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = cashpro, public AS $$
DECLARE v_ot uuid; v_active boolean;
BEGIN
  SELECT c.op_type_id INTO v_ot FROM categories c WHERE c.id = NEW.category_id;
  IF TG_OP = 'INSERT' THEN
    NEW.op_type_id := v_ot;
    IF v_ot IS NOT NULL THEN
      SELECT is_active INTO v_active FROM op_types WHERE id = v_ot;
      IF NOT v_active THEN
        RAISE EXCEPTION 'CP103: ce type d''opération est désactivé' USING ERRCODE = 'check_violation';
      END IF;
    END IF;
  ELSE
    IF NEW.category_id IS DISTINCT FROM OLD.category_id AND v_ot IS DISTINCT FROM OLD.op_type_id THEN
      RAISE EXCEPTION 'CP104: changer de type d''opération = correction (annulation + nouvelle opération)' USING ERRCODE = 'check_violation';
    END IF;
    NEW.op_type_id := OLD.op_type_id;
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS txn_op_type ON transactions;
CREATE TRIGGER txn_op_type BEFORE INSERT OR UPDATE ON transactions FOR EACH ROW EXECUTE FUNCTION trg_txn_op_type();

-- ---------------------------------------------------------------------
-- 2. Grand livre : + type personnalisé (colonnes ajoutées en fin)
-- ---------------------------------------------------------------------
DROP VIEW IF EXISTS v_ledger;
CREATE VIEW v_ledger WITH (security_invoker = true) AS
SELECT t.id, t.ref_no, t.business_id, b.name AS business_name, t.account_id, a.name AS account_name, a.kind AS account_kind,
       t.transaction_type, t.direction, t.amount, t.signed_amount, t.transaction_date, t.local_date,
       t.category_id, c.name AS category_name, c.color AS category_color, c.icon AS category_icon,
       t.payment_method_id, pm.code AS payment_method_code,
       t.supplier_id, s.name AS supplier_name, t.employee_id, e.full_name AS employee_name, t.payroll_period,
       t.transfer_id, tr.kind AS transfer_kind, t.cheque_id, t.reconciliation_id, t.corrects_id,
       t.description, t.reference, t.notes, t.status, t.cancel_reason, t.cancelled_at,
       t.created_by, u.full_name AS created_by_name, t.created_at, t.updated_at,
       CASE WHEN t.status = 'validated' THEN
         a.opening_balance + sum(t.signed_amount) FILTER (WHERE t.status = 'validated')
           OVER (PARTITION BY t.account_id ORDER BY t.transaction_date, t.ref_no ROWS UNBOUNDED PRECEDING)
       END AS running_balance,
       (SELECT count(*) FROM transaction_attachments x WHERE x.transaction_id = t.id AND x.is_active) AS attachments_count,
       t.cancelled_by, uc.full_name AS cancelled_by_name,
       rep.id AS replaced_by_id, rep.ref_no AS replaced_by_ref, rep.created_at AS replaced_at,
       orig.ref_no AS corrects_ref,
       ed.edited_at, ed.edited_by_name, coalesce(ed.edit_count, 0) AS edit_count,
       t.split_id, c.parent_id AS category_parent_id, pc.name AS category_parent_name,
       (SELECT count(*) FROM account_businesses ab WHERE ab.account_id = t.account_id) > 1 AS account_shared,
       -- 10 : type personnalisé
       t.op_type_id, ot.name AS op_type_name, ot.color AS op_type_color
FROM transactions t
JOIN businesses b ON b.id = t.business_id
JOIN accounts a ON a.id = t.account_id
LEFT JOIN categories c ON c.id = t.category_id
LEFT JOIN categories pc ON pc.id = c.parent_id
LEFT JOIN op_types ot ON ot.id = t.op_type_id
LEFT JOIN payment_methods pm ON pm.id = t.payment_method_id
LEFT JOIN suppliers s ON s.id = t.supplier_id
LEFT JOIN employees e ON e.id = t.employee_id
LEFT JOIN transfers tr ON tr.id = t.transfer_id
LEFT JOIN users u ON u.id = t.created_by
LEFT JOIN users uc ON uc.id = t.cancelled_by
LEFT JOIN LATERAL (SELECT r.id, r.ref_no, r.created_at FROM transactions r WHERE r.corrects_id = t.id ORDER BY r.created_at DESC LIMIT 1) rep ON true
LEFT JOIN transactions orig ON orig.id = t.corrects_id
LEFT JOIN LATERAL txn_edit_info(t.id) ed ON true;

-- ---------------------------------------------------------------------
-- 3. Alertes d'activité (🔔) pour les administrateurs
-- ---------------------------------------------------------------------
INSERT INTO app_settings (key, value)
VALUES ('activity_alerts', '{"events": "all", "min_amount": null, "include_admins": false}')
ON CONFLICT (key) DO NOTHING;

CREATE TABLE IF NOT EXISTS audit_reviews (
  audit_id    bigint NOT NULL REFERENCES audit_logs(id),
  user_id     uuid NOT NULL REFERENCES users(id),
  reviewed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (audit_id, user_id)
);
ALTER TABLE audit_reviews ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS audit_reviews_own ON audit_reviews;
CREATE POLICY audit_reviews_own ON audit_reviews USING (user_id = current_uid()) WITH CHECK (user_id = current_uid());

-- Toutes les alertes visibles par l'administrateur connecté (ses propres actions exclues)
CREATE OR REPLACE FUNCTION activity_alerts()
RETURNS TABLE (id bigint, occurred_at timestamptz, action text, user_name text, business_id uuid, business_name text,
               table_name text, record_id text, ref_no bigint, transaction_type txn_type, op_type_name text,
               amount numeric, category_name text, changed text[], old_values jsonb, new_values jsonb, reason text,
               reviewed boolean)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = cashpro, public AS $$
  WITH cfg AS (SELECT coalesce((SELECT value FROM app_settings WHERE key = 'activity_alerts'), '{}'::jsonb) AS v)
  SELECT l.id, l.occurred_at, l.action, u.full_name, l.business_id, b.name, l.table_name, l.record_id,
         t.ref_no, t.transaction_type, ot.name,
         coalesce(t.amount, tf.amount, ch.amount, (l.new_values ->> 'amount')::numeric),
         c.name, l.changed, l.old_values, l.new_values, l.reason,
         EXISTS (SELECT 1 FROM audit_reviews r WHERE r.audit_id = l.id AND r.user_id = current_uid())
  FROM audit_logs l
  CROSS JOIN cfg
  JOIN users u ON u.id = l.user_id
  LEFT JOIN businesses b ON b.id = l.business_id
  LEFT JOIN transactions t ON l.table_name = 'transactions' AND t.id::text = l.record_id
  LEFT JOIN op_types ot ON ot.id = t.op_type_id
  LEFT JOIN categories c ON c.id = t.category_id
  LEFT JOIN transfers tf ON l.table_name = 'transfers' AND tf.id::text = l.record_id
  LEFT JOIN cheques ch ON l.table_name = 'cheques' AND ch.id::text = l.record_id
  WHERE is_admin()
    AND l.user_id <> current_uid()
    AND (u.role <> 'admin' OR coalesce((cfg.v ->> 'include_admins')::boolean, false))
    AND l.table_name IN ('transactions', 'transfers', 'cheques', 'cash_sessions', 'payroll_items')
    AND l.action IN ('create', 'update', 'cancel', 'close', 'reopen')
    -- une opération créée par une fonction métier (transfert, chèque, paie) est signalée une seule fois, via son objet
    AND NOT (l.table_name = 'transactions' AND l.action = 'create'
             AND (t.transfer_id IS NOT NULL OR t.cheque_id IS NOT NULL OR t.reconciliation_id IS NOT NULL OR t.employee_id IS NOT NULL))
    AND (coalesce(cfg.v ->> 'events', 'all') <> 'changes' OR l.action <> 'create')
    AND (l.action <> 'create' OR nullif(cfg.v ->> 'min_amount', '') IS NULL
         OR coalesce(t.amount, tf.amount, ch.amount, 0) >= (cfg.v ->> 'min_amount')::numeric)
$$;

CREATE OR REPLACE FUNCTION activity_alerts_unread() RETURNS int
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = cashpro, public AS $$
  SELECT count(*)::int FROM activity_alerts() a WHERE NOT a.reviewed
$$;

-- « تمّت المراجعة » : des alertes précises, ou toutes (p_ids NULL)
CREATE OR REPLACE FUNCTION activity_alerts_mark(p_ids bigint[] DEFAULT NULL) RETURNS int
LANGUAGE plpgsql SECURITY DEFINER SET search_path = cashpro, public AS $$
DECLARE n int;
BEGIN
  IF NOT is_admin() THEN
    RAISE EXCEPTION 'CP004: réservé à l''administrateur' USING ERRCODE = 'insufficient_privilege';
  END IF;
  INSERT INTO audit_reviews (audit_id, user_id)
  SELECT a.id, current_uid() FROM activity_alerts() a
  WHERE NOT a.reviewed AND (p_ids IS NULL OR a.id = ANY (p_ids))
  ON CONFLICT DO NOTHING;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END $$;

-- ---------------------------------------------------------------------
-- 4. Droits
-- ---------------------------------------------------------------------
GRANT SELECT, INSERT, UPDATE ON op_types TO cashpro_app;
GRANT SELECT ON op_types, audit_reviews TO cashpro_backup;
GRANT SELECT ON v_ledger TO cashpro_app, cashpro_backup;
REVOKE EXECUTE ON FUNCTION activity_alerts(), activity_alerts_unread(), activity_alerts_mark(bigint[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION op_type_base(smallint), activity_alerts(), activity_alerts_unread(), activity_alerts_mark(bigint[]) TO cashpro_app;
