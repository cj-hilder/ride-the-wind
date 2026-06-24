/**
 * Ride the Wind — Prediction integration
 *
 * The glue that closes the loop between the four logic modules. It produces
 * the `predictForArrival(arrivalMs)` callback that alertEngine.evaluateAlert
 * consumes, by composing:
 *
 *   forecast (windModel) → wind_factor at the arrival window (windModel)
 *                        → predicted time from the learned model (learning)
 *
 * It also resolves two pieces of circularity that the individual modules
 * leave to the caller:
 *
 *  1. Arrival-window timing. wind_factor depends on *when* the rider is on
 *     each segment, which depends on the ride duration, which depends on
 *     wind_factor. We anchor on the arrival time (which is fixed by the user)
 *     and iterate departure ← arrival − predicted a couple of times. This
 *     converges fast (hourly forecast, short trips).
 *
 *  2. k applied once. windFactorTimed deliberately leaves k out (it weights by
 *     still-air time only). Here we apply the learned k exactly once, in the
 *     prediction step, so it never leaks into the convergence.
 *
 * This module performs no storage and no scheduling; it is handed a processed
 * route, a model state, a seed, and forecast stations, and returns a callback
 * plus a one-shot predict helper. Network (fetching the forecast) is the
 * caller's job via windModel.fetchForecast — kept out so this stays testable.
 */

import {
  segmentTimes,
  windFactorTimed,
  makeWindFn,
} from "./windModel.js";
import { resolveModel, predictFromModel } from "./learning.js";

/* ------------------------------------------------------------------ *
 * Station selection
 * ------------------------------------------------------------------ */

/**
 * Choose forecast sample locations along the route. Wind varies little over a
 * few km, so one midpoint suffices for short routes; longer routes get a few
 * evenly spaced points (spec §2.4). Returns [{lat, lon}] for the caller to
 * fetch forecasts at.
 *
 * @param {Object} route - processed route with segments + start/end
 * @param {Object} [opts]
 * @param {number} [opts.perKm=0.15] - target stations per km (≈ 1 per ~7km)
 * @param {number} [opts.max=4]
 * @returns {Array<{lat:number, lon:number}>}
 */
export function chooseStations(route, opts = {}) {
  const { perKm = 0.15, max = 4 } = opts;
  const segs = route.segments;
  if (!segs || segs.length === 0) {
    return [{ lat: route.start.lat, lon: route.start.lon }];
  }
  const km = route.totalDistance / 1000;
  const count = Math.max(1, Math.min(max, Math.round(km * perKm)));
  if (count === 1) {
    const mid = segs[Math.floor(segs.length / 2)];
    return [{ lat: mid.lat, lon: mid.lon }];
  }
  // evenly spaced by segment index
  const stations = [];
  for (let i = 0; i < count; i++) {
    const idx = Math.round((i / (count - 1)) * (segs.length - 1));
    stations.push({ lat: segs[idx].lat, lon: segs[idx].lon });
  }
  return stations;
}

/* ------------------------------------------------------------------ *
 * The prediction callback factory
 * ------------------------------------------------------------------ */

/**
 * Build the predictForArrival callback for one route. Resolves the learning
 * model ONCE here (from the curated ride log + the route's config), then the
 * returned callback does pure arithmetic per arrival — so the ensemble loop can
 * call it ~50× cheaply.
 *
 * @param {Object} args
 * @param {Object} args.route        - processed route (gpxRoute output)
 * @param {Array}  args.rides        - the route's ride log (any include state)
 * @param {Object} args.config       - { baselineMode, sliderBaselineSec, kMode,
 *                                       split, sliderKHead, sliderKTail }
 * @param {Array}  args.stationSeries - [{lat, lon, series}] forecast per station
 * @param {Object} [args.opts]
 * @param {number} [args.opts.passes=2]      - convergence passes
 * @param {boolean} [args.opts.useGradient=true]
 * @param {number} [args.opts.nowMs]         - for freeze evaluation (testable)
 * @returns {(arrivalMs:number)=>Object} predictForArrival.
 *          Also exposes `.resolved` (the resolveModel result, incl. `rides`
 *          with any freeze transitions to persist) on the returned function.
 */
