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

// Cache version. generate-env.mjs writes ./build-id.js on every build and dev
// start, setting self.__RTW_BUILD_ID__ from the commit hash and date. It used
// to be stamped by a `sed` step in the GitHub Pages workflow only, so the live
// site (Cloudflare Workers Builds, no GitHub Actions) always ran as "dev" and
// old shells were never purged. When the build id changes, so does this
// cache name, and activate() deletes the old one. The browser's update check
// byte-compares imported scripts too, so a new build-id.js alone is enough to
// install a new worker even though this file is unchanged.
// try/catch: a missing build-id.js (a checkout that never ran generate-env)
// must not stop the worker installing; it just falls back to "dev".
try { importScripts("./build-id.js"); } catch (e) { /* fall back to "dev" */ }
const VERSION = (self.__RTW_BUILD_ID__ || "dev");
const SHELL_CACHE = "rtw-shell-" + VERSION;
// Note: the old "rtw-data-v1" forecast cache is retired — forecasts are cached
// by the app (IndexedDB) now. activate() deletes every cache except the current
// shell, so any leftover copy is purged automatically.

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
          .filter((k) => k !== SHELL_CACHE) // drops the retired forecast cache too
          .map((k) => caches.delete(k))
      )
    ).then(() => self.clients.claim())
  );
});

/* ---- fetch routing ---- */
self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== "GET") return;

  // Open-Meteo is deliberately NOT cached here. Forecast caching lives in the
  // app (IndexedDB), where the entry carries its true fetch time — so the app
  // can skip the network while fresh AND report honest freshness when serving an
  // older copy offline. A second copy here would duplicate a large payload and
  // give two conflicting answers to "how old is this forecast?".

  if (url.origin === self.location.origin) {
    // /api/*: straight to the network, never cached.
    if (url.pathname.startsWith(BASE + "api/")) return;

    // The app shell: NETWORK-FIRST so a fresh deploy is seen at once; fall
    // back to the cached shell only when offline. ONLY the root counts as the
    // app (the app has no path routes: screens are React state, and the back
    // guard pushes entries on the same URL). Every other navigation — the
    // standalone pages privacy, terms and the OAuth popup's oauth-callback —
    // goes straight to the network and is never stored, because
    // networkFirstDoc stores whatever it gets AS the shell: Google's sign-in
    // popup landing there would make the next offline launch open "Returning
    // to Ride the Wind…" instead of the app. The extension can't mark those
    // pages: Cloudflare redirects /privacy.html to /privacy (html_handling),
    // and each redirect hop of a navigation comes back through this worker.
    if (url.pathname === BASE || url.pathname === BASE + "index.html") {
      event.respondWith(networkFirstDoc(event.request));
      return;
    }
    if (event.request.mode === "navigate") return;
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
    // Never cache HTML as an asset. wrangler.jsonc's single-page-application
    // fallback answers a request for ANY missing file — e.g. a hashed bundle
    // from an earlier build, /assets/index-OLD.js — with index.html and a 200.
    // Cached under the bundle's URL, that HTML can't run as a script, so a
    // stale page would render blank on every launch. `ok` alone can't catch
    // it; the content type can. (Found in Temperatura, same hosting.)
    const type = (res.headers.get("content-type") || "").toLowerCase();
    if (res.ok && !type.startsWith("text/html")) {
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
