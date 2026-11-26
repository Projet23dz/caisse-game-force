-- =====================================================================
-- CashPro — Multi-Business Cashflow Manager
-- 01_schema.sql : types et tables
-- PostgreSQL 16 — serveur local
-- =====================================================================
-- Principes :
--  * Montants en NUMERIC(18,2), jamais en float.
--  * Toute donnée d'entreprise porte business_id ; les clés étrangères
--    composites (id, business_id) empêchent de mélanger deux entreprises.
--  * Aucune suppression physique des données financières.
--  * Date locale calculée en Africa/Algiers.
-- =====================================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;

DROP SCHEMA IF EXISTS cashpro CASCADE;
CREATE SCHEMA cashpro;
SET search_path = cashpro, public;

-- ---------------------------------------------------------------------
-- Types
-- ---------------------------------------------------------------------
CREATE TYPE user_role       AS ENUM ('admin', 'user');
CREATE TYPE user_profile    AS ENUM ('employee', 'manager');      -- موظف / مسؤول
CREATE TYPE account_kind    AS ENUM ('cash', 'bank', 'ccp', 'other'); -- خزينة / بنك / بريد
CREATE TYPE txn_status      AS ENUM ('validated', 'cancelled');
CREATE TYPE transfer_kind   AS ENUM ('internal', 'inter_business');
CREATE TYPE session_status  AS ENUM ('open', 'pending_review', 'closed', 'reopened');
CREATE TYPE cheque_direction AS ENUM ('received', 'issued');
CREATE TYPE cheque_status   AS ENUM ('in_portfolio', 'deposited', 'cleared', 'rejected', 'issued', 'cancelled');
CREATE TYPE payroll_kind    AS ENUM ('advance', 'bonus', 'deduction', 'payment');

-- Types d'opération. Le sens (+1 / -1) est dérivé du type.
CREATE TYPE txn_type AS ENUM (
  'income',          -- إيراد
  'expense',         -- مصروف تشغيلي
  'purchase',        -- شراء
  'deposit',         -- إيداع (apport)
  'withdrawal',      -- سحب شخصي
  'transfer_out',    -- خروج تحويل
  'transfer_in',     -- دخول تحويل
  'adjustment_in',   -- تسوية فائض
  'adjustment_out',  -- تسوية عجز
  'salary_advance',  -- تسبيق أجر
  'salary_payment'   -- دفع أجر
);

CREATE FUNCTION txn_direction(t txn_type) RETURNS smallint
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT CASE WHEN t IN ('income','deposit','transfer_in','adjustment_in') THEN 1 ELSE -1 END::smallint
$$;

