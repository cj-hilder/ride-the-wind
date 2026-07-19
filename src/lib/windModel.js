/**
 * Ride the Wind — Wind model
 *
 * Computes `wind_factor`: a signed, dimensionless measure of how much the
 * forecast wind helps or hurts a given route. Positive = net headwind
 * (slower), negative = net tailwind (faster). This feeds the prediction:
 *
 *     predicted_time = baseline_time × (1 + k × wind_factor)
 *
 * The physics only needs to get the *shape* of the wind response right;
 * `baseline_time` and `k` (learned per route) absorb absolute magnitude and
 * everything unmodelled (shelter, surface, tyres, fitness).
 *
 * This module is split into:
 *   - pure math (no I/O, fully testable offline): windComponent, effortNorm,
 *     computeWindFactor, seedK
 *   - a forecast layer: fetchForecast (Open-Meteo) + sampleWind interpolation
 *
 * Consumes the ProcessedRoute produced by gpxRoute.js (segments with
 * { lat, lon, bearing, distance, eleDelta }).
 *
 * Conventions (fixed here, asserted in tests — a sign error silently
 * inverts every prediction):
 *   - bearing θ: direction of travel, degrees clockwise from true north.
 *   - wind direction φ: the direction the wind blows FROM (meteorological
 *     convention, as Open-Meteo reports it), degrees clockwise from north.
 *   - headwind = w · cos(φ − θ): positive opposes travel.
 *   - all speeds in km/h internally for wind_factor (w_ref = 20 km/h).
 */

const DEG = Math.PI / 180;

export const W_REF_KMH = 20; // reference wind for normalisation (per spec §2.2)

/* ------------------------------------------------------------------ *
 * Pure math
 * ------------------------------------------------------------------ */

/**
 * Headwind component of the wind along a segment, in the wind's units.
 *
 *   headwind = w · cos(φ − θ)
 *
 * @param {number} windSpeed   - forecast wind speed (km/h)
 * @param {number} windFromDeg - direction wind blows FROM (deg from north)
 * @param {number} bearingDeg  - travel bearing of the segment (deg from north)
 * @returns {number} signed headwind: positive = headwind, negative = tailwind
 */
export function windComponent(windSpeed, windFromDeg, bearingDeg) {
  return windSpeed * Math.cos((windFromDeg - bearingDeg) * DEG);
}

/**
 * Normalised time-effect of a signed headwind, per the solved constant-power
 * physics (NOT the old signed square, and NOT speed-addition).
 *
 * Derivation: at constant rider power P = a·v·(v+h)² + c·v (a = aero, c =
 * rolling), solve for ground speed v and convert to time (t ∝ 1/v). Note
 * power = force × GROUND speed — a bicycle's propulsion reacts against the
 * ground, so wind does not add/subtract speed directly (that would be true of
 * an aircraft): a 24 km/h headwind leaves a 24 km/h rider at ~12.5 km/h, not
 * stationary, and a 24 km/h tailwind yields ~40 km/h, not 48.
 *
 * The resulting time-excess curves, normalised to ±1 at w_ref, fitted least-
 * squares over 2–32 km/h at a nominal commuter (CdA 0.45, Crr 0.006, 90 kg,
 * 24 km/h still-air; the normalised shape is insensitive to rider speed
 * 18–30 km/h, so no per-rider parameters are needed):
 *
 *   head (h>0): f_H(x) = x·(1 + A·x)/(1 + A)   — super-linear: strong
 *               headwinds hurt disproportionately
 *   tail (h<0): f_T(x) = x/(1 + B·(x − 1))     — concave, saturating at 1/B:
 *               ever-stronger tailwinds help less and less
 *
 * with x = |h|/w_ref. f(±w_ref) = ±1 exactly, so k keeps its anchor meaning.
 * The head/tail SHAPE asymmetry lives here; residual MAGNITUDE asymmetry
 * (shelter and rider habit are direction-dependent) lives in split kHead/kTail.
 *
 * @param {number} headwind   - signed headwind (km/h); the caller pre-scales
 *                              by k (surface = k × forecast) under the v2 model
 * @param {number} [wRef=20]  - reference wind (km/h)
 */
