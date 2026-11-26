// Noyau de l'interface : construction DOM sûre, API, formats, fenêtres, graphiques, état de session.
import { getLang, t, tk } from './i18n.js';

// ------------------------------------------------------------------ DOM
type Child = Node | string | number | null | undefined | false | Child[];
type Props = Record<string, unknown> & { class?: string; style?: string };

/** Crée un élément. Le texte est toujours inséré comme texte (jamais d'HTML) : pas d'injection possible. */
export function h<K extends keyof HTMLElementTagNameMap>(tag: K, props: Props | null = null, ...children: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (props) {
    for (const [k, v] of Object.entries(props)) {
      if (v === undefined || v === null || v === false) continue;
      if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v as EventListener);
      else if (k === 'class') el.className = String(v);
      else if (k === 'style') el.setAttribute('style', String(v));
      else if (k === 'value' && 'value' in el) (el as HTMLInputElement).value = String(v);
      else if (k === 'checked') (el as HTMLInputElement).checked = Boolean(v);
      else if (v === true) el.setAttribute(k, '');
      else el.setAttribute(k, String(v));
    }
  }
  append(el, children);
  return el;
}
function append(el: Node, children: Child[]) {
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    if (Array.isArray(c)) append(el, c);
    else el.appendChild(c instanceof Node ? c : document.createTextNode(String(c)));
  }
}
export function clear(el: Element) { while (el.firstChild) el.removeChild(el.firstChild); return el; }

// Icônes (chaînes constantes du code, jamais de données utilisateur)
const P: Record<string, string> = {
  dashboard: '<rect x="3" y="3" width="7" height="9" rx="1.5"/><rect x="14" y="3" width="7" height="5" rx="1.5"/><rect x="14" y="12" width="7" height="9" rx="1.5"/><rect x="3" y="16" width="7" height="5" rx="1.5"/>',
  business: '<path d="M3 21h18"/><path d="M5 21V8l7-5 7 5v13"/><path d="M9 21v-6h6v6"/>',
  transactions: '<path d="M7 4v16"/><path d="M3 8l4-4 4 4"/><path d="M17 20V4"/><path d="M21 16l-4 4-4-4"/>',
  transfer: '<path d="M4 8h14"/><path d="M14 4l4 4-4 4"/><path d="M20 16H6"/><path d="M10 12l-4 4 4 4"/>',
  wallet: '<rect x="2" y="6" width="20" height="14" rx="2.5"/><path d="M16 13h2"/><path d="M2 10h20"/><path d="M6 6V4h12v2"/>',
  cheque: '<rect x="2" y="6" width="20" height="12" rx="2"/><path d="M6 14h6"/><path d="M15 10h3"/>',
  payroll: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20c.8-3.5 3.4-5.5 6.5-5.5s5.7 2 6.5 5.5"/><path d="M17 8h5"/><path d="M19.5 5.5v5"/>',
  reports: '<path d="M4 20V10"/><path d="M10 20V4"/><path d="M16 20v-7"/><path d="M22 20H2"/>',
  users: '<path d="M12 3l8 3v6c0 4.5-3.4 8-8 9-4.6-1-8-4.5-8-9V6z"/><path d="M9 12l2 2 4-4"/>',
  audit: '<path d="M4 6h16"/><path d="M4 12h16"/><path d="M4 18h10"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M4.2 4.2l2.1 2.1M17.7 17.7l2.1 2.1M2 12h3M19 12h3M4.2 19.8l2.1-2.1M17.7 6.3l2.1-2.1"/>',
  plus: '<path d="M12 5v14"/><path d="M5 12h14"/>', search: '<circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/>',
  bell: '<path d="M6 8a6 6 0 1 1 12 0c0 7 3 8 3 8H3s3-1 3-8"/><path d="M10 20a2 2 0 0 0 4 0"/>',
  up: '<path d="M3 17l6-6 4 4 8-8"/><path d="M15 7h6v6"/>', down: '<path d="M3 7l6 6 4-4 8 8"/><path d="M15 17h6v-6"/>',
  cart: '<path d="M3 4h2l2.4 11.2a2 2 0 0 0 2 1.6h7.7a2 2 0 0 0 2-1.5L21 8H6"/><circle cx="10" cy="20" r="1.3"/><circle cx="17" cy="20" r="1.3"/>',
  eye: '<path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
  eyeoff: '<path d="M3 3l18 18"/><path d="M10.6 5.1A10.7 10.7 0 0 1 12 5c6.4 0 10 7 10 7a17 17 0 0 1-3.2 4.1M6.6 6.6A17.4 17.4 0 0 0 2 12s3.6 7 10 7a9.9 9.9 0 0 0 5.4-1.6"/><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2"/>',
  device: '<rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8M12 16v4"/>',
  upload: '<path d="M12 16V4M6 10l6-6 6 6"/><path d="M4 20h16"/>',
  pen: '<path d="M4 20h4L19 9l-4-4L4 16z"/>', x: '<path d="M6 6l12 12"/><path d="M18 6L6 18"/>',
  logout: '<path d="M15 4h4v16h-4"/><path d="M10 8l-4 4 4 4"/><path d="M6 12h10"/>', menu: '<path d="M4 6h16M4 12h16M4 18h16"/>',
  moon: '<path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/>', download: '<path d="M12 4v11"/><path d="M7 10l5 5 5-5"/><path d="M5 20h14"/>',
  clip: '<path d="M21 11l-8.5 8.5a5 5 0 0 1-7-7L14 4a3.5 3.5 0 0 1 5 5l-8.5 8.5a2 2 0 0 1-3-3L15 7"/>', check: '<path d="M5 12l5 5 9-10"/>',
  calendar: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18"/><path d="M8 3v4"/><path d="M16 3v4"/>',
  refresh: '<path d="M20 11a8 8 0 1 0-2.3 5.7"/><path d="M20 4v7h-7"/>', lock: '<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>',
  back: '<path d="M5 12h14"/><path d="M13 6l6 6-6 6"/>',
  offline: '<path d="M3 3l18 18"/><path d="M8.5 16.4a5 5 0 0 1 7 0"/><path d="M5 12.9a10 10 0 0 1 5.2-2.7"/><path d="M19 12.9a10 10 0 0 0-2.2-1.5"/><path d="M2 8.8a15 15 0 0 1 4.2-2.6"/><path d="M22 8.8A15 15 0 0 0 10.5 5"/><path d="M12 20h.01"/>',
  tag: '<path d="M3 12V4a1 1 0 0 1 1-1h8l9 9-9 9z"/><circle cx="7.5" cy="7.5" r="1.5"/>',
  print: '<path d="M6 9V3h12v6"/><rect x="3" y="9" width="18" height="8" rx="2"/><path d="M7 14h10v7H7z"/>',
};
export function icon(name: keyof typeof P | string, size = 19): SVGSVGElement {
  const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  s.setAttribute('viewBox', '0 0 24 24'); s.setAttribute('width', String(size)); s.setAttribute('height', String(size));
  s.setAttribute('fill', 'none'); s.setAttribute('stroke', 'currentColor'); s.setAttribute('stroke-width', '1.8');
  s.setAttribute('stroke-linecap', 'round'); s.setAttribute('stroke-linejoin', 'round'); s.setAttribute('aria-hidden', 'true');
  s.innerHTML = P[name] ?? '';
  return s;
}
export function gfLogo(size = 44): SVGSVGElement {
  const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  s.setAttribute('viewBox', '0 0 44 44'); s.setAttribute('width', String(size)); s.setAttribute('height', String(size));
  s.setAttribute('role', 'img'); s.setAttribute('aria-label', 'CashPro');
  s.innerHTML = '<rect width="44" height="44" rx="12" fill="#fff"/><g transform="rotate(45 22 22)"><rect x="10" y="10" width="24" height="24" rx="4" fill="#1F2A7A"/><path d="M14 10H34V30Z" fill="#E30613"/></g><circle cx="22" cy="22" r="5.5" fill="none" stroke="#fff" stroke-width="2"/><circle cx="22" cy="22" r="2" fill="#fff"/>';
  return s;
}

