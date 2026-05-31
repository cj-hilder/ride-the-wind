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
 * Time handling is explicit and dependency-free. Arrival times are wall-clock
 * "HH:MM" on a given calendar day in the user's local zone; we resolve them to
 * epoch-ms using the runtime's local time (the device's zone, which is what the
 * rider cares about). For testing, a fixed "now" and a tz-offset shim can be
 * injected.
 */

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
export function nextActiveArrival(route, fromMs, opts = {}) {
  const { lookaheadDays = 8 } = opts;
  const active = new Set(route.activeDays || []);
  if (active.size === 0) return null;

  for (let d = 0; d < lookaheadDays; d++) {
    const day = new Date(fromMs + d * 86400e3);
    const code = WEEKDAY_CODE[day.getDay()];
    if (!active.has(code)) continue;

    const hhmm =
      (route.arrivalOverrides && route.arrivalOverrides[code]) ||
      route.targetArrival;
    const arrivalMs = atLocalTime(day, hhmm);

    // Skip a day whose arrival has already passed relative to fromMs.
    if (arrivalMs <= fromMs) continue;
    return { arrivalMs, weekday: code, arrivalHHMM: hhmm };
  }
  return null;
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
  const d = new Date(ms);
  const h = String(d.getHours()).padStart(2, "0");
  const m = String(d.getMinutes()).padStart(2, "0");
  return `${h}:${m}`;
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

  const next = nextActiveArrival(route, nowMs, opts);
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
    arrivalHHMM: next.arrivalHHMM,

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
    provisional: !!p.provisional,

    message: buildMessage(verdict, {
      deltaMin: Math.abs(Math.round(deltaSec / 60)),
      departureHHMM: formatHHMM(departureMs),
      normalDepartureHHMM: formatHHMM(normalDepartureMs),
      arrivalHHMM: next.arrivalHHMM,
      provisional: !!p.provisional,
    }),
  };
}

/**
 * Whether to actually surface a notification. Normal days stay silent (§4.2);
 * the in-app summary may still show the normal verdict, but push/notify should
 * not fire. Use this to gate the notification layer.
 */
export function shouldNotify(verdict) {
  return verdict && verdict.verdict !== VERDICT.NORMAL;
}

/* ------------------------------------------------------------------ *
 * Morning reconciliation (§4.3)
 * ------------------------------------------------------------------ */

/**
 * Compare a fresh morning verdict against the night-before one and decide
 * whether to update the user. The morning forecast is the one to trust; we
 * notify of a change only if the departure time has moved materially or the
 * verdict category flipped, to avoid waking someone for a one-minute drift.
 *
 * @param {Object} nightVerdict - prior evaluateAlert result (may be null)
 * @param {Object} morningVerdict - fresh evaluateAlert result
 * @param {Object} [opts]
 * @param {number} [opts.materialMin=3] - departure shift worth re-alerting
 * @returns {{changed:boolean, reason:string, verdict:Object}}
 */
export function reconcileMorning(nightVerdict, morningVerdict, opts = {}) {
  const { materialMin = 3 } = opts;
  if (!morningVerdict) {
    return { changed: false, reason: "no-morning", verdict: morningVerdict };
  }
  if (!nightVerdict) {
    return { changed: true, reason: "no-prior", verdict: morningVerdict };
  }
  if (nightVerdict.verdict !== morningVerdict.verdict) {
    return { changed: true, reason: "verdict-flip", verdict: morningVerdict };
  }
  const shiftMin =
    Math.abs(morningVerdict.departureMs - nightVerdict.departureMs) / 60000;
  if (shiftMin >= materialMin) {
    return { changed: true, reason: "departure-shift", verdict: morningVerdict };
  }
  return { changed: false, reason: "unchanged", verdict: morningVerdict };
}

/* ------------------------------------------------------------------ *
 * Messages (§4.4)
 * ------------------------------------------------------------------ */

export const DEFAULT_THRESHOLD_MIN = 4;

function buildMessage(verdict, ctx) {
  const provNote = ctx.provisional ? " (still learning — provisional)" : "";
  switch (verdict) {
    case VERDICT.HEADWIND:
      return (
        `Headwind — leave by ${ctx.departureHHMM} ` +
        `instead of ${ctx.normalDepartureHHMM} to arrive ${ctx.arrivalHHMM}` +
        provNote
      );
    case VERDICT.TAILWIND:
      return (
        `Tailwind — you can leave at ${ctx.departureHHMM}, ` +
        `about ${ctx.deltaMin} min later than usual, and still arrive ${ctx.arrivalHHMM}` +
        provNote
      );
    default:
      return `Normal morning — leave by ${ctx.departureHHMM} to arrive ${ctx.arrivalHHMM}${provNote}`;
  }
}

export { WEEKDAY, WEEKDAY_CODE };
