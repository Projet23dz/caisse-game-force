// CashPro 1.3.6 — copie de l'interface sur l'appareil (mode hors connexion).
// Seuls les fichiers de l'interface (HTML, JS, CSS, icônes) passent par ici ; les données (/api) jamais.
// Réseau d'abord : si le serveur répond, sa version est utilisée (et gardée) ; sinon, la copie gardée.
const VERSION = '__CASHPRO_UI_VERSION__';
const CACHE = 'cashpro-ui-' + VERSION;
const NET_TIMEOUT = 5000;

self.addEventListener('install', (e) => {
  self.skipWaiting();
  e.waitUntil((async () => {
    try {
      const m = await (await fetch('/offline-manifest.json', { cache: 'no-store' })).json();
      const c = await caches.open(CACHE);
      await Promise.all(['/', ...m.files].map(async (f) => {
        const r = await fetch(f, { cache: 'no-cache' });
        if (r.ok) await c.put(f, r);
      }));
    } catch (_) { /* copie complétée au fil des chargements */ }
  })());
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k.startsWith('cashpro-ui-') && k !== CACHE) await caches.delete(k);
    await self.clients.claim();
  })());
});

function withTimeout(p, ms) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('timeout')), ms);
    p.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
  });
}

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const u = new URL(req.url);
  if (u.origin !== self.location.origin || u.pathname.startsWith('/api/') || u.pathname === '/sw.js') return;
  const key = req.mode === 'navigate' || !/\.[a-z0-9]+$/i.test(u.pathname) ? '/' : u.pathname;
  e.respondWith((async () => {
    try {
      const r = await withTimeout(fetch(req), NET_TIMEOUT);
      if (r.ok) { const copy = r.clone(); caches.open(CACHE).then((c) => c.put(key, copy)).catch(() => {}); }
      return r;
    } catch (err) {
      const hit = await caches.match(key);
      if (hit) return hit;
      throw err;
    }
  })());
});
