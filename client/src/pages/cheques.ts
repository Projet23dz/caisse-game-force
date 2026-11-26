import { askReason, bizOptions, bizWith, can, clear, empty, errMsg, field, fmtDate, formData, get, h, icon, input, modal, moneyEl, nullIfEmpty, post, select, spinner, toast, today } from '../core.js';
import { t, tk } from '../i18n.js';
import { refreshBell } from '../main.js';
import { accountsOf } from './transactions.js';

export async function chequesPage(root: HTMLElement) {
  const bizs = bizWith('cheques');
  const st = { businessId: '', direction: '', pending: 'true' };
  const list = h('div', { class: 'col' });
  const biz = select('b', bizOptions(bizs, true), '', { style: 'width:auto' });
  const chips = h('div', { class: 'row' });
  const drawChips = () => {
    clear(chips);
    const c = (label: string, on: boolean, fn: () => void) => chips.appendChild(h('button', { class: `chip ${on ? 'on' : ''}`, onclick: () => { fn(); drawChips(); load(); } }, label));
    c(t('pending'), st.pending === 'true', () => { st.pending = st.pending === 'true' ? '' : 'true'; });
    c(t('all'), st.direction === '', () => { st.direction = ''; });
    c(t('received'), st.direction === 'received', () => { st.direction = 'received'; });
    c(t('issued'), st.direction === 'issued', () => { st.direction = 'issued'; });
  };
  const load = async () => {
    clear(list).append(spinner());
    try {
      const rows = await get<any[]>('/cheques', { businessId: biz.value, direction: st.direction, pending: st.pending });
      clear(list).append(rows.length ? h('div', { class: 'table-wrap' }, h('table', { class: 't' },
        h('thead', null, h('tr', null, [t('cheque_no'), t('business'), t('type'), t('bank'), `${t('drawer')} / ${t('payee')}`, t('amount'), t('due_date'), t('status'), t('actions')].map((c) => h('th', null, c)))),
        h('tbody', null, rows.map((c) => h('tr', null,
          h('td', { class: 'num' }, c.cheque_number), h('td', null, c.business_name),
          h('td', null, h('span', { class: `pill ${c.direction === 'received' ? 'c-income' : 'c-purchase'}` }, c.direction === 'received' ? t('received') : t('issued'))),
          h('td', null, c.bank_name ?? '—'), h('td', null, c.party_name), h('td', { style: 'font-weight:700' }, moneyEl(c.amount)),
          h('td', { class: 'num', style: c.is_overdue ? 'color:var(--exp);font-weight:700' : '' }, fmtDate(c.due_date), c.is_overdue ? ` · ${t('overdue')}` : ''),
          h('td', null, tk('st_' + c.status)), h('td', null, actions(c, load))))))) : empty());
    } catch (e) { clear(list).append(h('div', { class: 'err-box' }, errMsg(e))); }
  };
  biz.addEventListener('change', load);
  root.append(h('div', { class: 'page-head' }, h('div', null, h('h1', null, t('nav_cheques')), h('p', null, t('ch_sub'))),
    h('div', { class: 'actions' }, h('button', { class: 'btn', onclick: () => chequeForm('received', load) }, icon('down'), t('receive_cheque')),
      h('button', { class: 'btn pri', onclick: () => chequeForm('issued', load) }, icon('up'), t('issue_cheque')))),
  h('div', { class: 'card row' }, bizs.length > 1 ? biz : null, chips), list);
  drawChips(); await load();
}

function actions(c: any, reload: () => void) {
  if (!can('cheques', c.business_id)) return null;
  const done = () => { toast(t('saved'), 'ok'); refreshBell(); reload(); window.dispatchEvent(new Event('cp:changed')); };
  const run = (path: string, body: unknown = {}) => async () => { try { await post(`/cheques/${c.id}/${path}`, body); done(); } catch (e) { toast(errMsg(e), 'err'); } };
  const b: Node[] = [];
  if (c.direction === 'received' && c.status === 'in_portfolio') b.push(h('button', { class: 'btn sm', onclick: () => depositForm(c, done) }, t('deposit_ch')));
  if ((c.direction === 'received' && c.status === 'deposited') || (c.direction === 'issued' && c.status === 'issued')) b.push(h('button', { class: 'btn pri sm', onclick: run('clear') }, t('clear_ch')));
  if (c.direction === 'received' && ['in_portfolio', 'deposited', 'cleared'].includes(c.status)) b.push(h('button', { class: 'btn danger sm', onclick: () => askReason(t('reject_ch'), async (reason) => { await post(`/cheques/${c.id}/reject`, { reason }); done(); }) }, t('reject_ch')));
  if (c.direction === 'issued' && c.status === 'issued') b.push(h('button', { class: 'btn danger sm', onclick: () => askReason(t('cancel_ch'), async (reason) => { await post(`/cheques/${c.id}/cancel`, { reason }); done(); }) }, t('cancel_ch')));
  return h('div', { class: 'row', style: 'gap:6px;flex-wrap:nowrap' }, b);
}

