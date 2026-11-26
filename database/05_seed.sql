-- =====================================================================
-- CashPro — 05_seed.sql : configuration initiale
-- Game Force (محل الألعاب) + ETP (ألياف بصرية / كاميرات / أمن)
-- À exécuter une seule fois, en superutilisateur, à l'installation.
-- Le mot de passe admin est forcé à changer à la première connexion.
-- =====================================================================
SET search_path = cashpro, public;

-- Administrateur principal (mot de passe initial : CashPro@2026)
INSERT INTO users (id, username, full_name, password_hash, role, locale, theme)
VALUES ('00000000-0000-0000-0000-000000000001', 'admin', 'Administrateur',
        crypt('CashPro@2026', gen_salt('bf', 12)), 'admin', 'ar', 'game-force-dark');
SELECT set_config('cashpro.user_id', '00000000-0000-0000-0000-000000000001', false);
SELECT set_config('cashpro.reason', 'Installation initiale', false);

-- Paramètres généraux
INSERT INTO app_settings (key, value) VALUES
  ('app_name',              '"CashPro"'),
  ('app_logo',              'null'),
  ('default_locale',        '"ar"'),
  ('currency',              '"DZD"'),
  ('currency_symbol',       '"DA"'),
  ('date_format',           '"DD/MM/YYYY"'),
  ('timezone',              '"Africa/Algiers"'),
  ('default_theme',         '"game-force-dark"'),
  ('allow_negative_cash',   'false'),
  ('force_password_change', '["00000000-0000-0000-0000-000000000001"]'),
  ('backup',                '{"daily_time": "23:30", "retention_days": 30, "retention_months": 12, "offsite_path": null}'),
  ('notifications',         '{"cheque_due_days": 3, "cash_difference_alert": true, "unclosed_session_alert": true}');

-- Modes de paiement globaux
INSERT INTO payment_methods (code, name_ar, name_fr, name_en) VALUES
  ('cash',      'نقداً',       'Espèces',   'Cash'),
  ('ccp',       'CCP',         'CCP',       'CCP'),
  ('baridimob', 'بريدي موب',   'BaridiMob', 'BaridiMob'),
  ('bank',      'تحويل بنكي',  'Banque',    'Bank transfer'),
  ('cheque',    'شيك',         'Chèque',    'Cheque'),
  ('other',     'أخرى',        'Autre',     'Other');

-- ---------------------------------------------------------------------
-- Entreprises
-- ---------------------------------------------------------------------
INSERT INTO businesses (id, code, name, activity, color, sort_order) VALUES
  ('10000000-0000-0000-0000-000000000001', 'GF',  'Game Force', 'PlayStation & Gaming Store', '#E30613', 1),
  ('10000000-0000-0000-0000-000000000002', 'ETP', 'ETP', 'Fibre optique, caméras de surveillance, systèmes de sécurité', '#1F2A7A', 2);