export function makePredictor({ route, rides, config, stationSeries, opts = {} }) {
  const { passes = 2, useGradient = true, nowMs } = opts;
  const windFn = makeWindFn(stationSeries);

  // Resolve the model once. resolved.rides carries any current→historic freeze
  // transitions for the caller to persist.
  const resolved = resolveModel(rides ?? [], config, nowMs ?? Date.now());
  const baselineSec = resolved.baselineSec;
  const baseSpeedKmh = speedFromBaseline(route.totalDistance, baselineSec);
  const times = segmentTimes(route.segments, baseSpeedKmh, { useGradient });
  const provisional =
    resolved.baselineSource === "slider" &&
    resolved.kHeadSource === "slider" &&
    resolved.kTailSource === "slider";

  function predictForArrival(arrivalMs) {
    // Fixed-point: anchor on arrival, iterate departure ← arrival − predicted.
    let predictedSec = baselineSec; // first guess: still-air
    let windFactor = 0;
    let pr = predictFromModel(resolved, 0, { distanceM: route.totalDistance });

    for (let p = 0; p < passes; p++) {
      const departMs = arrivalMs - predictedSec * 1000;
      windFactor = windFactorTimed({
        segments: route.segments,
        times,
        windFn,
        departMs,
        passes: 1, // inner single pass; outer loop here drives convergence
      });
      pr = predictFromModel(resolved, windFactor, { distanceM: route.totalDistance });
      predictedSec = pr.predictedSec;
    }

    return {
      predictedSec,
      baselineSec: pr.baselineSec,
      k: pr.k,
      kHead: pr.kHead,
      kTail: pr.kTail,
      provisional,
      windFactor,
    };
  }
  predictForArrival.resolved = resolved;
  return predictForArrival;
}

/**
 * Derive an effective still-air speed (km/h) from the learned baseline time
 * over the route distance. Used only to weight segments; not user-facing.
 */
export function speedFromBaseline(distanceM, baselineSec) {
  if (!(baselineSec > 0) || !(distanceM > 0)) return 20; // sane default
  return (distanceM / baselineSec) * 3.6;
}

/* ------------------------------------------------------------------ *
 * Forecast-uncertainty range (spec §5)
 * ------------------------------------------------------------------ */

/**
 * Produce a departure-time range reflecting forecast wind uncertainty, by
 * perturbing the wind speed up/down and re-predicting. Forecast wind is the
 * dominant error source, so this is a more honest output than a single minute.
 *
 * The perturbation is applied by wrapping the station series; we do not mutate
 * the originals.
 *
 * @param {Object} args - same shape as makePredictor args
 * @param {number} arrivalMs
 * @param {Object} [opts]
 * @param {number} [opts.windRelError=0.25] - ±25% on wind speed
 * @returns {{centerSec:number, lowSec:number, highSec:number, windFactor:number, provisional:boolean}}
 */
export function predictWithRange(args, arrivalMs, opts = {}) {
  const { windRelError = 0.25 } = opts;
  const center = makePredictor(args)(arrivalMs);

  const scale = (factor) =>
    args.stationSeries.map((st) => ({
      ...st,
      series: st.series.map((s) => ({ ...s, speed: s.speed * factor })),
    }));

  // More wind → larger |wind_factor|. For a headwind that means slower (high
  // time); for a tailwind, faster. We compute both perturbations and take the
  // min/max predicted time so the range brackets the verdict either way.
  const up = makePredictor({ ...args, stationSeries: scale(1 + windRelError) })(arrivalMs);
  const down = makePredictor({ ...args, stationSeries: scale(1 - windRelError) })(arrivalMs);

  const lowSec = Math.min(center.predictedSec, up.predictedSec, down.predictedSec);
  const highSec = Math.max(center.predictedSec, up.predictedSec, down.predictedSec);

  return {
    centerSec: center.predictedSec,
    lowSec,
    highSec,
    windFactor: center.windFactor,
    provisional: center.provisional,
  };
}

