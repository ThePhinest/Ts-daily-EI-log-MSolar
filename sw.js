const CACHE_NAME = 'phinest-ei-v5';
const ASSETS = [
  '/Ts-daily-EI-log-MSolar/',
  '/Ts-daily-EI-log-MSolar/index.html',
  '/Ts-daily-EI-log-MSolar/manifest.json',
  '/Ts-daily-EI-log-MSolar/icon-192.png',
  '/Ts-daily-EI-log-MSolar/icon-512.png'
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(ASSETS))
  );
  self.skipWaiting();
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);

  // ── Let ALL external/cross-origin requests pass through untouched ──
  // This is critical — Firebase SDKs, Google Fonts, etc. must never be intercepted
  if (url.origin !== self.location.origin) {
    return; // browser handles it normally
  }

  const isHTML = event.request.destination === 'document'
    || url.pathname.endsWith('.html')
    || url.pathname.endsWith('/');

  if (isHTML) {
    // Network-first for HTML — always try to get fresh index.html
    event.respondWith(
      fetch(event.request)
        .then(response => {
          const clone = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
          return response;
        })
        .catch(() => caches.match(event.request))
    );
  } else {
    // Cache-first for same-origin assets (icons, manifest)
    event.respondWith(
      caches.match(event.request).then(cached => {
        if (cached) return cached;
        return fetch(event.request).then(response => {
          const clone = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
          return response;
        }).catch(() => caches.match('/Ts-daily-EI-log-MSolar/index.html'));
      })
    );
  }
});
