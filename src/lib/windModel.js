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
 * is present alone, and fall back to 1.0 if neither is given.
 *
 * @param {number} stillAirSec
 * @param {number|null} headwind20Sec
 * @param {number|null} tailwind20Sec
 * @returns {number} seeded k (>0)
 */
export function seedK(stillAirSec, headwind20Sec, tailwind20Sec) {
  if (!(stillAirSec > 0)) return 1.0;
  const estimates = [];
  if (headwind20Sec != null && headwind20Sec > 0) {
    estimates.push(headwind20Sec / stillAirSec - 1);
  }
  if (tailwind20Sec != null && tailwind20Sec > 0) {
    estimates.push(1 - tailwind20Sec / stillAirSec);
  }
  if (estimates.length === 0) return 1.0;
  const k = estimates.reduce((a, b) => a + b, 0) / estimates.length;
  // Keep within the same sane band the learning update enforces.
  return Math.max(0.2, Math.min(3.0, k));
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
  const t = (atMs - a.time) / (b.time - a.time);

  // interpolate direction on the circle to avoid the 350°→10° wraparound bug
  const fromDeg = interpAngle(a.fromDeg, b.fromDeg, t);
  const speed = a.speed + (b.speed - a.speed) * t;
  return { speed, fromDeg };
}

function pick(s) {
  return { speed: s.speed, fromDeg: s.fromDeg };
}

/** Shortest-path angular interpolation, degrees. */
export function interpAngle(a, b, t) {
  let diff = ((b - a + 540) % 360) - 180; // signed shortest delta in (−180,180]
  return ((a + diff * t) % 360 + 360) % 360;
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
  const { forecastDays = 2, fetchImpl } = opts;
  const f = fetchImpl || (typeof fetch !== "undefined" ? fetch : null);
  if (!f) throw new Error("No fetch available; inject opts.fetchImpl.");

  const url =
    `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}` +
    `&hourly=wind_speed_10m,wind_direction_10m` +
    `&wind_speed_unit=kmh&timeformat=unixtime&forecast_days=${forecastDays}`;

  const res = await f(url);
  if (!res.ok) throw new Error(`Open-Meteo HTTP ${res.status}`);
  const data = await res.json();
  return parseForecast(data);
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
