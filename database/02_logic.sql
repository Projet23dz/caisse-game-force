-- =====================================================================
-- CashPro — 02_logic.sql : contexte utilisateur, permissions,
-- règles métier (triggers) et opérations atomiques (fonctions)
-- =====================================================================
SET search_path = cashpro, public;


-- =====================================================================
-- 1. Contexte : l'API exécute, au début de chaque transaction SQL :
--    SELECT set_config('cashpro.user_id', '<uuid>', true);
--    SELECT set_config('cashpro.reason', '<motif>', true);   -- si modification
-- =====================================================================
CREATE FUNCTION current_uid() RETURNS uuid
LANGUAGE sql STABLE AS $$
  SELECT nullif(current_setting('cashpro.user_id', true), '')::uuid
$$;

CREATE FUNCTION require_uid() RETURNS uuid
LANGUAGE plpgsql STABLE AS $$
DECLARE v uuid := cashpro.current_uid();
BEGIN
  IF v IS NULL THEN
    RAISE EXCEPTION 'CP001: utilisateur non identifié' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM cashpro.users WHERE id = v AND is_active) THEN
    RAISE EXCEPTION 'CP002: utilisateur inactif ou inconnu' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN v;
END $$;

CREATE FUNCTION current_reason() RETURNS text
LANGUAGE sql STABLE AS $$
  SELECT nullif(current_setting('cashpro.reason', true), '')
$$;

-- Drapeau interne : seules les fonctions métier l'activent
CREATE FUNCTION internal_on() RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT coalesce(current_setting('cashpro.internal', true), '') = 'on'
$$;

CREATE FUNCTION set_internal(p boolean) RETURNS void
LANGUAGE sql AS $$
  SELECT set_config('cashpro.internal', CASE WHEN p THEN 'on' ELSE 'off' END, true)
$$;

CREATE FUNCTION is_admin(p_uid uuid DEFAULT cashpro.current_uid()) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = cashpro, public AS $$
  SELECT EXISTS (SELECT 1 FROM users WHERE id = p_uid AND role = 'admin' AND is_active)
$$;

CREATE FUNCTION has_access(p_business uuid, p_uid uuid DEFAULT cashpro.current_uid()) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = cashpro, public AS $$
  SELECT is_admin(p_uid) OR EXISTS (
    SELECT 1 FROM business_users bu JOIN users u ON u.id = bu.user_id
    WHERE bu.business_id = p_business AND bu.user_id = p_uid AND bu.is_active AND u.is_active)
$$;

CREATE FUNCTION has_perm(p_business uuid, p_perm text, p_uid uuid DEFAULT cashpro.current_uid()) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = cashpro, public AS $$
  SELECT is_admin(p_uid) OR EXISTS (
    SELECT 1 FROM business_users bu JOIN users u ON u.id = bu.user_id
    WHERE bu.business_id = p_business AND bu.user_id = p_uid AND bu.is_active AND u.is_active
      AND coalesce((bu.permissions ->> p_perm)::boolean, false))
$$;

CREATE FUNCTION require_perm(p_business uuid, p_perm text) RETURNS void
LANGUAGE plpgsql STABLE AS $$
BEGIN
  IF NOT cashpro.has_perm(p_business, p_perm) THEN
    RAISE EXCEPTION 'CP003: permission refusée (%)', p_perm USING ERRCODE = 'insufficient_privilege';
  END IF;
END $$;

CREATE FUNCTION require_admin() RETURNS void
LANGUAGE plpgsql STABLE AS $$
BEGIN
  IF NOT cashpro.is_admin() THEN
    RAISE EXCEPTION 'CP004: réservé à l''administrateur' USING ERRCODE = 'insufficient_privilege';
  END IF;
END $$;

-- Permissions par défaut (modifiables ensuite case par case par l'admin)
CREATE FUNCTION default_permissions(p user_profile) RETURNS jsonb
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE p
    WHEN 'employee' THEN jsonb_build_object(
      'add_income', true, 'add_expense', true, 'add_purchase', false,
      'deposit_withdrawal', false, 'transfer', false, 'cheques', false,
      'payroll', false, 'edit_own', true, 'edit_any', false, 'cancel', false,
      'view_balances', false, 'view_all_transactions', false,
      'cash_session', true, 'adjustment', false, 'view_reports', false,
      'export', false, 'view_audit', false, 'manage_categories', false,
      'manage_suppliers', false, 'manage_employees', false)
    ELSE jsonb_build_object(
      'add_income', true, 'add_expense', true, 'add_purchase', true,
      'deposit_withdrawal', true, 'transfer', true, 'cheques', true,
      'payroll', true, 'edit_own', true, 'edit_any', true, 'cancel', true,
      'view_balances', true, 'view_all_transactions', true,
      'cash_session', true, 'adjustment', true, 'view_reports', true,
      'export', true, 'view_audit', true, 'manage_categories', false,
      'manage_suppliers', true, 'manage_employees', false)
  END
$$;

CREATE FUNCTION local_today() RETURNS date
LANGUAGE sql STABLE AS $$ SELECT (timezone('Africa/Algiers', now()))::date $$;

-- Fin d'une journée locale (23:59:59 Africa/Algiers)
CREATE FUNCTION end_of_local_day(d date) RETURNS timestamptz
LANGUAGE sql IMMUTABLE AS $$
  SELECT ((d + 1)::timestamp AT TIME ZONE 'Africa/Algiers') - interval '1 second'
$$;

-- =====================================================================
-- 2. Soldes
-- =====================================================================
-- Solde à la fin d'une date locale (NULL = aujourd'hui et futur inclus)
CREATE FUNCTION account_balance(p_account uuid, p_at date DEFAULT NULL) RETURNS numeric
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = cashpro, public AS $$
  SELECT a.opening_balance + coalesce((
    SELECT sum(t.signed_amount) FROM transactions t
    WHERE t.account_id = a.id AND t.status = 'validated'
      AND (p_at IS NULL OR t.local_date <= p_at)), 0)
  FROM accounts a WHERE a.id = p_account
$$;

-- Solde à un instant précis
CREATE FUNCTION account_balance_at(p_account uuid, p_ts timestamptz) RETURNS numeric
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = cashpro, public AS $$
  SELECT a.opening_balance + coalesce((
    SELECT sum(t.signed_amount) FROM transactions t
    WHERE t.account_id = a.id AND t.status = 'validated' AND t.transaction_date <= p_ts), 0)
  FROM accounts a WHERE a.id = p_account
