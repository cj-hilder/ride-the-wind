/**
 * Ride the Wind — Alert engine
 *
 * Turns a prediction into the morning verdict: leave early, sleep in, or a
 * normal day — expressed as a departure time (spec §4, §5).
 *
 * Design: this module is PURE decision logic. It does not fetch forecasts,
 * schedule timers, or fire notifications. It is handed everything it needs
 * (route config, model fit, a wind-factor-for-an-arrival function) and returns
 * a structured verdict. That keeps it:
 *   - testable offline with no clock/network,
 *   - identical for the night-before and morning runs (same call, different
 *     forecast freshness),
 * leaving fetching to windModel.js and scheduling/push to the service-worker
 * layer, which consume this output.
 *
 * Time handling: arrival times are wall-clock "HH:MM" on a given calendar day in
 * the user's local zone; we resolve them to epoch-ms using the runtime's local
 * time (the device's zone, which is what the rider cares about). For testing, a
 * fixed "now" and a tz-offset shim can be injected. Time *display* strings are
 * produced via the format seam (formatTimeOfDay) so they honour the 12/24-hour
 * setting; the underlying scheduling math stays independent of display units.
 */

import { formatTimeOfDay } from "./format.js";

export const VERDICT = {
  HEADWIND: "headwind", // leave earlier
  TAILWIND: "tailwind", // sleep in
  NORMAL: "normal", // within threshold — stay quiet
};

const WEEKDAY = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 };
const WEEKDAY_CODE = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"];

/* ------------------------------------------------------------------ *
 * Day / time resolution
 * ------------------------------------------------------------------ */

/**
 * Find the next active calendar day for a route at or after `fromMs`, and the
 * arrival instant on that day.
 *
 * @param {Object} route
 * @param {string[]} route.activeDays   - weekday codes, e.g. ["MO","TU","WE","TH","FR"]
 * @param {string} route.targetArrival  - "HH:MM" default arrival
 * @param {Object<string,string>} [route.arrivalOverrides] - weekday → "HH:MM"
 * @param {number} fromMs               - reference instant (epoch ms)
 * @param {Object} [opts]
 * @param {number} [opts.lookaheadDays=8]
 * @returns {{arrivalMs:number, weekday:string, arrivalHHMM:string}|null}
 */
/**
 * The route's configured time on a SPECIFIC calendar day, ignoring activeDays
 * and ignoring whether the time has passed. Used by the Plan tab, which shows
 * the forecast for any selected day regardless of the alert schedule.
 *
 * @param {Object} route
 * @param {number} dayMs - any instant within the target calendar day (local)
 * @param {string} [overrideHHMM] - Explore: use this time instead of the route's
 *        configured time, for a what-if forecast on this day
 * @returns {{arrivalMs:number, weekday:string, arrivalHHMM:string}}
 */
export function arrivalOnDate(route, dayMs, overrideHHMM) {
  const day = new Date(dayMs);
  const code = WEEKDAY_CODE[day.getDay()];
  const hhmm = overrideHHMM ||
    (route.arrivalOverrides && route.arrivalOverrides[code]) ||
    route.targetArrival;
  return { arrivalMs: atLocalTime(day, hhmm), weekday: code, arrivalHHMM: hhmm };
}

/**
 * Resolve "HH:MM" on the calendar date of `dateInDay` to epoch ms in local time.
 */
export function atLocalTime(dateInDay, hhmm) {
  const [h, m] = hhmm.split(":").map(Number);
  const d = new Date(dateInDay);
  d.setHours(h, m, 0, 0);
  return d.getTime();
}

/** Format an epoch-ms instant as local "HH:MM" (24h). */
export function formatHHMM(ms) {
  // Delegates to the display format seam so times respect the 12/24-hour setting.
  return formatTimeOfDay(ms) || "";
}

/* ------------------------------------------------------------------ *
 * The verdict
 * ------------------------------------------------------------------ */

/**
 * Evaluate the alert for a route's next active day.
 *
 * The caller supplies `predictForArrival(arrivalMs)` → { predictedSec,
 * baselineSec, k, provisional, windFactor }. This is where the wind model and
 * learning model are combined upstream (compute wind_factor at the arrival
 * window, then predict). Passing it in keeps this engine pure and lets the
 * night-before and morning runs differ only by the forecast behind that fn.
 *
 * @param {Object} route
 * @param {(arrivalMs:number)=>Object} predictForArrival
 * @param {Object} [opts]
 * @param {number} [opts.nowMs=Date.now()]
 * @param {number} [opts.thresholdMin] - per-call threshold (minutes)
 * @returns {Object|null} verdict, or null if no upcoming active day
 */
export function evaluateAlert(route, predictForArrival, opts = {}) {
  const nowMs = opts.nowMs ?? Date.now();
  const thresholdMin =
    opts.thresholdMin ??
    route.alertThresholdMin ??
    DEFAULT_THRESHOLD_MIN;

  // The caller always supplies the resolved arrival (a specific calendar day
  // at the route's configured or explored time). There is no scheduler.
  const next = opts.fixedArrival;
  if (!next) return null;

  const p = predictForArrival(next.arrivalMs);
  if (!p || !(p.predictedSec > 0) || !(p.baselineSec > 0)) return null;

  const deltaSec = p.predictedSec - p.baselineSec;
  const thresholdSec = thresholdMin * 60;

  let verdict;
  if (deltaSec > thresholdSec) verdict = VERDICT.HEADWIND;
  else if (deltaSec < -thresholdSec) verdict = VERDICT.TAILWIND;
  else verdict = VERDICT.NORMAL;

  const departureMs = next.arrivalMs - p.predictedSec * 1000;
  const normalDepartureMs = next.arrivalMs - p.baselineSec * 1000;

  return {
    verdict,
    routeId: route.id,
    routeName: route.name,
    weekday: next.weekday,
    arrivalMs: next.arrivalMs,
    arrivalHHMM: formatHHMM(next.arrivalMs),

    departureMs, // recommended departure for the forecast
    departureHHMM: formatHHMM(departureMs),
    normalDepartureMs, // departure on a still-air day
    normalDepartureHHMM: formatHHMM(normalDepartureMs),

    deltaSec, // signed: + = slower (headwind), − = faster (tailwind)
    deltaMin: Math.round(deltaSec / 60),
    thresholdMin,

    predictedSec: p.predictedSec,
    baselineSec: p.baselineSec,
    windFactor: p.windFactor ?? null,
    k: p.k ?? null,
    kHead: p.kHead ?? null,
    kTail: p.kTail ?? null,
    provisional: !!p.provisional,
  };
}

export const DEFAULT_THRESHOLD_MIN = 4;

export { WEEKDAY, WEEKDAY_CODE };
