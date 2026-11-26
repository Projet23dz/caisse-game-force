import {
  api, ApiError, askReason, bizById, bizOptions, bizWith, can, clear, download, empty, errMsg, field, fmtDate, formData, get, h, icon, input,
  isAdmin, kindLabel, me, modal, money, moneyEl, nullIfEmpty, opLabel, opPill, opTypeById, opTypes, post, select, spinner, toast, today, typeLabel,
} from '../core.js';
import { getLang, t, tk } from '../i18n.js';
import { sendOrQueue } from '../offline.js';

export const SIMPLE = ['income', 'expense', 'purchase', 'deposit', 'withdrawal'] as const;
const PERM: Record<string, string> = { income: 'add_income', expense: 'add_expense', purchase: 'add_purchase', deposit: 'deposit_withdrawal', withdrawal: 'deposit_withdrawal' };
/** Valeur du champ « type » : un type de base, ou « ot:<id> » pour un type personnalisé. */
const OT = 'ot:';
export const baseOf = (v: string) => (v.startsWith(OT) ? (opTypeById(v.slice(OT.length))?.base_type ?? 'expense') : v);
const opTypeOf = (v: string) => (v.startsWith(OT) ? v.slice(OT.length) : null);
/** Paramètres de lecture des catégories pour un type (base ou personnalisé). */
export const catQuery = (v: string) => (opTypeOf(v) ? { opType: opTypeOf(v) } : { type: v });
const ALL_TYPES = ['income', 'expense', 'purchase', 'deposit', 'withdrawal', 'transfer_out', 'transfer_in', 'adjustment_in', 'adjustment_out', 'salary_advance', 'salary_payment'];

export async function accountsOf(bizId: string, opts: { onlyAllowed?: boolean; kinds?: string[] } = {}) {
  const rows = await get<any[]>(`/businesses/${bizId}/accounts`);
  const b = bizById(bizId);
  return rows.filter((a) => a.is_active && (!opts.kinds || opts.kinds.includes(a.kind))
    && (!opts.onlyAllowed || isAdmin() || !b?.allowed_accounts || b.allowed_accounts.includes(a.id)));
}
const accLabel = (a: any) => `${a.name} (${kindLabel(a.kind)})${a.shared ? ' · ' + t('shared_account') : ''}${a.balance != null ? ' — ' + money(a.balance) + ' ' + t('currency') : ''}`;

/** Remplit une liste de catégories : catégories principales, avec leurs sous-catégories regroupées. */
export function fillCategories(sel: HTMLSelectElement, list: any[], placeholder = true) {
  clear(sel);
  if (placeholder) sel.appendChild(h('option', { value: '' }, t('choose')));
  const active = list.filter((c) => c.is_active !== false);
  for (const m of active.filter((c) => !c.parent_id)) {
    const subs = active.filter((c) => c.parent_id === m.id);
    if (!subs.length) { sel.appendChild(h('option', { value: m.id }, m.name)); continue; }
    sel.appendChild(h('optgroup', { label: m.name }, h('option', { value: m.id }, `${m.name} — ${t('general')}`),
      subs.map((c) => h('option', { value: c.id }, c.name))));
  }
  // sous-catégories dont la principale est désactivée
  active.filter((c) => c.parent_id && !active.some((m) => m.id === c.parent_id)).forEach((c) => sel.appendChild(h('option', { value: c.id }, c.name)));
}
const localInput = (d = new Date()) => new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
export const toIso = (local: string) => (local ? new Date(local).toISOString() : undefined);

