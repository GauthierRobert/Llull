/**
 * llull service worker. `self.LLULL_SW` (version, precache list, policy regexes) is prepended at
 * build time by viteServiceWorker.ts from serviceWorker/config.json — this file holds no policy.
 * Updates never take over silently: a new worker waits until the page posts SKIP_WAITING
 * (src/ui/services/appUpdates.ts).
 */

const manifest = self.LLULL_SW;
const CACHE_PREFIX = 'llull-';
const cacheName = `${CACHE_PREFIX}${manifest.version}`;
const runtimeCacheFirst = new RegExp(manifest.runtime.cacheFirst);
const runtimeExclude = new RegExp(manifest.runtime.exclude);
const navigationBypass = new RegExp(manifest.navigation.bypass);

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(cacheName).then((cache) => cache.addAll(manifest.precache)));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((names) =>
        Promise.all(names.filter((name) => name.startsWith(CACHE_PREFIX) && name !== cacheName).map((name) => caches.delete(name))),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('message', (event) => {
  if (event.data === 'SKIP_WAITING') void self.skipWaiting();
});

async function cacheFirst(request) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);
  if (cached) return cached;
  const response = await fetch(request);
  // A SPA fallback page served for a missing asset must never be cached as that asset.
  const isHtml = (response.headers.get('content-type') ?? '').includes('text/html');
  if (response.ok && !isHtml) await cache.put(request, response.clone());
  return response;
}

async function networkFirstNavigation(request) {
  try {
    return await fetch(request);
  } catch (error) {
    const cache = await caches.open(cacheName);
    const shell = await cache.match(manifest.navigation.fallback);
    if (shell) return shell;
    throw error;
  }
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (request.mode === 'navigate') {
    if (!navigationBypass.test(url.pathname)) event.respondWith(networkFirstNavigation(request));
    return;
  }
  if (runtimeCacheFirst.test(url.pathname) && !runtimeExclude.test(url.pathname)) {
    event.respondWith(cacheFirst(request));
  }
});
