// 1.2.0 — Alertes d'activité (🔔) pour l'administrateur : ajouts, modifications et annulations des autres utilisateurs.
import { api, clear, empty, errMsg, fmtDate, get, h, icon, money, opLabel, spinner, toast, typeLabel } from '../core.js';
import { t, tk } from '../i18n.js';
import { openDetails } from './transactions.js';

const ACTION_CLS: Record<string, string> = { create: 'st-new', update: 'st-edited', cancel: 'st-cancelled', close: 'st-new', reopen: 'st-edited' };
const TABLE_KEY: Record<string, string> = { transactions: 'act_t_txn', transfers: 'act_t_transfer', cheques: 'act_t_cheque', cash_sessions: 'act_t_session', payroll_items: 'act_t_payroll' };
const FIELD_KEY: Record<string, string> = { description: 'description', reference: 'reference', notes: 'notes', category_id: 'category',
  payment_method_id: 'payment_method', supplier_id: 'supplier', status: 'status', amount: 'amount', cancel_reason: 'cancelled_reason' };
const shown = (v: unknown) => (v === null || v === undefined || v === '' ? '—' : typeof v === 'object' ? JSON.stringify(v) : String(v));

export async function activityPage(root: HTMLElement) {
  const st = { unread: true, page: 1 };
  const list = h('div', { class: 'col', style: 'gap:10px' });
  const unreadBtn = h('button', { class: 'chip on', 'aria-pressed': 'true' }, t('act_unread'));
  const allBtn = h('button', { class: 'chip', 'aria-pressed': 'false' }, t('all'));
  const markAll = h('button', { class: 'btn pri sm' }, icon('check', 15), t('act_mark_all'));
  const setTab = (u: boolean) => { st.unread = u; st.page = 1; unreadBtn.classList.toggle('on', u); allBtn.classList.toggle('on', !u);
    unreadBtn.setAttribute('aria-pressed', String(u)); allBtn.setAttribute('aria-pressed', String(!u)); void load(); };
  unreadBtn.addEventListener('click', () => setTab(true));
  allBtn.addEventListener('click', () => setTab(false));
  markAll.addEventListener('click', async () => {
    try { await api('POST', '/alerts/mark', {}); toast(t('act_marked'), 'ok'); window.dispatchEvent(new Event('cp:alerts')); void load(); }
    catch (e) { toast(errMsg(e), 'err'); }
  });

  const item = (a: any) => {
    const mark = h('button', { class: 'btn sm', title: t('act_mark') }, icon('check', 14), t('act_mark'));
    mark.addEventListener('click', async (e) => {
      e.stopPropagation();
      try { await api('POST', '/alerts/mark', { ids: [a.id] }); window.dispatchEvent(new Event('cp:alerts'));
        if (st.unread) card.remove(); else { card.classList.remove('unread'); mark.remove(); } }
      catch (er) { toast(errMsg(er), 'err'); }
    });
    const what = a.table_name === 'transactions' && a.transaction_type
      ? `${opLabel(a)}${a.ref_no ? ` ⁦#${a.ref_no}⁩` : ''}${a.category_name ? ` · ${a.category_name}` : ''}`
      : tk(TABLE_KEY[a.table_name] ?? 'act_t_txn');
    const changes = a.action === 'update' && a.changed?.length
      ? h('div', { class: 'col small', style: 'gap:2px' }, a.changed.filter((k: string) => k !== 'updated_at').map((k: string) =>
        h('div', null, h('b', null, FIELD_KEY[k] ? tk(FIELD_KEY[k]) : k), ' : ',
          h('span', { style: 'text-decoration:line-through;opacity:.7' }, shown(a.old_values?.[k])), ' → ', h('span', null, shown(a.new_values?.[k])))))
      : null;
    const card: HTMLElement = h('div', { class: `card col act ${a.reviewed ? '' : 'unread'}`, style: 'gap:6px;padding:14px 16px;cursor:pointer' },
      h('div', { class: 'row', style: 'gap:8px;flex-wrap:wrap' },
        h('span', { class: `badge ${ACTION_CLS[a.action] ?? ''}` }, tk('act_' + a.action)),
        h('b', { style: 'flex:1;min-width:160px' }, what),
        a.amount != null ? h('b', { class: 'num', dir: 'ltr' }, `${money(a.amount)} ${t('currency')}`) : null,
        a.reviewed ? h('span', { class: 'muted small' }, icon('check', 13), ' ', t('act_reviewed')) : mark),
      h('div', { class: 'muted small' }, `${a.user_name ?? '—'} · ${a.business_name ?? ''} · ${fmtDate(a.occurred_at, true)}`),
      changes,
      a.reason ? h('div', { class: 'small' }, `${t('cancelled_reason')} : ${a.reason}`) : null);
    if (a.table_name === 'transactions') card.addEventListener('click', () => openDetails(a.record_id));
    return card;
  };

  const load = async () => {
    clear(list).appendChild(spinner());
    try {
      const r = await get('/alerts', { unread: st.unread ? 1 : undefined, page: st.page, limit: 30 });
      clear(list);
      unreadBtn.textContent = `${t('act_unread')} (${r.unread})`;
      markAll.toggleAttribute('disabled', !r.unread);
      if (!r.items.length) { list.append(empty(st.unread ? t('act_none') : undefined)); return; }
      r.items.forEach((a: any) => list.append(item(a)));
      const pages = Math.max(1, Math.ceil(r.total / 30));
      if (pages > 1) list.append(h('div', { class: 'pager' }, h('span', { class: 'muted small' }, `${st.page} / ${pages}`),
        h('button', { class: 'btn sm', disabled: st.page <= 1, onclick: () => { st.page--; void load(); } }, t('prev')),
        h('button', { class: 'btn sm', disabled: st.page >= pages, onclick: () => { st.page++; void load(); } }, t('next'))));
    } catch (e) { clear(list).append(h('div', { class: 'err-box' }, errMsg(e))); }
  };

  root.append(
    h('div', { class: 'row' }, h('h1', { style: 'margin:0' }, icon('bell'), ' ', t('act_title')), h('span', { class: 'spacer' }), markAll),
    h('p', { class: 'muted small', style: 'margin:0' }, t('act_hint')),
    h('div', { class: 'row', role: 'group' }, unreadBtn, allBtn),
    list);
  void typeLabel;
  await load();
}
