-- =====================================================================
-- CashPro — 07 : historique visible des modifications
-- Rien n'est jamais effacé : une opération modifiée garde ses anciennes valeurs (journal),
-- une opération corrigée reste visible, barrée, liée à sa nouvelle version.
-- Script REJOUABLE : exécuté à chaque installation / mise à jour (données conservées).
-- =====================================================================
SET search_path = cashpro, public;

-- Visibilité d'une opération pour l'utilisateur courant (mêmes règles que la RLS)
CREATE OR REPLACE FUNCTION txn_visible(p_id uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = cashpro, public AS $$
  SELECT EXISTS (SELECT 1 FROM transactions t WHERE t.id = p_id
    AND has_access(t.business_id) AND (t.created_by = current_uid() OR has_perm(t.business_id, 'view_all_transactions')))
$$;

-- Dernière modification (champs non financiers) : date, auteur, nombre
CREATE OR REPLACE FUNCTION txn_edit_info(p_id uuid)
RETURNS TABLE (edited_at timestamptz, edited_by_name text, edit_count int)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = cashpro, public AS $$
  SELECT max(l.occurred_at), (array_agg(u.full_name ORDER BY l.occurred_at DESC))[1], count(*)::int
  FROM audit_logs l LEFT JOIN users u ON u.id = l.user_id
  WHERE l.table_name = 'transactions' AND l.record_id = p_id::text AND l.action = 'update'
    AND coalesce(l.changed, '{}') && ARRAY['description','reference','notes','category_id','payment_method_id','supplier_id']
    AND txn_visible(p_id)
  HAVING count(*) > 0
$$;

-- Historique complet d'une opération (anciennes et nouvelles valeurs, auteur), pour toute personne qui voit l'opération
CREATE OR REPLACE FUNCTION txn_history(p_id uuid)
RETURNS TABLE (id bigint, occurred_at timestamptz, user_name text, action text, changed text[], old_values jsonb, new_values jsonb, reason text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = cashpro, public AS $$
  SELECT l.id, l.occurred_at, u.full_name, l.action, l.changed, l.old_values, l.new_values, l.reason
  FROM audit_logs l LEFT JOIN users u ON u.id = l.user_id
  WHERE l.table_name = 'transactions' AND l.record_id = p_id::text AND txn_visible(p_id)
  ORDER BY l.occurred_at, l.id
$$;

-- Grand livre : colonnes ajoutées EN FIN (CREATE OR REPLACE VIEW l'exige)
-- (recréée à chaque mise à jour : 09_shared.sql y ajoute ensuite ses colonnes)
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
       -- 07 : qui a annulé, version de remplacement, opération d'origine, dernière modification
       t.cancelled_by, uc.full_name AS cancelled_by_name,
       rep.id AS replaced_by_id, rep.ref_no AS replaced_by_ref, rep.created_at AS replaced_at,
       orig.ref_no AS corrects_ref,
       ed.edited_at, ed.edited_by_name, coalesce(ed.edit_count, 0) AS edit_count
FROM transactions t
JOIN businesses b ON b.id = t.business_id
JOIN accounts a ON a.id = t.account_id
LEFT JOIN categories c ON c.id = t.category_id
LEFT JOIN payment_methods pm ON pm.id = t.payment_method_id
LEFT JOIN suppliers s ON s.id = t.supplier_id
LEFT JOIN employees e ON e.id = t.employee_id
LEFT JOIN transfers tr ON tr.id = t.transfer_id
LEFT JOIN users u ON u.id = t.created_by
LEFT JOIN users uc ON uc.id = t.cancelled_by
LEFT JOIN LATERAL (SELECT r.id, r.ref_no, r.created_at FROM transactions r WHERE r.corrects_id = t.id ORDER BY r.created_at DESC LIMIT 1) rep ON true
LEFT JOIN transactions orig ON orig.id = t.corrects_id
LEFT JOIN LATERAL txn_edit_info(t.id) ed ON true;

GRANT SELECT ON v_ledger TO cashpro_app, cashpro_backup;
GRANT EXECUTE ON FUNCTION txn_visible(uuid), txn_edit_info(uuid), txn_history(uuid) TO cashpro_app;

-- Modification complète d'une opération simple : l'originale est annulée (gardée, barrée)
-- et la nouvelle version reprend toutes les valeurs, modifiées ou non. NULL = valeur inchangée.
CREATE OR REPLACE FUNCTION correct_transaction_full(
  p_id uuid, p_reason text,
  p_amount numeric DEFAULT NULL, p_date timestamptz DEFAULT NULL, p_account uuid DEFAULT NULL, p_category uuid DEFAULT NULL,
  p_supplier uuid DEFAULT NULL, p_payment_method uuid DEFAULT NULL,
  p_description text DEFAULT NULL, p_reference text DEFAULT NULL, p_notes text DEFAULT NULL
) RETURNS uuid
LANGUAGE plpgsql AS $$
DECLARE o cashpro.transactions; v_new uuid;
BEGIN
  SELECT * INTO o FROM cashpro.transactions WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'CP050: opération introuvable'; END IF;
  IF o.transaction_type NOT IN ('income','expense','purchase','deposit','withdrawal') OR o.cheque_id IS NOT NULL THEN
    RAISE EXCEPTION 'CP051: seules les opérations simples se corrigent ainsi';
  END IF;
  PERFORM cashpro.require_perm(o.business_id, 'cancel');
  PERFORM cashpro.cancel_transaction(p_id, 'Correction : ' || p_reason);
  PERFORM cashpro.require_perm(o.business_id, CASE o.transaction_type
      WHEN 'income' THEN 'add_income' WHEN 'expense' THEN 'add_expense'
      WHEN 'purchase' THEN 'add_purchase' ELSE 'deposit_withdrawal' END);
  PERFORM cashpro.set_internal(true);
  INSERT INTO cashpro.transactions (business_id, account_id, category_id, transaction_type, amount, transaction_date,
    payment_method_id, supplier_id, description, reference, notes, corrects_id, created_by)
  VALUES (o.business_id, coalesce(p_account, o.account_id), coalesce(p_category, o.category_id), o.transaction_type,
    coalesce(p_amount, o.amount), coalesce(p_date, o.transaction_date),
    coalesce(p_payment_method, o.payment_method_id), coalesce(p_supplier, o.supplier_id),
    coalesce(p_description, o.description), coalesce(p_reference, o.reference), coalesce(p_notes, o.notes),
    o.id, cashpro.require_uid())
  RETURNING id INTO v_new;
  PERFORM cashpro.set_internal(false);
  RETURN v_new;
END $$;
GRANT EXECUTE ON FUNCTION correct_transaction_full(uuid, text, numeric, timestamptz, uuid, uuid, uuid, uuid, text, text, text) TO cashpro_app;
