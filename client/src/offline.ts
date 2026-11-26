// 1.3.6 — mode hors connexion (العمل دون اتصال).
// Quand le serveur est injoignable, les nouvelles opérations sont gardées sur l'appareil (file d'envoi),
// puis envoyées automatiquement au retour de la connexion. Chaque élément garde la clé unique générée
// au moment de la saisie (Idempotency-Key) : un renvoi ne crée jamais de doublon côté serveur.
import { api, ApiError, clear, confirmBox, errMsg, fmtDate, get, h, icon, isNetworkError, modal, money, net, onNet, opTypes, session, setOnline, toast, uuid } from './core.js';
import { t } from './i18n.js';

export interface OutItem {
  id: string;            // clé d'envoi (Idempotency-Key)
  userId: string;        // seul cet utilisateur peut l'envoyer
  path: string;          // '/transactions', '/transactions/split', '/transfers'
  body: Record<string, unknown>;
  label: string;         // résumé affiché (type, activité…)
  amount: string;
  createdAt: string;
  error?: string;        // refusée par le serveur (règle métier) : ne se renvoie plus seule
}

const append = (el: HTMLElement, kids: (Node | null)[]) => kids.forEach((k) => { if (k) el.appendChild(k); });
const KEY = 'cp.outbox';
function readAll(): OutItem[] {
  try { const v = JSON.parse(localStorage.getItem(KEY) ?? '[]'); return Array.isArray(v) ? v : []; } catch { return []; }
}
function writeAll(list: OutItem[]) {
  try { localStorage.setItem(KEY, JSON.stringify(list)); } catch { /* stockage plein */ }
  changed();
}
const uid = () => session.me?.user.id ?? '';
/** Éléments de l'utilisateur connecté. */
export const outbox = () => readAll().filter((x) => x.userId === uid());
export const pendingCount = () => outbox().filter((x) => !x.error).length;

const listeners = new Set<() => void>();
export function onOutbox(fn: () => void) { listeners.add(fn); return () => listeners.delete(fn); }
function changed() { listeners.forEach((fn) => { try { fn(); } catch { /* */ } }); }

/** Nouvelle clé d'envoi, à générer AVANT le premier essai (le même envoi peut être répété sans doublon). */
export const newSendKey = uuid;

/** Garde une opération sur l'appareil. La date de saisie est figée (sinon le serveur prendrait l'heure d'envoi). */
export function enqueue(key: string, path: string, body: Record<string, unknown>, label: string, amount: string) {
  if (!uid()) throw new Error(t('server_unreachable'));
  const list = readAll();
  if (list.some((x) => x.id === key)) return;
  list.push({ id: key, userId: uid(), path, body: { ...body, date: body.date ?? new Date().toISOString() }, label, amount, createdAt: new Date().toISOString() });
  writeAll(list);
  ensurePing();
}

/**
 * Envoi « avec repli » : essaie d'enregistrer tout de suite ; si le serveur est injoignable,
 * garde l'opération sur l'appareil. Retourne la réponse du serveur, ou null si l'opération a été gardée.
 */
export async function sendOrQueue<T = any>(path: string, body: Record<string, unknown>, label: string, amount: string): Promise<T | null> {
  const key = newSendKey();
  // déjà hors connexion avec des envois en attente : garder l'ordre de saisie
  if (!net.online && pendingCount()) { enqueue(key, path, body, label, amount); toast(t('off_saved'), 'ok'); return null; }
  try { return await api<T>('POST', path, body, false, { idempotencyKey: key }); } catch (e) {
    if (!isNetworkError(e)) throw e;
    enqueue(key, path, body, label, amount);
    toast(t('off_saved'), 'ok');
    return null;
  }
}

let flushing: Promise<number> | null = null;
/** Envoie la file dans l'ordre de saisie. S'arrête à la première coupure ; une règle métier refusée est marquée. */
export function flush(): Promise<number> {
  if (flushing) return flushing;
  flushing = (async () => {
    let sent = 0;
    const mine = outbox().filter((x) => !x.error).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    if (!mine.length) return 0;
    state.sending = true; changed();
    try {
      for (const it of mine) {
        try {
          await api('POST', it.path, it.body, false, { idempotencyKey: it.id });
          writeAll(readAll().filter((x) => x.id !== it.id));
          sent++;
        } catch (e) {
          if (isNetworkError(e)) break;                                        // toujours hors connexion
          if (e instanceof ApiError && (e.status === 401 || e.status >= 500 || e.status === 429)) break;   // réessayer plus tard
          writeAll(readAll().map((x) => (x.id === it.id ? { ...x, error: errMsg(e) } : x)));
        }
      }
    } finally { state.sending = false; changed(); }
    if (sent) { toast(`${t('off_sent')} (${sent})`, 'ok'); window.dispatchEvent(new Event('cp:changed')); }
    return sent;
  })();
  void flushing.finally(() => { flushing = null; });
  return flushing;
}

export function removeItem(id: string) { writeAll(readAll().filter((x) => x.id !== id)); }
export function retryItem(id: string) { writeAll(readAll().map((x) => (x.id === id ? { ...x, error: undefined } : x))); void flush(); }

