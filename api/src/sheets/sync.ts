// Synchronisation vers Google Sheets (consultation en lecture seule, même si le serveur est injoignable)
//  • Toutes les N minutes, le serveur construit un instantané (6 feuilles) avec l'identité de l'administrateur
//    qui a configuré la synchronisation (mêmes règles d'accès que dans l'application).
//  • Instantané inchangé → simple « ping » (mise à jour de « آخر اتصال »). Internet coupé → nouvel essai au
//    tour suivant : l'instantané étant complet, rien n'est perdu.
//  • Configuration (URL + jeton secret) : C:\CashPro\config\sheets.json (jamais dans la base : pas dans l'audit).
import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { type Db, many, one } from '../db';
import type { Deps } from '../http';
import { TYPE_LABELS } from '../routes/export';

export interface SheetsConfig { enabled: boolean; url: string; token: string; intervalMin: number; userId: string | null }
export interface SheetsState {
  lastRunAt: string | null; lastOkAt: string | null; lastDataAt: string | null;
  lastError: string | null; lastErrorAt: string | null; lastHash: string | null; rows: number | null;
}
type ColType = 'text' | 'money' | 'signed' | 'int' | 'date' | 'datetime' | 'month' | 'badge';
interface Mark { col: number; value: string; tone: 'muted' | 'bad' | 'good' | 'warn'; row?: boolean }
export interface SheetSpec { key: string; title: string; nav?: string; note?: string; headers: string[]; types: ColType[]; widths: number[]; rows: unknown[][]; marks?: Mark[] }
export interface Snapshot {
  rtl: boolean;
  labels: { updated: string; contact: string; empty: string };
  summary: { title: string; currency: string; total: { label: string; value: number; note: string }; cards: { name: string; value: number; rows: [string, number, string][] }[] };
  sheets: SheetSpec[];
}

const KIND: Record<string, string> = { cash: 'خزينة', bank: 'بنك', ccp: 'CCP', other: 'أخرى' };
const CHQ_STATUS: Record<string, string> = { in_portfolio: 'في الحافظة', deposited: 'مُودَع', cleared: 'محصَّل / مصروف', rejected: 'مرفوض', issued: 'صادر', cancelled: 'ملغى' };
const PAY_STATUS: Record<string, string> = { paid: 'مدفوع', partial: 'جزئي', unpaid: 'غير مدفوع' };
const YES = 'نعم', NO = 'لا';
const num = (v: unknown) => (v === null || v === undefined ? null : Number(v));
/** Horodatage local Algérie (UTC+1, sans heure d'été) au format ISO avec décalage, lu tel quel par Sheets. */
const iso = (d: unknown) => (d ? new Date(d as string).toISOString() : null);
const day = (d: unknown) => (d ? `${String(d).slice(0, 10)}T12:00:00+01:00` : null);

