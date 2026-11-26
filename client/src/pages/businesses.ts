import {
  api, barChart, bizById, can, clear, dropImgCache, empty, errMsg, field, fmtDate, formData, get, h, icon, input, isAdmin, kindLabel,
  me, modal, moneyEl, nullIfEmpty, opTypeById, opTypes, post, select, spinner, toast, today, typeLabel,
} from '../core.js';
import { openOpTypeForm } from './optypes.js';
import { t } from '../i18n.js';
import { loadMe, resetShell } from '../main.js';
import { bizLogo } from './dashboard.js';
import { openTransaction, openTransfer, SIMPLE, transactionsPage } from './transactions.js';

export async function businessesPage(root: HTMLElement) {
  const d = await get('/dashboard');
  root.append(h('div', { class: 'page-head' }, h('div', null, h('h1', null, t('nav_businesses'))),
    isAdmin() ? h('div', { class: 'actions' }, h('button', { class: 'btn pri', onclick: () => openBusinessForm() }, icon('plus'), t('add_business'))) : null),
  h('div', { class: 'grid g3' }, d.businesses.map((b: any, i: number) => h('a', { href: `#/business/${b.id}`, class: `card biz ${i === 0 ? 'hero' : ''}` },
    h('div', { class: 'row' }, bizLogo(b), h('b', { style: 'font-size:18px' }, b.name), h('span', { class: 'spacer' }), h('span', { class: 'badge' }, b.code)),
    h('div', { class: 'col', style: 'gap:0' }, h('span', { class: 'muted small' }, t('balance')), b.balance === null ? h('b', null, t('hidden_balance')) : h('b', { style: 'font-size:22px' }, moneyEl(b.balance)))))));
}

export function openBusinessForm(b?: any) {
  const f = h('div', { class: 'form' },
    field(t('code'), input('code', { value: b?.code ?? '', required: true, maxlength: '10', dir: 'ltr' })),
    field(t('name'), input('name', { value: b?.name ?? '', required: true })),
    field(t('activity'), input('activity', { value: b?.activity ?? '' }), 'full'),
    field(t('phone'), input('phone', { value: b?.phone ?? '', dir: 'ltr' })), field('Email', input('email', { value: b?.email ?? '', dir: 'ltr' })),
    field('NIF', input('nif', { value: b?.nif ?? '', dir: 'ltr' })), field('RC', input('rc', { value: b?.rc ?? '', dir: 'ltr' })),
    field(t('address'), input('address', { value: b?.address ?? '' }), 'full'),
    field(t('color'), input('color', { type: 'color', value: b?.color ?? '#E30613' })));
  // nouvelle activité : choisir les comptes communs existants (caisse / banque / CCP) qu'elle utilise aussi
  const sharedBoxes: { id: string; cb: HTMLInputElement }[] = [];
  if (!b && me().businesses.length) {
    const box = h('div', { class: 'col full', style: 'gap:6px' }, h('b', null, t('new_biz_shared')), h('span', { class: 'muted small' }, t('new_biz_shared_hint')), spinner());
    f.append(box);
    void (async () => {
      const seen = new Map<string, any>();
      for (const x of me().businesses) {
        try { for (const a of await get<any[]>(`/businesses/${x.id}/accounts`)) if (a.is_active && a.kind !== 'other' && !seen.has(a.id)) seen.set(a.id, a); } catch { /* activité non visible */ }
      }
      box.lastChild?.remove();
      const list = [...seen.values()].sort((p, q) => Number(q.shared) - Number(p.shared) || p.kind.localeCompare(q.kind));
      if (!list.length) { box.append(empty()); return; }
      box.append(h('div', { class: 'col', style: 'gap:4px' }, list.map((a) => {
        // proposé coché : les comptes déjà communs (ex. « Caisse commune »)
        const cb = h('input', { type: 'checkbox', checked: !!a.shared }) as HTMLInputElement;
        sharedBoxes.push({ id: a.id, cb });
        return h('label', { class: 'check' }, cb, `${a.name} (${kindLabel(a.kind)})`,
          h('span', { class: 'muted small' }, ` — ${(a.business_names ?? []).join(' + ')}`));
      })));
    })();
  }
  modal({ title: b ? t('edit') : t('add_business'), body: f, onSubmit: async (close) => {
    const d = formData(f);
    const body: Record<string, unknown> = { code: d.code, name: d.name, activity: nullIfEmpty(d.activity), phone: nullIfEmpty(d.phone), email: nullIfEmpty(d.email),
      nif: nullIfEmpty(d.nif), rc: nullIfEmpty(d.rc), address: nullIfEmpty(d.address), color: d.color.toUpperCase() };
    if (!b) body.sharedAccountIds = sharedBoxes.filter((x) => x.cb.checked).map((x) => x.id);
    const r = b ? await api('PATCH', `/businesses/${b.id}`, body) : await post('/businesses', body);
    await loadMe(); resetShell(); toast(t('saved'), 'ok'); close();
    location.hash = `#/business/${r.id}/settings`; window.dispatchEvent(new HashChangeEvent('hashchange'));
  } });
}

