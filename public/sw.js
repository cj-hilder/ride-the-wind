/* ============================================================================
 * Ride the Wind — Service Worker  (sw.js)
 *
 * Two jobs, both within what a PWA service worker can ACTUALLY do reliably:
 *
 *  1. Offline app shell. Cache the shell + assets so the app launches with no
 *     network. Forecast data is never shell-cached (it must be fresh); only the
 *     code/UI is. Strategy: cache-first for the shell, network-first for data.
 *
 *  2. Push display. When a push arrives (from a server, or a local
 *     showNotification call), render it and route taps back into the app.
 *
 * What this SW deliberately does NOT do: it does not try to self-schedule a
 * 21:00 fetch. A service worker cannot be relied on to wake at a wall-clock
 * time — setTimeout does not survive suspension, and Periodic Background Sync
 * is Chromium-only and best-effort. Scheduling/eval lives in scheduler.js and
 * runs when the app is open (the guaranteed path); true timed push, where
 * available, is driven by a server posting to the Push API. This matches the
 * delivery decision in the spec: in-app summary is the guaranteed channel,
 * push is enhancement.
 * ========================================================================== */

// Cache version is stamped at build time (see the BUILD_ID replace in the
// deploy step / vite define). When the bundle changes, the version changes,
// so old shells are purged automatically on activate — no hand-editing.
const VERSION = (self.__RTW_BUILD_ID__ || "dev");
const SHELL_CACHE = "rtw-shell-" + VERSION;
const DATA_CACHE = "rtw-data-v1";

// Paths are relative to the SW's scope (registered under the Pages subpath),
// so the same SW works whether served from / or /ride-the-wind/.
const BASE = new URL("./", self.location).pathname; // e.g. "/ride-the-wind/"
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

/* ---- push: render an alert ---- */
self.addEventListener("push", (event) => {
  let payload = {};
  try { payload = event.data ? event.data.json() : {}; } catch { payload = {}; }

  const title = payload.title || "Ride the Wind";
  const options = {
    body: payload.body || "Your morning ride forecast is ready.",
    icon: BASE + "icons/icon-192.png",
    badge: BASE + "icons/icon-192.png",
    tag: payload.tag || "rtw-alert", // collapse repeats for the same morning
    renotify: !!payload.renotify,
    data: { url: payload.url || BASE, routeId: payload.routeId || null },
    // a calm vibration, only where supported
    vibrate: payload.silent ? undefined : [40, 60, 40],
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

/* ---- notification tap: focus or open the app on the right route ---- */
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const target = (event.notification.data && event.notification.data.url) || BASE;
  event.waitUntil(
    clients.matchAll({ type: "window", includeUncontrolled: true }).then((wins) => {
      for (const w of wins) {
        if ("focus" in w) {
          w.navigate?.(target);
          return w.focus();
        }
      }
      return clients.openWindow(target);
    })
  );
});

/* ---- message channel: let the app ask the SW to show a local notification ----
 * Used by scheduler.js when a run produces an alert while the app is open or
 * being closed, on platforms where we don't have server push. Best-effort. */
self.addEventListener("message", (event) => {
  const msg = event.data || {};
  if (msg.type === "SKIP_WAITING") {
    // app detected a new version and asked us to take over now
    self.skipWaiting();
    return;
  }
  if (msg.type === "SHOW_LOCAL_NOTIFICATION") {
    const { title, ...options } = msg.notification || {};
    self.registration.showNotification(title || "Ride the Wind", options);
  }
});