export async function buildSnapshot(db: Db): Promise<Snapshot> {
  const sym = (await one<{ v: string | null }>(db, "SELECT value #>> '{}' AS v FROM app_settings WHERE key = 'currency_symbol'"))?.v || 'DA';

  // 1. الملخص
  const biz = await many<{ id: string; name: string; position: string; income: string; out: string; ops: string }>(db,
    `SELECT b.id, b.name, activity_position(b.id, local_today()) AS position,
            coalesce(s.income, 0) AS income, coalesce(s.expenses + s.purchases + s.salaries, 0) AS out, coalesce(s.operations, 0) AS ops
     FROM my_businesses() b LEFT JOIN v_daily_summary s ON s.business_id = b.id AND s.local_date = local_today()`);
  const acc = await many<Record<string, any>>(db,
    `SELECT * FROM v_account_balances WHERE is_active ORDER BY business_name, account_name`);
  const total = acc.reduce((n, a) => n + Number(a.balance), 0);

  // 3. العمليات (les plus récentes en haut)
  const tx = await many<Record<string, any>>(db,
    `SELECT ref_no, transaction_date, business_name, account_name, transaction_type, op_type_name, category_name, supplier_name,
            employee_name, description, reference, signed_amount, running_balance, status, created_by_name
     FROM v_ledger ORDER BY transaction_date DESC, ref_no DESC LIMIT 50000`);
  const chq = await many<Record<string, any>>(db,
    `SELECT business_name, direction, cheque_number, bank_name, party_name, amount, issue_date, due_date, status, is_overdue
     FROM v_cheques ORDER BY is_pending DESC, due_date NULLS LAST, issue_date DESC LIMIT 5000`);
  const pay = await many<Record<string, any>>(db,
    `SELECT p.full_name, b.name AS business_name, p.period, p.net_salary, p.advances, p.payments, p.remaining, p.status
     FROM v_payroll_monthly p JOIN businesses b ON b.id = p.business_id
     WHERE p.period >= (date_trunc('month', local_today()) - interval '1 month')::date AND p.period <= local_today()
     ORDER BY p.period DESC, b.sort_order, p.full_name`);
  const mon = await many<Record<string, any>>(db,
    `SELECT b.name AS business_name, m.month, m.income, m.expenses, m.purchases, m.salaries, m.operating_result
     FROM v_monthly_summary m JOIN businesses b ON b.id = m.business_id
     WHERE m.month >= (date_trunc('month', local_today()) - interval '11 months')::date
     ORDER BY m.month DESC, b.sort_order, b.name`);

  const T = TYPE_LABELS.ar;
  return {
    rtl: true,
    labels: { updated: 'آخر تحديث للبيانات', contact: 'آخر اتصال بالخادم', empty: 'لا توجد بيانات' },
    summary: {
      title: 'الملخص', currency: sym,
      total: { label: 'مجموع الخزينة — كل الأنشطة', value: total, note: `عدد الحسابات : ${acc.length}   ·   عدد الأنشطة : ${biz.length}` },
      cards: biz.map((b) => ({
        name: b.name, value: Number(b.position),
        rows: [['إيرادات اليوم', Number(b.income), 'good'], ['مصاريف اليوم', Number(b.out), 'bad'], ['عمليات اليوم', Number(b.ops), 'int']],
      })),
    },
    sheets: [
      {
        key: 'accounts', title: 'أرصدة الحسابات',
        headers: ['النشاط', 'الحساب', 'النوع', `الرصيد الحالي (${sym})`, 'دخل اليوم', 'خروج اليوم', 'آخر حركة', 'مشترك بين الأنشطة'],
        types: ['text', 'text', 'badge', 'signed', 'money', 'money', 'datetime', 'badge'],
        widths: [170, 170, 90, 150, 120, 120, 140, 130],
        rows: acc.map((a) => [(a.business_names?.length ? a.business_names : [a.business_name]).join('، '), a.account_name, KIND[a.kind] ?? a.kind,
          num(a.balance), num(a.today_in), num(a.today_out), iso(a.last_movement_at), a.shared ? YES : NO]),
        marks: [{ col: 7, value: YES, tone: 'warn' }],
      },
      {
        key: 'transactions', title: 'العمليات', note: tx.length >= 50000 ? 'آخر 50000 عملية' : undefined,
        headers: ['رقم', 'التاريخ', 'النشاط', 'الحساب', 'النوع', 'الفئة', 'المورّد / العامل', 'الوصف', 'المرجع', `المبلغ (${sym})`, 'الرصيد بعد العملية', 'الحالة', 'المستخدم'],
        types: ['text', 'datetime', 'text', 'text', 'badge', 'text', 'text', 'text', 'text', 'signed', 'money', 'badge', 'text'],
        widths: [70, 130, 140, 140, 110, 130, 150, 220, 110, 130, 140, 90, 130],
        rows: tx.map((r) => [r.ref_no, iso(r.transaction_date), r.business_name, r.account_name, r.op_type_name ?? T[r.transaction_type] ?? r.transaction_type,
          r.category_name ?? '', r.supplier_name ?? r.employee_name ?? '', r.description ?? '', r.reference ?? '',
          num(r.signed_amount), num(r.running_balance), r.status === 'cancelled' ? 'ملغاة' : 'مُصادَق', r.created_by_name ?? '']),
        marks: [{ col: 11, value: 'ملغاة', tone: 'muted', row: true }],
      },
      {
        key: 'cheques', title: 'الشيكات',
        headers: ['النشاط', 'وارد / صادر', 'رقم الشيك', 'البنك', 'الطرف', `المبلغ (${sym})`, 'تاريخ الإصدار', 'تاريخ الاستحقاق', 'الحالة', 'متأخر'],
        types: ['text', 'badge', 'text', 'text', 'text', 'money', 'date', 'date', 'badge', 'badge'],
        widths: [140, 100, 110, 130, 170, 130, 110, 120, 120, 80],
        rows: chq.map((c) => [c.business_name, c.direction === 'received' ? 'وارد' : 'صادر', c.cheque_number, c.bank_name ?? '', c.party_name,
          num(c.amount), day(c.issue_date), day(c.due_date), CHQ_STATUS[c.status] ?? c.status, c.is_overdue ? YES : NO]),
        marks: [{ col: 9, value: YES, tone: 'bad', row: true }, { col: 1, value: 'وارد', tone: 'good' }, { col: 1, value: 'صادر', tone: 'warn' }],
      },
      {
        key: 'payroll', title: 'الأجور', note: 'الشهر الحالي والشهر السابق',
        headers: ['العامل', 'النشاط', 'الشهر', `الأجر الصافي (${sym})`, 'التسبيقات', 'المدفوع', 'الباقي', 'الحالة'],
        types: ['text', 'text', 'month', 'money', 'money', 'money', 'signed', 'badge'],
        widths: [170, 140, 90, 140, 120, 120, 120, 110],
        rows: pay.map((p) => [p.full_name, p.business_name, day(p.period), num(p.net_salary), num(p.advances), num(p.payments), num(p.remaining),
          PAY_STATUS[p.status] ?? p.status]),
        marks: [{ col: 7, value: PAY_STATUS.paid, tone: 'good' }, { col: 7, value: PAY_STATUS.partial, tone: 'warn' }, { col: 7, value: PAY_STATUS.unpaid, tone: 'bad' }],
      },
      {
        key: 'monthly', title: 'الملخص الشهري', note: 'آخر 12 شهراً',
        headers: ['النشاط', 'الشهر', `الإيرادات (${sym})`, 'المصاريف', 'المشتريات', 'الأجور', 'النتيجة'],
        types: ['text', 'month', 'money', 'money', 'money', 'money', 'signed'],
        widths: [160, 90, 140, 130, 130, 130, 140],
        rows: mon.map((m) => [m.business_name, day(m.month), num(m.income), num(m.expenses), num(m.purchases), num(m.salaries), num(m.operating_result)]),
      },
    ],
  };
}