$$;

-- =====================================================================
-- 3. Protection des journées clôturées
-- =====================================================================
CREATE FUNCTION assert_day_open(p_account uuid, p_date date) RETURNS void
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = cashpro, public AS $$
DECLARE s record;
BEGIN
  SELECT session_date, status INTO s FROM cash_sessions
  WHERE account_id = p_account AND session_date >= p_date
    AND status IN ('closed','pending_review')
  ORDER BY session_date LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION 'CP010: la journée du % est clôturée pour ce compte (aucune opération possible au % ou avant). Réouverture administrative requise.',
      s.session_date, s.session_date USING ERRCODE = 'check_violation';
  END IF;
END $$;

-- =====================================================================
-- 4. Triggers sur transactions
-- =====================================================================
CREATE FUNCTION trg_txn_before_insert() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = cashpro, public AS $$
DECLARE
  v_uid uuid := require_uid();
  v_acc record;
  v_cat record;
  v_bu  record;
  v_perm text;
  v_allow_neg boolean;
BEGIN
  NEW.created_by := v_uid;
  NEW.created_at := now();
  NEW.updated_at := now();
  NEW.status := 'validated';
  NEW.cancel_reason := NULL; NEW.cancelled_by := NULL; NEW.cancelled_at := NULL;

  SELECT * INTO v_acc FROM accounts WHERE id = NEW.account_id;
  IF NOT v_acc.is_active THEN
    RAISE EXCEPTION 'CP020: compte inactif' USING ERRCODE = 'check_violation';
  END IF;
  IF (timezone('Africa/Algiers', NEW.transaction_date))::date < v_acc.opening_date THEN
    RAISE EXCEPTION 'CP021: date antérieure à l''ouverture du compte (%)', v_acc.opening_date USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.transaction_date > now() + interval '5 minutes' THEN
    RAISE EXCEPTION 'CP022: date dans le futur' USING ERRCODE = 'check_violation';
  END IF;

  -- Catégorie : même entreprise (FK) + même type + active
  IF NEW.category_id IS NOT NULL THEN
    SELECT * INTO v_cat FROM categories WHERE id = NEW.category_id;
    IF v_cat.txn_type <> NEW.transaction_type THEN
      RAISE EXCEPTION 'CP023: la catégorie « % » n''est pas de type %', v_cat.name, NEW.transaction_type USING ERRCODE = 'check_violation';
    END IF;
    IF NOT v_cat.is_active THEN
      RAISE EXCEPTION 'CP024: catégorie désactivée' USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  -- Opérations réservées aux fonctions métier
  IF NOT internal_on() AND (
       NEW.transaction_type IN ('transfer_in','transfer_out','adjustment_in','adjustment_out','salary_advance','salary_payment')
       OR NEW.cheque_id IS NOT NULL OR NEW.corrects_id IS NOT NULL) THEN
    RAISE EXCEPTION 'CP025: ce type d''opération doit passer par sa fonction dédiée' USING ERRCODE = 'check_violation';
  END IF;

  -- Permissions (les fonctions métier vérifient elles-mêmes les leurs)
  IF NOT internal_on() THEN
    v_perm := CASE NEW.transaction_type
      WHEN 'income'     THEN 'add_income'
      WHEN 'expense'    THEN 'add_expense'
      WHEN 'purchase'   THEN 'add_purchase'
      WHEN 'deposit'    THEN 'deposit_withdrawal'
      WHEN 'withdrawal' THEN 'deposit_withdrawal' END;
    PERFORM require_perm(NEW.business_id, v_perm);
  END IF;

  -- Restrictions par utilisateur : comptes autorisés + plafond
  IF NOT is_admin(v_uid) AND NEW.transaction_type NOT IN ('transfer_in','adjustment_in','adjustment_out') THEN
    SELECT * INTO v_bu FROM business_users WHERE business_id = NEW.business_id AND user_id = v_uid;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'CP005: aucun accès à cette entreprise' USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF v_bu.allowed_accounts IS NOT NULL AND NOT (NEW.account_id = ANY (v_bu.allowed_accounts)) THEN
      RAISE EXCEPTION 'CP026: compte non autorisé pour cet utilisateur' USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF v_bu.max_amount IS NOT NULL AND NEW.amount > v_bu.max_amount THEN
      RAISE EXCEPTION 'CP027: montant supérieur au plafond autorisé (% DA)', v_bu.max_amount USING ERRCODE = 'insufficient_privilege';
    END IF;
  END IF;

  -- Journée clôturée (sauf écriture d'ajustement produite par la clôture)
  IF NOT (internal_on() AND NEW.transaction_type IN ('adjustment_in','adjustment_out')) THEN
    PERFORM assert_day_open(NEW.account_id, (timezone('Africa/Algiers', NEW.transaction_date))::date);
  END IF;

  -- Pas de solde négatif sur une caisse (paramétrable)
  IF NEW.transaction_type NOT IN ('income','deposit','transfer_in','adjustment_in') AND v_acc.kind = 'cash' THEN
    SELECT coalesce((value)::text::boolean, false) INTO v_allow_neg FROM app_settings WHERE key = 'allow_negative_cash';
    IF NOT coalesce(v_allow_neg, false) AND account_balance(NEW.account_id) - NEW.amount < 0 THEN
      RAISE EXCEPTION 'CP028: solde insuffisant dans « % » (disponible : % DA)', v_acc.name, account_balance(NEW.account_id) USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  RETURN NEW;
END $$;

CREATE TRIGGER txn_before_insert BEFORE INSERT ON transactions
FOR EACH ROW EXECUTE FUNCTION trg_txn_before_insert();

CREATE FUNCTION trg_txn_before_update() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = cashpro, public AS $$
DECLARE
  v_uid uuid := require_uid();
  v_cat record;
BEGIN
  -- Champs financiers immuables : corriger = annuler + nouvelle opération
  IF NEW.business_id IS DISTINCT FROM OLD.business_id
     OR NEW.account_id IS DISTINCT FROM OLD.account_id
     OR NEW.transaction_type IS DISTINCT FROM OLD.transaction_type
     OR NEW.amount IS DISTINCT FROM OLD.amount
     OR NEW.transaction_date IS DISTINCT FROM OLD.transaction_date
     OR NEW.transfer_id IS DISTINCT FROM OLD.transfer_id
     OR NEW.employee_id IS DISTINCT FROM OLD.employee_id
     OR NEW.payroll_period IS DISTINCT FROM OLD.payroll_period
     OR NEW.cheque_id IS DISTINCT FROM OLD.cheque_id
     OR NEW.reconciliation_id IS DISTINCT FROM OLD.reconciliation_id
     OR NEW.corrects_id IS DISTINCT FROM OLD.corrects_id
     OR NEW.created_by IS DISTINCT FROM OLD.created_by
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'CP030: montant, compte, type et date ne sont pas modifiables. Utilisez « correction » (annulation + nouvelle opération).' USING ERRCODE = 'check_violation';
  END IF;

  IF OLD.status = 'cancelled' THEN
    RAISE EXCEPTION 'CP031: opération annulée, non modifiable' USING ERRCODE = 'check_violation';
  END IF;

  IF NEW.status = 'cancelled' AND OLD.status = 'validated' THEN
    -- Annulation
    IF NOT internal_on() THEN
      IF OLD.transfer_id IS NOT NULL OR OLD.cheque_id IS NOT NULL OR OLD.reconciliation_id IS NOT NULL
         OR OLD.transaction_type IN ('salary_advance','salary_payment') THEN
        RAISE EXCEPTION 'CP032: opération liée — annuler via sa fonction dédiée' USING ERRCODE = 'check_violation';
      END IF;
      PERFORM require_perm(OLD.business_id, 'cancel');
    END IF;
    IF coalesce(NEW.cancel_reason, current_reason()) IS NULL THEN
      RAISE EXCEPTION 'CP033: motif d''annulation obligatoire' USING ERRCODE = 'check_violation';
    END IF;
    NEW.cancel_reason := coalesce(NEW.cancel_reason, current_reason());
    NEW.cancelled_by := v_uid;
    NEW.cancelled_at := now();
    IF NOT (internal_on() AND OLD.transaction_type IN ('adjustment_in','adjustment_out')) THEN
      PERFORM assert_day_open(OLD.account_id, OLD.local_date);
    END IF;
  ELSIF NEW.status IS DISTINCT FROM OLD.status THEN
    RAISE EXCEPTION 'CP034: changement de statut non autorisé' USING ERRCODE = 'check_violation';
  ELSE
    -- Modification non financière (description, notes, référence, catégorie, mode, fournisseur)
    IF NOT internal_on() THEN
      IF NOT (has_perm(OLD.business_id, 'edit_any')
              OR (OLD.created_by = v_uid AND has_perm(OLD.business_id, 'edit_own')
                  AND (timezone('Africa/Algiers', OLD.created_at))::date = local_today())) THEN
        RAISE EXCEPTION 'CP035: modification non autorisée' USING ERRCODE = 'insufficient_privilege';
      END IF;
    END IF;
    IF NEW.category_id IS DISTINCT FROM OLD.category_id THEN
      SELECT * INTO v_cat FROM categories WHERE id = NEW.category_id;
      IF NEW.category_id IS NULL AND OLD.transaction_type IN ('income','expense','purchase') THEN
        RAISE EXCEPTION 'CP036: catégorie obligatoire' USING ERRCODE = 'check_violation';
      END IF;
      IF FOUND AND v_cat.txn_type <> OLD.transaction_type THEN
        RAISE EXCEPTION 'CP023: catégorie incompatible avec le type' USING ERRCODE = 'check_violation';
      END IF;
    END IF;
    NEW.cancel_reason := OLD.cancel_reason;
    NEW.cancelled_by := OLD.cancelled_by;
    NEW.cancelled_at := OLD.cancelled_at;
  END IF;

  NEW.updated_at := now();
  RETURN NEW;
END $$;

CREATE TRIGGER txn_before_update BEFORE UPDATE ON transactions
FOR EACH ROW EXECUTE FUNCTION trg_txn_before_update();

-- =====================================================================
-- 5. Interdiction des suppressions physiques
-- =====================================================================
CREATE FUNCTION trg_forbid_delete() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'CP040: suppression interdite sur % — utilisez l''annulation ou la désactivation', TG_TABLE_NAME
    USING ERRCODE = 'check_violation';
END $$;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['transactions','transfers','cheques','cash_sessions','cash_reconciliations',
                           'payroll_items','audit_logs','businesses','accounts','categories','users',
                           'employees','suppliers','transaction_attachments','payment_methods']
  LOOP
    EXECUTE format('CREATE TRIGGER %I BEFORE DELETE ON cashpro.%I FOR EACH ROW EXECUTE FUNCTION cashpro.trg_forbid_delete()', t || '_no_delete', t);
  END LOOP;
END $$;

-- Journal d'audit : ni modification ni suppression
CREATE FUNCTION trg_audit_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'CP041: le journal d''audit est en lecture seule' USING ERRCODE = 'check_violation';
END $$;
CREATE TRIGGER audit_logs_no_update BEFORE UPDATE ON audit_logs FOR EACH ROW EXECUTE FUNCTION trg_audit_immutable();
CREATE TRIGGER audit_logs_no_truncate BEFORE TRUNCATE ON audit_logs FOR EACH STATEMENT EXECUTE FUNCTION trg_audit_immutable();

-- =====================================================================
-- 6. Journal d'audit générique (سجل التعديلات)
-- =====================================================================
CREATE FUNCTION trg_audit() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = cashpro, public AS $$
DECLARE
  v_old jsonb; v_new jsonb; v_changed text[]; v_action text; v_rec text; v_bus uuid; k text;
BEGIN
  IF TG_OP = 'INSERT' THEN
    v_new := to_jsonb(NEW) - 'password_hash';
    v_action := 'create';
  ELSE
    v_old := to_jsonb(OLD) - 'password_hash';
    v_new := to_jsonb(NEW) - 'password_hash';
    SELECT array_agg(key ORDER BY key) INTO v_changed
    FROM jsonb_each(v_new) n
    WHERE n.key <> 'updated_at' AND n.value IS DISTINCT FROM v_old -> n.key;
    IF to_jsonb(NEW) ->> 'password_hash' IS DISTINCT FROM to_jsonb(OLD) ->> 'password_hash' THEN
      v_changed := array_append(coalesce(v_changed, '{}'), 'password');
    END IF;
    IF v_changed IS NULL THEN RETURN NEW; END IF;
    v_action := CASE
      WHEN v_new ->> 'status' = 'cancelled' AND v_old ->> 'status' <> 'cancelled' THEN 'cancel'
      WHEN v_new ->> 'status' = 'reopened'  AND v_old ->> 'status' <> 'reopened'  THEN 'reopen'
      WHEN v_new ->> 'status' = 'closed'    AND v_old ->> 'status' <> 'closed'    THEN 'close'
      WHEN v_new ->> 'is_active' = 'false'  AND v_old ->> 'is_active' = 'true'    THEN 'deactivate'
      WHEN v_new ->> 'is_active' = 'true'   AND v_old ->> 'is_active' = 'false'   THEN 'activate'
      ELSE 'update' END;
    -- ne garder que les colonnes modifiées pour un journal lisible
    v_old := (SELECT jsonb_object_agg(key, v_old -> key) FROM unnest(v_changed) key WHERE v_old ? key);
    v_new := (SELECT jsonb_object_agg(key, v_new -> key) FROM unnest(v_changed) key WHERE v_new ? key);
  END IF;

  v_rec := coalesce(to_jsonb(NEW) ->> 'id', to_jsonb(NEW) ->> 'key',
                    (to_jsonb(NEW) ->> 'business_id') || ':' || (to_jsonb(NEW) ->> 'user_id'));
  v_bus := coalesce(to_jsonb(NEW) ->> 'business_id', to_jsonb(NEW) ->> 'from_business_id',
                    CASE WHEN TG_TABLE_NAME = 'businesses' THEN to_jsonb(NEW) ->> 'id' END)::uuid;

  INSERT INTO audit_logs (user_id, business_id, table_name, record_id, action, old_values, new_values, changed, reason, client_info)
  VALUES (current_uid(), v_bus, TG_TABLE_NAME, v_rec, v_action, v_old, v_new, v_changed,
          coalesce(current_reason(), to_jsonb(NEW) ->> 'cancel_reason'),
          nullif(current_setting('cashpro.client', true), ''));
  RETURN NEW;
END $$;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['users','businesses','business_users','accounts','payment_methods','categories',
                           'suppliers','employees','transfers','cheques','cash_sessions','cash_reconciliations',
                           'transactions','payroll_items','transaction_attachments','app_settings']
  LOOP
    EXECUTE format('CREATE TRIGGER %I AFTER INSERT OR UPDATE ON cashpro.%I FOR EACH ROW EXECUTE FUNCTION cashpro.trg_audit()', t || '_audit', t);
  END LOOP;
END $$;

-- Journaliser un événement applicatif (connexion, export, sauvegarde...)
CREATE FUNCTION log_event(p_action text, p_business uuid DEFAULT NULL, p_details jsonb DEFAULT NULL) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = cashpro, public AS $$
  INSERT INTO audit_logs (user_id, business_id, table_name, record_id, action, new_values, client_info)
  VALUES (current_uid(), p_business, 'app', coalesce(current_uid()::text, '-'), p_action, p_details,
          nullif(current_setting('cashpro.client', true), ''))
$$;

-- updated_at automatique
CREATE FUNCTION trg_touch() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at := now(); RETURN NEW; END $$;
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['users','businesses','business_users','accounts','payment_methods','categories',
                           'suppliers','employees','transfers','cheques','cash_sessions','payroll_items']
  LOOP
    EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE ON cashpro.%I FOR EACH ROW EXECUTE FUNCTION cashpro.trg_touch()', t || '_touch', t);
  END LOOP;
END $$;

-- Permissions par défaut à l'affectation d'un utilisateur
CREATE FUNCTION trg_bu_defaults() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.permissions := cashpro.default_permissions(NEW.profile) || coalesce(NEW.permissions, '{}'::jsonb);
  RETURN NEW;
END $$;
CREATE TRIGGER business_users_defaults BEFORE INSERT ON business_users
FOR EACH ROW EXECUTE FUNCTION trg_bu_defaults();

-- Solde initial d'un compte : figé dès qu'il existe des opérations
CREATE FUNCTION trg_account_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.opening_balance IS DISTINCT FROM OLD.opening_balance OR NEW.opening_date IS DISTINCT FROM OLD.opening_date
      OR NEW.business_id IS DISTINCT FROM OLD.business_id OR NEW.kind IS DISTINCT FROM OLD.kind)
     AND EXISTS (SELECT 1 FROM cashpro.transactions WHERE account_id = OLD.id) THEN
    RAISE EXCEPTION 'CP042: solde initial, date d''ouverture et type figés : le compte a déjà des opérations' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER accounts_guard BEFORE UPDATE ON accounts FOR EACH ROW EXECUTE FUNCTION trg_account_guard();

