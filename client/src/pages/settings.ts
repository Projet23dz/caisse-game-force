import { api, authImg, desktop, dropImgCache, errMsg, field, fmtDate, get, gfLogo, h, icon, input, isAdmin, me, modal, passwordInput, post, select, setRefresh, toast } from '../core.js';
import { type Lang, setLang, t } from '../i18n.js';
import { applyTheme, changePasswordForm, loadMe, rerender, resetShell } from '../main.js';
import { opTypesCard } from './optypes.js';
import { driveCard, sheetsCard } from './sheets.js';

const THEMES: [string, string, string][] = [
  ['game-force-dark', 'Game Force Dark', '#0A0E27,#E30613,#1F2A7A'], ['game-force-light', 'Game Force Light', '#F3F4F9,#D0050F,#1F2A7A'],
  ['midnight-gold', 'Midnight Black & Gold', '#0B0B10,#D4A23A,#20202B'], ['deep-navy', 'Deep Navy', '#071226,#3B82F6,#162B52'],
  ['emerald-dark', 'Emerald Dark', '#06140F,#10B981,#153226'], ['premium-light', 'Premium Light', '#F7F7F5,#B4862B,#26262E'],
];

export async function settingsPage(root: HTMLElement) {
  const u = me().user;
  const lang = select('locale', [{ value: 'ar', label: 'العربية' }, { value: 'fr', label: 'Français' }, { value: 'en', label: 'English' }], u.locale);
  const name = input('fullName', { value: u.full_name });
  const themes = h('div', { class: 'grid', style: 'grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:10px' },
    THEMES.map(([id, label, colors]) => {
      const [bg, a, b] = colors.split(',');
      return h('button', { class: 'card', style: `padding:10px;cursor:pointer;text-align:start;${u.theme === id ? 'outline:2px solid var(--br)' : ''}`, 'aria-pressed': String(u.theme === id),
        onclick: async () => { try { await api('PATCH', '/auth/me', { theme: id }); u.theme = id; applyTheme(id); resetShell(); rerender(); } catch (e) { toast(errMsg(e), 'err'); } } },
        h('div', { style: `height:54px;border-radius:10px;background:${bg};display:flex;gap:6px;align-items:flex-end;padding:8px;border:1px solid var(--line)` },
          h('span', { style: `width:26px;height:26px;border-radius:7px;background:${a}` }), h('span', { style: `width:26px;height:16px;border-radius:5px;background:${b}` })),
        h('div', { class: 'small', style: 'margin-top:6px;font-weight:600' }, label));
    }));
  root.append(h('div', { class: 'page-head' }, h('div', null, h('h1', null, t('nav_settings')), h('p', null, t('set_sub')))),
    h('section', { class: 'grid g2' },
      h('div', { class: 'card col' }, h('h2', { style: 'margin:0' }, t('my_profile')), field(t('full_name'), name), field(t('language'), lang),
        h('div', { class: 'row' }, h('button', { class: 'btn pri', onclick: async () => {
          try { await api('PATCH', '/auth/me', { fullName: name.value, locale: lang.value }); await loadMe(); setLang(lang.value as Lang); resetShell(); toast(t('saved'), 'ok'); rerender(); } catch (e) { toast(errMsg(e), 'err'); }
        } }, t('save')))),
      h('div', { class: 'card col' }, h('h2', { style: 'margin:0' }, t('change_pw')), changePasswordForm('', () => undefined))),
    h('div', { class: 'card col' }, h('h2', { style: 'margin:0' }, t('theme')), themes),
    desktopCard(),
    devicesCard(u.id, true));
  if (!isAdmin()) return;
  const s = await get('/settings');
  const appName = input('app_name', { value: String(s.app_name ?? 'CashPro') });
  const neg = h('input', { type: 'checkbox', checked: Boolean(s.allow_negative_cash) });
  const days = input('days', { type: 'number', min: '0', max: '60', value: String(s.notifications?.cheque_due_days ?? 3), dir: 'ltr' });
  const rm = { enabled: true, days: 30, admin: true, users: true, ...(s.remember_me ?? {}) };
  const rmOn = h('input', { type: 'checkbox', checked: Boolean(rm.enabled) });
  const rmDays = input('rmdays', { type: 'number', min: '1', max: '365', value: String(rm.days), dir: 'ltr' });
  const rmAdmin = h('input', { type: 'checkbox', checked: Boolean(rm.admin) });
  const rmUsers = h('input', { type: 'checkbox', checked: Boolean(rm.users) });
  // alertes d'activité (🔔)
  const al = { events: 'all', min_amount: null as number | null, include_admins: false, ...(s.activity_alerts ?? {}) };
  const alEvents = select('alEvents', [{ value: 'all', label: t('al_all') }, { value: 'changes', label: t('al_changes') }], al.events);
  const alMin = input('alMin', { inputmode: 'decimal', dir: 'ltr', value: al.min_amount != null ? String(al.min_amount) : '', placeholder: '0' });
  const alAdmins = h('input', { type: 'checkbox', checked: Boolean(al.include_admins) });
  const fileIn = h('input', { type: 'file', accept: '.png,.jpg,.jpeg,.svg,.webp', class: 'hidden' });
  fileIn.addEventListener('change', async () => {
    if (!fileIn.files?.[0]) return;
    const fd = new FormData(); fd.append('file', fileIn.files[0]);
    try { await post('/settings/logo', fd); dropImgCache(); await loadMe(); resetShell(); toast(t('saved'), 'ok'); rerender(); } catch (e) { toast(errMsg(e), 'err'); }
  });
  root.append(h('section', { class: 'grid g2' },
    h('div', { class: 'card col' }, h('h2', { style: 'margin:0' }, t('app_settings')), field(t('app_name'), appName),
      h('label', { class: 'check' }, neg, t('allow_negative')), field(t('cheque_days'), days),
      h('b', { style: 'margin-top:6px' }, t('remember_settings')),
      h('label', { class: 'check' }, rmOn, t('remember_enabled')), field(t('remember_days'), rmDays),
      h('label', { class: 'check' }, rmAdmin, t('remember_admin')), h('label', { class: 'check' }, rmUsers, t('remember_users')),
      h('b', { style: 'margin-top:6px' }, icon('bell', 16), ' ', t('al_settings')),
      field(t('al_events'), alEvents), field(t('al_min'), alMin),
      h('label', { class: 'check' }, alAdmins, t('al_admins')),
      h('div', { class: 'row' }, h('button', { class: 'btn pri', onclick: async () => {
        try {
          await api('PUT', '/settings/app_name', { value: appName.value || 'CashPro' });
          await api('PUT', '/settings/allow_negative_cash', { value: neg.checked });
          await api('PUT', '/settings/notifications', { value: { ...(s.notifications ?? {}), cheque_due_days: Number(days.value) || 0 } });
          await api('PUT', '/settings/remember_me', { value: { enabled: rmOn.checked, days: Math.min(Math.max(Number(rmDays.value) || 30, 1), 365), admin: rmAdmin.checked, users: rmUsers.checked } });
          const min = Number(String(alMin.value).replace(/\s/g, '').replace(',', '.'));
          await api('PUT', '/settings/activity_alerts', { value: { events: alEvents.value, min_amount: alMin.value.trim() && min > 0 ? min : null, include_admins: alAdmins.checked } });
          window.dispatchEvent(new Event('cp:alerts'));
          toast(t('saved'), 'ok');
        } catch (e) { toast(errMsg(e), 'err'); }
      } }, t('save')))),
    h('div', { class: 'card col' }, h('h2', { style: 'margin:0' }, t('app_logo')),
      h('div', { class: 'row', style: 'gap:16px' }, h('div', { style: 'width:72px;height:72px;border-radius:16px;background:#fff;display:grid;place-items:center;overflow:hidden' },
        s.app_logo ? authImg('/settings/logo', 'logo', () => gfLogo(64)) : gfLogo(64)),
        h('div', { class: 'col' }, h('button', { class: 'btn pri', onclick: () => fileIn.click() }, icon('download'), t('upload')), h('span', { class: 'muted small' }, t('logo_hint')), fileIn)))));
  root.append(opTypesCard(() => rerender()), h('section', { class: 'grid g2' }, sheetsCard(), driveCard()), tailnetCard(), updatesCard());
}

