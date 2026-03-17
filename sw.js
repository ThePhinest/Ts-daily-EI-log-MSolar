const CACHE_NAME = 'phinest-ei-v3';

// Domains to NEVER cache — always pass through to network
const BYPASS_DOMAINS = [
  'gstatic.com',
  'firestore.googleapis.com',
  'googleapis.com',
  'firebaseapp.com',
  'firebasestorage.app',
  'fonts.googleapis.com',
  'fonts.gstatic.com'
];

self.addEventListener('install', event => {
  self.skipWaiting();
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  const url = event.request.url;

  // Always bypass Firebase and Google CDN domains
  if (BYPASS_DOMAINS.some(domain => url.includes(domain))) {
    event.respondWith(fetch(event.request));
    return;
  }

  // Network-first for everything else
  event.respondWith(
    fetch(event.request)
      .then(response => {
        // Cache successful GET responses for the app shell
        if (event.request.method === 'GET' && response.status === 200) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
        }
        return response;
      })
      .catch(() => caches.match(event.request))
  );
});