// ------------------------------------------------------------------ surveillance de la connexion
const state = { sending: false };
let pingTimer = 0;
async function ping(): Promise<boolean> {
  const ctl = new AbortController(); const tm = setTimeout(() => ctl.abort(), 6000);
  try { const r = await fetch('/api/health', { cache: 'no-store', signal: ctl.signal }); return r.ok; } catch { return false; } finally { clearTimeout(tm); }
}
function ensurePing() {
  if (pingTimer) return;
  pingTimer = window.setInterval(async () => {
    if (net.online && !pendingCount()) { clearInterval(pingTimer); pingTimer = 0; return; }
    if (await ping()) { setOnline(true); if (pendingCount() && session.me) void flush(); }
    else setOnline(false);
  }, 10_000);
}
onNet((online) => {
  changed();
  if (online) { toast(t('off_back'), 'ok'); if (session.me) void flush(); }
  else ensurePing();
});
window.addEventListener('online', () => { void ping().then((ok) => { if (ok) setOnline(true); }); });
/** Au démarrage / après connexion : envoyer ce qui attend, et préparer la copie locale. */
export function startOutbox() {
  if (pendingCount()) { ensurePing(); if (net.online) void flush(); }
  if (net.online) setTimeout(() => void warmCache(), 3000);
}

// Copie locale des listes du formulaire « عملية جديدة » (comptes, catégories de chaque type, fournisseurs, moyens de paiement),
// pour pouvoir saisir hors connexion une opération même si ce formulaire n'a jamais été ouvert. Au plus toutes les 20 min.
let warmedAt = 0;
async function warmCache() {
  if (!session.me || !net.online || Date.now() - warmedAt < 20 * 60_000) return;
  warmedAt = Date.now();
  const queries: Record<string, unknown>[] = [...['income', 'expense', 'purchase', 'deposit', 'withdrawal'].map((type) => ({ type })), ...opTypes().map((o) => ({ opType: o.id }))];
  try {
    await get('/payment-methods');
    for (const b of session.me.businesses) {
      if (!net.online) return;
      await Promise.all([get(`/businesses/${b.id}/accounts`), get(`/businesses/${b.id}/suppliers`),
        ...queries.map((q) => get(`/businesses/${b.id}/categories`, q).catch(() => undefined))]);
    }
  } catch { warmedAt = 0; }
}

// ------------------------------------------------------------------ bandeau « غير متصل » + liste
export function offlineBanner(): HTMLElement {
  const bar = h('div', { class: 'off-banner hidden', role: 'status', 'aria-live': 'polite' });
  const render = () => {
    const all = outbox(); const pend = all.filter((x) => !x.error).length; const failed = all.length - pend;
    const show = !net.online || all.length > 0;
    bar.classList.toggle('hidden', !show);
    bar.classList.toggle('offline', !net.online);
    if (!show) return;
    clear(bar);
    append(bar, [
      icon(net.online ? 'upload' : 'offline', 18),
      h('span', { style: 'flex:1;min-width:0' },
        h('b', null, net.online ? (state.sending ? t('off_sending') : t('off_list')) : t('off_title')),
        pend ? h('span', { class: 'badge', style: 'margin-inline-start:8px' }, h('span', { class: 'num' }, String(pend)), ' ', t('off_pending')) : null,
        failed ? h('span', { class: 'badge red', style: 'margin-inline-start:8px' }, h('span', { class: 'num' }, String(failed)), ' ', t('off_failed')) : null,
        !net.online ? h('span', { class: 'muted small off-hint' }, t('off_hint')) : null),
      net.online && pend && !state.sending ? h('button', { type: 'button', class: 'btn pri sm', onclick: () => void flush() }, t('off_send_now')) : null,
      all.length ? h('button', { type: 'button', class: 'btn sm', onclick: openOutbox }, t('off_view')) : null]);
  };
  onOutbox(render);
  render();
  return bar;
}

export function openOutbox() {
  const body = h('div', { class: 'col', style: 'gap:10px' });
  const render = () => {
    const all = outbox().sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    clear(body);
    if (!net.online) body.append(h('div', { class: 'warn-box' }, `${t('off_title')} — ${t('off_hint')}`));
    if (all.some((x) => x.error)) body.append(h('div', { class: 'err-box' }, t('off_failed_hint')));
    if (!all.length) { body.append(h('div', { class: 'empty' }, t('none'))); return; }
    all.forEach((x) => body.appendChild( h('div', { class: `card off-item ${x.error ? 'bad' : ''}` },
      h('div', { class: 'row' },
        h('b', { style: 'flex:1;min-width:0' }, x.label),
        h('b', { class: 'num' }, money(x.amount)), ' ', t('currency')),
      h('div', { class: 'row muted small' }, icon('calendar', 14), fmtDate(String(x.body.date ?? x.createdAt), true),
        x.body.description ? h('span', null, ' · ', String(x.body.description)) : null),
      x.error ? h('div', { class: 'err-box small' }, x.error) : h('div', { class: 'muted small' }, t('off_pending')),
      h('div', { class: 'row', style: 'justify-content:flex-end;gap:8px' },
        x.error ? h('button', { type: 'button', class: 'btn sm', onclick: () => retryItem(x.id) }, icon('refresh', 15), t('off_retry')) : null,
        h('button', { type: 'button', class: 'btn danger sm', onclick: async () => { if (await confirmBox(t('off_delete_q'), { danger: true })) removeItem(x.id); } }, icon('x', 15), t('off_delete'))))));
  };
  const off = onOutbox(render);
  render();
  const close = modal({ title: t('off_list'), body, wide: true });
  // désabonnement quand la fenêtre se ferme
  const obs = new MutationObserver(() => { if (!body.isConnected) { off(); obs.disconnect(); } });
  obs.observe(document.body, { childList: true });
  return close;
}