-- ---------------------------------------------------------------------
-- 1. users
-- ---------------------------------------------------------------------
CREATE TABLE users (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  username      text NOT NULL,
  full_name     text NOT NULL,
  email         text,
  phone         text,
  password_hash text NOT NULL,                 -- bcrypt
  role          user_role NOT NULL DEFAULT 'user',
  locale        text NOT NULL DEFAULT 'ar' CHECK (locale IN ('ar','fr','en')),
  theme         text NOT NULL DEFAULT 'game-force-dark',
  is_active     boolean NOT NULL DEFAULT true,
  last_login_at timestamptz,
  failed_logins int NOT NULL DEFAULT 0,
  locked_until  timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX users_username_uq ON users (lower(username));

-- ---------------------------------------------------------------------
-- 2. businesses
-- ---------------------------------------------------------------------
CREATE TABLE businesses (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code        text NOT NULL UNIQUE,            -- GF, ETP ...
  name        text NOT NULL,
  activity    text,
  logo_path   text,                            -- chemin du logo sur le serveur
  address     text,
  phone       text,
  email       text,
  nif         text,
  rc          text,
  color       text,                            -- couleur d'accent de la carte
  currency    char(3) NOT NULL DEFAULT 'DZD',
  is_active   boolean NOT NULL DEFAULT true,
  sort_order  int NOT NULL DEFAULT 0,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------
-- 3. business_users : accès + permissions par entreprise
-- ---------------------------------------------------------------------
CREATE TABLE business_users (
  business_id      uuid NOT NULL REFERENCES businesses(id),
  user_id          uuid NOT NULL REFERENCES users(id),
  profile          user_profile NOT NULL DEFAULT 'employee',
  permissions      jsonb NOT NULL DEFAULT '{}'::jsonb,
  allowed_accounts uuid[],                      -- NULL = tous les comptes
  max_amount       numeric(18,2) CHECK (max_amount IS NULL OR max_amount > 0),
  is_active        boolean NOT NULL DEFAULT true,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (business_id, user_id)
);

-- ---------------------------------------------------------------------
-- 4. accounts : خزينة / بنك / CCP
-- ---------------------------------------------------------------------
CREATE TABLE accounts (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id     uuid NOT NULL REFERENCES businesses(id),
  name            text NOT NULL,
  kind            account_kind NOT NULL,
  bank_name       text,
  account_number  text,
  opening_balance numeric(18,2) NOT NULL DEFAULT 0,
  opening_date    date NOT NULL DEFAULT (now() AT TIME ZONE 'Africa/Algiers')::date,
  requires_session boolean NOT NULL DEFAULT false, -- caisse avec ouverture/clôture
  is_active       boolean NOT NULL DEFAULT true,
  sort_order      int NOT NULL DEFAULT 0,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, business_id),
  UNIQUE (business_id, name)
);

-- ---------------------------------------------------------------------
-- payment_methods : Cash, CCP, BaridiMob, Banque, Chèque, Autre
-- business_id NULL = mode global
-- ---------------------------------------------------------------------
CREATE TABLE payment_methods (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid REFERENCES businesses(id),
  code        text NOT NULL,
  name_ar     text NOT NULL,
  name_fr     text NOT NULL,
  name_en     text NOT NULL,
  is_active   boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX payment_methods_code_uq ON payment_methods (coalesce(business_id, '00000000-0000-0000-0000-000000000000'::uuid), code);

-- ---------------------------------------------------------------------
-- 5. categories (par entreprise et par type d'opération)
-- ---------------------------------------------------------------------
CREATE TABLE categories (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES businesses(id),
  txn_type    txn_type NOT NULL CHECK (txn_type IN ('income','expense','purchase','deposit','withdrawal')),
  name        text NOT NULL,
  icon        text,
  color       text,
  is_active   boolean NOT NULL DEFAULT true,
  sort_order  int NOT NULL DEFAULT 0,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, business_id),
  UNIQUE (business_id, txn_type, name)
);

-- ---------------------------------------------------------------------
-- suppliers : المورّدون
-- ---------------------------------------------------------------------
CREATE TABLE suppliers (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES businesses(id),
  name        text NOT NULL,
  phone       text,
  address     text,
  notes       text,
  is_active   boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, business_id)
);
CREATE UNIQUE INDEX suppliers_name_uq ON suppliers (business_id, lower(name));

-- ---------------------------------------------------------------------
-- employees : العمّال (pas forcément des utilisateurs)
-- ---------------------------------------------------------------------
CREATE TABLE employees (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id    uuid NOT NULL REFERENCES businesses(id),
  full_name      text NOT NULL,
  job_title      text,
  phone          text,
  monthly_salary numeric(18,2) NOT NULL CHECK (monthly_salary >= 0),
  start_date     date NOT NULL,
  end_date       date,
  is_active      boolean NOT NULL DEFAULT true,
  notes          text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, business_id)
);

