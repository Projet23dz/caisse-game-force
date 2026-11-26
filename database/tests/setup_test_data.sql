-- Données de test (superutilisateur). NE PAS exécuter en production.
SET search_path = cashpro, public;
SELECT set_config('cashpro.user_id', '00000000-0000-0000-0000-000000000001', false);

-- comptes ouverts il y a 10 jours avec soldes initiaux
UPDATE accounts SET opening_date = local_today() - 10,
  opening_balance = CASE WHEN kind = 'cash' AND business_id = '10000000-0000-0000-0000-000000000001' THEN 50000
                         WHEN kind = 'bank' AND business_id = '10000000-0000-0000-0000-000000000001' THEN 200000
                         WHEN kind = 'cash' THEN 30000
                         WHEN kind = 'bank' THEN 100000 ELSE 0 END;

INSERT INTO users (username, full_name, password_hash, role) VALUES
  ('karim', 'Karim (employé GF)',  crypt('test', gen_salt('bf', 4)), 'user'),
  ('samir', 'Samir (responsable)', crypt('test', gen_salt('bf', 4)), 'user');

INSERT INTO business_users (business_id, user_id, profile, allowed_accounts, max_amount)
SELECT '10000000-0000-0000-0000-000000000001', id, 'employee',
       ARRAY(SELECT a.id FROM accounts a WHERE a.business_id = '10000000-0000-0000-0000-000000000001' AND a.kind = 'cash'), 5000
FROM users WHERE username = 'karim';
INSERT INTO business_users (business_id, user_id, profile)
SELECT b.id, u.id, 'manager' FROM users u, businesses b WHERE u.username = 'samir';

INSERT INTO employees (business_id, full_name, job_title, monthly_salary, start_date)
VALUES ('10000000-0000-0000-0000-000000000002', 'Yacine Technicien', 'Technicien fibre', 40000, date_trunc('month', local_today())::date);