export const WF_HEAD_A = 0.715;
export const WF_TAIL_B = 0.30;
// PHYSICAL magnitudes at the reference wind (nominal rider, from the solved
// constant-power model): a full 20 km/h effective headwind costs +70.8% time;
// a 20 km/h effective tailwind saves 35.0%. These make effortNorm the TIME
// EXCESS directly, so k = 1 genuinely means "the route feels the full forecast
// wind at the nominal rider". Rider-speed magnitude differences (~±20% over
// 18–30 km/h) are absorbed by the learned k, as shelter is.
export const WF_HEAD_C = 0.708;
export const WF_TAIL_C = 0.350;

export function effortNorm(headwind, wRef = W_REF_KMH) {
  const x = Math.abs(headwind) / wRef;
  if (headwind > 0) return (WF_HEAD_C * x * (1 + WF_HEAD_A * x)) / (1 + WF_HEAD_A);
  if (headwind < 0) return -((WF_TAIL_C * x) / (1 + WF_TAIL_B * (x - 1)));
  return 0;
}

/** Exact inverses of the branch curves: given a non-negative PHYSICAL time
 * deviation w (excess for head, saving for tail), return x = |h|/w_ref.
 * Verified round-trip to machine precision. */
export function invHead(w) {
  if (!(w > 0)) return 0;
  const u = w / WF_HEAD_C;
  return (-1 + Math.sqrt(1 + 4 * WF_HEAD_A * (1 + WF_HEAD_A) * u)) / (2 * WF_HEAD_A);
}
export function invTail(w) {
  if (!(w > 0)) return 0;
  const u = w / WF_TAIL_C;
  return ((1 - WF_TAIL_B) * u) / (1 - WF_TAIL_B * u);
}

/**
 * Estimate per-segment still-air ride time, used only as the weighting in the
 * aggregation. Absolute accuracy does not matter — only the relative share of
 * time across segments — so a constant baseline speed is sufficient, with an
 * optional gradient adjustment when elevation is present.
 *
 * Returns seconds per segment (array, parallel to segments).
 *
 * @param {Array} segments      - route segments (distance m, eleDelta m|null)
 * @param {number} baseSpeedKmh - nominal still-air speed for weighting
 * @param {Object} [opts]
 * @param {boolean} [opts.useGradient=true] - slow on climbs, speed on descents
 */
export function segmentTimes(segments, baseSpeedKmh, opts = {}) {
  const { useGradient = true } = opts;
  const baseMs = (baseSpeedKmh * 1000) / 3600; // m/s
  return segments.map((s) => {
    let v = baseMs;
    if (useGradient && s.eleDelta != null && s.distance > 0) {
      // Gentle, bounded gradient effect: this only reweights time share,
      // it is not a physical climb model. Grade clamped to ±15%.
      const grade = Math.max(-0.15, Math.min(0.15, s.eleDelta / s.distance));
      // Speed scales down ~6×grade on climbs, up on descents, clamped.
      const factor = Math.max(0.35, Math.min(1.8, 1 - grade * 6));
      v = baseMs * factor;
    }
    return v > 0 ? s.distance / v : 0;
  });
}

/**
 * Compute wind_factor for a route given a per-segment wind field.
 *
 *   wind_factor = Σ (t_i · f_norm(headwind_i)) / Σ t_i
 *
 * where t_i is the still-air time weight for segment i (segmentTimes).
 *
 * `windAt(i)` supplies the wind for segment i as { speed, fromDeg }. Passing a
 * function (rather than a flat value) is what lets the caller vary wind along
 * the route and across arrival times; for a single uniform forecast, return
 * the same object for every i.
 *
 * @param {Array} segments
 * @param {(i:number)=>{speed:number,fromDeg:number}} windAt
 * @param {number[]} times - per-segment weights (seconds), from segmentTimes
 * @param {number} [wRef=20]
 * @returns {number} signed, dimensionless wind_factor
 */