export async function businessPage(root: HTMLElement, params: string[], query: URLSearchParams) {
  const id = params[0];
  const tab = params[1] ?? 'overview';
  const b = bizById(id);
  if (!b) { root.append(empty()); return; }
  const canSettings = isAdmin() || can('manage_categories', id) || can('manage_suppliers', id);
  const tabs: [string, string, boolean][] = [['overview', t('overview'), true], ['transactions', t('nav_transactions'), true], ['settings', t('settings'), canSettings]];
  root.append(
    h('div', { class: 'page-head' }, h('a', { href: '#/businesses', class: 'btn icon-btn', 'aria-label': t('nav_businesses') }, icon('back')),
      h('div', { class: 'biz', style: 'flex-direction:row;align-items:center;gap:12px' }, bizLogo(b),
        h('div', null, h('h1', null, b.name), h('p', null, b.activity ?? ''))),
      h('div', { class: 'actions' }, h('button', { class: 'btn pri', onclick: () => openTransaction(undefined, { businessId: id }) }, icon('plus'), t('new_op')))),
    h('div', { class: 'tabs', role: 'tablist' }, tabs.filter((x) => x[2]).map(([k, label]) =>
      h('a', { href: `#/business/${id}/${k}`, role: 'tab', class: `tab ${tab === k ? 'on' : ''}`, 'aria-selected': String(tab === k), style: 'display:inline-flex;align-items:center;text-decoration:none' }, label))));
  const box = h('div', { class: 'col', style: 'gap:20px' });
  root.append(box);
  if (tab === 'transactions') return transactionsPage(box, [], query, id);
  if (tab === 'settings' && canSettings) return settingsTab(box, id);
  return overviewTab(box, id);
}

