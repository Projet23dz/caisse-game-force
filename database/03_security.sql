-- =====================================================================
-- CashPro — 03_security.sql : rôle applicatif + Row Level Security
-- L'API se connecte avec le rôle cashpro_app (jamais superutilisateur).
-- Toute lecture/écriture est filtrée par entreprise au niveau de la base.
-- =====================================================================
SET search_path = cashpro, public;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'cashpro_app') THEN
    CREATE ROLE cashpro_app LOGIN PASSWORD 'CHANGE_ME_APP_PASSWORD' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'cashpro_backup') THEN
    CREATE ROLE cashpro_backup LOGIN PASSWORD 'CHANGE_ME_BACKUP_PASSWORD' NOSUPERUSER BYPASSRLS;
  END IF;
END $$;

REVOKE ALL ON SCHEMA cashpro FROM PUBLIC;
GRANT USAGE ON SCHEMA cashpro TO cashpro_app, cashpro_backup;
REVOKE ALL ON ALL TABLES IN SCHEMA cashpro FROM PUBLIC;
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA cashpro FROM PUBLIC;

-- Lecture/écriture sans DELETE ni TRUNCATE
GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA cashpro TO cashpro_app;
REVOKE INSERT, UPDATE ON audit_logs FROM cashpro_app;      -- écrit uniquement par les triggers
GRANT USAGE ON ALL SEQUENCES IN SCHEMA cashpro TO cashpro_app;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA cashpro TO cashpro_app;
GRANT SELECT ON ALL TABLES IN SCHEMA cashpro TO cashpro_backup;
GRANT SELECT ON ALL SEQUENCES IN SCHEMA cashpro TO cashpro_backup;