export function computeWindFactor(segments, windAt, times, k = 1, wRef = W_REF_KMH) {
  // k is the WIND-ATTENUATION multiplier (surface = k × forecast), applied
  // INSIDE the curve. Accepts a single number or {kHead, kTail}: shelter and
  // habit are direction-dependent, so each segment's along-route component
  // uses the k of ITS OWN sign (head segments kHead, tail segments kTail).
  // predicted_time = baseline·(1 + wind_factor); no outer k multiply exists.
  const kHead = typeof k === "object" ? (k.kHead ?? 1) : k;
  const kTail = typeof k === "object" ? (k.kTail ?? 1) : k;
  let num = 0;
  let den = 0;
  for (let i = 0; i < segments.length; i++) {
    const w = windAt(i);
    const h = windComponent(w.speed, w.fromDeg, segments[i].bearing);
    const t = times[i];
    num += t * effortNorm((h > 0 ? kHead : kTail) * h, wRef);
    den += t;
  }
  return den > 0 ? num / den : 0;
}

/**
 * Seed the route wind-attenuation `k` from the optional setup estimates.
 *
 * v2 semantics: k is the fraction of the FORECAST wind felt on the route
 * (surface = k × forecast; calibration + shelter + rider habit blended).
 * At the 20 km/h seed wind, x = 1, so predicted excess = f_branch(k) and each
 * seed time inverts in closed form:
 *
 *   k_head = invHead(t_head/t_still − 1)
 *   k_tail = invTail(1 − t_tail/t_still)
 *
 * We average the two implied estimates when both are present, use whichever
 * is present alone, and fall back to DEFAULT_K if neither is given.
 */
/**
 * Default wind attenuation when the user gives no directional seed estimate:
 * the route feels 70% of the forecast along-route wind. Typical suburban
 * shelter sits below full exposure (k ≈ 1); fully open coastal routes may
 * reach ~1; heavy tree/building shelter can halve it. Tune as learned k
 * values accumulate.
 */
export const DEFAULT_K = 0.7;
/** THE k range (fraction of forecast wind felt, user-facing as 0%–120%).
 * The single range used everywhere: sliders, seeds, learned-fit acceptance,
 * and per-ride sanity (out-of-range rides default to not-used). */
export const K_MIN = 0.0;
export const K_MAX = 1.2;

export function seedK(stillAirSec, headwind20Sec, tailwind20Sec) {
  if (!(stillAirSec > 0)) return DEFAULT_K;
  const estimates = [];
  if (headwind20Sec != null && headwind20Sec > 0) {
    estimates.push(invHead(headwind20Sec / stillAirSec - 1));
  }
  if (tailwind20Sec != null && tailwind20Sec > 0) {
    estimates.push(invTail(1 - tailwind20Sec / stillAirSec));
  }
  if (estimates.length === 0) return DEFAULT_K;
  const k = estimates.reduce((a, b) => a + b, 0) / estimates.length;
  return Math.max(K_MIN, Math.min(K_MAX, k));
}

/**
 * Asymmetric seed: independent kHead and kTail from the directional setup
 * estimates via the branch inverses. Each side defaults to DEFAULT_K if its
 * estimate is absent. Both clamped to the K range (0–1.2).
 */
export function seedKSplit(stillAirSec, headwind20Sec, tailwind20Sec) {
  const clamp = (x) => Math.max(K_MIN, Math.min(K_MAX, x));
  let kHead = DEFAULT_K, kTail = DEFAULT_K;
  if (stillAirSec > 0) {
    if (headwind20Sec != null && headwind20Sec > 0) {
      kHead = clamp(invHead(headwind20Sec / stillAirSec - 1));
    }
    if (tailwind20Sec != null && tailwind20Sec > 0) {
      kTail = clamp(invTail(1 - tailwind20Sec / stillAirSec));
    }
  }
  return { kHead, kTail };
}