async function overviewTab(root: HTMLElement, id: string) {
  const accounts = await get<any[]>(`/businesses/${id}/accounts`);
  const cash = accounts.find((a) => a.kind === 'cash' && a.is_active) ?? accounts.find((a) => a.kind === 'cash');
  const quick: [string, string, () => void, boolean][] = [
    ...SIMPLE.slice(0, 3).map((tp) => [typeLabel(tp), tp === 'income' ? 'up' : tp === 'expense' ? 'down' : 'cart', () => openTransaction(undefined, { businessId: id, type: tp }),
      can(tp === 'income' ? 'add_income' : tp === 'expense' ? 'add_expense' : 'add_purchase', id)] as [string, string, () => void, boolean]),
    [t('nav_transfers'), 'transfer', () => openTransfer(undefined, { businessId: id }), can('transfer', id)],
    [t('nav_cheques'), 'cheque', () => { location.hash = '#/cheques'; }, can('cheques', id)],
    [t('t_salary_advance'), 'payroll', () => { location.hash = '#/payroll'; }, can('payroll', id)],
    [t('nav_treasury'), 'wallet', () => { location.hash = '#/treasury'; }, can('cash_session', id)],
  ];
  root.append(h('section', { class: 'grid g2' },
    h('div', { class: 'card hero-card span2 row', style: 'gap:24px;align-items:center;min-width:0' },
      h('div', { class: 'col', style: 'gap:4px' }, h('span', { class: 'muted' }, `${t('balance')} — ${cash?.name ?? ''}`),
        h('span', { class: 'big' }, cash?.balance != null ? moneyEl(cash.balance) : t('hidden_balance')),
        cash?.shared ? h('span', { class: 'shared-tag' }, icon('transfer', 13), `${t('shared_with')} ${(cash.business_names ?? []).join(' + ')}`) : ''),
      h('span', { class: 'spacer' }),
      h('div', { class: 'row', style: 'flex-wrap:wrap' }, accounts.filter((a) => a !== cash && a.is_active).map((a) => h('div', { style: 'padding:12px 16px;border-radius:14px;background:rgba(255,255,255,.08)' },
        h('div', { class: 'muted small' }, a.name, a.shared ? ` · ${t('shared_account')}` : ''), h('b', { style: 'font-size:18px' }, a.balance != null ? moneyEl(a.balance) : t('hidden_balance')))))),
    h('div', { class: 'card col' }, h('h2', { style: 'margin:0' }, t('quick_actions')),
      h('div', { class: 'grid', style: 'grid-template-columns:repeat(3,minmax(0,1fr));gap:8px' }, quick.filter((q) => q[3]).map(([label, ic, fn]) =>
        h('button', { class: 'btn', style: 'flex-direction:column;min-height:72px;gap:4px', onclick: fn }, icon(ic), h('span', { class: 'small' }, label)))))));
  if (can('view_reports', id)) {
    const r = await get('/reports/daily', { businessId: id });
    const m = (label: string, v: string, color: string) => h('div', { class: 'card kpi', style: `border-top-color:${color}` },
      h('div', { class: 'col', style: 'gap:2px' }, h('span', { class: 'l' }, label), h('span', { class: 'v' }, moneyEl(v))));
    root.append(h('section', { class: 'grid g4' }, m(t('today_income'), r.income, 'var(--inc)'), m(t('today_purchases'), r.purchases, 'var(--pur)'),
      m(t('today_expenses'), r.expenses, 'var(--exp)'), m(t('salaries'), r.salaries, 'var(--warn)')));
  }
  if (can('view_balances', id)) {
    const series = await get<any[]>('/reports/balance-series', { businessId: id, from: today(-29), to: today() });
    // avec un compte commun, la courbe de l'activité = son résultat cumulé (l'argent est dans la caisse commune)
    const anyShared = accounts.some((a) => a.shared);
    root.append(h('div', { class: 'card' }, h('h2', null, anyShared ? t('activity_net') : t('balance_evolution')), barChart(series.map((s) => fmtDate(s.day).slice(0, 5)), series.map((s) => Number(s.balance)))));
  }
}

