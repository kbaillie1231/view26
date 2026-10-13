// Offline support. The page and program data are fetched from the network
// first (with a short timeout, for slow venue Wi-Fi) and fall back to the
// cached copy; static assets are served from cache and refreshed in the
// background. Bump VERSION when the list of precached files changes.
const VERSION = 'v1';
const CACHE = `view26-${VERSION}`;
const PRECACHE = [
  './',
  'index.html',
  'styles.css?v=1',
  'app.js?v=1',
  'data/program.json',
  'manifest.webmanifest',
  'icons/icon.svg',
  'icons/icon-192.png',
  'icons/apple-touch-icon.png',
];
const NETWORK_TIMEOUT_MS = 3500;

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(PRECACHE)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('view26-') && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

function networkFirst(request, cacheKey) {
  return caches.open(CACHE).then((cache) => {
    const network = fetch(request).then((res) => {
      if (res.ok) cache.put(cacheKey || request, res.clone());
      return res;
    });
    const timeout = new Promise((resolve) => setTimeout(resolve, NETWORK_TIMEOUT_MS));
    const cached = () => cache.match(cacheKey || request);
    return Promise.race([network.catch(() => null), timeout]).then((res) => {
      if (res) return res;
      return cached().then((hit) => hit || network);
    });
  });
}

function staleWhileRevalidate(request) {
  return caches.open(CACHE).then((cache) =>
    cache.match(request).then((hit) => {
      const network = fetch(request)
        .then((res) => {
          if (res.ok) cache.put(request, res.clone());
          return res;
        })
        .catch(() => hit);
      return hit || network;
    }),
  );
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  if (request.mode === 'navigate') {
    // Any page URL (with ?q=… or ?s=…) is the same app shell.
    event.respondWith(networkFirst(request, 'index.html'));
    return;
  }
  if (url.pathname.endsWith('/data/program.json')) {
    event.respondWith(networkFirst(request, 'data/program.json'));
    return;
  }
  event.respondWith(staleWhileRevalidate(request));
});
