# CashPro API — référence (v1.2.0)

Base : `http://<serveur>:4600/api` — JSON — authentification `Authorization: Bearer <jeton>`.
Montants : chaînes décimales (`"12500.00"`), jamais de float. Dates : `AAAA-MM-JJ`, horodatages ISO 8601.
Fuseau : Africa/Algiers. En-tête optionnel `X-CashPro-Client: <nom du poste>` (tracé dans l'audit).

## Erreurs

`{ "error": { "code", "message", "details" } }`

| HTTP | Codes fréquents |
|---|---|
| 401 | `UNAUTHENTICATED`, `TOKEN_INVALID`, `BAD_CREDENTIALS` |
| 403 | `CP003` permission, `CP004` admin, `CP026` compte non autorisé, `CP027` plafond, `PASSWORD_CHANGE_REQUIRED`, `ACCOUNT_DISABLED` |
| 409 | `CP010` journée clôturée, `CP032` opération liée, `CP083` statut chèque, `DUPLICATE` |
| 422 | `VALIDATION`, `CP023` catégorie, `CP028` solde caisse insuffisant, `CP075` motif d'écart, `CP093` paie > reste |
| 423 | `ACCOUNT_LOCKED` (5 échecs → 15 min) |

Toutes les règles financières et les permissions sont appliquées **dans PostgreSQL** (RLS + triggers) : l'API ne peut pas les contourner.

## Authentification
| Méthode | Route | Corps / remarques |
|---|---|---|
| POST | `/auth/login` | `{username, password, remember?, deviceName?}` → `{token, refreshToken?, refreshExpiresAt?, user{mustChangePassword}}` ; `remembered:false` si « تذكّرني » est interdit pour ce compte |
| POST | `/auth/refresh` | `{refreshToken}` → nouveau `token` **et nouveau** `refreshToken` (l'ancien devient invalide) ; 401 `REFRESH_INVALID` si révoqué, expiré, mot de passe changé, compte désactivé ou option retirée |
| POST | `/auth/logout` | `{refreshToken?}` → 204 ; révoque l'appareil mémorisé |
| GET | `/auth/devices?userId?` | appareils mémorisés actifs (les siens ; ceux d'un autre pour l'admin) — l'empreinte du jeton n'est jamais renvoyée |
| POST | `/auth/devices/revoke` | `{userId?, deviceId?}` → `{revoked}` ; sans `deviceId` : tous les appareils |
| GET | `/auth/me` | utilisateur, activités accessibles + permissions effectives, paramètres d'affichage |
| PATCH | `/auth/me` | `{fullName?, locale?, theme?, email?, phone?}` |
| POST | `/auth/change-password` | `{currentPassword, newPassword, remember?, deviceName?}` → nouveau jeton (obligatoire si `mustChangePassword`) ; révoque tous les appareils mémorisés, ce poste est re-mémorisé si `remember` |

## Activités, comptes, catégories, fournisseurs
| | Route | |
|---|---|---|
| GET | `/businesses` | activités accessibles |
| POST/PATCH | `/businesses`, `/businesses/:id` | admin ; création = 3 comptes par défaut |
| GET/POST | `/businesses/:id/logo` | logo (PNG/JPG/SVG/WebP, admin) ; `GET …/logo/history`, `POST …/logo/restore {key}` |
| GET/POST | `/businesses/:id/accounts` | comptes utilisés par l'activité (propres + communs) : `owned, shared, business_ids, business_names` ; soldes avec `view_balances` ; création admin `{…, businessIds?}` |
| PATCH | `/accounts/:id` | admin ; solde initial figé dès la 1re opération ; `businessIds` = activités qui utilisent le compte (propriétaire toujours incluse ; retrait refusé `CP044` si opérations/utilisateurs) |
| GET/POST | `/businesses/:id/categories` `?type=&opType=any\|<id>` | sans `opType`, `type` ne renvoie que les catégories des types de base ; création `{…, opTypeId?}` (la base suit le sens du type, `CP101`) ; `parent_id, parent_name, children` ; création `{txnType, name, color?, parentId?, allBusinesses?}` (2 niveaux max, `CP046`) ; `PATCH /categories/:id {…, parentId}` |
| GET/POST | `/businesses/:id/suppliers` `?q=` | ; `PATCH /suppliers/:id` |
| GET | `/op-types?all=` | 1.2.0 — types d'opération personnalisés : `{id, name, direction (1/-1), dir: in/out, base_type: income/expense, color, is_active, used}` |
| POST | `/op-types` | admin : `{name, direction: in\|out, color?}` (nom unique, `DUPLICATE`) |
| PATCH | `/op-types/:id` | admin : `{name?, color?, isActive?}` — le sens ne change jamais (`CP100`) |
| GET | `/payment-methods` | |

## Opérations
| | Route | |
|---|---|---|
| GET | `/transactions` | filtres `businessId, accountId, categoryId, supplierId, type (répétable), opTypeId (<id> ou none), from, to, status, q, page, limit` → `{items, total, totalIn, totalOut}` ; chaque ligne : `op_type_id, op_type_name, op_type_color` (type personnalisé, déduit de la catégorie ; changer de type = correction, `CP104` ; type désactivé `CP103`) |
| GET | `/transactions/:id` | + pièces jointes, historique des modifications, corrections |
| POST | `/transactions` | `{businessId, accountId, type: income/expense/purchase/deposit/withdrawal, amount, categoryId, date?, paymentMethodId?, supplierId? \| newSupplier{name, phone}, description?, reference?, notes?}` |
| POST | `/transactions/split` | 1.1.0 — ventilation d'une dépense/achat d'un compte commun : `{accountId, type: expense/purchase, total, date?, paymentMethodId?, description?, reference?, notes?, parts: [{businessId, categoryId, amount, supplierId?}]}` (≥ 2 parts, somme = total, `CP049`) → `{splitId, items}` ; annuler une part annule toute la ventilation |
| PATCH | `/transactions/:id` | champs non financiers seulement (`description, reference, notes, categoryId, paymentMethodId, supplierId`) |
| POST | `/transactions/:id/cancel` | `{reason}` — transfert : annule les 2 côtés ; paie : via la paie ; chèque/écart : refusé (`CP032`) |
| POST | `/transactions/:id/correct` | `{reason, amount?, date?, accountId?, categoryId?}` = annulation + nouvelle opération liée |
| POST | `/transactions/:id/attachments` | multipart `file` (PDF/PNG/JPG/WebP ≤ 20 Mo) + `kind` |
| GET | `/attachments/:id` | téléchargement ; `POST /attachments/:id/deactivate {reason}` |
| GET/POST | `/transfers` | `{fromAccountId, toAccountId, amount, date?, reference?, description?, fromBusinessId?, toBusinessId?}` (activité imputée si compte commun) (interne ou entre activités) ; `POST /transfers/:id/cancel {reason}` |

## Chèques (même logique que PALM TOURS)
`GET /cheques?businessId&direction&status&pending&dueBefore`, `GET /cheques/:id` (+ historique)
- Reçu : `POST /cheques/receive {businessId, number, bank?, drawer, amount, issueDate, dueDate?, txnType=income|deposit, categoryId}` → `POST /cheques/:id/deposit {accountId}` → `POST /cheques/:id/clear` (crée la recette) ou `POST /cheques/:id/reject {reason}` (annule la recette si déjà encaissé)
- Émis : `POST /cheques/issue {businessId, accountId, number, payee, amount, issueDate, dueDate?, txnType, categoryId, supplierId?}` → `clear` (débit) ou `cancel {reason}`

## Caisse
| | Route | |
|---|---|---|
| GET | `/cash/status?accountId=` | session du jour, sessions non clôturées, solde théorique, entrées/sorties du jour |
| GET | `/cash/sessions` | `?accountId&businessId&from&to` (historique des clôtures) |
| POST | `/cash/sessions/open` | `{accountId, date?, declared?, notes?}` |
| POST | `/cash/sessions/:id/close` | `{physical, reason?}` — écart : motif obligatoire ; employé → `pending_review`, responsable → تسوية automatique |
| POST | `/cash/sessions/:id/approve` | `{reason?}` (permission `adjustment`) |
| POST | `/cash/sessions/:id/reopen` | `{reason}` admin uniquement |

## Personnel et paie
`GET/POST /businesses/:id/employees`, `PATCH /employees/:id`, `GET /employees/:id/statement`
`POST /payroll/advance` et `/payroll/payment` `{employeeId, period, amount, accountId, date?, notes?}`
`POST /payroll/items {employeeId, period, kind: bonus|deduction, amount, reason}`, `POST /payroll/items/:id/cancel {reason}`
`GET /payroll/monthly?businessId&employeeId&period` → salaire, primes, retenues, avances, payé, reste, dette reportée, statut

## Tableau de bord et rapports
| | Route | |
|---|---|---|
| GET | `/dashboard` | KPI (solde global, recettes/dépenses/achats du jour + % vs hier), cartes d'activité, courbe 30 jours, répartition du mois, alertes (chèques à échéance, clôtures en attente, caisses non clôturées, salaires non payés) |
| GET | `/reports/daily?businessId&date` | ouverture + flux = clôture |
| GET | `/reports/summary?businessId?&from&to&groupBy=day\|month` | par activité + totaux consolidés |
| GET | `/reports/expense-distribution`, `/reports/income-by-category` | `?businessId?&from&to` |
| GET | `/reports/balance-series?businessId&from&to` | courbe du solde |
| GET | `/reports/balances` | soldes par compte |
| GET | `/audit` | `?businessId&userId&table&recordId&action&from&to&page&limit` (سجل التعديلات) |
| GET | `/export/transactions?format=xlsx\|csv\|pdf&lang=ar\|fr\|en` + filtres d'opérations | permission `export` ; logo dans l'en-tête |

## Alertes d'activité (admin) — 1.2.0
| | Route | |
|---|---|---|
| GET | `/alerts/count` | `{unread}` : ajouts / modifications / annulations des autres utilisateurs non vus |
| GET | `/alerts?unread=1&businessId&page&limit` | `{items[{id, occurred_at, action, user_name, business_name, table_name, record_id, ref_no, transaction_type, op_type_name, amount, category_name, changed, old_values, new_values, reason, reviewed}], total, unread}` |
| POST | `/alerts/mark` | `{ids?}` (sans ids : tout) → `{marked, unread}` — « vu » propre à chaque administrateur |

Paramètre `activity_alerts` : `{events: all\|changes, min_amount: number\|null, include_admins: bool}`.

## Administration (admin)
`GET/POST /users`, `PATCH /users/:id {fullName, role, isActive, unlock, …}`, `POST /users/:id/reset-password {newPassword}`
`PUT /users/:id/businesses/:businessId {profile: employee|manager, permissions{clé: bool}, allowedAccounts[], maxAmount, isActive, resetToDefaults}`
`GET /permissions/defaults`, `GET /settings`, `PUT /settings/:key {value}`, `GET/POST /settings/logo`
`GET /admin/network` → `{hostname, port, addresses[{address, kind: lan\|vpn, iface}]}` — adresses du serveur à saisir dans les postes (1.2.0 : plus de Tailscale intégré ; VPN installé à part, ex. Tailscale officiel)

Clés de permission : `add_income, add_expense, add_purchase, deposit_withdrawal, transfer, cheques, payroll, edit_own, edit_any, cancel, view_balances, view_all_transactions, cash_session, adjustment, view_reports, export, view_audit, manage_categories, manage_suppliers, manage_employees`.

Paramètre `remember_me` : `{enabled, days (1–365), admin, users}` — « تذكّرني » (table `auth_devices`, script `08_devices.sql`).

## Google Sheets et Google Drive (admin) — 1.3.0
| Méthode | Route | Remarques |
|---|---|---|
| GET | `/admin/sheets` | `{enabled, url, intervalMin, configuredBy, state{lastRunAt, lastOkAt, lastDataAt, lastError, lastErrorAt, rows}}` — le jeton n'est jamais renvoyé |
| PUT | `/admin/sheets` | `{url?, enabled?, intervalMin? (1–1440)}` ; `url` = `https://script.google.com/macros/s/…/exec` uniquement. Les données sont lues avec les droits de l'administrateur qui enregistre |
| POST | `/admin/sheets/run` | synchronise maintenant (instantané complet) |
| POST | `/admin/sheets/token` | nouveau jeton (le script doit être recollé) |
| GET | `/admin/sheets/script` | script Apps Script (`CashPro-Sheets.gs`) avec le jeton |
| GET/PUT | `/admin/backup/offsite` | `{path \| null}` : dossier Google Drive (mode miroir) où `backup.ps1` copie la sauvegarde de 23:30 (`<dossier>\CashPro-Backups`) ; vérifié en écriture. `GET` liste aussi les dossiers Drive trouvés |

Fonctionnement : toutes les N minutes (5 par défaut), instantané de 6 feuilles (الملخص, أرصدة الحسابات, العمليات ≤ 50 000, الشيكات, الأجور, الملخص الشهري) envoyé en JSON à l'application Web ; s'il est inchangé, simple « ping » (`آخر اتصال بالخادم`). Échec (Internet) : nouvel essai au tour suivant. Configuration : `C:\CashPro\config\sheets.json`.

## Mode hors connexion — 1.3.6

- `POST /transactions`, `POST /transactions/split`, `POST /transfers` acceptent l'en-tête facultatif `Idempotency-Key: <uuid>`
  (généré par l'appareil au moment de la saisie). Un renvoi de la même clé ne crée rien : réponse du premier enregistrement
  + en-tête `Idempotent-Replayed: true`. Clé d'un autre utilisateur / d'un autre type d'envoi → 409 `CP105`.
  Réservation de la clé dans la même transaction SQL que l'opération (`idem_begin` / `idem_finish`, `database/11_offline.sql`).
- `GET /offline-manifest.json` : liste des fichiers de l'interface + version (copie gardée par l'application Android).
- `GET /sw.js` : service worker (copie de l'interface sur le poste Windows / navigateur sûr), version = celle du manifeste.
- Interface : file d'envoi `localStorage['cp.outbox']`, copie des lectures `cp.cache:*` (session, comptes, catégories,
  fournisseurs, tableau de bord) ; envoi automatique au retour de la connexion (vérification toutes les 10 s).

## Mises à jour
| Méthode | Route | Remarques |
|---|---|---|
| GET | `/updates/client` | **sans connexion** : `{version, file, sha512, size, url}` de l'installateur des postes (`C:\CashPro\updates\client\latest.yml`), 404 `UPDATE_NO_CLIENT` sinon |
| GET | `/updates/client/file` | **sans connexion** : l'installateur des postes (vérifié par l'application avec le SHA-512) |
| GET | `/updates/server` | admin : version installée, dernière version publiée (GitHub Releases), `available`, `status` (`idle, downloading, backup, installing, failed`), `progress`, `error` ; vérification automatique 1 fois / 24 h |
| POST | `/updates/server/check` | admin : vérifie maintenant |
| POST | `/updates/server/install` | admin, serveur Windows : téléchargement + SHA-256 → **sauvegarde obligatoire** → installation silencieuse (`run-update.ps1`, tâche « CashPro - Mise a jour ») → redémarrage ; 202 |
| PUT | `/updates/server/config` | admin : `{repo?: "propriétaire/dépôt", token?: string \| null}` — jeton GitHub lecture seule, gardé dans `C:\CashPro\config\update.json`, jamais renvoyé |
