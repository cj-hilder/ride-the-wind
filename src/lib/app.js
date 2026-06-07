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
  computeWindFactor,
  seriesCovers,
} from "./windModel.js";
import * as learning from "./learning.js";
import {
  evaluateAlert,
  arrivalOnDate,
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

// 8-point compass label (e.g. 295° → "NW") — at most two letters, per spec.
const COMPASS8 = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
function compass16(deg) {
  return COMPASS8[Math.round(((deg % 360) + 360) % 360 / 45) % 8];
}

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

  // ----- Ephemeral example route (first-run onboarding) ------------------
  // Shown ONLY when the user has zero real routes, so a brand-new user can see
  // a live Plan tab (real forecast + map) and try the Ride flow before adding
  // anything. NEVER written to storage, never learns, never records — it
  // vanishes the moment a real route exists. Greymouth → Kumara on NZ's West
  // Coast: a real, scenic tourist ride, downsampled to ~60 points so the map
  // and forecast geometry are faithful without bloating the bundle.
  const EXAMPLE_ID = "__example__";
  const EXAMPLE_GPX =
    `<?xml version="1.0"?><gpx version="1.1"><trk><name>Greymouth to Kumara</name><trkseg>` +
    [
      [-42.44959,171.20799], [-42.45233,171.20748], [-42.45412,171.20807], [-42.45668,171.20662],
      [-42.45827,171.20474], [-42.46057,171.20022], [-42.46279,171.19611], [-42.46301,171.19557],
      [-42.46413,171.19355], [-42.46652,171.19204], [-42.46828,171.19082], [-42.47149,171.18875],
      [-42.47472,171.18687], [-42.47792,171.18541], [-42.48086,171.18388], [-42.48656,171.18167],
      [-42.48794,171.18062], [-42.48989,171.17956], [-42.49085,171.17850], [-42.49059,171.17854],
      [-42.49131,171.17727], [-42.49373,171.17587], [-42.49564,171.17510], [-42.49921,171.17356],
      [-42.50029,171.17298], [-42.50294,171.17186], [-42.50585,171.17053], [-42.51199,171.16759],
      [-42.51504,171.16597], [-42.51760,171.16442], [-42.51976,171.16308], [-42.52147,171.16225],
      [-42.52315,171.16118], [-42.52448,171.16014], [-42.52689,171.15890], [-42.52912,171.15753],
      [-42.53096,171.15625], [-42.53266,171.15499], [-42.53405,171.15398], [-42.53499,171.15323],
      [-42.53912,171.15069], [-42.54472,171.14977], [-42.54588,171.14923], [-42.54642,171.14892],
      [-42.55009,171.14425], [-42.55132,171.14294], [-42.55617,171.13896], [-42.56031,171.14278],
      [-42.56043,171.14400], [-42.56263,171.14515], [-42.56262,171.14575], [-42.56597,171.14758],
      [-42.56978,171.14820], [-42.57184,171.14855], [-42.57951,171.15173], [-42.59180,171.15385],
      [-42.60075,171.15405], [-42.62342,171.17827], [-42.62865,171.18405], [-42.62976,171.18680],
    ].map(([la, lo]) => `<trkpt lat="${la}" lon="${lo}"><ele>30</ele></trkpt>`).join("") +
    `</trkseg></trk></gpx>`;

  // Same defaults a brand-new route gets in Setup: 16 km/h still-air, Urban
  // ground effect (k 0.35 both ways). Seeds are derived from the example's
  // actual distance with the identical formula Setup uses, so the example
  // models exactly the starting point a user would create.
  const EXAMPLE_DEFAULT_SPEED_KMH = 16;
  const EXAMPLE_DEFAULT_K = 0.35;

  let _exampleRoute = null;
  function exampleRoute() {
    if (_exampleRoute) return _exampleRoute;
    const p = processGpx(EXAMPLE_GPX, { domParser: deps.domParser });
    const baselineSec = Math.round(p.totalDistance / (EXAMPLE_DEFAULT_SPEED_KMH / 3.6));
    _exampleRoute = {
      id: EXAMPLE_ID,
      name: "Greymouth → Kumara (example)",
      isExample: true,
      description: "",
      segments: p.segments,
      totalDistance: p.totalDistance,
      hasElevation: p.hasElevation,
      startRegion: { lat: p.start.lat, lon: p.start.lon, radius: 60 },
      endRegion: { lat: p.end.lat, lon: p.end.lon, radius: 60 },
      baselineTimeSec: baselineSec,
      seedStillAirSec: baselineSec,
      seedHeadwind20Sec: Math.round(baselineSec * (1 + EXAMPLE_DEFAULT_K)),
      seedTailwind20Sec: Math.round(baselineSec * (1 - EXAMPLE_DEFAULT_K)),
      targetArrival: "08:30",
      timeMode: "arrive",
      arrivalOverrides: {},
      activeDays: ["MO", "TU", "WE", "TH", "FR"],
      alertThresholdMin: null,
      createdAt: now(), updatedAt: now(),
      rawGpx: null,
    };
    return _exampleRoute;
  }
  // Seeded model for the example (k from its seed times; never trained).
  function exampleModel() {
    const r = exampleRoute();
    const k = computeSeedKSplit(r.seedStillAirSec, r.seedHeadwind20Sec, r.seedTailwind20Sec);
    return { routeId: EXAMPLE_ID, kHead: k.kHead ?? 1.0, kTail: k.kTail ?? 1.0,
      regressionState: learning.createModelState(), usableRideCount: 0, lastUpdated: now() };
  }
  const isExampleId = (id) => id === EXAMPLE_ID;

  // Update the example's tuning AND schedule IN MEMORY ONLY, so a user can
  // experiment with speed/k/arrival/days/mode and see the Plan tab respond.
  // Never persisted — resets on restart and when the example vanishes. Mutates
  // the cached example object in place.
  function updateExampleSeeds({ speedKmh, kHead, kTail, targetArrival, activeDays, timeMode }) {
    const r = exampleRoute();
    if (speedKmh != null) {
      const baselineSec = Math.round(r.totalDistance / (speedKmh / 3.6));
      r.baselineTimeSec = baselineSec;
      r.seedStillAirSec = baselineSec;
    }
    const kH = kHead != null ? kHead : null;
    const kT = kTail != null ? kTail : null;
    if (kH != null) r.seedHeadwind20Sec = Math.round(r.seedStillAirSec * (1 + kH));
    if (kT != null) r.seedTailwind20Sec = Math.round(r.seedStillAirSec * (1 - kT));
    if (targetArrival != null) r.targetArrival = targetArrival;
    if (activeDays != null) r.activeDays = activeDays;
    if (timeMode != null) r.timeMode = timeMode === "depart" ? "depart" : "arrive";
    r.updatedAt = now();
  }

  // In-memory caches for a session: avoid re-fetching the same station within
  // a short window. Keyed by rounded lat/lon.
  const forecastCache = new Map();
  const FORECAST_TTL = 30 * 60 * 1000; // 30 min

  async function stationSeriesFor(route) {
    const stations = chooseStations(route);
    // Stations are independent fetches — run them in parallel (a route has only
    // a few). Each still checks/populates the shared TTL cache.
    return Promise.all(stations.map(async (st) => {
      const key = `${st.lat.toFixed(2)},${st.lon.toFixed(2)}`;
      const hit = forecastCache.get(key);
      if (hit && now() - hit.at < FORECAST_TTL) {
        return { lat: st.lat, lon: st.lon, series: hit.series };
      }
      const series = await fetchForecastFor(st.lat, st.lon);
      forecastCache.set(key, { series, at: now() });
      return { lat: st.lat, lon: st.lon, series };
    }));
  }

  const ensembleCache = new Map();

  // Most recent forecast fetch time across this route's stations (for the
  // tech-info panel's "last/next update"). null if none cached yet.
  function forecastFetchedAt(route) {
    const stations = chooseStations(route);
    let latest = null;
    for (const st of stations) {
      const hit = forecastCache.get(`${st.lat.toFixed(2)},${st.lon.toFixed(2)}`);
      if (hit && (latest == null || hit.at > latest)) latest = hit.at;
    }
    return latest;
  }
  // Fetch per-member ensemble wind for each station. Returns null on any
  // failure so the caller can fall back to the deterministic range — the app
  // must never block on the ensemble.
  async function ensembleStationsFor(route) {
    try {
      const stations = chooseStations(route);
      // Independent per-station fetches — run in parallel; each uses the cache.
      return await Promise.all(stations.map(async (st) => {
        const key = `${st.lat.toFixed(2)},${st.lon.toFixed(2)}`;
        const hit = ensembleCache.get(key);
        if (hit && now() - hit.at < FORECAST_TTL) {
          return { lat: st.lat, lon: st.lon, members: hit.members };
        }
        const members = await fetchEnsembleFor(st.lat, st.lon);
        ensembleCache.set(key, { members, at: now() });
        return { lat: st.lat, lon: st.lon, members };
      }));
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
  // Geometry-only example wind factors for the ground-effect display: a steady
  // 20 km/h wind from the route's mean bearing (headward) and its opposite
  // (tailward), simulated over the actual segments. k-independent. Weight by
  // segment distance (the factor is a weighted mean of a speed-independent
  // per-segment quantity, so exact timing isn't needed for the example).
  function exampleFor(segments) {
    const DEG = Math.PI / 180;
    let bx = 0, by = 0;
    for (const s of segments) { bx += Math.cos(s.bearing * DEG); by += Math.sin(s.bearing * DEG); }
    const meanBearing = (Math.atan2(by / segments.length, bx / segments.length) / DEG + 360) % 360;
    const w = segments.map((s) => s.distance || 1);
    const steady = (fromDeg) => () => ({ speed: 20, fromDeg });
    return {
      meanBearingDeg: Math.round(meanBearing),
      headBearingLabel: compass16(meanBearing),
      tailBearingLabel: compass16((meanBearing + 180) % 360),
      headFactor: computeWindFactor(segments, steady(meanBearing), w),
      tailFactor: computeWindFactor(segments, steady((meanBearing + 180) % 360), w),
    };
  }

  // Downsampled lat/lon polyline for a static map: all segment start points
  // plus the final end point, reduced to ~maxPts (always keeping first & last)
  // so it fits within a static-map URL length budget. Shape reads fine for a
  // commute at this resolution.
  function routePolyline(segments, end, maxPts = 40) {
    const pts = segments.map((s) => ({ lat: s.lat, lon: s.lon }));
    if (end) pts.push({ lat: end.lat, lon: end.lon });
    if (pts.length <= maxPts) return pts;
    const step = (pts.length - 1) / (maxPts - 1);
    const out = [];
    for (let i = 0; i < maxPts; i++) out.push(pts[Math.round(i * step)]);
    out[out.length - 1] = pts[pts.length - 1]; // guarantee the true end
    return out;
  }

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
      example: exampleFor(p.segments),
      polyline: routePolyline(p.segments, p.end),
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
  const reorderRoutes = (orderedIds) => store.reorderRoutes(orderedIds);

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
  async function getHomeVerdict(routeId, dayMs = null, exploredHHMM = null, forceDepart = false) {
    const route = isExampleId(routeId) ? exampleRoute() : await store.getRoute(routeId);
    if (!route) return null;
    const model = isExampleId(routeId) ? exampleModel() : await store.getModel(routeId);
    const seed = await seedFor(route, model);
    const stationSeries = await stationSeriesFor(route);

    const nowMs = now();
    // The Plan tab passes a specific calendar day (ignoring activeDays/past-time),
    // optionally with an Explore time override. With no day given (the route-list
    // summary), default to today's configured time. There is no scheduler: PWAs
    // can't reliably wake to notify when closed, so the app shows a live
    // countdown beside the time instead of dispatching alerts.
    const next = arrivalOnDate(route, dayMs != null ? dayMs : nowMs, exploredHHMM || undefined);

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

    const verdict = evaluateAlert(route, predictForArrival, {
      nowMs,
      fixedArrival: next,
    });
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

        // The deterministic forecast is just another forecast — often better at
        // short lead (high resolution, near current conditions) but not a
        // different kind of thing. So we fold it INTO the ensemble as one extra
        // weighted member and let a single percentile computation produce the
        // center and the spread together (consistent by construction). Its
        // weight (how many ordinary members it counts as) ramps from M/2 at
        // lead 0 — making it ≈⅓ of the weighted population — down to 0 at 12 h,
        // AND is forced to 0 for any arrival after tonight (tomorrow on is pure
        // ensemble). Whichever zeros it first wins.
        const memberCount = Math.min(...ensembleStations.map((s) => s.members.length));
        const leadH = (next.arrivalMs - nowMs) / 3600000;
        const endOfToday = (() => { const d = new Date(nowMs); d.setHours(24, 0, 0, 0); return d.getTime(); })();
        const ramp = Math.max(0, Math.min(1, (12 - leadH) / 12)); // 1 at lead 0 → 0 at 12h
        const isToday = next.arrivalMs < endOfToday;
        const detWeight = isToday ? ramp * (memberCount / 2) : 0;

        range = predictEnsembleRange(
          { ...rangeArgs, ensembleStations },
          next.arrivalMs,
          {
            loPct, hiPct,
            detSec: verdict ? verdict.predictedSec : null,
            detFactor: verdict ? verdict.windFactor : null,
            detWeight,
          }
        );
        // Keep the displayed central estimate ("likely", arrival, delta, debug)
        // equal to the unified weighted median, so everything agrees.
        if (range && verdict && Number.isFinite(range.centerSec)) {
          verdict.predictedSec = range.centerSec;
        }
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
    // Go now (Explore) forces this one instance to be treated as a departure at
    // the given time, regardless of the route's configured mode.
    const timeMode = forceDepart ? "depart" : (route.timeMode === "depart" ? "depart" : "arrive");
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

      // Diagnostics. The linear mean headwind and crosswind are sampled per
      // segment at the time the rider reaches it; they describe the wind but do
      // NOT by themselves determine wind_factor (which is a signed, quadratic,
      // time-weighted quantity that head/tail segments can cancel within).
      const DEG = Math.PI / 180;
      let sx = 0, sy = 0, head = 0, cross = 0, spd = 0, tt = 0;
      let segMs = departMs;
      let firstW = null;
      route.segments.forEach((s, i) => {
        const mid = segMs + (times[i] * 1000) / 2;
        const ws = windFn(s.lat, s.lon, mid);
        if (i === Math.floor(route.segments.length / 2)) firstW = ws;
        sx += Math.cos(s.bearing * DEG); sy += Math.sin(s.bearing * DEG);
        const h = ws.speed * Math.cos((ws.fromDeg - s.bearing) * DEG);
        const c = ws.speed * Math.sin((ws.fromDeg - s.bearing) * DEG);
        head += h * times[i];
        cross += Math.abs(c) * times[i];
        spd += ws.speed * times[i];
        tt += times[i];
        segMs += times[i] * 1000;
      });
      const w = firstW || windFn(route.segments[0].lat, route.segments[0].lon, departMs);
      const avgBearing = (Math.atan2(sy / route.segments.length, sx / route.segments.length) / DEG + 360) % 360;
      const meanHead = head / tt;
      // Effort headwind: the single equivalent headwind that, run through the
      // signed effort law, reproduces wind_factor exactly —
      // wind_factor = sign · (effortHead/20)², so effortHead = sign·√|wf|·20.
      // Defined as the inverse of the factor (not an RMS of segment headwinds),
      // so it reconciles in every case, including a near-perpendicular wind on a
      // winding route where head and tail segments largely cancel.
      const wf = verdict.windFactor ?? 0;
      const effortHead = Math.sign(wf) * Math.sqrt(Math.abs(wf)) * 20;
      const fetchedAt = forecastFetchedAt(route);
      debug = {
        windFromDeg: Math.round(w.fromDeg),
        windFromLabel: compass16(w.fromDeg),
        windSpeedKmh: Math.round(spd / tt),
        avgBearingDeg: Math.round(avgBearing),
        meanHeadwindKmh: +meanHead.toFixed(1),      // linear time-weighted mean
        effortHeadwindKmh: +effortHead.toFixed(1),  // equivalent headwind behind wind_factor
        meanCrosswindKmh: +(cross / tt).toFixed(1),
        windFactor: +(verdict.windFactor ?? 0).toFixed(3),
        baselineSec: Math.round(route.baselineTimeSec),
        predictedSec: Math.round(verdict.predictedSec),
        slowSec: range ? Math.round(range.highSec) : null,
        fastSec: range ? Math.round(range.lowSec) : null,
        forecastUpdatedMs: fetchedAt,
        forecastNextUpdateMs: fetchedAt != null ? fetchedAt + FORECAST_TTL : null,
        kIdHead: !!conf.idHead,
        kIdTail: !!conf.idTail,
      };
    }

    // Carry the wind strength onto windEffect so the UI can apply the
    // "light" / "no wind effect" thresholds (7.5 km/h). meanHeadKmh is the
    // magnitude of the time-weighted mean headwind; windSpeedKmh the forecast
    // wind speed sampled mid-route.
    if (windEffect && debug) {
      windEffect.meanHeadKmh = Math.abs(debug.meanHeadwindKmh ?? 0);
      windEffect.windSpeedKmh = debug.windSpeedKmh ?? 0;
    }

    return { route, verdict, range, conservative, windEffect, rangeUnavailable, confidence: conf, expect, debug, model };
  }

  async function listRoutesWithVerdict(onProgress) {
    const routes = await store.listRoutes();
    // First-run: no real routes yet → show the ephemeral example so the Plan and
    // Ride tabs are explorable. It is never stored and disappears once a real
    // route is added.
    if (routes.length === 0) {
      if (onProgress) onProgress(0, 1);
      const v = await getHomeVerdict(EXAMPLE_ID);
      if (onProgress) onProgress(1, 1);
      return v ? [v] : [];
    }
    const total = routes.length;
    if (onProgress) onProgress(0, total);
    const out = new Array(total);
    let done = 0;
    // Bounded concurrency: process a few routes at once so several slow fetches
    // overlap instead of running strictly one-after-another, without firing all
    // routes simultaneously (which would flood a slow link and lose the benefit
    // of the per-station cache warming as earlier routes complete).
    const LIMIT = 4;
    let next = 0;
    async function worker() {
      while (next < total) {
        const i = next++;
        out[i] = await getHomeVerdict(routes[i].id);
        done++;
        if (onProgress) onProgress(done, total);
      }
    }
    await Promise.all(Array.from({ length: Math.min(LIMIT, total) }, worker));
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
    // The example route is ephemeral — a demo ride runs the full flow but
    // persists nothing and never trains a model.
    if (isExampleId(capture.routeId)) {
      return { skipped: true, isExample: true };
    }
    const route = await store.getRoute(capture.routeId);
    const model = await store.getModel(capture.routeId);
    const seed = await seedFor(route, model);

    // Reconstruct the wind_factor for this ride from the forecast it carried.
    let windFactor = capture.windFactor;
    let predictedTimeSec = capture.predictedTimeSec ?? null;
    if (windFactor == null && capture.forecastWind && capture.forecastWind.length) {
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
   * Tuning state for the route editor's manual controls. Returns the route's
   * distance, the current manual (seed-derived) speed/k, and — when the model
   * has learned at least one direction — the learned speed/k and which
   * directions are identifiable. The editor uses this to decide Manual vs
   * Learned display and to drive the off-scale indicators.
   */
  async function routeTuning(routeId) {
    const route = isExampleId(routeId) ? exampleRoute() : await store.getRoute(routeId);
    if (!route) return null;
    const model = isExampleId(routeId) ? exampleModel() : await store.getModel(routeId);
    const seed = await seedFor(route, model);
    const distanceM = route.totalDistance;

    // Route stats for the same panel shown at GPX load (derived from the stored
    // segments — no re-parse needed).
    let climb = 0;
    if (route.hasElevation) for (const s of route.segments) if (s.eleDelta > 0) climb += s.eleDelta;
    const stats = {
      totalDistance: distanceM,
      hasElevation: route.hasElevation,
      climb: route.hasElevation ? climb : null,
      pointCount: route.segments.length + 1,
    };

    // Manual (seed) view: speed from baseline, k from seeds.
    const manualSpeedKmh = Math.round((distanceM / route.baselineTimeSec) * 3.6);
    const manual = { speedKmh: manualSpeedKmh, kHead: seed.kHead, kTail: seed.kTail };

    // Learned view: fit the accumulated rides. Identifiable per direction.
    let learned = null;
    if (model && model.regressionState) {
      const fit = learning.fitModel(model.regressionState, {
        seedKHead: seed.kHead, seedKTail: seed.kTail, seedBaselineSec: route.baselineTimeSec,
      });
      if (fit && (fit.identifiableHead || fit.identifiableTail)) {
        learned = {
          speedKmh: Math.round((distanceM / fit.baselineSec) * 3.6),
          kHead: fit.kHead, kTail: fit.kTail,
          idHead: !!fit.identifiableHead, idTail: !!fit.identifiableTail,
        };
      }
    }
    return { distanceM, stats, manual, learned, example: exampleFor(route.segments),
      polyline: routePolyline(route.segments, route.endRegion) };
  }

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
  /**
   * One-shot distance (metres) from the device's current position to the
   * route's start point. Resolves to null if geolocation is unavailable, denied,
   * or times out — callers should treat null as "couldn't check" and proceed
   * without the warning. Never rejects.
   */
  function distanceToStart(route, { geo } = {}) {
    const geoApi = geo || (typeof navigator !== "undefined" ? navigator.geolocation : null);
    const start = route.startRegion;
    if (!geoApi || !start) return Promise.resolve(null);
    return new Promise((resolve) => {
      let settled = false;
      const done = (v) => { if (!settled) { settled = true; resolve(v); } };
      try {
        geoApi.getCurrentPosition(
          (pos) => done(Math.round(haversineLocal(pos.coords.latitude, pos.coords.longitude, start.lat, start.lon))),
          () => done(null),
          { enableHighAccuracy: true, timeout: 8000, maximumAge: 30000 }
        );
      } catch { done(null); }
    });
  }

  async function startRide(route, { onTick, onFinish, geo } = {}) {
    const geoApi = geo || (typeof navigator !== "undefined" ? navigator.geolocation : null);
    if (!geoApi) throw new Error("Geolocation unavailable.");

    const startedAt = now();
    const forecastWind = await stationSeriesFor(route).catch(() => []);
    const endRegion = route.endRegion;
    const trace = [];
    let prev = null;
    let stoppedSince = null;
    // Pause support: total paused ms is excluded from the ride time, so a rider
    // can stop (lights, coffee, mechanical) without inflating the learned time.
    let paused = false;
    let pauseStartedAt = null;
    let totalPausedMs = 0;

    const watchId = geoApi.watchPosition(
      (pos) => {
        const fix = { lat: pos.coords.latitude, lon: pos.coords.longitude, t: Date.now() };
        // While paused, ignore movement entirely — no distance, no finish
        // detection, no trace growth, and the clock is held.
        if (paused) { prev = fix; return; }
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

          if (onTick) onTick({ elapsedSec: (fix.t - startedAt - totalPausedMs) / 1000, distanceM: traceDistance(trace) });
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
      // close an open pause at finish
      const pausedMs = totalPausedMs + (paused && pauseStartedAt ? (endedAt - pauseStartedAt) : 0);
      return {
        actualSec: (endedAt - startedAt - pausedMs) / 1000,
        distanceM: traceDistance(trace),
        trace, startedAt, endedAt, pausedSec: pausedMs / 1000, forecastWind,
      };
    }
    function stop() { geoApi.clearWatch(watchId); }
    return {
      stop,
      pause: () => { if (!paused) { paused = true; pauseStartedAt = Date.now(); } },
      resume: () => { if (paused) { totalPausedMs += Date.now() - pauseStartedAt; paused = false; pauseStartedAt = null; } },
      isPaused: () => paused,
      manualFinish: () => { stop(); if (onFinish) onFinish(buildResult(now())); },
    };
  }

  function traceDistance(trace) {
    let d = 0;
    for (let i = 1; i < trace.length; i++) d += haversineLocal(trace[i - 1].lat, trace[i - 1].lon, trace[i].lat, trace[i].lon);
    return d;
  }

  /* ---------------------------------------------------------------- *
   * Alert runs (on app open)
   * ---------------------------------------------------------------- */

  /* ---------------------------------------------------------------- *
   * Portability + persistence
   * ---------------------------------------------------------------- */

  const exportAll = () => store.exportAll();
  const importAll = (bundle, mode) => store.importAll(bundle, mode);
  const requestPersistence = () => requestPersistentStorage();

  /* ---------------------------------------------------------------- *
   * Startup. No scheduler/notifications: a PWA can't reliably wake to
   * notify when closed, so the app shows a live countdown beside the
   * departure time while open instead of dispatching alerts.
   * ---------------------------------------------------------------- */

  async function start() {
    await requestPersistence();
  }

  return {
    store,
    createRoute, previewGpx, listRoutes, getRoute, updateRoute, resetRoute, deleteRoute, reorderRoutes,
    getHomeVerdict, listRoutesWithVerdict,
    recordRide, listRides, recomputeModel, startRide, distanceToStart, routeTuning, updateExampleSeeds,
    start,
    exportAll, importAll, requestPersistence,
    stationSeriesFor,
  };
}

/* ------------------------------------------------------------------ *
 * Geometry helper
 * ------------------------------------------------------------------ */

const EARTH_M = 6371008.8, D2R = Math.PI / 180;
function haversineLocal(aLat, aLon, bLat, bLon) {
  const dLat = (bLat - aLat) * D2R, dLon = (bLon - aLon) * D2R;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(aLat * D2R) * Math.cos(bLat * D2R) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

export { DEFAULT_THRESHOLD_MIN };
