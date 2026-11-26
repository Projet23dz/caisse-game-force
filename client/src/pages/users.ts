import { api, clear, errMsg, field, fmtDate, formData, get, h, icon, input, kindLabel, me, modal, nullIfEmpty, passwordInput, post, select, spinner, toast } from '../core.js';
import { devicesCard } from './settings.js';
import { t, tk } from '../i18n.js';
import { accountsOf } from './transactions.js';

export async function usersPage(root: HTMLElement) {
  const box = h('div', { class: 'col' });
  const load = async () => {
    clear(box).append(spinner());
    try {
      const [users, bizs] = await Promise.all([get<any[]>('/users'), get<any[]>('/businesses')]);
      clear(box).append(h('div', { class: 'table-wrap' }, h('table', { class: 't' },
        h('thead', null, h('tr', null, [t('full_name'), t('username'), t('role'), ...bizs.map((b) => b.name), t('last_login'), t('status'), t('actions')].map((c) => h('th', null, c)))),
        h('tbody', null, users.map((u) => h('tr', { style: u.is_active ? '' : 'opacity:.5' },
          h('td', null, h('b', null, u.full_name)), h('td', { class: 'num' }, u.username), h('td', null, u.role === 'admin' ? t('r_admin') : t('r_user')),
          ...bizs.map((b) => {
            const bu = u.businesses.find((x: any) => x.businessId === b.id && x.isActive);
            return h('td', null, u.role === 'admin' ? '✓' : bu ? h('span', { class: 'pill' }, tk(bu.profile)) : h('span', { class: 'muted small' }, t('no_access')));
          }),
          h('td', { class: 'num small' }, fmtDate(u.last_login_at, true)),
          h('td', null, !u.is_active ? t('inactive') : u.locked_until && new Date(u.locked_until) > new Date() ? h('span', { class: 'down' }, icon('lock', 15)) : t('active')),
          h('td', null, h('div', { class: 'row', style: 'gap:4px;flex-wrap:nowrap' },
            h('button', { class: 'btn sm', onclick: () => userForm(u, load) }, icon('pen', 15)),
            h('button', { class: 'btn sm', title: t('devices'), 'aria-label': t('devices'), onclick: () => modal({ title: `${t('devices')} — ${u.full_name}`, body: devicesCard(u.id, u.id === me().user.id), noFooter: true }) }, icon('device', 15)),
            u.role !== 'admin' ? h('button', { class: 'btn pri sm', onclick: () => permissionsForm(u, bizs, load) }, t('permissions')) : null))))))));
    } catch (e) { clear(box).append(h('div', { class: 'err-box' }, errMsg(e))); }
  };
  root.append(h('div', { class: 'page-head' }, h('div', null, h('h1', null, t('nav_users')), h('p', null, t('users_sub'))),
    h('div', { class: 'actions' }, h('button', { class: 'btn pri', onclick: () => userForm(null, load) }, icon('plus'), t('new_user')))), box);
  await load();
}

function userForm(u: any | null, done: () => void) {
  const f = h('div', { class: 'form' },
    field(t('full_name'), input('fullName', { value: u?.full_name ?? '', required: true })),
    u ? null : field(t('username'), input('username', { required: true, dir: 'ltr', autocomplete: 'off' })),
    u ? null : field(`${t('password')} (${t('pw_rule')})`, passwordInput('password', { required: true, autocomplete: 'new-password' }).el),
    field(t('role'), select('role', [{ value: 'user', label: t('r_user') }, { value: 'admin', label: t('r_admin') }], u?.role ?? 'user', u?.id === me().user.id ? { disabled: true } : {})),
    field(t('phone'), input('phone', { value: u?.phone ?? '', dir: 'ltr' })), field('Email', input('email', { value: u?.email ?? '', dir: 'ltr' })),
    field(t('language'), select('locale', [{ value: 'ar', label: 'العربية' }, { value: 'fr', label: 'Français' }, { value: 'en', label: 'English' }], u?.locale ?? 'ar')),
    u && u.id !== me().user.id ? h('label', { class: 'check' }, h('input', { type: 'checkbox', name: 'isActive', checked: u.is_active }), t('active')) : null,
    u && u.locked_until ? h('label', { class: 'check' }, h('input', { type: 'checkbox', name: 'unlock' }), t('unlock')) : null,
    u ? h('div', { class: 'full row' }, h('button', { type: 'button', class: 'btn sm', onclick: () => resetPw(u) }, icon('lock', 15), t('reset_pw'))) : null);
  modal({ title: u ? u.full_name : t('new_user'), body: f, onSubmit: async (close) => {
    const d = formData(f);
    if (u) {
      const body: Record<string, unknown> = { fullName: d.fullName, phone: nullIfEmpty(d.phone), email: nullIfEmpty(d.email), locale: d.locale };
      if (u.id !== me().user.id) { body.role = d.role; body.isActive = d.isActive === '1'; }
      if (d.unlock === '1') body.unlock = true;
      await api('PATCH', `/users/${u.id}`, body);
    } else await post('/users', { username: d.username, fullName: d.fullName, password: d.password, role: d.role, phone: nullIfEmpty(d.phone), email: nullIfEmpty(d.email), locale: d.locale });
    toast(t('saved'), 'ok'); close(); done();
  } });
}

