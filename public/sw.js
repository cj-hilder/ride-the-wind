/* ============================================================================
 * Ride the Wind — Service Worker  (sw.js)
 *
 * Two jobs, both within what a PWA service worker can ACTUALLY do reliably:
 *
 *  1. Offline app shell. Cache the shell + assets so the app launches with no
 *     network. Forecast data is never shell-cached (it must be fresh); only the
 *     code/UI is. Strategy: cache-first for the shell, network-first for data.
 *
 * What this SW deliberately does NOT do: notifications or scheduling. A PWA
 * cannot be relied on to wake at a wall-clock time (setTimeout does not survive
 * suspension; Periodic Background Sync is Chromium-only and best-effort) and on
 * iOS cannot notify when closed at all. Rather than ship an alert path that
 * works on some platforms and silently fails on others, the app shows a live
 * countdown beside the departure time while open. The only message handled here
 * is SKIP_WAITING, for picking up a new version.
 * ========================================================================== */

// Cache version is stamped at build time (see the BUILD_ID replace in the
// deploy step / vite define). When the bundle changes, the version changes,
// so old shells are purged automatically on activate — no hand-editing.
const VERSION = (self.__RTW_BUILD_ID__ || "dev");
const SHELL_CACHE = "rtw-shell-" + VERSION;
const DATA_CACHE = "rtw-data-v1";

// Paths are relative to the SW's scope (registered under the Pages subpath),
// BASE is derived dynamically so the SW works at any path (/ for ridethewind.nz).
const BASE = new URL("./", self.location).pathname; // e.g. "/" or "/ride-the-wind/"
// Only pre-cache things whose URL never changes. NOT index.html — that is
// fetched network-first so new deploys are picked up immediately.
const SHELL_ASSETS = [
  BASE + "manifest.webmanifest",
  BASE + "icons/icon-192.png",
  BASE + "icons/icon-512.png",
];

/* ---- install: pre-cache stable assets, then take over immediately ---- */
self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE).then((c) => c.addAll(SHELL_ASSETS)).then(() => self.skipWaiting())
  );
});

/* ---- activate: drop ALL old shell caches (any version != current) ---- */
self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((k) => k !== SHELL_CACHE && k !== DATA_CACHE)
          .map((k) => caches.delete(k))
      )
    ).then(() => self.clients.claim())
  );
});

/* ---- fetch routing ---- */
self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== "GET") return;

  // Open-Meteo: network-first, fall back to last good forecast.
  if (url.hostname.endsWith("open-meteo.com")) {
    event.respondWith(networkFirst(event.request, DATA_CACHE));
    return;
  }

  if (url.origin === self.location.origin) {
    // The HTML document / SPA navigations: NETWORK-FIRST so a fresh deploy is
    // seen at once; fall back to the cached shell only when offline.
    if (event.request.mode === "navigate" || url.pathname === BASE || url.pathname === BASE + "index.html") {
      event.respondWith(networkFirstDoc(event.request));
      return;
    }
    // Hashed build assets (app-a1b2c3.js, *.css): safe to cache-first forever,
    // because Vite changes the filename when the content changes.
    event.respondWith(cacheFirst(event.request));
    return;
  }
  // Everything else: straight to network.
});

async function cacheFirst(request) {
  const cached = await caches.match(request);
  if (cached) return cached;
  try {
    const res = await fetch(request);
    if (res.ok) {
      const cache = await caches.open(SHELL_CACHE);
      cache.put(request, res.clone());
    }
    return res;
  } catch {
    throw new Error("offline and uncached");
  }
}

// Network-first for the document: always fetch fresh, cache the latest copy,
// fall back to whatever we last cached if the network is down.
async function networkFirstDoc(request) {
  const cache = await caches.open(SHELL_CACHE);
  try {
    const res = await fetch(request, { cache: "no-store" });
    if (res.ok) cache.put(BASE + "index.html", res.clone());
    return res;
  } catch {
    const cached = await cache.match(BASE + "index.html");
    if (cached) return cached;
    throw new Error("offline and no cached shell");
  }
}

// Network-first for forecast data: fresh when online, last-known when not.
async function networkFirst(request, cacheName) {
  const cache = await caches.open(cacheName);
  try {
    const res = await fetch(request);
    if (res.ok) cache.put(request, res.clone());
    return res;
  } catch {
    const cached = await cache.match(request);
    if (cached) return cached; // stale forecast is better than nothing
    throw new Error("forecast unavailable offline");
  }
}

/* ---- message channel: version update only ----
 * No notifications: a PWA can't reliably wake to notify when closed, so the app
 * shows a live countdown beside the departure time instead. */
self.addEventListener("message", (event) => {
  const msg = event.data || {};
  if (msg.type === "SKIP_WAITING") {
    // app detected a new version and asked us to take over now
    self.skipWaiting();
  }
});