// ------------------------------------------------------------------ formats
const nf = () => new Intl.NumberFormat(getLang() === 'en' ? 'en-US' : 'fr-FR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
export function money(v: unknown, sign = false): string {
  const n = Number(v ?? 0);
  const s = nf().format(Math.abs(n)).replace(/ | /g, ' ');
  // isolé en LTR (U+2066…U+2069) : l'ordre des groupes de chiffres reste correct dans un texte arabe
  return '\u2066' + (n < 0 ? '−' : sign && n > 0 ? '+' : '') + s + '\u2069';
}
export function moneyEl(v: unknown, opts: { sign?: boolean; cls?: string } = {}) {
  return h('span', { class: opts.cls ?? '' }, h('span', { class: 'num' }, money(v, opts.sign)), ' ', t('currency'));
}
export function fmtDate(v: string | Date | null | undefined, withTime = false): string {
  if (!v) return '—';
  const d = typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) ? new Date(v + 'T12:00:00') : new Date(v);
  return new Intl.DateTimeFormat(getLang() === 'en' ? 'en-GB' : 'fr-FR', {
    timeZone: 'Africa/Algiers', day: '2-digit', month: '2-digit', year: 'numeric', ...(withTime ? { hour: '2-digit', minute: '2-digit', hour12: false } : {}),
  }).format(d);
}
export function today(offsetDays = 0): string {
  const d = new Date(Date.now() + offsetDays * 86400000);
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Algiers' }).format(d);
}
export const monthStart = (d = today()) => d.slice(0, 8) + '01';
export const typeLabel = (tp: string) => tk('t_' + tp);

