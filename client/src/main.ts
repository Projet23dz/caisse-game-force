// Point d'entrée : session, routeur, gabarit (barre latérale + barre supérieure), connexion.
import { api, ApiError, authImg, can, clear, deviceName, errMsg, field, fmtDate, getRefresh, gfLogo, get, h, icon, input, isAdmin, loadOpTypes, type Me, passwordInput, post, session, setRefresh, setToken, spinner, today, toast, tryRefresh } from './core.js';
import { getLang, type Lang, setLang, t } from './i18n.js';
import { activityPage } from './pages/activity.js';
import { auditPage } from './pages/audit.js';
import { businessPage, businessesPage, categoriesPage } from './pages/businesses.js';
import { chequesPage } from './pages/cheques.js';
import { dashboardPage } from './pages/dashboard.js';
import { payrollPage } from './pages/payroll.js';
import { reportsPage } from './pages/reports.js';
import { settingsPage } from './pages/settings.js';
import { transactionsPage, transfersPage } from './pages/transactions.js';
import { treasuryPage } from './pages/treasury.js';
import { usersPage } from './pages/users.js';

export type Page = (root: HTMLElement, params: string[], query: URLSearchParams) => Promise<void> | void;

const ROUTES: Record<string, { page: Page; nav?: string }> = {
  dashboard: { page: dashboardPage, nav: 'dashboard' },
  businesses: { page: businessesPage, nav: 'businesses' },
  business: { page: businessPage, nav: 'businesses' },
  categories: { page: categoriesPage, nav: 'categories' },
  transactions: { page: transactionsPage, nav: 'transactions' },
  transfers: { page: transfersPage, nav: 'transfers' },
  treasury: { page: treasuryPage, nav: 'treasury' },
  cheques: { page: chequesPage, nav: 'cheques' },
  payroll: { page: payrollPage, nav: 'payroll' },
  reports: { page: reportsPage, nav: 'reports' },
  users: { page: usersPage, nav: 'users' },
  audit: { page: auditPage, nav: 'audit' },
  activity: { page: activityPage, nav: 'activity' },
  settings: { page: settingsPage, nav: 'settings' },
};

export function applyTheme(theme?: string) {
  const th = theme || 'game-force-dark';
  document.documentElement.dataset.theme = th;
  try { localStorage.setItem('cp.theme', th); } catch { /* */ }
}

export async function loadMe() {
  session.me = await get<Me>('/auth/me');
  await loadOpTypes();
  setLang(session.me.user.locale ?? 'ar');
  applyTheme(session.me.user.theme);
}

const app = document.getElementById('app')!;
let shell: { content: HTMLElement; side: HTMLElement; bell: HTMLElement; act: HTMLElement | null } | null = null;

function navItems() {
  const items: [string, string, string, boolean][] = [
    ['dashboard', 'dashboard', t('nav_dashboard'), true],
    ['businesses', 'business', t('nav_businesses'), true],
    ['transactions', 'transactions', t('nav_transactions'), true],
    ['categories', 'tag', t('categories'), can('manage_categories')],
    ['transfers', 'transfer', t('nav_transfers'), can('transfer')],
    ['treasury', 'wallet', t('nav_treasury'), can('cash_session') || can('view_balances')],
    ['cheques', 'cheque', t('nav_cheques'), can('cheques')],
    ['payroll', 'payroll', t('nav_payroll'), can('payroll') || can('manage_employees')],
    ['reports', 'reports', t('nav_reports'), can('view_reports')],
    ['users', 'users', t('nav_users'), isAdmin()],
    ['activity', 'bell', t('act_title'), isAdmin()],
    ['audit', 'audit', t('nav_audit'), can('view_audit') || isAdmin()],
    ['settings', 'settings', t('nav_settings'), true],
  ];
  return items.filter((i) => i[3]);
}

