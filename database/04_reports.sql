-- =====================================================================
-- CashPro — 04_reports.sql : vues et fonctions de rapports
-- Toutes les vues sont « security_invoker » : la RLS s'applique.
-- =====================================================================
SET search_path = cashpro, public;

-- ---------------------------------------------------------------------
-- Soldes par compte (visibles avec la permission view_balances)
-- ---------------------------------------------------------------------
CREATE VIEW v_account_balances WITH (security_invoker = true) AS
SELECT a.business_id, b.name AS business_name, a.id AS account_id, a.name AS account_name, a.kind,
       a.opening_balance, a.opening_date,
       account_balance(a.id) AS balance,
       coalesce(sum(t.amount) FILTER (WHERE t.direction = 1  AND t.local_date = local_today()), 0) AS today_in,
       coalesce(sum(t.amount) FILTER (WHERE t.direction = -1 AND t.local_date = local_today()), 0) AS today_out,
       max(t.transaction_date) AS last_movement_at,
       a.is_active
FROM accounts a
JOIN businesses b ON b.id = a.business_id
LEFT JOIN transactions t ON t.account_id = a.id AND t.status = 'validated'
WHERE has_perm(a.business_id, 'view_balances')
GROUP BY a.id, b.name;

-- ---------------------------------------------------------------------
-- Journal détaillé avec solde courant (historique chronologique)
-- ---------------------------------------------------------------------
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
       (SELECT count(*) FROM transaction_attachments x WHERE x.transaction_id = t.id AND x.is_active) AS attachments_count
FROM transactions t
JOIN businesses b ON b.id = t.business_id
JOIN accounts a ON a.id = t.account_id
LEFT JOIN categories c ON c.id = t.category_id
LEFT JOIN payment_methods pm ON pm.id = t.payment_method_id
LEFT JOIN suppliers s ON s.id = t.supplier_id
LEFT JOIN employees e ON e.id = t.employee_id
LEFT JOIN transfers tr ON tr.id = t.transfer_id
LEFT JOIN users u ON u.id = t.created_by;

-- ---------------------------------------------------------------------
-- Classification analytique d'une opération
--   income/expense/purchase/salaries : flux externes
--   transfers internes : neutres ; inter-entreprises : exclus du consolidé
-- ---------------------------------------------------------------------
CREATE VIEW v_movements WITH (security_invoker = true) AS
SELECT t.id, t.business_id, t.account_id, t.local_date, date_trunc('month', t.local_date)::date AS month,
       t.transaction_type, t.category_id, t.amount, t.signed_amount,
       CASE
         WHEN t.transaction_type IN ('transfer_in','transfer_out') AND tr.kind = 'internal' THEN 'internal_transfer'
         WHEN t.transaction_type IN ('transfer_in','transfer_out') THEN 'inter_business_transfer'
         WHEN t.transaction_type IN ('adjustment_in','adjustment_out') THEN 'cash_difference'
         WHEN t.transaction_type IN ('salary_advance','salary_payment') THEN 'salaries'
         ELSE t.transaction_type::text
       END AS bucket
FROM transactions t
LEFT JOIN transfers tr ON tr.id = t.transfer_id
WHERE t.status = 'validated';

CREATE VIEW v_daily_summary WITH (security_invoker = true) AS
SELECT business_id, local_date,
  coalesce(sum(amount) FILTER (WHERE bucket = 'income'), 0)      AS income,
  coalesce(sum(amount) FILTER (WHERE bucket = 'expense'), 0)     AS expenses,
  coalesce(sum(amount) FILTER (WHERE bucket = 'purchase'), 0)    AS purchases,
  coalesce(sum(amount) FILTER (WHERE bucket = 'salaries'), 0)    AS salaries,
  coalesce(sum(amount) FILTER (WHERE bucket = 'deposit'), 0)     AS deposits,
  coalesce(sum(amount) FILTER (WHERE bucket = 'withdrawal'), 0)  AS withdrawals,
  coalesce(sum(signed_amount) FILTER (WHERE bucket = 'cash_difference'), 0) AS cash_differences,
  coalesce(sum(amount) FILTER (WHERE bucket = 'internal_transfer' AND signed_amount > 0), 0) AS internal_transfers,
  coalesce(sum(amount) FILTER (WHERE bucket = 'inter_business_transfer' AND signed_amount > 0), 0) AS inter_transfers_in,
  coalesce(sum(amount) FILTER (WHERE bucket = 'inter_business_transfer' AND signed_amount < 0), 0) AS inter_transfers_out,
  coalesce(sum(signed_amount), 0) AS net_change,
  count(*) FILTER (WHERE bucket NOT IN ('internal_transfer','cash_difference')) AS operations
