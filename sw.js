const CACHE_NAME = 'phinest-ei-v1';
const ASSETS = [
  '/Ts-daily-EI-log-MSolar/',
  '/Ts-daily-EI-log-MSolar/index.html',
  '/Ts-daily-EI-log-MSolar/manifest.json',
  '/Ts-daily-EI-log-MSolar/icon-192.png',
  '/Ts-daily-EI-log-MSolar/icon-512.png'
];

// Install: cache all core assets
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(ASSETS))
  );
  self.skipWaiting();
});

// Activate: clear old caches
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k))
      )
    )
  );
  self.clients.claim();
});

// Fetch: serve from cache, fall back to network
self.addEventListener('fetch', event => {
  event.respondWith(
    caches.match(event.request).then(cached => {
      if (cached) return cached;
      return fetch(event.request).then(response => {
        // Cache new successful GET responses
        if (event.request.method === 'GET' && response.status === 200) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
        }
        return response;
      }).catch(() => {
        // Offline fallback — return cached index if available
        return caches.match('/Ts-daily-EI-log-MSolar/index.html');
      });
    })
  );
});