// ================================================================== nouvelle opération
export function openTransaction(id?: string, preset: { businessId?: string; type?: string; accountId?: string } = {}) {
  if (id) return openDetails(id);
  const bizList = me().businesses.filter((b) => SIMPLE.some((tp) => can(PERM[tp], b.id)));
  if (!bizList.length) { toast(errMsg(new Error('—')), 'err'); return; }
  const biz = select('businessId', bizOptions(bizList), preset.businessId ?? bizList[0].id);
  const type = select('type', []);
  const acc = select('accountId', []);
  const cat = select('categoryId', []);
  const sup = select('supplierId', []);
  const newSupName = input('newSupplierName', { placeholder: t('new_supplier_name') });
  const newSupPhone = input('newSupplierPhone', { placeholder: t('phone'), dir: 'ltr' });
  const newSupBox = h('div', { class: 'form full hidden' }, field(t('new_supplier_name'), newSupName), field(t('phone'), newSupPhone));
  const supField = field(t('supplier'), sup);
  const newCatName = input('newCategoryName', { placeholder: t('new_category_name'), maxlength: '80' });
  const newCatBox = h('div', { class: 'form full hidden' }, field(t('new_category_name'), newCatName, 'full'));
  const pm = select('paymentMethodId', []);
  const amount = input('amount', { inputmode: 'decimal', required: true, dir: 'ltr', placeholder: '0.00' });
  const date = input('date', { type: 'datetime-local', value: localInput(), max: localInput(new Date(Date.now() + 60000)) });
  const splitBox = h('div', { class: 'split-box full hidden' });
  const splitBtn = h('button', { type: 'button', class: 'btn sm full', style: 'justify-self:start' }, icon('transfer', 15), t('split_btn'));
  const catField = field(t('category'), cat);
  const form = h('div', { class: 'form' },
    field(t('business'), biz), field(t('type'), type), field(t('account'), acc), catField, newCatBox,
    field(`${t('amount')} (${t('currency')})`, amount), field(t('date'), date), splitBtn, splitBox, field(t('payment_method'), pm), supField, newSupBox,
    field(t('description'), input('description', { maxlength: '300' }), 'full'), field(t('reference'), input('reference', { maxlength: '100' })),
    field(t('notes'), h('textarea', { class: 'input', name: 'notes', maxlength: '1000' }), 'full'));

  const refreshTypes = () => {
    const allowed: string[] = SIMPLE.filter((tp) => can(PERM[tp], biz.value));
    clear(type); allowed.forEach((tp) => type.appendChild(h('option', { value: tp }, typeLabel(tp))));
    // types personnalisés (أنواع جديدة) : permission du type de base (entrée = revenu, sortie = dépense)
    const custom = opTypes().filter((o) => can(PERM[o.base_type], biz.value));
    if (custom.length) type.appendChild(h('optgroup', { label: t('custom_types') },
      custom.map((o) => h('option', { value: OT + o.id }, `${o.name} (${o.dir === 'in' ? '⬆' : '⬇'})`))));
    custom.forEach((o) => allowed.push(OT + o.id));
    type.value = preset.type && allowed.includes(preset.type) ? preset.type : allowed[0];
  };
  let accList: any[] = [];
  const refreshAccounts = async () => {
    const prev = acc.value;
    accList = await accountsOf(biz.value, { onlyAllowed: true });
    // comptes communs en premier : on choisit seulement l'activité, l'argent sort de la même caisse
    accList.sort((p, q) => Number(!!q.shared) - Number(!!p.shared));
    clear(acc); accList.forEach((a) => acc.appendChild(h('option', { value: a.id }, accLabel(a))));
    if (preset.accountId && accList.some((a) => a.id === preset.accountId)) acc.value = preset.accountId;
    else if (prev && accList.some((a) => a.id === prev)) acc.value = prev;
    syncSplit();
  };
  const refreshCats = async () => {
    const list = await get<any[]>(`/businesses/${biz.value}/categories`, catQuery(type.value));
    fillCategories(cat, list);
    if (can('manage_categories', biz.value)) cat.appendChild(h('option', { value: '__new' }, t('new_category')));
    newCatBox.classList.add('hidden');
    const withSup = baseOf(type.value) === 'purchase' || baseOf(type.value) === 'expense';
    supField.classList.toggle('hidden', !withSup || splitOn);
    if (!withSup) { sup.value = ''; newSupBox.classList.add('hidden'); }
    syncSplit();
  };

  // ---- ventilation entre activités (compte commun, dépense ou achat)
  let splitOn = false;
  const splitRows: { bizId: string; on: HTMLInputElement; cat: HTMLSelectElement; amt: HTMLInputElement }[] = [];
  const sumEl = h('div', { class: 'split-sum' });
  const parse = (v: string) => Number(String(v).replace(/\s/g, '').replace(',', '.')) || 0;
  const updateSum = () => {
    const total = parse(amount.value);
    const sum = splitRows.filter((r) => r.on.checked).reduce((x, r) => x + parse(r.amt.value), 0);
    const diff = Math.round((total - sum) * 100) / 100;
    sumEl.className = `split-sum ${diff === 0 && sum > 0 ? 'ok' : 'bad'}`;
    sumEl.textContent = `${t('split_sum')} : ${money(sum)} / ${money(total)} ${t('currency')}${diff ? ` — ${t('split_diff')} : ${money(diff)}` : ' ✓'}`;
  };
  const buildSplit = async () => {
    const a = accList.find((x) => x.id === acc.value);
    const ids: string[] = (a?.business_ids ?? []).filter((id: string) => can(PERM[baseOf(type.value)], id));
    clear(splitBox); splitRows.length = 0;
    if (ids.length < 2) { splitBox.append(h('div', { class: 'muted small' }, t('split_not_shared'))); return; }
    splitBox.append(h('span', { class: 'muted small' }, t('split_hint')));
    for (const id of ids) {
      const b = me().businesses.find((x) => x.id === id);
      const on = h('input', { type: 'checkbox', checked: true }) as HTMLInputElement;
      const c = select('splitCat', []) as HTMLSelectElement;
      fillCategories(c, await get<any[]>(`/businesses/${id}/categories`, catQuery(type.value)));
      if (id === biz.value && cat.value && cat.value !== '__new') c.value = cat.value;
      else { const name = cat.selectedOptions[0]?.textContent ?? ''; const same = Array.from(c.options).find((o) => o.textContent === name); if (same) c.value = same.value; }
      const amt = input('splitAmount', { inputmode: 'decimal', dir: 'ltr', placeholder: '0.00' }) as HTMLInputElement;
      amt.addEventListener('input', updateSum); on.addEventListener('change', updateSum);
      splitRows.push({ bizId: id, on, cat: c, amt });
      splitBox.append(h('div', { class: 'split-row' }, h('label', { class: 'check' }, on, h('b', null, b?.name ?? id)), field(t('category'), c), field(t('amount'), amt)));
    }
    splitBox.append(sumEl); updateSum();
  };
  const syncSplit = () => {
    const canSplit = (baseOf(type.value) === 'expense' || baseOf(type.value) === 'purchase');
    splitBtn.classList.toggle('hidden', !canSplit);
    if (!canSplit && splitOn) toggleSplit(false);
    else if (splitOn) void buildSplit();
  };
  const toggleSplit = (on: boolean) => {
    splitOn = on;
    splitBox.classList.toggle('hidden', !on);
    catField.classList.toggle('hidden', on);
    supField.classList.toggle('hidden', on || !(baseOf(type.value) === 'purchase' || baseOf(type.value) === 'expense'));
    splitBtn.replaceChildren(icon('transfer', 15), t(on ? 'split_off' : 'split_btn'));
    if (on) void buildSplit();
  };
  splitBtn.addEventListener('click', () => toggleSplit(!splitOn));
  amount.addEventListener('input', () => { if (splitOn) updateSum(); });
  acc.addEventListener('change', () => { if (splitOn) void buildSplit(); });
  const refreshSuppliers = async () => {
    const list = await get<any[]>(`/businesses/${biz.value}/suppliers`);
    clear(sup); sup.append(h('option', { value: '' }, '—'), ...list.map((s) => h('option', { value: s.id }, s.name)), h('option', { value: '__new' }, t('new_supplier')));
  };
  sup.addEventListener('change', () => newSupBox.classList.toggle('hidden', sup.value !== '__new'));
  cat.addEventListener('change', () => { newCatBox.classList.toggle('hidden', cat.value !== '__new'); if (cat.value === '__new') newCatName.focus(); });
  biz.addEventListener('change', async () => { refreshTypes(); await Promise.all([refreshAccounts(), refreshCats(), refreshSuppliers()]); });
  type.addEventListener('change', refreshCats);
  refreshTypes();
  void Promise.all([refreshAccounts(), refreshCats(), refreshSuppliers(), get<any[]>('/payment-methods').then((list) => {
    pm.append(h('option', { value: '' }, '—'), ...list.map((p) => h('option', { value: p.id }, getLang() === 'ar' ? p.name_ar : getLang() === 'fr' ? p.name_fr : p.name_en)));
  })]);

  modal({ title: t('new_op'), body: form, onSubmit: async (close) => {
    const f = formData(form);
    if (splitOn) {
      const parts = splitRows.filter((r) => r.on.checked);
      if (parts.length < 2) throw new Error(t('split_need_two'));
      const label = `${t('split_label')} · ${type.selectedOptions[0]?.textContent ?? ''} · ${acc.selectedOptions[0]?.textContent?.split(' — ')[0] ?? ''}`;
      const r = await sendOrQueue('/transactions/split', {
        accountId: f.accountId, type: baseOf(f.type), total: f.amount.replace(/\s/g, ''), date: toIso(f.date), paymentMethodId: nullIfEmpty(f.paymentMethodId),
        description: nullIfEmpty(f.description), reference: nullIfEmpty(f.reference), notes: nullIfEmpty(f.notes),
        parts: parts.map((p) => ({ businessId: p.bizId, categoryId: p.cat.value, amount: p.amt.value.replace(/\s/g, '') })),
      }, label, f.amount.replace(/\s/g, ''));
      if (!r) { close(); window.dispatchEvent(new Event('cp:changed')); return; }   // gardée sur l'appareil (hors connexion)
      toast(`${t('split_label')} : ${r.items.map((x: any) => `${x.business_name} ${money(x.amount)}`).join(' + ')} ${t('currency')}`, 'ok');
      close(); window.dispatchEvent(new Event('cp:changed'));
      return;
    }
    const body: Record<string, unknown> = {
      businessId: f.businessId, accountId: f.accountId, type: baseOf(f.type), amount: f.amount.replace(/\s/g, ''),
      categoryId: nullIfEmpty(f.categoryId), date: toIso(f.date), paymentMethodId: nullIfEmpty(f.paymentMethodId),
      description: nullIfEmpty(f.description), reference: nullIfEmpty(f.reference), notes: nullIfEmpty(f.notes),
    };
    if (f.categoryId === '__new') {
      // nouvelle catégorie créée à la volée (permission « gérer les catégories » vérifiée par la base)
      const c = await post(`/businesses/${f.businessId}/categories`, { txnType: baseOf(f.type), opTypeId: opTypeOf(f.type), name: f.newCategoryName });
      body.categoryId = c.id;
      void refreshCats().then(() => { cat.value = c.id; });
    }
    if (f.supplierId === '__new') body.newSupplier = { name: f.newSupplierName, phone: nullIfEmpty(f.newSupplierPhone) };
    else if (f.supplierId) body.supplierId = f.supplierId;
    let r: any;
    const label = `${type.selectedOptions[0]?.textContent ?? ''} · ${biz.selectedOptions[0]?.textContent ?? ''} · ${acc.selectedOptions[0]?.textContent?.split(' — ')[0] ?? ''}`;
    try { r = await sendOrQueue('/transactions', body, label, String(body.amount)); } catch (e) {
      // solde insuffisant : indiquer les comptes de cette activité qui ont assez d'argent
      if (e instanceof ApiError && e.code === 'CP028') {
        const need = Number(String(body.amount));
        const ok = accList.filter((a) => a.id !== body.accountId && a.balance != null && Number(a.balance) >= need);
        if (ok.length) throw new Error(`${errMsg(e)} — ${t('low_balance_try')} : ${ok.map((a) => `${a.name} (${money(a.balance)} ${t('currency')})`).join(' · ')}`);
      }
      throw e;
    }
    if (!r) { close(); window.dispatchEvent(new Event('cp:changed')); return; }   // gardée sur l'appareil (hors connexion)
    toast(`${opLabel(r)} #${r.ref_no} — ${money(r.amount)} ${t('currency')}`, 'ok');
    close(); window.dispatchEvent(new Event('cp:changed'));
  } });
}

