// LETW Radio Service Worker
// Handles caching, offline fallback, background audio notifications, and push messages

const CACHE_NAME = 'letw-radio-v2';
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

// ===== PUSH NOTIFICATIONS =====
self.addEventListener('push', event => {
  let data = {};
  if (event.data) {
    try {
      data = event.data.json();
    } catch (e) {
      data = { title: 'LETW Radio', body: event.data.text() };
    }
  }

  const title = data.title || 'LETW Radio';
  const options = {
    body: data.body || 'A new broadcast has started.',
    icon: data.icon || '/logo.png',
    badge: '/logo.png',
    tag: 'letw-radio-notification',
    renotify: true,
    vibrate: [200, 100, 200],
    data: {
      url: data.url || '/listen',
    },
    actions: [
      { action: 'listen', title: 'Listen Now' },
      { action: 'dismiss', title: 'Dismiss' },
    ],
  };

  event.waitUntil(
    self.registration.showNotification(title, options)
  );
});

// ===== NOTIFICATION CLICK =====
self.addEventListener('notificationclick', event => {
  event.notification.close();

  if (event.action === 'dismiss') return;

  const targetUrl = (event.notification.data && event.notification.data.url)
    ? event.notification.data.url
    : '/listen';

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(clientList => {
      // If a window is already open on /listen, focus it
      for (const client of clientList) {
        if (client.url.includes('/listen') && 'focus' in client) {
          return client.focus();
        }
      }
      // Otherwise open a new window
      if (self.clients.openWindow) {
        return self.clients.openWindow(targetUrl);
      }
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