-- ---------------------------------------------------------------------
-- 8. transfers : تحويل بين الحسابات / بين المؤسسات
-- ---------------------------------------------------------------------
CREATE TABLE transfers (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ref_no           bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
  kind             transfer_kind NOT NULL,
  from_business_id uuid NOT NULL,
  from_account_id  uuid NOT NULL,
  to_business_id   uuid NOT NULL,
  to_account_id    uuid NOT NULL,
  amount           numeric(18,2) NOT NULL CHECK (amount > 0),
  transfer_date    timestamptz NOT NULL,
  reference        text,
  description      text,
  status           txn_status NOT NULL DEFAULT 'validated',
  cancel_reason    text,
  cancelled_by     uuid REFERENCES users(id),
  cancelled_at     timestamptz,
  created_by       uuid NOT NULL REFERENCES users(id),
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (from_account_id, from_business_id) REFERENCES accounts(id, business_id),
  FOREIGN KEY (to_account_id,   to_business_id)   REFERENCES accounts(id, business_id),
  CHECK (from_account_id <> to_account_id),
  CHECK ((kind = 'internal'       AND from_business_id =  to_business_id) OR
         (kind = 'inter_business' AND from_business_id <> to_business_id))
);

-- ---------------------------------------------------------------------
-- cheques : الشيكات
-- ---------------------------------------------------------------------
CREATE TABLE cheques (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id      uuid NOT NULL REFERENCES businesses(id),
  direction        cheque_direction NOT NULL,
  cheque_number    text NOT NULL,
  bank_name        text,
  party_name       text NOT NULL,                 -- tireur (reçu) ou bénéficiaire (émis)
  amount           numeric(18,2) NOT NULL CHECK (amount > 0),
  issue_date       date NOT NULL,
  due_date         date,
  status           cheque_status NOT NULL,
  account_id       uuid,                          -- compte bancaire/CCP d'encaissement ou de paiement
  txn_type         txn_type NOT NULL,             -- type de l'opération générée à l'encaissement
  category_id      uuid,
  supplier_id      uuid,
  settlement_txn_id uuid,                         -- opération créée à l'encaissement/paiement
  deposited_at     timestamptz,
  settled_at       timestamptz,
  rejected_at      timestamptz,
  status_reason    text,
  notes            text,
  created_by       uuid NOT NULL REFERENCES users(id),
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, business_id),
  FOREIGN KEY (account_id, business_id)  REFERENCES accounts(id, business_id),
  FOREIGN KEY (category_id, business_id) REFERENCES categories(id, business_id),
  FOREIGN KEY (supplier_id, business_id) REFERENCES suppliers(id, business_id),
  CHECK ((direction = 'received' AND status IN ('in_portfolio','deposited','cleared','rejected') AND txn_type IN ('income','deposit'))
      OR (direction = 'issued'   AND status IN ('issued','cleared','cancelled')               AND txn_type IN ('expense','purchase','withdrawal')))
);
CREATE UNIQUE INDEX cheques_number_uq ON cheques (business_id, direction, coalesce(bank_name,''), cheque_number);

-- ---------------------------------------------------------------------
-- 9. cash_sessions : ouverture / clôture de caisse
-- ---------------------------------------------------------------------
CREATE TABLE cash_sessions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id     uuid NOT NULL,
  account_id      uuid NOT NULL,
  session_date    date NOT NULL,
  opening_balance numeric(18,2) NOT NULL,        -- solde théorique au début du jour
  declared_opening numeric(18,2),                -- montant compté à l'ouverture (facultatif)
  status          session_status NOT NULL DEFAULT 'open',
  opened_by       uuid NOT NULL REFERENCES users(id),
  opened_at       timestamptz NOT NULL DEFAULT now(),
  closed_by       uuid REFERENCES users(id),
  closed_at       timestamptz,
  notes           text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, session_date),
  UNIQUE (id, business_id),
  FOREIGN KEY (account_id, business_id) REFERENCES accounts(id, business_id)
);