// ================================================================== détails d'une opération
export async function openDetails(id: string) {
  const body = h('div', { class: 'col' }, spinner());
  const close = modal({ title: t('details'), body, wide: true });
  try {
    const x = await get(`/transactions/${id}`);
    clear(body);
    const simple = (SIMPLE as readonly string[]).includes(x.transaction_type) && !x.cheque_id;
    const editable = x.status === 'validated' && (can('edit_any', x.business_id) || (x.created_by === me().user.id && can('edit_own', x.business_id)));
    const info = (label: string, value: Node | string) => h('div', { class: 'col', style: 'gap:0' }, h('span', { class: 'muted small' }, label), h('b', null, value));
    body.append(
      h('div', { class: 'row' }, opPill(x),
        h('b', { style: 'font-size:26px' }, h('span', { class: `num c-${x.transaction_type}` }, money(x.signed_amount, true)), ' ', t('currency')),
        h('span', { class: 'spacer' }), h('span', { class: 'badge', style: `color:${x.status === 'cancelled' ? 'var(--exp)' : 'var(--inc)'}` }, tk(x.status))),
      x.status === 'cancelled' ? h('div', { class: 'err-box' }, `${t('cancelled_reason')} : ${x.cancel_reason}`) : '',
      x.split_id ? h('div', { class: 'info-box row' }, icon('transfer', 16), h('span', { style: 'flex:1' }, `${t('split_label')} — ${t('split_hint')}`)) : '',
      h('div', { class: 'grid g4' }, info(t('ref'), h('span', { class: 'num' }, '#' + x.ref_no)), info(t('date'), fmtDate(x.transaction_date, true)),
        info(t('business'), x.business_name), info(t('account'), x.account_shared ? `${x.account_name} · ${t('shared_account')}` : x.account_name),
        info(t('category'), x.category_parent_name ? `${x.category_parent_name} › ${x.category_name}` : (x.category_name ?? '—')),
        info(t('supplier'), x.supplier_name ?? x.employee_name ?? '—'), info(t('user'), x.created_by_name),
        x.running_balance != null ? info(t('balance'), moneyEl(x.running_balance)) : null),
      x.replaced_by_id ? h('div', { class: 'warn-box row' }, icon('pen', 16),
        h('span', { style: 'flex:1' }, `${t('old_version')} ${t('by_user')} ${x.cancelled_by_name ?? '—'} · ${fmtDate(x.cancelled_at, true)}`),
        h('button', { type: 'button', class: 'btn sm', onclick: () => { close(); openDetails(x.replaced_by_id); } }, `${t('replaced_by')} \u2066#${x.replaced_by_ref}\u2069`)) : '',
      x.corrects_id ? h('div', { class: 'info-box row' }, icon('refresh', 16), h('span', { style: 'flex:1' }, `${t('correction_of')} \u2066#${x.corrects_ref ?? ''}\u2069`),
        h('button', { type: 'button', class: 'btn sm', onclick: () => { close(); openDetails(x.corrects_id); } }, t('open_version'))) : '');

    // actions : modifier (tout) / annuler — rien n'est effacé
    // une part de ventilation ne se corrige pas seule (montants liés) : annuler puis ressaisir
    const canCorrect = simple && !x.split_id && can('cancel', x.business_id) && can(PERM[x.transaction_type], x.business_id);
    const actions = h('div', { class: 'row' });
    if (x.status === 'validated' && (editable || canCorrect)) {
      actions.append(h('button', { type: 'button', class: 'btn pri sm', onclick: () => editForm(x, simple, editable, canCorrect, close) }, icon('pen', 16), t('edit_op')));
    }
    if (x.status === 'validated' && !x.cheque_id && !x.reconciliation_id && can('cancel', x.business_id)) {
      actions.append(h('button', { type: 'button', class: 'btn danger sm', onclick: () => askReason(t('cancel_op'), async (reason) => {
        await post(`/transactions/${id}/cancel`, { reason }); toast(t('saved'), 'ok'); close(); window.dispatchEvent(new Event('cp:changed'));
      }) }, icon('x', 16), t('cancel_op')));
    }
    if (x.status === 'validated') body.append(h('div', { class: 'muted small' }, t('edit_hint')));
    body.append(actions);
    // pièces jointes
    const att = h('div', { class: 'col', style: 'gap:6px' }, x.attachments.length ? x.attachments.map((a: any) => h('div', { class: 'row' }, icon('clip', 16),
      h('a', { href: '#', onclick: (e: Event) => { e.preventDefault(); download(`/attachments/${a.id}`, a.file_name).catch((er) => toast(errMsg(er), 'err')); } }, a.file_name),
      h('span', { class: 'muted small' }, `${Math.ceil(a.size_bytes / 1024)} Ko · ${fmtDate(a.uploaded_at, true)}`))) : h('span', { class: 'muted small' }, t('none')));
    const fileIn = h('input', { type: 'file', accept: '.pdf,.png,.jpg,.jpeg,.webp', class: 'hidden' });
    fileIn.addEventListener('change', async () => {
      if (!fileIn.files?.[0]) return;
      const fd = new FormData(); fd.append('kind', fileIn.files[0].type === 'application/pdf' ? 'pdf' : 'receipt'); fd.append('file', fileIn.files[0]);
      try { await post(`/transactions/${id}/attachments`, fd); toast(t('saved'), 'ok'); close(); openDetails(id); } catch (e) { toast(errMsg(e), 'err'); }
    });
    body.append(h('div', { class: 'card col', style: 'padding:14px' }, h('div', { class: 'row' }, h('h3', { style: 'margin:0' }, t('attachments')), h('span', { class: 'spacer' }),
      h('button', { type: 'button', class: 'btn sm', onclick: () => fileIn.click() }, icon('clip', 16), t('upload')), fileIn), att));
    // historique : anciennes valeurs barrées → nouvelles, auteur, motif
    const names = await refNames(x.business_id, x.history);
    body.append(h('div', { class: 'card col', style: 'padding:14px' }, h('h3', { style: 'margin:0' }, t('history')), historyList(x.history, names)));
  } catch (e) { clear(body).append(h('div', { class: 'err-box' }, errMsg(e))); }
}

