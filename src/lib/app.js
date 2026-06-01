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
  seedKSplit as computeSeedKSplit,
  fetchForecast as realFetchForecast,
  fetchEnsemble as realFetchEnsemble,
  parseForecast,
  makeWindFn,
  segmentTimes,
  seriesCovers,
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
  predictEnsembleRange,
  speedFromBaseline,
} from "./prediction.js";
import { whatToExpect } from "./whatToExpect.js";
import {
  Store,
  MemoryBackend,
  IndexedDBBackend,
  requestPersistentStorage,
} from "./storage.js";
import { runDueAlerts, installScheduler } from "./scheduler.js";

// Local HH:MM (24h) formatter, device local time.
function hhmm(ms) {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

// Clamp the conservatism percentile to a sane band (50–99); guards against a
// bad stored value. Below 50 would invert slow/fast; 100 is the noisy extreme.
function clampPct(p) {
  const n = Number(p);
  if (!Number.isFinite(n)) return 95;
  return Math.max(50, Math.min(99, n));
}


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

  // Optional ensemble fetcher → per-member wind series. Defaults to Open-Meteo
  // ensemble; if it throws, the range falls back to the deterministic method.
  const fetchEnsembleFor =
    deps.fetchEnsembleFor ||
    (async (lat, lon) => realFetchEnsemble(lat, lon));

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

  const ensembleCache = new Map();
  // Fetch per-member ensemble wind for each station. Returns null on any
  // failure so the caller can fall back to the deterministic range — the app
  // must never block on the ensemble.
  async function ensembleStationsFor(route) {
    try {
      const stations = chooseStations(route);
      const out = [];
      for (const st of stations) {
        const key = `${st.lat.toFixed(2)},${st.lon.toFixed(2)}`;
        const hit = ensembleCache.get(key);
        if (hit && now() - hit.at < FORECAST_TTL) {
          out.push({ lat: st.lat, lon: st.lon, members: hit.members });
          continue;
        }
        const members = await fetchEnsembleFor(st.lat, st.lon);
        ensembleCache.set(key, { members, at: now() });
        out.push({ lat: st.lat, lon: st.lon, members });
      }
      return out;
    } catch {
      return null;
    }
  }

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
    const seededK = computeSeedKSplit(
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
  const resetRoute = (id, baseValues) => store.resetRoute(id, baseValues);
  const deleteRoute = (id) => store.deleteRoute(id);

  /* ---------------------------------------------------------------- *
   * Prediction / verdict for the home screen
   * ---------------------------------------------------------------- */

  async function seedFor(route, model) {
    return {
      baselineSec: route.baselineTimeSec,
      kHead: model ? (model.kHead ?? 1.0) : 1.0,
      kTail: model ? (model.kTail ?? 1.0) : 1.0,
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

    const nowMs = now();
    const next = nextActiveArrival(route, nowMs);

    // Guard: does the fetched forecast actually reach the ride day? A ride up to
    // a week out must not silently use clamped (stale) end-of-forecast data. If
    // any station's series doesn't cover the arrival, we treat the forecast as
    // unavailable for this ride rather than predicting from the wrong day.
    const forecastReaches =
      next &&
      stationSeries.length > 0 &&
      stationSeries.every((st) => seriesCovers(st.series, next.arrivalMs));

    const predictForArrival = makePredictor({
      route,
      modelState: model ? model.regressionState : learning.createModelState(),
      seed,
      stationSeries,
    });

    const verdict = evaluateAlert(route, predictForArrival, { nowMs });
    if (!verdict) return { route, verdict: null };

    // Forecast spread: ALWAYS from the real ensemble. No synthetic ±% range.
    // If the ensemble is unavailable OR the forecast doesn't reach the ride day,
    // we do not invent a spread — central prediction, flagged.
    let range = null;
    let rangeUnavailable = false;
    if (next && forecastReaches) {
      const rangeArgs = {
        route,
        modelState: model ? model.regressionState : learning.createModelState(),
        seed,
      };
      const ensembleStations = await ensembleStationsFor(route);
      // ensemble must also cover the arrival day
      const ensembleReaches =
        ensembleStations &&
        ensembleStations.every((st) =>
          st.members.every((m) => seriesCovers(m, next.arrivalMs))
        );
      if (ensembleReaches) {
        // Conservatism percentile (tunable). The slow end anchors here; the
        // fast end mirrors at its complement. NOT a calibrated on-time
        // probability — a deliberate safety margin against an under-dispersive
        // ensemble. Default 95 (≈ rarely late) rather than 90 (≈1-in-10 late).
        const hiPct = clampPct(await store.getSetting("conservatismPct", 95));
        const loPct = 100 - hiPct;
        range = predictEnsembleRange(
          { ...rangeArgs, ensembleStations },
          next.arrivalMs,
          { loPct, hiPct }
        );
      }
      if (!range) rangeUnavailable = true;
    } else if (next) {
      rangeUnavailable = true; // forecast horizon doesn't reach the ride
    }

    const conf = learning.confidence(
      model ? model.regressionState : learning.createModelState()
    );

    // Conservative departure: anchor on the SLOW end of the forecast range so
    // the rider arrives on time even on the slower side. Target = latest arrival.
    // Departure AND headline both drive off the slow end (the safe number).
    let conservative = null;
    let windEffect = null;
    const timeMode = route.timeMode === "depart" ? "depart" : "arrive";
    // `next.arrivalMs` is the entered-time instant: an arrival in arrive mode,
    // a departure in depart mode.
    const baselineDepartureMs =
      next && timeMode === "arrive" ? next.arrivalMs - route.baselineTimeSec * 1000 : null;

    if (next && range && timeMode === "depart") {
      // Fixed departure: the rider leaves at the entered time; we show the
      // arrival RANGE. arrival = departure + rideTime. The caution percentile
      // already widened range.highSec, so the latest-arrival reflects it.
      const departureMs = next.arrivalMs; // entered time = departure
      const fastSec = range.lowSec;
      const slowSec = range.highSec;
      const earliestArrivalMs = departureMs + fastSec * 1000;
      const latestArrivalMs = departureMs + slowSec * 1000;
      conservative = {
        mode: "depart",
        departureMs,
        departureHHMM: hhmm(departureMs),
        earliestArrivalMs,
        earliestArrivalHHMM: hhmm(earliestArrivalMs),
        latestArrivalMs,
        latestArrivalHHMM: hhmm(latestArrivalMs),
        windowMin: Math.round((latestArrivalMs - earliestArrivalMs) / 60000),
      };
      // No leave-early decision in depart mode (departure is fixed), but the
      // wind still classifies the ride for the headline. Use the slow-end delta
      // vs baseline, same threshold as arrive mode.
      verdict.departureMs = departureMs;
      verdict.departureHHMM = hhmm(departureMs);
      const dDeltaSec = range.highSec - route.baselineTimeSec;
      const thr = (verdict.thresholdMin ?? 4) * 60;
      verdict.verdict = dDeltaSec > thr ? "headwind" : dDeltaSec < -thr ? "tailwind" : "normal";
      verdict.deltaMin = Math.round(dDeltaSec / 60);

      const loEffectMin = Math.round((range.lowSec - route.baselineTimeSec) / 60);
      const hiEffectMin = Math.round((range.highSec - route.baselineTimeSec) / 60);
      let direction, headPct = null;
      if (hiEffectMin <= 0 && loEffectMin >= -1) direction = "calm";
      else if (hiEffectMin <= 0) direction = "tailwind";
      else if (loEffectMin >= 0) direction = "headwind";
      else { direction = "mixed"; headPct = Math.round(range.headProb * 100); }
      windEffect = {
        direction, headPct, loMin: loEffectMin, hiMin: hiEffectMin,
        fastMin: Math.round(range.lowSec / 60),
        slowMin: Math.round(range.highSec / 60),
        likelyMin: Math.round(range.centerSec / 60),
      };
    } else if (next && range) {
      // Effect at each end, in whole minutes vs baseline (+ = slower).
      const loEffectMin = Math.round((range.lowSec - route.baselineTimeSec) / 60);
      const hiEffectMin = Math.round((range.highSec - route.baselineTimeSec) / 60);

      // Departure anchors on the slow end. SNAP it to baseline only when it is
      // a sub-minute HEADWIND — i.e. fractionally ABOVE baseline but rounding to
      // 0 — so it doesn't pull the departure earlier while the display shows 0.
      // A slow end at or below baseline is a genuine (if small) tailwind benefit
      // and must pass through untouched; a multi-minute headwind is never
      // snapped, preserving the on-time guarantee.
      const slowAboveBaseline = range.highSec > route.baselineTimeSec;
      const slowSec = slowAboveBaseline && hiEffectMin === 0
        ? route.baselineTimeSec
        : range.highSec;
      const fastSec = range.lowSec;
      const departureMs = next.arrivalMs - slowSec * 1000;
      const earliestArrivalMs = departureMs + fastSec * 1000;
      conservative = {
        mode: "arrive",
        departureMs,
        departureHHMM: hhmm(departureMs),
        latestArrivalMs: next.arrivalMs,
        latestArrivalHHMM: verdict.arrivalHHMM,
        earliestArrivalMs,
        earliestArrivalHHMM: hhmm(earliestArrivalMs),
        windowMin: Math.round((next.arrivalMs - earliestArrivalMs) / 60000),
      };
      const deltaSec = slowSec - route.baselineTimeSec;
      verdict.departureMs = departureMs;
      verdict.departureHHMM = conservative.departureHHMM;
      verdict.normalDepartureHHMM = hhmm(baselineDepartureMs);
      verdict.deltaSec = deltaSec;
      verdict.deltaMin = Math.round(deltaSec / 60);
      verdict.verdict = deltaSec > (verdict.thresholdMin ?? 4) * 60 ? "headwind"
        : deltaSec < -(verdict.thresholdMin ?? 4) * 60 ? "tailwind" : "normal";

      // Wind-effect description, classified from the rounded effect range so the
      // word and the numbers always agree.
      //  - slow end ≤ 0 and fast end ≥ −1  → "No wind" (negligible; e.g. −1 to 0)
      //  - whole range ≤ 0 (faster), fast end ≤ −2 → tailwind
      //  - whole range ≥ 0 (slower), at least one end > 0 → headwind
      //  - straddles zero → show headwind probability
      let direction, headPct = null;
      if (hiEffectMin <= 0 && loEffectMin >= -1) {
        direction = "calm";
      } else if (hiEffectMin <= 0) {
        direction = "tailwind";
      } else if (loEffectMin >= 0) {
        direction = "headwind";
      } else {
        direction = "mixed";
        headPct = Math.round(range.headProb * 100);
      }
      windEffect = {
        direction,
        headPct,
        loMin: loEffectMin,
        hiMin: hiEffectMin,
        fastMin: Math.round(range.lowSec / 60),
        slowMin: Math.round(range.highSec / 60),
        likelyMin: Math.round(range.centerSec / 60),
      };
    } else if (next && rangeUnavailable && timeMode === "depart") {
      // Fixed departure, no forecast range: single central arrival estimate.
      const departureMs = next.arrivalMs;
      const arrivalMs = departureMs + verdict.predictedSec * 1000;
      conservative = {
        mode: "depart",
        departureMs,
        departureHHMM: hhmm(departureMs),
        earliestArrivalMs: arrivalMs,
        earliestArrivalHHMM: hhmm(arrivalMs),
        latestArrivalMs: arrivalMs,
        latestArrivalHHMM: hhmm(arrivalMs),
        windowMin: 0,
        unavailable: true,
      };
      verdict.departureMs = departureMs;
      verdict.departureHHMM = hhmm(departureMs);
      const duDeltaSec = verdict.predictedSec - route.baselineTimeSec;
      const duThr = (verdict.thresholdMin ?? 4) * 60;
      verdict.verdict = duDeltaSec > duThr ? "headwind" : duDeltaSec < -duThr ? "tailwind" : "normal";
      verdict.deltaMin = Math.round(duDeltaSec / 60);
    } else if (next && rangeUnavailable) {
      // Ensemble unavailable: central prediction, no conservative padding.
      const centralSec = verdict.predictedSec;
      const departureMs = next.arrivalMs - centralSec * 1000;
      conservative = {
        mode: "arrive",
        departureMs,
        departureHHMM: hhmm(departureMs),
        latestArrivalMs: next.arrivalMs,
        latestArrivalHHMM: verdict.arrivalHHMM,
        earliestArrivalMs: next.arrivalMs,
        earliestArrivalHHMM: verdict.arrivalHHMM,
        windowMin: 0,
        unavailable: true,
      };
      const deltaSec = centralSec - route.baselineTimeSec;
      verdict.departureMs = departureMs;
      verdict.departureHHMM = conservative.departureHHMM;
      verdict.normalDepartureHHMM = hhmm(baselineDepartureMs);
      verdict.deltaSec = deltaSec;
      verdict.deltaMin = Math.round(deltaSec / 60);
      verdict.verdict = deltaSec > (verdict.thresholdMin ?? 4) * 60 ? "headwind"
        : deltaSec < -(verdict.thresholdMin ?? 4) * 60 ? "tailwind" : "normal";
    }

    // "What to expect" line: temp / rain / side wind at the arrival window.
    let expect = null;
    let debug = null;
    if (next) {
      const baseSpeed = speedFromBaseline(route.totalDistance, route.baselineTimeSec);
      const times = segmentTimes(route.segments, baseSpeed, { useGradient: true });
      const windFn = makeWindFn(stationSeries);
      const departMs = conservative ? conservative.departureMs : next.arrivalMs - verdict.predictedSec * 1000;
      expect = whatToExpect({ segments: route.segments, times, windFn, departMs });

      // Diagnostics: representative wind, route bearing, signed components.
      const mid = route.segments[Math.floor(route.segments.length / 2)];
      const w = windFn(mid.lat, mid.lon, departMs);
      // average route bearing (circular mean) and the time-weighted head/cross
      let sx = 0, sy = 0, head = 0, cross = 0, tt = 0;
      const DEG = Math.PI / 180;
      route.segments.forEach((s, i) => {
        sx += Math.cos(s.bearing * DEG); sy += Math.sin(s.bearing * DEG);
        const h = w.speed * Math.cos((w.fromDeg - s.bearing) * DEG);
        const c = w.speed * Math.sin((w.fromDeg - s.bearing) * DEG);
        head += h * times[i]; cross += Math.abs(c) * times[i]; tt += times[i];
      });
      const avgBearing = (Math.atan2(sy / route.segments.length, sx / route.segments.length) / DEG + 360) % 360;
      debug = {
        windFromDeg: Math.round(w.fromDeg),
        windSpeedKmh: Math.round(w.speed),
        avgBearingDeg: Math.round(avgBearing),
        meanHeadwindKmh: +(head / tt).toFixed(1), // + = headwind, − = tailwind
        meanCrosswindKmh: +(cross / tt).toFixed(1),
        windFactor: +(verdict.windFactor ?? 0).toFixed(3),
        baselineSec: Math.round(route.baselineTimeSec),
        predictedSec: Math.round(verdict.predictedSec),
        slowSec: range ? Math.round(range.highSec) : null,
        fastSec: range ? Math.round(range.lowSec) : null,
      };
    }

    return { route, verdict, range, conservative, windEffect, rangeUnavailable, confidence: conf, expect, debug, model };
  }

  async function listRoutesWithVerdict(onProgress) {
    const routes = await store.listRoutes();
    const total = routes.length;
    if (onProgress) onProgress(0, total);
    const out = [];
    for (let i = 0; i < routes.length; i++) {
      out.push(await getHomeVerdict(routes[i].id));
      if (onProgress) onProgress(i + 1, total);
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
    createRoute, previewGpx, listRoutes, getRoute, updateRoute, resetRoute, deleteRoute,
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
