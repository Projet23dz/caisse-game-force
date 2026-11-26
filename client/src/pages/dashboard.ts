import { authImg, can, donut, isNetworkError, empty, fmtDate, get, h, icon, isAdmin, lineChart, me, money, moneyEl, pct, opPill, PALETTE, typeLabel } from '../core.js';
import { t, tk } from '../i18n.js';
import { openBusinessForm } from './businesses.js';
import { openTransaction } from './transactions.js';

export function bizLogo(b: { id: string; code: string; logo_path?: string | null; hasLogo?: boolean }) {
  const fallback = () => h('span', null, b.code.slice(0, 3));
  return h('div', { class: 'logo' }, (b.logo_path || b.hasLogo) ? authImg(`/businesses/${b.id}/logo`, b.code, fallback) : fallback());
}

export async function dashboardPage(root: HTMLElement) {
  // hors connexion : tableau de bord gardé sur l'appareil, sans la liste des dernières opérations
  const [d, recent] = await Promise.all([get('/dashboard'), get('/transactions', { limit: 6 }).catch((e) => { if (isNetworkError(e)) return { items: [] }; throw e; })]);
  const k = d.kpis;
  root.append(
    h('div', { class: 'page-head' }, h('div', null, h('h1', null, t('nav_dashboard')), h('p', null, t('dash_sub'))),
      h('div', { class: 'actions' }, h('button', { class: 'btn pri', onclick: () => openTransaction() }, icon('plus'), t('new_op')))),
    can('view_reports') || can('view_balances') ? h('section', { class: 'grid g4', 'aria-label': 'KPI' },
      can('view_balances') ? kpi(t('global_balance'), k.globalBalance, 'wallet', 'var(--br)', pct(k.globalBalanceChangePct), t('vs_month')) : '',
      can('view_reports') ? [
        kpi(t('today_income'), k.todayIncome, 'up', 'var(--inc)', pct(k.todayIncomeChangePct), t('vs_yesterday')),
        kpi(t('today_expenses'), k.todayExpenses, 'down', 'var(--exp)', pct(k.todayExpensesChangePct), t('vs_yesterday')),
        kpi(t('today_purchases'), k.todayPurchases, 'cart', 'var(--pur)', pct(k.todayPurchasesChangePct), t('vs_yesterday'))] : '') : '',
    h('section', { class: 'grid g3', 'aria-label': t('nav_businesses') },
      d.businesses.map((b: any, i: number) => h('a', { href: `#/business/${b.id}`, class: `card biz ${i === 0 ? 'hero' : ''}` },
        h('div', { class: 'row' }, bizLogo(b), h('div', { class: 'col', style: 'gap:0' }, h('b', { style: 'font-size:18px' }, b.name),
          h('span', { class: 'muted small act' }, me().businesses.find((x) => x.id === b.id)?.activity ?? '')),
          h('span', { class: 'spacer' }), h('span', { class: 'badge', style: 'color:var(--inc)' }, t('active'))),
        h('div', { class: 'row', style: 'gap:28px' },
          h('div', { class: 'col', style: 'gap:0' }, h('span', { class: 'muted small' }, b.sharedBalance != null ? t('own_accounts') : t('balance')),
            b.balance === null ? h('b', null, t('hidden_balance')) : h('b', { style: 'font-size:21px' }, moneyEl(b.balance))),
          b.todayIncome !== null ? h('div', { class: 'col', style: 'gap:0' }, h('span', { class: 'muted small' }, t('today_income')), h('b', { style: 'font-size:21px' }, moneyEl(b.todayIncome))) : null),
        b.sharedBalance != null ? h('div', { class: 'row', style: 'gap:6px' }, h('span', { class: 'shared-tag' }, icon('transfer', 13), `${t('shared_balance')} : ${(b.sharedAccounts ?? []).join(', ')}`),
          h('b', null, moneyEl(b.sharedBalance))) : null,
        h('span', { class: 'deco' }, icon(i === 0 ? 'dashboard' : 'business', 130)))),
      isAdmin() ? h('button', { class: 'card biz add-biz', onclick: () => openBusinessForm() },
        h('span', { class: 'avatar', style: 'background:var(--br);color:var(--brTx);width:50px;height:50px' }, icon('plus', 26)),
        h('b', null, t('add_business')), h('span', { class: 'muted small' }, t('add_business_sub'))) : null),
    can('view_reports') ? h('section', { class: 'grid g2' },
      h('div', { class: 'card span2', style: 'min-width:0' }, h('h2', null, t('evolution30')),
        lineChart(d.series.map((s: any) => fmtDate(s.day).slice(0, 5)), [
          { name: t('income'), values: d.series.map((s: any) => Number(s.income)), color: 'var(--inc)', fill: true },
          { name: t('outflows'), values: d.series.map((s: any) => Number(s.outflows)), color: 'var(--exp)' }])),
      h('div', { class: 'card' }, h('h2', null, t('distribution')),
        donut(d.distribution.map((x: any, i: number) => ({ label: tk('bucket_' + x.bucket), value: Number(x.total), color: PALETTE[i] }))))) : '',
    h('section', { class: 'grid g2' },
      h('div', { class: 'card span2', style: 'min-width:0' },
        h('div', { class: 'row' }, h('h2', { style: 'margin:0' }, t('recent_ops')), h('span', { class: 'spacer' }), h('a', { href: '#/transactions' }, t('see_all'))),
        recent.items.length ? recent.items.map((r: any) => h('div', { class: 'list-row', style: 'cursor:pointer', onclick: () => openTransaction(r.id) },
          opPill(r),
          h('div', { class: 'col', style: 'gap:0;flex:1;min-width:0' }, h('span', null, r.description || r.category_name || '—'),
            h('span', { class: 'muted small' }, `${r.business_name} · ${r.account_name} · ${fmtDate(r.transaction_date, true)}`)),
          h('b', { class: `c-${r.transaction_type}`, style: r.status === 'cancelled' ? 'text-decoration:line-through;opacity:.6' : '' },
            h('span', { class: 'num' }, money(r.signed_amount, true)), ' ', t('currency')))) : empty()),
      h('div', { class: 'card col' }, h('h2', { style: 'margin:0' }, t('alerts')), alerts(d.alerts))),
  );
}