// Valeurs lisibles pour l'historique (identifiants → noms)
async function refNames(bizId: string, hist: any[]) {
  const m: Record<string, string> = {};
  const need = (k: string) => hist.some((e) => (e.changed ?? []).includes(k));
  try {
    if (need('category_id')) (await get<any[]>(`/businesses/${bizId}/categories`, { all: true })).forEach((c) => { m[c.id] = c.name; });
    if (need('supplier_id')) (await get<any[]>(`/businesses/${bizId}/suppliers`)).forEach((c) => { m[c.id] = c.name; });
    if (need('account_id')) (await get<any[]>(`/businesses/${bizId}/accounts`)).forEach((c) => { m[c.id] = c.name; });
  } catch { /* noms facultatifs */ }
  return m;
}
const HIDDEN_FIELDS = new Set(['updated_at', 'cancelled_by', 'cancelled_at', 'cancel_reason', 'local_date', 'signed_amount']);
function showVal(k: string, v: unknown, names: Record<string, string>): string {
  if (v === null || v === undefined || v === '') return '—';
  if (k === 'amount') return `${money(v)} ${t('currency')}`;
  if (k === 'transaction_date') return fmtDate(String(v), true);
  if (k === 'status') return tk(String(v));
  if (k.endsWith('_id')) return names[String(v)] ?? '…';
  return String(v);
}
function historyList(hist: any[], names: Record<string, string>) {
  if (!hist.length) return h('span', { class: 'muted small' }, t('none'));
  return h('div', { class: 'col', style: 'gap:0' }, hist.map((e: any) => {
    const fields = (e.changed ?? []).filter((c: string) => !HIDDEN_FIELDS.has(c));
    const label = e.action === 'create' ? t('a_create') : e.action === 'cancel' ? t('a_cancel') : e.action === 'update' ? t('a_update') : e.action;
    return h('div', { class: 'list-row', style: 'align-items:flex-start' },
      h('span', { class: 'num muted small', style: 'min-width:130px' }, fmtDate(e.occurred_at, true)),
      h('div', { class: 'col', style: 'gap:4px;flex:1' },
        h('div', { class: 'row', style: 'gap:6px' }, h('span', { class: `badge h-${e.action}` }, label), h('b', null, e.user_name ?? '—')),
        e.reason ? h('span', { class: 'small' }, `${t('reason')} : ${e.reason}`) : null,
        e.action === 'update' && fields.length ? h('div', { class: 'col', style: 'gap:2px' }, fields.map((c: string) => h('div', { class: 'small diff' },
          h('span', { class: 'muted' }, tk('f_' + c) + ' : '),
          h('s', { class: 'old' }, showVal(c, e.old_values?.[c], names)), ' → ', h('b', { class: 'new' }, showVal(c, e.new_values?.[c], names))))) : null));
  }));
}