async function settingsTab(root: HTMLElement, id: string) {
  const rerun = () => { clear(root); settingsTab(root, id).catch((e) => root.append(h('div', { class: 'err-box' }, errMsg(e)))); };
  if (isAdmin()) {
    const full = await get(`/businesses/${id}`);
    // ---- logo
    const fileIn = h('input', { type: 'file', accept: '.png,.jpg,.jpeg,.svg,.webp', class: 'hidden' });
    fileIn.addEventListener('change', async () => {
      if (!fileIn.files?.[0]) return;
      const fd = new FormData(); fd.append('file', fileIn.files[0]);
      try { await post(`/businesses/${id}/logo`, fd); dropImgCache(); await loadMe(); resetShell(); toast(t('saved'), 'ok'); rerun(); } catch (e) { toast(errMsg(e), 'err'); }
    });
    const history = await get<string[]>(`/businesses/${id}/logo/history`).catch(() => [] as string[]);
    root.append(h('section', { class: 'grid g2' },
      h('div', { class: 'card col' }, h('h2', { style: 'margin:0' }, t('biz_logo')),
        h('div', { class: 'row', style: 'gap:18px' }, h('div', { class: 'biz', style: 'transform:scale(1.8);margin:18px' }, bizLogo({ ...full, logo_path: full.logo_path })),
          h('div', { class: 'col' }, h('button', { class: 'btn pri', onclick: () => fileIn.click() }, icon('download'), t('upload')), h('span', { class: 'muted small' }, t('logo_hint')), fileIn)),
        history.length > 1 ? h('div', { class: 'col', style: 'gap:6px' }, h('b', null, t('previous_logos')),
          history.filter((k) => k !== full.logo_path).slice(0, 5).map((k) => h('div', { class: 'row' }, h('span', { class: 'muted small num' }, k.split('/').pop()!.slice(37, 50)),
            h('button', { class: 'btn sm', onclick: async () => { try { await post(`/businesses/${id}/logo/restore`, { key: k }); dropImgCache(); await loadMe(); resetShell(); toast(t('saved'), 'ok'); rerun(); } catch (e) { toast(errMsg(e), 'err'); } } }, t('restore'))))) : null),
      h('div', { class: 'card col' }, h('div', { class: 'row' }, h('h2', { style: 'margin:0' }, t('details')), h('span', { class: 'spacer' }),
        h('button', { class: 'btn sm', onclick: () => openBusinessForm(full) }, icon('pen', 15), t('edit'))),
        ...[[t('code'), full.code], [t('activity'), full.activity], [t('phone'), full.phone], ['NIF', full.nif], ['RC', full.rc], [t('address'), full.address]]
          .map(([k, v]) => h('div', { class: 'row' }, h('span', { class: 'muted', style: 'min-width:110px' }, k), h('span', null, v ?? '—'))))));
    // ---- comptes
    const accounts = await get<any[]>(`/businesses/${id}/accounts`);
    root.append(h('div', { class: 'card col' }, h('div', { class: 'row' }, h('h2', { style: 'margin:0' }, t('accounts')), h('span', { class: 'spacer' }),
      h('button', { class: 'btn sm', onclick: () => accountForm(id, null, rerun) }, icon('plus', 15), t('add_account'))),
      h('div', { class: 'table-wrap' }, h('table', { class: 't', style: 'min-width:600px' },
        h('thead', null, h('tr', null, [t('name'), t('type'), t('activities'), t('opening_balance'), t('opening_date'), t('balance'), t('status'), ''].map((c) => h('th', null, c)))),
        h('tbody', null, accounts.map((a) => h('tr', null, h('td', null, a.name, a.bank_name ? h('span', { class: 'muted small' }, ` · ${a.bank_name}`) : null), h('td', null, kindLabel(a.kind)),
          h('td', null, a.shared ? h('span', { class: 'shared-tag', title: (a.business_names ?? []).join(' + ') }, icon('transfer', 13), (a.business_names ?? []).join(' + ')) : h('span', { class: 'muted small' }, '—')),
          h('td', null, moneyEl(a.opening_balance)), h('td', { class: 'num' }, fmtDate(a.opening_date)), h('td', null, moneyEl(a.balance)),
          h('td', null, a.is_active ? t('active') : t('inactive')),
          h('td', null, h('button', { class: 'btn sm', onclick: () => accountForm(id, a, rerun) }, icon('pen', 15))))))))));
  }
  // ---- catégories
  root.append(await categoriesCard(id, rerun));
  // ---- fournisseurs
  const sups = await get<any[]>(`/businesses/${id}/suppliers`);
  root.append(h('div', { class: 'card col' }, h('div', { class: 'row' }, h('h2', { style: 'margin:0' }, t('suppliers')), h('span', { class: 'spacer' }),
    can('manage_suppliers', id) ? h('button', { class: 'btn sm', onclick: () => supplierForm(id, null, rerun) }, icon('plus', 15), t('add')) : null),
    sups.length ? h('div', { class: 'table-wrap' }, h('table', { class: 't', style: 'min-width:500px' }, h('thead', null, h('tr', null, [t('name'), t('phone'), t('address'), ''].map((c) => h('th', null, c)))),
      h('tbody', null, sups.map((s) => h('tr', null, h('td', null, s.name), h('td', { class: 'num' }, s.phone ?? '—'), h('td', null, s.address ?? '—'),
        h('td', null, can('manage_suppliers', id) ? h('button', { class: 'btn sm', onclick: () => supplierForm(id, s, rerun) }, icon('pen', 15)) : null)))))) : empty()));
}

