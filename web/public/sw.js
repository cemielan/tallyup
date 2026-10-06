// Service worker: makes the app open offline after the first visit.
//
// - The API (/v1/*) is never cached. Event data must be fresh, and it is
//   ciphertext the app re-fetches on every open anyway.
// - Page loads go network-first, so a deploy is picked up on the next visit
//   and the cached shell is only the offline fallback.
// - Same-origin files and fonts (hashed bundles, icons, OCR files) are
//   cache-first: those URLs never change content. Other origins are not
//   touched at all.
//
// ponytail: one cache that only grows. Old hashed bundles linger until
// CACHE is bumped. Bump it when the shell changes shape, or switch to a
// build-generated precache list if the cache size ever matters.
const CACHE = 'tallyup-v2';

self.addEventListener('install', () => self.skipWaiting());

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      for (const key of await caches.keys()) if (key !== CACHE) await caches.delete(key);
      await self.clients.claim();
    })(),
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);
  if (request.method !== 'GET') return;
  // Same-origin files and fonts only. Third-party scripts, Turnstile above
  // all, must always come fresh from their owner; caching a security check
  // would be a bug.
  const font = url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com';
  if (url.origin !== self.location.origin && !font) return;
  if (url.origin === self.location.origin && /^\/(v1\/|health)/.test(url.pathname)) return;

  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((response) => {
          const copy = response.clone();
          caches.open(CACHE).then((cache) => cache.put('/', copy));
          return response;
        })
        .catch(async () => (await caches.match('/')) ?? Response.error()),
    );
    return;
  }

  event.respondWith(
    caches.match(request).then(
      (hit) =>
        hit ??
        fetch(request).then((response) => {
          if (response.ok) {
            const copy = response.clone();
            caches.open(CACHE).then((cache) => cache.put(request, copy));
          }
          return response;
        }),
    ),
  );
});
