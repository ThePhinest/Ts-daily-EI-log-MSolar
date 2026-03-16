// Self-destructing service worker
// Unregisters itself and reloads all clients so Firebase CDN loads clean
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', event => {
  event.waitUntil(
    self.registration.unregister()
      .then(() => self.clients.matchAll())
      .then(clients => clients.forEach(client => client.navigate(client.url)))
  );
});
