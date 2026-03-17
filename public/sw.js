// LETW Radio Service Worker
// Handles caching, offline fallback, and background audio notifications

const CACHE_NAME = 'letw-radio-v1';
const STATIC_ASSETS = [
  '/listen',
  '/logo.png',
  '/manifest.json',
];

// ===== INSTALL =====
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => {
      return cache.addAll(STATIC_ASSETS);
    })
  );
  self.skipWaiting();
});

// ===== ACTIVATE =====
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys.filter(key => key !== CACHE_NAME).map(key => caches.delete(key))
      )
    )
  );
  self.clients.claim();
});

// ===== FETCH =====
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);

  // Never cache the stream — always fetch live
  if (url.pathname === '/stream') {
    event.respondWith(fetch(event.request));
    return;
  }

  // Never cache API calls
  if (url.pathname.startsWith('/api/')) {
    event.respondWith(fetch(event.request));
    return;
  }

  // For everything else: cache first, fallback to network
  event.respondWith(
    caches.match(event.request).then(cached => {
      if (cached) return cached;
      return fetch(event.request).then(response => {
        // Cache successful GET responses
        if (event.request.method === 'GET' && response.status === 200) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
        }
        return response;
      }).catch(() => {
        // Offline fallback — return cached /listen page
        if (event.request.headers.get('accept')?.includes('text/html')) {
          return caches.match('/listen');
        }
      });
    })
  );
});

// ===== MEDIA SESSION (lock screen / notification controls) =====
self.addEventListener('message', event => {
  if (event.data?.type === 'UPDATE_METADATA') {
    const { title, artist } = event.data;
    if ('mediaSession' in self.registration) {
      // Broadcast to all open clients
      self.clients.matchAll().then(clients => {
        clients.forEach(client => {
          client.postMessage({ type: 'METADATA_UPDATE', title, artist });
        });
      });
    }
  }
});