function accountForm(bizId: string, a: any | null, done: () => void) {
  const f = h('div', { class: 'form' },
    field(t('name'), input('name', { value: a?.name ?? '', required: true })),
    field(t('type'), select('kind', ['cash', 'bank', 'ccp', 'other'].map((k) => ({ value: k, label: kindLabel(k) })), a?.kind ?? 'bank', a ? { disabled: true } : {})),
    field(t('bank'), input('bankName', { value: a?.bank_name ?? '' })), field('N°', input('accountNumber', { value: a?.account_number ?? '', dir: 'ltr' })),
    field(`${t('opening_balance')} (${t('currency')})`, input('openingBalance', { value: a?.opening_balance ?? '0', dir: 'ltr', inputmode: 'decimal' })),
    field(t('opening_date'), input('openingDate', { type: 'date', value: a?.opening_date ?? today() })),
    a ? h('label', { class: 'check full' }, h('input', { type: 'checkbox', name: 'isActive', checked: a.is_active }), t('active')) : null);
  // compte commun : activités qui utilisent ce compte (l'activité propriétaire est toujours cochée)
  const owner = a?.business_id ?? bizId;
  const current: string[] = a?.business_ids ?? [bizId];
  const bizBoxes = me().businesses.map((b) => ({ id: b.id, cb: h('input', { type: 'checkbox', checked: current.includes(b.id) || b.id === owner, disabled: b.id === owner }) as HTMLInputElement, b }));
  // case « compte commun » : cochée → on choisit les activités (2, 3 ou plus) ; décochée → compte d'une seule activité
  const sharedCb = h('input', { type: 'checkbox', checked: current.length > 1 }) as HTMLInputElement;
  const bizList = h('div', { class: 'col', style: 'gap:6px' }, h('span', { class: 'muted small' }, t('shared_pick')),
    h('div', { class: 'row', style: 'flex-wrap:wrap;gap:14px' }, bizBoxes.map(({ cb, b }) =>
      h('label', { class: 'check' }, cb, b.name, b.id === owner ? h('span', { class: 'muted small' }, ` (${t('owner')})`) : ''))));
  const syncShared = () => {
    bizList.classList.toggle('hidden', !sharedCb.checked);
    // compte commun nouvellement coché : toutes les activités cochées par défaut (on décoche celles qui n'en ont pas besoin)
    if (sharedCb.checked && bizBoxes.every((x) => x.b.id === owner || !x.cb.checked)) bizBoxes.forEach((x) => { x.cb.checked = true; });
  };
  sharedCb.addEventListener('change', syncShared);
  if (me().businesses.length > 1) {
    f.append(h('div', { class: 'col full', style: 'gap:8px' },
      h('label', { class: 'check', style: 'font-weight:600' }, sharedCb, t('shared_check')),
      h('span', { class: 'muted small' }, t('used_by_hint')), bizList));
    syncShared();
  }
  modal({ title: a ? `${t('edit')} — ${a.name}` : t('add_account'), body: f, onSubmit: async (close) => {
    const d = formData(f);
    const body: Record<string, unknown> = { name: d.name, bankName: nullIfEmpty(d.bankName), accountNumber: nullIfEmpty(d.accountNumber) };
    const ids = sharedCb.checked ? bizBoxes.filter((x) => x.cb.checked || x.id === owner).map((x) => x.id) : [owner];
    if (sharedCb.checked && ids.length < 2) throw new Error(t('shared_need_two'));
    if (me().businesses.length > 1 && (!a || ids.slice().sort().join() !== current.slice().sort().join())) body.businessIds = ids;
    if (!a || Number(d.openingBalance) !== Number(a.opening_balance)) body.openingBalance = d.openingBalance;
    if (!a || d.openingDate !== a.opening_date) body.openingDate = d.openingDate;
    if (a) body.isActive = d.isActive === '1'; else body.kind = d.kind;
    if (a) await api('PATCH', `/accounts/${a.id}`, body); else await post(`/businesses/${bizId}/accounts`, body);
    toast(t('saved'), 'ok'); close(); done();
  } });
}

function supplierForm(bizId: string, s: any | null, done: () => void) {
  const f = h('div', { class: 'form' }, field(t('name'), input('name', { value: s?.name ?? '', required: true })), field(t('phone'), input('phone', { value: s?.phone ?? '', dir: 'ltr' })),
    field(t('address'), input('address', { value: s?.address ?? '' }), 'full'), field(t('notes'), h('textarea', { class: 'input', name: 'notes' }, s?.notes ?? ''), 'full'));
  modal({ title: s ? s.name : t('add'), body: f, onSubmit: async (close) => {
    const d = formData(f);
    const body = { name: d.name, phone: nullIfEmpty(d.phone), address: nullIfEmpty(d.address), notes: nullIfEmpty(d.notes) };
    if (s) await api('PATCH', `/suppliers/${s.id}`, body); else await post(`/businesses/${bizId}/suppliers`, body);
    toast(t('saved'), 'ok'); close(); done();
  } });
}
export const _spinner = spinner;

