/**
 * Ride the Wind — Application wiring (app.js)
 *
 * The single place the real, tested modules are composed into a dependency
 * graph and exposed as clean app-level operations. Nothing above this layer
 * (the UI) imports the modules directly; it talks to an AppController.
 *
 * This is the seam the three screens plug into:
 *   - SetupScreen   → controller.createRoute(gpxText, setup)
 *   - HomeScreen    → controller.getHomeVerdict(routeId) / listRoutesWithVerdict()
 *   - CaptureScreen → controller.recordRide(capture)
 *   - on app open   → controller.runDueAlerts()
 *
 * The forecast fetch is injected (real Open-Meteo in the browser, a stub in
 * tests) so this whole layer is exercisable headlessly.
 */

import { processGpx } from "./gpxRoute.js";
import {
  seedK as computeSeedK,
  fetchForecast as realFetchForecast,
  parseForecast,
} from "./windModel.js";
import * as learning from "./learning.js";
import {
  evaluateAlert,
  reconcileMorning,
  nextActiveArrival,
  shouldNotify,
  DEFAULT_THRESHOLD_MIN,
} from "./alertEngine.js";
import {
  makePredictor,
  chooseStations,
  predictWithRange,
} from "./prediction.js";
import {
  Store,
  MemoryBackend,
  IndexedDBBackend,
  requestPersistentStorage,
} from "./storage.js";
import { runDueAlerts, installScheduler } from "./scheduler.js";

/* ------------------------------------------------------------------ *
 * Construction
 * ------------------------------------------------------------------ */

/**
 * Build the controller with all real modules wired together.
 *
 * @param {Object} [deps]
 * @param {Object} [deps.backend]   - storage backend (defaults to IndexedDB in
 *                                    browser, MemoryBackend otherwise)
 * @param {Function} [deps.fetchForecastFor] - async (lat,lon)=>parsedSeries;
 *                                    defaults to Open-Meteo via windModel
 * @param {Function} [deps.notify]  - async (notification)=>void
 * @param {Function} [deps.now]     - ()=>epochMs (injectable clock for tests)
 */