-- ---------------------------------------------------------------------
-- 10. cash_reconciliations : rapprochement physique (historique conservé)
-- ---------------------------------------------------------------------
CREATE TABLE cash_reconciliations (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id          uuid NOT NULL,
  business_id         uuid NOT NULL,
  theoretical_balance numeric(18,2) NOT NULL,
  physical_balance    numeric(18,2) NOT NULL,
  difference          numeric(18,2) GENERATED ALWAYS AS (physical_balance - theoretical_balance) STORED,
  result              text GENERATED ALWAYS AS (
                        CASE WHEN physical_balance > theoretical_balance THEN 'surplus'
                             WHEN physical_balance < theoretical_balance THEN 'deficit'
                             ELSE 'balanced' END) STORED,
  adjustment_txn_id   uuid,
  reason              text,
  confirmed_by        uuid NOT NULL REFERENCES users(id),
  confirmed_at        timestamptz NOT NULL DEFAULT now(),
  is_current          boolean NOT NULL DEFAULT true,   -- false après réouverture
  FOREIGN KEY (session_id, business_id) REFERENCES cash_sessions(id, business_id)
);
CREATE UNIQUE INDEX cash_reconciliations_current_uq ON cash_reconciliations (session_id) WHERE is_current;

-- ---------------------------------------------------------------------
-- 6. transactions : le grand livre
-- ---------------------------------------------------------------------
CREATE TABLE transactions (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ref_no            bigint GENERATED ALWAYS AS IDENTITY UNIQUE,  -- numéro lisible
  business_id       uuid NOT NULL REFERENCES businesses(id),
  account_id        uuid NOT NULL,
  category_id       uuid,
  transaction_type  txn_type NOT NULL,
  direction         smallint GENERATED ALWAYS AS (cashpro.txn_direction(transaction_type)) STORED,
  amount            numeric(18,2) NOT NULL CHECK (amount > 0),
  signed_amount     numeric(18,2) GENERATED ALWAYS AS (amount * cashpro.txn_direction(transaction_type)) STORED,
  transaction_date  timestamptz NOT NULL DEFAULT now(),
  local_date        date GENERATED ALWAYS AS ((timezone('Africa/Algiers', transaction_date))::date) STORED,
  payment_method_id uuid REFERENCES payment_methods(id),
  supplier_id       uuid,
  employee_id       uuid,
  payroll_period    date CHECK (payroll_period IS NULL OR extract(day FROM payroll_period) = 1),
  transfer_id       uuid REFERENCES transfers(id),
  cheque_id         uuid,
  reconciliation_id uuid REFERENCES cash_reconciliations(id),
  corrects_id       uuid REFERENCES transactions(id),
  description       text,
  reference         text,
  notes             text,
  status            txn_status NOT NULL DEFAULT 'validated',
  cancel_reason     text,
  cancelled_by      uuid REFERENCES users(id),
  cancelled_at      timestamptz,
  created_by        uuid NOT NULL REFERENCES users(id),
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (account_id, business_id)  REFERENCES accounts(id, business_id),
  FOREIGN KEY (category_id, business_id) REFERENCES categories(id, business_id),
  FOREIGN KEY (supplier_id, business_id) REFERENCES suppliers(id, business_id),
  FOREIGN KEY (employee_id, business_id) REFERENCES employees(id, business_id),
  FOREIGN KEY (cheque_id, business_id)   REFERENCES cheques(id, business_id),
  -- cohérence des liens selon le type
  CHECK (transaction_type NOT IN ('income','expense','purchase') OR category_id IS NOT NULL),
  CHECK ((transaction_type IN ('transfer_in','transfer_out')) = (transfer_id IS NOT NULL)),
  CHECK ((transaction_type IN ('salary_advance','salary_payment')) = (employee_id IS NOT NULL AND payroll_period IS NOT NULL)),
  CHECK (transaction_type NOT IN ('adjustment_in','adjustment_out') OR reconciliation_id IS NOT NULL),
  CHECK (supplier_id IS NULL OR transaction_type IN ('purchase','expense')),
  CHECK ((status = 'cancelled') = (cancelled_at IS NOT NULL AND cancel_reason IS NOT NULL))
);
CREATE INDEX transactions_business_date_idx ON transactions (business_id, transaction_date DESC);
CREATE INDEX transactions_account_date_idx  ON transactions (account_id, local_date) WHERE status = 'validated';
CREATE INDEX transactions_type_idx          ON transactions (business_id, transaction_type, local_date);
CREATE INDEX transactions_category_idx      ON transactions (category_id);
CREATE INDEX transactions_created_by_idx    ON transactions (created_by);
CREATE INDEX transactions_search_idx        ON transactions USING gin (to_tsvector('simple', coalesce(description,'') || ' ' || coalesce(reference,'') || ' ' || coalesce(notes,'')));

