// Offline support. The page and program data are fetched from the network
// first (with a short timeout, for slow venue Wi-Fi) and fall back to the
// cached copy; static assets are served from cache and refreshed in the
// background. When app.js or styles.css change, bump their ?v= in index.html
// and here, and bump VERSION, so phones load the new code on the next launch.
const VERSION = 'v2';
const CACHE = `view26-${VERSION}`;
const PRECACHE = [
  './',
  'index.html',
  'styles.css?v=2',
  'app.js?v=2',
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

function networkFirst(request, cacheKey, expectType) {
  return caches.open(CACHE).then((cache) => {
    const network = fetch(request).then((res) => {
      // Only cache what we expect under this key (never e.g. a calendar
      // file or an error page in place of the app shell).
      const type = res.headers.get('content-type') || '';
      if (res.ok && (!expectType || type.includes(expectType))) cache.put(cacheKey || request, res.clone());
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

  const scopePath = new URL(self.registration.scope).pathname;
  if (request.mode === 'navigate') {
    // The app shell, under any query (?q=…, ?s=…). Other navigations, such as
    // opening a calendar file, go straight to the network.
    if (url.pathname === scopePath || url.pathname === `${scopePath}index.html`) {
      event.respondWith(networkFirst(request, 'index.html', 'text/html'));
    }
    return;
  }
  if (url.pathname === `${scopePath}data/program.json`) {
    event.respondWith(networkFirst(request, 'data/program.json', 'json'));
    return;
  }
  if (url.pathname.startsWith(`${scopePath}ics/`)) return;
  event.respondWith(staleWhileRevalidate(request));
});
