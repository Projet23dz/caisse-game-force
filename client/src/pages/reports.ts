import { bizOptions, bizWith, can, clear, donut, download, empty, errMsg, fmtDate, get, h, icon, input, kindLabel, lineChart, money, moneyEl, monthStart, PALETTE, select, spinner, toast, today } from '../core.js';
import { getLang, t, tk } from '../i18n.js';

export async function reportsPage(root: HTMLElement) {
  const bizs = bizWith('view_reports');
  const biz = select('b', bizOptions(bizs, true), '', { style: 'width:auto' });
  const from = input('from', { type: 'date', value: monthStart() }); const to = input('to', { type: 'date', value: today() });
  const presets: [string, () => [string, string]][] = [
    [t('days7'), () => [today(-6), today()]], [t('days30'), () => [today(-29), today()]],
    [t('this_month'), () => [monthStart(), today()]], [t('this_year'), () => [today().slice(0, 4) + '-01-01', today()]],
  ];
  const box = h('div', { class: 'col', style: 'gap:20px' });
  const load = async () => { clear(box).append(spinner()); try { await render(box, biz.value, from.value, to.value); } catch (e) { clear(box).append(h('div', { class: 'err-box' }, errMsg(e))); } };
  [biz, from, to].forEach((x) => x.addEventListener('change', load));
  root.append(h('div', { class: 'page-head' }, h('div', null, h('h1', null, t('nav_reports')), h('p', null, t('rep_sub'))),
    h('div', { class: 'actions' }, can('export') ? h('button', { class: 'btn', onclick: () => download(`/export/transactions?format=xlsx&lang=${getLang()}&from=${from.value}&to=${to.value}${biz.value ? '&businessId=' + biz.value : ''}`, 'cashpro.xlsx').catch((e) => toast(errMsg(e), 'err')) }, icon('download'), 'Excel') : null,
      can('export') ? h('button', { class: 'btn', onclick: () => download(`/export/transactions?format=pdf&lang=${getLang()}&from=${from.value}&to=${to.value}${biz.value ? '&businessId=' + biz.value : ''}`, 'cashpro.pdf').catch((e) => toast(errMsg(e), 'err')) }, icon('download'), 'PDF') : null,
      h('button', { class: 'btn', onclick: () => window.print() }, icon('print'), t('print')))),
  h('div', { class: 'card row' }, presets.map(([label, fn]) => h('button', { class: 'chip', onclick: () => { [from.value, to.value] = fn(); load(); } }, label)),
    h('span', { class: 'spacer' }), bizs.length > 1 ? biz : null, h('label', { class: 'row', style: 'gap:6px' }, t('from'), from), h('label', { class: 'row', style: 'gap:6px' }, t('to'), to)), box);
  await load();
}

async function render(box: HTMLElement, businessId: string, from: string, to: string) {
  const q = { businessId, from, to };
  const [daily, monthly, dist, incomes, balances] = await Promise.all([
    get('/reports/summary', { ...q, groupBy: 'day' }), get('/reports/summary', { ...q, groupBy: 'month' }),
    get<any[]>('/reports/expense-distribution', q), get<any[]>('/reports/income-by-category', q), get<any[]>('/reports/balances', { businessId }),
  ]);
  clear(box);
  const T = daily.totals;
  const k = (label: string, v: string, color: string) => h('div', { class: 'card kpi', style: `border-top-color:${color}` }, h('div', { class: 'col', style: 'gap:2px' }, h('span', { class: 'l' }, label), h('span', { class: 'v' }, moneyEl(v))));
  box.append(h('section', { class: 'grid g4' }, k(t('income'), T.income, 'var(--inc)'), k(t('expenses'), T.expenses, 'var(--exp)'), k(t('purchases'), T.purchases, 'var(--pur)'),
    k(t('salaries'), T.salaries, 'var(--warn)'), k(t('operating_result'), T.operating_result, Number(T.operating_result) >= 0 ? 'var(--inc)' : 'var(--exp)'),
    k(t('withdrawals'), T.withdrawals, 'var(--mu)'), k(t('cash_diff'), T.cash_differences, 'var(--mu)'), k(t('net_change'), T.net_change, 'var(--br)')));
  // courbe journalière (toutes activités cumulées)
  const days = new Map<string, { inc: number; out: number }>();
  for (const r of daily.rows) { const d = days.get(r.period) ?? { inc: 0, out: 0 }; d.inc += Number(r.income); d.out += Number(r.expenses) + Number(r.purchases) + Number(r.salaries); days.set(r.period, d); }
  const keys = [...days.keys()].sort();
  box.append(h('section', { class: 'grid g2' },
    h('div', { class: 'card span2', style: 'min-width:0' }, h('h2', null, `${t('income')} / ${t('outflows')}`),
      keys.length ? lineChart(keys.map((d) => fmtDate(d).slice(0, 5)), [{ name: t('income'), values: keys.map((d) => days.get(d)!.inc), color: 'var(--inc)', fill: true },
        { name: t('outflows'), values: keys.map((d) => days.get(d)!.out), color: 'var(--exp)' }]) : empty()),
    h('div', { class: 'card' }, h('h2', null, t('distribution').split('—')[0]),
      donut(dist.slice(0, 7).map((x, i) => ({ label: x.category_name ?? tk('bucket_' + x.bucket), value: Number(x.total), color: x.color ?? PALETTE[i] }))))));
  // par activité et par mois
  box.append(h('div', { class: 'card col' }, h('h2', { style: 'margin:0' }, t('by_business')),
    monthly.rows.length ? h('div', { class: 'table-wrap' }, h('table', { class: 't' },
      h('thead', null, h('tr', null, [t('month'), t('business'), t('income'), t('expenses'), t('purchases'), t('salaries'), t('cash_diff'), t('operating_result'), t('net_change')].map((c) => h('th', null, c)))),
      h('tbody', null, monthly.rows.map((r: any) => h('tr', null, h('td', { class: 'num' }, r.period.slice(0, 7)), h('td', null, r.business_name),
        ...['income', 'expenses', 'purchases', 'salaries', 'cash_differences', 'operating_result', 'net_change'].map((c) =>
          h('td', { class: c === 'income' ? 'up' : c === 'operating_result' || c === 'net_change' ? '' : 'down', style: c === 'operating_result' ? 'font-weight:700' : '' }, h('span', { class: 'num' }, money(r[c]))))))))) : empty()));
  box.append(h('section', { class: 'grid g2' },
    h('div', { class: 'card col' }, h('h2', { style: 'margin:0' }, t('income_by_cat')),
      incomes.length ? incomes.map((r) => h('div', { class: 'list-row' }, h('span', { style: `width:10px;height:10px;border-radius:3px;background:${r.color ?? 'var(--inc)'}` }),
        h('span', null, r.category_name ?? '—'), h('span', { class: 'muted small' }, r.business_name), h('span', { class: 'spacer' }), moneyEl(r.total))) : empty()),
    h('div', { class: 'card col' }, h('h2', { style: 'margin:0' }, t('balances')),
      balances.length ? balances.map((r) => h('div', { class: 'list-row' }, h('span', null, `${r.business_name} · ${r.account_name}`), h('span', { class: 'muted small' }, kindLabel(r.kind)),
        h('span', { class: 'spacer' }), h('b', null, moneyEl(r.balance)))) : empty())));
}