-- =====================================================================
-- 7. Opérations simples : annulation et correction
-- =====================================================================
CREATE FUNCTION cancel_transaction(p_id uuid, p_reason text) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  IF nullif(trim(p_reason), '') IS NULL THEN RAISE EXCEPTION 'CP033: motif d''annulation obligatoire'; END IF;
  UPDATE cashpro.transactions SET status = 'cancelled', cancel_reason = p_reason WHERE id = p_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'CP050: opération introuvable'; END IF;
END $$;

-- Correction : annule l'original et crée la version corrigée, liée par corrects_id
CREATE FUNCTION correct_transaction(
  p_id uuid, p_reason text,
  p_amount numeric DEFAULT NULL, p_date timestamptz DEFAULT NULL,
  p_account uuid DEFAULT NULL, p_category uuid DEFAULT NULL
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
    coalesce(p_amount, o.amount), coalesce(p_date, o.transaction_date), o.payment_method_id, o.supplier_id,
    o.description, o.reference, o.notes, o.id, cashpro.require_uid())
  RETURNING id INTO v_new;
  PERFORM cashpro.set_internal(false);
  RETURN v_new;
END $$;

-- =====================================================================
-- 8. Transferts (atomiques, deux écritures liées)
-- =====================================================================
CREATE FUNCTION create_transfer(
  p_from_account uuid, p_to_account uuid, p_amount numeric,
  p_date timestamptz DEFAULT now(), p_reference text DEFAULT NULL, p_description text DEFAULT NULL
) RETURNS uuid
LANGUAGE plpgsql AS $$
DECLARE
  v_uid uuid := cashpro.require_uid();
  fa cashpro.accounts; ta cashpro.accounts; v_id uuid; v_kind cashpro.transfer_kind; v_bu record;