FROM v_movements
GROUP BY business_id, local_date;

CREATE VIEW v_monthly_summary WITH (security_invoker = true) AS
SELECT business_id, date_trunc('month', local_date)::date AS month,
  sum(income) AS income, sum(expenses) AS expenses, sum(purchases) AS purchases, sum(salaries) AS salaries,
  sum(deposits) AS deposits, sum(withdrawals) AS withdrawals, sum(cash_differences) AS cash_differences,
  sum(internal_transfers) AS internal_transfers, sum(inter_transfers_in) AS inter_transfers_in,
  sum(inter_transfers_out) AS inter_transfers_out,
  sum(income) - sum(expenses) - sum(purchases) - sum(salaries) AS operating_result,
  sum(net_change) AS net_change, sum(operations) AS operations
FROM v_daily_summary
GROUP BY business_id, date_trunc('month', local_date);

-- Consolidé toutes entreprises : les transferts inter-entreprises s'annulent
CREATE VIEW v_consolidated_monthly WITH (security_invoker = true) AS
SELECT month,
  sum(income) AS income, sum(expenses) AS expenses, sum(purchases) AS purchases, sum(salaries) AS salaries,
  sum(deposits) AS deposits, sum(withdrawals) AS withdrawals, sum(cash_differences) AS cash_differences,
  sum(operating_result) AS operating_result,
  sum(net_change) AS net_change   -- = variation réelle de la trésorerie du groupe
FROM v_monthly_summary
GROUP BY month;

-- Répartition des dépenses (dépenses + achats + salaires) par catégorie
CREATE VIEW v_expense_distribution WITH (security_invoker = true) AS
SELECT m.business_id, m.month, m.bucket,
       coalesce(c.name, CASE m.bucket WHEN 'salaries' THEN 'Salaires' END) AS category_name,
       c.color, sum(m.amount) AS total
FROM v_movements m
LEFT JOIN categories c ON c.id = m.category_id
WHERE m.bucket IN ('expense','purchase','salaries')
GROUP BY m.business_id, m.month, m.bucket, c.name, c.color;

-- ---------------------------------------------------------------------
-- Rapport quotidien d'une entreprise (tous comptes)
-- ---------------------------------------------------------------------
CREATE FUNCTION daily_report(p_business uuid, p_date date DEFAULT NULL)
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
  SELECT d,
    (SELECT coalesce(sum(cashpro.account_balance(a.id, d - 1)), 0) FROM cashpro.accounts a WHERE a.business_id = p_business),
    coalesce(s.income, 0), coalesce(s.expenses, 0), coalesce(s.purchases, 0), coalesce(s.salaries, 0),
    coalesce(s.deposits, 0), coalesce(s.withdrawals, 0), coalesce(s.internal_transfers, 0),
    coalesce(s.inter_transfers_in, 0), coalesce(s.inter_transfers_out, 0), coalesce(s.cash_differences, 0),
    (SELECT coalesce(sum(cashpro.account_balance(a.id, d)), 0) FROM cashpro.accounts a WHERE a.business_id = p_business),
    coalesce(s.operations, 0)
  FROM (SELECT 1) one
  LEFT JOIN cashpro.v_daily_summary s ON s.business_id = p_business AND s.local_date = d;
END $$;

-- Évolution du solde total d'une entreprise (pour les graphiques)
CREATE FUNCTION balance_series(p_business uuid, p_from date, p_to date)
RETURNS TABLE (day date, balance numeric)
LANGUAGE plpgsql STABLE AS $$
BEGIN
  PERFORM cashpro.require_perm(p_business, 'view_balances');
  RETURN QUERY
  WITH days AS (SELECT generate_series(p_from, p_to, interval '1 day')::date AS day),
  base AS (SELECT coalesce(sum(a.opening_balance), 0) AS ob FROM cashpro.accounts a WHERE a.business_id = p_business),
  daily AS (SELECT t.local_date, sum(t.signed_amount) AS chg FROM cashpro.transactions t
            WHERE t.business_id = p_business AND t.status = 'validated' GROUP BY t.local_date)
  SELECT d.day, (SELECT ob FROM base) + coalesce((SELECT sum(chg) FROM daily WHERE local_date <= d.day), 0)
  FROM days d ORDER BY d.day;
END $$;

