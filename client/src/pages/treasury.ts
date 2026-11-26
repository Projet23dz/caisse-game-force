import { askReason, bizWith, can, clear, empty, errMsg, field, fmtDate, get, h, icon, input, isAdmin, me, modal, money, moneyEl, post, select, spinner, toast, today } from '../core.js';
import { t, tk } from '../i18n.js';
import { refreshBell } from '../main.js';
import { accountsOf } from './transactions.js';

export async function treasuryPage(root: HTMLElement, _p: string[], query: URLSearchParams) {
  const bizs = bizWith('cash_session').length ? bizWith('cash_session') : bizWith('view_balances');
  const cashAccounts: any[] = [];
  for (const b of bizs) (await accountsOf(b.id, { kinds: ['cash'] })).forEach((a) => cashAccounts.push({ ...a, bizName: b.name }));
  if (!cashAccounts.length) { root.append(empty()); return; }
  const sel = select('account', cashAccounts.map((a) => ({ value: a.id, label: `${a.bizName} · ${a.name}` })), query.get('account') ?? cashAccounts[0].id, { style: 'width:auto' });
  const box = h('div', { class: 'col', style: 'gap:20px' });
  root.append(h('div', { class: 'page-head' }, h('div', null, h('h1', null, t('nav_treasury')), h('p', null, t('cash_sub'))),
    h('div', { class: 'actions' }, sel)), box);
  const load = async () => { clear(box).append(spinner()); try { await render(box, cashAccounts.find((a) => a.id === sel.value), load); } catch (e) { clear(box).append(h('div', { class: 'err-box' }, errMsg(e))); } };
  sel.addEventListener('change', load);
  await load();
}

async function render(box: HTMLElement, acc: any, reload: () => void) {
  const st = await get('/cash/status', { accountId: acc.id });
  const hist = await get<any[]>('/cash/sessions', { accountId: acc.id });
  clear(box);
  const biz = acc.business_id;
  const theo = st.theoretical != null ? Number(st.theoretical) : null;
  const sess = st.today;
  const statusBadge = sess
    ? h('span', { class: 'badge', style: `color:${sess.status === 'closed' ? 'var(--mu)' : sess.status === 'pending_review' ? 'var(--exp)' : 'var(--inc)'}` },
      '● ', tk('s_' + sess.status), sess.status !== 'closed' ? ` — ${sess.opened_by_name} ${fmtDate(sess.opened_at, true).slice(-5)}` : '')
    : h('span', { class: 'badge', style: 'color:var(--warn)' }, t('no_session'));

  box.append(h('div', { class: 'row' }, statusBadge, h('span', { class: 'spacer' }),
    !sess && can('cash_session', biz) ? h('button', { class: 'btn pri', onclick: async () => {
      try { await post('/cash/sessions/open', { accountId: acc.id }); toast(t('saved'), 'ok'); reload(); } catch (e) { toast(errMsg(e), 'err'); }
    } }, icon('wallet'), t('open_session')) : null));

  box.append(h('section', { class: 'grid g2' },
    h('div', { class: 'card hero-card col', style: 'gap:4px' }, h('span', { class: 'muted' }, t('theoretical')),
      h('span', { class: 'big' }, theo != null ? moneyEl(theo) : t('hidden_balance')),
      sess ? h('span', { class: 'muted small' }, `${t('opening')} : `, moneyEl(sess.opening_balance)) : null),
    h('div', { class: 'card col' }, h('h2', { style: 'margin:0' }, t('day_summary')),
      h('div', { class: 'list-row' }, h('span', { class: 'up' }, '↗'), t('in_today'), h('span', { class: 'spacer' }), h('b', null, moneyEl(st.today_in, { sign: true }))),
      h('div', { class: 'list-row' }, h('span', { class: 'down' }, '↘'), t('out_today'), h('span', { class: 'spacer' }), h('b', null, moneyEl(-Number(st.today_out)))))));

  // sessions à clôturer (jour courant ou jours précédents oubliés)
  for (const p of st.pending) {
    if (p.status === 'pending_review') {
      box.append(h('div', { class: 'card col', style: 'border-color:var(--exp)' },
        h('div', { class: 'row' }, h('b', null, `${t('alert_pending')} — ${fmtDate(p.session_date)}`), h('span', { class: 'spacer' }),
          h('span', null, t('difference'), ' : ', moneyEl(p.difference, { sign: true, cls: Number(p.difference) < 0 ? 'down' : 'up' }))),
        h('span', { class: 'muted' }, `${t('reason')} : ${p.reason ?? '—'} · ${p.closed_by_name ?? ''}`),
        can('adjustment', biz) ? h('div', { class: 'row' }, h('button', { class: 'btn pri', onclick: async () => {
          try { await post(`/cash/sessions/${p.session_id}/approve`, { reason: null }); toast(t('saved'), 'ok'); refreshBell(); reload(); } catch (e) { toast(errMsg(e), 'err'); }
        } }, icon('check'), t('approve'))) : null));
    } else if (can('cash_session', biz)) box.append(closeCard(p, theo, reload));
  }

  // historique
  box.append(h('div', { class: 'card col' }, h('h2', { style: 'margin:0' }, t('closings')),
    hist.length ? h('div', { class: 'table-wrap' }, h('table', { class: 't', style: 'min-width:640px' },
      h('thead', null, h('tr', null, [t('date'), t('status'), t('theoretical'), t('counted'), t('difference'), t('reason'), t('user'), ''].map((c) => h('th', null, c)))),
      h('tbody', null, hist.map((s) => h('tr', null, h('td', { class: 'num' }, fmtDate(s.session_date)), h('td', null, tk('s_' + s.status)),
        h('td', null, s.theoretical_balance != null ? moneyEl(s.theoretical_balance) : '—'), h('td', null, s.physical_balance != null ? moneyEl(s.physical_balance) : '—'),
        h('td', { style: `font-weight:700;color:${Number(s.difference ?? 0) === 0 ? 'var(--inc)' : Number(s.difference) < 0 ? 'var(--exp)' : 'var(--trf)'}` },
          s.difference != null ? h('span', { class: 'num' }, money(s.difference, true)) : '—'),
        h('td', null, s.reason ?? ''), h('td', null, s.closed_by_name ?? s.opened_by_name ?? ''),
        h('td', null, isAdmin() && (s.status === 'closed' || s.status === 'pending_review') ? h('button', { class: 'btn sm', onclick: () => askReason(t('reopen'), async (reason) => {
          await post(`/cash/sessions/${s.session_id}/reopen`, { reason }); toast(t('saved'), 'ok'); reload();
        }, false) }, t('reopen')) : null)))))) : empty()));
}