// Modification d'une opération : tout est modifiable ; montant/date/compte → nouvelle version (l'ancienne reste, barrée)
async function editForm(x: any, simple: boolean, editable: boolean, canCorrect: boolean, closeParent: () => void) {
  const [cats, sups, accs] = await Promise.all([
    simple ? get<any[]>(`/businesses/${x.business_id}/categories`, x.op_type_id ? { opType: x.op_type_id } : { type: x.transaction_type }) : Promise.resolve([]),
    simple && ['purchase', 'expense'].includes(x.transaction_type) ? get<any[]>(`/businesses/${x.business_id}/suppliers`) : Promise.resolve(null),
    canCorrect ? accountsOf(x.business_id, { onlyAllowed: true }) : Promise.resolve([]),
  ]);
  const fin = canCorrect;
  const f = h('div', { class: 'form' },
    h('div', { class: 'full muted small' }, t('edit_hint')),
    fin ? field(`${t('amount')} (${t('currency')})`, input('amount', { value: x.amount, dir: 'ltr', inputmode: 'decimal' })) : null,
    fin ? field(t('date'), input('date', { type: 'datetime-local', value: localInput(new Date(x.transaction_date)) })) : null,
    fin && accs.length ? field(t('account'), select('accountId', accs.map((a) => ({ value: a.id, label: `${a.name} (${kindLabel(a.kind)})` })), x.account_id)) : null,
    cats.length ? field(t('category'), (() => { const c = select('categoryId', []) as HTMLSelectElement; fillCategories(c, cats, false); c.value = x.category_id ?? ''; return c; })()) : null,
    sups ? field(t('supplier'), select('supplierId', [{ value: '', label: '—' }, ...sups.map((c) => ({ value: c.id, label: c.name }))], x.supplier_id ?? '')) : null,
    field(t('description'), input('description', { value: x.description ?? '', maxlength: '300' }), 'full'),
    field(t('reference'), input('reference', { value: x.reference ?? '', maxlength: '100' })),
    field(t('notes'), h('textarea', { class: 'input', name: 'notes', maxlength: '1000' }, x.notes ?? ''), 'full'),
    field(t('reason_edit'), h('textarea', { class: 'input', name: 'reason', maxlength: '500' }), 'full'));
  modal({ title: `${t('edit_op')} \u2066#${x.ref_no}\u2069`, body: f, wide: true, onSubmit: async (close) => {
    const d = formData(f);
    const iso = fin ? toIso(d.date) : undefined;
    const amountChanged = fin && d.amount && Number(d.amount.replace(/\s/g, '').replace(',', '.')) !== Number(x.amount);
    const dateChanged = fin && iso && new Date(iso).getTime() !== new Date(x.transaction_date).setSeconds(0, 0);
    const accountChanged = fin && d.accountId && d.accountId !== x.account_id;
    const text: Record<string, string | null> = {};
    for (const k of ['description', 'reference', 'notes'] as const) if ((d[k] ?? '') !== (x[k] ?? '')) text[k] = d[k] || null;
    if (d.categoryId && d.categoryId !== (x.category_id ?? '')) text.categoryId = d.categoryId;
    if (sups && (d.supplierId ?? '') !== (x.supplier_id ?? '')) text.supplierId = d.supplierId || null;
    const financial = amountChanged || dateChanged || accountChanged;
    if (!financial && !Object.keys(text).length) throw new Error(t('no_change'));
    let target = x.id;
    if (financial || !editable) {
      if (!d.reason || d.reason.trim().length < 3) throw new Error(t('reason_edit_needed'));
      const body: Record<string, unknown> = { reason: d.reason.trim() };
      if (amountChanged) body.amount = d.amount.replace(/\s/g, '').replace(',', '.');
      if (dateChanged) body.date = iso;
      if (accountChanged) body.accountId = d.accountId;
      if (text.categoryId) body.categoryId = text.categoryId;
      if (text.supplierId) body.supplierId = text.supplierId;
      for (const k of ['description', 'reference', 'notes']) if (text[k]) body[k] = text[k];
      const n = await post(`/transactions/${x.id}/correct`, body);
      target = n.id;
      toast(`#${x.ref_no} → #${n.ref_no} ✓`, 'ok');
    } else {
      await api('PATCH', `/transactions/${x.id}`, { ...text, ...(d.reason ? { reason: d.reason.trim() } : {}) });
      toast(t('saved'), 'ok');
    }
    close(); closeParent(); window.dispatchEvent(new Event('cp:changed'));
    openDetails(target);
  } });
}

