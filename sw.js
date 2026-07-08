const CACHE_NAME = 'antosias-app-v2';

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      // Drop every cache from previous versions (including all the stale
      // ?v=N asset copies accumulated under the old cache name).
      const names = await caches.keys();
      await Promise.all(names.filter((n) => n !== CACHE_NAME).map((n) => caches.delete(n)));
      await self.clients.claim();
    })()
  );
});

// Network-first, same-origin only: always try to fetch the newest version of
// our own files so deployed updates show up immediately; fall back to the
// last cached copy when offline. Cross-origin requests (GitHub API, raw Gist
// files) pass through untouched — caching those would duplicate multi-MB
// shared exports into cache storage and serve stale shared data.
self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  if (new URL(request.url).origin !== self.location.origin) return;
  event.respondWith(
    fetch(request)
      .then((response) => {
        const copy = response.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
        return response;
      })
      .catch(() => caches.match(request))
  );
});