// ---- 1.2.0 : types d'opération personnalisés (créés par l'administrateur)
export interface OpType { id: string; name: string; direction: number; dir: 'in' | 'out'; base_type: 'income' | 'expense'; color: string | null; is_active: boolean; used: number }
let OP_TYPES: OpType[] = [];
export async function loadOpTypes(): Promise<OpType[]> {
  try { OP_TYPES = await get<OpType[]>('/op-types', { all: true }); } catch { OP_TYPES = []; }
  return OP_TYPES;
}
export const opTypes = (activeOnly = true) => OP_TYPES.filter((o) => !activeOnly || o.is_active);
export const opTypeById = (id?: string | null) => OP_TYPES.find((o) => o.id === id);
/** Nom affiché d'une opération : le type personnalisé s'il existe, sinon le type de base. */
export const opLabel = (r: { transaction_type: string; op_type_name?: string | null }) => r.op_type_name || typeLabel(r.transaction_type);
/** Pastille de type (couleur du type personnalisé si présent). */
export function opPill(r: { transaction_type: string; op_type_name?: string | null; op_type_color?: string | null }) {
  return h('span', { class: `pill c-${r.op_type_name ? (r.transaction_type === 'income' ? 'income' : 'expense') : r.transaction_type}`,
    style: r.op_type_name && r.op_type_color ? `color:${r.op_type_color};border-color:${r.op_type_color}` : '' }, opLabel(r));
}
export const kindLabel = (k: string) => tk('k_' + k);
export function pct(v: number | null | undefined) {
  if (v === null || v === undefined) return null;
  return h('span', { class: v >= 0 ? 'up small' : 'down small' }, v >= 0 ? '↗ ' : '↘ ', h('span', { class: 'num' }, `${v > 0 ? '+' : ''}${v}%`));
}

// ------------------------------------------------------------------ API
export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string, public details?: unknown) { super(message); }
}
export const session = {
  token: localStorage.getItem('cp.token') ?? '',
  me: null as null | Me,
};
export interface Biz { id: string; code: string; name: string; activity: string | null; color: string | null; logo_path: string | null; profile: string; permissions: Record<string, boolean>; allowed_accounts: string[] | null; max_amount: string | null }
export interface Me { user: { id: string; username: string; full_name: string; role: 'admin' | 'user'; locale: 'ar' | 'fr' | 'en'; theme: string }; businesses: Biz[]; settings: Record<string, unknown> }

export function setToken(tok: string) { session.token = tok; if (tok) localStorage.setItem('cp.token', tok); else localStorage.removeItem('cp.token'); }