export class SheetsSync {
  private readonly cfgFile: string;
  private readonly stateFile: string;
  private timer: NodeJS.Timeout | null = null;
  private running: Promise<SheetsState> | null = null;

  constructor(private readonly deps: Deps) {
    this.cfgFile = path.join(deps.dataDir, 'config', 'sheets.json');
    this.stateFile = path.join(deps.dataDir, 'config', 'sheets-state.json');
  }

  async config(): Promise<SheetsConfig> {
    let c: Partial<SheetsConfig> = {};
    try { c = JSON.parse(await fsp.readFile(this.cfgFile, 'utf8')); } catch { /* premier usage */ }
    const cfg: SheetsConfig = { enabled: false, url: '', token: '', intervalMin: 5, userId: null, ...c };
    if (!cfg.token) { cfg.token = crypto.randomBytes(24).toString('base64url'); await this.saveConfig(cfg); }
    return cfg;
  }
  async saveConfig(cfg: SheetsConfig) {
    await fsp.mkdir(path.dirname(this.cfgFile), { recursive: true });
    await fsp.writeFile(this.cfgFile, JSON.stringify(cfg, null, 2), { mode: 0o600 });
  }
  async state(): Promise<SheetsState> {
    let s: Partial<SheetsState> = {};
    try { s = JSON.parse(await fsp.readFile(this.stateFile, 'utf8')); } catch { /* premier usage */ }
    return { lastRunAt: null, lastOkAt: null, lastDataAt: null, lastError: null, lastErrorAt: null, lastHash: null, rows: null, ...s };
  }
  private async saveState(s: SheetsState) {
    await fsp.mkdir(path.dirname(this.stateFile), { recursive: true });
    await fsp.writeFile(this.stateFile, JSON.stringify(s, null, 2));
  }