-- Comptes : خزينة / بنك / بريد (soldes initiaux à saisir par l'admin)
INSERT INTO accounts (business_id, name, kind, requires_session, sort_order) VALUES
  ('10000000-0000-0000-0000-000000000001', 'Caisse principale', 'cash', true,  1),
  ('10000000-0000-0000-0000-000000000001', 'Compte bancaire',   'bank', false, 2),
  ('10000000-0000-0000-0000-000000000001', 'CCP',               'ccp',  false, 3),
  ('10000000-0000-0000-0000-000000000002', 'Caisse principale', 'cash', true,  1),
  ('10000000-0000-0000-0000-000000000002', 'Compte bancaire',   'bank', false, 2),
  ('10000000-0000-0000-0000-000000000002', 'CCP',               'ccp',  false, 3);

-- ---------------------------------------------------------------------
-- Catégories — Game Force
-- ---------------------------------------------------------------------
INSERT INTO categories (business_id, txn_type, name, icon, color, sort_order)
SELECT '10000000-0000-0000-0000-000000000001', t::txn_type, n, i, c, o FROM (VALUES
  -- recettes
  ('income',   'Ventes consoles',          'gamepad-2',     '#22C55E', 1),
  ('income',   'Ventes jeux vidéo',        'disc-3',        '#16A34A', 2),
  ('income',   'Ventes manettes & accessoires', 'joystick', '#15803D', 3),
  ('income',   'Réparations / services',   'wrench',        '#4ADE80', 4),
  ('income',   'Recettes diverses',        'coins',         '#86EFAC', 5),
  -- achats (نوع الشراء)
  ('purchase', 'Achat PlayStation',        'gamepad-2',     '#3B82F6', 1),
  ('purchase', 'Achat Xbox',               'gamepad',       '#2563EB', 2),
  ('purchase', 'Achat Nintendo',           'gamepad',       '#1D4ED8', 3),
  ('purchase', 'Achat jeux vidéo',         'disc-3',        '#60A5FA', 4),
  ('purchase', 'Achat manettes',           'joystick',      '#93C5FD', 5),
  ('purchase', 'Achat accessoires',        'headphones',    '#1E40AF', 6),
  -- dépenses opérationnelles
  ('expense',  'Transport',                'truck',         '#F97316', 1),
  ('expense',  'Électricité',              'zap',           '#EAB308', 2),
  ('expense',  'Internet',                 'wifi',          '#06B6D4', 3),
  ('expense',  'Loyer',                    'home',          '#A855F7', 4),
  ('expense',  'Maintenance',              'wrench',        '#64748B', 5),
  ('expense',  'Autres dépenses',          'receipt',       '#94A3B8', 9),
  -- apports / retraits
  ('deposit',    'Apport personnel',       'piggy-bank',    '#10B981', 1),
  ('deposit',    'Autres entrées',         'plus-circle',   '#34D399', 2),
  ('withdrawal', 'Retrait personnel',      'wallet',        '#EF4444', 1)
) v(t, n, i, c, o);

-- ---------------------------------------------------------------------
-- Catégories — ETP
-- ---------------------------------------------------------------------
INSERT INTO categories (business_id, txn_type, name, icon, color, sort_order)
SELECT '10000000-0000-0000-0000-000000000002', t::txn_type, n, i, c, o FROM (VALUES
  ('income',   'Prestations fibre optique',          'cable',        '#22C55E', 1),
  ('income',   'Installation caméras',               'cctv',         '#16A34A', 2),
  ('income',   'Installation systèmes de sécurité',  'shield-check', '#15803D', 3),
  ('income',   'Maintenance',                        'wrench',       '#4ADE80', 4),
  ('income',   'Autres prestations',                 'briefcase',    '#86EFAC', 5),
  ('purchase', 'Fibre optique',                      'cable',        '#3B82F6', 1),
  ('purchase', 'Câbles réseau',                      'network',      '#2563EB', 2),
  ('purchase', 'Caméras',                            'cctv',         '#1D4ED8', 3),
  ('purchase', 'DVR / NVR',                          'hard-drive',   '#60A5FA', 4),
  ('purchase', 'Routeurs',                           'router',       '#93C5FD', 5),
  ('purchase', 'Switches',                           'server',       '#1E40AF', 6),
  ('purchase', 'Matériel technique',                 'toolbox',      '#3730A3', 7),
  ('expense',  'Transport',                          'truck',        '#F97316', 1),
  ('expense',  'Carburant',                          'fuel',         '#EA580C', 2),
  ('expense',  'Location',                           'home',         '#A855F7', 3),
  ('expense',  'Électricité',                        'zap',          '#EAB308', 4),
  ('expense',  'Maintenance',                        'wrench',       '#64748B', 5),
  ('expense',  'Sous-traitance techniciens',         'hard-hat',     '#0EA5E9', 6),
  ('expense',  'Autres dépenses',                    'receipt',      '#94A3B8', 9),
  ('deposit',    'Apport personnel',                 'piggy-bank',   '#10B981', 1),
  ('deposit',    'Autres entrées',                   'plus-circle',  '#34D399', 2),
  ('withdrawal', 'Retrait personnel',                'wallet',       '#EF4444', 1)
) v(t, n, i, c, o);

SELECT set_config('cashpro.reason', '', false);