// ------------------------------------------------------------------ « تذكّرني » (appareil mémorisé)
// Application Windows : jeton chiffré par Windows (DPAPI) ; navigateur : stockage local du navigateur.
// Le mot de passe n'est jamais conservé.
export const desktop = (): any => (window as any).cashproDesktop ?? null;
const CLIENT_NAME = () => (navigator.userAgent.includes('Electron') ? 'CashPro Desktop' : 'CashPro Web');
async function secureStore(): Promise<boolean> {
  const d = desktop();
  try { return Boolean(d?.getSecret && d?.setSecret && (await d.secretAvailable())); } catch { return false; }
}
export async function getRefresh(): Promise<string> {
  if (await secureStore()) { try { return String((await desktop().getSecret('refresh')) || ''); } catch { return ''; } }
  try { return localStorage.getItem('cp.refresh') ?? ''; } catch { return ''; }
}
export async function setRefresh(v: string | null | undefined) {
  if (await secureStore()) {
    try { await desktop().setSecret('refresh', v || ''); localStorage.removeItem('cp.refresh'); return; } catch { /* repli */ }
  }
  try { if (v) localStorage.setItem('cp.refresh', v); else localStorage.removeItem('cp.refresh'); } catch { /* stockage indisponible */ }
}
export async function deviceName(): Promise<string> {
  const d = desktop();
  try { if (d?.setupInfo) { const i = await d.setupInfo(); if (i?.device) return `Windows — ${String(i.device).replace(/^cashpro-/, '')}`; } } catch { /* */ }
  const ua = navigator.userAgent;
  return /Android/i.test(ua) ? 'Android' : /iPhone|iPad/i.test(ua) ? 'iOS' : /Windows/i.test(ua) ? 'Windows (navigateur)' : 'Navigateur';
}
let refreshing: Promise<boolean> | null = null;
/** Renouvelle la session avec l'appareil mémorisé (une seule requête à la fois). */
export function tryRefresh(): Promise<boolean> {
  if (!refreshing) {
    refreshing = (async () => {
      const rt = await getRefresh();
      if (!rt) return false;
      try {
        const r = await fetch('/api/auth/refresh', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CashPro-Client': CLIENT_NAME() }, body: JSON.stringify({ refreshToken: rt }) });
        if (r.status === 401 || r.status === 400) { await setRefresh(''); return false; }
        if (!r.ok) return false;
        const d = await r.json();
        setToken(d.token); await setRefresh(d.refreshToken);
        return true;
      } catch { return false; }
    })();
    void refreshing.finally(() => { refreshing = null; });
  }
  return refreshing!;
}

// ------------------------------------------------------------------ 1.3.6 : état de la connexion + copie locale (hors connexion)
export const net = { online: true };
const netListeners = new Set<(online: boolean) => void>();
export function onNet(fn: (online: boolean) => void) { netListeners.add(fn); return () => netListeners.delete(fn); }
export function setOnline(v: boolean) {
  if (net.online === v) return;
  net.online = v;
  netListeners.forEach((fn) => { try { fn(v); } catch { /* */ } });
}
/** UUID v4 (crypto.randomUUID n'existe pas hors HTTPS : http://192.168.x.x) — clé d'envoi unique. */
export function uuid(): string {
  const b = new Uint8Array(16); crypto.getRandomValues(b);
  b[6] = (b[6] & 0x0f) | 0x40; b[8] = (b[8] & 0x3f) | 0x80;
  const x = Array.from(b, (v) => v.toString(16).padStart(2, '0')).join('');
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20)}`;
}
// Lectures gardées pour l'affichage hors connexion : session, activités, comptes, catégories, fournisseurs, tableau de bord.
const CACHE_RE = /^\/(auth\/me|op-types|payment-methods|dashboard|businesses(\/[0-9a-f-]{36}\/(accounts|categories|suppliers))?)(\?|$)/;
const CACHE_PREFIX = 'cp.cache:';
function cacheGet(path: string): unknown {
  try { const v = localStorage.getItem(CACHE_PREFIX + path); return v ? JSON.parse(v) : undefined; } catch { return undefined; }
}
function cachePut(path: string, data: unknown) {
  try { localStorage.setItem(CACHE_PREFIX + path, JSON.stringify(data)); } catch { /* stockage plein : sans copie locale */ }
}
/** Efface la copie locale (déconnexion, autre utilisateur). La file d'envoi n'est pas touchée. */
export function clearReadCache() {
  try { Object.keys(localStorage).filter((k) => k.startsWith(CACHE_PREFIX)).forEach((k) => localStorage.removeItem(k)); } catch { /* */ }
}
export const isNetworkError = (e: unknown) => e instanceof ApiError && e.code === 'NETWORK';

export async function api<T = any>(method: string, path: string, body?: unknown, retried = false, extra: { idempotencyKey?: string; timeoutMs?: number } = {}): Promise<T> {
  const headers: Record<string, string> = { 'X-CashPro-Client': CLIENT_NAME() };
  if (session.token) headers.Authorization = `Bearer ${session.token}`;
  if (extra.idempotencyKey) headers['Idempotency-Key'] = extra.idempotencyKey;
  let payload: BodyInit | undefined;
  if (body instanceof FormData) payload = body;
  else if (body !== undefined) { headers['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
  const cacheable = method === 'GET' && CACHE_RE.test(path);
  // hors connexion connu : la copie locale tout de suite (la vérification périodique détecte le retour du serveur)
  if (cacheable && !net.online) { const c = cacheGet(path); if (c !== undefined) return c as T; }
  // délai maximal : sans réponse, l'appareil passe hors connexion au lieu d'attendre indéfiniment
  // déjà hors connexion (Tailscale arrêté…) : délais courts, la copie locale s'affiche sans attendre
  const timeoutMs = extra.timeoutMs ?? (body instanceof FormData ? 0 : method === 'GET' ? (net.online ? 25_000 : 4_000) : (net.online ? 15_000 : 6_000));
  const ctl = timeoutMs && typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timer = ctl ? setTimeout(() => ctl.abort(), timeoutMs) : 0;
  let r: Response;
  try { r = await fetch('/api' + path, { method, headers, body: payload, cache: 'no-store', signal: ctl?.signal }); } catch {
    setOnline(false);
    if (cacheable) { const c = cacheGet(path); if (c !== undefined) return c as T; }
    throw new ApiError(0, 'NETWORK', t('server_unreachable'));
  } finally { if (timer) clearTimeout(timer); }
  setOnline(true);
  const ct = r.headers.get('content-type') ?? '';
  const data = ct.includes('json') ? await r.json() : await r.blob();
  if (!r.ok) {
    const e = (data as any)?.error ?? {};
    if (r.status === 401 && !path.startsWith('/auth/login') && !path.startsWith('/auth/refresh') && path !== '/auth/change-password') {
      if (!retried && (e.code === 'TOKEN_INVALID' || e.code === 'UNAUTHENTICATED') && (await tryRefresh())) return api<T>(method, path, body, true, extra);
      setToken(''); location.hash = '#/login';
    }
    throw new ApiError(r.status, e.code ?? 'ERROR', e.message ?? r.statusText, e.details);
  }
  if (cacheable) cachePut(path, data);
  return data as T;
}
export const get = <T = any>(p: string, q?: Record<string, unknown>) => api<T>('GET', p + qs(q));
export const post = <T = any>(p: string, b?: unknown, idempotencyKey?: string) => api<T>('POST', p, b ?? {}, false, { idempotencyKey });
export function qs(q?: Record<string, unknown>) {
  if (!q) return '';
  const u = new URLSearchParams();
  for (const [k, v] of Object.entries(q)) {
    if (v === undefined || v === null || v === '') continue;
    if (Array.isArray(v)) v.forEach((x) => u.append(k, String(x))); else u.append(k, String(v));
  }
  const s = u.toString();
  return s ? '?' + s : '';
}
export async function download(path: string, fallbackName: string) {
  const r = await fetch('/api' + path, { headers: { Authorization: `Bearer ${session.token}` } });
  if (!r.ok) { const e = await r.json().catch(() => ({})); throw new ApiError(r.status, e?.error?.code ?? 'ERROR', e?.error?.message ?? r.statusText); }
  const blob = await r.blob();
  const cd = r.headers.get('content-disposition') ?? '';
  const m = /filename\*=UTF-8''([^;]+)|filename="([^"]+)"/.exec(cd);
  const name = m ? decodeURIComponent(m[1] ?? m[2]) : fallbackName;
  // Application Android : la WebView ne sait pas télécharger un blob → enregistrement par l'application
  const android = (window as any).cashproAndroid;
  if (android?.saveFile) {
    const b64 = await new Promise<string>((res, rej) => {
      const fr = new FileReader();
      fr.onload = () => res(String(fr.result).replace(/^data:[^,]*,/, ''));
      fr.onerror = () => rej(fr.error); fr.readAsDataURL(blob);
    });
    android.saveFile(name, blob.type || 'application/octet-stream', b64);
    return;
  }
  const a = h('a', { href: URL.createObjectURL(blob), download: name });
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}
/** Image protégée (logo) : chargée avec le jeton puis affichée via une URL blob. */
const imgCache = new Map<string, string>();
export function authImg(path: string, alt: string, fallback: () => Node): HTMLElement {
  const box = h('span', { style: 'display:contents' }, fallback());
  const show = (url: string) => { clear(box); box.appendChild(h('img', { src: url, alt })); };
  if (imgCache.has(path)) { show(imgCache.get(path)!); return box; }
  fetch('/api' + path, { headers: { Authorization: `Bearer ${session.token}` } })
    .then((r) => (r.ok ? r.blob() : null)).then((b) => { if (b) { const u = URL.createObjectURL(b); imgCache.set(path, u); show(u); } }).catch(() => undefined);
  return box;
}
export function dropImgCache() { imgCache.clear(); }

export const me = () => session.me!;
export const isAdmin = () => session.me?.user.role === 'admin';
export const bizById = (id: string) => session.me?.businesses.find((b) => b.id === id);
export const can = (perm: string, bizId?: string) =>
  isAdmin() || (bizId ? Boolean(bizById(bizId)?.permissions?.[perm]) : Boolean(session.me?.businesses.some((b) => b.permissions?.[perm])));
export const bizWith = (perm: string) => (session.me?.businesses ?? []).filter((b) => isAdmin() || b.permissions?.[perm]);

// ------------------------------------------------------------------ retours visuels
let lastToastAt = 0;
export function toast(msg: string, kind: 'ok' | 'err' | '' = '') {
  lastToastAt = Date.now();
  let box = document.querySelector('.toasts');
  if (!box) { box = h('div', { class: 'toasts', role: 'status', 'aria-live': 'polite' }); document.body.appendChild(box); }
  const el = h('div', { class: `toast ${kind}` }, msg);
  box.appendChild(el);
  setTimeout(() => el.remove(), kind === 'err' ? 6000 : 3000);
}
export function errMsg(e: unknown): string {
  if (e instanceof ApiError) {
    const det = Array.isArray(e.details) ? ' — ' + (e.details as { field: string; message: string }[]).map((d) => `${d.field}: ${d.message}`).join(' · ') : '';
    return e.message + det;
  }
  return e instanceof Error ? e.message : String(e);
}
export const spinner = () => h('div', { class: 'spin', role: 'progressbar', 'aria-label': t('loading') });
export const empty = (msg = t('none')) => h('div', { class: 'empty' }, msg);

export interface ModalOpts {
  title: string; body: Node | Node[]; wide?: boolean; submitText?: string; danger?: boolean;
  onSubmit?: (close: () => void, errBox: HTMLElement) => Promise<void> | void; noFooter?: boolean;
  /** pas de message « تمّ الحفظ » automatique après l'envoi */
  quiet?: boolean;
}

/** Petite fenêtre de confirmation (Oui / Non), utilisable partout (Windows, navigateur, Android). */
export function confirmBox(message: string, opts: { yes?: string; no?: string; danger?: boolean } = {}): Promise<boolean> {
  return new Promise((resolve) => {
    const back = h('div', { class: 'modal-back confirm-back' });
    const done = (v: boolean) => { back.remove(); document.removeEventListener('keydown', key, true); resolve(v); };
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); done(false); } };
    const yes = h('button', { type: 'button', class: opts.danger ? 'btn danger' : 'btn pri', onclick: () => done(true) }, opts.yes ?? t('confirm'));
    back.appendChild(h('div', { class: 'modal confirm', role: 'alertdialog', 'aria-modal': 'true' },
      h('div', { class: 'body' }, h('p', { style: 'margin:0;font-size:15px;line-height:1.6' }, message)),
      h('footer', null, h('button', { type: 'button', class: 'btn', onclick: () => done(false) }, opts.no ?? t('cancel')), yes)));
    document.body.appendChild(back);
    document.addEventListener('keydown', key, true);
    setTimeout(() => yes.focus(), 30);
  });
}

// Bouton « retour » du téléphone / du navigateur : ferme d'abord la fenêtre ouverte
const openModals: { id: number; tryClose: () => void }[] = [];
let modalSeq = 0;
window.addEventListener('popstate', () => {
  const top = openModals[openModals.length - 1];
  if (top && history.state?.cpModal !== top.id) top.tryClose();
});

export function modal(o: ModalOpts): () => void {
  const errBox = h('div', { class: 'err-box hidden', role: 'alert' });
  const back = h('div', { class: 'modal-back' });
  const id = ++modalSeq;
  let open = true; let dirty = false; let asking = false;
  const close = () => {
    if (!open) return;
    open = false;
    back.remove(); document.removeEventListener('keydown', esc);
    const i = openModals.findIndex((m) => m.id === id); if (i >= 0) openModals.splice(i, 1);
    if (history.state?.cpModal === id) history.back();
  };
  // fermeture demandée par l'utilisateur : confirmation si des modifications ne sont pas enregistrées
  const tryClose = async () => {
    if (!open || asking) return;
    if (dirty && o.onSubmit) {
      asking = true;
      const leave = await confirmBox(t('unsaved_leave'), { yes: t('leave_without_saving'), no: t('stay'), danger: true });
      asking = false;
      if (!leave) { if (history.state?.cpModal !== id) history.pushState({ cpModal: id }, ''); return; }
    }
    close();
  };
  const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') void tryClose(); };
  const submit = o.onSubmit ? h('button', { class: o.danger ? 'btn danger' : 'btn pri', type: 'submit' }, o.submitText ?? t('save')) : null;
  const form = h('form', { class: `modal ${o.wide ? 'wide' : ''}`, role: 'dialog', 'aria-modal': 'true', 'aria-label': o.title, novalidate: true },
    h('header', null,
      h('button', { type: 'button', class: 'btn ghost icon-btn modal-backbtn', 'aria-label': t('back'), title: t('back'), onclick: () => void tryClose() }, icon('back')),
      h('h2', null, o.title), h('button', { type: 'button', class: 'btn ghost icon-btn', 'aria-label': t('close'), onclick: () => void tryClose() }, icon('x'))),
    h('div', { class: 'body' }, errBox, o.body),
    o.noFooter ? null : h('footer', null, h('button', { type: 'button', class: 'btn', onclick: () => void tryClose() }, o.onSubmit ? t('cancel') : t('close')), submit));
  // seules les saisies de l'utilisateur comptent (les remplissages automatiques ne déclenchent pas ces événements)
  form.addEventListener('input', () => { dirty = true; });
  form.addEventListener('change', (e) => { if (e.isTrusted) dirty = true; });
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!o.onSubmit || !submit) return;
    errBox.classList.add('hidden');
    submit.disabled = true;
    const before = Date.now();
    try {
      await o.onSubmit(() => { dirty = false; close(); }, errBox);
      if (!open && !o.quiet && lastToastAt < before) toast(t('saved'), 'ok');   // confirmation d'enregistrement
    } catch (err) { errBox.textContent = errMsg(err); errBox.classList.remove('hidden'); errBox.scrollIntoView({ block: 'nearest' }); }
    finally { submit.disabled = false; }
  });
  back.addEventListener('mousedown', (e) => { if (e.target === back) void tryClose(); });
  back.appendChild(form);
  document.body.appendChild(back);
  document.addEventListener('keydown', esc);
  openModals.push({ id, tryClose: () => void tryClose() });
  history.pushState({ cpModal: id }, '');
  setTimeout(() => (form.querySelector('input:not([type=hidden]),select,textarea') as HTMLElement | null)?.focus(), 30);
  return close;
}
/** Demande un motif obligatoire puis exécute l'action. */
export function askReason(title: string, action: (reason: string) => Promise<void>, danger = true) {
  const ta = h('textarea', { class: 'input', required: true, minlength: '3', name: 'reason' });
  modal({ title, danger, submitText: t('confirm'), body: field(t('reason_required'), ta),
    onSubmit: async (close) => { if (ta.value.trim().length < 3) throw new Error(t('reason_required')); await action(ta.value.trim()); close(); } });
}

// ------------------------------------------------------------------ formulaires
export function field(label: string, control: HTMLElement, cls = '') {
  return h('label', { class: `f ${cls}` }, label, control);
}
export function input(name: string, opts: Record<string, unknown> = {}) { return h('input', { class: 'input', name, ...opts }); }

/** Champ mot de passe avec bouton 👁 (afficher / masquer) et alerte « Verr. Maj ». Se remasque après 10 s ou à l'envoi. */
export function withEye(inp: HTMLInputElement): HTMLElement {
  const btn = h('button', { type: 'button', class: 'pw-eye', 'aria-pressed': 'false' });
  const caps = h('div', { class: 'pw-caps hidden', role: 'status' }, icon('lock', 14), t('caps_on'));
  let timer = 0;
  const set = (show: boolean) => {
    inp.type = show ? 'text' : 'password';
    btn.replaceChildren(icon(show ? 'eyeoff' : 'eye', 18));
    btn.setAttribute('aria-pressed', String(show));
    btn.title = t(show ? 'hide_pw' : 'show_pw'); btn.setAttribute('aria-label', btn.title);
    window.clearTimeout(timer);
    if (show) timer = window.setTimeout(() => set(false), 10_000);
  };
  set(false);
  btn.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); set(inp.type === 'password'); inp.focus(); });
  const onKey = (e: KeyboardEvent) => { if (typeof e.getModifierState === 'function') caps.classList.toggle('hidden', !e.getModifierState('CapsLock')); };
  inp.addEventListener('keydown', onKey); inp.addEventListener('keyup', onKey);
  inp.addEventListener('blur', () => caps.classList.add('hidden'));
  const wrap = h('div', { class: 'pw-wrap' }, h('div', { class: 'pw-field', dir: 'ltr' }, inp, btn), caps);
  const onSubmit = () => { if (!wrap.isConnected) { window.removeEventListener('submit', onSubmit, true); return; } set(false); };
  window.addEventListener('submit', onSubmit, true);
  return wrap;
}
export function passwordInput(name: string, opts: Record<string, unknown> = {}) {
  const inp = input(name, { type: 'password', dir: 'ltr', autocapitalize: 'off', spellcheck: 'false', ...opts });
  return { input: inp, el: withEye(inp) };
}
export function select(name: string, options: { value: string; label: string }[], value?: string, opts: Record<string, unknown> = {}) {
  const s = h('select', { class: 'input', name, ...opts }, options.map((o) => h('option', { value: o.value }, o.label)));
  if (value !== undefined) s.value = value;
  return s;
}
export function formData(form: HTMLElement): Record<string, string> {
  const out: Record<string, string> = {};
  form.querySelectorAll<HTMLInputElement>('input[name],select[name],textarea[name]').forEach((el) => {
    if (el.type === 'checkbox') out[el.name] = el.checked ? '1' : '';
    else out[el.name] = el.value.trim();
  });
  return out;
}
export const nullIfEmpty = (v: string | undefined) => (v === undefined || v === '' ? null : v);
export const bizOptions = (list = session.me?.businesses ?? [], withAll = false) =>
  [...(withAll ? [{ value: '', label: t('all_businesses') }] : []), ...list.map((b) => ({ value: b.id, label: b.name }))];

// ------------------------------------------------------------------ graphiques SVG
const svgNS = 'http://www.w3.org/2000/svg';
function svg(tag: string, attrs: Record<string, string | number>, ...kids: SVGElement[]) {
  const e = document.createElementNS(svgNS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
  kids.forEach((k) => e.appendChild(k));
  return e;
}
const compact = (n: number) => (Math.abs(n) >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : Math.abs(n) >= 1e3 ? Math.round(n / 1e3) + 'k' : String(Math.round(n)));

export function lineChart(labels: string[], series: { values: number[]; color: string; fill?: boolean; name: string }[], height = 230) {
  const W = 700, H = height, L = 46, R = 10, T = 12, B = 26;
  const max = Math.max(1, ...series.flatMap((s) => s.values));
  const x = (i: number) => L + (i * (W - L - R)) / Math.max(1, labels.length - 1);
  const y = (v: number) => T + (H - T - B) * (1 - v / max);
  const root = svg('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': series.map((s) => s.name).join(', ') });
  for (let g = 0; g <= 4; g++) {
    const v = (max * g) / 4;
    root.appendChild(svg('line', { x1: L, x2: W - R, y1: y(v), y2: y(v), stroke: 'var(--line)' }));
    const tx = svg('text', { x: 4, y: y(v) + 4, fill: 'var(--mu)', 'font-size': 11 }); tx.textContent = compact(v); root.appendChild(tx);
  }
  const step = Math.max(1, Math.ceil(labels.length / 6));
  labels.forEach((lb, i) => { if (i % step === 0 || i === labels.length - 1) { const tx = svg('text', { x: x(i), y: H - 6, fill: 'var(--mu)', 'font-size': 11, 'text-anchor': 'middle' }); tx.textContent = lb; root.appendChild(tx); } });
  for (const s of series) {
    const d = s.values.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)} ${y(v).toFixed(1)}`).join(' ');
    if (s.fill) root.appendChild(svg('path', { d: `${d} L${x(s.values.length - 1)} ${y(0)} L${x(0)} ${y(0)} Z`, fill: s.color, opacity: .12 }));
    root.appendChild(svg('path', { d, fill: 'none', stroke: s.color, 'stroke-width': 2.5, 'stroke-linejoin': 'round' }));
    s.values.forEach((v, i) => { const c = svg('circle', { cx: x(i), cy: y(v), r: 3, fill: s.color, opacity: 0 }); const tt = svg('title', {}); tt.textContent = `${labels[i]} — ${s.name}: ${money(v)}`; c.appendChild(tt); c.addEventListener('mouseenter', () => c.setAttribute('opacity', '1')); c.addEventListener('mouseleave', () => c.setAttribute('opacity', '0')); root.appendChild(c); });
  }
  return h('div', { class: 'chart' }, root, h('div', { class: 'legend' }, series.map((s) => h('span', null, h('i', { style: `background:${s.color}` }), s.name))));
}

