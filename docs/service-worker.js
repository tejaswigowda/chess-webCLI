/**
 * Service worker for chess-webCLI: installable, and opens offline.
 *
 * It caches only this site's own files. Games on this device then work with no network at all. A room
 * still needs the network (introductions go through public relays). It never handles other hosts, so the
 * relays, the model hosts and WebRTC traffic never pass through it. The model library (lib/web-llm.js,
 * about 6 MB) is not precached; it is cached the first time you load a model.
 *
 * Network first, cache as the fallback, so online you always get one consistent release (the page checks
 * the libraries in lib/ against hashes pinned in js/app.js, and the two must come from the same release).
 */
const CACHE_VERSION = '0.2.0';
const CACHE_NAME = `chess-webCLI-${CACHE_VERSION}`;
const SHELL = [
  './', 'index.html', 'manifest.json', 'icon.svg', 'icon-192.png', 'icon-512.png', 'icon-192-maskable.png', 'icon-512-maskable.png', 'apple-touch-icon.png',
  'about/', 'about/index.html',
  'img/architecture.svg', 'img/invite-link.svg', 'img/signed-log.svg', 'img/git-game.svg', 'img/bounded-ai.svg', 'img/privacy.svg',
  'js/app.js', 'js/chess.js', 'js/engine.js', 'js/engine-worker.js', 'js/intent.js', 'js/ai.js', 'js/log.js', 'js/store.js',
  'lib/trystero-nostr.js', 'lib/qrcode.js', 'lib/PINS.json',
];
self.addEventListener('install', (event) => {
  self.skipWaiting();
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => Promise.all(SHELL.map((u) => cache.add(new Request(u, { cache: 'reload' })).catch((e) => console.warn('chess-webCLI: not cached', u, e))))));
});
self.addEventListener('activate', (event) => {
  event.waitUntil(caches.keys().then((names) => Promise.all(names.filter((n) => n.startsWith('chess-webCLI-') && n !== CACHE_NAME).map((n) => caches.delete(n)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  event.respondWith((async () => {
    try {
      const fresh = await fetch(request);
      if (fresh.ok && fresh.type === 'basic') { const copy = fresh.clone(); caches.open(CACHE_NAME).then((c) => c.put(request, copy)).catch(() => {}); }
      return fresh;
    } catch (err) {
      const hit = await caches.match(request, { ignoreSearch: true });
      if (hit) return hit;
      if (request.mode === 'navigate') { const page = await caches.match(url.pathname.endsWith('/about/') ? 'about/index.html' : 'index.html'); if (page) return page; }
      throw err;
    }
  })());
});