BEGIN
  SELECT * INTO fa FROM cashpro.accounts WHERE id = p_from_account;
  SELECT * INTO ta FROM cashpro.accounts WHERE id = p_to_account;
  IF fa.id IS NULL OR ta.id IS NULL THEN RAISE EXCEPTION 'CP060: compte introuvable'; END IF;
  IF fa.id = ta.id THEN RAISE EXCEPTION 'CP061: compte source et destination identiques'; END IF;
  v_kind := CASE WHEN fa.business_id = ta.business_id THEN 'internal' ELSE 'inter_business' END;

  PERFORM cashpro.require_perm(fa.business_id, 'transfer');
  IF v_kind = 'inter_business' THEN PERFORM cashpro.require_perm(ta.business_id, 'transfer'); END IF;
  IF NOT cashpro.is_admin() THEN
    SELECT * INTO v_bu FROM cashpro.business_users WHERE business_id = ta.business_id AND user_id = v_uid;
    IF v_bu.allowed_accounts IS NOT NULL AND NOT (ta.id = ANY (v_bu.allowed_accounts)) THEN
      RAISE EXCEPTION 'CP026: compte destination non autorisé';
    END IF;
  END IF;

  INSERT INTO cashpro.transfers (kind, from_business_id, from_account_id, to_business_id, to_account_id,
                                 amount, transfer_date, reference, description, created_by)
  VALUES (v_kind, fa.business_id, fa.id, ta.business_id, ta.id, p_amount, p_date, p_reference, p_description, v_uid)
  RETURNING id INTO v_id;

  PERFORM cashpro.set_internal(true);
  INSERT INTO cashpro.transactions (business_id, account_id, transaction_type, amount, transaction_date, transfer_id, description, reference, created_by)
  VALUES (fa.business_id, fa.id, 'transfer_out', p_amount, p_date, v_id,
          coalesce(p_description, 'Transfert vers ' || ta.name), p_reference, v_uid),
         (ta.business_id, ta.id, 'transfer_in',  p_amount, p_date, v_id,
          coalesce(p_description, 'Transfert depuis ' || fa.name), p_reference, v_uid);
  PERFORM cashpro.set_internal(false);
  RETURN v_id;