function buildShell() {
  const m = session.me!;
  const side = h('nav', { class: 'side', 'aria-label': 'Menu' },
    h('div', { class: 'brand' }, m.settings.app_logo ? authImg('/settings/logo', 'CashPro', () => gfLogo()) : gfLogo(),
      h('div', { class: 'col', style: 'gap:0' }, h('b', null, 'Cash', h('span', null, 'Pro')), h('span', { class: 'muted small' }, t('app_tagline')))),
    navItems().map(([id, ic, label]) => h('a', { href: `#/${id}`, class: 'nav', 'data-nav': id, onclick: () => side.classList.remove('open') }, icon(ic), label)),
    h('div', { class: 'grow' }),
    h('div', { class: 'usercard' },
      h('div', { class: 'avatar', 'aria-hidden': 'true' }, (m.user.full_name || '?').trim().charAt(0).toUpperCase()),
      h('div', { class: 'col', style: 'gap:0;flex:1;min-width:0' }, h('b', { style: 'overflow:hidden;text-overflow:ellipsis;white-space:nowrap' }, m.user.full_name),
        h('span', { class: 'muted small' }, m.user.role === 'admin' ? t('r_admin') : t('r_user'))),
      h('button', { class: 'btn ghost icon-btn', title: t('logout'), 'aria-label': t('logout'), onclick: logout }, icon('logout'))));

  const search = h('input', { name: 'q', type: 'search', placeholder: `${t('search')}…  (Ctrl+K)` });
  search.addEventListener('keydown', (e) => { if (e.key === 'Enter') location.hash = `#/transactions?q=${encodeURIComponent(search.value)}`; });
  document.addEventListener('keydown', (e) => { if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); search.focus(); } });
  const lang = h('select', { class: 'input', style: 'width:auto;min-height:40px', 'aria-label': t('language') },
    h('option', { value: 'ar' }, 'العربية'), h('option', { value: 'fr' }, 'Français'), h('option', { value: 'en' }, 'English'));
  lang.value = getLang();
  lang.addEventListener('change', async () => {
    try { await api('PATCH', '/auth/me', { locale: lang.value }); } catch { /* préférence locale seulement */ }
    session.me!.user.locale = lang.value as Lang; setLang(lang.value as Lang); shell = null; route();
  });
  const bell = h('a', { href: '#/dashboard', class: 'btn icon-btn', style: 'position:relative', 'aria-label': t('alerts') }, icon('bell'));
  // administrateur : modifications faites par les employés (🔔 activité)
  const act = isAdmin() ? h('a', { href: '#/activity', class: 'btn icon-btn', style: 'position:relative', 'aria-label': t('act_title'), title: t('act_title') }, icon('eye')) : null;
  const top = h('header', { class: 'top' },
    h('button', { class: 'btn icon-btn menu-btn', 'aria-label': 'Menu', onclick: () => side.classList.toggle('open') }, icon('menu')),
    h('button', { class: 'btn icon-btn top-back hidden', 'aria-label': t('back'), title: t('back'),
      onclick: () => { if (history.length > 1) history.back(); else location.hash = '#/dashboard'; } }, icon('back')),
    h('label', { class: 'searchbox' },
      icon('search', 17), h('span', { class: 'sr' }, t('search')), search),
    h('div', { class: 'spacer' }), act, bell, lang,
    h('div', { class: 'row btn', style: 'cursor:default' }, icon('calendar', 17), h('span', { class: 'num' }, fmtDate(today()))));
  const content = h('div', { class: 'content', id: 'content' });
  // téléphone : voile derrière le menu ouvert ; un appui ferme le menu
  const backdrop = h('div', { class: 'backdrop', 'aria-hidden': 'true', onclick: () => side.classList.remove('open') });
  clear(app).appendChild(h('div', { class: 'app' }, side, backdrop, h('div', { class: 'main' }, top, h('main', null, content))));
  shell = { content, side, bell, act };
  refreshBell();
  void refreshActivity();
}

// compteur des alertes d'activité non vues (administrateur), rafraîchi chaque minute et après chaque enregistrement
export async function refreshActivity() {
  if (!shell?.act) return;
  try {
    const { unread } = await get<{ unread: number }>('/alerts/count');
    shell.act.querySelector('.badge')?.remove();
    if (unread) shell.act.appendChild(h('span', { class: 'badge red', style: 'position:absolute;top:-4px;inset-inline-end:-4px' }, unread > 99 ? '99+' : String(unread)));
    const nav = shell.side.querySelector('[data-nav="activity"]');
    nav?.querySelector('.badge')?.remove();
    if (unread && nav) nav.appendChild(h('span', { class: 'badge red', style: 'margin-inline-start:auto' }, String(unread)));
  } catch { /* silencieux */ }
}
window.addEventListener('cp:alerts', () => { void refreshActivity(); });
window.addEventListener('cp:changed', () => { void refreshActivity(); });
setInterval(() => { if (document.visibilityState === 'visible') void refreshActivity(); }, 60_000);

