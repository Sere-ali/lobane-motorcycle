/* Lobane Motorcycle – service worker : démarrage instantané + page hors connexion */
const V = 'lobane-v1', STATIC = `${V}-static`, PAGES = `${V}-pages`;
self.addEventListener('install', (e) => { e.waitUntil(caches.open(STATIC).then((c) => c.addAll(['/offline.html', '/img/icon-192.png'])).then(() => self.skipWaiting())); });
self.addEventListener('activate', (e) => { e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => !k.startsWith(V)).map((k) => caches.delete(k)))).then(() => self.clients.claim())); });
const PRIVATE = /^\/(admin|super|connexion|inscription|deconnexion|healthz)/;
self.addEventListener('fetch', (e) => {
  const r = e.request, u = new URL(r.url);
  if (r.method !== 'GET' || u.origin !== location.origin || PRIVATE.test(u.pathname)) return;
  if (r.mode === 'navigate') { // pages : réseau d'abord, copie récente ou page hors connexion en secours
    e.respondWith(fetch(r).then((res) => { if (res.ok && !r.headers.get('cookie')) { const c = res.clone(); caches.open(PAGES).then((p) => p.put(r, c)); } return res; })
      .catch(() => caches.match(r).then((m) => m || caches.match('/offline.html'))));
    return;
  }
  if (/^\/(img|t|uploads)\//.test(u.pathname) || /\.(css|js|webp|png|jpg|woff2?)$/.test(u.pathname)) { // fichiers : cache d'abord
    e.respondWith(caches.match(r).then((m) => m || fetch(r).then((res) => { if (res.ok) { const c = res.clone(); caches.open(STATIC).then((p) => p.put(r, c)); } return res; })));
  }
});