END $$;

CREATE FUNCTION cancel_transfer(p_transfer uuid, p_reason text) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE t cashpro.transfers;
BEGIN
  SELECT * INTO t FROM cashpro.transfers WHERE id = p_transfer FOR UPDATE;
  IF NOT FOUND OR t.status = 'cancelled' THEN RAISE EXCEPTION 'CP062: transfert introuvable ou déjà annulé'; END IF;
  IF nullif(trim(p_reason), '') IS NULL THEN RAISE EXCEPTION 'CP033: motif obligatoire'; END IF;
  PERFORM cashpro.require_perm(t.from_business_id, 'cancel');
  IF t.kind = 'inter_business' THEN PERFORM cashpro.require_perm(t.to_business_id, 'cancel'); END IF;
  -- l'annulation de l'entrée ne doit pas rendre la caisse destinataire négative
  PERFORM cashpro.set_internal(true);
  UPDATE cashpro.transactions SET status = 'cancelled', cancel_reason = p_reason WHERE transfer_id = t.id;
  UPDATE cashpro.transfers SET status = 'cancelled', cancel_reason = p_reason,
         cancelled_by = cashpro.current_uid(), cancelled_at = now() WHERE id = t.id;
  PERFORM cashpro.set_internal(false);
END $$;

-- =====================================================================
-- 9. Caisse : ouverture, clôture, validation d'écart, réouverture
-- =====================================================================
CREATE FUNCTION open_session(p_account uuid, p_date date DEFAULT NULL, p_declared numeric DEFAULT NULL, p_notes text DEFAULT NULL)
RETURNS uuid
LANGUAGE plpgsql AS $$
DECLARE a cashpro.accounts; v_id uuid; v_date date := coalesce(p_date, cashpro.local_today());
BEGIN
  SELECT * INTO a FROM cashpro.accounts WHERE id = p_account;
  IF NOT FOUND THEN RAISE EXCEPTION 'CP060: compte introuvable'; END IF;
  PERFORM cashpro.require_perm(a.business_id, 'cash_session');
  IF v_date > cashpro.local_today() THEN RAISE EXCEPTION 'CP070: ouverture dans le futur'; END IF;
  INSERT INTO cashpro.cash_sessions (business_id, account_id, session_date, opening_balance, declared_opening, opened_by, notes)
  VALUES (a.business_id, a.id, v_date, cashpro.account_balance(a.id, v_date - 1), p_declared, cashpro.require_uid(), p_notes)
  RETURNING id INTO v_id;
  RETURN v_id;
END $$;

-- Écriture d'ajustement (تسوية) pour une réconciliation
CREATE FUNCTION post_adjustment(p_recon uuid) RETURNS uuid
LANGUAGE plpgsql AS $$
DECLARE r cashpro.cash_reconciliations; s cashpro.cash_sessions; v_id uuid;
BEGIN
  SELECT * INTO r FROM cashpro.cash_reconciliations WHERE id = p_recon;
  SELECT * INTO s FROM cashpro.cash_sessions WHERE id = r.session_id;
  IF r.difference = 0 THEN RETURN NULL; END IF;
  PERFORM cashpro.set_internal(true);
  INSERT INTO cashpro.transactions (business_id, account_id, transaction_type, amount, transaction_date,
                                    reconciliation_id, description, notes, created_by)
  VALUES (s.business_id, s.account_id,
          (CASE WHEN r.difference > 0 THEN 'adjustment_in' ELSE 'adjustment_out' END)::cashpro.txn_type,
          abs(r.difference), least(cashpro.end_of_local_day(s.session_date), now()), r.id,
          CASE WHEN r.difference > 0 THEN 'Tasweya — surplus de caisse du ' ELSE 'Tasweya — déficit de caisse du ' END || s.session_date,
          r.reason, cashpro.require_uid())
  RETURNING id INTO v_id;
  PERFORM cashpro.set_internal(false);
  UPDATE cashpro.cash_reconciliations SET adjustment_txn_id = v_id WHERE id = r.id;
  RETURN v_id;
