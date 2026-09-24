const CACHE_NAME = 'dungeon-scrivener-studio-v2';
const APP_SHELL = ['/', '/manifest.webmanifest'];
self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE_NAME).then(cache => cache.addAll(APP_SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key => key.startsWith('dungeon-scrivener-studio-') && key !== CACHE_NAME).map(key => caches.delete(key)))).then(() => self.clients.claim()));
});
self.addEventListener('message', event => {
  if (event.data?.type !== 'PRECACHE_URLS' || !Array.isArray(event.data.urls)) return;
  event.waitUntil(caches.open(CACHE_NAME).then(cache => cache.addAll(event.data.urls)).then(() => {
    event.source?.postMessage({ type: 'PRECACHE_COMPLETE' });
  }));
});
self.addEventListener('fetch', event => {
  const request = event.request;
  if (request.method !== 'GET' || new URL(request.url).origin !== self.location.origin) return;
  event.respondWith((async () => {
    const cache = await caches.open(CACHE_NAME);
    const cached = await cache.match(request, { ignoreVary: true });
    if (cached) return cached;
    try {
      const response = await fetch(request);
      if (response.ok && ['document', 'script', 'style', 'font'].includes(request.destination)) {
        void cache.put(request, response.clone());
      }
      return response;
    } catch {
      if (request.mode === 'navigate') return (await cache.match('/', { ignoreVary: true })) ?? Response.error();
      return Response.error();
    }
  })());
});