-- ---------------------------------------------------------------------
-- Paie : situation mensuelle par employé (report des soldes)
-- ---------------------------------------------------------------------
CREATE VIEW v_payroll_monthly WITH (security_invoker = true) AS
WITH months AS (
  SELECT e.id AS employee_id, e.business_id, e.full_name, e.job_title, e.monthly_salary,
         generate_series(month_start(e.start_date),
                         month_start(coalesce(e.end_date, local_today())), interval '1 month')::date AS period
  FROM employees e),
agg AS (
  SELECT m.*,
    coalesce((SELECT sum(amount) FROM payroll_items p WHERE p.employee_id = m.employee_id AND p.period = m.period AND p.kind = 'bonus' AND p.status = 'validated'), 0) AS bonuses,
    coalesce((SELECT sum(amount) FROM payroll_items p WHERE p.employee_id = m.employee_id AND p.period = m.period AND p.kind = 'deduction' AND p.status = 'validated'), 0) AS deductions,
    coalesce((SELECT sum(amount) FROM transactions t WHERE t.employee_id = m.employee_id AND t.payroll_period = m.period AND t.transaction_type = 'salary_advance' AND t.status = 'validated'), 0) AS advances,
    coalesce((SELECT sum(amount) FROM transactions t WHERE t.employee_id = m.employee_id AND t.payroll_period = m.period AND t.transaction_type = 'salary_payment' AND t.status = 'validated'), 0) AS payments
  FROM months m)
SELECT employee_id, business_id, full_name, job_title, period, monthly_salary, bonuses, deductions,
       monthly_salary + bonuses - deductions AS net_salary, advances, payments,
       monthly_salary + bonuses - deductions - advances - payments AS month_balance,
       coalesce(sum(monthly_salary + bonuses - deductions - advances - payments)
         OVER (PARTITION BY employee_id ORDER BY period ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING), 0) AS carried_over,
       sum(monthly_salary + bonuses - deductions - advances - payments)
         OVER (PARTITION BY employee_id ORDER BY period) AS remaining,   -- < 0 : dette de l'employé
       CASE
         WHEN advances + payments = 0 THEN 'unpaid'
         WHEN sum(monthly_salary + bonuses - deductions - advances - payments) OVER (PARTITION BY employee_id ORDER BY period) > 0 THEN 'partial'
         ELSE 'paid' END AS status
FROM agg;

-- ---------------------------------------------------------------------
-- Chèques à suivre (échéances)
-- ---------------------------------------------------------------------
CREATE VIEW v_cheques WITH (security_invoker = true) AS
SELECT c.*, b.name AS business_name, a.name AS account_name, s.name AS supplier_name,
       (c.status IN ('in_portfolio','deposited','issued')) AS is_pending,
       (c.status IN ('in_portfolio','deposited','issued') AND c.due_date < local_today()) AS is_overdue
FROM cheques c
JOIN businesses b ON b.id = c.business_id
LEFT JOIN accounts a ON a.id = c.account_id
LEFT JOIN suppliers s ON s.id = c.supplier_id;

-- Historique des clôtures
CREATE VIEW v_cash_closings WITH (security_invoker = true) AS
SELECT s.id AS session_id, s.business_id, s.account_id, a.name AS account_name, s.session_date, s.status,
       s.opening_balance, s.declared_opening, r.theoretical_balance, r.physical_balance, r.difference, r.result,
       r.reason, r.adjustment_txn_id, uo.full_name AS opened_by_name, uc.full_name AS closed_by_name,
       s.opened_at, s.closed_at
FROM cash_sessions s
JOIN accounts a ON a.id = s.account_id
LEFT JOIN cash_reconciliations r ON r.session_id = s.id AND r.is_current
LEFT JOIN users uo ON uo.id = s.opened_by
LEFT JOIN users uc ON uc.id = s.closed_by;

-- Journal d'audit lisible
CREATE VIEW v_audit WITH (security_invoker = true) AS
SELECT l.id, l.occurred_at, l.user_id, u.full_name AS user_name, l.business_id, b.name AS business_name,
       l.table_name, l.record_id, l.action, l.changed, l.old_values, l.new_values, l.reason, l.client_info
FROM audit_logs l
LEFT JOIN users u ON u.id = l.user_id
LEFT JOIN businesses b ON b.id = l.business_id;

GRANT SELECT ON ALL TABLES IN SCHEMA cashpro TO cashpro_app, cashpro_backup;
REVOKE INSERT, UPDATE ON audit_logs FROM cashpro_app;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA cashpro TO cashpro_app;
GRANT SELECT ON ALL SEQUENCES IN SCHEMA cashpro TO cashpro_backup;