END $$;

-- Clôture : un écart est ajusté automatiquement si l'utilisateur a la
-- permission « adjustment », sinon la clôture passe en attente de validation.
CREATE FUNCTION close_session(p_session uuid, p_physical numeric, p_reason text DEFAULT NULL) RETURNS uuid
LANGUAGE plpgsql AS $$
DECLARE s cashpro.cash_sessions; v_theo numeric; v_recon uuid; v_diff numeric;
BEGIN
  SELECT * INTO s FROM cashpro.cash_sessions WHERE id = p_session FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'CP071: session introuvable'; END IF;
  IF s.status NOT IN ('open','reopened') THEN RAISE EXCEPTION 'CP072: session déjà clôturée'; END IF;
  PERFORM cashpro.require_perm(s.business_id, 'cash_session');
  IF p_physical IS NULL OR p_physical < 0 THEN RAISE EXCEPTION 'CP073: solde physique invalide'; END IF;
  IF EXISTS (SELECT 1 FROM cashpro.cash_sessions WHERE account_id = s.account_id AND session_date < s.session_date
             AND status IN ('open','reopened','pending_review')) THEN
    RAISE EXCEPTION 'CP074: clôturez d''abord les journées précédentes de ce compte';
  END IF;

  v_theo := cashpro.account_balance(s.account_id, s.session_date);
  v_diff := p_physical - v_theo;
  IF v_diff <> 0 AND nullif(trim(p_reason), '') IS NULL THEN
    RAISE EXCEPTION 'CP075: écart de % DA — motif obligatoire', v_diff;
  END IF;

  UPDATE cashpro.cash_reconciliations SET is_current = false WHERE session_id = s.id AND is_current;
  INSERT INTO cashpro.cash_reconciliations (session_id, business_id, theoretical_balance, physical_balance, reason, confirmed_by)
  VALUES (s.id, s.business_id, v_theo, p_physical, p_reason, cashpro.require_uid())
  RETURNING id INTO v_recon;

  IF v_diff = 0 OR cashpro.has_perm(s.business_id, 'adjustment') THEN
    PERFORM cashpro.post_adjustment(v_recon);
    UPDATE cashpro.cash_sessions SET status = 'closed', closed_by = cashpro.current_uid(), closed_at = now() WHERE id = s.id;
  ELSE
    UPDATE cashpro.cash_sessions SET status = 'pending_review', closed_by = cashpro.current_uid(), closed_at = now() WHERE id = s.id;
  END IF;
  RETURN v_recon;
END $$;

-- Validation par un responsable d'une clôture avec écart
CREATE FUNCTION approve_session(p_session uuid, p_reason text DEFAULT NULL) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE s cashpro.cash_sessions; r cashpro.cash_reconciliations;
BEGIN
  SELECT * INTO s FROM cashpro.cash_sessions WHERE id = p_session FOR UPDATE;
  IF s.status <> 'pending_review' THEN RAISE EXCEPTION 'CP076: session non en attente'; END IF;
  PERFORM cashpro.require_perm(s.business_id, 'adjustment');
  SELECT * INTO r FROM cashpro.cash_reconciliations WHERE session_id = s.id AND is_current;
  IF p_reason IS NOT NULL THEN PERFORM set_config('cashpro.reason', p_reason, true); END IF;
  PERFORM cashpro.post_adjustment(r.id);
  UPDATE cashpro.cash_sessions SET status = 'closed' WHERE id = s.id;
END $$;

-- Réouverture : administrateur uniquement, motif obligatoire, tracée
CREATE FUNCTION reopen_session(p_session uuid, p_reason text) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE s cashpro.cash_sessions; r cashpro.cash_reconciliations;
BEGIN
  PERFORM cashpro.require_admin();
  IF nullif(trim(p_reason), '') IS NULL THEN RAISE EXCEPTION 'CP033: motif obligatoire'; END IF;
  SELECT * INTO s FROM cashpro.cash_sessions WHERE id = p_session FOR UPDATE;
  IF s.status NOT IN ('closed','pending_review') THEN RAISE EXCEPTION 'CP077: session non clôturée'; END IF;
  IF EXISTS (SELECT 1 FROM cashpro.cash_sessions WHERE account_id = s.account_id AND session_date > s.session_date
             AND status IN ('closed','pending_review')) THEN
    RAISE EXCEPTION 'CP078: rouvrez d''abord les journées suivantes de ce compte';
  END IF;
  PERFORM set_config('cashpro.reason', p_reason, true);
  SELECT * INTO r FROM cashpro.cash_reconciliations WHERE session_id = s.id AND is_current;
  IF r.adjustment_txn_id IS NOT NULL THEN
    PERFORM cashpro.set_internal(true);
    UPDATE cashpro.transactions SET status = 'cancelled', cancel_reason = 'Réouverture : ' || p_reason WHERE id = r.adjustment_txn_id;
    PERFORM cashpro.set_internal(false);
  END IF;
  UPDATE cashpro.cash_reconciliations SET is_current = false WHERE session_id = s.id AND is_current;
  UPDATE cashpro.cash_sessions SET status = 'reopened', closed_by = NULL, closed_at = NULL WHERE id = s.id;
END $$;

-- =====================================================================
-- 10. Chèques
-- Reçu : in_portfolio → deposited → cleared (opération créée) | rejected
-- Émis : issued → cleared (opération créée) | cancelled
-- Le solde ne bouge qu'à l'encaissement / au débit effectif.
-- =====================================================================
CREATE FUNCTION cheque_receive(
  p_business uuid, p_number text, p_bank text, p_drawer text, p_amount numeric,
  p_issue_date date, p_due_date date DEFAULT NULL, p_txn_type cashpro.txn_type DEFAULT 'income',
  p_category uuid DEFAULT NULL, p_notes text DEFAULT NULL
) RETURNS uuid
LANGUAGE plpgsql AS $$
DECLARE v_id uuid;
BEGIN
  PERFORM cashpro.require_perm(p_business, 'cheques');
  IF p_txn_type = 'income' AND p_category IS NULL THEN RAISE EXCEPTION 'CP080: catégorie obligatoire pour un chèque de recette'; END IF;
  INSERT INTO cashpro.cheques (business_id, direction, cheque_number, bank_name, party_name, amount, issue_date, due_date,
                               status, txn_type, category_id, notes, created_by)
  VALUES (p_business, 'received', p_number, p_bank, p_drawer, p_amount, p_issue_date, p_due_date,
          'in_portfolio', p_txn_type, p_category, p_notes, cashpro.require_uid())
  RETURNING id INTO v_id;
  RETURN v_id;