// ================================================================== catégories (carte réutilisable + page dédiée)
// Deux niveaux : catégorie principale (ex. « Équipements ») et sous-catégories (ex. « Caméras », « Routeurs »).
export async function categoriesCard(bizId: string, rerun: () => void): Promise<HTMLElement> {
  const canCat = can('manage_categories', bizId);
  const cats = await get<any[]>(`/businesses/${bizId}/categories`, { all: true });
  const several = me().businesses.filter((b) => can('manage_categories', b.id)).length > 1;
  const row = (c: any, sub: boolean) => h('div', { class: 'row', style: `gap:6px;${sub ? 'padding-inline-start:20px;' : 'font-weight:600;'}${c.is_active ? '' : 'opacity:.5'}` },
    sub ? h('span', { class: 'muted', 'aria-hidden': 'true' }, '↳') : h('span', { style: `width:9px;height:9px;border-radius:3px;flex:none;background:${c.color ?? 'var(--mu)'}` }),
    h('span', { style: `flex:1;${c.is_active ? '' : 'text-decoration:line-through'}` }, c.name),
    canCat && !sub ? h('button', { class: 'btn ghost sm', title: `${t('add_sub')} — ${c.name}`, 'aria-label': `${t('add_sub')} ${c.name}`,
      onclick: () => newCategoryForm(bizId, kindOf(c), cats, rerun, c.id) }, icon('plus', 14)) : null,
    canCat ? h('button', { class: 'btn ghost sm', title: t('edit_category'), 'aria-label': `${t('edit_category')} ${c.name}`, onclick: () => categoryForm(c, cats, rerun) }, icon('pen', 14)) : null,
    canCat ? h('button', { class: 'btn ghost sm', title: c.is_active ? t('deactivate') : t('activate'), onclick: async () => {
      try { await api('PATCH', `/categories/${c.id}`, { isActive: !c.is_active }); toast(t('saved'), 'ok'); rerun(); } catch (e) { toast(errMsg(e), 'err'); }
    } }, c.is_active ? icon('x', 14) : icon('check', 14)) : null);
  return h('div', { class: 'card col' },
    h('div', { class: 'row', style: 'flex-wrap:wrap' }, h('h2', { style: 'margin:0' }, icon('tag'), ' ', t('categories')), h('span', { class: 'spacer' }),
      isAdmin() ? h('button', { class: 'btn sm', onclick: () => openOpTypeForm(null, rerun) }, icon('plus', 15), t('new_op_type')) : null,
      canCat ? h('button', { class: 'btn pri sm', onclick: () => newCategoryForm(bizId, 'expense', cats, rerun, null, several) }, icon('plus', 15), t('new_main_category')) : null),
    h('p', { class: 'muted small', style: 'margin:0' }, t('categories_hint')),
    h('div', { class: 'grid g3', style: 'gap:12px' }, kindOptions().map(({ value: k }) => {
      const mains = cats.filter((c) => kindOf(c) === k && !c.parent_id);
      const ot = k.startsWith('ot:') ? opTypeById(k.slice(3)) : null;
      return h('div', { class: 'col', style: 'gap:4px' },
        h('div', { class: 'row' }, h('b', { class: kindCls(k), style: `flex:1;${ot?.color ? 'color:' + ot.color : ''}` }, kindName(k),
          ot ? h('span', { class: 'muted small' }, ` · ${t('custom_type')}`) : ''),
          canCat ? h('button', { class: 'btn ghost sm', title: `${t('new_main_category')} — ${kindName(k)}`, onclick: () => newCategoryForm(bizId, k, cats, rerun, null, several) }, icon('plus', 14)) : null),
        mains.length ? mains.map((m) => [row(m, false), ...cats.filter((c) => c.parent_id === m.id).map((c) => row(c, true))])
          : h('span', { class: 'muted small' }, '—'));
    })));
}

// Colonne d'une catégorie : un des 5 types de base, ou « ot:<id> » pour un type personnalisé
const kindOf = (c: any) => (c.op_type_id ? 'ot:' + c.op_type_id : c.txn_type);
const kindName = (k: string) => (k.startsWith('ot:') ? (opTypeById(k.slice(3))?.name ?? '?') : typeLabel(k));
const kindCls = (k: string) => (k.startsWith('ot:') ? (opTypeById(k.slice(3))?.dir === 'in' ? 'c-income' : 'c-expense') : `c-${k}`);
const kindOptions = () => [...SIMPLE.map((x) => ({ value: x as string, label: typeLabel(x) })),
  ...opTypes().map((o) => ({ value: 'ot:' + o.id, label: `${o.name} (${o.dir === 'in' ? '⬆' : '⬇'})` }))];