export function barChart(labels: string[], values: number[], color = 'var(--pur)', height = 220) {
  const W = 700, H = height, L = 50, B = 24, T = 10;
  const min = Math.min(0, ...values), max = Math.max(1, ...values);
  const lo = min < 0 ? min : Math.max(0, min - (max - min) * 0.3);
  const y = (v: number) => T + (H - T - B) * (1 - (v - lo) / Math.max(1, max - lo));
  const bw = (W - L - 10) / Math.max(1, values.length);
  const root = svg('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': 'bar chart' });
  for (let g = 0; g <= 3; g++) { const v = lo + ((max - lo) * g) / 3; root.appendChild(svg('line', { x1: L, x2: W - 10, y1: y(v), y2: y(v), stroke: 'var(--line)' })); const tx = svg('text', { x: 2, y: y(v) + 4, fill: 'var(--mu)', 'font-size': 11 }); tx.textContent = compact(v); root.appendChild(tx); }
  values.forEach((v, i) => {
    const r = svg('rect', { x: L + i * bw + bw * 0.18, y: y(Math.max(v, lo)), width: bw * 0.64, height: Math.max(2, y(lo) - y(Math.max(v, lo))), rx: 4, fill: i === values.length - 1 ? 'var(--br)' : color });
    const tt = svg('title', {}); tt.textContent = `${labels[i]}: ${money(v)}`; r.appendChild(tt); root.appendChild(r);
  });
  const step = Math.max(1, Math.ceil(labels.length / 7));
  labels.forEach((lb, i) => { if (i % step === 0) { const tx = svg('text', { x: L + i * bw + bw / 2, y: H - 6, fill: 'var(--mu)', 'font-size': 11, 'text-anchor': 'middle' }); tx.textContent = lb; root.appendChild(tx); } });
  return h('div', { class: 'chart' }, root);
}

