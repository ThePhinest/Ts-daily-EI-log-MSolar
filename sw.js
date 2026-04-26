const CACHE_NAME = 'phinest-ei-v24';
// Domains to NEVER cache — always pass through to network
const BYPASS_DOMAINS = [
  'gstatic.com',
  'firestore.googleapis.com',
  'googleapis.com',
  'firebaseapp.com',
  'firebasestorage.app',
  'fonts.googleapis.com',
  'fonts.gstatic.com',
  'api.mapbox.com',
  'events.mapbox.com',
  'tiles.mapbox.com',
  'a.tiles.mapbox.com',
  'b.tiles.mapbox.com',
  'c.tiles.mapbox.com',
  'd.tiles.mapbox.com',
  'cdn.jsdelivr.net'
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
  // Only cache our own GitHub Pages app shell — let everything else go direct
  if (!url.includes('app.groundlog.io')) {
    event.respondWith(fetch(event.request));
    return;
  }
  // Network-first for our own app shell only
  event.respondWith(
    fetch(event.request)
      .then(response => {
        if (event.request.method === 'GET' && response.status === 200) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
        }
        return response;
      })
      .catch(() => caches.match(event.request))
  );
});
