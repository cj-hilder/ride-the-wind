/**
 * Ride the Wind — Learning update
 *
 * Refines, per route, the two quantities the prediction depends on:
 *
 *     predicted_time = baseline_time × (1 + k × wind_factor)
 *
 *   - baseline_time : still-air ride time (seconds)
 *   - k             : route wind sensitivity (dimensionless)
 *
 * from the history of confirmed-typical rides, each contributing a
 * (wind_factor, actual_time) pair plus an age for recency weighting.
 *
 * ── Why regress actual_time, not observed_ratio ──────────────────────
 * The spec frames the fit as observed_ratio = actual/baseline ≈ 1 + k·wf.
 * But `baseline` is exactly what we're trying to learn, so dividing by it
 * first is circular — a wrong baseline biases every ratio and leaks into k.
 *
 * Multiply the model through by baseline:
 *
 *     actual_time ≈ baseline + (baseline·k)·wind_factor
 *                 =   A      +      B      ·wind_factor      (a plain line)
 *
 * So a single weighted linear regression of actual_time on wind_factor gives:
 *     baseline = A   (the intercept, in seconds)
 *     k        = B / A
 *
 * Both fall out of one fit, with no circularity. Near-calm rides (wf≈0)
 * pin down A (the baseline) and contribute little to the slope, which is
 * correct — they genuinely carry no information about wind sensitivity.
 *
 * ── Online via weighted recursive least squares ──────────────────────
 * We keep only six weighted sufficient statistics (Σw, Σwx, Σwx², Σwy,
 * Σwxy, n). Each new ride updates them in O(1); recency decay multiplies
 * the accumulated stats by a factor < 1 before adding the newest ride, so
 * old rides fade exponentially. The whole state is still recomputable from
 * the ride log (data spec §3.3) by replaying rides oldest-to-newest.
 */

const K_MIN = 0.2;
const K_MAX = 3.0;

/* ------------------------------------------------------------------ *
 * Sufficient-statistics container
 * ------------------------------------------------------------------ */

/**
 * Create an empty model state. `halfLifeRides` sets how fast old rides fade:
 * after this many newer rides, an observation's weight has halved. Tune for
 * how quickly the route should track fitness/seasonal change.
 *
 * @param {Object} [opts]
 * @param {number} [opts.halfLifeRides=30]
 */
export function createModelState(opts = {}) {
  const halfLifeRides = opts.halfLifeRides ?? 30;
  return {
    // weighted sums
    sw: 0, // Σ w
    swx: 0, // Σ w·x        (x = wind_factor)
    swxx: 0, // Σ w·x²
    swy: 0, // Σ w·y        (y = actual_time, seconds)
    swxy: 0, // Σ w·x·y
    n: 0, // usable ride count (unweighted)
    // decay applied to existing stats per new ride
    decay: Math.pow(0.5, 1 / halfLifeRides),
    halfLifeRides,
  };
}

/* ------------------------------------------------------------------ *
 * Outlier check (spec §3.4)
 * ------------------------------------------------------------------ */

/**
 * Decide whether a ride looks anomalous versus what the current model would
 * have predicted. Used to auto-flag (not silently drop) per spec §3.4 — the
 * UI can then ask the user to confirm before it learns from the ride.
 *
 * Returns { flagged, predicted, ratio }. `ratio` is actual/predicted.
 *
 * @param {Object} state
 * @param {number} windFactor
 * @param {number} actualSec
 * @param {Object} [opts]
 * @param {number} [opts.tol=0.4] - flag if actual is >40% off prediction
 * @param {number} [opts.minRides=5] - below this, don't flag (model too green)
 */
export function checkOutlier(state, windFactor, actualSec, opts = {}) {
  const { tol = 0.4, minRides = 5 } = opts;
  const fit = fitModel(state);
  if (!fit || state.n < minRides) {
    return { flagged: false, predicted: null, ratio: null };
  }
  const predicted = fit.baselineSec * (1 + fit.k * windFactor);
  if (!(predicted > 0)) return { flagged: false, predicted, ratio: null };
  const ratio = actualSec / predicted;
  return { flagged: Math.abs(ratio - 1) > tol, predicted, ratio };
}

/* ------------------------------------------------------------------ *
 * The update
 * ------------------------------------------------------------------ */

/**
 * Incorporate one confirmed-typical ride into the model state (mutates a
 * copy, returns it). Applies recency decay to existing stats first, then
 * adds the new observation with full weight.
 *
 * @param {Object} state      - from createModelState (treated immutably)
 * @param {number} windFactor - x
 * @param {number} actualSec  - y (seconds)
 * @returns {Object} new state
 */
export function updateModel(state, windFactor, actualSec) {
  if (!(actualSec > 0) || !Number.isFinite(windFactor)) return state;
  const d = state.decay;
  const x = windFactor;
  const y = actualSec;
  return {
    ...state,
    sw: state.sw * d + 1,
    swx: state.swx * d + x,
    swxx: state.swxx * d + x * x,
    swy: state.swy * d + y,
    swxy: state.swxy * d + x * y,
    n: state.n + 1,
  };
}

/* ------------------------------------------------------------------ *
 * The fit
 * ------------------------------------------------------------------ */