  /** Vérifie chaque minute si une synchronisation est due. */
  start() {
    if (this.timer) return;
    const tick = async () => {
      try {
        const [cfg, st] = await Promise.all([this.config(), this.state()]);
        if (!cfg.enabled || !cfg.url) return;
        const due = !st.lastRunAt || Date.now() - new Date(st.lastRunAt).getTime() >= cfg.intervalMin * 60_000 - 5_000;
        if (due) await this.run(false);
      } catch (e) { console.error('[cashpro] sheets :', e instanceof Error ? e.message : e); }
    };
    this.timer = setInterval(() => { void tick(); }, 60_000);
    this.timer.unref();
    setTimeout(() => { void tick(); }, 20_000).unref();
  }
  stop() { if (this.timer) clearInterval(this.timer); this.timer = null; }

  /** Lance une synchronisation (une seule à la fois). force : envoie l'instantané même s'il est inchangé. */
  run(force: boolean): Promise<SheetsState> {
    if (!this.running) this.running = this.doRun(force).finally(() => { this.running = null; });
    return this.running;
  }

  private async doRun(force: boolean): Promise<SheetsState> {
    const cfg = await this.config();
    const st = await this.state();
    const now = new Date().toISOString();
    st.lastRunAt = now;
    const fail = async (code: string) => { st.lastError = code; st.lastErrorAt = now; await this.saveState(st); return st; };
    if (!cfg.url) return fail('no_url');
    if (!cfg.userId) return fail('no_user');
    if (typeof fetch !== 'function') return fail('unsupported');
    let snap: Snapshot;
    try {
      snap = await this.deps.db.tx({ userId: cfg.userId, client: 'google-sheets' }, (db) => buildSnapshot(db));
    } catch (e) {
      console.error('[cashpro] sheets (lecture) :', e instanceof Error ? e.message : e);
      return fail('db');
    }
    const hash = crypto.createHash('sha256').update(JSON.stringify(snap)).digest('hex');
    const changed = force || hash !== st.lastHash;
    const body = changed ? { token: cfg.token, at: now, ...snap } : { token: cfg.token, at: now, ping: true, labels: snap.labels };
    let res: globalThis.Response;
    try {
      res = await fetch(cfg.url, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
        redirect: 'follow', signal: AbortSignal.timeout(5 * 60_000),
      });
    } catch { return fail('offline'); }
    type Out = { ok?: boolean; error?: string; rows?: number };
    let out: Out | null = null;
    try { out = await res.json() as Out; } catch { /* page HTML : mauvais lien ou accès non public */ }
    if (!res.ok || !out) return fail(res.status === 404 ? 'not_found' : 'bad_response');
    if (!out.ok) return fail(out.error === 'unauthorized' ? 'unauthorized' : out.error === 'busy' ? 'busy' : 'script');
    st.lastOkAt = now; st.lastError = null; st.lastErrorAt = null;
    if (changed) { st.lastHash = hash; st.lastDataAt = now; st.rows = out.rows ?? null; }
    await this.saveState(st);
    return st;
  }
}
