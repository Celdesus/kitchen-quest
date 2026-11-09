// Kitchen Quest service worker: caches the app shell so the tablet opens instantly and offline.
// Data calls (Supabase: /rest/, /auth/, /functions/, or another origin) always go to the network; tick-offs made
// offline wait in the app's outbox (see app.js) and sync later.
const SHELL = 'kq-shell-v2';
const FILES = ['/', '/index.html', '/styles.css', '/app.js', '/kq-api.js', '/config.js', '/manifest.webmanifest', '/icons/icon.svg'];
self.addEventListener('install', e => e.waitUntil(caches.open(SHELL).then(c => c.addAll(FILES)).then(() => self.skipWaiting())));
self.addEventListener('activate', e => e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== SHELL).map(k => caches.delete(k))))
  .then(() => self.clients.claim())));
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin || /^\/(rest|auth|functions)\//.test(url.pathname)) return;
  e.respondWith(fetch(e.request).then(r => { const copy = r.clone(); caches.open(SHELL).then(c => c.put(e.request, copy)); return r; })
    .catch(() => caches.match(e.request).then(r => r || caches.match('/index.html'))));
});
self.addEventListener('push', e => {   // Web Push (iOS 16.4+ once added to the Home Screen; Android Chrome)
  const d = e.data ? e.data.json() : { title: 'Kitchen Quest', body: 'New memo' };
  e.waitUntil(self.registration.showNotification(d.title, { body: d.body, icon: '/icons/icon-192.png' }));
});