/* ------------------------------------------------------------------ *
 * Forecast sampling (interpolation) — pure, testable
 * ------------------------------------------------------------------ */

/**
 * Linearly interpolate hourly forecast wind to an arbitrary instant.
 *
 * @param {Array<{time:number, speed:number, fromDeg:number}>} hourly
 *        forecast samples sorted ascending by `time` (epoch ms); speed km/h.
 * @param {number} atMs - target instant (epoch ms)
 * @returns {{speed:number, fromDeg:number}}
 */
export function sampleWind(hourly, atMs) {
  if (!hourly || hourly.length === 0) {
    throw new Error("No forecast data to sample.");
  }
  if (atMs <= hourly[0].time) return pick(hourly[0]);
  const last = hourly[hourly.length - 1];
  if (atMs >= last.time) return pick(last);

  // find bracketing hours
  let lo = 0;
  while (lo < hourly.length - 1 && hourly[lo + 1].time <= atMs) lo++;
  const a = hourly[lo];
  const b = hourly[lo + 1];
  if (!b) return pick(a); // defensive: no upper bracket, use the last sample
  const t = (atMs - a.time) / (b.time - a.time);

  // interpolate direction on the circle to avoid the 350°→10° wraparound bug
  const fromDeg = interpAngle(a.fromDeg, b.fromDeg, t);
  const speed = a.speed + (b.speed - a.speed) * t;
  // temperature interpolates linearly; precipitation is an hourly total so we
  // take the hour the rider is in (the earlier bracket), not a blend, and the
  // probability likewise reflects that hour.
  const tempC = a.tempC == null || b.tempC == null ? (a.tempC ?? b.tempC ?? null) : a.tempC + (b.tempC - a.tempC) * t;
  return { speed, fromDeg, tempC, precipMm: a.precipMm ?? 0, precipProb: a.precipProb ?? 0, snowfallCm: a.snowfallCm ?? 0, weatherCode: a.weatherCode ?? null, gustKmh: a.gustKmh ?? null };
}

function pick(s) {
  return { speed: s.speed, fromDeg: s.fromDeg, tempC: s.tempC ?? null, precipMm: s.precipMm ?? 0, precipProb: s.precipProb ?? 0, snowfallCm: s.snowfallCm ?? 0, weatherCode: s.weatherCode ?? null, gustKmh: s.gustKmh ?? null };
}

/** Shortest-path angular interpolation, degrees. */
export function interpAngle(a, b, t) {
  let diff = ((b - a + 540) % 360) - 180; // signed shortest delta in (−180,180]
  return ((a + diff * t) % 360 + 360) % 360;
}

/**
 * Whether a forecast series actually covers an instant (with a small grace at
 * the end for the final hour). Lets callers detect a ride beyond the forecast
 * horizon instead of silently using clamped, stale data.
 */
export function seriesCovers(series, atMs, graceMs = 3600 * 1000) {
  if (!series || series.length === 0) return false;
  return atMs >= series[0].time && atMs <= series[series.length - 1].time + graceMs;
}

/* ------------------------------------------------------------------ *
 * Full wind_factor with arrival-time-aware wind + convergence pass
 * ------------------------------------------------------------------ */

/**
 * Compute wind_factor accounting for *when* the rider reaches each segment:
 * wind at a segment is sampled at the clock time of arrival there. Because
 * arrival times depend on total ride time and vice versa, we run a short
 * fixed-point loop; it converges in 1–2 passes given hourly forecast
 * resolution and short trips (spec §2.4).
 *
 * @param {Object} args
 * @param {Array}  args.segments
 * @param {number[]} args.times        - per-segment still-air weights (s)
 * @param {(lat:number,lon:number,atMs:number)=>{speed,fromDeg}} args.windFn
 *        returns forecast wind at a location and instant (built from Open-Meteo)
 * @param {number} args.departMs       - departure instant (epoch ms)
 * @param {number} [args.wRef=20]
 * @param {number} [args.passes=2]
 * @returns {number} wind_factor
 */