function parentOptions(cats: any[], kind: string, exclude?: string) {
  return [{ value: '', label: t('parent_none') },
    ...cats.filter((c) => kindOf(c) === kind && !c.parent_id && c.id !== exclude && c.is_active).map((c) => ({ value: c.id, label: c.name }))];
}

function newCategoryForm(bizId: string, type: string, cats: any[], done: () => void, parentId: string | null, several = false) {
  const typeSel = select('txnType', kindOptions(), type, parentId ? { disabled: true } : {});
  const parent = select('parentId', parentOptions(cats, type), parentId ?? '');
  typeSel.addEventListener('change', () => { clear(parent); parentOptions(cats, typeSel.value).forEach((o) => parent.appendChild(h('option', { value: o.value }, o.label))); });
  const all = h('input', { type: 'checkbox', name: 'allBusinesses' }) as HTMLInputElement;
  const f = h('div', { class: 'form' }, field(t('type'), typeSel), field(t('main_category'), parent),
    field(t('name'), input('name', { required: true, maxlength: '80' }), 'full'),
    field(t('color'), input('color', { type: 'color', value: '#8a8fb0', style: 'min-height:44px;padding:4px' })),
    several ? h('label', { class: 'check full' }, all, t('add_all_businesses')) : null);
  const title = parentId ? `${t('add_sub')} — ${cats.find((c) => c.id === parentId)?.name ?? ''}` : t('new_main_category');
  modal({ title, body: f, onSubmit: async (close) => {
    const d = formData(f);
    const k = typeSel.value;
    await post(`/businesses/${bizId}/categories`, { txnType: k.startsWith('ot:') ? 'expense' : k, opTypeId: k.startsWith('ot:') ? k.slice(3) : undefined, name: d.name, color: d.color, parentId: nullIfEmpty(parent.value), allBusinesses: all.checked || undefined });
    close(); done();
  } });
}

function categoryForm(c: any, cats: any[], done: () => void) {
  const parent = select('parentId', parentOptions(cats, kindOf(c), c.id), c.parent_id ?? '', c.children > 0 ? { disabled: true } : {});
  const f = h('div', { class: 'form' },
    field(t('type'), h('div', { class: kindCls(kindOf(c)), style: 'padding:10px 0;font-weight:700' }, kindName(kindOf(c)))),
    field(t('name'), input('name', { value: c.name, required: true, maxlength: '80' })),
    field(t('main_category'), parent),
    field(t('color'), input('color', { type: 'color', value: /^#[0-9a-fA-F]{6}$/.test(c.color ?? '') ? c.color : '#8a8fb0', style: 'min-height:44px;padding:4px' })),
    h('label', { class: 'check full' }, h('input', { type: 'checkbox', name: 'isActive', checked: c.is_active }), t('active')));
  modal({ title: `${t('edit_category')} — ${c.name}`, body: f, onSubmit: async (close) => {
    const d = formData(f);
    const body: Record<string, unknown> = { name: d.name, color: d.color, isActive: d.isActive === '1' };
    if ((parent.value || null) !== (c.parent_id ?? null)) body.parentId = nullIfEmpty(parent.value);
    await api('PATCH', `/categories/${c.id}`, body);
    close(); done();
  } });
}

export async function categoriesPage(root: HTMLElement, _p: string[], query: URLSearchParams) {
  const list = me().businesses.filter((b) => can('manage_categories', b.id) || can('view', b.id) || isAdmin());
  if (!list.length) { root.append(empty()); return; }
  const sel = select('businessId', list.map((b) => ({ value: b.id, label: b.name })), query.get('businessId') ?? list[0].id, { style: 'width:auto' });
  const holder = h('div', { class: 'col' });
  const load = async () => { clear(holder).append(spinner()); const card = await categoriesCard(sel.value, load); clear(holder).append(card); };
  sel.addEventListener('change', () => { void load(); });
  root.append(h('div', { class: 'page-head' }, h('div', null, h('h1', null, t('categories'))), h('div', { class: 'actions' }, sel)), holder);
  await load();
}
