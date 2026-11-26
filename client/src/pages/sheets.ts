// Paramètres → Google Sheets (consultation en lecture seule) + copie des sauvegardes vers Google Drive
import { api, download, errMsg, field, fmtDate, get, h, icon, input, modal, post, select, toast } from '../core.js';
import { t } from '../i18n.js';

const ERRORS: Record<string, Parameters<typeof t>[0]> = {
  offline: 'gs_e_offline', unauthorized: 'gs_e_token', not_found: 'gs_e_url', bad_response: 'gs_e_url', script: 'gs_e_script',
  busy: 'gs_e_busy', db: 'gs_e_db', no_url: 'gs_e_nourl', no_user: 'gs_e_nourl', unsupported: 'gs_e_unsupported',
};

async function scriptText(): Promise<string> {
  const b = await api<Blob>('GET', '/admin/sheets/script');
  return typeof b === 'string' ? b : b.text();
}

function copy(text: string) {
  if (navigator.clipboard && window.isSecureContext) return navigator.clipboard.writeText(text);
  const ta = h('textarea', { style: 'position:fixed;opacity:0' }); ta.value = text;
  document.body.appendChild(ta); ta.select(); document.execCommand('copy'); ta.remove();
  return Promise.resolve();
}

export function sheetsCard(): HTMLElement {
  const body = h('div', { class: 'col' }, h('span', { class: 'muted small' }, '…'));
  const card = h('div', { class: 'card col' }, h('h2', { style: 'margin:0' }, icon('reports'), ' ', t('gs_title')),
    h('span', { class: 'muted small' }, t('gs_sub')), body);

  const render = (s: any) => {
    const url = input('gsurl', { value: s.url, dir: 'ltr', placeholder: 'https://script.google.com/macros/s/…/exec' });
    const on = h('input', { type: 'checkbox', checked: Boolean(s.enabled) });
    const every = select('gsint', [1, 5, 10, 15, 30, 60].map((m) => ({ value: String(m), label: `${m} ${t('gs_min')}` })), String(s.intervalMin));
    const st = s.state ?? {};
    const err = st.lastError ? t(ERRORS[st.lastError] ?? 'gs_e_script') : '';
    const status = !s.enabled
      ? h('div', { class: 'row', style: 'gap:8px' }, h('span', { class: 'dot', style: 'background:var(--muted)' }), t('gs_off'))
      : err
        ? h('div', { class: 'err-box' }, `${t('gs_last_err')} (${fmtDate(st.lastErrorAt, true)}) : ${err}`)
        : h('div', { class: 'row', style: 'gap:8px;color:var(--inc);font-weight:700' }, icon('check', 18),
          st.lastOkAt ? `${t('gs_ok')} — ${fmtDate(st.lastOkAt, true)}` : t('gs_wait'));
    body.replaceChildren(
      h('ol', { class: 'small', style: 'margin:0;padding-inline-start:20px;line-height:1.9' },
        h('li', null, t('gs_s1')), h('li', null, t('gs_s2'),
          h('div', { class: 'row', style: 'gap:8px;margin:6px 0' },
            h('button', { class: 'btn sm pri', onclick: async () => {
              try { await copy(await scriptText()); toast(t('gs_copied'), 'ok'); } catch (e) { toast(errMsg(e), 'err'); }
            } }, icon('clip', 16), t('gs_copy')),
            h('button', { class: 'btn sm', onclick: () => download('/admin/sheets/script', 'CashPro-Sheets.gs').catch((e) => toast(errMsg(e), 'err')) },
              icon('download', 16), t('gs_dl')))),
        h('li', null, t('gs_s3')), h('li', null, t('gs_s4'))),
      field(t('gs_url'), url),
      h('div', { class: 'row', style: 'flex-wrap:wrap;gap:12px' }, h('label', { class: 'check' }, on, t('gs_enable')), field(t('gs_every'), every)),
      status,
      st.lastDataAt ? h('span', { class: 'muted small' }, `${t('gs_data_at')} : ${fmtDate(st.lastDataAt, true)}${st.rows != null ? ` · ${st.rows} ${t('gs_rows')}` : ''}${s.configuredBy ? ` · ${t('gs_by')} ${s.configuredBy}` : ''}`) : '',
      h('div', { class: 'row', style: 'flex-wrap:wrap' },
        h('button', { class: 'btn pri', onclick: async () => {
          try { render(await api('PUT', '/admin/sheets', { url: url.value.trim(), enabled: on.checked, intervalMin: Number(every.value) })); toast(t('saved'), 'ok'); }
          catch (e) { toast(errMsg(e), 'err'); }
        } }, t('save')),
        h('button', { class: 'btn', disabled: !s.url, onclick: async (ev: Event) => {
          const b = ev.currentTarget as HTMLButtonElement; b.disabled = true; b.textContent = t('gs_running');
          try { const r = await post('/admin/sheets/run'); render(r); if (!r.state?.lastError) toast(t('gs_ok'), 'ok'); }
          catch (e) { toast(errMsg(e), 'err'); void load(); }
        } }, icon('refresh', 16), t('gs_now')),
        h('span', { class: 'spacer' }),
        h('button', { class: 'btn ghost sm', onclick: () => modal({
          title: t('gs_newtoken'), body: h('p', null, t('gs_newtoken_q')), submitText: t('gs_newtoken'),
          onSubmit: async (close) => { render(await post('/admin/sheets/token')); toast(t('gs_newtoken_done'), 'ok'); close(); },
        }) }, t('gs_newtoken'))));
  };
  const load = async () => { try { render(await get('/admin/sheets')); } catch (e) { body.replaceChildren(h('div', { class: 'err-box' }, errMsg(e))); } };
  void load();
  return card;
}

