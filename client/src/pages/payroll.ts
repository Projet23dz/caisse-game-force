import { api, bizOptions, bizWith, can, clear, empty, errMsg, field, fmtDate, formData, get, h, icon, input, modal, money, moneyEl, monthStart, nullIfEmpty, post, select, spinner, toast, today, typeLabel } from '../core.js';
import { getLang, t, tk } from '../i18n.js';
import { accountsOf, toIso } from './transactions.js';

const monthLabel = (d: string) => new Intl.DateTimeFormat(getLang() === 'ar' ? 'ar-DZ' : getLang() === 'fr' ? 'fr-FR' : 'en-GB', { month: 'long', year: 'numeric' }).format(new Date(d + 'T12:00:00'));

export async function payrollPage(root: HTMLElement) {
  const bizs = [...new Map([...bizWith('payroll'), ...bizWith('manage_employees')].map((b) => [b.id, b])).values()];
  if (!bizs.length) { root.append(empty()); return; }
  const biz = select('b', bizOptions(bizs), bizs[0].id, { style: 'width:auto' });
  const month = input('m', { type: 'month', value: today().slice(0, 7), style: 'width:auto' });
  const box = h('div', { class: 'col', style: 'gap:20px' });
  const load = async () => { clear(box).append(spinner()); try { await render(box, biz.value, month.value + '-01', load); } catch (e) { clear(box).append(h('div', { class: 'err-box' }, errMsg(e))); } };
  biz.addEventListener('change', load); month.addEventListener('change', load);
  root.append(h('div', { class: 'page-head' }, h('div', null, h('h1', null, t('nav_payroll')), h('p', null, t('pay_sub'))),
    h('div', { class: 'actions' }, bizs.length > 1 ? biz : null, month,
      can('manage_employees', biz.value) ? h('button', { class: 'btn pri', onclick: () => employeeForm(biz.value, null, load) }, icon('plus'), t('add_employee')) : null)), box);
  await load();
}

async function render(box: HTMLElement, bizId: string, period: string, reload: () => void) {
  const [emps, monthly] = await Promise.all([get<any[]>(`/businesses/${bizId}/employees`, { all: true }), can('payroll', bizId) ? get<any[]>('/payroll/monthly', { businessId: bizId, period }) : Promise.resolve([])]);
  clear(box);
  const byEmp = new Map(monthly.map((m) => [m.employee_id, m]));
  const totals = monthly.reduce((a, m) => ({ net: a.net + Number(m.net_salary), adv: a.adv + Number(m.advances), paid: a.paid + Number(m.payments), rem: a.rem + Math.max(0, Number(m.remaining)) }), { net: 0, adv: 0, paid: 0, rem: 0 });
  const k = (label: string, v: number, color: string) => h('div', { class: 'card kpi', style: `border-top-color:${color}` }, h('div', { class: 'col', style: 'gap:2px' }, h('span', { class: 'l' }, label), h('span', { class: 'v' }, moneyEl(v))));
  box.append(h('div', { class: 'muted' }, monthLabel(period)),
    h('section', { class: 'grid g4' }, k(t('net_salary'), totals.net, 'var(--pur)'), k(t('advances'), totals.adv, 'var(--trf)'), k(t('paid'), totals.paid, 'var(--inc)'), k(t('remaining'), totals.rem, 'var(--exp)')));
  if (!emps.length) { box.append(empty()); return; }
  box.append(h('div', { class: 'table-wrap' }, h('table', { class: 't' },
    h('thead', null, h('tr', null, [t('name'), t('job'), t('salary'), t('bonus'), t('deduction'), t('advances'), t('paid'), t('carried'), t('remaining'), t('status'), t('actions')].map((c) => h('th', null, c)))),
    h('tbody', null, emps.map((e) => {
      const m = byEmp.get(e.id);
      const rem = m ? Number(m.remaining) : null;
      return h('tr', { style: e.is_active ? '' : 'opacity:.5' },
        h('td', null, h('a', { href: '#', onclick: (ev: Event) => { ev.preventDefault(); statement(e); } }, e.full_name)), h('td', null, e.job_title ?? '—'),
        h('td', null, moneyEl(e.monthly_salary)), h('td', { class: 'up' }, m ? h('span', { class: 'num' }, money(m.bonuses)) : '—'), h('td', { class: 'down' }, m ? h('span', { class: 'num' }, money(m.deductions)) : '—'),
        h('td', null, m ? h('span', { class: 'num' }, money(m.advances)) : '—'), h('td', null, m ? h('span', { class: 'num' }, money(m.payments)) : '—'),
        h('td', null, m ? h('span', { class: 'num' }, money(m.carried_over, true)) : '—'),
        h('td', { style: `font-weight:700;color:${rem !== null && rem < 0 ? 'var(--exp)' : 'var(--tx)'}` }, rem === null ? '—' : h('span', { class: 'num' }, money(rem)), rem !== null && rem < 0 ? h('div', { class: 'small' }, t('debt')) : null),
        h('td', null, m ? h('span', { class: 'pill', style: `color:${m.status === 'paid' ? 'var(--inc)' : m.status === 'partial' ? 'var(--trf)' : 'var(--exp)'}` }, tk('p_' + m.status)) : '—'),
        h('td', null, h('div', { class: 'row', style: 'gap:4px;flex-wrap:nowrap' },
          can('payroll', bizId) && e.is_active ? [
            h('button', { class: 'btn sm', onclick: () => movement('advance', e, period, null, reload) }, t('advance')),
            h('button', { class: 'btn pri sm', onclick: () => movement('payment', e, period, rem, reload) }, t('pay')),
            h('button', { class: 'btn sm', title: `${t('bonus')} / ${t('deduction')}`, onclick: () => item(e, period, reload) }, '±')] : null,
          can('manage_employees', bizId) ? h('button', { class: 'btn ghost sm', 'aria-label': t('edit'), onclick: () => employeeForm(bizId, e, reload) }, icon('pen', 15)) : null)));
    })))));
}