async function depositForm(c: any, done: () => void) {
  const accs = await accountsOf(c.business_id, { kinds: ['bank', 'ccp'] });
  const s = select('accountId', accs.map((a) => ({ value: a.id, label: a.name })));
  modal({ title: `${t('deposit_ch')} — ${c.cheque_number}`, body: field(t('account'), s), submitText: t('confirm'),
    onSubmit: async (close) => { await post(`/cheques/${c.id}/deposit`, { accountId: s.value }); close(); done(); } });
}

async function chequeForm(direction: 'received' | 'issued', reload: () => void) {
  const bizs = bizWith('cheques');
  const biz = select('businessId', bizOptions(bizs));
  const txnType = select('txnType', (direction === 'received' ? ['income', 'deposit'] : ['purchase', 'expense', 'withdrawal']).map((x) => ({ value: x, label: tk('t_' + x) })));
  const cat = select('categoryId', []); const acc = select('accountId', []); const sup = select('supplierId', []);
  const refresh = async () => {
    const cats = await get<any[]>(`/businesses/${biz.value}/categories`, { type: txnType.value });
    clear(cat).append(h('option', { value: '' }, t('choose')), ...cats.map((c) => h('option', { value: c.id }, c.name)));
    if (direction === 'issued') {
      const accs = await accountsOf(biz.value, { kinds: ['bank', 'ccp'] });
      clear(acc).append(...accs.map((a) => h('option', { value: a.id }, `${a.name}${a.bank_name ? ' · ' + a.bank_name : ''}`)));
      const sups = await get<any[]>(`/businesses/${biz.value}/suppliers`);
      clear(sup).append(h('option', { value: '' }, '—'), ...sups.map((s) => h('option', { value: s.id }, s.name)));
    }
  };
  biz.addEventListener('change', refresh); txnType.addEventListener('change', refresh);
  const f = h('div', { class: 'form' }, field(t('business'), biz), field(t('type'), txnType), field(t('category'), cat),
    direction === 'issued' ? field(t('account'), acc) : field(t('bank'), input('bank')),
    field(t('cheque_no'), input('number', { required: true, dir: 'ltr' })),
    field(direction === 'received' ? t('drawer') : t('payee'), input('party', { required: true })),
    field(`${t('amount')} (${t('currency')})`, input('amount', { required: true, dir: 'ltr', inputmode: 'decimal' })),
    field(t('issue_date'), input('issueDate', { type: 'date', value: today() })), field(t('due_date'), input('dueDate', { type: 'date' })),
    direction === 'issued' ? field(t('supplier'), sup) : null,
    field(t('notes'), h('textarea', { class: 'input', name: 'notes' }), 'full'));
  await refresh();
  modal({ title: direction === 'received' ? t('receive_cheque') : t('issue_cheque'), body: f, onSubmit: async (close) => {
    const d = formData(f);
    if (direction === 'received') await post('/cheques/receive', { businessId: d.businessId, number: d.number, bank: nullIfEmpty(d.bank), drawer: d.party, amount: d.amount,
      issueDate: d.issueDate, dueDate: nullIfEmpty(d.dueDate), txnType: d.txnType, categoryId: nullIfEmpty(d.categoryId), notes: nullIfEmpty(d.notes) });
    else await post('/cheques/issue', { businessId: d.businessId, accountId: d.accountId, number: d.number, payee: d.party, amount: d.amount, issueDate: d.issueDate,
      dueDate: nullIfEmpty(d.dueDate), txnType: d.txnType, categoryId: nullIfEmpty(d.categoryId), supplierId: nullIfEmpty(d.supplierId), notes: nullIfEmpty(d.notes) });
    toast(t('saved'), 'ok'); close(); reload(); refreshBell();
  } });
}
