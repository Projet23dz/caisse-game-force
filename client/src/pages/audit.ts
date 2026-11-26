import { bizOptions, bizWith, clear, empty, errMsg, fmtDate, get, h, input, isAdmin, select, spinner } from '../core.js';
import { t } from '../i18n.js';

const TABLES = ['transactions', 'transfers', 'cheques', 'cash_sessions', 'cash_reconciliations', 'payroll_items', 'employees', 'accounts', 'categories', 'suppliers', 'businesses', 'business_users', 'users', 'app_settings', 'transaction_attachments', 'app'];
const ACTIONS = ['create', 'update', 'cancel', 'close', 'reopen', 'deactivate', 'activate', 'login_success', 'login_failed', 'export'];

export async function auditPage(root: HTMLElement) {
  const bizs = isAdmin() ? bizWith('view_audit') : bizWith('view_audit');
  const st = { page: 1 };
  const biz = select('b', bizOptions(bizs, isAdmin()), isAdmin() ? '' : bizs[0]?.id ?? '');
  const table = select('t', [{ value: '', label: `${t('table')} — ${t('all')}` }, ...TABLES.map((x) => ({ value: x, label: x }))]);
  const action = select('a', [{ value: '', label: `${t('action')} — ${t('all')}` }, ...ACTIONS.map((x) => ({ value: x, label: x }))]);
  const from = input('from', { type: 'date' }); const to = input('to', { type: 'date' });
  const list = h('div', { class: 'col' });
  const load = async () => {
    clear(list).append(spinner());
    try {
      const r = await get('/audit', { businessId: biz.value, table: table.value, action: action.value, from: from.value, to: to.value, page: st.page, limit: 40 });
      clear(list);
      if (!r.items.length) { list.append(empty()); return; }
      list.append(h('div', { class: 'table-wrap' }, h('table', { class: 't' },
        h('thead', null, h('tr', null, [t('date'), t('user'), t('business'), t('table'), t('action'), t('old_value'), t('new_value'), t('reason')].map((c) => h('th', null, c)))),
        h('tbody', null, r.items.map((a: any) => {
          const keys: string[] = a.changed ?? (a.new_values ? Object.keys(a.new_values).filter((k) => !['id', 'created_at', 'updated_at'].includes(k)).slice(0, 6) : []);
          const fmt = (o: any) => keys.filter((k) => o && k in o).map((k) => `${k}: ${JSON.stringify(o[k])}`).join('\n');
          return h('tr', null, h('td', { class: 'num small' }, fmtDate(a.occurred_at, true)), h('td', null, a.user_name ?? '—'), h('td', null, a.business_name ?? '—'),
            h('td', { class: 'small' }, a.table_name), h('td', null, h('span', { class: 'pill' }, a.action)),
            h('td', { style: 'white-space:normal;max-width:260px' }, h('div', { class: 'json' }, fmt(a.old_values))),
            h('td', { style: 'white-space:normal;max-width:260px' }, h('div', { class: 'json' }, fmt(a.new_values))),
            h('td', { style: 'white-space:normal;max-width:220px' }, a.reason ?? ''));
        })))));
      const pages = Math.max(1, Math.ceil(r.total / 40));
      list.append(h('div', { class: 'pager' }, h('span', { class: 'muted small' }, `${r.total} · ${st.page} / ${pages}`),
        h('button', { class: 'btn sm', disabled: st.page <= 1, onclick: () => { st.page--; load(); } }, t('prev')),
        h('button', { class: 'btn sm', disabled: st.page >= pages, onclick: () => { st.page++; load(); } }, t('next'))));
    } catch (e) { clear(list).append(h('div', { class: 'err-box' }, errMsg(e))); }
  };
  [biz, table, action, from, to].forEach((x) => x.addEventListener('change', () => { st.page = 1; load(); }));
  root.append(h('div', { class: 'page-head' }, h('div', null, h('h1', null, t('nav_audit')), h('p', null, t('audit_sub')))),
    h('div', { class: 'card form', style: 'grid-template-columns:repeat(auto-fit,minmax(170px,1fr))' }, biz, table, action, from, to), list);
  await load();
}