function employeeForm(bizId: string, e: any | null, done: () => void) {
  const f = h('div', { class: 'form' }, field(t('full_name'), input('fullName', { value: e?.full_name ?? '', required: true })), field(t('job'), input('jobTitle', { value: e?.job_title ?? '' })),
    field(t('phone'), input('phone', { value: e?.phone ?? '', dir: 'ltr' })), field(`${t('salary')} (${t('currency')})`, input('monthlySalary', { value: e?.monthly_salary ?? '', dir: 'ltr', required: true })),
    field(t('start_date'), input('startDate', { type: 'date', value: e?.start_date ?? monthStart() })),
    field(t('notes'), h('textarea', { class: 'input', name: 'notes' }, e?.notes ?? ''), 'full'),
    e ? h('label', { class: 'check full' }, h('input', { type: 'checkbox', name: 'isActive', checked: e.is_active }), t('active')) : null);
  modal({ title: e ? e.full_name : t('add_employee'), body: f, onSubmit: async (close) => {
    const d = formData(f);
    const body: Record<string, unknown> = { fullName: d.fullName, jobTitle: nullIfEmpty(d.jobTitle), phone: nullIfEmpty(d.phone), monthlySalary: d.monthlySalary, startDate: d.startDate, notes: nullIfEmpty(d.notes) };
    if (e) { body.isActive = d.isActive === '1'; await api('PATCH', `/employees/${e.id}`, body); } else await post(`/businesses/${bizId}/employees`, body);
    toast(t('saved'), 'ok'); close(); done();
  } });
}

