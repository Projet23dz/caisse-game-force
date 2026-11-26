/**
 * Tests d'intégration de l'API CashPro sur une vraie base PostgreSQL.
 * Prérequis : PostgreSQL 16 local. Variables :
 *   TEST_ADMIN_URL  connexion superutilisateur (défaut postgres://postgres@localhost:5432/postgres)
 *   TEST_DB         nom de la base de test créée/écrasée (défaut cashpro_api_test)
 *   SQL_DIR         dossier des scripts SQL (défaut ../database)
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { Client } from 'pg';
import { createApp } from '../app';
import { Database } from '../db';
import { findSetupDir } from '../routes/updates';

const ADMIN_URL = process.env.TEST_ADMIN_URL ?? 'postgres://postgres@localhost:5432/postgres';
const TEST_DB = process.env.TEST_DB ?? 'cashpro_api_test';
const SQL_DIR = process.env.SQL_DIR ?? path.resolve(__dirname, '../../../database');
const GF = '10000000-0000-0000-0000-000000000001';
const ETP = '10000000-0000-0000-0000-000000000002';
const PNG_1PX = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

let base = '';
let db: Database;
let server: ReturnType<ReturnType<typeof createApp>['listen']>;
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cashpro-data-'));
export const artifacts: Record<string, Buffer> = {};

interface Res { status: number; body: any; headers: Headers; raw: Buffer }
async function api(method: string, url: string, token?: string | null, body?: unknown): Promise<Res> {
  const headers: Record<string, string> = {};
  if (token) headers.authorization = `Bearer ${token}`;
  let payload: BodyInit | undefined;
  if (body instanceof FormData) payload = body;
  else if (body !== undefined) { headers['content-type'] = 'application/json'; payload = JSON.stringify(body); }
  const r = await fetch(base + url, { method, headers, body: payload });
  const raw = Buffer.from(await r.arrayBuffer());
  const ct = r.headers.get('content-type') ?? '';
  return { status: r.status, headers: r.headers, raw, body: ct.includes('json') ? JSON.parse(raw.toString()) : raw.toString('utf8') };
}
const expectOk = (r: Res, status = 200) => { assert.equal(r.status, status, JSON.stringify(r.body)); return r.body; };
const expectErr = (r: Res, status: number, code?: string) => {
  assert.equal(r.status, status, JSON.stringify(r.body));
  if (code) assert.equal(r.body.error.code, code, JSON.stringify(r.body));
};

async function login(username: string, password: string) {
  return expectOk(await api('POST', '/api/auth/login', null, { username, password }));
}
async function loginReady(username: string, password: string, newPassword: string) {
  const l = await login(username, password);
  if (!l.user.mustChangePassword) return l.token as string;
  return expectOk(await api('POST', '/api/auth/change-password', l.token, { currentPassword: password, newPassword })).token as string;
}

const tokens: Record<string, string> = {};
const ids: Record<string, string> = {};
// Dates locales Africa/Algiers (UTC+1, sans heure d'été), comme le serveur
const ALG = 3600_000;
const daysAgo = (n: number) => new Date(Date.now() + ALG - n * 86400_000).toISOString().slice(0, 10);
const localDayStart = () => Math.floor((Date.now() + ALG) / 86400_000) * 86400_000 - ALG;

before(async () => {
  const admin = new Client({ connectionString: ADMIN_URL });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS ${TEST_DB} WITH (FORCE)`);
  await admin.query(`CREATE DATABASE ${TEST_DB}`);
  await admin.end();
  const u = new URL(ADMIN_URL); u.pathname = '/' + TEST_DB;
  // skip_init : garder la configuration de départ (une caisse par activité) pour ces tests
  const su = new Client({ connectionString: u.toString(), options: '-c cashpro.skip_init=on' });
  await su.connect();
  for (const f of fs.readdirSync(SQL_DIR).filter((n) => /^\d\d_.*\.sql$/.test(n)).sort().map((n) => n.slice(0, -4))) {
    await su.query(fs.readFileSync(path.join(SQL_DIR, `${f}.sql`), 'utf8'));
  }
  await su.query("ALTER ROLE cashpro_app PASSWORD 'test-app-password'");
  await su.end();
  const appUrl = new URL(u.toString()); appUrl.username = 'cashpro_app'; appUrl.password = 'test-app-password';
  db = new Database(appUrl.toString());
  const app = createApp({ db, jwtSecret: 'x'.repeat(40), jwtTtl: '1h', dataDir, maxUploadMb: 5 });
  server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  server?.close();
  await db?.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

async function accounts(token: string, biz: string): Promise<Record<string, any>> {
  const rows = expectOk(await api('GET', `/api/businesses/${biz}/accounts`, token)) as any[];
  return Object.fromEntries(rows.map((a) => [a.kind, a]));
}
async function cats(token: string, biz: string) {
  const rows = expectOk(await api('GET', `/api/businesses/${biz}/categories`, token)) as any[];
  return Object.fromEntries(rows.map((c) => [c.name, c.id]));
}
const bal = async (biz: string, kind: string) => Number((await accounts(tokens.admin, biz))[kind].balance);

describe('CashPro API', () => {
  test('santé + routes protégées', async () => {
    const hr = await api('GET', '/api/health');
    const h = expectOk(hr);
    assert.equal(h.ok, true);
    assert.equal(hr.headers.get('cache-control'), 'no-store', 'données /api jamais mises en cache (1.3.3)');
    expectErr(await api('GET', '/api/businesses'), 401, 'UNAUTHENTICATED');
    expectErr(await api('GET', '/api/businesses', 'faux.jeton.jwt'), 401, 'TOKEN_INVALID');
    expectErr(await api('GET', '/api/inconnue'), 401);
    const ui = await api('GET', '/');
    assert.equal(ui.status, 200, 'interface servie par l\'API');
    assert.match(ui.headers.get('content-type') ?? '', /text\/html/);
    assert.match(String(ui.body), /CashPro/);
    const deep = await api('GET', '/une/route/de/l-interface');
    assert.equal(deep.status, 200);
    assert.match(ui.headers.get('content-security-policy') ?? '', /script-src 'self'/);
    assert.doesNotMatch(ui.headers.get('content-security-policy') ?? '', /upgrade-insecure-requests/);
  });

  test('connexion admin : mot de passe à changer obligatoirement', async () => {
    expectErr(await api('POST', '/api/auth/login', null, { username: 'admin', password: 'mauvais' }), 401, 'BAD_CREDENTIALS');
    expectErr(await api('POST', '/api/auth/login', null, { username: 'inconnu', password: 'x' }), 401, 'BAD_CREDENTIALS');
    const l = await login('admin', 'CashPro@2026');
    assert.equal(l.user.mustChangePassword, true);
    expectErr(await api('GET', '/api/businesses', l.token), 403, 'PASSWORD_CHANGE_REQUIRED');
    expectErr(await api('POST', '/api/auth/change-password', l.token, { currentPassword: 'CashPro@2026', newPassword: 'court' }), 422, 'VALIDATION');
    tokens.admin = expectOk(await api('POST', '/api/auth/change-password', l.token,
      { currentPassword: 'CashPro@2026', newPassword: 'Admin2026!' })).token;
    const relog = await login('admin', 'Admin2026!');
    assert.equal(relog.user.mustChangePassword, false);
    const me = expectOk(await api('GET', '/api/auth/me', tokens.admin));
    assert.deepEqual(me.businesses.map((b: any) => b.code), ['GF', 'ETP']);
    assert.equal(me.businesses[0].permissions.manage_employees, true);
    assert.equal(me.settings.app_name, 'CashPro');
  });

  test('admin : soldes initiaux des comptes', async () => {
    const plan: Record<string, Record<string, number>> = { [GF]: { cash: 50000, bank: 200000, ccp: 0 }, [ETP]: { cash: 30000, bank: 100000, ccp: 0 } };
    for (const biz of [GF, ETP]) {
      for (const [kind, a] of Object.entries(await accounts(tokens.admin, biz))) {
        expectOk(await api('PATCH', `/api/accounts/${a.id}`, tokens.admin, { openingBalance: plan[biz][kind], openingDate: daysAgo(10) }));
      }
    }
    assert.equal(await bal(GF, 'cash'), 50000);
    assert.equal(await bal(ETP, 'bank'), 100000);
  });

  test('admin : utilisateurs et permissions par activité', async () => {
    const gf = await accounts(tokens.admin, GF);
    const karim = expectOk(await api('POST', '/api/users', tokens.admin, { username: 'karim', fullName: 'Karim', password: 'Karim2026' }), 201);
    const samir = expectOk(await api('POST', '/api/users', tokens.admin, { username: 'samir', fullName: 'Samir', password: 'Samir2026' }), 201);
    ids.karim = karim.id; ids.samir = samir.id;
    expectErr(await api('POST', '/api/users', tokens.admin, { username: 'karim', fullName: 'Doublon', password: 'Karim2026' }), 409, 'DUPLICATE');
    const bu = expectOk(await api('PUT', `/api/users/${karim.id}/businesses/${GF}`, tokens.admin,
      { profile: 'employee', allowedAccounts: [gf.cash.id], maxAmount: 5000 }));
    assert.equal(bu.permissions.add_purchase, false);
    assert.equal(bu.permissions.add_expense, true);
    for (const biz of [GF, ETP]) expectOk(await api('PUT', `/api/users/${samir.id}/businesses/${biz}`, tokens.admin, { profile: 'manager' }));
    expectErr(await api('PUT', `/api/users/${karim.id}/businesses/${GF}`, tokens.admin,
      { profile: 'employee', allowedAccounts: [(await accounts(tokens.admin, ETP)).cash.id] }), 422, 'INVALID_ACCOUNTS');
    tokens.karim = await loginReady('karim', 'Karim2026', 'Karim2027x');
    tokens.samir = await loginReady('samir', 'Samir2026', 'Samir2027x');
    expectErr(await api('GET', '/api/users', tokens.samir), 403);
  });

  test('admin : recette en caisse', async () => {
    const c = await cats(tokens.admin, GF);
    const gf = await accounts(tokens.admin, GF);
    const t = expectOk(await api('POST', '/api/transactions', tokens.admin, {
      businessId: GF, accountId: gf.cash.id, type: 'income', amount: '10 000', categoryId: c['Ventes consoles'],
      description: 'Vente PS5 slim', date: new Date(Math.max(Date.now() - 3600_000, localDayStart())).toISOString(),
    }), 201);
    assert.equal(t.amount, '10000.00');
    assert.equal(t.running_balance, '60000.00');
    assert.equal(await bal(GF, 'cash'), 60000);
    expectErr(await api('POST', '/api/transactions', tokens.admin, {
      businessId: GF, accountId: gf.cash.id, type: 'income', amount: 100, categoryId: c['Transport'] }), 422, 'CP023');
    expectErr(await api('POST', '/api/transactions', tokens.admin, {
      businessId: GF, accountId: gf.cash.id, type: 'expense', amount: -5, categoryId: c['Transport'] }), 422, 'VALIDATION');
    expectErr(await api('POST', '/api/transactions', tokens.admin, {
      businessId: GF, accountId: gf.cash.id, type: 'expense', amount: 999999, categoryId: c['Transport'] }), 422, 'CP028');
    expectErr(await api('POST', '/api/transactions', tokens.admin, {
      businessId: GF, accountId: (await accounts(tokens.admin, ETP)).cash.id, type: 'expense', amount: 10, categoryId: c['Transport'] }), 422, 'CP029');
  });

  test('employé : droits limités appliqués par la base', async () => {
    const c = await cats(tokens.karim, GF);
    const gf = await accounts(tokens.karim, GF);
    assert.equal(gf.cash.balance, null, 'solde masqué pour un employé');
    const biz = expectOk(await api('GET', '/api/businesses', tokens.karim));
    assert.deepEqual(biz.map((b: any) => b.code), ['GF']);
    const t = expectOk(await api('POST', '/api/transactions', tokens.karim, {
      businessId: GF, accountId: gf.cash.id, type: 'expense', amount: 2000, categoryId: c['Transport'], description: 'Livraison' }), 201);
    ids.livraison = t.id;
    expectErr(await api('POST', '/api/transactions', tokens.karim, {
      businessId: GF, accountId: gf.cash.id, type: 'purchase', amount: 100, categoryId: c['Achat PlayStation'] }), 403, 'CP003');
    expectErr(await api('POST', '/api/transactions', tokens.karim, {
      businessId: GF, accountId: gf.bank.id, type: 'expense', amount: 100, categoryId: c['Transport'] }), 403, 'CP026');
    expectErr(await api('POST', '/api/transactions', tokens.karim, {
      businessId: GF, accountId: gf.cash.id, type: 'expense', amount: 6000, categoryId: c['Transport'] }), 403, 'CP027');
    const list = expectOk(await api('GET', '/api/transactions', tokens.karim));
    assert.equal(list.total, 1, 'ne voit que ses opérations');
    expectOk(await api('PATCH', `/api/transactions/${t.id}`, tokens.karim, { notes: 'Livraison client Annaba' }));
    expectErr(await api('POST', `/api/transactions/${t.id}/cancel`, tokens.karim, { reason: 'erreur' }), 403, 'CP003');
    expectErr(await api('GET', `/api/businesses/${ETP}/accounts`, tokens.karim).then((r) => ({ ...r, status: r.body.length === 0 ? 403 : r.status })), 403);
    expectErr(await api('GET', '/api/reports/summary?from=2026-01-01&to=2030-01-01', tokens.karim).then((r) =>
      ({ ...r, status: r.body.businesses?.length === 0 ? 403 : r.status })), 403);
  });

  test('responsable : annulation et correction', async () => {
    expectErr(await api('POST', `/api/transactions/${ids.livraison}/cancel`, tokens.samir, { reason: '' }), 422, 'VALIDATION');
    const n = expectOk(await api('POST', `/api/transactions/${ids.livraison}/correct`, tokens.samir, { reason: 'Montant réel 2 500', amount: 2500 }), 201);
    assert.equal(n.corrects_id, ids.livraison);
    const old = expectOk(await api('GET', `/api/transactions/${ids.livraison}`, tokens.samir));
    assert.equal(old.status, 'cancelled');
    assert.match(old.cancel_reason, /^Correction : /);
    assert.equal(old.corrections.length, 1);
    assert.ok(old.history.some((h: any) => h.action === 'update' && h.new_values?.notes === 'Livraison client Annaba'));
    assert.equal(await bal(GF, 'cash'), 57500);
    // l'ancienne version reste visible, barrée, avec le responsable et le lien vers la nouvelle
    assert.equal(old.replaced_by_id, n.id);
    assert.equal(old.cancelled_by_name, 'Samir');
    assert.ok(old.edit_count >= 1 && old.edited_by_name);
    assert.equal(n.corrects_ref, old.ref_no);
    const list = expectOk(await api('GET', `/api/transactions?businessId=${GF}&limit=100`, tokens.samir));
    const inList = list.items.find((r: any) => r.id === ids.livraison);
    assert.equal(inList.status, 'cancelled');
    assert.equal(inList.replaced_by_ref, n.ref_no);
    // modification complète : texte + montant en une fois ; la version précédente est conservée
    const n2 = expectOk(await api('POST', `/api/transactions/${n.id}/correct`, tokens.samir,
      { reason: 'Facture reçue', amount: 2500, description: 'Livraison Annaba (facture 77)' }), 201);
    assert.equal(n2.description, 'Livraison Annaba (facture 77)');
    assert.equal(n2.notes, 'Livraison client Annaba');
    assert.equal(await bal(GF, 'cash'), 57500);
    ids.livraison = n2.id;
  });

  test('achat avec nouveau fournisseur créé à la volée', async () => {
    const c = await cats(tokens.samir, GF);
    const gf = await accounts(tokens.samir, GF);
    const t = expectOk(await api('POST', '/api/transactions', tokens.samir, {
      businessId: GF, accountId: gf.cash.id, type: 'purchase', amount: 12000, categoryId: c['Achat manettes'],
      newSupplier: { name: 'Sony Distribution Alger', phone: '0550000000' }, description: '4 manettes DualSense' }), 201);
    assert.equal(t.supplier_name, 'Sony Distribution Alger');
    const sup = expectOk(await api('GET', `/api/businesses/${GF}/suppliers?q=sony`, tokens.samir));
    assert.equal(sup.length, 1);
    ids.sony = sup[0].id;
    assert.equal(await bal(GF, 'cash'), 45500);
  });

  test('transferts interne et entre activités', async () => {
    const gf = await accounts(tokens.samir, GF);
    const etp = await accounts(tokens.samir, ETP);
    expectOk(await api('POST', '/api/transfers', tokens.samir, { fromAccountId: gf.cash.id, toAccountId: gf.bank.id, amount: 5000, reference: 'VRS-001' }), 201);
    assert.equal(await bal(GF, 'cash'), 40500);
    assert.equal(await bal(GF, 'bank'), 205000);
    const inter = expectOk(await api('POST', '/api/transfers', tokens.samir,
      { fromAccountId: gf.bank.id, toAccountId: etp.bank.id, amount: 20000, reference: 'INTER-001' }), 201);
    assert.equal(inter.kind, 'inter_business');
    assert.equal(await bal(ETP, 'bank'), 120000);
    const today = daysAgo(0);
    const sum = expectOk(await api('GET', `/api/reports/summary?from=${today}&to=${today}`, tokens.samir));
    assert.equal(Number(sum.totals.net_change), 10000 - 2500 - 12000, 'consolidé : transferts neutres');
    assert.equal(Number(sum.totals.income), 10000);
    const legs = expectOk(await api('GET', '/api/transactions?q=INTER-001', tokens.samir));
    const out = legs.items.find((x: any) => x.transaction_type === 'transfer_out');
    expectOk(await api('POST', `/api/transactions/${out.id}/cancel`, tokens.samir, { reason: 'Doublon' }));
    const after = expectOk(await api('GET', '/api/transactions?q=INTER-001', tokens.samir));
    assert.ok(after.items.every((x: any) => x.status === 'cancelled'));
    assert.equal(await bal(GF, 'bank'), 205000);
  });

  test('chèques : portefeuille → dépôt → encaissement → rejet ; chèque émis', async () => {
    const c = await cats(tokens.samir, GF);
    const gf = await accounts(tokens.samir, GF);
    const ch = expectOk(await api('POST', '/api/cheques/receive', tokens.samir, {
      businessId: GF, number: '0012345', bank: 'BNA', drawer: 'Client Ali', amount: 45000,
      issueDate: daysAgo(0), dueDate: daysAgo(-2), categoryId: c['Ventes consoles'] }), 201);
    assert.equal(ch.status, 'in_portfolio');
    expectErr(await api('POST', `/api/cheques/${ch.id}/clear`, tokens.samir, {}), 409, 'CP083');
    expectOk(await api('POST', `/api/cheques/${ch.id}/deposit`, tokens.samir, { accountId: gf.bank.id }));
    assert.equal(await bal(GF, 'bank'), 205000);
    const cl = expectOk(await api('POST', `/api/cheques/${ch.id}/clear`, tokens.samir, {}));
    assert.equal(cl.status, 'cleared');
    assert.equal(await bal(GF, 'bank'), 250000);
    expectErr(await api('POST', `/api/transactions/${cl.settlement_txn_id}/cancel`, tokens.samir, { reason: 'test annulation' }), 409, 'CP032');
    expectOk(await api('POST', `/api/cheques/${ch.id}/reject`, tokens.samir, { reason: 'Impayé — provision insuffisante' }));
    assert.equal(await bal(GF, 'bank'), 205000);
    const iss = expectOk(await api('POST', '/api/cheques/issue', tokens.samir, {
      businessId: GF, accountId: gf.bank.id, number: '7700001', payee: 'Sony Distribution Alger', amount: 120000,
      issueDate: daysAgo(0), dueDate: daysAgo(-1), categoryId: c['Achat PlayStation'], supplierId: ids.sony }), 201);
    const dash = expectOk(await api('GET', '/api/dashboard', tokens.samir));
    assert.ok(dash.alerts.chequesDue.some((x: any) => x.id === iss.id), 'alerte échéance');
    expectOk(await api('POST', `/api/cheques/${iss.id}/clear`, tokens.samir, {}));
    assert.equal(await bal(GF, 'bank'), 85000);
    const det = expectOk(await api('GET', `/api/cheques/${iss.id}`, tokens.samir));
    assert.ok(det.history.length >= 2);
    expectErr(await api('POST', '/api/cheques/receive', tokens.karim, {
      businessId: GF, number: '1', drawer: 'Client Test', amount: 10, issueDate: daysAgo(0), categoryId: c['Ventes consoles'] }), 403, 'CP003');
  });

  test('caisse : clôture avec écart, validation, réouverture admin', async () => {
    const gf = await accounts(tokens.samir, GF);
    const theo = await bal(GF, 'cash');
    assert.equal(theo, 40500);
    const s = expectOk(await api('POST', '/api/cash/sessions/open', tokens.karim, { accountId: gf.cash.id }), 201);
    expectErr(await api('POST', '/api/cash/sessions/open', tokens.karim, { accountId: gf.cash.id }), 409, 'DUPLICATE');
    const st = expectOk(await api('GET', `/api/cash/status?accountId=${gf.cash.id}`, tokens.karim));
    assert.equal(Number(st.theoretical), 40500, 'le caissier voit le théorique de sa caisse');
    expectErr(await api('POST', `/api/cash/sessions/${s.session_id}/close`, tokens.karim, { physical: 40000 }), 422, 'CP075');
    const closed = expectOk(await api('POST', `/api/cash/sessions/${s.session_id}/close`, tokens.karim, { physical: 40000, reason: 'Rendu monnaie erroné' }));
    assert.equal(closed.status, 'pending_review');
    assert.equal(Number(closed.difference), -500);
    const c = await cats(tokens.karim, GF);
    expectErr(await api('POST', '/api/transactions', tokens.karim, {
      businessId: GF, accountId: gf.cash.id, type: 'income', amount: 100, categoryId: c['Ventes consoles'] }), 409, 'CP010');
    const dash = expectOk(await api('GET', '/api/dashboard', tokens.samir));
    assert.equal(dash.alerts.sessionsPendingReview.length, 1);
    expectErr(await api('POST', `/api/cash/sessions/${s.session_id}/approve`, tokens.karim, {}), 403, 'CP003');
    const ap = expectOk(await api('POST', `/api/cash/sessions/${s.session_id}/approve`, tokens.samir, { reason: 'Validé' }));
    assert.equal(ap.status, 'closed');
    assert.equal(await bal(GF, 'cash'), 40000);
    expectErr(await api('POST', `/api/cash/sessions/${s.session_id}/reopen`, tokens.samir, { reason: 'oubli de vente' }), 403, 'CP004');
    const ro = expectOk(await api('POST', `/api/cash/sessions/${s.session_id}/reopen`, tokens.admin, { reason: 'Vente oubliée à saisir' }));
    assert.equal(ro.status, 'reopened');
    assert.equal(await bal(GF, 'cash'), 40500);
    const audit = expectOk(await api('GET', `/api/audit?action=reopen`, tokens.admin));
    assert.ok(audit.items.some((a: any) => a.reason === 'Vente oubliée à saisir'));
    const re = expectOk(await api('POST', `/api/cash/sessions/${s.session_id}/close`, tokens.samir, { physical: '40500' }));
    assert.equal(re.status, 'closed');
    assert.equal(Number(re.difference), 0);
  });

  test('paie : avance, prime, paiement plafonné au reste', async () => {
    const etp = await accounts(tokens.samir, ETP);
    const month = daysAgo(0).slice(0, 8) + '01';
    expectErr(await api('POST', `/api/businesses/${ETP}/employees`, tokens.samir,
      { fullName: 'Employé Test', monthlySalary: 1, startDate: month }), 403);
    const e = expectOk(await api('POST', `/api/businesses/${ETP}/employees`, tokens.admin,
      { fullName: 'Yacine Technicien', jobTitle: 'Technicien fibre', monthlySalary: 40000, startDate: month }), 201);
    const adv = expectOk(await api('POST', '/api/payroll/advance', tokens.samir,
      { employeeId: e.id, period: daysAgo(0), amount: 10000, accountId: etp.cash.id }), 201);
    assert.equal(adv.transaction_type, 'salary_advance');
    assert.equal(await bal(ETP, 'cash'), 20000, 'l\'avance sort immédiatement de la caisse');
    expectOk(await api('POST', '/api/payroll/items', tokens.samir, { employeeId: e.id, period: daysAgo(0), kind: 'bonus', amount: 2000, reason: 'Chantier urgent' }), 201);
    expectErr(await api('POST', '/api/payroll/payment', tokens.samir,
      { employeeId: e.id, period: daysAgo(0), amount: 33000, accountId: etp.bank.id }), 422, 'CP093');
    expectOk(await api('POST', '/api/payroll/payment', tokens.samir,
      { employeeId: e.id, period: daysAgo(0), amount: 32000, accountId: etp.bank.id }), 201);
    const m = expectOk(await api('GET', `/api/payroll/monthly?employeeId=${e.id}&period=${daysAgo(0)}`, tokens.samir));
    assert.equal(m[0].status, 'paid');
    assert.equal(Number(m[0].remaining), 0);
    const st = expectOk(await api('GET', `/api/employees/${e.id}/statement`, tokens.samir));
    assert.equal(st.movements.length, 2);
    expectOk(await api('POST', `/api/transactions/${adv.id}/cancel`, tokens.samir, { reason: 'Avance saisie par erreur' }));
    assert.equal(await bal(ETP, 'cash'), 30000);
    const emp = expectOk(await api('GET', `/api/businesses/${ETP}/employees`, tokens.karim));
    assert.equal(emp.length, 0, 'salaires invisibles pour l\'employé');
  });

  test('tableau de bord et rapports', async () => {
    const d = expectOk(await api('GET', '/api/dashboard', tokens.admin));
    assert.equal(d.businesses.length, 2);
    assert.equal(d.series.length, 30);
    assert.equal(Number(d.kpis.todayIncome), 10000, 'le chèque rejeté ne compte plus');
    assert.equal(Number(d.kpis.todayPurchases), 132000);
    assert.ok(d.kpis.globalBalance !== null);
    const k = expectOk(await api('GET', '/api/dashboard', tokens.karim));
    assert.equal(k.kpis.globalBalance, null, 'employé : pas de solde global');
    assert.equal(k.businesses[0].balance, null);
    const daily = expectOk(await api('GET', `/api/reports/daily?businessId=${GF}`, tokens.samir));
    const flows = ['income', 'deposits', 'inter_transfers_in', 'cash_differences'].reduce((s, f) => s + Number(daily[f]), 0)
      - ['expenses', 'purchases', 'salaries', 'withdrawals', 'inter_transfers_out'].reduce((s, f) => s + Number(daily[f]), 0);
    assert.equal(Number(daily.opening_balance) + flows, Number(daily.closing_balance), 'ouverture + flux = clôture');
    const dist = expectOk(await api('GET', `/api/reports/expense-distribution?from=${daysAgo(0)}&to=${daysAgo(0)}&businessId=${GF}`, tokens.samir));
    assert.ok(dist.some((x: any) => x.bucket === 'purchase'));
    const series = expectOk(await api('GET', `/api/reports/balance-series?businessId=${GF}&from=${daysAgo(2)}&to=${daysAgo(0)}`, tokens.samir));
    assert.equal(series.length, 3);
    expectErr(await api('GET', `/api/reports/daily?businessId=${GF}`, tokens.karim), 403, 'CP003');
    expectErr(await api('GET', `/api/audit?businessId=${GF}`, tokens.karim), 403);
  });

  test('logos : activité et logiciel, SVG dangereux refusé', async () => {
    const fd = new FormData();
    fd.append('file', new Blob([PNG_1PX], { type: 'image/png' }), 'logo.png');
    const up = expectOk(await api('POST', `/api/businesses/${GF}/logo`, tokens.admin, fd));
    assert.match(up.logo_path, /^logos\/10000000-0000-0000-0000-000000000001-.*\.png$/);
    const get = await api('GET', `/api/businesses/${GF}/logo`, tokens.karim);
    assert.equal(get.status, 200);
    assert.equal(get.headers.get('content-type'), 'image/png');
    assert.deepEqual(get.raw, PNG_1PX);
    const bad = new FormData();
    bad.append('file', new Blob(['<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"></svg>'], { type: 'image/svg+xml' }), 'x.svg');
    expectErr(await api('POST', `/api/businesses/${GF}/logo`, tokens.admin, bad), 422, 'UNSAFE_SVG');
    const fake = new FormData();
    fake.append('file', new Blob(['MZ-pas-une-image'], { type: 'image/png' }), 'virus.png');
    expectErr(await api('POST', `/api/businesses/${GF}/logo`, tokens.admin, fake), 415, 'UNSUPPORTED_FILE');
    const fd2 = new FormData();
    fd2.append('file', new Blob([PNG_1PX], { type: 'image/png' }), 'logo.png');
    expectErr(await api('POST', `/api/businesses/${GF}/logo`, tokens.samir, fd2), 403);
    const hist = expectOk(await api('GET', `/api/businesses/${GF}/logo/history`, tokens.admin));
    assert.equal(hist.length, 1);
    const fd3 = new FormData();
    fd3.append('file', new Blob([PNG_1PX], { type: 'image/png' }), 'app.png');
    expectOk(await api('POST', '/api/settings/logo', tokens.admin, fd3));
    assert.equal((await api('GET', '/api/settings/logo', tokens.karim)).status, 200);
    const audit = expectOk(await api('GET', `/api/audit?table=businesses&businessId=${GF}`, tokens.admin));
    assert.ok(audit.items.some((a: any) => a.changed?.includes('logo_path') && a.reason === 'Changement de logo'));
  });

  test('pièces jointes', async () => {
    const list = expectOk(await api('GET', `/api/transactions?type=purchase&businessId=${GF}&status=validated`, tokens.samir));
    const t = list.items[0];
    const fd = new FormData();
    fd.append('kind', 'invoice');
    fd.append('file', new Blob([Buffer.from('%PDF-1.4\n%fake facture\n')], { type: 'application/pdf' }), 'facture-sony.pdf');
    const a = expectOk(await api('POST', `/api/transactions/${t.id}/attachments`, tokens.samir, fd), 201);
    assert.equal(a.file_name, 'facture-sony.pdf');
    const dl = await api('GET', `/api/attachments/${a.id}`, tokens.samir);
    assert.equal(dl.status, 200);
    assert.match(dl.headers.get('content-disposition') ?? '', /facture-sony\.pdf/);
    const det = expectOk(await api('GET', `/api/transactions/${t.id}`, tokens.samir));
    assert.equal(det.attachments.length, 1);
  });

  test('exports Excel / CSV / PDF (permission export)', async () => {
    const x = await api('GET', `/api/export/transactions?format=xlsx&businessId=${GF}&lang=ar`, tokens.samir);
    assert.equal(x.status, 200);
    assert.equal(x.raw.subarray(0, 2).toString(), 'PK');
    const c = await api('GET', `/api/export/transactions?format=csv&businessId=${GF}&lang=fr`, tokens.samir);
    assert.equal(c.status, 200);
    assert.ok(String(c.body).startsWith('﻿N°;Date;Activité'));
    assert.ok(String(c.body).includes('Sony Distribution Alger'));
    const p = await api('GET', `/api/export/transactions?format=pdf&businessId=${GF}&lang=ar`, tokens.samir);
    assert.equal(p.status, 200);
    assert.equal(p.raw.subarray(0, 5).toString(), '%PDF-');
    const pf = await api('GET', `/api/export/transactions?format=pdf&lang=fr`, tokens.admin);
    if (process.env.EXPORT_DIR) {
      fs.writeFileSync(path.join(process.env.EXPORT_DIR, 'releve-ar.pdf'), p.raw);
      fs.writeFileSync(path.join(process.env.EXPORT_DIR, 'releve-fr.pdf'), pf.raw);
      fs.writeFileSync(path.join(process.env.EXPORT_DIR, 'releve-ar.xlsx'), x.raw);
    }
    expectErr(await api('GET', `/api/export/transactions?format=csv&businessId=${GF}`, tokens.karim), 403);
    const audit = expectOk(await api('GET', '/api/audit?action=export', tokens.admin));
    assert.ok(audit.total >= 3);
  });

  test('admin : adresses du serveur (réseau local / VPN)', async () => {
    const n = expectOk(await api('GET', '/api/admin/network', tokens.admin));
    assert.ok(n.hostname); assert.ok(Array.isArray(n.addresses)); assert.ok(n.port > 0);
    for (const a of n.addresses) assert.ok(['lan', 'vpn'].includes(a.kind));
    assert.equal((await api('GET', '/api/admin/network', tokens.samir)).status, 403);
    assert.equal((await api('GET', '/api/admin/tailnet', tokens.admin)).status, 404);
  });

  test('admin modifie une permission → effet immédiat', async () => {
    const c = await cats(tokens.karim, GF);
    const gf = await accounts(tokens.karim, GF);
    expectOk(await api('PUT', `/api/users/${ids.karim}/businesses/${GF}`, tokens.admin,
      { profile: 'employee', permissions: { add_purchase: true }, allowedAccounts: [gf.cash.id], maxAmount: 5000, reason: 'Karim gère les petits achats' }));
    // journée de caisse clôturée : l'achat est refusé pour cette raison, plus pour la permission
    expectErr(await api('POST', '/api/transactions', tokens.karim, {
      businessId: GF, accountId: gf.cash.id, type: 'purchase', amount: 1000, categoryId: c['Achat accessoires'] }), 409, 'CP010');
    const audit = expectOk(await api('GET', '/api/audit?table=business_users', tokens.admin));
    assert.ok(audit.items.some((a: any) => a.reason === 'Karim gère les petits achats'));
  });

  test('« تذكّرني » : appareil mémorisé, rotation du jeton, révocation', async () => {
    const remember = async (password: string) => expectOk(await api('POST', '/api/auth/login', null,
      { username: 'samir', password, remember: true, deviceName: 'PC caisse' }));
    const refresh = (tok: string) => api('POST', '/api/auth/refresh', null, { refreshToken: tok });
    const l = await remember('Samir2027x');
    assert.ok(l.refreshToken && l.refreshExpiresAt);
    const r1 = expectOk(await refresh(l.refreshToken));
    assert.ok(r1.token && r1.refreshToken && r1.refreshToken !== l.refreshToken, 'nouveau jeton à chaque utilisation');
    assert.equal(r1.user.role, 'user');
    expectOk(await api('GET', `/api/businesses/${GF}/accounts`, r1.token));
    expectErr(await refresh(l.refreshToken), 401, 'REFRESH_INVALID');            // l'ancien jeton ne sert plus
    const devs = expectOk(await api('GET', '/api/auth/devices', r1.token));
    assert.equal(devs.length, 1); assert.equal(devs[0].device_name, 'PC caisse'); assert.equal(devs[0].token_hash, undefined);
    assert.equal(expectOk(await api('GET', `/api/auth/devices?userId=${ids.samir}`, tokens.admin)).length, 1);
    assert.equal(expectOk(await api('GET', `/api/auth/devices?userId=${ids.karim}`, r1.token)).length, 0, 'RLS : appareils des autres invisibles');
    expectErr(await api('POST', '/api/auth/devices/revoke', r1.token, { userId: ids.karim }), 403);
    // option retirée par l'administrateur pour les utilisateurs
    expectOk(await api('PUT', '/api/settings/remember_me', tokens.admin, { value: { enabled: true, days: 30, admin: true, users: false } }));
    expectErr(await refresh(r1.refreshToken), 401, 'REFRESH_INVALID');
    const l2 = await remember('Samir2027x');
    assert.equal(l2.refreshToken, undefined); assert.equal(l2.remembered, false);
    expectOk(await api('PUT', '/api/settings/remember_me', tokens.admin, { value: { enabled: true, days: 30, admin: true, users: true } }));
    // changement de mot de passe : tous les appareils invalidés, ce poste peut être re-mémorisé
    const l3 = await remember('Samir2027x');
    const cp = expectOk(await api('POST', '/api/auth/change-password', l3.token, { currentPassword: 'Samir2027x', newPassword: 'Samir2028y', remember: true }));
    expectErr(await refresh(l3.refreshToken), 401, 'REFRESH_INVALID');
    const r2 = expectOk(await refresh(cp.refreshToken));
    // révocation par l'administrateur
    assert.equal(expectOk(await api('POST', '/api/auth/devices/revoke', tokens.admin, { userId: ids.samir })).revoked, 1);
    expectErr(await refresh(r2.refreshToken), 401, 'REFRESH_INVALID');
    // déconnexion
    const l4 = await remember('Samir2028y');
    assert.equal((await api('POST', '/api/auth/logout', null, { refreshToken: l4.refreshToken })).status, 204);
    expectErr(await refresh(l4.refreshToken), 401, 'REFRESH_INVALID');
    expectErr(await refresh('x'.repeat(43)), 401, 'REFRESH_INVALID');
    // mot de passe d'origine rétabli pour la suite
    const back = await login('samir', 'Samir2028y');
    expectOk(await api('POST', '/api/auth/change-password', back.token, { currentPassword: 'Samir2028y', newPassword: 'Samir2027x' }));
    const audit = expectOk(await api('GET', '/api/audit?action=remember_device_created', tokens.admin));
    assert.ok(audit.total >= 1);
  });

  test('mises à jour : installateur des postes servi par le serveur, état du serveur', async () => {
    expectErr(await api('GET', '/api/updates/client'), 404, 'UPDATE_NO_CLIENT');
    const dir = path.join(dataDir, 'updates', 'client');
    fs.mkdirSync(dir, { recursive: true });
    const exe = Buffer.from('MZ-cashpro-test');
    const sha = crypto.createHash('sha512').update(exe).digest('base64');
    fs.writeFileSync(path.join(dir, 'CashPro-Setup-1.0.1.exe'), exe);
    fs.writeFileSync(path.join(dir, 'latest.yml'), `version: 1.0.1\nfiles:\n  - url: CashPro-Setup-1.0.1.exe\n    sha512: ${sha}\n    size: ${exe.length}\npath: CashPro-Setup-1.0.1.exe\nsha512: ${sha}\nreleaseDate: '2026-11-25T10:00:00.000Z'\n`);
    const info = expectOk(await api('GET', '/api/updates/client'));
    assert.equal(info.version, '1.0.1'); assert.equal(info.sha512, sha); assert.equal(info.size, exe.length);
    const f = await api('GET', info.url);
    assert.equal(f.status, 200); assert.deepEqual(f.raw, exe);

    expectErr(await api('GET', '/api/updates/server'), 401);
    expectErr(await api('GET', '/api/updates/server', tokens.samir), 403);
    // dernière vérification récente (pas d'appel réseau pendant le test)
    fs.mkdirSync(path.join(dataDir, 'updates', 'server'), { recursive: true });
    fs.writeFileSync(path.join(dataDir, 'updates', 'server', 'state.json'), JSON.stringify({ checkedAt: new Date().toISOString(),
      latest: { version: '9.9.9', name: 'v9.9.9', notes: 'Nouveautés', publishedAt: '2026-11-25T10:00:00Z', asset: 'CashPro-Server-Setup-9.9.9.exe', size: 10 } }));
    const st = expectOk(await api('GET', '/api/updates/server', tokens.admin));
    assert.equal(st.available, true); assert.equal(st.latest.version, '9.9.9'); assert.equal(st.status, 'idle');
    assert.equal(st.hasToken, false); assert.equal(st.repo, 'Projet23dz/caisse-game-force');
    assert.equal(st.current, expectOk(await api('GET', '/api/health')).version);
    const c = expectOk(await api('PUT', '/api/updates/server/config', tokens.admin, { repo: 'game-force/cashpro-releases', token: 'github_pat_secret' }));
    assert.equal(c.hasToken, true); assert.equal(c.repo, 'game-force/cashpro-releases');
    assert.ok(!JSON.stringify(c).includes('github_pat_secret'), 'le jeton ne sort jamais du serveur');
    expectErr(await api('PUT', '/api/updates/server/config', tokens.admin, { repo: 'pas un dépôt' }), 422);
    assert.equal(expectOk(await api('PUT', '/api/updates/server/config', tokens.admin, { token: null })).hasToken, false);
    if (process.platform !== 'win32') expectErr(await api('POST', '/api/updates/server/install', tokens.admin), 501, 'UPDATE_UNSUPPORTED');
  });

  test('compte commun (1.1.0) : une caisse pour deux activités, ventilation, sous-catégories', async () => {
    const cc = expectOk(await api('POST', `/api/businesses/${GF}/accounts`, tokens.admin,
      { name: 'Caisse commune test', kind: 'cash', openingBalance: 100000, openingDate: daysAgo(10), businessIds: [GF, ETP] }), 201);
    const etpAcc = expectOk(await api('GET', `/api/businesses/${ETP}/accounts`, tokens.admin)) as any[];
    const shared = etpAcc.find((a) => a.id === cc.id);
    assert.ok(shared, 'le compte commun apparaît dans ETP'); assert.equal(shared.shared, true); assert.equal(shared.owned, false);
    const cg = await cats(tokens.admin, GF); const ce = await cats(tokens.admin, ETP);
    // achat ETP payé par la caisse commune : une seule écriture
    expectOk(await api('POST', '/api/transactions', tokens.admin, {
      businessId: ETP, accountId: cc.id, type: 'purchase', amount: 30000, categoryId: ce['Caméras'], description: 'Caméra dôme' }), 201);
    const bal1 = Number((expectOk(await api('GET', `/api/businesses/${ETP}/accounts`, tokens.admin)) as any[]).find((a) => a.id === cc.id).balance);
    assert.equal(bal1, 70000);
    // ventilation d'une facture entre les deux activités
    expectErr(await api('POST', '/api/transactions/split', tokens.admin, { accountId: cc.id, type: 'expense', total: 12000,
      parts: [{ businessId: GF, categoryId: cg['Électricité'], amount: 8000 }, { businessId: ETP, categoryId: ce['Électricité'], amount: 3000 }] }), 422, 'CP049');
    const sp = expectOk(await api('POST', '/api/transactions/split', tokens.admin, { accountId: cc.id, type: 'expense', total: '12 000', description: 'Facture Sonelgaz',
      parts: [{ businessId: GF, categoryId: cg['Électricité'], amount: 8000 }, { businessId: ETP, categoryId: ce['Électricité'], amount: 4000 }] }), 201);
    assert.equal(sp.items.length, 2);
    assert.ok(sp.items.every((x: any) => x.split_id === sp.splitId && x.account_shared === true));
    const bal2 = Number((expectOk(await api('GET', `/api/businesses/${GF}/accounts`, tokens.admin)) as any[]).find((a) => a.id === cc.id).balance);
    assert.equal(bal2, 58000, 'la caisse baisse une seule fois de 12 000');
    const etpOps = expectOk(await api('GET', `/api/transactions?businessId=${ETP}&q=Sonelgaz`, tokens.admin));
    assert.equal(etpOps.total, 1); assert.equal(etpOps.items[0].amount, '4000.00');
    // annuler une part annule toute la ventilation
    expectOk(await api('POST', `/api/transactions/${sp.items[0].id}/cancel`, tokens.admin, { reason: 'Facture saisie deux fois' }));
    const after = expectOk(await api('GET', '/api/transactions?q=Sonelgaz', tokens.admin));
    assert.ok(after.items.length === 2 && after.items.every((x: any) => x.status === 'cancelled'));
    // une activité qui a des opérations sur le compte ne peut pas en être retirée
    expectErr(await api('PATCH', `/api/accounts/${cc.id}`, tokens.admin, { businessIds: [GF] }), 422, 'CP044');
    // un compte non partagé reste refusé à l'autre activité
    expectErr(await api('POST', '/api/transactions', tokens.admin, {
      businessId: ETP, accountId: (await accounts(tokens.admin, GF)).bank.id, type: 'expense', amount: 10, categoryId: ce['Transport'] }), 422, 'CP029');
    // tableau de bord : solde commun affiché à part
    const d = expectOk(await api('GET', '/api/dashboard', tokens.admin));
    const etpCard = d.businesses.find((b: any) => b.id === ETP);
    assert.ok(etpCard.sharedAccounts.includes('Caisse commune test'));
    assert.equal(Number(etpCard.sharedBalance), 70000);
    // 1.2.1 : nouvelle activité qui utilise la caisse commune existante (3 activités, une seule caisse)
    const nb = expectOk(await api('POST', '/api/businesses', tokens.admin, { code: 'T3', name: 'Troisième', sharedAccountIds: [cc.id] }), 201);
    const nbAcc = expectOk(await api('GET', `/api/businesses/${nb.id}/accounts`, tokens.admin)) as any[];
    assert.ok(nbAcc.some((a) => a.id === cc.id && a.shared), 'la caisse commune sert la nouvelle activité');
    assert.ok(!nbAcc.some((a) => a.kind === 'cash' && a.id !== cc.id), 'pas de caisse propre créée');
    assert.deepEqual(nbAcc.filter((a) => a.owned).map((a) => a.kind).sort(), ['bank', 'ccp']);
    assert.equal((expectOk(await api('GET', `/api/businesses/${GF}/accounts`, tokens.admin)) as any[]).find((a) => a.id === cc.id).business_ids.length, 3);
    expectErr(await api('POST', '/api/businesses', tokens.admin, { code: 'T4', name: 'Quatrième', sharedAccountIds: ['00000000-0000-0000-0000-000000000000'] }), 404);
    expectOk(await api('PATCH', `/api/businesses/${nb.id}`, tokens.admin, { isActive: false }));
    // catégories principales / sous-catégories, et catégorie ajoutée à toutes les activités
    const main = expectOk(await api('POST', `/api/businesses/${ETP}/categories`, tokens.admin, { txnType: 'purchase', name: 'Équipements' }), 201);
    const sub = expectOk(await api('POST', `/api/businesses/${ETP}/categories`, tokens.admin, { txnType: 'purchase', name: 'Caméras IP', parentId: main.id }), 201);
    assert.equal(sub.parent_id, main.id);
    expectErr(await api('POST', `/api/businesses/${ETP}/categories`, tokens.admin, { txnType: 'purchase', name: 'Niveau 3', parentId: sub.id }), 422, 'CP046');
    const list = expectOk(await api('GET', `/api/businesses/${ETP}/categories?type=purchase`, tokens.admin)) as any[];
    assert.equal(list.find((c) => c.id === sub.id).parent_name, 'Équipements');
    assert.equal(list.find((c) => c.id === main.id).children, 1);
    const all = expectOk(await api('POST', `/api/businesses/${GF}/categories`, tokens.admin, { txnType: 'expense', name: 'Internet fibre', allBusinesses: true }), 201);
    assert.deepEqual(all.map((c: any) => c.business_id).sort(), [GF, ETP].sort());
  });

  test('types d\'opération personnalisés + alertes d\'activité (1.2.0)', async () => {
    // seul l'administrateur crée un type
    expectErr(await api('POST', '/api/op-types', tokens.samir, { name: 'Transport', direction: 'out' }), 403);
    const ot = expectOk(await api('POST', '/api/op-types', tokens.admin, { name: 'Transport colis', direction: 'out', color: '#ff9900' }), 201);
    expectErr(await api('POST', '/api/op-types', tokens.admin, { name: 'transport colis', direction: 'in' }), 409);
    const list = expectOk(await api('GET', '/api/op-types', tokens.karim)) as any[];
    assert.ok(list.some((x) => x.id === ot.id && x.dir === 'out' && x.base_type === 'expense'));
    // catégorie du type (la base suit le sens), même nom permis hors type
    const cat = expectOk(await api('POST', `/api/businesses/${GF}/categories`, tokens.admin, { txnType: 'income', name: 'Yalidine', opTypeId: ot.id }), 201);
    assert.equal(cat.txn_type, 'expense'); assert.equal(cat.op_type_id, ot.id);
    const sub = expectOk(await api('POST', `/api/businesses/${GF}/categories`, tokens.admin, { txnType: 'expense', name: 'Yalidine Annaba', opTypeId: ot.id, parentId: cat.id }), 201);
    const byType = expectOk(await api('GET', `/api/businesses/${GF}/categories?opType=${ot.id}`, tokens.admin)) as any[];
    assert.deepEqual(byType.map((c) => c.id).sort(), [cat.id, sub.id].sort());
    const base = expectOk(await api('GET', `/api/businesses/${GF}/categories?type=expense`, tokens.admin)) as any[];
    assert.ok(!base.some((c) => c.op_type_id), 'les catégories des types personnalisés ne sont pas mélangées aux dépenses');
    // opération du type par un responsable (permission add_expense)
    const bank = (await accounts(tokens.samir, GF)).bank;
    const before = Number(bank.balance);
    const op = expectOk(await api('POST', '/api/transactions', tokens.samir, {
      businessId: GF, accountId: bank.id, type: 'expense', amount: 1500, categoryId: sub.id, description: 'Envoi colis client' }), 201);
    assert.equal(op.op_type_id, ot.id); assert.equal(op.op_type_name, 'Transport colis');
    assert.equal(Number((await accounts(tokens.samir, GF)).bank.balance), before - 1500, 'le solde suit le sens du type');
    const f = expectOk(await api('GET', `/api/transactions?opTypeId=${ot.id}`, tokens.admin));
    assert.equal(f.total, 1);
    const g = expectOk(await api('GET', `/api/transactions?opTypeId=none&q=Envoi colis`, tokens.admin));
    assert.equal(g.total, 0);
    // changer de type par la catégorie = refusé (correction)
    expectErr(await api('PATCH', `/api/transactions/${op.id}`, tokens.admin, { categoryId: base.find((c) => c.is_active).id }), 422, 'CP104');
    // type désactivé : plus de nouvelles opérations, l'historique reste
    expectOk(await api('PATCH', `/api/op-types/${ot.id}`, tokens.admin, { isActive: false }));
    expectErr(await api('POST', '/api/transactions', tokens.samir, {
      businessId: GF, accountId: bank.id, type: 'expense', amount: 10, categoryId: sub.id }), 422, 'CP103');
    assert.equal(expectOk(await api('GET', `/api/transactions?opTypeId=${ot.id}`, tokens.admin)).total, 1);
    // alertes : l'administrateur voit l'opération du responsable, pas les siennes
    expectErr(await api('GET', '/api/alerts', tokens.samir), 403);
    const al = expectOk(await api('GET', '/api/alerts?unread=1&limit=200', tokens.admin));
    const mine = al.items.find((x: any) => x.record_id === op.id && x.action === 'create');
    assert.ok(mine, 'alerte de création'); assert.equal(mine.user_name, 'Samir'); assert.equal(mine.op_type_name, 'Transport colis');
    assert.ok(!al.items.some((x: any) => x.user_name === 'Administrateur'));
    assert.ok(al.unread >= 1);
    const m1 = expectOk(await api('POST', '/api/alerts/mark', tokens.admin, { ids: [mine.id] }));
    assert.equal(m1.marked, 1); assert.equal(m1.unread, al.unread - 1);
    expectOk(await api('POST', '/api/alerts/mark', tokens.admin, {}));
    assert.equal(expectOk(await api('GET', '/api/alerts/count', tokens.admin)).unread, 0);
    // une modification par un employé redevient une alerte
    expectOk(await api('PATCH', `/api/transactions/${op.id}`, tokens.samir, { description: 'Envoi colis client Annaba' }));
    const c2 = expectOk(await api('GET', '/api/alerts?unread=1', tokens.admin));
    assert.equal(c2.unread, 1); assert.equal(c2.items[0].action, 'update');
    // réglage : seulement les modifications / annulations
    expectOk(await api('PUT', '/api/settings/activity_alerts', tokens.admin, { value: { events: 'changes', min_amount: null, include_admins: false } }));
    const c3 = expectOk(await api('GET', '/api/alerts?limit=200', tokens.admin));
    assert.ok(c3.items.every((x: any) => x.action !== 'create'));
    expectOk(await api('PUT', '/api/settings/activity_alerts', tokens.admin, { value: { events: 'all', min_amount: null, include_admins: false } }));
  });

  test('Google Sheets : configuration, script, instantané envoyé (1.3.0)', async () => {
    expectErr(await api('GET', '/api/admin/sheets', tokens.samir), 403);
    const c0 = expectOk(await api('GET', '/api/admin/sheets', tokens.admin));
    assert.equal(c0.enabled, false); assert.equal(c0.intervalMin, 5); assert.equal(c0.url, '');
    assert.equal(c0.token, undefined, 'le jeton ne sort jamais en JSON');
    expectErr(await api('PUT', '/api/admin/sheets', tokens.admin, { url: 'https://evil.example.com/exec', enabled: true }), 422);
    expectErr(await api('PUT', '/api/admin/sheets', tokens.admin, { enabled: true }), 422, 'SHEETS_URL_REQUIRED');
    const good = 'https://script.google.com/macros/s/AKfycbx_TEST_0123456789abcdef/exec';
    const c1 = expectOk(await api('PUT', '/api/admin/sheets', tokens.admin, { url: good, enabled: true, intervalMin: 10 }));
    assert.equal(c1.url, good); assert.equal(c1.enabled, true); assert.equal(c1.configuredBy, 'Administrateur');
    const script = await api('GET', '/api/admin/sheets/script', tokens.admin);
    assert.equal(script.status, 200);
    const tok = /var TOKEN = '([A-Za-z0-9_-]{20,})'/.exec(script.body)?.[1];
    assert.ok(tok, 'jeton injecté dans le script'); assert.ok(!script.body.includes('__CASHPRO_TOKEN__'));
    assert.match(script.body, /function doPost\(e\)/);
    // faux Apps Script local : on remplace l'URL dans le fichier de configuration (l'API n'accepte que script.google.com)
    const http = await import('node:http');
    const got: any[] = [];
    const mock = http.createServer((req, res) => {
      let b = ''; req.on('data', (d) => { b += d; }); req.on('end', () => {
        const j = JSON.parse(b); got.push(j);
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify(j.token === tok ? { ok: true, rows: (j.sheets ?? []).reduce((n: number, x: any) => n + x.rows.length, 0) } : { ok: false, error: 'unauthorized' }));
      });
    });
    await new Promise<void>((r) => mock.listen(0, '127.0.0.1', () => r()));
    const cfgFile = path.join(dataDir, 'config', 'sheets.json');
    const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'));
    fs.writeFileSync(cfgFile, JSON.stringify({ ...cfg, url: `http://127.0.0.1:${(mock.address() as AddressInfo).port}/exec` }));
    try {
      const r1 = expectOk(await api('POST', '/api/admin/sheets/run', tokens.admin));
      assert.equal(r1.state.lastError, null, JSON.stringify(r1.state)); assert.ok(r1.state.lastOkAt); assert.ok(r1.state.rows > 0);
      const snap = got[0];
      assert.equal(snap.token, tok); assert.equal(snap.summary.title, 'الملخص');
      assert.deepEqual(snap.sheets.map((x: any) => x.title), ['أرصدة الحسابات', 'العمليات', 'الشيكات', 'الأجور', 'الملخص الشهري']);
      for (const sh of snap.sheets) {
        assert.equal(sh.headers.length, sh.types.length, sh.key);
        for (const row of sh.rows) assert.equal(row.length, sh.headers.length, sh.key);
      }
      const txs = snap.sheets.find((x: any) => x.key === 'transactions');
      assert.ok(txs.rows.length > 5); assert.ok(txs.rows.some((r: any[]) => r[11] === 'ملغاة'), 'opérations annulées incluses');
      assert.ok(snap.sheets.find((x: any) => x.key === 'cheques').rows.length >= 1);
      assert.equal(snap.summary.cards.length, 2);
      const accs = snap.sheets.find((x: any) => x.key === 'accounts').rows;
      assert.equal(Math.round(accs.reduce((n: number, r: any[]) => n + r[3], 0) * 100), Math.round(snap.summary.total.value * 100));
      // jeton changé → le script existant est refusé
      expectOk(await api('POST', '/api/admin/sheets/token', tokens.admin));
      const r2 = expectOk(await api('POST', '/api/admin/sheets/run', tokens.admin));
      assert.equal(r2.state.lastError, 'unauthorized');
    } finally {
      mock.close();
      expectOk(await api('PUT', '/api/admin/sheets', tokens.admin, { url: '', enabled: false }));
    }
  });

  test('mises à jour : scripts Windows trouvés dans <serveur>\\setup (disposition de l\'installateur)', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cashpro-root-'));
    const routes = path.join(root, 'api', 'dist', 'routes');
    fs.mkdirSync(routes, { recursive: true }); fs.mkdirSync(path.join(root, 'setup'));
    fs.writeFileSync(path.join(root, 'setup', 'backup.ps1'), '');
    assert.equal(findSetupDir(routes), path.join(root, 'setup'));
  });

  test('Google Drive : dossier de copie des sauvegardes', async () => {
    expectErr(await api('PUT', '/api/admin/backup/offsite', tokens.samir, { path: dataDir }), 403);
    expectErr(await api('PUT', '/api/admin/backup/offsite', tokens.admin, { path: 'relatif/dossier' }), 422, 'OFFSITE_INVALID');
    expectErr(await api('PUT', '/api/admin/backup/offsite', tokens.admin, { path: path.join(dataDir, 'absent') }), 422, 'OFFSITE_UNREACHABLE');
    const ok = expectOk(await api('PUT', '/api/admin/backup/offsite', tokens.admin, { path: dataDir }));
    assert.equal(ok.path, dataDir);
    const s = expectOk(await api('GET', '/api/settings', tokens.admin));
    assert.equal(s.backup.offsite_path, dataDir); assert.equal(s.backup.retention_days, 30);
    assert.equal(expectOk(await api('PUT', '/api/admin/backup/offsite', tokens.admin, { path: null })).path, null);
  });

  test('sécurité des comptes : désactivation et verrouillage', async () => {
    expectOk(await api('PATCH', `/api/users/${ids.karim}`, tokens.admin, { isActive: false, reason: 'Départ' }));
    expectErr(await api('POST', '/api/auth/login', null, { username: 'karim', password: 'Karim2027x' }), 403, 'ACCOUNT_DISABLED');
    expectErr(await api('GET', `/api/businesses/${GF}/accounts`, tokens.karim).then((r) => ({ ...r, status: r.body.length === 0 ? 403 : r.status })), 403);
    for (let i = 0; i < 5; i++) expectErr(await api('POST', '/api/auth/login', null, { username: 'samir', password: 'faux' }), 401);
    expectErr(await api('POST', '/api/auth/login', null, { username: 'samir', password: 'Samir2027x' }), 423, 'ACCOUNT_LOCKED');
    expectOk(await api('PATCH', `/api/users/${ids.samir}`, tokens.admin, { unlock: true }));
    await login('samir', 'Samir2027x');
    expectErr(await api('PATCH', `/api/users/${(await login('admin', 'Admin2026!')).user.id}`, tokens.admin, { isActive: false }), 422, 'SELF_LOCKOUT');
  });
});