export async function refreshBell() {
  if (!shell) return;
  try {
    const d = await get('/dashboard');
    const n = d.alerts.chequesDue.length + d.alerts.sessionsPendingReview.length + d.alerts.sessionsNotClosed.length + d.alerts.payrollUnpaid.length;
    shell.bell.querySelector('.badge')?.remove();
    if (n) shell.bell.appendChild(h('span', { class: 'badge red', style: 'position:absolute;top:-4px;inset-inline-end:-4px' }, String(n)));
  } catch { /* silencieux */ }
}

async function logout() {
  const rt = await getRefresh();
  if (rt) await post('/auth/logout', { refreshToken: rt }).catch(() => undefined);
  await setRefresh(''); setToken(''); session.me = null; shell = null; location.hash = '#/login';
}

let routeSeq = 0;
async function route() {
  const seq = ++routeSeq;
  const raw = location.hash.replace(/^#\/?/, '') || 'dashboard';
  const [path, q = ''] = raw.split('?');
  const [name, ...params] = path.split('/');
  if (name === 'login') return loginPage();
  if (!session.token && !(await tryRefresh())) return loginPage();   // « تذكّرني » : reconnexion sans mot de passe
  if (seq !== routeSeq) return;
  if (!session.me) {
    try { await loadMe(); if (seq !== routeSeq) return; } catch (e) {
      if (e instanceof ApiError && e.code === 'PASSWORD_CHANGE_REQUIRED') return changePasswordPage('', Boolean(await getRefresh()));
      if (e instanceof ApiError && e.status === 401) return loginPage();
      clear(app).appendChild(h('div', { class: 'login' }, h('div', { class: 'card' }, h('div', { class: 'err-box' }, errMsg(e)), h('button', { class: 'btn pri', onclick: () => route() }, t('refresh')))));
      return;
    }
  }
  const r = ROUTES[name] ?? ROUTES.dashboard;
  if (!shell) buildShell();
  shell!.side.querySelectorAll('.nav').forEach((n) => n.classList.toggle('on', (n as HTMLElement).dataset.nav === r.nav));
  shell!.side.parentElement?.querySelector('.top-back')?.classList.toggle('hidden', !ROUTES[name] || name === 'dashboard');
  const content = clear(shell!.content) as HTMLElement;
  content.appendChild(spinner());
  try {
    const box = h('div', { class: 'col', style: 'gap:20px' });
    await r.page(box, params, new URLSearchParams(q));
    if (seq !== routeSeq) return;               // une navigation plus récente a pris la main
    clear(content).appendChild(box);
  } catch (e) {
    if (seq !== routeSeq) return;
    clear(content).appendChild(h('div', { class: 'err-box' }, errMsg(e)));
  }
  window.scrollTo(0, 0);
}

// ------------------------------------------------------------------ connexion
function authFrame(...kids: Node[]) {
  const lang = h('select', { class: 'input', style: 'width:auto', 'aria-label': t('language') },
    h('option', { value: 'ar' }, 'العربية'), h('option', { value: 'fr' }, 'Français'), h('option', { value: 'en' }, 'English'));
  lang.value = getLang();
  lang.addEventListener('change', () => { setLang(lang.value as Lang); route(); });
  clear(app).appendChild(h('div', { class: 'login' }, h('div', { class: 'card' },
    h('div', { class: 'row', style: 'justify-content:space-between' }, h('div', { class: 'brand', style: 'padding:0' }, gfLogo(48),
      h('div', { class: 'col', style: 'gap:0' }, h('b', null, 'Cash', h('span', null, 'Pro')), h('span', { class: 'muted small' }, t('app_tagline')))), lang),
    ...kids)));
}

function loginPage() {
  shell = null; session.me = null;
  let last = ''; let rememberPref = false;
  try { last = localStorage.getItem('cp.lastUser') ?? ''; rememberPref = localStorage.getItem('cp.remember') === '1'; } catch { /* */ }
  const u = input('username', { autocomplete: 'username', required: true, dir: 'ltr', value: last });
  const pw = passwordInput('password', { autocomplete: 'current-password', required: true });
  const remember = h('input', { type: 'checkbox', name: 'remember', checked: rememberPref });
  const err = h('div', { class: 'err-box hidden', role: 'alert' });
  const btn = h('button', { class: 'btn pri', type: 'submit' }, t('login_btn'));
  const form = h('form', { class: 'col', style: 'gap:14px' }, h('h1', null, t('login_title')), err, field(t('username'), u), field(t('password'), pw.el),
    h('div', { class: 'remember' }, h('label', { class: 'check' }, remember, t('remember_me')), h('span', { class: 'muted small' }, t('remember_hint'))), btn);
  form.addEventListener('submit', async (e) => {
    e.preventDefault(); err.classList.add('hidden'); btn.disabled = true;
    try {
      const r = await post<{ token: string; refreshToken?: string; remembered?: boolean; user: { mustChangePassword: boolean; locale: Lang; theme: string } }>('/auth/login',
        { username: u.value.trim(), password: pw.input.value, remember: remember.checked, ...(remember.checked ? { deviceName: await deviceName() } : {}) });
      try { localStorage.setItem('cp.lastUser', u.value.trim()); localStorage.setItem('cp.remember', remember.checked ? '1' : '0'); } catch { /* */ }
      setToken(r.token); setLang(r.user.locale); applyTheme(r.user.theme);
      await setRefresh(r.refreshToken ?? '');
      if (remember.checked && r.remembered === false) toast(t('remember_refused'));
      if (r.user.mustChangePassword) return changePasswordPage(pw.input.value, remember.checked);
      if (location.hash === '#/dashboard') route(); else location.hash = '#/dashboard';
    } catch (ex) { err.textContent = errMsg(ex); err.classList.remove('hidden'); } finally { btn.disabled = false; }
  });
  authFrame(form);
  setTimeout(() => (last ? pw.input : u).focus(), 50);
}

export function changePasswordForm(current = '', onDone: () => void, remember?: boolean) {
  const c = passwordInput('current', { autocomplete: 'current-password', value: current });
  const n1 = passwordInput('new', { autocomplete: 'new-password' });
  const n2 = passwordInput('new2', { autocomplete: 'new-password' });
  const err = h('div', { class: 'err-box hidden', role: 'alert' });
  const btn = h('button', { class: 'btn pri', type: 'submit' }, t('change_pw'));
  const form = h('form', { class: 'col', style: 'gap:12px' }, err, field(t('current_pw'), c.el), field(t('new_pw'), n1.el), h('span', { class: 'muted small' }, t('pw_rule')), field(t('confirm_pw'), n2.el), btn);
  form.addEventListener('submit', async (e) => {
    e.preventDefault(); err.classList.add('hidden');
    if (n1.input.value !== n2.input.value) { err.textContent = t('pw_mismatch'); err.classList.remove('hidden'); return; }
    btn.disabled = true;
    try {
      // le changement révoque les appareils mémorisés : ce poste est mémorisé à nouveau s'il l'était
      const keep = remember ?? Boolean(await getRefresh());
      const r = await post<{ token: string; refreshToken?: string }>('/auth/change-password',
        { currentPassword: c.input.value, newPassword: n1.input.value, ...(keep ? { remember: true, deviceName: await deviceName() } : {}) });
      setToken(r.token); await setRefresh(r.refreshToken ?? ''); toast(t('saved'), 'ok'); onDone();
    }
    catch (ex) { err.textContent = errMsg(ex); err.classList.remove('hidden'); } finally { btn.disabled = false; }
  });
  return form;
}

function changePasswordPage(current = '', remember = false) {
  authFrame(h('h1', null, t('change_pw')), h('div', { class: 'alert' }, h('span', { class: 'dot', style: 'background:var(--warn)' }), t('must_change_pw')),
    changePasswordForm(current, () => { session.me = null; if (location.hash === '#/dashboard') route(); else location.hash = '#/dashboard'; }, remember));
}

// ------------------------------------------------------------------ démarrage
try { setLang((localStorage.getItem('cp.lang') as Lang) || 'ar'); applyTheme(localStorage.getItem('cp.theme') || undefined); } catch { setLang('ar'); }
window.addEventListener('hashchange', route);
export const rerender = route;
export function resetShell() { shell = null; }
route();