// Application Windows : serveur, version, mise à jour de ce poste
function desktopCard(): HTMLElement | string {
  const d = desktop();
  if (!d) return '';
  const ver = h('b', { class: 'num', dir: 'ltr' }, '…');
  // Windows : promesse ; Android : valeur directe
  if (d.version) Promise.resolve().then(() => d.version()).then((v: string) => { ver.textContent = String(v); }).catch(() => undefined);
  return h('div', { class: 'card col' },
    h('div', { class: 'row' }, h('b', null, 'CashPro Desktop'), h('span', { class: 'muted small', dir: 'ltr' }, location.origin), h('span', { class: 'spacer' }),
      h('button', { class: 'btn', onclick: () => d.changeServer() }, icon('refresh'), t('change_server'))),
    h('div', { class: 'row' }, h('span', { class: 'muted small' }, t('upd_app_version')), ver, h('span', { class: 'spacer' }),
      d.checkUpdate ? h('button', { class: 'btn', onclick: async () => {
        try {
          const r = await d.checkUpdate();
          if (r?.status === 'uptodate' || r?.status === 'none') toast(t('upd_uptodate'), 'ok');
          else if (r?.status === 'server') toast(t('upd_clients_hint'));
        } catch (e) { toast(errMsg(e), 'err'); }
      } }, icon('download'), t('upd_check_app')) : ''));
}