/**
 * True forecast-uncertainty range from a weather ensemble. Runs the ride-time
 * model once per member and reads percentiles off the resulting distribution,
 * so the spread is the model's own honest uncertainty (narrow on settled days,
 * wide on uncertain ones) rather than a fixed ±%.
 *
 * @param {Object} args - same as makePredictor, but `ensemble` replaces the
 *                        wind in stationSeries:
 * @param {Array<{lat,lon, members: Array<series>}>} args.ensembleStations
 *        per station, an array of per-member wind series (windModel.parseEnsemble)
 * @param {number} arrivalMs
 * @param {Object} [opts]
 * @param {number} [opts.loPct=10] @param {number} [opts.hiPct=90]
 * @param {number} [opts.detSec] - deterministic predicted time, included as an
 *        extra weighted "member" (it is just another forecast, often better at
 *        short lead). Center and spread then emerge from ONE population.
 * @param {number} [opts.detFactor] - its signed wind_factor (for headProb)
 * @param {number} [opts.detWeight=0] - how many ordinary members it counts as
 * @returns {{centerSec, lowSec, highSec, members:number}|null}
 */
export function predictEnsembleRange(args, arrivalMs, opts = {}) {
  const { loPct = 10, hiPct = 90, detSec = null, detFactor = null, detWeight = 0 } = opts;
  const stations = args.ensembleStations;
  if (!stations || stations.length === 0) return null;
  const memberCount = Math.min(...stations.map((s) => s.members.length));
  if (!(memberCount > 1)) return null;

  const samples = []; // { t, w, f } weighted population
  for (let m = 0; m < memberCount; m++) {
    const stationSeries = stations.map((s) => ({
      lat: s.lat, lon: s.lon, series: s.members[m],
    }));
    const p = makePredictor({ ...args, stationSeries })(arrivalMs);
    if (p.predictedSec > 0) samples.push({ t: p.predictedSec, w: 1, f: p.windFactor });
  }
  if (samples.length < 2) return null;

  // Include the deterministic forecast as one more member, weighted by our
  // belief that it is better at short lead. weight 0 → pure ensemble.
  if (detSec > 0 && detWeight > 0) {
    samples.push({ t: detSec, w: detWeight, f: detFactor ?? 0 });
  }

  samples.sort((a, b) => a.t - b.t);
  const totalW = samples.reduce((s, x) => s + x.w, 0);

  // Weighted headwind probability (fraction of weighted members that slow).
  const headW = samples.reduce((s, x) => s + (x.f > 0 ? x.w : 0), 0);

  return {
    centerSec: weightedPercentile(samples, 50, totalW),
    lowSec: weightedPercentile(samples, loPct, totalW),
    highSec: weightedPercentile(samples, hiPct, totalW),
    members: samples.length,
    headCount: Math.round(headW),
    headProb: totalW ? headW / totalW : 0,
  };
}

/**
 * Weighted percentile over [{t, w}] sorted ascending by t. Uses the standard
 * cumulative-weight method with linear interpolation between adjacent samples,
 * so a fractional weight ramps the result smoothly (no integer jumps).
 */
export function weightedPercentile(samples, p, totalW) {
  if (samples.length === 1) return samples[0].t;
  const target = (p / 100) * totalW;
  let cum = 0;
  for (let i = 0; i < samples.length; i++) {
    const wMid = samples[i].w; // place each sample's mass at its midpoint
    const prevCum = cum;
    cum += wMid;
    // cumulative midpoint position of this sample
    const pos = prevCum + wMid / 2;
    if (pos >= target) {
      if (i === 0) return samples[0].t;
      const prevPos = (cum - wMid) - samples[i - 1].w / 2;
      const span = pos - prevPos;
      const frac = span > 0 ? (target - prevPos) / span : 0;
      return samples[i - 1].t + (samples[i].t - samples[i - 1].t) * Math.max(0, Math.min(1, frac));
    }
  }
  return samples[samples.length - 1].t;
}

/** Linear-interpolated percentile of a sorted array. */
export function percentile(sorted, p) {
  if (sorted.length === 1) return sorted[0];
  const idx = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(idx), hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}