// ================================================================== liste des opérations
export async function transactionsPage(root: HTMLElement, _p: string[], query: URLSearchParams, fixedBiz?: string) {
  const st = { businessId: fixedBiz ?? query.get('businessId') ?? '', accountId: '', type: '', from: query.get('from') ?? '', to: query.get('to') ?? '', q: query.get('q') ?? '', status: 'all', page: 1 };
  const biz = select('businessId', bizOptions(undefined, true), st.businessId);
  const acc = select('accountId', [{ value: '', label: t('all_accounts') }]);
  const from = input('from', { type: 'date', value: st.from }); const to = input('to', { type: 'date', value: st.to });
  const q = input('q', { type: 'search', value: st.q, placeholder: `${t('description')}, ${t('reference')}, ${t('supplier')}…` });
  const chips = h('div', { class: 'row', role: 'group' });
  const tableBox = h('div', { class: 'col' });
  const loadAccounts = async () => {
    clear(acc).appendChild(h('option', { value: '' }, t('all_accounts')));
    if (biz.value) (await accountsOf(biz.value)).forEach((a) => acc.appendChild(h('option', { value: a.id }, `${a.name} (${kindLabel(a.kind)})`)));
  };
  const drawChips = () => {
    clear(chips);
    for (const tp of ['', ...ALL_TYPES, ...opTypes(false).map((o) => OT + o.id)]) chips.appendChild(h('button', { class: `chip ${st.type === tp ? 'on' : ''}`, 'aria-pressed': String(st.type === tp),
      onclick: () => { st.type = tp; st.page = 1; drawChips(); load(); } }, !tp ? t('all') : tp.startsWith(OT) ? (opTypeById(tp.slice(OT.length))?.name ?? '?') : typeLabel(tp)));
  };
  const load = async (quiet = false) => {
    if (!quiet) clear(tableBox).appendChild(spinner());
    // type de base : sans les types personnalisés ; type personnalisé : filtre opTypeId
    const typeF = st.type.startsWith(OT) ? { opTypeId: st.type.slice(OT.length) } : st.type ? { type: st.type, opTypeId: 'none' } : {};
    const filters = { businessId: biz.value, accountId: acc.value, ...typeF, from: from.value, to: to.value, q: q.value, status: st.status };
    try {
      const r = await get('/transactions', { ...filters, page: st.page, limit: 25 });
      clear(tableBox);
      tableBox.append(h('div', { class: 'row small' }, h('span', { class: 'muted' }, `${r.total} ·`), h('span', null, t('total_in'), ' ', moneyEl(r.totalIn, { cls: 'up' })),
        h('span', null, t('total_out'), ' ', moneyEl(r.totalOut, { cls: 'down' })), h('span', { class: 'spacer' }),
        can('export') ? ['xlsx', 'pdf', 'csv'].map((fmt) => h('button', { class: 'btn sm', onclick: () => download(`/export/transactions?${new URLSearchParams({ ...Object.fromEntries(Object.entries(filters).filter(([, v]) => v)), format: fmt, lang: getLang() })}`, `cashpro.${fmt}`).catch((e) => toast(errMsg(e), 'err')) }, icon('download', 15), fmt.toUpperCase())) : null));
      tableBox.append(r.items.length ? txTable(r.items) : empty());
      const pages = Math.max(1, Math.ceil(r.total / 25));
      tableBox.append(h('div', { class: 'pager' }, h('span', { class: 'muted small' }, `${st.page} / ${pages}`),
        h('button', { class: 'btn sm', disabled: st.page <= 1, onclick: () => { st.page--; load(); } }, t('prev')),
        h('button', { class: 'btn sm', disabled: st.page >= pages, onclick: () => { st.page++; load(); } }, t('next'))));
    } catch (e) { clear(tableBox).append(h('div', { class: 'err-box' }, errMsg(e))); }
  };
  biz.addEventListener('change', async () => { st.page = 1; await loadAccounts(); load(); });
  [acc, from, to].forEach((el) => el.addEventListener('change', () => { st.page = 1; load(); }));
  let tm = 0; q.addEventListener('input', () => { clearTimeout(tm); tm = window.setTimeout(() => { st.page = 1; load(); }, 350); });
  const onChange = () => { if (tableBox.isConnected) load(true); else window.removeEventListener('cp:changed', onChange); };
  window.addEventListener('cp:changed', onChange);
  if (!fixedBiz) root.append(h('div', { class: 'page-head' }, h('div', null, h('h1', null, t('nav_transactions')), h('p', null, t('tx_sub'))),
    h('div', { class: 'actions' }, h('button', { class: 'btn pri', onclick: () => openTransaction() }, icon('plus'), t('new_op')))));
  root.append(h('div', { class: 'card col' }, h('div', { class: 'form', style: 'grid-template-columns:repeat(auto-fit,minmax(170px,1fr))' },
    fixedBiz ? null : field(t('business'), biz), field(t('account'), acc), field(t('from'), from), field(t('to'), to), field(t('search'), q)), chips), tableBox);
  drawChips(); await loadAccounts(); await load();
}