/**
 * Solve the weighted least-squares line y = A + B·x from the sufficient
 * statistics, then map to baseline and k:
 *
 *     baselineSec = A
 *     k           = clamp(B / A, 0.2, 3.0)
 *
 * Returns null until there is enough signal to fit. When rides exist but the
 * design is degenerate (all wind_factor ≈ equal — e.g. only calm rides), the
 * slope is unidentifiable; we then return the weighted-mean time as the
 * baseline and leave k at its current best estimate / seed.
 *
 * @param {Object} state
 * @param {Object} [opts]
 * @param {number} [opts.seedK=1.0] - fallback k when slope unidentifiable
 * @returns {{baselineSec:number, k:number, identifiable:boolean}|null}
 */
export function fitModel(state, opts = {}) {
  const { seedK = 1.0 } = opts;
  if (state.n === 0 || state.sw <= 0) return null;

  const meanX = state.swx / state.sw;
  const meanY = state.swy / state.sw;
  // weighted variance of x and covariance(x,y)
  const varX = state.swxx / state.sw - meanX * meanX;
  const covXY = state.swxy / state.sw - meanX * meanY;

  // x-spread too small → slope unidentifiable (e.g. only near-calm rides).
  // The guard is on the *standard deviation* of wind_factor, not a near-zero
  // float epsilon: we need a meaningful spread of wind conditions before a
  // slope (and hence k) can be trusted. ~0.1 std in wind_factor corresponds
  // to roughly a ±6 km/h headwind spread across rides — below that, k is not
  // identifiable from data and we hold the seed.
  const MIN_X_STD = 0.1;
  if (varX < MIN_X_STD * MIN_X_STD) {
    const baselineSec = meanY; // best baseline = weighted mean time
    return {
      baselineSec,
      k: clampK(seedK),
      identifiable: false,
    };
  }

  const B = covXY / varX; // slope
  const A = meanY - B * meanX; // intercept = baseline

  if (!(A > 0)) {
    // pathological fit; fall back to mean time, keep seed k
    return { baselineSec: meanY, k: clampK(seedK), identifiable: false };
  }

  return {
    baselineSec: A,
    k: clampK(B / A),
    identifiable: true,
  };
}

function clampK(k) {
  if (!Number.isFinite(k)) return 1.0;
  return Math.max(K_MIN, Math.min(K_MAX, k));
}

/* ------------------------------------------------------------------ *
 * Convenience: predict + confidence
 * ------------------------------------------------------------------ */

/**
 * Predicted ride time for a given wind_factor using the current model.
 * Falls back to the supplied seed baseline/k when the model can't fit yet,
 * so the app always has a number (provisional early on, per spec §3.5).
 *
 * The raw model is predicted = baseline·(1 + k·wind_factor). That linear form
 * is fine near calm but breaks at strong wind: a large tailwind drives the
 * multiplier toward zero or negative (an impossible negative ride time), and a
 * large headwind would let it grow without bound. Time scales inversely with
 * effective speed, which is physically bounded, so we clamp the multiplier to
 * a sane band: a tailwind saves at most ~40% of time, a headwind roughly
 * triples it at the extreme. The clamp only bites in conditions far beyond a
 * normal commute; in the everyday range the model is untouched.
 *
 * @param {Object} state
 * @param {number} windFactor
 * @param {Object} seed - { baselineSec, k }
 * @param {Object} [opts]
 * @param {number} [opts.multMin=0.6] - fastest a tailwind can make the ride
 * @param {number} [opts.multMax=3.0] - slowest a headwind can make it
 * @returns {{predictedSec:number, baselineSec:number, k:number, provisional:boolean, multiplier:number, clamped:boolean}}
 */
export function predict(state, windFactor, seed, opts = {}) {
  const { multMin = 0.6, multMax = 3.0 } = opts;
  const fit = fitModel(state, { seedK: seed.k });
  const baselineSec = fit ? fit.baselineSec : seed.baselineSec;
  const k = fit ? fit.k : seed.k;

  const raw = 1 + k * windFactor;
  const multiplier = Math.max(multMin, Math.min(multMax, raw));
  return {
    predictedSec: baselineSec * multiplier,
    baselineSec,
    k,
    multiplier,
    clamped: multiplier !== raw,
    provisional: !fit || !fit.identifiable,
  };
}

/**
 * Confidence label from usable ride count (spec §3.5). Thresholds are a
 * starting point; the UI maps these to its own copy/visuals.
 */
export function confidence(state, opts = {}) {
  const { provisionalBelow = 5, goodAbove = 15 } = opts;
  const n = state.n;
  if (n < provisionalBelow) return { level: "provisional", rides: n };
  if (n < goodAbove) return { level: "learning", rides: n };
  return { level: "good", rides: n };
}

/* ------------------------------------------------------------------ *
 * Rebuild from log (data spec §3.3 recompute op)
 * ------------------------------------------------------------------ */

/**
 * Recompute model state from scratch by replaying usable rides
 * oldest-to-newest. Used after an algorithm change, or to verify the live
 * online state. Rides must be sorted ascending by time so decay is applied
 * in the right order.
 *
 * @param {Array<{windFactor:number, actualSec:number, usable:boolean}>} rides
 * @param {Object} [opts] - passed to createModelState
 */
export function rebuildFromRides(rides, opts = {}) {
  let state = createModelState(opts);
  for (const r of rides) {
    if (r.usable) state = updateModel(state, r.windFactor, r.actualSec);
  }
  return state;
}