export function driveCard(): HTMLElement {
  const body = h('div', { class: 'col' }, h('span', { class: 'muted small' }, '…'));
  const card = h('div', { class: 'card col' }, h('h2', { style: 'margin:0' }, icon('upload'), ' ', t('gd_title')),
    h('span', { class: 'muted small' }, t('gd_sub')), body);
  const render = (s: { path: string | null; candidates: string[] }) => {
    const p = input('gdpath', { value: s.path ?? '', dir: 'ltr', placeholder: 'C:\\Users\\…\\My Drive' });
    const save = async (v: string | null) => {
      try { render(await api('PUT', '/admin/backup/offsite', { path: v })); toast(t('saved'), 'ok'); } catch (e) { toast(errMsg(e), 'err'); }
    };
    body.replaceChildren(
      h('ol', { class: 'small', style: 'margin:0;padding-inline-start:20px;line-height:1.9' }, h('li', null, t('gd_s1')), h('li', null, t('gd_s2')), h('li', null, t('gd_s3'))),
      s.candidates.length ? h('div', { class: 'row', style: 'flex-wrap:wrap;gap:8px' }, h('span', { class: 'small' }, t('gd_found')),
        s.candidates.map((c) => h('button', { class: 'btn sm', dir: 'ltr', onclick: () => { p.value = c; } }, c))) : '',
      field(t('gd_path'), p),
      s.path ? h('div', { class: 'row', style: 'gap:8px;color:var(--inc);font-weight:700' }, icon('check', 18), `${t('gd_on')} ${s.path}\\CashPro-Backups`) : h('span', { class: 'muted small' }, t('gd_off')),
      h('div', { class: 'row' }, h('button', { class: 'btn pri', onclick: () => save(p.value.trim() || null) }, t('save')),
        s.path ? h('button', { class: 'btn ghost sm', onclick: () => save(null) }, t('gd_stop')) : ''));
  };
  void get('/admin/backup/offsite').then(render).catch((e) => body.replaceChildren(h('div', { class: 'err-box' }, errMsg(e))));
  return card;
}
