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
 * Normalised signed-square effort contribution of a headwind.
 *
 *   f_norm(h) = sign(h) · (h / w_ref)²
 *
 * The square encodes that drag rises with the square of air speed, so a
 * headwind costs more than an equal tailwind saves; the sign preserves the
 * helping/hurting direction. This asymmetry is what makes "leave early" and
 * "sleep in" non-symmetric, which is the whole point of the product.
 *
 * @param {number} headwind   - signed headwind (km/h)
 * @param {number} [wRef=20]  - reference wind (km/h)
 */
export function effortNorm(headwind, wRef = W_REF_KMH) {
  const r = headwind / wRef;
  return Math.sign(headwind) * r * r;
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
export function computeWindFactor(segments, windAt, times, wRef = W_REF_KMH) {
  let num = 0;
  let den = 0;
  for (let i = 0; i < segments.length; i++) {
    const w = windAt(i);
    const h = windComponent(w.speed, w.fromDeg, segments[i].bearing);
    const t = times[i];
    num += t * effortNorm(h, wRef);
    den += t;
  }
  return den > 0 ? num / den : 0;
}

/**
 * Seed the route wind sensitivity `k` from the optional setup estimates.
 *
 * The user may give still-air, 20 km/h-headwind, and 20 km/h-tailwind times.
 * Under the model predicted_time = baseline·(1 + k·wind_factor), a pure
 * head/tailwind at exactly w_ref over the whole route gives wind_factor = ±1
 * (since f_norm(±w_ref) = ±1 and the time-weighting cancels). So:
 *
 *   t_head = t_still · (1 + k)      →  k_head = t_head/t_still − 1
 *   t_tail = t_still · (1 − k)      →  k_tail = 1 − t_tail/t_still
 *
 * We average the two implied estimates when both are present, use whichever
 * is present alone, and fall back to DEFAULT_K if neither is given.
 *
 * @param {number} stillAirSec
 * @param {number|null} headwind20Sec
 * @param {number|null} tailwind20Sec
 * @returns {number} seeded k (>0)
 */
/**
 * Default wind sensitivity when the user gives no directional seed estimate.
 * Set from real data: a measured k ≈ 0.5 on an exposed Otago Harbour route is
 * an upper anchor (harbour edges are windier than sheltered streets), so a
 * typical commute with some urban shelter sits below it. 0.33 lands the default
 * in typical-sheltered territory — a third under the one exposed-route
 * measurement — and is far more realistic than the old 1.0. Tune as more
 * routes' learned k values accumulate.
 */
export const DEFAULT_K = 0.33;

export function seedK(stillAirSec, headwind20Sec, tailwind20Sec) {
  if (!(stillAirSec > 0)) return DEFAULT_K;
  const estimates = [];
  if (headwind20Sec != null && headwind20Sec > 0) {
    estimates.push(headwind20Sec / stillAirSec - 1);
  }
  if (tailwind20Sec != null && tailwind20Sec > 0) {
    estimates.push(1 - tailwind20Sec / stillAirSec);
  }
  if (estimates.length === 0) return DEFAULT_K;
  const k = estimates.reduce((a, b) => a + b, 0) / estimates.length;
  // Keep within the same sane band the learning update enforces.
  return Math.max(0.05, Math.min(4.0, k));
}

/**
 * Asymmetric seed: independent kHead and kTail from the directional setup
 * estimates. kHead from the headwind estimate (headwind20Sec/stillAir − 1),
 * kTail from the tailwind estimate (1 − tailwind20Sec/stillAir). Each side
 * defaults to DEFAULT_K if its estimate is absent. Both clamped to 0.2–3.0.
 */
export function seedKSplit(stillAirSec, headwind20Sec, tailwind20Sec) {
  // User setup estimates are explicit prior knowledge, not a noisy fit, so we
  // clamp only to the full physical range (0.05–4.0), not the tight early band.
  const clamp = (x) => Math.max(0.05, Math.min(4.0, x));
  let kHead = DEFAULT_K, kTail = DEFAULT_K;
  if (stillAirSec > 0) {
    if (headwind20Sec != null && headwind20Sec > 0) {
      kHead = clamp(headwind20Sec / stillAirSec - 1);
    }
    if (tailwind20Sec != null && tailwind20Sec > 0) {
      kTail = clamp(1 - tailwind20Sec / stillAirSec);
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
  return { speed, fromDeg, tempC, precipMm: a.precipMm ?? 0, precipProb: a.precipProb ?? 0 };
}

function pick(s) {
  return { speed: s.speed, fromDeg: s.fromDeg, tempC: s.tempC ?? null, precipMm: s.precipMm ?? 0, precipProb: s.precipProb ?? 0 };
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
  wRef = W_REF_KMH,
  passes = 2,
}) {
  const totalStill = times.reduce((a, b) => a + b, 0);
  // Initial guess: wind sampled at departure for all segments.
  let factor = 0;
  for (let p = 0; p < passes; p++) {
    // ride-time multiplier from current factor estimate
    const mult = 1 + /*k folded out*/ factor; // k applied by caller; weighting only
    let clock = departMs;
    const windAt = (i) => {
      const s = segments[i];
      const w = windFn(s.lat, s.lon, clock);
      // advance clock by this segment's (scaled) time for the next lookup
      clock += times[i] * Math.max(0.5, mult) * 1000;
      return w;
    };
    factor = computeWindFactor(segments, windAt, times, wRef);
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
  const { forecastDays = 8, fetchImpl } = opts;
  const f = fetchImpl || (typeof fetch !== "undefined" ? fetch : null);
  if (!f) throw new Error("No fetch available; inject opts.fetchImpl.");

  const url =
    `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}` +
    `&hourly=wind_speed_10m,wind_direction_10m,temperature_2m,precipitation,precipitation_probability` +
    `&wind_speed_unit=kmh&timeformat=unixtime&forecast_days=${forecastDays}`;

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
  const { forecastDays = 8, fetchImpl, model = "ecmwf_ifs025" } = opts;
  const f = fetchImpl || (typeof fetch !== "undefined" ? fetch : null);
  if (!f) throw new Error("No fetch available; inject opts.fetchImpl.");

  const url =
    `https://ensemble-api.open-meteo.com/v1/ensemble?latitude=${lat}&longitude=${lon}` +
    `&hourly=wind_speed_10m,wind_direction_10m` +
    `&models=${model}&wind_speed_unit=kmh&timeformat=unixtime&forecast_days=${forecastDays}`;

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
    const series = [];
    for (let i = 0; i < times.length; i++) {
      series.push({ time: times[i] * 1000, speed: speeds[i], fromDeg: dirs[i] });
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