END $$;

CREATE FUNCTION cheque_deposit(p_cheque uuid, p_account uuid, p_date timestamptz DEFAULT now()) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE c cashpro.cheques; a cashpro.accounts;
BEGIN
  SELECT * INTO c FROM cashpro.cheques WHERE id = p_cheque FOR UPDATE;
  IF c.direction <> 'received' OR c.status <> 'in_portfolio' THEN RAISE EXCEPTION 'CP081: chèque non déposable (statut %)', c.status; END IF;
  PERFORM cashpro.require_perm(c.business_id, 'cheques');
  SELECT * INTO a FROM cashpro.accounts WHERE id = p_account;
  IF a.business_id <> c.business_id OR a.kind NOT IN ('bank','ccp') THEN RAISE EXCEPTION 'CP082: le dépôt se fait sur un compte bancaire ou CCP de la même entreprise'; END IF;
  UPDATE cashpro.cheques SET status = 'deposited', account_id = a.id, deposited_at = p_date WHERE id = c.id;
END $$;

CREATE FUNCTION cheque_issue(
  p_business uuid, p_account uuid, p_number text, p_payee text, p_amount numeric,
  p_issue_date date, p_due_date date DEFAULT NULL, p_txn_type cashpro.txn_type DEFAULT 'purchase',
  p_category uuid DEFAULT NULL, p_supplier uuid DEFAULT NULL, p_notes text DEFAULT NULL
) RETURNS uuid
LANGUAGE plpgsql AS $$
DECLARE v_id uuid; a cashpro.accounts;
BEGIN
  PERFORM cashpro.require_perm(p_business, 'cheques');
  SELECT * INTO a FROM cashpro.accounts WHERE id = p_account;
  IF a.business_id <> p_business OR a.kind NOT IN ('bank','ccp') THEN RAISE EXCEPTION 'CP082: un chèque est tiré sur un compte bancaire ou CCP de l''entreprise'; END IF;
  IF p_txn_type IN ('expense','purchase') AND p_category IS NULL THEN RAISE EXCEPTION 'CP080: catégorie obligatoire'; END IF;
  INSERT INTO cashpro.cheques (business_id, direction, cheque_number, bank_name, party_name, amount, issue_date, due_date,
                               status, account_id, txn_type, category_id, supplier_id, notes, created_by)
  VALUES (p_business, 'issued', p_number, a.bank_name, p_payee, p_amount, p_issue_date, p_due_date,
          'issued', a.id, p_txn_type, p_category, p_supplier, p_notes, cashpro.require_uid())
  RETURNING id INTO v_id;
  RETURN v_id;
END $$;

-- Encaissement (reçu) ou débit (émis) : crée l'opération qui modifie le solde
CREATE FUNCTION cheque_clear(p_cheque uuid, p_date timestamptz DEFAULT now()) RETURNS uuid
LANGUAGE plpgsql AS $$
DECLARE c cashpro.cheques; v_txn uuid; v_pm uuid;
BEGIN
  SELECT * INTO c FROM cashpro.cheques WHERE id = p_cheque FOR UPDATE;
  IF NOT ((c.direction = 'received' AND c.status = 'deposited') OR (c.direction = 'issued' AND c.status = 'issued')) THEN
    RAISE EXCEPTION 'CP083: chèque non encaissable (statut %)', c.status;
  END IF;
  PERFORM cashpro.require_perm(c.business_id, 'cheques');
  SELECT id INTO v_pm FROM cashpro.payment_methods WHERE code = 'cheque' AND business_id IS NULL;
  PERFORM cashpro.set_internal(true);
  INSERT INTO cashpro.transactions (business_id, account_id, category_id, transaction_type, amount, transaction_date,
                                    payment_method_id, supplier_id, cheque_id, description, reference, notes, created_by)
  VALUES (c.business_id, c.account_id, c.category_id, c.txn_type, c.amount, p_date, v_pm, c.supplier_id, c.id,
          'Chèque n° ' || c.cheque_number || ' — ' || c.party_name, c.cheque_number, c.notes, cashpro.require_uid())
  RETURNING id INTO v_txn;
  PERFORM cashpro.set_internal(false);
  UPDATE cashpro.cheques SET status = 'cleared', settled_at = p_date, settlement_txn_id = v_txn WHERE id = c.id;
  RETURN v_txn;
END $$;

-- Rejet (chèque reçu impayé) — même après encaissement : l'opération est annulée
CREATE FUNCTION cheque_reject(p_cheque uuid, p_reason text) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE c cashpro.cheques;
BEGIN
  SELECT * INTO c FROM cashpro.cheques WHERE id = p_cheque FOR UPDATE;
  IF c.direction <> 'received' OR c.status NOT IN ('in_portfolio','deposited','cleared') THEN RAISE EXCEPTION 'CP084: rejet impossible (statut %)', c.status; END IF;
  IF nullif(trim(p_reason), '') IS NULL THEN RAISE EXCEPTION 'CP033: motif obligatoire'; END IF;
  PERFORM cashpro.require_perm(c.business_id, 'cheques');
  IF c.settlement_txn_id IS NOT NULL THEN
    PERFORM cashpro.set_internal(true);
    UPDATE cashpro.transactions SET status = 'cancelled', cancel_reason = 'Chèque rejeté : ' || p_reason WHERE id = c.settlement_txn_id;
    PERFORM cashpro.set_internal(false);
  END IF;
  UPDATE cashpro.cheques SET status = 'rejected', rejected_at = now(), status_reason = p_reason WHERE id = c.id;
END $$;