function closeCard(sess: any, theo: number | null, reload: () => void) {
  const count = input('physical', { type: 'number', step: '0.01', min: '0', inputmode: 'decimal', dir: 'ltr', style: 'font-size:22px;font-weight:700;min-height:52px' });
  const reason = h('textarea', { class: 'input', name: 'reason', placeholder: t('reason_required') });
  const reasonField = field(t('reason_required'), reason, 'hidden');
  const circle = h('div', { class: 'circle' }); const diffTxt = h('b', { style: 'font-size:32px' }); const label = h('b');
  const isToday = !sess.session_date || sess.session_date === today();
  const upd = () => {
    if (count.value === '' || theo === null || !isToday) { circle.textContent = '?'; circle.style.background = 'var(--s3)'; diffTxt.textContent = ''; label.textContent = ''; return; }
    const d = Math.round((Number(count.value) - theo) * 100) / 100;
    const color = d === 0 ? 'var(--inc)' : d < 0 ? 'var(--exp)' : 'var(--trf)';
    circle.textContent = d === 0 ? '✓' : '!'; circle.style.background = d === 0 ? '#16A34A' : d < 0 ? '#E11D48' : '#D97706';
    diffTxt.textContent = `${money(d, true)} ${t('currency')}`; diffTxt.style.color = color;
    label.textContent = d === 0 ? t('matched') : d < 0 ? t('deficit') : t('surplus'); label.style.color = color;
    reasonField.classList.toggle('hidden', d === 0);
  };
  count.addEventListener('input', upd); upd();
  const doClose = async () => {
    try {
      await post(`/cash/sessions/${sess.session_id}/close`, { physical: count.value, reason: reason.value.trim() || null });
      toast(t('saved'), 'ok'); refreshBell(); reload();
    } catch (e) { toast(errMsg(e), 'err'); }
  };
  return h('div', { class: 'card grid g2', style: 'align-items:start' },
    h('div', { class: 'col' }, h('h2', { style: 'margin:0' }, `${t('close_session')} — ${fmtDate(sess.session_date)}`),
      field(`${t('counted')} (${t('currency')})`, count), reasonField,
      h('div', { class: 'row' }, h('button', { class: 'btn pri', onclick: () => {
        if (count.value === '') { toast(t('counted'), 'err'); return; }
        modal({ title: t('close_session'), body: h('div', { class: 'col' }, h('span', null, `${t('counted')} : ${money(count.value)} ${t('currency')}`), label.cloneNode(true)),
          submitText: t('confirm'), onSubmit: async (close) => { close(); await doClose(); } });
      } }, icon('lock'), t('close_session')),
        theo !== null && isToday ? h('button', { class: 'btn', onclick: () => { count.value = String(theo); upd(); } }, t('exact')) : null),
      h('span', { class: 'muted small' }, me().user.role === 'admin' ? '' : t('close_hint_emp'))),
    h('div', { class: 'diff-box' }, circle, h('span', { class: 'muted' }, t('difference')), diffTxt, label));
}