export function createAppController(deps = {}) {
  const backend =
    deps.backend ||
    (typeof indexedDB !== "undefined"
      ? new IndexedDBBackend()
      : new MemoryBackend());

  const store = new Store({ backend, learning });

  const fetchForecastFor =
    deps.fetchForecastFor ||
    (async (lat, lon) => realFetchForecast(lat, lon)); // returns parsed series

  const now = deps.now || (() => Date.now());

  // In-memory caches for a session: avoid re-fetching the same station within
  // a short window. Keyed by rounded lat/lon.
  const forecastCache = new Map();
  const FORECAST_TTL = 30 * 60 * 1000; // 30 min

  async function stationSeriesFor(route) {
    const stations = chooseStations(route);
    const series = [];
    for (const st of stations) {
      const key = `${st.lat.toFixed(2)},${st.lon.toFixed(2)}`;
      const hit = forecastCache.get(key);
      if (hit && now() - hit.at < FORECAST_TTL) {
        series.push({ lat: st.lat, lon: st.lon, series: hit.series });
        continue;
      }
      const s = await fetchForecastFor(st.lat, st.lon);
      forecastCache.set(key, { series: s, at: now() });
      series.push({ lat: st.lat, lon: st.lon, series: s });
    }
    return series;
  }

  /* ---------------------------------------------------------------- *
   * Routes
   * ---------------------------------------------------------------- */

  /**
   * Create a route from raw GPX text plus the setup form values.
   * Handles processing, k-seeding, and persistence in one call.
   */
  /**
   * Parse a GPX without persisting, for the setup preview (distance, elevation,
   * point count, warnings). Throws GpxError on invalid files so the UI can show
   * the message.
   */
  async function previewGpx(gpxText) {
    const p = processGpx(gpxText, { domParser: deps.domParser });
    let climb = 0;
    if (p.hasElevation) for (const s of p.segments) if (s.eleDelta > 0) climb += s.eleDelta;
    return {
      totalDistance: p.totalDistance,
      hasElevation: p.hasElevation,
      climb: p.hasElevation ? climb : null,
      pointCount: p.segments.length + 1,
      warnings: p.warnings || [],
    };
  }

  async function createRoute(gpxText, setup) {
    const processed = processGpx(gpxText, { domParser: deps.domParser });
    const seededK = computeSeedK(
      setup.seedStillAirSec,
      setup.seedHeadwind20Sec,
      setup.seedTailwind20Sec
    );
    const route = await store.createRoute(processed, setup, seededK);
    return route;
  }

  const listRoutes = () => store.listRoutes();
  const getRoute = (id) => store.getRoute(id);
  const updateRoute = (id, patch) => store.updateRoute(id, patch);
  const deleteRoute = (id) => store.deleteRoute(id);

  /* ---------------------------------------------------------------- *
   * Prediction / verdict for the home screen
   * ---------------------------------------------------------------- */

  async function seedFor(route, model) {
    return {
      baselineSec: route.baselineTimeSec,
      k: model ? model.k : 1.0,
    };
  }

  /**
   * Full home verdict for a route: the alert verdict plus the forecast range
   * and confidence, ready for the UI. Fetches the live forecast.
   */
  async function getHomeVerdict(routeId) {
    const route = await store.getRoute(routeId);
    if (!route) return null;
    const model = await store.getModel(routeId);
    const seed = await seedFor(route, model);
    const stationSeries = await stationSeriesFor(route);

    const predictForArrival = makePredictor({
      route,
      modelState: model ? model.regressionState : learning.createModelState(),
      seed,
      stationSeries,
    });

    const nowMs = now();
    const verdict = evaluateAlert(route, predictForArrival, { nowMs });
    if (!verdict) return { route, verdict: null };

    // forecast spread for the range display
    const next = nextActiveArrival(route, nowMs);
    const range = next
      ? predictWithRange(
          {
            route,
            modelState: model ? model.regressionState : learning.createModelState(),
            seed,
            stationSeries,
          },
          next.arrivalMs
        )
      : null;

    const conf = learning.confidence(
      model ? model.regressionState : learning.createModelState()
    );

    return { route, verdict, range, confidence: conf, model };
  }

  async function listRoutesWithVerdict() {
    const routes = await store.listRoutes();
    const out = [];
    for (const r of routes) {
      out.push(await getHomeVerdict(r.id));
    }
    return out;
  }

  /* ---------------------------------------------------------------- *
   * Ride capture
   * ---------------------------------------------------------------- */

  /**
   * Record a finished ride. Computes the wind_factor that applied (from the
   * forecast in effect), runs the outlier check, then persists — which folds
   * usable rides into the model.
   */
  async function recordRide(capture) {
    const route = await store.getRoute(capture.routeId);
    const model = await store.getModel(capture.routeId);
    const seed = await seedFor(route, model);

    // Reconstruct the wind_factor for this ride from the forecast it carried.
    let windFactor = capture.windFactor;
    let predictedTimeSec = capture.predictedTimeSec ?? null;
    if (windFactor == null && capture.forecastWind) {
      const stationSeries = capture.forecastWind; // [{lat,lon,series}]
      const predictForArrival = makePredictor({
        route,
        modelState: model ? model.regressionState : learning.createModelState(),
        seed,
        stationSeries,
      });
      const p = predictForArrival(capture.endedAt);
      windFactor = p.windFactor;
      predictedTimeSec = p.predictedSec;
    }

    // Outlier auto-flag (does not block; UI may ask the user to confirm).
    let autoFlagged = false;
    if (model && windFactor != null) {
      const chk = learning.checkOutlier(
        model.regressionState,
        windFactor,
        capture.actualTimeSec
      );
      autoFlagged = chk.flagged;
    }

    return store.recordRide({
      ...capture,
      windFactor,
      predictedTimeSec,
      autoFlagged,
    });
  }

  const listRides = (routeId) => store.listRides(routeId);
  const recomputeModel = (routeId) => store.recomputeModel(routeId);

  /**
   * Begin a real GPS ride capture for a route. Uses watchPosition and the same
   * finish detector logic as the tested capture screen. Returns a handle:
   *   { stop() }  — call to cancel
   * and drives the supplied callbacks:
   *   onTick({ elapsedSec, distanceM })
   *   onFinish({ actualSec, distanceM, trace, startedAt, endedAt, forecastWind })
   *
   * forecastWind is captured at ride start so the model can later reconstruct
   * the wind_factor that actually applied.
   */
  async function startRide(route, { onTick, onFinish, geo } = {}) {
    const geoApi = geo || (typeof navigator !== "undefined" ? navigator.geolocation : null);
    if (!geoApi) throw new Error("Geolocation unavailable.");

    const startedAt = now();
    const forecastWind = await stationSeriesFor(route).catch(() => []);
    const endRegion = route.endRegion;
    const trace = [];
    let prev = null;
    let stoppedSince = null;

    const watchId = geoApi.watchPosition(
      (pos) => {
        const fix = { lat: pos.coords.latitude, lon: pos.coords.longitude, t: Date.now() };
        if (prev) {
          // distance accrual
          const moved = haversineLocal(prev.lat, prev.lon, fix.lat, fix.lon);
          trace.push(fix);
          // finish detection: in end region, or stopped near it
          const dEnd = haversineLocal(fix.lat, fix.lon, endRegion.lat, endRegion.lon);
          let finished = false;
          if (dEnd <= endRegion.radius) finished = true;
          else if (dEnd <= endRegion.radius * 3) {
            const dt = (fix.t - prev.t) / 1000;
            const speed = dt > 0 ? moved / dt : 0;
            if (speed < 1.2) {
              if (stoppedSince == null) stoppedSince = fix.t;
              if ((fix.t - stoppedSince) / 1000 >= 20) finished = true;
            } else stoppedSince = null;
          } else stoppedSince = null;

          if (onTick) onTick({ elapsedSec: (fix.t - startedAt) / 1000, distanceM: traceDistance(trace) });
          if (finished) { stop(); if (onFinish) onFinish(buildResult(fix.t)); }
        } else {
          trace.push(fix);
        }
        prev = fix;
      },
      () => {},
      { enableHighAccuracy: true, maximumAge: 0, timeout: 15000 }
    );

    function buildResult(endedAt) {
      return {
        actualSec: (endedAt - startedAt) / 1000,
        distanceM: traceDistance(trace),
        trace, startedAt, endedAt, forecastWind,
      };
    }
    function stop() { geoApi.clearWatch(watchId); }
    return { stop, manualFinish: () => { stop(); if (onFinish) onFinish(buildResult(now())); } };
  }

  function traceDistance(trace) {
    let d = 0;
    for (let i = 1; i < trace.length; i++) d += haversineLocal(trace[i - 1].lat, trace[i - 1].lon, trace[i].lat, trace[i].lon);
    return d;
  }

  /* ---------------------------------------------------------------- *
   * Alert runs (on app open)
   * ---------------------------------------------------------------- */

  // last-run / stored-verdict persistence via settings store
  const lrKey = (rid, t) => `lastRun:${rid}:${t}`;
  const svKey = (rid, day, t) => `verdict:${rid}:${day}:${t}`;

  async function runAlerts(nowMs = now()) {
    return runDueAlerts(
      {
        getRoutes: () => store.listRoutes(),
        nextActiveArrival,
        getModelAndSeed: async (routeId) => {
          const route = await store.getRoute(routeId);
          const model = await store.getModel(routeId);
          return {
            modelState: model
              ? model.regressionState
              : learning.createModelState(),
            seed: await seedFor(route, model),
          };
        },
        fetchStations: (route) => stationSeriesFor(route),
        makePredictor,
        evaluateAlert,
        reconcile: reconcileMorning,
        getLastRun: (rid, t) => readSettingSync(rid, t),
        setLastRun: (rid, t, v) => store.setSetting(lrKey(rid, t), v),
        getStoredVerdict: (rid, day, t) => svCache.get(svKey(rid, day, t)) || null,
        setStoredVerdict: (rid, day, t, v) => {
          svCache.set(svKey(rid, day, t), v);
          store.setSetting(svKey(rid, day, t), v);
        },
        notify: deps.notify || defaultNotify,
      },
      nowMs
    );
  }

  // small sync-ish caches hydrated lazily (settings reads are async; the
  // scheduler calls getLastRun synchronously, so we hydrate a cache first)
  const lrCache = new Map();
  const svCache = new Map();
  function readSettingSync(rid, t) {
    return lrCache.get(lrKey(rid, t)) || null;
  }
  async function hydrateRunCaches() {
    const routes = await store.listRoutes();
    for (const r of routes) {
      for (const t of ["night", "morning"]) {
        const v = await store.getSetting(lrKey(r.id, t));
        if (v) lrCache.set(lrKey(r.id, t), v);
      }
    }
  }
  // keep lrCache in step when the scheduler writes
  const origSet = store.setSetting.bind(store);
  store.setSetting = (key, value) => {
    if (key.startsWith("lastRun:")) lrCache.set(key, value);
    return origSet(key, value);
  };

  /* ---------------------------------------------------------------- *
   * Portability + persistence
   * ---------------------------------------------------------------- */

  const exportAll = () => store.exportAll();
  const importAll = (bundle, mode) => store.importAll(bundle, mode);
  const requestPersistence = () => requestPersistentStorage();

  /* ---------------------------------------------------------------- *
   * Startup
   * ---------------------------------------------------------------- */

  async function start({ onAlerts } = {}) {
    await hydrateRunCaches();
    await requestPersistence();
    installScheduler({
      onActive: async () => {
        const produced = await runAlerts();
        if (onAlerts) onAlerts(produced);
      },
    });
  }

  return {
    store,
    createRoute, previewGpx, listRoutes, getRoute, updateRoute, deleteRoute,
    getHomeVerdict, listRoutesWithVerdict,
    recordRide, listRides, recomputeModel, startRide,
    runAlerts, start,
    exportAll, importAll, requestPersistence,
    stationSeriesFor,
  };
}

/* ------------------------------------------------------------------ *
 * Default notify: route through the service worker if available
 * ------------------------------------------------------------------ */

const EARTH_M = 6371008.8, D2R = Math.PI / 180;
function haversineLocal(aLat, aLon, bLat, bLon) {
  const dLat = (bLat - aLat) * D2R, dLon = (bLon - aLon) * D2R;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(aLat * D2R) * Math.cos(bLat * D2R) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

async function defaultNotify(n) {
  if (
    typeof navigator !== "undefined" &&
    navigator.serviceWorker &&
    navigator.serviceWorker.controller
  ) {
    navigator.serviceWorker.controller.postMessage({
      type: "SHOW_LOCAL_NOTIFICATION",
      notification: {
        title: n.title,
        body: n.body,
        tag: n.tag,
        renotify: n.renotify,
        icon: "/icons/icon-192.png",
        data: { url: "/", routeId: n.routeId },
      },
    });
  }
  // else: the in-app summary (the produced[] return) is the guaranteed channel
}

export { DEFAULT_THRESHOLD_MIN };