export function windFactorTimed({
  segments,
  times,
  windFn,
  departMs,
  k = 1,
  wRef = W_REF_KMH,
  passes = 2,
}) {
  const totalStill = times.reduce((a, b) => a + b, 0);
  // Initial guess: wind sampled at departure for all segments.
  let factor = 0;
  for (let p = 0; p < passes; p++) {
    // ride-time multiplier from current factor estimate. v2: the factor IS the
    // fractional time effect (k already inside), so no outer k here either.
    const mult = 1 + factor;
    let clock = departMs;
    const windAt = (i) => {
      const s = segments[i];
      const w = windFn(s.lat, s.lon, clock);
      // advance clock by this segment's (scaled) time for the next lookup
      clock += times[i] * Math.max(0.5, mult) * 1000;
      return w;
    };
    factor = computeWindFactor(segments, windAt, times, k, wRef);
    void totalStill;
  }
  return factor;
}

/* ------------------------------------------------------------------ *
 * Open-Meteo forecast layer (network I/O)
 * ------------------------------------------------------------------ */

/**
 * Fetch hourly wind forecast from Open-Meteo for a location.
 * No API key required. Returns samples sorted ascending by time.
 *
 * @param {number} lat
 * @param {number} lon
 * @param {Object} [opts]
 * @param {number} [opts.forecastDays=2]
 * @param {typeof fetch} [opts.fetchImpl] - injectable for testing
 * @returns {Promise<Array<{time:number, speed:number, fromDeg:number}>>}
 */
export async function fetchForecast(lat, lon, opts = {}) {
  const { forecastDays = 8, pastDays = 1, fetchImpl } = opts;
  const f = fetchImpl || (typeof fetch !== "undefined" ? fetch : null);
  if (!f) throw new Error("No fetch available; inject opts.fetchImpl.");

  // past_days keeps recently-past hours in the window so a ride earlier today
  // (or yesterday) still resolves to its OWN forecast hour rather than being
  // clamped to the first remaining hour as the day advances.
  const url =
    `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}` +
    `&hourly=wind_speed_10m,wind_direction_10m,wind_gusts_10m,temperature_2m,precipitation,precipitation_probability,snowfall,weather_code` +
    `&wind_speed_unit=kmh&timeformat=unixtime&past_days=${pastDays}&forecast_days=${forecastDays}`;

  const res = await f(url);
  if (!res.ok) throw new Error(`Open-Meteo HTTP ${res.status}`);
  const data = await res.json();
  return parseForecast(data);
}

/**
 * Fetch the wind ensemble (ECMWF IFS, 51 members) for a location. Returns one
 * wind series PER MEMBER, so the caller can run each through the ride-time
 * model and read off true forecast uncertainty. Members carry only wind
 * (speed + direction); temperature/precip come from the deterministic call.
 *
 * @returns {Promise<Array<Array<{time:number, speed:number, fromDeg:number}>>>}
 *          array of members, each a sorted series
 */
export async function fetchEnsemble(lat, lon, opts = {}) {
  const { forecastDays = 8, pastDays = 1, fetchImpl, model = "ecmwf_ifs025" } = opts;
  const f = fetchImpl || (typeof fetch !== "undefined" ? fetch : null);
  if (!f) throw new Error("No fetch available; inject opts.fetchImpl.");

  const url =
    `https://ensemble-api.open-meteo.com/v1/ensemble?latitude=${lat}&longitude=${lon}` +
    `&hourly=wind_speed_10m,wind_direction_10m,precipitation` +
    `&models=${model}&wind_speed_unit=kmh&timeformat=unixtime&past_days=${pastDays}&forecast_days=${forecastDays}`;

  const res = await f(url);
  if (!res.ok) throw new Error(`Open-Meteo ensemble HTTP ${res.status}`);
  const data = await res.json();
  return parseEnsemble(data);
}

