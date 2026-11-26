-- =====================================================================
-- CashPro — 09 : comptes partagés entre activités, ventilation d'une dépense,
-- catégories principales / sous-catégories (version 1.1.0)
--
-- Principe : l'ACTIVITÉ (Game Force, ETP…) dit à qui l'opération est imputée ;
-- le COMPTE (caisse, banque, CCP) dit où se trouve l'argent. Un compte peut servir
-- une ou plusieurs activités : une caisse commune pour Game Force et ETP, par exemple.
-- Chaque opération reste enregistrée UNE seule fois.
--
-- Script REJOUABLE : exécuté à chaque installation / mise à jour (données conservées).
-- =====================================================================
SET search_path = cashpro, public;

-- ---------------------------------------------------------------------
-- 1. Activités servies par chaque compte
--    accounts.business_id reste l'activité « propriétaire » (solde initial, clôture).
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS account_businesses (
  account_id  uuid NOT NULL REFERENCES accounts(id),
  business_id uuid NOT NULL REFERENCES businesses(id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, business_id)
);
CREATE INDEX IF NOT EXISTS account_businesses_biz_idx ON account_businesses (business_id);
INSERT INTO account_businesses (account_id, business_id)
SELECT id, business_id FROM accounts ON CONFLICT DO NOTHING;

CREATE OR REPLACE FUNCTION trg_account_owner_link() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = cashpro, public AS $$
BEGIN
  INSERT INTO account_businesses (account_id, business_id) VALUES (NEW.id, NEW.business_id) ON CONFLICT DO NOTHING;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS accounts_owner_link ON accounts;
CREATE TRIGGER accounts_owner_link AFTER INSERT ON accounts FOR EACH ROW EXECUTE FUNCTION trg_account_owner_link();

