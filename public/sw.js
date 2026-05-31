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

const SHELL_CACHE = "rtw-shell-v1";
const DATA_CACHE = "rtw-data-v1";

// Paths are relative to the SW's scope (registered under the Pages subpath),
// so the same SW works whether served from / or /ride-the-wind/.
const BASE = new URL("./", self.location).pathname; // e.g. "/ride-the-wind/"
const SHELL_ASSETS = [
  BASE,
  BASE + "index.html",
  BASE + "manifest.webmanifest",
  BASE + "icons/icon-192.png",
  BASE + "icons/icon-512.png",
];

/* ---- install: pre-cache the shell ---- */
self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE).then((c) => c.addAll(SHELL_ASSETS)).then(() => self.skipWaiting())
  );
});

/* ---- activate: drop old caches ---- */
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

  // Open-Meteo (and any forecast API): network-first, fall back to last good.
  if (url.hostname.endsWith("open-meteo.com")) {
    event.respondWith(networkFirst(event.request));
    return;
  }

  // App shell & same-origin assets: cache-first.
  if (url.origin === self.location.origin) {
    event.respondWith(cacheFirst(event.request));
    return;
  }
  // Everything else: just go to network.
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
    // SPA fallback to the cached shell for navigations
    if (request.mode === "navigate") return caches.match(BASE + "index.html");
    throw new Error("offline and uncached");
  }
}

async function networkFirst(request) {
  const cache = await caches.open(DATA_CACHE);
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
  if (msg.type === "SHOW_LOCAL_NOTIFICATION") {
    const { title, ...options } = msg.notification || {};
    self.registration.showNotification(title || "Ride the Wind", options);
  }
});