/**
 * Parse an ensemble response into per-member series. Open-Meteo names member
 * variables like `wind_speed_10m_member01`, `wind_direction_10m_member01`, …
 * (member00/control may also appear unsuffixed). Separated from the fetch for
 * offline testing against canned JSON.
 */
export function parseEnsemble(data) {
  const h = data && data.hourly;
  if (!h || !Array.isArray(h.time)) {
    throw new Error("Unexpected Open-Meteo ensemble response shape.");
  }
  const times = h.time;
  // collect member suffixes present for wind speed
  const speedKeys = Object.keys(h).filter((k) => k.startsWith("wind_speed_10m"));
  const members = [];
  for (const sk of speedKeys) {
    const suffix = sk.slice("wind_speed_10m".length); // "" or "_member03"
    const dk = "wind_direction_10m" + suffix;
    const speeds = h[sk];
    const dirs = h[dk];
    if (!Array.isArray(speeds) || !Array.isArray(dirs)) continue;
    const precip = h["precipitation" + suffix]; // may be absent
    const series = [];
    for (let i = 0; i < times.length; i++) {
      series.push({
        time: times[i] * 1000, speed: speeds[i], fromDeg: dirs[i],
        precipMm: Array.isArray(precip) ? precip[i] : null,
      });
    }
    series.sort((a, b) => a.time - b.time);
    members.push(series);
  }
  if (members.length === 0) throw new Error("No ensemble members found.");
  return members;
}

/**
 * Parse an Open-Meteo response into sorted wind samples. Separated from the
 * fetch so it can be tested against canned JSON with no network.
 */
export function parseForecast(data) {
  const h = data && data.hourly;
  if (!h || !Array.isArray(h.time)) {
    throw new Error("Unexpected Open-Meteo response shape.");
  }
  const out = [];
  for (let i = 0; i < h.time.length; i++) {
    out.push({
      time: h.time[i] * 1000, // unixtime (s) → ms
      speed: h.wind_speed_10m[i],
      fromDeg: h.wind_direction_10m[i],
      // new conditions fields; default safely if a field is absent
      tempC: h.temperature_2m ? h.temperature_2m[i] : null,
      precipMm: h.precipitation ? h.precipitation[i] : 0,
      precipProb: h.precipitation_probability ? h.precipitation_probability[i] : 0,
      snowfallCm: h.snowfall ? h.snowfall[i] : 0,
      weatherCode: h.weather_code ? h.weather_code[i] : null,
      gustKmh: h.wind_gusts_10m ? h.wind_gusts_10m[i] : null,
    });
  }
  out.sort((a, b) => a.time - b.time);
  return out;
}

/**
 * Build a windFn(lat, lon, atMs) for windFactorTimed from one or more
 * forecast series keyed to sample locations along the route. For short routes
 * a single midpoint series is enough; for longer routes pass several and the
 * nearest is used (wind varies little over a few km, so nearest-point is fine).
 *
 * @param {Array<{lat:number, lon:number, series:Array}>} stations
 * @returns {(lat:number,lon:number,atMs:number)=>{speed,fromDeg}}
 */
export function makeWindFn(stations) {
  if (!stations || stations.length === 0) {
    throw new Error("makeWindFn needs at least one station.");
  }
  return (lat, lon, atMs) => {
    let best = stations[0];
    if (stations.length > 1) {
      let bestD = Infinity;
      for (const st of stations) {
        const d = (st.lat - lat) ** 2 + (st.lon - lon) ** 2; // planar ok at km scale
        if (d < bestD) {
          bestD = d;
          best = st;
        }
      }
    }
    return sampleWind(best.series, atMs);
  };
}