-- ---------------------------------------------------------------------
-- Authentification (avant que l'utilisateur soit connu)
-- ---------------------------------------------------------------------
CREATE FUNCTION auth_find_user(p_username text)
RETURNS TABLE (id uuid, full_name text, password_hash text, role user_role, is_active boolean,
               locked_until timestamptz, locale text, theme text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = cashpro, public AS $$
  SELECT id, full_name, password_hash, role, is_active, locked_until, locale, theme
  FROM users WHERE lower(username) = lower(p_username)
$$;

-- Après 5 échecs : verrouillage 15 minutes
CREATE FUNCTION auth_record_login(p_user uuid, p_success boolean, p_client text DEFAULT NULL) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = cashpro, public AS $$
BEGIN
  PERFORM set_config('cashpro.user_id', p_user::text, true);
  PERFORM set_config('cashpro.client', coalesce(p_client, ''), true);
  IF p_success THEN
    UPDATE users SET failed_logins = 0, locked_until = NULL, last_login_at = now() WHERE id = p_user;
    PERFORM log_event('login_success');
  ELSE
    UPDATE users SET failed_logins = failed_logins + 1,
           locked_until = CASE WHEN failed_logins + 1 >= 5 THEN now() + interval '15 minutes' ELSE locked_until END
    WHERE id = p_user;
    PERFORM log_event('login_failed');
  END IF;
END $$;

-- Changement de mot de passe (hash bcrypt calculé par l'API)
CREATE FUNCTION set_password(p_user uuid, p_hash text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = cashpro, public AS $$
BEGIN
  IF current_uid() IS DISTINCT FROM p_user AND NOT is_admin() THEN
    RAISE EXCEPTION 'CP004: réservé à l''administrateur';
  END IF;
  IF p_hash !~ '^\$2[aby]\$\d\d\$' THEN RAISE EXCEPTION 'CP006: hash invalide'; END IF;
  UPDATE users SET password_hash = p_hash, failed_logins = 0, locked_until = NULL WHERE id = p_user;
END $$;

REVOKE EXECUTE ON FUNCTION auth_find_user(text), auth_record_login(uuid, boolean, text), set_password(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION auth_find_user(text), auth_record_login(uuid, boolean, text), set_password(uuid, text) TO cashpro_app;

-- ---------------------------------------------------------------------
-- Row Level Security
-- ---------------------------------------------------------------------
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['users','businesses','business_users','accounts','payment_methods','categories',
                           'suppliers','employees','transfers','cheques','cash_sessions','cash_reconciliations',
                           'transactions','payroll_items','transaction_attachments','audit_logs','app_settings']
  LOOP
    EXECUTE format('ALTER TABLE cashpro.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE cashpro.%I FORCE ROW LEVEL SECURITY', t);
  END LOOP;
END $$;

-- users : l'admin gère tout ; chacun voit son profil et les noms de ses collègues
CREATE FUNCTION shares_business(p_other uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = cashpro, public AS $$
  SELECT EXISTS (SELECT 1 FROM business_users a JOIN business_users b ON a.business_id = b.business_id
                 WHERE a.user_id = current_uid() AND b.user_id = p_other)
$$;
GRANT EXECUTE ON FUNCTION shares_business(uuid) TO cashpro_app;
CREATE POLICY users_select ON users FOR SELECT USING (is_admin() OR id = current_uid() OR shares_business(id));
CREATE POLICY users_insert ON users FOR INSERT WITH CHECK (is_admin());
CREATE POLICY users_update ON users FOR UPDATE USING (is_admin() OR id = current_uid())
  WITH CHECK (is_admin() OR (id = current_uid() AND role = 'user'));

-- businesses
CREATE POLICY businesses_select ON businesses FOR SELECT USING (has_access(id));
CREATE POLICY businesses_write  ON businesses FOR INSERT WITH CHECK (is_admin());
CREATE POLICY businesses_update ON businesses FOR UPDATE USING (is_admin()) WITH CHECK (is_admin());

-- business_users : admin uniquement en écriture
CREATE POLICY bu_select ON business_users FOR SELECT USING (is_admin() OR user_id = current_uid());
CREATE POLICY bu_insert ON business_users FOR INSERT WITH CHECK (is_admin());
CREATE POLICY bu_update ON business_users FOR UPDATE USING (is_admin()) WITH CHECK (is_admin());

-- accounts : paramètres financiers = admin
CREATE POLICY accounts_select ON accounts FOR SELECT USING (has_access(business_id));
CREATE POLICY accounts_insert ON accounts FOR INSERT WITH CHECK (is_admin());
CREATE POLICY accounts_update ON accounts FOR UPDATE USING (is_admin()) WITH CHECK (is_admin());

-- payment_methods
CREATE POLICY pm_select ON payment_methods FOR SELECT USING (business_id IS NULL OR has_access(business_id));
CREATE POLICY pm_insert ON payment_methods FOR INSERT WITH CHECK (is_admin());
CREATE POLICY pm_update ON payment_methods FOR UPDATE USING (is_admin()) WITH CHECK (is_admin());

-- categories / suppliers
CREATE POLICY categories_select ON categories FOR SELECT USING (has_access(business_id));
CREATE POLICY categories_insert ON categories FOR INSERT WITH CHECK (has_perm(business_id, 'manage_categories'));
CREATE POLICY categories_update ON categories FOR UPDATE USING (has_perm(business_id, 'manage_categories'))
  WITH CHECK (has_perm(business_id, 'manage_categories'));

CREATE POLICY suppliers_select ON suppliers FOR SELECT USING (has_access(business_id));
CREATE POLICY suppliers_insert ON suppliers FOR INSERT WITH CHECK (has_perm(business_id, 'manage_suppliers') OR has_perm(business_id, 'add_purchase'));
CREATE POLICY suppliers_update ON suppliers FOR UPDATE USING (has_perm(business_id, 'manage_suppliers'))
  WITH CHECK (has_perm(business_id, 'manage_suppliers'));

-- employees : salaires visibles uniquement avec la permission paie
CREATE POLICY employees_select ON employees FOR SELECT USING (has_perm(business_id, 'payroll') OR has_perm(business_id, 'manage_employees'));
CREATE POLICY employees_insert ON employees FOR INSERT WITH CHECK (has_perm(business_id, 'manage_employees'));
CREATE POLICY employees_update ON employees FOR UPDATE USING (has_perm(business_id, 'manage_employees'))
  WITH CHECK (has_perm(business_id, 'manage_employees'));

-- transactions : un employé ne voit que ses opérations (sauf permission)
CREATE POLICY txn_select ON transactions FOR SELECT USING (
  has_access(business_id) AND (created_by = current_uid() OR has_perm(business_id, 'view_all_transactions')));
CREATE POLICY txn_insert ON transactions FOR INSERT WITH CHECK (has_access(business_id));
CREATE POLICY txn_update ON transactions FOR UPDATE USING (has_access(business_id)) WITH CHECK (has_access(business_id));

-- transfers
CREATE POLICY transfers_select ON transfers FOR SELECT USING (
  (has_access(from_business_id) OR has_access(to_business_id))
  AND (created_by = current_uid() OR has_perm(from_business_id, 'view_all_transactions') OR has_perm(to_business_id, 'view_all_transactions')));
CREATE POLICY transfers_insert ON transfers FOR INSERT WITH CHECK (has_perm(from_business_id, 'transfer'));
CREATE POLICY transfers_update ON transfers FOR UPDATE USING (has_perm(from_business_id, 'cancel')) WITH CHECK (true);

-- cheques
CREATE POLICY cheques_select ON cheques FOR SELECT USING (has_perm(business_id, 'cheques') OR (has_access(business_id) AND created_by = current_uid()));
CREATE POLICY cheques_insert ON cheques FOR INSERT WITH CHECK (has_perm(business_id, 'cheques'));
CREATE POLICY cheques_update ON cheques FOR UPDATE USING (has_perm(business_id, 'cheques')) WITH CHECK (has_perm(business_id, 'cheques'));

-- caisse
CREATE POLICY sessions_select ON cash_sessions FOR SELECT USING (has_access(business_id));
CREATE POLICY sessions_insert ON cash_sessions FOR INSERT WITH CHECK (has_perm(business_id, 'cash_session'));
CREATE POLICY sessions_update ON cash_sessions FOR UPDATE USING (has_perm(business_id, 'cash_session')) WITH CHECK (has_access(business_id));

CREATE POLICY recon_select ON cash_reconciliations FOR SELECT USING (has_access(business_id));
CREATE POLICY recon_insert ON cash_reconciliations FOR INSERT WITH CHECK (has_perm(business_id, 'cash_session'));
CREATE POLICY recon_update ON cash_reconciliations FOR UPDATE USING (has_perm(business_id, 'cash_session')) WITH CHECK (has_access(business_id));

-- paie
CREATE POLICY payroll_select ON payroll_items FOR SELECT USING (has_perm(business_id, 'payroll'));
CREATE POLICY payroll_insert ON payroll_items FOR INSERT WITH CHECK (has_perm(business_id, 'payroll'));
CREATE POLICY payroll_update ON payroll_items FOR UPDATE USING (has_perm(business_id, 'payroll')) WITH CHECK (has_perm(business_id, 'payroll'));

-- pièces jointes
CREATE POLICY att_select ON transaction_attachments FOR SELECT USING (has_access(business_id));
CREATE POLICY att_insert ON transaction_attachments FOR INSERT WITH CHECK (has_access(business_id) AND uploaded_by = current_uid());
CREATE POLICY att_update ON transaction_attachments FOR UPDATE USING (has_perm(business_id, 'cancel')) WITH CHECK (has_access(business_id));

-- audit : lecture selon permission, aucune écriture directe
CREATE POLICY audit_select ON audit_logs FOR SELECT USING (
  is_admin() OR (business_id IS NOT NULL AND has_perm(business_id, 'view_audit')) OR user_id = current_uid());

-- paramètres
CREATE POLICY settings_select ON app_settings FOR SELECT USING (current_uid() IS NOT NULL);
CREATE POLICY settings_insert ON app_settings FOR INSERT WITH CHECK (is_admin());
CREATE POLICY settings_update ON app_settings FOR UPDATE USING (is_admin()) WITH CHECK (is_admin());

-- Le rôle de sauvegarde lit tout
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['users','businesses','business_users','accounts','payment_methods','categories',
                           'suppliers','employees','transfers','cheques','cash_sessions','cash_reconciliations',
                           'transactions','payroll_items','transaction_attachments','audit_logs','app_settings']
  LOOP
    EXECUTE format('CREATE POLICY backup_read ON cashpro.%I FOR SELECT TO cashpro_backup USING (true)', t);
  END LOOP;
END $$;
