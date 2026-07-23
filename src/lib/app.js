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

import { processGpx, processTrace, reverseRoute } from "./gpxRoute.js";
import {
  seedKSplit as computeSeedKSplit,
  effortNorm,
  invHead,
  invTail,
  windComponent,
  DEFAULT_K,
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
import { whatToExpect, rainLevel } from "./whatToExpect.js";
import { formatTimeOfDay } from "./format.js";
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
  // Delegates to the display format seam so every verdict time (departure,
  // arrival, earliest/latest, normal) respects the 12/24-hour setting in one
  // place. Falls back to a bare 24h render if ms is invalid.
  return formatTimeOfDay(ms) || "";
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
  // The example ride uses the SAME wind-attenuation default as a brand-new
  // route (DEFAULT_K) — it models exactly the starting prior a user would get,
  // with no separate demo value.

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
      // v2 forward map: seed time = still·(1 + f_branch(k·w_ref)) — the exact
      // counterpart of seedKSplit's inverse, so k round-trips through seed times.
      seedHeadwind20Sec: Math.round(baselineSec * (1 + effortNorm(DEFAULT_K * 20))),
      seedTailwind20Sec: Math.round(baselineSec * (1 + effortNorm(-DEFAULT_K * 20))),
      // Mirror the default new-route experience; toggleable in-memory so the
      // demo illustrates the difference between manual and learn.
      baselineMode: "learn",
      kMode: "learn",
      split: false,
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
  // Config for the example route. It mirrors the default NEW-route experience
  // (learn/learn) so the onboarding demo teaches what the user will actually
  // see: the "until enough rides recorded" status and the Manual/Learn toggles
  // are themselves explanatory. The example has no persisted rides, so learn
  // falls back to the slider values — identical prediction, instructive UI.
  // k sliders come from its seed times.
  function exampleConfig() {
    const r = exampleRoute();
    const k = computeSeedKSplit(r.seedStillAirSec, r.seedHeadwind20Sec, r.seedTailwind20Sec);
    return {
      baselineMode: r.baselineMode ?? "learn",
      sliderBaselineSec: r.seedStillAirSec,
      kMode: r.kMode ?? "learn",
      split: r.split ?? false,
      sliderKHead: k.kHead ?? 1.0,
      sliderKTail: k.kTail ?? 1.0,
    };
  }
  const isExampleId = (id) => id === EXAMPLE_ID;

  // Update the example's tuning AND schedule IN MEMORY ONLY, so a user can
  // experiment with speed/k/arrival/days/mode and see the Plan tab respond.
  // Never persisted — resets on restart and when the example vanishes. Mutates
  // the cached example object in place.
  function updateExampleSeeds({ speedKmh, kHead, kTail, targetArrival, activeDays, timeMode, baselineMode, kMode, split }) {
    const r = exampleRoute();
    if (speedKmh != null) {
      const baselineSec = Math.round(r.totalDistance / (speedKmh / 3.6));
      r.baselineTimeSec = baselineSec;
      r.seedStillAirSec = baselineSec;
    }
    const kH = kHead != null ? kHead : null;
    const kT = kTail != null ? kTail : null;
    if (kH != null) r.seedHeadwind20Sec = Math.round(r.seedStillAirSec * (1 + effortNorm(kH * 20)));
    if (kT != null) r.seedTailwind20Sec = Math.round(r.seedStillAirSec * (1 + effortNorm(-kT * 20)));
    if (targetArrival != null) r.targetArrival = targetArrival;
    if (activeDays != null) r.activeDays = activeDays;
    if (timeMode != null) r.timeMode = timeMode === "depart" ? "depart" : "arrive";
    if (baselineMode != null) r.baselineMode = baselineMode;
    if (kMode != null) r.kMode = kMode;
    if (split != null) r.split = split;
    r.updatedAt = now();
  }

  // In-memory caches for a session: avoid re-fetching the same station within
  // a short window. Keyed by rounded lat/lon.
  const forecastCache = new Map();
  const FORECAST_TTL = 30 * 60 * 1000; // 30 min
  // Auto-finish fires only when the rider is within this straight-line distance
  // of the end point (the sole end-detection rule).
  const FINISH_RADIUS_M = 50;
  // Distance the rider must cover before finish-detection arms, so a ride that
  // starts near its own end (out-and-back / loop / testing from home) can't
  // self-finish before actually setting off.
  const FINISH_ARM_DIST_M = 200;
  // Percentile across ensemble members for the worst-case wetness upgrade. A high
  // percentile (not the literal wettest member) so one freak run doesn't cry wolf:
  // "a meaningful minority of scenarios are this wet".
  const ENSEMBLE_RAIN_PCT = 85;

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
   * Ensemble worst-case wetness level (0–3) for a ride, at a high percentile
   * across members — a robust "worst case" that isn't hijacked by one freak
   * member. For each member: walk the ride segments, sample that member's
   * precipitation (mm/h) at each segment's mid-time from the NEAREST ensemble
   * station, accumulate the ride total and track the peak rate, then map via the
   * SAME worse-of-rate/total banding the deterministic token uses. The returned
   * level is the value at ~ENSEMBLE_RAIN_PCT across members (e.g. 85th percentile:
   * "a meaningful minority of scenarios are this wet"), NOT the single wettest.
   * Returns { level (0–3), peakMmH, totalMm } from that same worst-case member;
   * level 0 / zero figures when precip data is missing so the merge is a no-op.
   */
  function ensembleRainLevelFor(ensembleStations, segments, times, departMs) {
    const ZERO = { level: 0, peakMmH: 0, totalMm: 0 };
    if (!ensembleStations || !ensembleStations.length || !segments || !segments.length) return ZERO;
    const memberCount = Math.min(...ensembleStations.map((s) => s.members.length));
    if (!(memberCount > 0)) return ZERO;
    // Nearest station index per segment (cheap squared-distance).
    const nearest = segments.map((s) => {
      let bi = 0, bd = Infinity;
      ensembleStations.forEach((st, i) => {
        const dx = st.lat - s.lat, dy = st.lon - s.lon, d = dx * dx + dy * dy;
        if (d < bd) { bd = d; bi = i; }
      });
      return bi;
    });
    // Precip (mm/h) for a member series at a time — pick the hour the rider is in
    // (earlier bracket), since precip is an hourly total, matching windModel.
    const precipAt = (series, atMs) => {
      if (!series || !series.length) return 0;
      let lo = 0;
      while (lo < series.length - 1 && series[lo + 1].time <= atMs) lo++;
      const v = series[lo] && series[lo].precipMm;
      return typeof v === "number" && v >= 0 ? v : 0;
    };
    let anyPrecip = false;
    const members = [];
    for (let m = 0; m < memberCount; m++) {
      let total = 0, peak = 0, segMs = departMs;
      for (let i = 0; i < segments.length; i++) {
        const st = ensembleStations[nearest[i]];
        const series = st.members[m];
        const mid = segMs + (times[i] * 1000) / 2;
        const rate = precipAt(series, mid); // mm/h
        if (rate > 0) anyPrecip = true;
        if (rate > peak) peak = rate;
        total += rate * (times[i] / 3600); // mm over this segment
        segMs += times[i] * 1000;
      }
      members.push({ peak, total });
    }
    if (!anyPrecip) return { level: 0, peakMmH: 0, totalMm: 0 };
    // Rank members by peak rate and pick the one at ENSEMBLE_RAIN_PCT — the level
    // AND the reported mm figures then come from the SAME (worst-case) member, so
    // the debug numbers and the band label are self-consistent.
    members.sort((a, b) => a.peak - b.peak);
    const idx = Math.min(members.length - 1, Math.floor((ENSEMBLE_RAIN_PCT / 100) * members.length));
    const worst = members[idx];
    return { level: rainLevel(worst.total, worst.peak), peakMmH: worst.peak, totalMm: worst.total };
  }

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
    // Per-segment along-route components (km/h) under the steady 20 km/h
    // example winds, with distance weights — the UI evaluates the v2 model
    // live as baseline·(1 + Σw·effortNorm(k·hᵢ)/Σw) with the slider's k
    // INSIDE the curve (there is no outer k multiply in v2).
    const comps = (fromDeg) => segments.map((s, i) => ({
      h: windComponent(20, fromDeg, s.bearing), w: w[i],
    }));
    return {
      meanBearingDeg: Math.round(meanBearing),
      headBearingLabel: compass16(meanBearing),
      tailBearingLabel: compass16((meanBearing + 180) % 360),
      // k=1 factors (reference; the sliders use the components below)
      headFactor: computeWindFactor(segments, steady(meanBearing), w),
      tailFactor: computeWindFactor(segments, steady((meanBearing + 180) % 360), w),
      headComponents: comps(meanBearing),
      tailComponents: comps((meanBearing + 180) % 360),
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

  /**
   * Create a route from raw GPX text plus the setup form values.
   * Handles processing, k-seeding, and persistence in one call.
   */
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

  /**
   * Create a route from already-processed geometry (e.g. the reverse-route flow,
   * which supplies reversed segments rather than GPX). Same seeding/creation as
   * createRoute, just skipping the GPX parse.
   */
  async function createRouteFromProcessed(processed, setup) {
    const seededK = computeSeedKSplit(
      setup.seedStillAirSec, setup.seedHeadwind20Sec, setup.seedTailwind20Sec
    );
    return store.createRoute(processed, setup, seededK);
  }

  /**
   * Create the return-trip route from an existing route: reversed geometry
   * (via reverseRoute), inheriting the source's speed/k slider seeds and split
   * (same bike), but with NO rides (the return trip has different wind/gradient,
   * so it learns its own k). Modes default to learn/learn like any new route.
   * The caller supplies name/schedule (the details form); name defaults to
   * "Reverse <source name>".
   */
  async function createReverseRoute(sourceId, setup = {}) {
    const src = await store.getRoute(sourceId);
    if (!src) throw new Error("Source route not found.");
    const rev = reverseRoute({
      segments: src.segments, totalDistance: src.totalDistance,
      hasElevation: src.hasElevation,
      start: src.startRegion, end: src.endRegion,
    });
    const processed = {
      segments: rev.segments,
      totalDistance: rev.totalDistance,
      hasElevation: rev.hasElevation,
      start: rev.start,
      end: rev.end,
    };
    // Inherit the source's CONFIGURATION (not its rendered appearance): same
    // modes and the same manual/slider seed values (which, when the source is in
    // learn mode, are its hidden manual fallback). The reverse has zero rides, so
    // in learn mode it will display that manual seed with the "using your setting
    // until enough rides" note — different from what the source may currently show
    // (a learned value), but carrying the identical underlying config. That's
    // honest: the reverse genuinely hasn't learned anything yet.
    const fullSetup = {
      name: setup.name != null ? setup.name : `Reverse ${src.name}`,
      seedStillAirSec: src.seedStillAirSec,
      seedHeadwind20Sec: src.seedHeadwind20Sec,
      seedTailwind20Sec: src.seedTailwind20Sec,
      split: src.split ?? false,
      baselineMode: src.baselineMode ?? "learn",
      kMode: src.kMode ?? "learn",
      targetArrival: setup.targetArrival ?? src.targetArrival,
      timeMode: setup.timeMode ?? src.timeMode,
      activeDays: setup.activeDays ?? [],
      startRadius: src.startRegion?.radius, endRadius: src.endRegion?.radius,
    };
    // Inherit k sliders verbatim (the source's manual/slider k), not re-derived.
    const seededK = { kHead: src.sliderKHead ?? 1.0, kTail: src.sliderKTail ?? 1.0 };
    return store.createRoute(processed, fullSetup, seededK);
  }

  /**
   * Preview the reversed geometry of an existing route (for the New route →
   * reverse flow), plus the inherited config defaults, WITHOUT creating anything.
   * Mirrors previewGpx's shape so the same details form can render it, and
   * carries the inherited seed/mode/name defaults for the form to pre-fill.
   */
  async function previewReverse(sourceId) {
    const src = await store.getRoute(sourceId);
    if (!src) throw new Error("Source route not found.");
    const rev = reverseRoute({
      segments: src.segments, totalDistance: src.totalDistance,
      hasElevation: src.hasElevation, start: src.startRegion, end: src.endRegion,
    });
    let climb = 0;
    if (rev.hasElevation) for (const s of rev.segments) if (s.eleDelta > 0) climb += s.eleDelta;
    // Effective speed the source's slider represents (its manual seed).
    const seedSpeedKmh = src.seedStillAirSec > 0
      ? Math.round((src.totalDistance / src.seedStillAirSec) * 3.6 * 2) / 2 : 16;
    return {
      sourceId,
      processed: {
        segments: rev.segments, totalDistance: rev.totalDistance,
        hasElevation: rev.hasElevation, start: rev.start, end: rev.end,
      },
      preview: {
        totalDistance: rev.totalDistance,
        hasElevation: rev.hasElevation,
        climb: rev.hasElevation ? climb : null,
        pointCount: rev.segments.length + 1,
        warnings: [],
        example: exampleFor(rev.segments),
        polyline: routePolyline(rev.segments, rev.end),
      },
      defaults: {
        name: `Reverse ${src.name}`,
        speedKmh: seedSpeedKmh,
        kHead: src.sliderKHead ?? 0.35,
        kTail: src.sliderKTail ?? 0.35,
        split: src.split ?? false,
        baselineMode: src.baselineMode ?? "learn",
        kMode: src.kMode ?? "learn",
        targetArrival: src.targetArrival,
        timeMode: src.timeMode,
      },
    };
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

  /**
   * Assemble the inputs the learning resolver needs for a route: its curated
   * ride log (normalized to the resolver's shape) and its config (manual/learn
   * toggles, split, slider values). The example route has no persisted rides.
   */
  async function modelInputsFor(route) {
    if (isExampleId(route.id)) {
      return { rides: [], config: exampleConfig() };
    }
    const rides = (await store.listRides(route.id)).map((r) => ({
      id: r.id,
      wfv: r.wfv,
      rideWindKmh: r.rideWindKmh,
      windFactor: r.windFactor, // v1 legacy, display-only
      klass: r.klass ?? null,   // stored class (authoritative for v1 rides)
      actualSec: r.actualTimeSec,
      startedAt: r.startedAt,
      included: r.included != null ? r.included : (r.usable != null ? !!r.usable : true),
      baselineRef: r.baselineRef ?? "current",
      savedBaselineSec: r.savedBaselineSec ?? null,
    }));
    return { rides, config: store.routeConfig(route) };
  }

  /**
   * Persist any current→historic freeze transitions the resolver produced, plus
   * keep the route's cached baseline in step. `resolved` is a resolveModel
   * result whose `.rides` carry the (possibly updated) baselineRef/saved values.
   * No-op for the example route.
   */
  async function persistResolved(route, resolved) {
    if (!resolved || isExampleId(route.id)) return;
    for (const out of resolved.rides) {
      if (!out.id) continue;
      const orig = await store.getRide(out.id);
      if (orig && (orig.baselineRef !== out.baselineRef ||
                   orig.savedBaselineSec !== out.savedBaselineSec)) {
        await store.updateRide(out.id, {
          baselineRef: out.baselineRef,
          savedBaselineSec: out.savedBaselineSec,
        });
      }
    }
    if (resolved.baselineSec > 0 && resolved.baselineSec !== route.baselineTimeSec) {
      await store.updateRoute(route.id, { baselineTimeSec: resolved.baselineSec });
    }
  }

  /**
   * Full home verdict for a route: the alert verdict plus the forecast range
   * and confidence, ready for the UI. Fetches the live forecast.
   */
  async function getHomeVerdict(routeId, dayMs = null, exploredHHMM = null, forceDepart = false) {
    const route = isExampleId(routeId) ? exampleRoute() : await store.getRoute(routeId);
    if (!route) return null;
    const { rides, config } = await modelInputsFor(route);
    const stationSeries = await stationSeriesFor(route);

    const nowMs = now();
    // The Plan tab passes a specific calendar day (ignoring activeDays/past-time),
    // optionally with an Explore time override. With no day given (the route-list
    // summary), default to today's configured time. There is no scheduler: PWAs
    // can't reliably wake to notify when closed, so the app shows a live
    // countdown beside the time instead of dispatching alerts.
    const entered = arrivalOnDate(route, dayMs != null ? dayMs : nowMs, exploredHHMM || undefined);

    const predictForArrival = makePredictor({
      route, rides, config, stationSeries, opts: { nowMs },
    });
    // The model is resolved once inside makePredictor; reuse it for confidence,
    // dots and freeze persistence.
    const resolved = predictForArrival.resolved;
    await persistResolved(route, resolved);

    // DEPART mode ("leave at HH:MM" / Go-now): the configured time is the
    // DEPARTURE, but arrivalOnDate — and the whole prediction stack — anchor on
    // an ARRIVAL. Anchoring the prediction on the entered time as if it were
    // the arrival samples the wind one ride-length EARLY (e.g. 7:43–8:00 for an
    // 8:00 departure), so tech info disagreed with a ride actually ridden
    // 8:00–8:17 under a changing forecast. Fix: converge the arrival for the
    // fixed departure (arrival = departure + predicted, two passes — same
    // fixed-point style as the predictor itself) and evaluate there. Display
    // still shows the entered time as the departure (see the depart block).
    const isDepartMode = forceDepart || route.timeMode === "depart";
    const enteredDepartMs = isDepartMode && entered ? entered.arrivalMs : null;
    let next = entered;
    if (isDepartMode && entered) {
      let arrMs = enteredDepartMs + (resolved.baselineSec > 0 ? resolved.baselineSec : 1800) * 1000;
      for (let i = 0; i < 2; i++) {
        const p = predictForArrival(arrMs);
        if (!p || !(p.predictedSec > 0)) break;
        arrMs = enteredDepartMs + p.predictedSec * 1000;
      }
      next = { ...entered, arrivalMs: arrMs };
    }

    // Guard: does the fetched forecast actually reach the ride day? A ride up to
    // a week out must not silently use clamped (stale) end-of-forecast data. If
    // any station's series doesn't cover the arrival, we treat the forecast as
    // unavailable for this ride rather than predicting from the wrong day.
    const forecastReaches =
      next &&
      stationSeries.length > 0 &&
      stationSeries.every((st) => seriesCovers(st.series, next.arrivalMs));

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
        route, rides, config, opts: { nowMs },
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
        // Default conservatism corresponds to a 75% uncertainty-allowance slider
        // (sliderToPct(75) ≈ 87). Stored as a percentile in 50–99.
        const hiPct = clampPct(await store.getSetting("conservatismPct", 87));
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


    // Confidence/dots derive from the resolved model's sources (spec §4):
    // one dot each for baseline, kHead, kTail served from ride data; combined-k
    // earns at most one.
    const dots = learning.dotCount(resolved);
    const conf = {
      dots,
      baselineLearned: resolved.baselineSource === "learned",
      kHeadLearned: resolved.kHeadSource === "learned",
      kTailLearned: resolved.kTailSource === "learned",
      split: resolved.split,
      ridesBaseline: resolved.ridesBaseline,
      ridesHead: resolved.ridesHead,
      ridesTail: resolved.ridesTail,
    };

    // Conservative departure: anchor on the SLOW end of the forecast range so
    // the rider arrives on time even on the slower side. Target = latest arrival.
    // Departure AND headline both drive off the slow end (the safe number).
    let conservative = null;
    let windEffect = null;
    // Go now (Explore) forces this one instance to be treated as a departure at
    // the given time, regardless of the route's configured mode.
    const timeMode = forceDepart ? "depart" : (route.timeMode === "depart" ? "depart" : "arrive");
    // In arrive mode `next.arrivalMs` is the entered arrival. In depart mode
    // the entered time is the DEPARTURE (enteredDepartMs); next.arrivalMs is
    // the converged arrival the prediction anchored on. Baseline departure uses
    // the whole-minute baseline ride time, to stay consistent with the
    // displayed still-air time.
    const baselineDepartureMs =
      next && timeMode === "arrive"
        ? next.arrivalMs - Math.round(route.baselineTimeSec / 60) * 60 * 1000
        : null;

    if (next && range && timeMode === "depart") {
      // Fixed departure: the rider leaves at the entered time; we show the
      // arrival RANGE. arrival = departure + rideTime. The caution percentile
      // already widened range.highSec, so the latest-arrival reflects it.
      const departureMs = enteredDepartMs; // the entered leave-at time
      // Compute arrivals from WHOLE-MINUTE ride times so the displayed numbers
      // are self-consistent with integer mental arithmetic (departure + shown
      // minutes = shown arrival). Round the ride durations first, then derive.
      const fastSec = Math.round(range.lowSec / 60) * 60;
      const slowSec = Math.round(range.highSec / 60) * 60;
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
      // Ride times are rounded to WHOLE MINUTES before deriving departure/arrival
      // instants, so the displayed numbers are self-consistent with integer
      // mental arithmetic (shown arrival − shown ride minutes = shown departure).
      const slowAboveBaseline = range.highSec > route.baselineTimeSec;
      const slowSec = slowAboveBaseline && hiEffectMin === 0
        ? route.baselineTimeSec
        : Math.round(range.highSec / 60) * 60;
      const fastSec = Math.round(range.lowSec / 60) * 60;
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
      // Wind allowance MUST equal the visible shift between the shown departure
      // and the shown still-air departure, or the user sees "0 min" while the
      // clock moved a minute. Both displayed times are minute-aligned (slowSec
      // is whole minutes; baselineDepartureMs rounds the baseline to a minute),
      // so derive deltaSec from those SAME aligned quantities rather than from
      // the raw baseline — otherwise a minute-rounded slowSec minus a raw
      // baseline can round to 0 while the two clocks differ by a minute.
      const baselineDepMin = baselineDepartureMs != null
        ? baselineDepartureMs
        : next.arrivalMs - Math.round(route.baselineTimeSec / 60) * 60 * 1000;
      const deltaSec = Math.round((baselineDepMin - departureMs) / 1000);
      verdict.departureMs = departureMs;
      verdict.departureHHMM = conservative.departureHHMM;
      verdict.normalDepartureHHMM = hhmm(baselineDepMin);
      verdict.normalDepartureMs = baselineDepMin;
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
      const departureMs = enteredDepartMs;
      const arrivalMs = departureMs + Math.round(verdict.predictedSec / 60) * 60 * 1000;
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
      const centralSec = Math.round(verdict.predictedSec / 60) * 60;
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
      const baselineDepMin = baselineDepartureMs != null
        ? baselineDepartureMs
        : next.arrivalMs - Math.round(route.baselineTimeSec / 60) * 60 * 1000;
      const deltaSec = Math.round((baselineDepMin - departureMs) / 1000);
      verdict.departureMs = departureMs;
      verdict.departureHHMM = conservative.departureHHMM;
      verdict.normalDepartureHHMM = hhmm(baselineDepMin);
      verdict.normalDepartureMs = baselineDepMin;
      verdict.deltaSec = deltaSec;
      verdict.deltaMin = Math.round(deltaSec / 60);
      verdict.verdict = deltaSec > (verdict.thresholdMin ?? 4) * 60 ? "headwind"
        : deltaSec < -(verdict.thresholdMin ?? 4) * 60 ? "tailwind" : "normal";
    }

    // "What to expect" line: temp / rain / crosswind at the arrival window.
    let expect = null;
    let debug = null;
    if (next) {
      const baseSpeed = speedFromBaseline(route.totalDistance, route.baselineTimeSec);
      const stillAir = segmentTimes(route.segments, baseSpeed, { useGradient: true });
      // Scale segment times by the predicted duration ratio (predicted / still-air)
      // so rain EXPOSURE reflects the wind slowdown — a headwind lengthens time in
      // the rain and raises the total. Same basis as the arrival prediction.
      const ts = (route.baselineTimeSec > 0 && verdict.predictedSec > 0)
        ? verdict.predictedSec / route.baselineTimeSec : 1;
      const times = stillAir.map((t) => t * ts);
      const windFn = makeWindFn(stationSeries);
      const departMs = conservative ? conservative.departureMs : next.arrivalMs - verdict.predictedSec * 1000;
      // Ensemble worst-case wetness (planning only): can upgrade the rain token to
      // "maybe «wetter»". Uses the cached ensemble (cheap); 0 if unavailable.
      let ensRain = { level: 0, peakMmH: 0, totalMm: 0 };
      try {
        const ens = await ensembleStationsFor(route);
        ensRain = ensembleRainLevelFor(ens, route.segments, times, departMs);
      } catch { ensRain = { level: 0, peakMmH: 0, totalMm: 0 }; }
      expect = whatToExpect({ segments: route.segments, times, windFn, departMs, ensembleRainLevel: ensRain.level });

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
      // Effort headwind: the single equivalent uniform forecast wind that
      // reproduces the k=1 wind factor exactly, via the v2 branch inverses —
      // the same quantity rides store as rideWindKmh. Defined as the inverse
      // of the factor (not an RMS of segment headwinds), so it reconciles in
      // every case, including a near-perpendicular wind on a winding route
      // where head and tail segments largely cancel.
      const wf1 = verdict.windFactorK1 ?? 0;
      const effortHead = wf1 === 0 ? 0
        : (wf1 > 0 ? 20 * invHead(wf1) : -20 * invTail(-wf1));
      const fetchedAt = forecastFetchedAt(route);
      debug = {
        windFromDeg: Math.round(w.fromDeg),
        windFromLabel: compass16(w.fromDeg),
        windSpeedKmh: Math.round(spd / tt),
        avgBearingDeg: Math.round(avgBearing),
        meanHeadwindKmh: +meanHead.toFixed(1),      // linear time-weighted mean
        effortHeadwindKmh: +effortHead.toFixed(2),  // equivalent wind (2dp, same precision as stored rideWindKmh so the two display identically at record time)
        // Ground-effect equivalent wind: the equivalent wind scaled by the
        // route's learned k for its direction — "the wind that actually affects
        // the predicted ride time". Signed, same sign as effortHead.
        feltEquivWindKmh: +(effortHead * (effortHead >= 0 ? (resolved.kHead ?? 1) : (resolved.kTail ?? 1))).toFixed(2),
        meanCrosswindKmh: +(cross / tt).toFixed(1),
        windFactor: +(verdict.windFactor ?? 0).toFixed(3),
        windFactorK1: +(verdict.windFactorK1 ?? 0).toFixed(3), // k=1 factor (effortHead inverts this)
        baselineSec: Math.round(route.baselineTimeSec),
        predictedSec: Math.round(verdict.predictedSec),
        slowSec: range ? Math.round(range.highSec) : null,
        fastSec: range ? Math.round(range.lowSec) : null,
        forecastUpdatedMs: fetchedAt,
        forecastNextUpdateMs: fetchedAt != null ? fetchedAt + FORECAST_TTL : null,
        kIdHead: resolved.kHeadSource === "learned",
        kIdTail: resolved.kTailSource === "learned",
        // Rain diagnostics — the actual figures the wetness token is computed
        // from, so a "why no 'a little wet'?" can be checked against the bands.
        rainPeakRateMmH: expect && expect.conditions ? +(expect.conditions.precipPeakRate || 0).toFixed(2) : null,
        rainTotalMm: expect && expect.conditions ? +(expect.conditions.precipTotalMm || 0).toFixed(2) : null,
        rainMaxProbPct: expect && expect.conditions && expect.conditions.precipProb && expect.conditions.precipProb.length
          ? Math.round(Math.max(...expect.conditions.precipProb)) : null,
        // Ensemble worst-case (85th-percentile member) actual figures — the
        // numbers behind any "maybe «wetter»" upgrade, in the same mm currency as
        // the deterministic rows above so they're directly comparable.
        rainWettestPeakMmH: ensRain.level > 0 ? +ensRain.peakMmH.toFixed(2) : null,
        rainWettestTotalMm: ensRain.level > 0 ? +ensRain.totalMm.toFixed(2) : null,
      };
    }

    // Carry the wind strength onto windEffect so the UI can apply the
    // "light" / "no wind effect" thresholds. meanHeadKmh is the magnitude of
    // the time-weighted mean headwind; windSpeedKmh the forecast wind speed
    // sampled mid-route. feltWindKmh is the FELT equivalent wind (kept for the
    // Forecast-details panel and any wind-magnitude use). timeEffect is the
    // k-applied fractional effect on ride time (same value shown as "time
    // effect" in Forecast details) — "light" is decided on |timeEffect| ≤ 10%,
    // i.e. the wind is gentle to ride in / barely moves your arrival. This is
    // independent of the 4-minute leave-early rule (a light wind can still be
    // worth leaving a little early for on a long ride — no contradiction).
    if (windEffect && debug) {
      windEffect.meanHeadKmh = Math.abs(debug.meanHeadwindKmh ?? 0);
      windEffect.windSpeedKmh = debug.windSpeedKmh ?? 0;
      const eq = debug.effortHeadwindKmh ?? 0; // signed k=1 equivalent wind
      const kDir = eq >= 0 ? (resolved.kHead ?? 1) : (resolved.kTail ?? 1);
      windEffect.feltWindKmh = Math.abs(eq) * kDir;
      windEffect.timeEffect = debug.windFactor ?? 0; // signed k-applied fractional time effect
    }

    return { route, verdict, range, conservative, windEffect, rangeUnavailable, confidence: conf, expect, debug, resolved };
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
   * forecast in effect), then persists it into the curated ride log. There is
   * no model accumulator to fold into and no auto-outlier gate any more — the
   * ride lands included by default and the user curates it in the Rides Manager.
   */
  async function recordRide(capture) {
    // The example route is ephemeral — a demo ride runs the full flow but
    // persists nothing and never tunes a model.
    if (isExampleId(capture.routeId)) {
      return { skipped: true, isExample: true };
    }
    const route = await store.getRoute(capture.routeId);
    const { rides, config } = await modelInputsFor(route);

    // Reconstruct the wind_factor for this ride from the forecast it carried.
    let windFactor = capture.windFactor;
    let predictedTimeSec = capture.predictedTimeSec ?? null;
    if (windFactor == null && !Number.isFinite(capture.endedAt)) {
      // Surface bad state rather than silently storing rideWindKmh 0 (which
      // would misclassify the ride as still): the capture should always carry
      // a finite end time from the ride/manual flows.
      console.warn("recordRide: non-finite endedAt; ride will record zero wind", capture.endedAt);
    }
    if (windFactor == null && capture.forecastWind && capture.forecastWind.length) {
      const stationSeries = capture.forecastWind; // [{lat,lon,series}]
      const predictForArrival = makePredictor({
        route, rides, config, stationSeries, opts: { nowMs: now() },
      });
      const p = predictForArrival(capture.endedAt);
      // v2: invert the k=1 factor (forecast-equivalent), NEVER the k-applied
      // time factor — rideWindKmh must be independent of the learned k.
      windFactor = p.windFactorK1 ?? p.windFactor;
      predictedTimeSec = p.predictedSec;
    }

    // v2 ride record: store the equivalent uniform forecast along-route wind
    // (signed km/h) recovered from the K=1 wind factor via the branch inverses.
    // IMPORTANT (prediction plumbing): the factor inverted here MUST stay the
    // k=1 factor. When the predictor moves k inside the curve for time
    // prediction, it must keep exposing the k=1 factor for this record,
    // plus the wind-model version stamp. windFactor itself is not stored on new
    // rides — rideWindKmh is the canonical, scale-stable summary.
    const wf1 = Number.isFinite(windFactor) ? windFactor : 0;
    const rideWindKmh = wf1 === 0 ? 0
      : (wf1 > 0 ? 20 * invHead(wf1) : -20 * invTail(-wf1));

    // Per-ride k sanity (v2): compute the UNCLAMPED implied k against the
    // route's current resolved baseline. If it lands outside THE k range
    // (0–1.2), the ride defaults to not-used — same mechanism as gentle rides;
    // the user can opt it back in from the Rides Manager. An out-of-range k
    // means the ride contradicts the model (baseline drift, stop-heavy ride,
    // anomaly), so it shouldn't silently steer learning.
    let included = capture.included;
    if (included == null) {
      const resolved = learning.resolveModel(rides, config, now());
      // Still rides are never quarantined by the k check: their equivalent
      // wind is ~0, so k = deviation/wind is an unstable near-zero-denominator
      // ratio that blows up on any timing noise (a 1 km/h residual can imply
      // k=10). A still ride carries no wind signal to contradict — it's exactly
      // what should feed the baseline — so we only sanity-check k for rides
      // that actually have meaningful wind (gentle/windy).
      const cls = learning.classifyRide(rideWindKmh);
      if (cls !== "still") {
        const kRide = learning.rideK(
          { wfv: 2, rideWindKmh, actualSec: capture.actualTimeSec, baselineRef: "current" },
          resolved.baselineSec
        );
        // Quarantine only when the implied k is genuinely implausible (above
        // K_LEARN_REJECT). Values in (K_MAX, K_LEARN_REJECT] are a legitimate
        // strong-wind route and get clamped in the fit, not excluded.
        if (kRide != null && (kRide < learning.K_MIN || kRide > learning.K_LEARN_REJECT)) {
          included = false;
        }
      }
    }

    return store.recordRide({
      ...capture,
      wfv: 2,
      rideWindKmh: +rideWindKmh.toFixed(2),
      windFactor: null,
      predictedTimeSec,
      included,
    });
  }

  const listRides = (routeId) => store.listRides(routeId);

  /**
   * Manually log a ride from earlier today by entered start/finish times. Builds
   * a capture equivalent to a GPS-recorded ride (fetches today's forecast so
   * wind_factor is reconstructed the SAME way — predictForArrival(endMs) inside
   * recordRide) and delegates to recordRide, so classification, used/unused and
   * curation are all identical to a recorded ride. `actualSec` = finish − start.
   * Times are ms epoch; caller enforces today-only, finish ≤ now, finish > start.
   */
  async function recordManualRide(routeId, { startMs, endMs }) {
    if (isExampleId(routeId)) return { skipped: true, isExample: true };
    if (!(endMs > startMs)) throw new Error("Finish time must be after the start time.");
    if (endMs > now()) throw new Error("Finish time can't be in the future.");
    const route = await store.getRoute(routeId);
    if (!route) throw new Error("Route not found.");
    const forecastWind = await stationSeriesFor(route).catch(() => []);
    if (!forecastWind.length) throw new Error("Couldn't fetch the forecast to work out the wind for this ride. Check your connection and try again.");
    return recordRide({
      routeId,
      actualTimeSec: Math.round((endMs - startMs) / 1000),
      startedAt: startMs,
      endedAt: endMs,
      distanceM: route.totalDistance,
      forecastWind,
    });
  }

  /* ---------------------------------------------------------------- *
   * Rides Manager
   * ---------------------------------------------------------------- */

  /**
   * The ride list for the Rides Manager, decorated for display: each ride
   * carries its classification (still/gentle/windy), its per-ride k against the
   * currently-configured (effective) baseline, and whether its current/historic
   * switch is locked by age (>= 14 days). Sorted newest-first. Reflects — but
   * does not surface a control for — each ride's baseline reference.
   */
  async function ridesForManager(routeId) {
    if (isExampleId(routeId)) return [];
    const route = await store.getRoute(routeId);
    if (!route) return [];
    const { rides, config } = await modelInputsFor(route);
    const resolved = learning.resolveModel(rides, config, now());
    await persistResolved(route, resolved);
    const liveBaseline = resolved.baselineSec;

    // Map resolved (freeze-applied) rides back, decorate for display.
    const decorated = resolved.rides.map((r) => {
      // ONE classification (raw-forecast data-quality triage): the same value
      // shown to the user and used to gate inclusion, so included/excluded is
      // always explicable from what's displayed.
      const cls = learning.classifyRideRecord(r);
      const k = cls === "still" ? null : learning.rideK(r, liveBaseline); // null for v1 rides
      return {
        id: r.id,
        startedAt: r.startedAt,
        actualTimeSec: r.actualSec,
        wfv: r.wfv,
        rideWindKmh: r.rideWindKmh,
        windFactor: r.windFactor, // v1 legacy (mean-wind display uses v1 inverse)
        liveBaselineSec: liveBaseline, // lets the editor recompute k live as duration/baseline-ref change
        klass: cls,
        rideK: k,
        included: r.included !== false,
        baselineRef: r.baselineRef,
        savedBaselineSec: r.savedBaselineSec,
        locked: learning.isFrozenByAge(r, now()),
      };
    });
    decorated.sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0));
    return decorated;
  }

  /** Edit a ride (duration), toggle include/exclude, or flip current/historic. */
  const updateRide = (id, patch) => store.updateRide(id, patch);
  /** Delete a ride outright (destructive). */
  const deleteRide = (id) => store.deleteRide(id);
  /** Exclude this ride and all earlier rides (reversible). Returns count. */
  const excludeRideAndEarlier = (id) => store.excludeRideAndEarlier(id);

  /**
   * Tuning state for the route editor. Returns the route's distance, route
   * stats, the manual (slider) speed/k, the current config (modes + split), and
   * the learned view resolved from the curated ride log — including, per
   * quantity, whether it is currently served from rides ("learned") or the
   * slider, so the editor can show the manual/learn switches and their status
   * text.
   */
  /**
   * Record a NEW route by GPS: like startRide but with no end-region detection
   * (there is no route yet). Collects a raw {lat,lon,t} trace; the user ends it
   * with manualFinish(). Pause is supported (excluded from actualSec). The trace
   * is kept RAW here; denoising/gating happens at route construction.
   */
  async function recordRoute({ onTick, onError, geo } = {}) {
    const geoApi = geo || (typeof navigator !== "undefined" ? navigator.geolocation : null);
    if (!geoApi) throw new Error("Geolocation unavailable.");
    const startedAt = now();
    const trace = [];
    let prev = null, paused = false, pauseStartedAt = null, totalPausedMs = 0;

    const watchId = geoApi.watchPosition(
      (pos) => {
        const fix = { lat: pos.coords.latitude, lon: pos.coords.longitude, t: now(),
          gpsT: (typeof pos.timestamp === "number" && pos.timestamp > 0) ? pos.timestamp : null,
          accuracyM: (typeof pos.coords.accuracy === "number" && pos.coords.accuracy >= 0) ? pos.coords.accuracy : null,
          gpsSpeedMps: (typeof pos.coords.speed === "number" && pos.coords.speed >= 0) ? pos.coords.speed : null,
          speedAccMps: (typeof pos.coords.speedAccuracy === "number" && pos.coords.speedAccuracy >= 0) ? pos.coords.speedAccuracy : null };
        if (paused) { prev = fix; return; }
        trace.push(fix);
        if (prev && onTick) {
          const moved = haversineLocal(prev.lat, prev.lon, fix.lat, fix.lon);
          // Speed dt from GPS fix timestamps (see startRide for rationale); fall
          // back to the app clock if gpsT missing/implausible.
          const appDt = (fix.t - prev.t) / 1000;
          let dt = appDt;
          if (fix.gpsT != null && prev.gpsT != null) {
            const gdt = (fix.gpsT - prev.gpsT) / 1000;
            if (gdt > 0 && gdt < 3600) dt = gdt; // plausible GPS interval; batched delivery makes gdt < appDt (the case we fix)
          }
          onTick({
            elapsedSec: (fix.t - startedAt - totalPausedMs) / 1000,
            distanceM: traceDistance(trace),
            speedMps: dt > 0 ? moved / dt : 0,
            gpsSpeedMps: fix.gpsSpeedMps, // device Doppler speed if available (m/s) — preferred needle source
            speedAccMps: fix.speedAccMps, // device speed accuracy (m/s), for Doppler-appropriate τ
            fixT: fix.gpsT ?? fix.t,
            accuracyM: fix.accuracyM,
          });
        }
        prev = fix;
      },
      (err) => {
        // Surface geolocation errors (denied / unavailable / timeout) instead of
        // swallowing them — otherwise recording on a device with no GPS hangs on
        // "GPS initialising" forever. code: 1=denied, 2=unavailable, 3=timeout.
        if (onError) onError({ code: err && err.code, message: err && err.message });
      },
      { enableHighAccuracy: true, maximumAge: 0, timeout: 15000 }
    );

    function buildResult(endedAt) {
      const pausedMs = totalPausedMs + (paused && pauseStartedAt ? (endedAt - pauseStartedAt) : 0);
      return {
        trace, startedAt, endedAt,
        actualSec: (endedAt - startedAt - pausedMs) / 1000,
        pausedSec: pausedMs / 1000,
      };
    }
    function stop() { geoApi.clearWatch(watchId); }
    let onFinishCb = null;
    return {
      stop,
      pause: () => { if (!paused) { paused = true; pauseStartedAt = Date.now(); } },
      resume: () => { if (paused) { totalPausedMs += Date.now() - pauseStartedAt; paused = false; pauseStartedAt = null; } },
      isPaused: () => paused,
      onFinish: (cb) => { onFinishCb = cb; },
      manualFinish: () => { stop(); if (onFinishCb) onFinishCb(buildResult(now())); },
    };
  }

  /**
   * Finalize a recorded route: gate + process the raw trace into geometry, create
   * the route, and log the recording traversal as the route's FIRST ride (normal
   * classification/curation). Returns { ok:true, route } or { ok:false, reason }
   * when the quality gate blocks it.
   */
  /**
   * Preview a recorded GPS trace for the New route form: run the quality gate +
   * processing WITHOUT creating anything. Returns { ok:true, processed, preview }
   * or { ok:false, reason } (re-record message). The caller keeps the raw
   * `recording` to pass to finalizeRecordedRoute at save (for first-ride logging).
   */
  function previewTrace(trace) {
    const result = processTrace(trace);
    if (!result.ok) return result;
    const p = result.processed;
    let climb = 0;
    if (p.hasElevation) for (const s of p.segments) if (s.eleDelta > 0) climb += s.eleDelta;
    return {
      ok: true,
      processed: p,
      preview: {
        totalDistance: p.totalDistance,
        hasElevation: p.hasElevation,
        climb: p.hasElevation ? climb : null,
        pointCount: p.segments.length + 1,
        warnings: p.warnings || [],
        example: exampleFor(p.segments),
        polyline: routePolyline(p.segments, p.end),
      },
    };
  }

  async function finalizeRecordedRoute(recording, setup) {
    const result = processTrace(recording.trace);
    if (!result.ok) return result;
    const route = await createRouteFromProcessed(result.processed, setup);
    try {
      const forecastWind = await stationSeriesFor(route).catch(() => []);
      if (forecastWind.length) {
        await recordRide({
          routeId: route.id,
          actualTimeSec: Math.round(recording.actualSec),
          startedAt: recording.startedAt,
          endedAt: recording.endedAt,
          distanceM: route.totalDistance,
          forecastWind,
        });
      }
    } catch { /* first-ride logging is best-effort; the route still stands */ }
    return { ok: true, route };
  }

  async function routeTuning(routeId) {
    const route = isExampleId(routeId) ? exampleRoute() : await store.getRoute(routeId);
    if (!route) return null;
    const { rides, config } = await modelInputsFor(route);
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

    // Manual (slider) view: speed from the slider baseline, k from the sliders.
    const manualSpeedKmh = Math.round((distanceM / config.sliderBaselineSec) * 3.6 * 2) / 2;
    const manual = { speedKmh: manualSpeedKmh, kHead: config.sliderKHead, kTail: config.sliderKTail };

    // Resolve the live model from the curated log + config (persisting any
    // freeze transitions). This drives the dots (what is ACTUALLY serving the
    // prediction under the route's current modes).
    const resolved = learning.resolveModel(rides, config, now());
    await persistResolved(route, resolved);

    // Separately resolve a "what learning WOULD produce" view with both modes
    // forced to learn, so the editor can preview the learned value the instant a
    // Manual→Learn pill flips — before Apply. The per-quantity sources here tell
    // the editor whether a learned value actually exists (vs. starved → slider).
    const learnView = learning.resolveModel(
      rides, { ...config, baselineMode: "learn", kMode: "learn" }, now()
    );

    const learned = {
      speedKmh: Math.round((distanceM / learnView.baselineSec) * 3.6 * 2) / 2,
      baselineSec: learnView.baselineSec,
      kHead: learnView.kHead, kTail: learnView.kTail,
      baselineSource: learnView.baselineSource,
      kHeadSource: learnView.kHeadSource,
      kTailSource: learnView.kTailSource,
      split: learnView.split, autoSplit: learnView.autoSplit,
      ridesBaseline: learnView.ridesBaseline,
      ridesHead: learnView.ridesHead, ridesTail: learnView.ridesTail,
    };

    return {
      distanceM, stats, manual, learned,
      config: {
        baselineMode: config.baselineMode,
        kMode: config.kMode,
        split: config.split,
      },
      dots: learning.dotCount(resolved),
      example: exampleFor(route.segments),
      polyline: routePolyline(route.segments, route.endRegion),
    };
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
  function distanceToRegion(region, { geo } = {}) {
    const geoApi = geo || (typeof navigator !== "undefined" ? navigator.geolocation : null);
    if (!geoApi || !region) return Promise.resolve(null);
    return new Promise((resolve) => {
      let settled = false;
      const done = (v) => { if (!settled) { settled = true; resolve(v); } };
      try {
        geoApi.getCurrentPosition(
          (pos) => done(Math.round(haversineLocal(pos.coords.latitude, pos.coords.longitude, region.lat, region.lon))),
          () => done(null),
          { enableHighAccuracy: true, timeout: 8000, maximumAge: 30000 }
        );
      } catch { done(null); }
    });
  }
  function distanceToStart(route, opts) { return distanceToRegion(route && route.startRegion, opts); }
  function distanceToEnd(route, opts) { return distanceToRegion(route && route.endRegion, opts); }

  /**
   * Predicted ride duration (seconds) for leaving NOW — IDENTICAL BY CONSTRUCTION
   * to the plan screen's "go now" likely. Go-now on the plan screen is an explored
   * override of {current HH:MM, depart:true}; we call getHomeVerdict with exactly
   * those arguments (today, current HH:MM, forceDepart) and return its
   * `verdict.predictedSec` (the ensemble-weighted center). This guarantees that a
   * rider who taps "go now" sees the same figure on the ride screen as the plan
   * screen showed. (There is deliberately NO equivalence with the *scheduled*
   * prediction — the rider may leave hours off-schedule, when the wind differs.)
   * Also returns `windWord`: "headwind" or "tailwind" when the go-now verdict is a
   * definite head/tailwind, else null (calm / "usual" / probability "mixed" cases
   * insert nothing). The ride screen shows this in place of the home card's
   * headline, which isn't visible during a ride.
   * Also returns `timeScale` = predictedSec / still-air baseline — how much longer
   * (or shorter) today's wind makes the ride — for scaling rain-exposure time.
   * Returns { predictedSec, windWord, timeScale } or null if unavailable.
   */
  async function ridePrediction(route) {
    if (!route || !route.segments) return null;
    try {
      const d = new Date(now());
      const hhmm = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
      const res = await getHomeVerdict(route.id, now(), hhmm, true); // depart at current time
      const sec = res && res.verdict && res.verdict.predictedSec;
      if (!(sec > 0)) return null;
      // Head/tail word from the SAME windEffect the home card headline uses, so
      // classification can't diverge. Only definite head/tailwind insert a word,
      // prefixed "light" when |time effect| ≤ 10% — the identical test the plan
      // tab's phrase uses, so the two lines always agree.
      const dir = res.windEffect && res.windEffect.direction;
      const LIGHT_TIME_EFFECT = 0.10;
      const te = res.windEffect && res.windEffect.timeEffect;
      const lightPrefix = (te != null && Math.abs(te) <= LIGHT_TIME_EFFECT) ? "light " : "";
      const windWord = dir === "headwind" ? `${lightPrefix}headwind`
        : dir === "tailwind" ? `${lightPrefix}tailwind` : null;
      // How much longer/shorter than still air (unambiguous ratio; avoids the
      // additive-vs-multiplicative ambiguity of the raw windFactor).
      const base = route.baselineTimeSec;
      const timeScale = (base > 0) ? sec / base : 1;
      return { predictedSec: sec, windWord, timeScale, timeEffect: te ?? null };
    } catch {
      return null;
    }
  }

  async function rideExpectation(route, windWord = null, timeScale = 1) {
    if (!route || !route.segments) return null;
    const stationSeries = await stationSeriesFor(route).catch(() => []);
    if (!stationSeries.length) return null;
    const baseSpeed = speedFromBaseline(route.totalDistance, route.baselineTimeSec);
    const stillAir = segmentTimes(route.segments, baseSpeed, { useGradient: true });
    // Scale still-air segment times by the whole-ride duration ratio (predicted /
    // still-air) so the rain EXPOSURE (total mm = rate × time-in-rain) reflects
    // today's wind: a headwind lengthens time on each segment and correctly
    // increases the accumulated rain total. Uniform net scaling (whole-ride, not
    // per-segment); defaults to 1.0 (still air). Also aligns the rain-exposure
    // time basis with the arrival prediction, which uses the same duration.
    const ts = (typeof timeScale === "number" && timeScale > 0) ? timeScale : 1;
    const times = stillAir.map((t) => t * ts);
    const windFn = makeWindFn(stationSeries);
    return whatToExpect({ segments: route.segments, times, windFn, departMs: now(), windWord });
  }

  async function startRide(route, { onTick, onFinish, onArrived, onError, geo } = {}) {
    const geoApi = geo || (typeof navigator !== "undefined" ? navigator.geolocation : null);
    if (!geoApi) throw new Error("Geolocation unavailable.");

    const startedAt = now();
    const forecastWind = await stationSeriesFor(route).catch(() => []);
    const endRegion = route.endRegion;
    const trace = [];
    let prev = null;
    let hasLeftStart = false; // finish detection stays disarmed until the rider actually leaves the start
    let arrivalDeclined = false; // set when the rider chose "keep riding" — auto-finish stays off thereafter
    // Pause support: total paused ms is excluded from the ride time, so a rider
    // can stop (lights, coffee, mechanical) without inflating the learned time.
    let paused = false;
    let pauseStartedAt = null;
    let totalPausedMs = 0;

    const watchId = geoApi.watchPosition(
      (pos) => {
        const fix = { lat: pos.coords.latitude, lon: pos.coords.longitude, t: Date.now(),
          gpsT: (typeof pos.timestamp === "number" && pos.timestamp > 0) ? pos.timestamp : null,
          gpsSpeedMps: (typeof pos.coords.speed === "number" && pos.coords.speed >= 0) ? pos.coords.speed : null,
          speedAccMps: (typeof pos.coords.speedAccuracy === "number" && pos.coords.speedAccuracy >= 0) ? pos.coords.speedAccuracy : null,
          accuracyM: (typeof pos.coords.accuracy === "number" && pos.coords.accuracy >= 0) ? pos.coords.accuracy : null };
        // While paused, ignore movement entirely — no distance, no finish
        // detection, no trace growth, and the clock is held.
        if (paused) { prev = fix; return; }
        if (prev) {
          // distance accrual
          const moved = haversineLocal(prev.lat, prev.lon, fix.lat, fix.lon);
          trace.push(fix);
          // finish detection: in end region, or stopped near it. GATED on the
          // ride having actually begun — the rider must have moved a minimum
          // distance from the start first. Without this, starting a ride within
          // ~180m of the end region (common: out-and-back commutes, loops, or
          // testing from home) while stationary during GPS warm-up trips the
          // "arrived and stopped" branch after 20s, calls stop(), and freezes the
          // whole ride (no more ticks — distance, speed, and the "GPS
          // initialising" readout all stick at their first values).
          const dEnd = haversineLocal(fix.lat, fix.lon, endRegion.lat, endRegion.lon);
          const distSoFar = traceDistance(trace);
          if (!hasLeftStart && distSoFar >= FINISH_ARM_DIST_M) hasLeftStart = true;
          // Auto-finish has ONE rule: the rider is physically inside the end
          // region (within FINISH_RADIUS_M of the end point), and the ride has
          // armed (moved FINISH_ARM_DIST_M from the start first). The old "stopped
          // within ~180m of the end" heuristic was removed — proximity to the end
          // POINT while merely near it (a parallel road, a detour, or stopping
          // short) caused false finishes; entering the region is the only honest
          // signal. Manual Finish covers ending anywhere else.
          const finished = hasLeftStart && !arrivalDeclined && dEnd <= FINISH_RADIUS_M;

          if (onTick) {
            // Speed dt from the GPS fix timestamps (pos.timestamp), NOT the app
            // clock: watchPosition callbacks can be delivered late or batched, so
            // Date.now() at callback time may span a different interval than the
            // distance covered — the classic fast-out/slow-back needle spike. GPS
            // time is the correct clock for a GPS-derived speed. Fall back to the
            // app clock if either gpsT is missing or gives an implausible dt.
            const appDt = (fix.t - prev.t) / 1000;
            let dt = appDt;
            if (fix.gpsT != null && prev.gpsT != null) {
              const gdt = (fix.gpsT - prev.gpsT) / 1000;
              // Use the GPS interval whenever it's plausible on its own (positive,
              // not absurdly long). We deliberately DON'T require it to match the
              // app-clock dt — a GPS dt much smaller than the app dt is exactly the
              // batched-delivery case we're correcting. Only reject garbage.
              if (gdt > 0 && gdt < 3600) dt = gdt;
            }
            const speedMps = dt > 0 ? moved / dt : 0;
            onTick({
              elapsedSec: (fix.t - startedAt - totalPausedMs) / 1000,
              distanceM: traceDistance(trace),
              speedMps,                 // this-fix derived speed over the GPS interval; UI smooths
              fixT: fix.gpsT ?? fix.t,  // GPS fix timestamp for the EMA dt (falls back to app clock)
              gpsSpeedMps: fix.gpsSpeedMps, // device GPS speed if available (m/s)
              speedAccMps: fix.speedAccMps, // device GPS speed accuracy if available (m/s), for Doppler τ
              accuracyM: fix.accuracyM, // device GPS accuracy estimate (m), or null
              lat: fix.lat, lon: fix.lon,  // fix position, for route projection
              distanceToEndM: dEnd,     // straight-line metres to the end region
            });
          }
          if (finished) {
            if (onArrived) {
              // Hand the decision to the app: it confirms ("finish") or the rider
              // keeps riding. A "keep riding" latches arrivalDeclined so
              // auto-finish won't fire again for the rest of the ride.
              arrivalDeclined = true;
              onArrived(buildResult(fix.t));
            } else {
              stop(); if (onFinish) onFinish(buildResult(fix.t));
            }
          }
        } else {
          trace.push(fix);
        }
        prev = fix;
      },
      (err) => {
        // Geolocation error (permission denied, position unavailable, timeout).
        // Previously swallowed — which left the UI stuck on "GPS initialising"
        // forever on a device with no GPS or with permission denied. Surface it so
        // the screen can say so. code: 1=denied, 2=unavailable, 3=timeout.
        if (onError) onError({ code: err && err.code, message: err && err.message });
      },
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
    createRoute, createRouteFromProcessed, createReverseRoute, previewReverse, previewGpx, listRoutes, getRoute, updateRoute, resetRoute, deleteRoute, reorderRoutes,
    getHomeVerdict, listRoutesWithVerdict,
    recordRide, recordManualRide, listRides, startRide, recordRoute, previewTrace, finalizeRecordedRoute, distanceToStart, distanceToEnd, rideExpectation, ridePrediction, routeTuning, updateExampleSeeds,
    updateRide, deleteRide, excludeRideAndEarlier, ridesForManager,
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
