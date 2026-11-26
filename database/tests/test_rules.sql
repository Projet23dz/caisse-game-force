-- =====================================================================
-- CashPro — tests des règles métier
-- Usage : psql -d cashpro -f tests/setup_test_data.sql (superuser)
--         psql -d cashpro -U cashpro_app -f tests/test_rules.sql
-- =====================================================================
\set ON_ERROR_STOP on
SET search_path = cashpro, public;
\pset footer off

CREATE TEMP TABLE results (n serial, name text, ok boolean, detail text);

-- exécute une instruction qui DOIT échouer avec le code CPxxx attendu
CREATE FUNCTION pg_temp.expect_error(p_name text, p_sql text, p_code text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  BEGIN
    EXECUTE p_sql;
    INSERT INTO results(name, ok, detail) VALUES (p_name, false, 'aucune erreur');
  EXCEPTION WHEN OTHERS THEN
    INSERT INTO results(name, ok, detail) VALUES (p_name, SQLERRM LIKE p_code || '%' OR SQLERRM LIKE '%' || p_code || '%', SQLERRM);
  END;
END $$;
CREATE FUNCTION pg_temp.check(p_name text, p_ok boolean, p_detail text DEFAULT NULL) RETURNS void LANGUAGE sql AS $$
  INSERT INTO results(name, ok, detail) VALUES (p_name, coalesce(p_ok, false), p_detail)
$$;
CREATE FUNCTION pg_temp.as_user(p text) RETURNS void LANGUAGE sql AS $$
  SELECT set_config('cashpro.user_id', (SELECT id::text FROM cashpro.auth_find_user(p)), false)
$$;
CREATE FUNCTION pg_temp.acc(p_bus text, p_kind text) RETURNS uuid LANGUAGE sql AS $$
  SELECT a.id FROM cashpro.accounts a JOIN cashpro.businesses b ON b.id = a.business_id WHERE b.code = p_bus AND a.kind::text = p_kind
$$;
CREATE FUNCTION pg_temp.bus(p text) RETURNS uuid LANGUAGE sql AS $$ SELECT id FROM cashpro.businesses WHERE code = p $$;
CREATE FUNCTION pg_temp.cat(p_bus text, p_name text) RETURNS uuid LANGUAGE sql AS $$
  SELECT c.id FROM cashpro.categories c JOIN cashpro.businesses b ON b.id = c.business_id WHERE b.code = p_bus AND c.name = p_name
$$;
CREATE FUNCTION pg_temp.bal(p uuid) RETURNS numeric LANGUAGE sql AS $$ SELECT cashpro.account_balance(p) $$;

-- ---------------------------------------------------------------------
-- 0. Sans utilisateur identifié : rien n'est visible ni possible
-- ---------------------------------------------------------------------
SELECT set_config('cashpro.user_id', '', false);
SELECT pg_temp.check('Sans connexion : aucune entreprise visible', (SELECT count(*) FROM businesses) = 0);

-- ---------------------------------------------------------------------
-- 1. Admin : recette sur la caisse Game Force
-- ---------------------------------------------------------------------
SELECT pg_temp.as_user('admin');
SELECT pg_temp.check('Admin voit 2 entreprises', (SELECT count(*) FROM businesses) = 2);
INSERT INTO transactions (business_id, account_id, category_id, transaction_type, amount, transaction_date, description)
VALUES (pg_temp.bus('GF'), pg_temp.acc('GF','cash'), pg_temp.cat('GF','Ventes consoles'), 'income', 10000, greatest(now() - interval '1 hour', date_trunc('day', now() AT TIME ZONE 'Africa/Algiers') AT TIME ZONE 'Africa/Algiers'), 'Vente PS5 slim');
SELECT pg_temp.check('Recette : caisse GF 50 000 → 60 000', pg_temp.bal(pg_temp.acc('GF','cash')) = 60000, pg_temp.bal(pg_temp.acc('GF','cash'))::text);

SELECT pg_temp.expect_error('Catégorie d''un autre type refusée',
  $$INSERT INTO cashpro.transactions (business_id, account_id, category_id, transaction_type, amount)
    VALUES (pg_temp.bus('GF'), pg_temp.acc('GF','cash'), pg_temp.cat('GF','Transport'), 'income', 100)$$, 'CP023');
SELECT pg_temp.expect_error('Catégorie d''une autre entreprise refusée (FK composite)',
  $$INSERT INTO cashpro.transactions (business_id, account_id, category_id, transaction_type, amount)
    VALUES (pg_temp.bus('GF'), pg_temp.acc('GF','cash'), pg_temp.cat('ETP','Carburant'), 'expense', 100)$$, 'foreign key');
SELECT pg_temp.expect_error('Compte non utilisé par cette activité refusé',
  $$INSERT INTO cashpro.transactions (business_id, account_id, category_id, transaction_type, amount)
    VALUES (pg_temp.bus('GF'), pg_temp.acc('ETP','cash'), pg_temp.cat('GF','Transport'), 'expense', 100)$$, 'CP029');
SELECT pg_temp.expect_error('Montant négatif refusé',
  $$INSERT INTO cashpro.transactions (business_id, account_id, category_id, transaction_type, amount)
    VALUES (pg_temp.bus('GF'), pg_temp.acc('GF','cash'), pg_temp.cat('GF','Transport'), 'expense', -5)$$, 'check constraint');
SELECT pg_temp.expect_error('Caisse négative refusée',
  $$INSERT INTO cashpro.transactions (business_id, account_id, category_id, transaction_type, amount)
    VALUES (pg_temp.bus('GF'), pg_temp.acc('GF','cash'), pg_temp.cat('GF','Transport'), 'expense', 999999)$$, 'CP028');
SELECT pg_temp.expect_error('Transfert saisi à la main refusé',
  $$INSERT INTO cashpro.transactions (business_id, account_id, transaction_type, amount)
    VALUES (pg_temp.bus('GF'), pg_temp.acc('GF','cash'), 'transfer_in', 100)$$, 'CP025');

-- ---------------------------------------------------------------------
-- 2. Employé (Karim, Game Force uniquement)
-- ---------------------------------------------------------------------
SELECT pg_temp.as_user('karim');
SELECT pg_temp.check('Employé : ne voit que Game Force', (SELECT array_agg(code) FROM businesses) = ARRAY['GF']);
INSERT INTO transactions (business_id, account_id, category_id, transaction_type, amount, description)
VALUES (pg_temp.bus('GF'), pg_temp.acc('GF','cash'), pg_temp.cat('GF','Transport'), 'expense', 2000, 'Livraison');
SELECT pg_temp.check('Employé : dépense enregistrée', (SELECT count(*) FROM transactions WHERE description = 'Livraison') = 1);
SELECT pg_temp.check('Employé : ne voit pas les opérations de l''admin', (SELECT count(*) FROM transactions) = 1);
SELECT pg_temp.check('Employé : soldes masqués', (SELECT count(*) FROM v_account_balances) = 0);
SELECT pg_temp.expect_error('Employé : achat refusé (permission)',
  $$INSERT INTO cashpro.transactions (business_id, account_id, category_id, transaction_type, amount)
    VALUES (pg_temp.bus('GF'), pg_temp.acc('GF','cash'), pg_temp.cat('GF','Achat PlayStation'), 'purchase', 100)$$, 'CP003');
SELECT pg_temp.expect_error('Employé : compte bancaire non autorisé',
  $$INSERT INTO cashpro.transactions (business_id, account_id, category_id, transaction_type, amount)
    VALUES (pg_temp.bus('GF'), pg_temp.acc('GF','bank'), pg_temp.cat('GF','Transport'), 'expense', 100)$$, 'CP026');
SELECT pg_temp.expect_error('Employé : plafond 5 000 DA',
  $$INSERT INTO cashpro.transactions (business_id, account_id, category_id, transaction_type, amount)
    VALUES (pg_temp.bus('GF'), pg_temp.acc('GF','cash'), pg_temp.cat('GF','Transport'), 'expense', 6000)$$, 'CP027');
SELECT pg_temp.expect_error('Employé : écriture dans ETP refusée',
  $$INSERT INTO cashpro.transactions (business_id, account_id, category_id, transaction_type, amount)
    VALUES (pg_temp.bus('ETP'), pg_temp.acc('ETP','cash'), pg_temp.cat('ETP','Carburant'), 'expense', 100)$$, 'CP0');
SELECT pg_temp.expect_error('Montant non modifiable',
  $$UPDATE cashpro.transactions SET amount = 1 WHERE description = 'Livraison'$$, 'CP030');
UPDATE transactions SET notes = 'Livraison client Annaba' WHERE description = 'Livraison';
SELECT pg_temp.check('Employé : note modifiée sur sa propre opération du jour', (SELECT notes FROM transactions WHERE description = 'Livraison') = 'Livraison client Annaba');
SELECT pg_temp.expect_error('Employé : annulation refusée',
  $$SELECT cashpro.cancel_transaction((SELECT id FROM cashpro.transactions WHERE description = 'Livraison'), 'erreur')$$, 'CP003');
SELECT pg_temp.expect_error('Suppression physique impossible',
  $$DELETE FROM cashpro.transactions WHERE description = 'Livraison'$$, 'permission denied');
SELECT pg_temp.expect_error('Employé : journal d''audit non modifiable',
  $$UPDATE cashpro.audit_logs SET reason = 'x'$$, 'permission denied');
UPDATE accounts SET name = 'X' WHERE id = pg_temp.acc('GF','cash');  -- filtré par la RLS
SELECT pg_temp.check('Employé : modification d''un compte sans effet (RLS)', (SELECT count(*) FROM accounts WHERE name = 'X') = 0);

-- ---------------------------------------------------------------------
-- 3. Responsable (Samir) : annulation et correction
-- ---------------------------------------------------------------------
SELECT pg_temp.as_user('samir');
SELECT pg_temp.check('Responsable : voit toutes les opérations GF', (SELECT count(*) FROM transactions WHERE business_id = pg_temp.bus('GF')) = 2);
SELECT pg_temp.expect_error('Annulation sans motif refusée',
  $$SELECT cashpro.cancel_transaction((SELECT id FROM cashpro.transactions WHERE description = 'Livraison'), '')$$, 'CP033');
SELECT cashpro.correct_transaction((SELECT id FROM transactions WHERE description = 'Livraison'), 'Montant réel 2 500', p_amount => 2500);
SELECT pg_temp.check('Correction : original annulé + nouvelle opération liée',
  (SELECT count(*) FROM transactions WHERE description = 'Livraison' AND status = 'cancelled') = 1
  AND (SELECT amount FROM transactions WHERE description = 'Livraison' AND status = 'validated' AND corrects_id IS NOT NULL) = 2500);
SELECT pg_temp.check('Caisse GF = 50 000 + 10 000 − 2 500', pg_temp.bal(pg_temp.acc('GF','cash')) = 57500, pg_temp.bal(pg_temp.acc('GF','cash'))::text);

-- ---------------------------------------------------------------------
-- 4. Transferts
-- ---------------------------------------------------------------------
SELECT cashpro.create_transfer(pg_temp.acc('GF','cash'), pg_temp.acc('GF','bank'), 5000, now(), 'VRS-001', 'Versement banque');
SELECT pg_temp.check('Transfert interne : caisse −5 000 / banque +5 000',
  pg_temp.bal(pg_temp.acc('GF','cash')) = 52500 AND pg_temp.bal(pg_temp.acc('GF','bank')) = 205000);
SELECT pg_temp.check('Transfert interne : total GF inchangé',
  (SELECT sum(cashpro.account_balance(id)) FROM accounts WHERE business_id = pg_temp.bus('GF')) = 257500);
SELECT pg_temp.check('Transfert interne : ni recette ni dépense',
  (SELECT income FROM v_daily_summary WHERE business_id = pg_temp.bus('GF') AND local_date = local_today()) = 10000
  AND (SELECT expenses FROM v_daily_summary WHERE business_id = pg_temp.bus('GF') AND local_date = local_today()) = 2500);

SELECT cashpro.create_transfer(pg_temp.acc('GF','bank'), pg_temp.acc('ETP','bank'), 20000, now(), 'INTER-001', 'Avance trésorerie ETP');
SELECT pg_temp.check('Transfert inter-entreprises : 2 écritures liées',
  (SELECT count(DISTINCT business_id) FROM transactions WHERE reference = 'INTER-001') = 2);
SELECT pg_temp.check('Consolidé : le transfert inter-entreprises s''annule (variation = recettes − dépenses)',
  (SELECT net_change FROM v_consolidated_monthly WHERE month = date_trunc('month', local_today())::date) = 10000 - 2500);
SELECT cashpro.cancel_transfer((SELECT transfer_id FROM transactions WHERE reference = 'INTER-001' LIMIT 1), 'Doublon');
SELECT pg_temp.check('Annulation transfert : les 2 côtés annulés',
  (SELECT bool_and(status = 'cancelled') FROM transactions WHERE reference = 'INTER-001')
  AND pg_temp.bal(pg_temp.acc('GF','bank')) = 205000);

-- ---------------------------------------------------------------------
-- 5. Chèques
-- ---------------------------------------------------------------------
SELECT cashpro.cheque_receive(pg_temp.bus('GF'), '0012345', 'BNA', 'Client Ali', 45000, local_today(), local_today() + 30,
                              'income', pg_temp.cat('GF','Ventes consoles'), 'PS5 + 2 manettes');
SELECT pg_temp.check('Chèque reçu en portefeuille : solde banque inchangé', pg_temp.bal(pg_temp.acc('GF','bank')) = 205000);
SELECT cashpro.cheque_deposit((SELECT id FROM cheques WHERE cheque_number = '0012345'), pg_temp.acc('GF','bank'));
SELECT pg_temp.check('Chèque déposé : solde banque inchangé', pg_temp.bal(pg_temp.acc('GF','bank')) = 205000);
SELECT cashpro.cheque_clear((SELECT id FROM cheques WHERE cheque_number = '0012345'));
SELECT pg_temp.check('Chèque encaissé : banque +45 000 (recette)', pg_temp.bal(pg_temp.acc('GF','bank')) = 250000);
SELECT cashpro.cheque_reject((SELECT id FROM cheques WHERE cheque_number = '0012345'), 'Impayé — provision insuffisante');
SELECT pg_temp.check('Chèque rejeté après encaissement : recette annulée', pg_temp.bal(pg_temp.acc('GF','bank')) = 205000
  AND (SELECT status FROM cheques WHERE cheque_number = '0012345') = 'rejected');

INSERT INTO suppliers (business_id, name, phone) VALUES (pg_temp.bus('GF'), 'Sony Distribution Alger', '0550000000');
SELECT cashpro.cheque_issue(pg_temp.bus('GF'), pg_temp.acc('GF','bank'), '7700001', 'Sony Distribution Alger', 120000,
                            local_today(), NULL, 'purchase', pg_temp.cat('GF','Achat PlayStation'),
                            (SELECT id FROM suppliers WHERE name = 'Sony Distribution Alger'));
SELECT cashpro.cheque_clear((SELECT id FROM cheques WHERE cheque_number = '7700001'));
SELECT pg_temp.check('Chèque émis débité : achat −120 000 avec fournisseur',
  pg_temp.bal(pg_temp.acc('GF','bank')) = 85000
  AND (SELECT supplier_name FROM v_ledger WHERE reference = '7700001') = 'Sony Distribution Alger');

-- Achat espèces avec fournisseur
INSERT INTO transactions (business_id, account_id, category_id, transaction_type, amount, supplier_id, description)
VALUES (pg_temp.bus('GF'), pg_temp.acc('GF','cash'), pg_temp.cat('GF','Achat manettes'), 'purchase', 12000,
        (SELECT id FROM suppliers WHERE name = 'Sony Distribution Alger'), '4 manettes DualSense');
SELECT pg_temp.check('Achats séparés des dépenses dans les stats',
  (SELECT purchases FROM v_daily_summary WHERE business_id = pg_temp.bus('GF') AND local_date = local_today()) = 132000
  AND (SELECT expenses FROM v_daily_summary WHERE business_id = pg_temp.bus('GF') AND local_date = local_today()) = 2500);

-- Retrait personnel ≠ dépense
INSERT INTO transactions (business_id, account_id, category_id, transaction_type, amount, description)
VALUES (pg_temp.bus('GF'), pg_temp.acc('GF','cash'), pg_temp.cat('GF','Retrait personnel'), 'withdrawal', 3000, 'Retrait gérant');
SELECT pg_temp.check('Retrait personnel hors dépenses opérationnelles',
  (SELECT withdrawals FROM v_daily_summary WHERE business_id = pg_temp.bus('GF') AND local_date = local_today()) = 3000
  AND (SELECT expenses FROM v_daily_summary WHERE business_id = pg_temp.bus('GF') AND local_date = local_today()) = 2500);

-- ---------------------------------------------------------------------
-- 6. Caisse : ouverture, clôture avec écart, validation, réouverture
-- Caisse GF : 52 500 − 12 000 − 3 000 = 37 500
-- ---------------------------------------------------------------------
SELECT pg_temp.check('Solde théorique caisse GF = 37 500', pg_temp.bal(pg_temp.acc('GF','cash')) = 37500, pg_temp.bal(pg_temp.acc('GF','cash'))::text);
SELECT pg_temp.as_user('karim');
SELECT cashpro.open_session(pg_temp.acc('GF','cash'));
SELECT pg_temp.expect_error('Clôture avec écart sans motif refusée',
  $$SELECT cashpro.close_session((SELECT id FROM cashpro.cash_sessions LIMIT 1), 37000)$$, 'CP075');
SELECT cashpro.close_session((SELECT id FROM cash_sessions LIMIT 1), 37000, 'Rendu monnaie erroné');
SELECT pg_temp.check('Employé : clôture avec écart → en attente de validation',
  (SELECT status FROM cash_sessions LIMIT 1) = 'pending_review' AND pg_temp.bal(pg_temp.acc('GF','cash')) = 37500);
SELECT pg_temp.expect_error('Journée en attente : saisie bloquée',
  $$INSERT INTO cashpro.transactions (business_id, account_id, category_id, transaction_type, amount)
    VALUES (pg_temp.bus('GF'), pg_temp.acc('GF','cash'), pg_temp.cat('GF','Ventes consoles'), 'income', 100)$$, 'CP010');

SELECT pg_temp.as_user('samir');
SELECT cashpro.approve_session((SELECT id FROM cash_sessions LIMIT 1), 'Validé');
SELECT pg_temp.check('Validation : تسوية −500, solde = physique 37 000',
  pg_temp.bal(pg_temp.acc('GF','cash')) = 37000
  AND (SELECT transaction_type::text FROM transactions WHERE reconciliation_id IS NOT NULL) = 'adjustment_out'
  AND (SELECT status FROM cash_sessions LIMIT 1) = 'closed');
SELECT pg_temp.check('Écart visible dans le rapport, hors dépenses',
  (SELECT cash_differences FROM v_daily_summary WHERE business_id = pg_temp.bus('GF') AND local_date = local_today()) = -500
  AND (SELECT expenses FROM v_daily_summary WHERE business_id = pg_temp.bus('GF') AND local_date = local_today()) = 2500);
SELECT pg_temp.expect_error('Journée clôturée : annulation bloquée',
  $$SELECT cashpro.cancel_transaction((SELECT id FROM cashpro.transactions WHERE description = 'Retrait gérant'), 'test')$$, 'CP010');
SELECT pg_temp.expect_error('Journée clôturée : saisie antidatée bloquée',
  $$INSERT INTO cashpro.transactions (business_id, account_id, category_id, transaction_type, amount, transaction_date)
    VALUES (pg_temp.bus('GF'), pg_temp.acc('GF','cash'), pg_temp.cat('GF','Ventes consoles'), 'income', 100, now() - interval '3 days')$$, 'CP010');
SELECT pg_temp.check('La banque (sans clôture) reste utilisable',
  (SELECT count(*) FROM cash_sessions WHERE account_id = pg_temp.acc('GF','bank')) = 0);
SELECT pg_temp.expect_error('Responsable : réouverture refusée',
  $$SELECT cashpro.reopen_session((SELECT id FROM cashpro.cash_sessions LIMIT 1), 'oubli')$$, 'CP004');

SELECT pg_temp.as_user('admin');
SELECT cashpro.reopen_session((SELECT id FROM cash_sessions LIMIT 1), 'Vente oubliée à saisir');
SELECT pg_temp.check('Réouverture admin : تسوية annulée, solde revenu à 37 500',
  pg_temp.bal(pg_temp.acc('GF','cash')) = 37500 AND (SELECT status FROM cash_sessions LIMIT 1) = 'reopened');
INSERT INTO transactions (business_id, account_id, category_id, transaction_type, amount, description)
VALUES (pg_temp.bus('GF'), pg_temp.acc('GF','cash'), pg_temp.cat('GF','Ventes jeux vidéo'), 'income', 500, 'FIFA oublié');
SELECT cashpro.close_session((SELECT id FROM cash_sessions LIMIT 1), 38000, NULL);
SELECT pg_temp.check('Re-clôture sans écart : 38 000 = 38 000',
  (SELECT difference FROM v_cash_closings LIMIT 1) = 0 AND (SELECT status FROM cash_sessions LIMIT 1) = 'closed'
  AND (SELECT count(*) FROM cash_reconciliations) = 2);

-- ---------------------------------------------------------------------
-- 7. Paie (ETP)
-- ---------------------------------------------------------------------
SELECT pg_temp.as_user('samir');
SELECT cashpro.salary_advance((SELECT id FROM employees WHERE full_name = 'Yacine Technicien'), local_today(), 10000, pg_temp.acc('ETP','cash'));
SELECT cashpro.payroll_item_add((SELECT id FROM employees WHERE full_name = 'Yacine Technicien'), local_today(), 'bonus', 2000, 'Chantier urgent');
SELECT pg_temp.check('Reste à payer : 40 000 + 2 000 − 10 000 = 32 000',
  cashpro.payroll_remaining((SELECT id FROM employees WHERE full_name = 'Yacine Technicien'), local_today()) = 32000);
SELECT pg_temp.expect_error('Paiement supérieur au reste refusé',
  $$SELECT cashpro.salary_payment((SELECT id FROM cashpro.employees WHERE full_name = 'Yacine Technicien'), cashpro.local_today(), 33000, pg_temp.acc('ETP','bank'))$$, 'CP093');
SELECT cashpro.salary_payment((SELECT id FROM employees WHERE full_name = 'Yacine Technicien'), local_today(), 32000, pg_temp.acc('ETP','bank'));
SELECT pg_temp.check('Mois soldé (statut paid, reste 0)',
  (SELECT status = 'paid' AND remaining = 0 FROM v_payroll_monthly WHERE full_name = 'Yacine Technicien' AND period = month_start(local_today())));
SELECT pg_temp.check('Salaires dans leur propre rubrique',
  (SELECT salaries FROM v_daily_summary WHERE business_id = pg_temp.bus('ETP') AND local_date = local_today()) = 42000
  AND coalesce((SELECT expenses FROM v_daily_summary WHERE business_id = pg_temp.bus('ETP') AND local_date = local_today()), 0) = 0);
SELECT pg_temp.as_user('karim');
SELECT pg_temp.check('Employé GF : salaires ETP invisibles', (SELECT count(*) FROM employees) = 0);

-- ---------------------------------------------------------------------
-- 8. Solde à une date passée, rapport quotidien, audit
-- ---------------------------------------------------------------------
SELECT pg_temp.as_user('admin');
SELECT pg_temp.check('Solde à une date passée (hier) = solde initial',
  cashpro.account_balance(pg_temp.acc('GF','cash'), local_today() - 1) = 50000);
SELECT pg_temp.check('Rapport quotidien cohérent (ouverture + flux = clôture)',
  (SELECT opening_balance + income - expenses - purchases - salaries + deposits - withdrawals
          + inter_transfers_in - inter_transfers_out + cash_differences = closing_balance
   FROM cashpro.daily_report(pg_temp.bus('GF'))));
SELECT pg_temp.check('Audit : annulation tracée avec motif',
  EXISTS (SELECT 1 FROM v_audit WHERE action = 'cancel' AND table_name = 'transactions' AND reason LIKE 'Correction%'));
SELECT pg_temp.check('Audit : anciennes et nouvelles valeurs conservées',
  EXISTS (SELECT 1 FROM v_audit WHERE action = 'update' AND table_name = 'transactions'
          AND old_values ? 'notes' AND new_values ->> 'notes' = 'Livraison client Annaba'));
SELECT pg_temp.check('Audit : réouverture tracée', EXISTS (SELECT 1 FROM v_audit WHERE action = 'reopen' AND reason = 'Vente oubliée à saisir'));

-- ---------------------------------------------------------------------
SELECT n AS "#", CASE WHEN ok THEN '✔' ELSE '✘' END AS r, name,
       CASE WHEN NOT ok THEN detail END AS detail FROM results ORDER BY n;
SELECT count(*) FILTER (WHERE ok) || ' / ' || count(*) || ' tests réussis' AS bilan FROM results;