// Appareils mémorisés (« تذكّرني ») d'un utilisateur : les siens, ou ceux d'un autre (administrateur)
export function devicesCard(userId: string, self: boolean): HTMLElement {
  const list = h('ul', { class: 'devices' });
  const card = h('div', { class: 'card col' }, h('h2', { style: 'margin:0' }, icon('device'), ' ', t(self ? 'my_devices' : 'devices')),
    h('span', { class: 'muted small' }, t('devices_hint')), list);
  const load = async () => {
    let rows: any[];
    try { rows = await get<any[]>('/auth/devices', self ? undefined : { userId }); } catch (e) { list.replaceChildren(h('li', { class: 'err-box' }, errMsg(e))); return; }
    if (!rows.length) { list.replaceChildren(h('li', { class: 'muted small' }, t('no_devices'))); return; }
    const revoke = async (deviceId?: string) => {
      try {
        await post('/auth/devices/revoke', { ...(self ? {} : { userId }), ...(deviceId ? { deviceId } : {}) });
        if (self && !deviceId) await setRefresh('');
        toast(t('saved'), 'ok'); void load();
      } catch (e) { toast(errMsg(e), 'err'); }
    };
    list.replaceChildren(...rows.map((d) => h('li', null, icon('device', 18),
      h('div', { class: 'col', style: 'gap:0;flex:1;min-width:0' }, h('b', null, d.device_name || '—'),
        h('span', { class: 'muted small' }, `${t('last_used')} : ${fmtDate(d.last_used_at, true)} · ${t('expires')} : ${fmtDate(d.expires_at)}`)),
      h('button', { class: 'btn sm', onclick: () => revoke(d.id) }, t('revoke')))),
    h('li', null, h('span', { class: 'spacer' }), h('button', { class: 'btn sm danger', onclick: () => revoke() }, t('revoke_all'))));
  };
  void load();
  return card;
}

