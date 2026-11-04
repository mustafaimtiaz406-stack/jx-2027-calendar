/* JX 2027 Calendar — service worker (app-shell caching)
 * Bump VERSION on every release that changes any file in SHELL_ASSETS.
 * The new worker installs a new cache, waits, and only takes over when the user
 * accepts the update prompt (SKIP_WAITING). Old jx-shell-* caches are deleted on activate.
 * This worker caches app files only — it never touches IndexedDB user data.
 */
const VERSION = '0.6.2'; // must match APP_VERSION in js/app.js
const CACHE_PREFIX = 'jx-shell-';
const CACHE_NAME = `${CACHE_PREFIX}${VERSION}`;

const SHELL_ASSETS = [
  './',
  './index.html',
  './css/app.css',
  './js/app.js',
  './js/db.js',
  './js/settings.js',
  './js/dates.js',
  './js/events.js',
  './js/recurrence.js',
  './js/tasks.js',
  './js/task-views.js',
  './js/task-dialogs.js',
  './js/ics-export.js',
  './js/backup.js',
  './js/backup-ui.js',
  './js/ui.js',
  './js/views.js',
  './js/event-dialogs.js',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png',
  './icons/apple-touch-icon.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    // cache: 'reload' bypasses the HTTP cache so a new version never caches stale files.
    await cache.addAll(SHELL_ASSETS.map((url) => new Request(url, { cache: 'reload' })));
    // First install (no active worker yet) activates immediately; updates wait for the user.
    if (!self.registration.active) await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys
      .filter((k) => k.startsWith(CACHE_PREFIX) && k !== CACHE_NAME)
      .map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  // Navigations: serve the cached app shell (single-page app with hash routes).
  if (req.mode === 'navigate') {
    event.respondWith((async () => {
      const cache = await caches.open(CACHE_NAME);
      const cached = await cache.match('./index.html');
      if (cached) return cached;
      return fetch(req);
    })());
    return;
  }

  // Static assets: cache first, then network. Uncached responses are not stored,
  // so the cache only ever contains the versioned shell list.
  event.respondWith((async () => {
    const cache = await caches.open(CACHE_NAME);
    const cached = await cache.match(req, { ignoreSearch: true });
    if (cached) return cached;
    return fetch(req);
  })());
});