function kpi(label: string, value: string | null, ic: string, color: string, change: Node | null, changeLabel: string) {
  return h('div', { class: 'card kpi', style: `border-top-color:${color}` },
    h('div', { class: 'ico', style: `color:${color}` }, icon(ic)),
    h('div', { class: 'col', style: 'gap:2px' }, h('span', { class: 'l' }, label),
      h('span', { class: 'v' }, value === null ? t('hidden_balance') : moneyEl(value)),
      change ? h('span', { class: 'small muted' }, change, ' ', changeLabel) : null));
}

function alerts(a: any) {
  const rows: Node[] = [];
  const item = (color: string, title: string, sub: Node | string, href: string) =>
    rows.push(h('a', { class: 'alert', href, style: 'text-decoration:none;color:inherit' }, h('span', { class: 'dot', style: `background:${color}` }),
      h('div', { class: 'col', style: 'gap:0' }, h('b', null, title), h('span', { class: 'muted small' }, sub))));
  for (const c of a.chequesDue) item(c.is_overdue ? 'var(--exp)' : 'var(--trf)', t('alert_cheques'), h('span', null, `${c.business_name} · ${c.party_name} · `, moneyEl(c.amount), ` · ${fmtDate(c.due_date)}`), '#/cheques');
  for (const s of a.sessionsPendingReview) item('var(--exp)', t('alert_pending'), h('span', null, `${s.account_name} · ${fmtDate(s.session_date)} · `, moneyEl(s.difference, { sign: true })), '#/treasury');
  for (const s of a.sessionsNotClosed) item('var(--warn)', t('alert_unclosed'), `${s.account_name} · ${fmtDate(s.session_date)}`, '#/treasury');
  for (const p of a.payrollUnpaid) item('var(--pur)', t('alert_payroll'), h('span', null, `${me().businesses.find((b) => b.id === p.business_id)?.name ?? ''} · ${p.employees} · `, moneyEl(p.remaining)), '#/payroll');
  return rows.length ? rows : [h('div', { class: 'muted' }, t('no_alerts'))];
}