// Mise à jour du serveur (administrateur) : recherche, installation avec sauvegarde, suivi
function updatesCard(): HTMLElement {
  const body = h('div', { class: 'col' }, h('span', { class: 'muted small' }, '…'));
  const card = h('div', { class: 'card col' }, h('h2', { style: 'margin:0' }, icon('download'), ' ', t('updates')), body);
  let timer = 0; let wasRunning = false; let startVersion = '';
  const statusLabel = (s: string) => ({ downloading: t('upd_s_downloading'), backup: t('upd_s_backup'), installing: t('upd_s_installing'), failed: t('upd_s_failed') } as Record<string, string>)[s] ?? '';
  const render = (st: any) => {
    const running = ['downloading', 'backup', 'installing', 'checking'].includes(st.status);
    const rows: Node[] = [
      h('div', { class: 'grid g3', style: 'gap:10px' },
        h('div', null, h('div', { class: 'muted small' }, t('upd_current')), h('b', { class: 'num', dir: 'ltr' }, st.current)),
        h('div', null, h('div', { class: 'muted small' }, t('upd_latest')), h('b', { class: 'num', dir: 'ltr' }, st.latest?.version ?? '—')),
        h('div', null, h('div', { class: 'muted small' }, t('upd_checked')), h('span', { class: 'small' }, st.checkedAt ? fmtDate(st.checkedAt, true) : '—'))),
    ];
    if (running) {
      rows.push(h('div', { class: 'row', style: 'gap:8px;font-weight:700' }, h('span', { class: 'spin', style: 'width:18px;height:18px' }), statusLabel(st.status) + (st.progress != null ? ` — ${st.progress}%` : '')));
      if (st.progress != null) rows.push(h('div', { class: 'upd-bar' }, h('span', { style: `width:${st.progress}%` })));
    } else if (st.status === 'failed') {
      rows.push(h('div', { class: 'err-box' }, `${t('upd_s_failed')} : ${st.error ?? ''}`));
    } else if (st.error) {
      rows.push(h('div', { class: 'err-box' }, st.error));
    }
    if (!running && st.available) {
      rows.push(h('div', { class: 'alert' }, h('span', { class: 'dot', style: 'background:var(--ok)' }), `${t('upd_available')} : ${st.latest.version}`));
      if (st.latest.notes) rows.push(h('div', { class: 'upd-notes', dir: 'auto' }, st.latest.notes));
    } else if (!running && st.latest && !st.error) {
      rows.push(h('div', { class: 'row', style: 'gap:8px;color:var(--inc);font-weight:700' }, icon('check', 18), t('upd_uptodate')));
    }
    rows.push(h('div', { class: 'row' },
      h('button', { class: 'btn', disabled: running, onclick: async () => {
        try { render(await post('/updates/server/check')); } catch (e) { toast(errMsg(e), 'err'); void load(); }
      } }, icon('refresh', 16), t('upd_check')),
      st.available ? h('button', { class: 'btn pri', disabled: running, onclick: () => modal({
        title: `${t('upd_server')} ${st.current} → ${st.latest.version}`, body: h('p', null, t('upd_confirm')), submitText: t('upd_install'),
        onSubmit: async (close) => { startVersion = st.current; render(await post('/updates/server/install')); close(); poll(); },
      }) }, icon('download', 16), t('upd_install')) : '',
      h('span', { class: 'spacer' }),
      h('button', { class: 'btn ghost sm', onclick: () => sourceForm(st) }, t('upd_source'))));
    rows.push(h('span', { class: 'muted small' }, t('upd_clients_hint')));
    body.replaceChildren(...rows);
    if (running) { wasRunning = true; poll(); }
  };
  const load = async () => {
    if (!card.isConnected && timer) { window.clearInterval(timer); timer = 0; return; }
    try {
      const st = await get('/updates/server');
      if (wasRunning && startVersion && st.current !== startVersion) {
        toast(`${t('upd_done')} ${st.current}`, 'ok'); wasRunning = false; setTimeout(() => location.reload(), 1500);
      }
      render(st);
    } catch (e) {
      // pendant l'installation, le serveur redémarre : on attend
      if (wasRunning) body.replaceChildren(h('div', { class: 'row', style: 'gap:8px;font-weight:700' }, h('span', { class: 'spin', style: 'width:18px;height:18px' }), t('upd_s_installing')));
      else body.replaceChildren(h('div', { class: 'err-box' }, errMsg(e)));
    }
  };
  const poll = () => { if (!timer) timer = window.setInterval(() => { void load(); }, 3000); };
  const sourceForm = (st: any) => {
    const repo = input('repo', { value: st.repo, dir: 'ltr' });
    const tok = passwordInput('token', { autocomplete: 'off', placeholder: st.hasToken ? t('upd_token_set') : '' });
    const del = h('input', { type: 'checkbox' });
    modal({ title: t('upd_source'), body: h('div', { class: 'col' }, field(t('upd_repo'), repo), field(t('upd_token'), tok.el),
      h('span', { class: 'muted small' }, t('upd_token_hint')), st.hasToken ? h('label', { class: 'check' }, del, t('upd_token_del')) : ''),
      onSubmit: async (close) => {
        const b: Record<string, unknown> = { repo: repo.value.trim() };
        if (del.checked) b.token = null; else if (tok.input.value.trim()) b.token = tok.input.value.trim();
        render(await api('PUT', '/updates/server/config', b)); toast(t('saved'), 'ok'); close();
      } });
  };
  void load();
  return card;
}

// Accès à distance : adresses du serveur à saisir dans les postes et le téléphone (VPN installé à part : Tailscale officiel…)
function tailnetCard(): HTMLElement {
  const body = h('div', { class: 'col' }, h('span', { class: 'muted small' }, '…'));
  const card = h('div', { class: 'card col' }, h('h2', { style: 'margin:0' }, icon('refresh'), ' ', t('ts_title')), body);
  void (async () => {
    let n: any;
    try { n = await get('/admin/network'); } catch (e) { body.replaceChildren(h('span', { class: 'err-box' }, errMsg(e))); return; }
    const line = (addr: string) => h('code', { dir: 'ltr', style: 'font-weight:700;display:inline-block;padding:4px 8px;border-radius:8px;background:rgba(255,255,255,.06)' }, `http://${addr}:${n.port}`);
    const lan = n.addresses.filter((a: any) => a.kind === 'lan'), vpn = n.addresses.filter((a: any) => a.kind === 'vpn');
    body.replaceChildren(
      h('span', { class: 'small' }, t('net_how')),
      h('div', { class: 'col', style: 'gap:6px' }, h('b', null, t('net_lan')), h('div', { class: 'row', style: 'flex-wrap:wrap;gap:8px' }, lan.map((a: any) => line(a.address)))),
      vpn.length
        ? h('div', { class: 'col', style: 'gap:6px' }, h('b', null, t('net_vpn')), h('div', { class: 'row', style: 'flex-wrap:wrap;gap:8px' }, [...vpn.map((a: any) => line(a.address)), line(n.hostname)]))
        : h('div', { class: 'info-box col', style: 'gap:8px' }, h('span', { class: 'small' }, t('net_no_vpn')),
          h('a', { class: 'btn sm', style: 'align-self:flex-start', href: 'https://tailscale.com/download', target: '_blank', rel: 'noopener noreferrer' }, t('net_dl'))));
  })();
  return card;
}