CREATE FUNCTION cheque_cancel(p_cheque uuid, p_reason text) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE c cashpro.cheques;
BEGIN
  SELECT * INTO c FROM cashpro.cheques WHERE id = p_cheque FOR UPDATE;
  IF c.direction <> 'issued' OR c.status <> 'issued' THEN RAISE EXCEPTION 'CP085: annulation impossible (statut %)', c.status; END IF;
  IF nullif(trim(p_reason), '') IS NULL THEN RAISE EXCEPTION 'CP033: motif obligatoire'; END IF;
  PERFORM cashpro.require_perm(c.business_id, 'cheques');
  UPDATE cashpro.cheques SET status = 'cancelled', status_reason = p_reason WHERE id = c.id;
END $$;

-- =====================================================================
-- 11. Paie : avances, primes, retenues, paiements
-- =====================================================================
CREATE FUNCTION month_start(d date) RETURNS date
LANGUAGE sql IMMUTABLE AS $$ SELECT date_trunc('month', d)::date $$;

CREATE FUNCTION payroll_remaining(p_employee uuid, p_period date) RETURNS numeric
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = cashpro, public AS $$
  -- reste cumulé à payer jusqu'au mois indiqué inclus (négatif = dette de l'employé)
  WITH e AS (SELECT * FROM employees WHERE id = p_employee),
  months AS (
    SELECT generate_series(month_start(e.start_date), month_start(p_period), interval '1 month')::date m FROM e)
  SELECT
    coalesce((SELECT count(*) FROM months), 0) * (SELECT monthly_salary FROM e)
    + coalesce((SELECT sum(CASE kind WHEN 'bonus' THEN amount ELSE -amount END) FROM payroll_items
                WHERE employee_id = p_employee AND status = 'validated' AND period <= month_start(p_period)), 0)
    - coalesce((SELECT sum(amount) FROM transactions
                WHERE employee_id = p_employee AND status = 'validated' AND payroll_period <= month_start(p_period)), 0)
$$;

CREATE FUNCTION salary_movement(
  p_kind text, p_employee uuid, p_period date, p_amount numeric, p_account uuid,
  p_date timestamptz DEFAULT now(), p_notes text DEFAULT NULL
) RETURNS uuid
LANGUAGE plpgsql AS $$
DECLARE e cashpro.employees; v_id uuid; v_rem numeric; v_period date := cashpro.month_start(p_period);
BEGIN
  IF p_kind NOT IN ('advance','payment') THEN RAISE EXCEPTION 'CP090: type invalide'; END IF;
  SELECT * INTO e FROM cashpro.employees WHERE id = p_employee;
  IF NOT FOUND OR NOT e.is_active THEN RAISE EXCEPTION 'CP091: employé introuvable ou inactif'; END IF;
  PERFORM cashpro.require_perm(e.business_id, 'payroll');
  IF v_period < cashpro.month_start(e.start_date) THEN RAISE EXCEPTION 'CP092: période antérieure à l''embauche'; END IF;
  IF p_kind = 'payment' THEN
    v_rem := cashpro.payroll_remaining(e.id, v_period);
    IF p_amount > v_rem THEN
      RAISE EXCEPTION 'CP093: paiement (% DA) supérieur au reste à payer (% DA)', p_amount, v_rem;
    END IF;
  END IF;
  PERFORM cashpro.set_internal(true);
  INSERT INTO cashpro.transactions (business_id, account_id, transaction_type, amount, transaction_date,
                                    employee_id, payroll_period, description, notes, created_by)
  VALUES (e.business_id, p_account,
          CASE p_kind WHEN 'advance' THEN 'salary_advance'::cashpro.txn_type ELSE 'salary_payment'::cashpro.txn_type END,
          p_amount, p_date, e.id, v_period,
          CASE p_kind WHEN 'advance' THEN 'Avance sur salaire — ' ELSE 'Paiement salaire — ' END || e.full_name || ' (' || to_char(v_period, 'MM/YYYY') || ')',
          p_notes, cashpro.require_uid())
  RETURNING id INTO v_id;
  PERFORM cashpro.set_internal(false);
  RETURN v_id;
END $$;

CREATE FUNCTION salary_advance(p_employee uuid, p_period date, p_amount numeric, p_account uuid,
                               p_date timestamptz DEFAULT now(), p_notes text DEFAULT NULL) RETURNS uuid
LANGUAGE sql AS $$ SELECT cashpro.salary_movement('advance', p_employee, p_period, p_amount, p_account, p_date, p_notes) $$;

CREATE FUNCTION salary_payment(p_employee uuid, p_period date, p_amount numeric, p_account uuid,
                               p_date timestamptz DEFAULT now(), p_notes text DEFAULT NULL) RETURNS uuid
LANGUAGE sql AS $$ SELECT cashpro.salary_movement('payment', p_employee, p_period, p_amount, p_account, p_date, p_notes) $$;

CREATE FUNCTION cancel_salary_movement(p_txn uuid, p_reason text) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE t cashpro.transactions;
BEGIN
  SELECT * INTO t FROM cashpro.transactions WHERE id = p_txn;
  IF t.transaction_type NOT IN ('salary_advance','salary_payment') THEN RAISE EXCEPTION 'CP094: pas un mouvement de paie'; END IF;
  PERFORM cashpro.require_perm(t.business_id, 'payroll');
  PERFORM cashpro.require_perm(t.business_id, 'cancel');
  PERFORM cashpro.set_internal(true);
  UPDATE cashpro.transactions SET status = 'cancelled', cancel_reason = p_reason WHERE id = p_txn;
  PERFORM cashpro.set_internal(false);
END $$;

CREATE FUNCTION payroll_item_add(p_employee uuid, p_period date, p_kind cashpro.payroll_kind, p_amount numeric, p_reason text) RETURNS uuid
LANGUAGE plpgsql AS $$
DECLARE e cashpro.employees; v_id uuid;
BEGIN
  SELECT * INTO e FROM cashpro.employees WHERE id = p_employee;
  PERFORM cashpro.require_perm(e.business_id, 'payroll');
  INSERT INTO cashpro.payroll_items (business_id, employee_id, period, kind, amount, reason, created_by)
  VALUES (e.business_id, e.id, cashpro.month_start(p_period), p_kind, p_amount, p_reason, cashpro.require_uid())
  RETURNING id INTO v_id;
  RETURN v_id;
END $$;