async function movement(kind: 'advance' | 'payment', e: any, period: string, remaining: number | null, done: () => void) {
  const accs = await accountsOf(e.business_id, { onlyAllowed: true });
  const f = h('div', { class: 'form' },
    h('div', { class: 'full' }, h('b', null, e.full_name), ' · ', monthLabel(period), remaining !== null && kind === 'payment' ? h('span', { class: 'muted' }, ` · ${t('remaining')} : ${money(remaining)} ${t('currency')}`) : null),
    field(`${t('amount')} (${t('currency')})`, input('amount', { required: true, dir: 'ltr', inputmode: 'decimal', value: kind === 'payment' && remaining && remaining > 0 ? String(remaining) : '' })),
    field(t('account'), select('accountId', accs.map((a) => ({ value: a.id, label: `${a.name}${a.balance != null ? ' — ' + money(a.balance) : ''}` })))),
    field(t('date'), input('date', { type: 'datetime-local', value: new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 16) })),
    field(t('notes'), input('notes'), 'full'));
  modal({ title: kind === 'advance' ? typeLabel('salary_advance') : typeLabel('salary_payment'), body: f, onSubmit: async (close) => {
    const d = formData(f);
    await post(`/payroll/${kind}`, { employeeId: e.id, period, amount: d.amount, accountId: d.accountId, date: toIso(d.date), notes: nullIfEmpty(d.notes) });
    toast(t('saved'), 'ok'); close(); done(); window.dispatchEvent(new Event('cp:changed'));
  } });
}

function item(e: any, period: string, done: () => void) {
  const f = h('div', { class: 'form' }, field(t('type'), select('kind', [{ value: 'bonus', label: t('bonus') }, { value: 'deduction', label: t('deduction') }])),
    field(`${t('amount')} (${t('currency')})`, input('amount', { required: true, dir: 'ltr' })), field(t('reason_required'), input('reason', { required: true }), 'full'));
  modal({ title: `${t('bonus')} / ${t('deduction')} — ${e.full_name}`, body: f, onSubmit: async (close) => {
    const d = formData(f);
    await post('/payroll/items', { employeeId: e.id, period, kind: d.kind, amount: d.amount, reason: d.reason });
    toast(t('saved'), 'ok'); close(); done();
  } });
}

async function statement(e: any) {
  const body = h('div', { class: 'col' }, spinner());
  modal({ title: `${t('statement')} — ${e.full_name}`, body, wide: true });
  try {
    const s = await get(`/employees/${e.id}/statement`);
    clear(body).append(
      s.months.length ? h('div', { class: 'table-wrap' }, h('table', { class: 't' }, h('thead', null, h('tr', null, [t('month'), t('net_salary'), t('advances'), t('paid'), t('remaining'), t('status')].map((c) => h('th', null, c)))),
        h('tbody', null, s.months.map((m: any) => h('tr', null, h('td', null, monthLabel(m.period)), h('td', null, moneyEl(m.net_salary)), h('td', null, moneyEl(m.advances)),
          h('td', null, moneyEl(m.payments)), h('td', { style: 'font-weight:700' }, moneyEl(m.remaining)), h('td', null, tk('p_' + m.status))))))) : empty(),
      h('h3', { style: 'margin:8px 0 0' }, t('nav_transactions')),
      s.movements.length ? h('div', { class: 'table-wrap' }, h('table', { class: 't' }, h('thead', null, h('tr', null, [t('ref'), t('date'), t('type'), t('month'), t('account'), t('amount'), t('status')].map((c) => h('th', null, c)))),
        h('tbody', null, s.movements.map((m: any) => h('tr', { class: m.status === 'cancelled' ? 'cancelled' : '' }, h('td', { class: 'num' }, '#' + m.ref_no), h('td', { class: 'num' }, fmtDate(m.transaction_date, true)),
          h('td', null, typeLabel(m.transaction_type)), h('td', null, monthLabel(m.payroll_period)), h('td', null, m.account_name), h('td', { class: 'amt' }, moneyEl(m.amount)), h('td', null, tk(m.status))))))) : empty(),
      s.items.length ? h('div', { class: 'col', style: 'gap:4px' }, h('h3', { style: 'margin:8px 0 0' }, `${t('bonus')} / ${t('deduction')}`),
        s.items.map((i: any) => h('div', { class: 'list-row' }, h('span', { class: i.kind === 'bonus' ? 'up' : 'down' }, i.kind === 'bonus' ? t('bonus') : t('deduction')),
          h('span', null, monthLabel(i.period)), h('span', { class: 'muted' }, i.reason), h('span', { class: 'spacer' }), moneyEl(i.amount), i.status === 'cancelled' ? h('span', { class: 'badge' }, t('cancelled')) : null))) : '');
  } catch (er) { clear(body).append(h('div', { class: 'err-box' }, errMsg(er))); }
}