export function donut(parts: { label: string; value: number; color: string }[]) {
  const total = parts.reduce((a, p) => a + p.value, 0);
  if (!total) return empty();
  const root = svg('svg', { viewBox: '0 0 42 42', width: 150, height: 150, role: 'img', 'aria-label': parts.map((p) => `${p.label} ${Math.round((p.value / total) * 100)}%`).join(', ') });
  root.appendChild(svg('circle', { cx: 21, cy: 21, r: 15.9, fill: 'none', stroke: 'var(--s2)', 'stroke-width': 5 }));
  let acc = 0;
  for (const p of parts) {
    const pc = (p.value / total) * 100;
    root.appendChild(svg('circle', { cx: 21, cy: 21, r: 15.9, fill: 'none', stroke: p.color, 'stroke-width': 5, 'stroke-dasharray': `${pc} ${100 - pc}`, 'stroke-dashoffset': 25 - acc }));
    acc += pc;
  }
  return h('div', { class: 'row', style: 'gap:20px;align-items:center' }, h('div', { class: 'chart', style: 'width:150px;flex:none' }, root),
    h('div', { class: 'col', style: 'flex:1;min-width:160px;gap:8px' }, parts.map((p) => h('div', { class: 'row', style: 'gap:8px' },
      h('span', { style: `width:10px;height:10px;border-radius:3px;background:${p.color}` }), p.label, h('span', { class: 'spacer' }),
      h('span', { class: 'num', style: 'font-weight:700' }, `${Math.round((p.value / total) * 100)}%`)))));
}
export const PALETTE = ['var(--pur)', 'var(--exp)', 'var(--trf)', 'var(--inc)', '#A78BFA', '#22D3EE', '#F472B6', 'var(--mu)'];