CREATE OR REPLACE FUNCTION account_serves(p_account uuid, p_business uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = cashpro, public AS $$
  SELECT EXISTS (SELECT 1 FROM account_businesses WHERE account_id = p_account AND business_id = p_business)
$$;
CREATE OR REPLACE FUNCTION account_visible(p_account uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = cashpro, public AS $$
  SELECT is_admin() OR EXISTS (SELECT 1 FROM account_businesses ab WHERE ab.account_id = p_account AND has_access(ab.business_id))
$$;
CREATE OR REPLACE FUNCTION account_perm(p_account uuid, p_perm text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = cashpro, public AS $$
  SELECT is_admin() OR EXISTS (SELECT 1 FROM account_businesses ab WHERE ab.account_id = p_account AND has_perm(ab.business_id, p_perm))
$$;
CREATE OR REPLACE FUNCTION require_account_perm(p_account uuid, p_perm text) RETURNS void
LANGUAGE plpgsql STABLE AS $$
BEGIN
  IF NOT cashpro.account_perm(p_account, p_perm) THEN
    RAISE EXCEPTION 'CP003: permission refusée (%)', p_perm USING ERRCODE = 'insufficient_privilege';
  END IF;
END $$;
CREATE OR REPLACE FUNCTION session_visible(p_session uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = cashpro, public AS $$
  SELECT EXISTS (SELECT 1 FROM cash_sessions s WHERE s.id = p_session AND account_visible(s.account_id))
$$;

ALTER TABLE account_businesses ENABLE ROW LEVEL SECURITY;
ALTER TABLE account_businesses FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS ab_select ON account_businesses;
CREATE POLICY ab_select ON account_businesses FOR SELECT USING (account_visible(account_id));
DROP POLICY IF EXISTS backup_read ON account_businesses;
CREATE POLICY backup_read ON account_businesses FOR SELECT TO cashpro_backup USING (true);
REVOKE ALL ON account_businesses FROM cashpro_app;
GRANT SELECT ON account_businesses TO cashpro_app, cashpro_backup;

-- Paramétrage (administrateur) : activités qui utilisent un compte.
-- L'activité propriétaire reste toujours liée ; une activité qui a déjà des opérations sur ce compte ne peut pas être retirée.
CREATE OR REPLACE FUNCTION account_set_businesses(p_account uuid, p_businesses uuid[]) RETURNS uuid[]
LANGUAGE plpgsql SECURITY DEFINER SET search_path = cashpro, public AS $$
DECLARE a accounts; v_new uuid[]; v_old uuid[]; v_rm uuid; v_name text;
BEGIN
  PERFORM require_admin();
  SELECT * INTO a FROM accounts WHERE id = p_account;
  IF NOT FOUND THEN RAISE EXCEPTION 'CP060: compte introuvable'; END IF;
  v_new := ARRAY(SELECT DISTINCT x FROM unnest(coalesce(p_businesses, '{}') || a.business_id) x);
  IF EXISTS (SELECT 1 FROM unnest(v_new) x WHERE NOT EXISTS (SELECT 1 FROM businesses b WHERE b.id = x)) THEN
    RAISE EXCEPTION 'CP045: activité inconnue';
  END IF;
  v_old := ARRAY(SELECT business_id FROM account_businesses WHERE account_id = a.id);
  FOR v_rm IN SELECT x FROM unnest(v_old) x WHERE NOT x = ANY (v_new) LOOP
    IF EXISTS (SELECT 1 FROM transactions WHERE account_id = a.id AND business_id = v_rm)
       OR EXISTS (SELECT 1 FROM business_users WHERE business_id = v_rm AND a.id = ANY (allowed_accounts)) THEN
      SELECT name INTO v_name FROM businesses WHERE id = v_rm;
      RAISE EXCEPTION 'CP044: « % » a déjà des opérations ou des utilisateurs sur ce compte : impossible de le retirer', v_name;
    END IF;
    DELETE FROM account_businesses WHERE account_id = a.id AND business_id = v_rm;
  END LOOP;
  INSERT INTO account_businesses (account_id, business_id) SELECT a.id, x FROM unnest(v_new) x ON CONFLICT DO NOTHING;
  IF v_old IS DISTINCT FROM v_new THEN
    PERFORM log_event('account_businesses', a.business_id, jsonb_build_object('account', a.id, 'name', a.name, 'before', v_old, 'after', v_new));
  END IF;
  RETURN v_new;
END $$;

-- ---------------------------------------------------------------------
-- 2. Contrôles : une opération n'utilise qu'un compte servant son activité
--    (remplace les clés étrangères composites « compte de la même activité »)
-- ---------------------------------------------------------------------
ALTER TABLE transactions DROP CONSTRAINT IF EXISTS transactions_account_id_business_id_fkey;
ALTER TABLE cheques      DROP CONSTRAINT IF EXISTS cheques_account_id_business_id_fkey;
ALTER TABLE transfers    DROP CONSTRAINT IF EXISTS transfers_from_account_id_from_business_id_fkey;
ALTER TABLE transfers    DROP CONSTRAINT IF EXISTS transfers_to_account_id_to_business_id_fkey;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'transactions_account_fk') THEN
    ALTER TABLE cashpro.transactions ADD CONSTRAINT transactions_account_fk FOREIGN KEY (account_id) REFERENCES cashpro.accounts(id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'cheques_account_fk') THEN
    ALTER TABLE cashpro.cheques ADD CONSTRAINT cheques_account_fk FOREIGN KEY (account_id) REFERENCES cashpro.accounts(id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'transfers_from_account_fk') THEN
    ALTER TABLE cashpro.transfers ADD CONSTRAINT transfers_from_account_fk FOREIGN KEY (from_account_id) REFERENCES cashpro.accounts(id);
    ALTER TABLE cashpro.transfers ADD CONSTRAINT transfers_to_account_fk FOREIGN KEY (to_account_id) REFERENCES cashpro.accounts(id);
  END IF;
END $$;

CREATE OR REPLACE FUNCTION assert_account_serves(p_account uuid, p_business uuid) RETURNS void
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = cashpro, public AS $$
DECLARE v_acc text; v_biz text;
BEGIN
  IF p_account IS NULL OR account_serves(p_account, p_business) THEN RETURN; END IF;
  SELECT name INTO v_acc FROM accounts WHERE id = p_account;
  SELECT name INTO v_biz FROM businesses WHERE id = p_business;
  RAISE EXCEPTION 'CP029: le compte « % » n''est pas utilisé par l''activité « % » (Paramètres > comptes)', coalesce(v_acc, '?'), coalesce(v_biz, '?')
    USING ERRCODE = 'check_violation';
END $$;

CREATE OR REPLACE FUNCTION trg_txn_account_serves() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN PERFORM cashpro.assert_account_serves(NEW.account_id, NEW.business_id); RETURN NEW; END $$;
DROP TRIGGER IF EXISTS txn_account_serves ON transactions;
CREATE TRIGGER txn_account_serves BEFORE INSERT ON transactions FOR EACH ROW EXECUTE FUNCTION trg_txn_account_serves();

CREATE OR REPLACE FUNCTION trg_transfer_account_serves() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM cashpro.assert_account_serves(NEW.from_account_id, NEW.from_business_id);
  PERFORM cashpro.assert_account_serves(NEW.to_account_id, NEW.to_business_id);
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS transfers_account_serves ON transfers;
CREATE TRIGGER transfers_account_serves BEFORE INSERT ON transfers FOR EACH ROW EXECUTE FUNCTION trg_transfer_account_serves();

CREATE OR REPLACE FUNCTION trg_cheque_account_serves() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN PERFORM cashpro.assert_account_serves(NEW.account_id, NEW.business_id); RETURN NEW; END $$;
DROP TRIGGER IF EXISTS cheques_account_serves ON cheques;
CREATE TRIGGER cheques_account_serves BEFORE INSERT OR UPDATE OF account_id ON cheques FOR EACH ROW EXECUTE FUNCTION trg_cheque_account_serves();

-- ---------------------------------------------------------------------
-- 3. Visibilité (RLS) : un compte est visible pour toute activité qu'il sert
-- ---------------------------------------------------------------------
DROP POLICY IF EXISTS accounts_select ON accounts;
CREATE POLICY accounts_select ON accounts FOR SELECT USING (account_visible(id));
DROP POLICY IF EXISTS sessions_select ON cash_sessions;
DROP POLICY IF EXISTS sessions_insert ON cash_sessions;
DROP POLICY IF EXISTS sessions_update ON cash_sessions;
CREATE POLICY sessions_select ON cash_sessions FOR SELECT USING (account_visible(account_id));
CREATE POLICY sessions_insert ON cash_sessions FOR INSERT WITH CHECK (account_perm(account_id, 'cash_session'));
CREATE POLICY sessions_update ON cash_sessions FOR UPDATE USING (account_perm(account_id, 'cash_session')) WITH CHECK (account_visible(account_id));
DROP POLICY IF EXISTS recon_select ON cash_reconciliations;
DROP POLICY IF EXISTS recon_insert ON cash_reconciliations;
DROP POLICY IF EXISTS recon_update ON cash_reconciliations;
CREATE POLICY recon_select ON cash_reconciliations FOR SELECT USING (session_visible(session_id));
CREATE POLICY recon_insert ON cash_reconciliations FOR INSERT WITH CHECK (session_visible(session_id));
CREATE POLICY recon_update ON cash_reconciliations FOR UPDATE USING (session_visible(session_id)) WITH CHECK (session_visible(session_id));

-- ---------------------------------------------------------------------
-- 4. Caisse : droits sur le compte (caisse commune = une seule clôture par jour)
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION open_session(p_account uuid, p_date date DEFAULT NULL, p_declared numeric DEFAULT NULL, p_notes text DEFAULT NULL)
RETURNS uuid
LANGUAGE plpgsql AS $$
DECLARE a cashpro.accounts; v_id uuid; v_date date := coalesce(p_date, cashpro.local_today());
BEGIN
  SELECT * INTO a FROM cashpro.accounts WHERE id = p_account;
  IF NOT FOUND THEN RAISE EXCEPTION 'CP060: compte introuvable'; END IF;
  PERFORM cashpro.require_account_perm(a.id, 'cash_session');
  IF v_date > cashpro.local_today() THEN RAISE EXCEPTION 'CP070: ouverture dans le futur'; END IF;
  INSERT INTO cashpro.cash_sessions (business_id, account_id, session_date, opening_balance, declared_opening, opened_by, notes)
  VALUES (a.business_id, a.id, v_date, cashpro.account_balance(a.id, v_date - 1), p_declared, cashpro.require_uid(), p_notes)
  RETURNING id INTO v_id;
  RETURN v_id;
END $$;

CREATE OR REPLACE FUNCTION close_session(p_session uuid, p_physical numeric, p_reason text DEFAULT NULL) RETURNS uuid
LANGUAGE plpgsql AS $$
DECLARE s cashpro.cash_sessions; v_theo numeric; v_recon uuid; v_diff numeric;
BEGIN
  SELECT * INTO s FROM cashpro.cash_sessions WHERE id = p_session FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'CP071: session introuvable'; END IF;
  IF s.status NOT IN ('open','reopened') THEN RAISE EXCEPTION 'CP072: session déjà clôturée'; END IF;
  PERFORM cashpro.require_account_perm(s.account_id, 'cash_session');
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
  IF v_diff = 0 OR cashpro.account_perm(s.account_id, 'adjustment') THEN
    PERFORM cashpro.post_adjustment(v_recon);
    UPDATE cashpro.cash_sessions SET status = 'closed', closed_by = cashpro.current_uid(), closed_at = now() WHERE id = s.id;
  ELSE
    UPDATE cashpro.cash_sessions SET status = 'pending_review', closed_by = cashpro.current_uid(), closed_at = now() WHERE id = s.id;
  END IF;
  RETURN v_recon;
END $$;

CREATE OR REPLACE FUNCTION approve_session(p_session uuid, p_reason text DEFAULT NULL) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE s cashpro.cash_sessions; r cashpro.cash_reconciliations;
BEGIN
  SELECT * INTO s FROM cashpro.cash_sessions WHERE id = p_session FOR UPDATE;
  IF s.status <> 'pending_review' THEN RAISE EXCEPTION 'CP076: session non en attente'; END IF;
  PERFORM cashpro.require_account_perm(s.account_id, 'adjustment');
  SELECT * INTO r FROM cashpro.cash_reconciliations WHERE session_id = s.id AND is_current;
  IF p_reason IS NOT NULL THEN PERFORM set_config('cashpro.reason', p_reason, true); END IF;
  PERFORM cashpro.post_adjustment(r.id);
  UPDATE cashpro.cash_sessions SET status = 'closed' WHERE id = s.id;
END $$;

-- ---------------------------------------------------------------------
-- 5. Transferts : activité de chaque côté (par défaut, l'activité propriétaire du compte)
-- ---------------------------------------------------------------------
DROP FUNCTION IF EXISTS create_transfer(uuid, uuid, numeric, timestamptz, text, text);
CREATE OR REPLACE FUNCTION create_transfer(
  p_from_account uuid, p_to_account uuid, p_amount numeric,
  p_date timestamptz DEFAULT now(), p_reference text DEFAULT NULL, p_description text DEFAULT NULL,
  p_from_business uuid DEFAULT NULL, p_to_business uuid DEFAULT NULL
) RETURNS uuid
LANGUAGE plpgsql AS $$
DECLARE
  v_uid uuid := cashpro.require_uid();
  fa cashpro.accounts; ta cashpro.accounts; v_id uuid; v_kind cashpro.transfer_kind; v_bu record;
  v_fb uuid; v_tb uuid;
BEGIN
  SELECT * INTO fa FROM cashpro.accounts WHERE id = p_from_account;
  SELECT * INTO ta FROM cashpro.accounts WHERE id = p_to_account;
  IF fa.id IS NULL OR ta.id IS NULL THEN RAISE EXCEPTION 'CP060: compte introuvable'; END IF;
  IF fa.id = ta.id THEN RAISE EXCEPTION 'CP061: compte source et destination identiques'; END IF;
  v_fb := coalesce(p_from_business, fa.business_id);
  v_tb := coalesce(p_to_business, CASE WHEN cashpro.account_serves(ta.id, v_fb) THEN v_fb ELSE ta.business_id END);
  v_kind := CASE WHEN v_fb = v_tb THEN 'internal' ELSE 'inter_business' END;

  PERFORM cashpro.require_perm(v_fb, 'transfer');
  IF v_kind = 'inter_business' THEN PERFORM cashpro.require_perm(v_tb, 'transfer'); END IF;
  IF NOT cashpro.is_admin() THEN
    SELECT * INTO v_bu FROM cashpro.business_users WHERE business_id = v_tb AND user_id = v_uid;
    IF v_bu.allowed_accounts IS NOT NULL AND NOT (ta.id = ANY (v_bu.allowed_accounts)) THEN
      RAISE EXCEPTION 'CP026: compte destination non autorisé';
    END IF;
  END IF;

  INSERT INTO cashpro.transfers (kind, from_business_id, from_account_id, to_business_id, to_account_id,
                                 amount, transfer_date, reference, description, created_by)
  VALUES (v_kind, v_fb, fa.id, v_tb, ta.id, p_amount, p_date, p_reference, p_description, v_uid)
  RETURNING id INTO v_id;

  PERFORM cashpro.set_internal(true);
  INSERT INTO cashpro.transactions (business_id, account_id, transaction_type, amount, transaction_date, transfer_id, description, reference, created_by)
  VALUES (v_fb, fa.id, 'transfer_out', p_amount, p_date, v_id, coalesce(p_description, 'Transfert vers ' || ta.name), p_reference, v_uid),
         (v_tb, ta.id, 'transfer_in',  p_amount, p_date, v_id, coalesce(p_description, 'Transfert depuis ' || fa.name), p_reference, v_uid);
  PERFORM cashpro.set_internal(false);
  RETURN v_id;
END $$;

-- ---------------------------------------------------------------------
-- 6. Chèques : compte bancaire / CCP servant l'activité du chèque
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION cheque_deposit(p_cheque uuid, p_account uuid, p_date timestamptz DEFAULT now()) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE c cashpro.cheques; a cashpro.accounts;
BEGIN
  SELECT * INTO c FROM cashpro.cheques WHERE id = p_cheque FOR UPDATE;
  IF c.direction <> 'received' OR c.status <> 'in_portfolio' THEN RAISE EXCEPTION 'CP081: chèque non déposable (statut %)', c.status; END IF;
  PERFORM cashpro.require_perm(c.business_id, 'cheques');
  SELECT * INTO a FROM cashpro.accounts WHERE id = p_account;
  IF NOT cashpro.account_serves(a.id, c.business_id) OR a.kind NOT IN ('bank','ccp') THEN
    RAISE EXCEPTION 'CP082: le dépôt se fait sur un compte bancaire ou CCP utilisé par cette activité';
  END IF;
  UPDATE cashpro.cheques SET status = 'deposited', account_id = a.id, deposited_at = p_date WHERE id = c.id;
END $$;

CREATE OR REPLACE FUNCTION cheque_issue(
  p_business uuid, p_account uuid, p_number text, p_payee text, p_amount numeric,
  p_issue_date date, p_due_date date DEFAULT NULL, p_txn_type cashpro.txn_type DEFAULT 'purchase',
  p_category uuid DEFAULT NULL, p_supplier uuid DEFAULT NULL, p_notes text DEFAULT NULL
) RETURNS uuid
LANGUAGE plpgsql AS $$
DECLARE v_id uuid; a cashpro.accounts;
BEGIN
  PERFORM cashpro.require_perm(p_business, 'cheques');
  SELECT * INTO a FROM cashpro.accounts WHERE id = p_account;
  IF NOT cashpro.account_serves(a.id, p_business) OR a.kind NOT IN ('bank','ccp') THEN
    RAISE EXCEPTION 'CP082: un chèque est tiré sur un compte bancaire ou CCP utilisé par cette activité';
  END IF;
  IF p_txn_type IN ('expense','purchase') AND p_category IS NULL THEN RAISE EXCEPTION 'CP080: catégorie obligatoire'; END IF;
  INSERT INTO cashpro.cheques (business_id, direction, cheque_number, bank_name, party_name, amount, issue_date, due_date,
                               status, account_id, txn_type, category_id, supplier_id, notes, created_by)
  VALUES (p_business, 'issued', p_number, a.bank_name, p_payee, p_amount, p_issue_date, p_due_date,
          'issued', a.id, p_txn_type, p_category, p_supplier, p_notes, cashpro.require_uid())
  RETURNING id INTO v_id;
  RETURN v_id;
END $$;

-- ---------------------------------------------------------------------
-- 7. Catégories principales et sous-catégories (2 niveaux)
-- ---------------------------------------------------------------------
ALTER TABLE categories ADD COLUMN IF NOT EXISTS parent_id uuid;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'categories_parent_fk') THEN
    ALTER TABLE cashpro.categories ADD CONSTRAINT categories_parent_fk FOREIGN KEY (parent_id) REFERENCES cashpro.categories(id);
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS categories_parent_idx ON categories (parent_id);

CREATE OR REPLACE FUNCTION trg_category_parent() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = cashpro, public AS $$
DECLARE p categories;
BEGIN
  IF NEW.parent_id IS NULL THEN RETURN NEW; END IF;
  IF NEW.parent_id = NEW.id THEN RAISE EXCEPTION 'CP046: une catégorie ne peut pas être sa propre catégorie principale'; END IF;
  SELECT * INTO p FROM categories WHERE id = NEW.parent_id;
  IF NOT FOUND OR p.business_id <> NEW.business_id OR p.txn_type <> NEW.txn_type THEN
    RAISE EXCEPTION 'CP046: la catégorie principale doit être de la même activité et du même type';
  END IF;
  IF p.parent_id IS NOT NULL THEN RAISE EXCEPTION 'CP046: deux niveaux seulement (catégorie principale > sous-catégorie)'; END IF;
  IF EXISTS (SELECT 1 FROM categories c WHERE c.parent_id = NEW.id) THEN
    RAISE EXCEPTION 'CP046: cette catégorie a déjà des sous-catégories : elle reste principale';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS categories_parent ON categories;
CREATE TRIGGER categories_parent BEFORE INSERT OR UPDATE OF parent_id, business_id, txn_type ON categories
FOR EACH ROW EXECUTE FUNCTION trg_category_parent();

-- Répartition des dépenses : + catégorie principale (colonnes ajoutées en fin)
CREATE OR REPLACE VIEW v_expense_distribution WITH (security_invoker = true) AS
SELECT m.business_id, m.month, m.bucket,
       coalesce(c.name, CASE m.bucket WHEN 'salaries' THEN 'Salaires' END) AS category_name,
       c.color, sum(m.amount) AS total,
       coalesce(pc.name, c.name, CASE m.bucket WHEN 'salaries' THEN 'Salaires' END) AS main_category_name,
       coalesce(pc.color, c.color) AS main_category_color
FROM v_movements m
LEFT JOIN categories c ON c.id = m.category_id
LEFT JOIN categories pc ON pc.id = c.parent_id
WHERE m.bucket IN ('expense','purchase','salaries')
GROUP BY m.business_id, m.month, m.bucket, c.name, c.color, pc.name, pc.color;

-- ---------------------------------------------------------------------
-- 8. Ventilation d'une dépense / d'un achat entre plusieurs activités
--    Une sortie d'argent = plusieurs opérations liées (split_id), même compte, même date.
--    Elles s'annulent ensemble ; une partie seule ne peut pas être annulée ni corrigée.
-- ---------------------------------------------------------------------
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS split_id uuid;
CREATE INDEX IF NOT EXISTS transactions_split_idx ON transactions (split_id) WHERE split_id IS NOT NULL;

CREATE OR REPLACE FUNCTION trg_txn_split_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.split_id IS NOT NULL AND NOT cashpro.internal_on() THEN
      RAISE EXCEPTION 'CP047: une opération ventilée se crée avec la fonction de ventilation' USING ERRCODE = 'check_violation';
    END IF;
  ELSIF OLD.split_id IS NOT NULL AND NEW.status = 'cancelled' AND OLD.status = 'validated' AND NOT cashpro.internal_on() THEN
    RAISE EXCEPTION 'CP048: opération ventilée entre plusieurs activités : elle s''annule en entier' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS txn_split_guard ON transactions;
CREATE TRIGGER txn_split_guard BEFORE INSERT OR UPDATE ON transactions FOR EACH ROW EXECUTE FUNCTION trg_txn_split_guard();

-- p_parts : [{ "businessId": uuid, "categoryId": uuid, "amount": "8000.00", "supplierId": uuid|null }, ...]
CREATE OR REPLACE FUNCTION create_split(
  p_account uuid, p_type cashpro.txn_type, p_parts jsonb, p_date timestamptz DEFAULT now(),
  p_description text DEFAULT NULL, p_reference text DEFAULT NULL, p_notes text DEFAULT NULL,
  p_payment_method uuid DEFAULT NULL, p_total numeric DEFAULT NULL
) RETURNS uuid
LANGUAGE plpgsql AS $$
DECLARE v_split uuid := gen_random_uuid(); p jsonb; v_sum numeric := 0; v_n int; v_perm text; v_biz uuid; v_amt numeric;
BEGIN
  IF p_type NOT IN ('expense','purchase') THEN RAISE EXCEPTION 'CP049: seules les dépenses et les achats se ventilent'; END IF;
  v_n := jsonb_array_length(coalesce(p_parts, '[]'));
  IF v_n < 2 THEN RAISE EXCEPTION 'CP049: au moins deux activités pour une ventilation'; END IF;
  IF (SELECT count(DISTINCT x ->> 'businessId') FROM jsonb_array_elements(p_parts) x) <> v_n THEN
    RAISE EXCEPTION 'CP049: une seule ligne par activité';
  END IF;
  SELECT sum((x ->> 'amount')::numeric) INTO v_sum FROM jsonb_array_elements(p_parts) x;
  IF p_total IS NOT NULL AND v_sum <> p_total THEN
    RAISE EXCEPTION 'CP049: la somme des parts (% DA) est différente du montant total (% DA) : écart %', v_sum, p_total, p_total - v_sum;
  END IF;
  v_perm := CASE p_type WHEN 'expense' THEN 'add_expense' ELSE 'add_purchase' END;
  FOR p IN SELECT * FROM jsonb_array_elements(p_parts) LOOP
    v_biz := (p ->> 'businessId')::uuid;
    v_amt := (p ->> 'amount')::numeric;
    IF v_amt IS NULL OR v_amt <= 0 THEN RAISE EXCEPTION 'CP049: chaque part doit être positive'; END IF;
    PERFORM cashpro.require_perm(v_biz, v_perm);
    PERFORM cashpro.set_internal(true);   -- autorise split_id ; les contrôles de compte, plafond, journée clôturée s'appliquent
    INSERT INTO cashpro.transactions (business_id, account_id, category_id, transaction_type, amount, transaction_date,
                                      payment_method_id, supplier_id, description, reference, notes, split_id, created_by)
    VALUES (v_biz, p_account, (p ->> 'categoryId')::uuid, p_type, v_amt, coalesce(p_date, now()), p_payment_method,
            nullif(p ->> 'supplierId', '')::uuid, p_description, p_reference, p_notes, v_split, cashpro.require_uid());
    PERFORM cashpro.set_internal(false);
  END LOOP;
  RETURN v_split;
END $$;

CREATE OR REPLACE FUNCTION cancel_split(p_split uuid, p_reason text) RETURNS int
LANGUAGE plpgsql AS $$
DECLARE v_biz uuid; n int;
BEGIN
  IF nullif(trim(p_reason), '') IS NULL THEN RAISE EXCEPTION 'CP033: motif d''annulation obligatoire'; END IF;
  IF NOT EXISTS (SELECT 1 FROM cashpro.transactions WHERE split_id = p_split AND status = 'validated') THEN
    RAISE EXCEPTION 'CP050: opération introuvable ou déjà annulée';
  END IF;
  FOR v_biz IN SELECT DISTINCT business_id FROM cashpro.transactions WHERE split_id = p_split LOOP
    PERFORM cashpro.require_perm(v_biz, 'cancel');
  END LOOP;
  PERFORM cashpro.set_internal(true);
  UPDATE cashpro.transactions SET status = 'cancelled', cancel_reason = p_reason WHERE split_id = p_split AND status = 'validated';
  GET DIAGNOSTICS n = ROW_COUNT;
  PERFORM cashpro.set_internal(false);
  RETURN n;
END $$;

-- ---------------------------------------------------------------------
-- 9. Soldes et rapports
-- ---------------------------------------------------------------------
-- Soldes par compte (colonnes ajoutées en fin) : un compte commun n'apparaît qu'une fois
CREATE OR REPLACE VIEW v_account_balances WITH (security_invoker = true) AS
SELECT a.business_id, b.name AS business_name, a.id AS account_id, a.name AS account_name, a.kind,
       a.opening_balance, a.opening_date,
       account_balance(a.id) AS balance,
       coalesce(sum(t.amount) FILTER (WHERE t.direction = 1  AND t.local_date = local_today()), 0) AS today_in,
       coalesce(sum(t.amount) FILTER (WHERE t.direction = -1 AND t.local_date = local_today()), 0) AS today_out,
       max(t.transaction_date) AS last_movement_at,
       a.is_active,
       ARRAY(SELECT ab.business_id FROM account_businesses ab WHERE ab.account_id = a.id ORDER BY ab.business_id) AS business_ids,
       ARRAY(SELECT bb.name FROM account_businesses ab JOIN businesses bb ON bb.id = ab.business_id
             WHERE ab.account_id = a.id ORDER BY bb.sort_order, bb.name) AS business_names,
       (SELECT count(*) FROM account_businesses ab WHERE ab.account_id = a.id) > 1 AS shared
FROM accounts a
JOIN businesses b ON b.id = a.business_id
LEFT JOIN transactions t ON t.account_id = a.id AND t.status = 'validated'
WHERE account_perm(a.id, 'view_balances')
GROUP BY a.id, b.name;

-- Rapport quotidien d'une activité : ouverture + flux de l'activité = clôture.
-- Avec un compte commun, la « position » d'une activité = soldes initiaux de ses comptes
-- + ses propres opérations (tous comptes) ; la somme des activités = la trésorerie réelle.
CREATE OR REPLACE FUNCTION activity_position(p_business uuid, p_at date) RETURNS numeric
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = cashpro, public AS $$
  SELECT coalesce((SELECT sum(opening_balance) FROM accounts WHERE business_id = p_business), 0)
       + coalesce((SELECT sum(signed_amount) FROM transactions
                   WHERE business_id = p_business AND status = 'validated' AND local_date <= p_at), 0)
$$;

CREATE OR REPLACE FUNCTION daily_report(p_business uuid, p_date date DEFAULT NULL)
RETURNS TABLE (
  report_date date, opening_balance numeric, income numeric, expenses numeric, purchases numeric,
  salaries numeric, deposits numeric, withdrawals numeric, internal_transfers numeric,
  inter_transfers_in numeric, inter_transfers_out numeric, cash_differences numeric,
  closing_balance numeric, operations bigint)
LANGUAGE plpgsql STABLE AS $$
DECLARE d date := coalesce(p_date, cashpro.local_today());
BEGIN
  PERFORM cashpro.require_perm(p_business, 'view_reports');
  RETURN QUERY
  SELECT d, cashpro.activity_position(p_business, d - 1),
    coalesce(s.income, 0), coalesce(s.expenses, 0), coalesce(s.purchases, 0), coalesce(s.salaries, 0),
    coalesce(s.deposits, 0), coalesce(s.withdrawals, 0), coalesce(s.internal_transfers, 0),
    coalesce(s.inter_transfers_in, 0), coalesce(s.inter_transfers_out, 0), coalesce(s.cash_differences, 0),
    cashpro.activity_position(p_business, d),
    coalesce(s.operations, 0)
  FROM (SELECT 1) one
  LEFT JOIN cashpro.v_daily_summary s ON s.business_id = p_business AND s.local_date = d;
END $$;

-- Grand livre : + ventilation et catégorie principale (vue recréée : 07 la recrée aussi à chaque mise à jour)
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
       -- 09 : ventilation, catégorie principale, compte commun
       t.split_id, c.parent_id AS category_parent_id, pc.name AS category_parent_name,
       (SELECT count(*) FROM account_businesses ab WHERE ab.account_id = t.account_id) > 1 AS account_shared
FROM transactions t
JOIN businesses b ON b.id = t.business_id
JOIN accounts a ON a.id = t.account_id
LEFT JOIN categories c ON c.id = t.category_id
LEFT JOIN categories pc ON pc.id = c.parent_id
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
-- 10. Droits
-- ---------------------------------------------------------------------
GRANT SELECT ON v_ledger, v_account_balances, v_expense_distribution TO cashpro_app, cashpro_backup;
GRANT SELECT ON ALL TABLES IN SCHEMA cashpro TO cashpro_backup;
REVOKE EXECUTE ON FUNCTION account_set_businesses(uuid, uuid[]), create_split(uuid, cashpro.txn_type, jsonb, timestamptz, text, text, text, uuid, numeric),
  cancel_split(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION account_serves(uuid, uuid), account_visible(uuid), account_perm(uuid, text), require_account_perm(uuid, text),
  session_visible(uuid), account_set_businesses(uuid, uuid[]), assert_account_serves(uuid, uuid), open_session(uuid, date, numeric, text),
  close_session(uuid, numeric, text), approve_session(uuid, text),
  create_transfer(uuid, uuid, numeric, timestamptz, text, text, uuid, uuid), cheque_deposit(uuid, uuid, timestamptz),
  cheque_issue(uuid, uuid, text, text, numeric, date, date, cashpro.txn_type, uuid, uuid, text),
  create_split(uuid, cashpro.txn_type, jsonb, timestamptz, text, text, text, uuid, numeric), cancel_split(uuid, text),
  activity_position(uuid, date), daily_report(uuid, date) TO cashpro_app;

-- ---------------------------------------------------------------------
-- 11. Première installation de la 1.1.0 sans aucune opération : caisse commune Game Force + ETP
--     (demande du propriétaire : une seule caisse physique pour les deux activités).
--     Rien n'est supprimé : la caisse ETP est désactivée, réactivable dans Paramètres > comptes.
--     Tests automatiques : PGOPTIONS="-c cashpro.skip_init=on" pour garder la configuration de départ.
-- ---------------------------------------------------------------------
DO $$
DECLARE v_cash uuid;
BEGIN
  IF coalesce(current_setting('cashpro.skip_init', true), '') = 'on'
     OR EXISTS (SELECT 1 FROM cashpro.app_settings WHERE key = 'shared_cash_init')
     OR EXISTS (SELECT 1 FROM cashpro.transactions) THEN
    RETURN;
  END IF;
  PERFORM set_config('cashpro.reason', 'Version 1.1.0 : caisse commune Game Force + ETP', true);
  SELECT id INTO v_cash FROM cashpro.accounts
  WHERE business_id = '10000000-0000-0000-0000-000000000001' AND kind = 'cash' AND is_active ORDER BY sort_order LIMIT 1;
  IF v_cash IS NOT NULL THEN
    INSERT INTO cashpro.account_businesses (account_id, business_id)
    SELECT v_cash, b.id FROM cashpro.businesses b WHERE b.is_active ON CONFLICT DO NOTHING;
    UPDATE cashpro.accounts SET name = 'Caisse commune' WHERE id = v_cash AND name = 'Caisse principale';
    UPDATE cashpro.accounts a SET is_active = false
    WHERE a.kind = 'cash' AND a.id <> v_cash AND a.business_id <> '10000000-0000-0000-0000-000000000001'
      AND NOT EXISTS (SELECT 1 FROM cashpro.transactions t WHERE t.account_id = a.id)
      AND NOT EXISTS (SELECT 1 FROM cashpro.cash_sessions s WHERE s.account_id = a.id);
  END IF;
  INSERT INTO cashpro.app_settings (key, value) VALUES ('shared_cash_init', 'true') ON CONFLICT (key) DO NOTHING;
END $$;