function resetPw(u: any) {
  const p = passwordInput('pw', { required: true, autocomplete: 'new-password' });
  modal({ title: `${t('reset_pw')} — ${u.full_name}`, body: h('div', { class: 'col' }, field(t('new_pw'), p.el), h('span', { class: 'muted small' }, t('pw_rule'))),
    onSubmit: async (close) => { await post(`/users/${u.id}/reset-password`, { newPassword: p.input.value }); toast(t('saved'), 'ok'); close(); } });
}

async function permissionsForm(u: any, bizs: any[], done: () => void) {
  const defaults = await get('/permissions/defaults');
  const keys: string[] = defaults.keys;
  const sections: { biz: any; root: HTMLElement; get: () => Record<string, unknown> | null }[] = [];
  for (const b of bizs) {
    const cur = u.businesses.find((x: any) => x.businessId === b.id);
    const accs = await accountsOf(b.id);
    const access = h('input', { type: 'checkbox', checked: Boolean(cur?.isActive) });
    const profile = select('profile', [{ value: 'employee', label: t('employee') }, { value: 'manager', label: t('manager') }], cur?.profile ?? 'employee');
    const perms: Record<string, HTMLInputElement> = {};
    const base = () => (cur && cur.profile === profile.value ? cur.permissions : defaults[profile.value]);
    const grid = h('div', { class: 'grid', style: 'grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:6px' });
    const drawPerms = () => { clear(grid); for (const k of keys) { perms[k] = h('input', { type: 'checkbox', checked: Boolean(base()?.[k]) }); grid.appendChild(h('label', { class: 'check' }, perms[k], tk('p_' + k))); } };
    profile.addEventListener('change', drawPerms); drawPerms();
    const accBoxes = accs.map((a) => ({ a, cb: h('input', { type: 'checkbox', checked: !cur?.allowedAccounts || cur.allowedAccounts.includes(a.id) }) }));
    const max = input('max', { value: cur?.maxAmount ?? '', dir: 'ltr', placeholder: t('optional'), inputmode: 'decimal' });
    const body = h('div', { class: 'col' }, h('div', { class: 'row' }, field(t('profile'), profile), field(`${t('max_amount')} (${t('currency')})`, max)),
      h('b', null, t('allowed_accounts')), h('div', { class: 'row' }, accBoxes.map(({ a, cb }) => h('label', { class: 'check' }, cb, `${a.name} (${kindLabel(a.kind)})`))),
      h('b', null, t('permissions')), grid);
    const sync = () => body.classList.toggle('hidden', !access.checked);
    access.addEventListener('change', sync); sync();
    const root = h('div', { class: 'card col', style: 'padding:14px' }, h('label', { class: 'check', style: 'font-size:16px;font-weight:700' }, access, b.name), body);
    sections.push({ biz: b, root, get: () => {
      if (!access.checked) return cur ? { profile: profile.value, isActive: false } : null;
      const all = accBoxes.every((x) => x.cb.checked);
      return { profile: profile.value, isActive: true, permissions: Object.fromEntries(keys.map((k) => [k, perms[k].checked])),
        allowedAccounts: all ? null : accBoxes.filter((x) => x.cb.checked).map((x) => x.a.id), maxAmount: max.value.trim() || null };
    } });
  }
  const reason = input('reason', { placeholder: t('optional') });
  modal({ title: `${t('permissions')} — ${u.full_name}`, wide: true, body: [...sections.map((s) => s.root), field(t('reason'), reason)], onSubmit: async (close) => {
    for (const s of sections) {
      const b = s.get();
      if (b) await api('PUT', `/users/${u.id}/businesses/${s.biz.id}`, { ...b, ...(reason.value.trim().length >= 3 ? { reason: reason.value.trim() } : {}) });
    }
    toast(t('saved'), 'ok'); close(); done();
  } });
}