// L'ancienne version d'une opération modifiée s'affiche juste sous la nouvelle
function groupVersions(items: any[]) {
  const byId = new Map(items.map((r) => [r.id, r]));
  const placed = new Set<string>();
  const out: { r: any; nested: boolean }[] = [];
  for (const r of items) {
    if (placed.has(r.id)) continue;
    if (r.replaced_by_id && byId.has(r.replaced_by_id)) continue; // placée sous sa nouvelle version
    out.push({ r, nested: false }); placed.add(r.id);
    let cur = r;
    while (cur.corrects_id && byId.has(cur.corrects_id) && !placed.has(cur.corrects_id)) {
      cur = byId.get(cur.corrects_id); out.push({ r: cur, nested: true }); placed.add(cur.id);
    }
  }
  for (const r of items) if (!placed.has(r.id)) out.push({ r, nested: false });
  return out;
}
function statusCell(r: any) {
  const iso = (v: string) => `\u2068${v}\u2069`; // isolation bidi (noms latins, numéros, dates dans l'arabe)
  const who = (name: string | null, at: string | null) => h('span', { class: 'muted small' }, `${t('by_user')} ${iso(name ?? '—')}${at ? ' · ' + iso(fmtDate(at, true)) : ''}`);
  if (r.status === 'cancelled' && r.replaced_by_id) {
    return h('div', { class: 'col', style: 'gap:0' }, h('span', { class: 'badge st-modified' }, icon('pen', 12), ' ', t('st_modified'), ` → ${iso('#' + r.replaced_by_ref)}`), who(r.cancelled_by_name, r.cancelled_at));
  }
  if (r.status === 'cancelled') {
    return h('div', { class: 'col', style: 'gap:0' }, h('span', { class: 'badge st-cancelled' }, icon('x', 12), ' ', t('op_cancelled')), who(r.cancelled_by_name, r.cancelled_at));
  }
  const tags = h('div', { class: 'col', style: 'gap:0' }, h('span', { class: 'small', style: 'color:var(--inc)' }, tk(r.status)));
  if (r.corrects_id) tags.append(h('span', { class: 'muted small' }, `↺ ${t('correction_of')} ${iso('#' + (r.corrects_ref ?? ''))}`));
  if (r.edit_count > 0) tags.append(h('span', { class: 'badge st-edited' }, icon('pen', 12), ' ', t('st_edited')), who(r.edited_by_name, r.edited_at));
  return tags;
}

