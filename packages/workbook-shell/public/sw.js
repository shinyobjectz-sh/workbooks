// Workbooks PWA service worker.
//
// Job: register the PWA, cache the shell assets so the shell can boot
// offline (and for instant relaunches after install). DOES NOT cache
// user data — the workbook file the user opens is the database; we
// just bootstrap the runtime that reads it.
//
// Caching strategy:
//   - manifest.json + index.html: network-first (stale-while-revalidate
//     fallback). PWA chrome / install validators need the freshest copy
//     after a shell deploy; serving stale here led to the install
//     prompt showing months-old icon errors.
//   - everything else (sw.js itself, icons, static assets): cache-first
//     with background revalidation.
//
// Versioning: bump CACHE_NAME on every shell deploy so old caches get
// cleaned up on activate. Without this, browsers stick to whatever
// they cached on first visit until the cache is manually cleared.

const CACHE_NAME = "workbooks-shell-v2";
const SHELL_ASSETS = [
  "/",
  "/index.html",
  "/manifest.json",
  "/icon.svg",
  "/icon-192.png",
  "/icon-512.png",
  "/icon-maskable-512.png",
];

const NETWORK_FIRST_PATHS = new Set([
  "/",
  "/index.html",
  "/manifest.json",
]);

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) =>
      cache.addAll(SHELL_ASSETS).catch((e) => {
        console.warn("[sw] partial precache:", e?.message ?? e);
      }),
    ),
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      // Drop old caches so the freshest manifest replaces stale ones.
      const keys = await caches.keys();
      await Promise.all(
        keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)),
      );
      await self.clients.claim();
    })(),
  );
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;
  if (event.request.method !== "GET") return;

  if (NETWORK_FIRST_PATHS.has(url.pathname)) {
    event.respondWith(networkFirst(event.request));
  } else {
    event.respondWith(cacheFirst(event.request));
  }
});

async function networkFirst(request) {
  try {
    const fresh = await fetch(request);
    if (fresh.ok) {
      const clone = fresh.clone();
      caches.open(CACHE_NAME).then((c) => c.put(request, clone));
    }
    return fresh;
  } catch {
    const cached = await caches.match(request);
    if (cached) return cached;
    throw new Error(`network-first: no network and no cache for ${request.url}`);
  }
}

async function cacheFirst(request) {
  const cached = await caches.match(request);
  if (cached) return cached;
  const fresh = await fetch(request);
  if (fresh.ok && SHELL_ASSETS.includes(new URL(request.url).pathname)) {
    const clone = fresh.clone();
    caches.open(CACHE_NAME).then((c) => c.put(request, clone));
  }
  return fresh;
}