ALTER TABLE cheques ADD FOREIGN KEY (settlement_txn_id) REFERENCES transactions(id);
ALTER TABLE cash_reconciliations ADD FOREIGN KEY (adjustment_txn_id) REFERENCES transactions(id);

-- ---------------------------------------------------------------------
-- payroll_items : primes / retenues (les avances et paiements sont
-- des transactions ; primes et retenues ne déplacent pas d'argent)
-- ---------------------------------------------------------------------
CREATE TABLE payroll_items (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL,
  employee_id uuid NOT NULL,
  period      date NOT NULL CHECK (extract(day FROM period) = 1),
  kind        payroll_kind NOT NULL CHECK (kind IN ('bonus','deduction')),
  amount      numeric(18,2) NOT NULL CHECK (amount > 0),
  reason      text NOT NULL,
  status      txn_status NOT NULL DEFAULT 'validated',
  cancel_reason text,
  cancelled_by uuid REFERENCES users(id),
  cancelled_at timestamptz,
  created_by  uuid NOT NULL REFERENCES users(id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (employee_id, business_id) REFERENCES employees(id, business_id)
);

-- ---------------------------------------------------------------------
-- 7. transaction_attachments : pièces jointes (fichiers sur disque serveur)
-- ---------------------------------------------------------------------
CREATE TABLE transaction_attachments (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id    uuid NOT NULL REFERENCES businesses(id),
  transaction_id uuid REFERENCES transactions(id),
  cheque_id      uuid REFERENCES cheques(id),
  kind           text NOT NULL DEFAULT 'other' CHECK (kind IN ('invoice','receipt','screenshot','pdf','cheque_scan','other')),
  storage_key    text NOT NULL UNIQUE,           -- chemin relatif dans le dossier des pièces jointes
  file_name      text NOT NULL,
  mime_type      text NOT NULL,
  size_bytes     bigint NOT NULL CHECK (size_bytes > 0 AND size_bytes <= 20971520),
  sha256         text NOT NULL,
  is_active      boolean NOT NULL DEFAULT true,
  uploaded_by    uuid NOT NULL REFERENCES users(id),
  uploaded_at    timestamptz NOT NULL DEFAULT now(),
  CHECK (transaction_id IS NOT NULL OR cheque_id IS NOT NULL)
);

-- ---------------------------------------------------------------------
-- 11. audit_logs : سجل التعديلات (append-only)
-- ---------------------------------------------------------------------
CREATE TABLE audit_logs (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  user_id     uuid,
  business_id uuid,
  table_name  text NOT NULL,
  record_id   text NOT NULL,
  action      text NOT NULL,                     -- create / update / cancel / reopen / login ...
  old_values  jsonb,
  new_values  jsonb,
  changed     text[],                            -- colonnes modifiées
  reason      text,
  client_info text                               -- poste / IP
);
CREATE INDEX audit_logs_record_idx   ON audit_logs (table_name, record_id);
CREATE INDEX audit_logs_business_idx ON audit_logs (business_id, occurred_at DESC);
CREATE INDEX audit_logs_user_idx     ON audit_logs (user_id, occurred_at DESC);

-- ---------------------------------------------------------------------
-- 12. app_settings
-- ---------------------------------------------------------------------
CREATE TABLE app_settings (
  key        text PRIMARY KEY,
  value      jsonb NOT NULL,
  updated_by uuid REFERENCES users(id),
  updated_at timestamptz NOT NULL DEFAULT now()
);
