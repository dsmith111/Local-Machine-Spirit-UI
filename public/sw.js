/* Cogitator service worker: caches the app shell so the PWA opens instantly
 * and offline. API traffic (/api/*) is never cached. */
const VERSION = 'cogitator-v6';
const SHELL = [
  './',
  'index.html',
  'styles.css',
  'markdown.js',
  'app.js',
  'manifest.webmanifest',
  'icons/icon.svg',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/apple-touch-icon.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // Never intercept the relay.
  if (url.origin === self.location.origin && url.pathname.startsWith('/api/')) return;

  // Google Fonts: cache-first once fetched.
  if (url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com') {
    event.respondWith(
      caches.open(VERSION).then(async (cache) => {
        const hit = await cache.match(req);
        if (hit) return hit;
        const res = await fetch(req);
        if (res.ok || res.type === 'opaque') cache.put(req, res.clone());
        return res;
      }),
    );
    return;
  }

  if (url.origin !== self.location.origin) return;

  // App shell: network-first (so updates land), falling back to cache offline.
  // cache: 'no-cache' makes the browser revalidate instead of using a stale HTTP copy.
  event.respondWith(
    // (A navigation Request can't be re-initialised with options, so fetch its URL.)
    fetch(req.mode === 'navigate' ? req.url : req, { cache: 'no-cache' })
      .then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(VERSION).then((c) => c.put(req, copy));
        }
        return res;
      })
      .catch(async () => (await caches.match(req, { ignoreSearch: true })) || (req.mode === 'navigate' ? caches.match('index.html') : Response.error())),
  );
});

// ---------------------------------------------------------------------------
// Summonings: push notifications from the cogitator server
// ---------------------------------------------------------------------------
self.addEventListener('push', (event) => {
  let msg = {};
  try {
    msg = event.data ? event.data.json() : {};
  } catch {
    msg = { title: 'Cogitator', body: event.data ? event.data.text() : '' };
  }
  const title = msg.title || 'Cogitator';
  const options = {
    body: msg.body || '',
    tag: msg.tag || 'cogitator',
    renotify: true,
    icon: 'icons/icon-192.png',
    badge: 'icons/icon-192.png',
    requireInteraction: msg.kind === 'sanction',
    data: { convId: msg.convId || null, kind: msg.kind || null },
  };
  event.waitUntil(
    Promise.all([
      self.registration.showNotification(title, options),
      // A dot on the app icon until the app is opened again.
      self.navigator && self.navigator.setAppBadge ? self.navigator.setAppBadge().catch(() => {}) : null,
    ]),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const convId = event.notification.data && event.notification.data.convId;
  const target = new URL(convId ? `./?c=${encodeURIComponent(convId)}` : './', self.registration.scope).href;
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(async (wins) => {
      const win = wins.find((w) => 'focus' in w);
      if (win) {
        await win.focus();
        if (convId) win.postMessage({ type: 'open-conversation', convId });
        return;
      }
      return self.clients.openWindow(target);
    }),
  );
});