export function txTable(items: any[]) {
  return h('div', { class: 'table-wrap' }, h('table', { class: 't' },
    h('thead', null, h('tr', null, [t('ref'), t('date'), t('business'), t('type'), t('party'), t('account'), t('amount'), t('user'), t('status'), ''].map((c) => h('th', null, c)))),
    h('tbody', null, groupVersions(items).map(({ r, nested }) => h('tr', { class: `click ${r.status === 'cancelled' ? 'cancelled' : ''} ${nested ? 'nested' : ''}`, onclick: () => openTransaction(r.id), tabindex: '0',
      onkeydown: (e: KeyboardEvent) => { if (e.key === 'Enter') openTransaction(r.id); } },
      h('td', { class: 'num muted' }, nested ? '↳ ' : '', '#' + r.ref_no), h('td', { class: 'num' }, fmtDate(r.transaction_date, true)), h('td', null, r.business_name),
      h('td', null, opPill(r)),
      h('td', { style: 'white-space:normal;min-width:180px' }, h('div', { class: 'col', style: 'gap:0' }, h('span', null, r.category_name ?? r.description ?? '—'),
        h('span', { class: 'muted small' }, r.supplier_name ?? r.employee_name ?? r.description ?? ''))),
      h('td', null, r.account_name),
      h('td', { class: `amt c-${r.transaction_type}`, style: 'font-weight:700' }, h('span', { class: 'num' }, money(r.signed_amount, true))),
      h('td', null, r.created_by_name),
      h('td', { style: 'white-space:normal;min-width:150px' }, statusCell(r)),
      h('td', null, r.attachments_count > 0 ? icon('clip', 15) : null))))));
}

// ================================================================== transferts
export async function transfersPage(root: HTMLElement) {
  const list = h('div', { class: 'col' });
  const load = async () => {
    clear(list).append(spinner());
    const rows = await get<any[]>('/transfers', { limit: 100 });
    clear(list).append(rows.length ? h('div', { class: 'table-wrap' }, h('table', { class: 't' },
      h('thead', null, h('tr', null, [t('ref'), t('date'), t('from_account'), t('to_account'), t('amount'), t('reference'), t('status'), ''].map((c) => h('th', null, c)))),
      h('tbody', null, rows.map((r) => h('tr', { class: r.status === 'cancelled' ? 'cancelled' : '' },
        h('td', { class: 'num muted' }, '#' + r.ref_no), h('td', { class: 'num' }, fmtDate(r.transfer_date, true)),
        h('td', null, `${r.from_business_name} · ${r.from_account_name}`), h('td', null, `${r.to_business_name} · ${r.to_account_name}`),
        h('td', { class: 'amt c-transfer_out', style: 'font-weight:700' }, h('span', { class: 'num' }, money(r.amount))),
        h('td', null, r.reference ?? (r.kind === 'internal' ? t('internal') : t('inter_business'))),
        h('td', null, tk(r.status)),
        h('td', null, r.status === 'validated' && can('cancel', r.from_business_id) ? h('button', { class: 'btn danger sm', onclick: () => askReason(t('cancel'), async (reason) => {
          await post(`/transfers/${r.id}/cancel`, { reason }); toast(t('saved'), 'ok'); load();
        }) }, t('cancel')) : null)))))) : empty());
  };
  root.append(h('div', { class: 'page-head' }, h('div', null, h('h1', null, t('nav_transfers')), h('p', null, t('tr_sub'))),
    h('div', { class: 'actions' }, h('button', { class: 'btn pri', onclick: () => openTransfer(load) }, icon('transfer'), t('new_transfer')))), list);
  await load();
}

export async function openTransfer(after?: () => void, preset: { businessId?: string } = {}) {
  const bizs = bizWith('transfer');
  const all: any[] = [];
  for (const b of bizs) (await accountsOf(b.id, { onlyAllowed: true })).forEach((a) => all.push({ ...a, bizName: b.name }));
  const opts = all.map((a) => ({ value: a.id, label: `${a.bizName} · ${accLabel(a)}` }));
  const firstOfBiz = all.find((a) => a.business_id === preset.businessId)?.id;
  const f = h('div', { class: 'form' },
    field(t('from_account'), select('fromAccountId', opts, firstOfBiz)), field(t('to_account'), select('toAccountId', opts, all.find((a) => a.id !== (firstOfBiz ?? all[0]?.id))?.id)),
    field(`${t('amount')} (${t('currency')})`, input('amount', { dir: 'ltr', inputmode: 'decimal', required: true })),
    field(t('date'), input('date', { type: 'datetime-local', value: localInput() })),
    field(t('reference'), input('reference')), field(t('description'), input('description')));
  modal({ title: t('new_transfer'), body: f, onSubmit: async (close) => {
    const d = formData(f);
    const sel = (n: string) => (f.querySelector(`select[name=${n}]`) as HTMLSelectElement | null)?.selectedOptions[0]?.textContent?.split(' — ')[0] ?? '';
    const r = await sendOrQueue('/transfers', { fromAccountId: d.fromAccountId, toAccountId: d.toAccountId, amount: d.amount.replace(/\s/g, ''), date: toIso(d.date), reference: nullIfEmpty(d.reference), description: nullIfEmpty(d.description) },
      `${t('new_transfer')} : ${sel('fromAccountId')} → ${sel('toAccountId')}`, d.amount.replace(/\s/g, ''));
    if (r) toast(t('saved'), 'ok');
    close(); after?.(); window.dispatchEvent(new Event('cp:changed'));
  } });
}
export const todayStr = today;
