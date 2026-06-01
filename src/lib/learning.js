/**
 * Ride the Wind — Learning update
 *
 * Refines, per route, the quantities the prediction depends on:
 *
 *     predicted_time = baseline_time × (1 + k × wind_factor)
 *
 * where k is ASYMMETRIC: kHead applies when wind_factor > 0 (headwind, slower)
 * and kTail when wind_factor < 0 (tailwind, faster). Shelter is often
 * directional, so the penalty per unit headwind effort and the saving per unit
 * tailwind effort differ; two independent slopes capture that, with a kink at
 * wind_factor = 0 where they agree (no effect either way).
 *
 *   - baseline_time : still-air ride time (seconds)
 *   - kHead, kTail  : directional wind sensitivities (dimensionless)
 *
 * from the history of confirmed-typical rides, each contributing a
 * (wind_factor, actual_time) pair plus an age for recency weighting.
 *
 * ── Why regress actual_time, not observed_ratio ──────────────────────
 * `baseline` is what we're learning, so dividing actual by it first is
 * circular. Multiply the model through by baseline and split the signed
 * wind_factor into a headwind term h = max(wf,0) and a tailwind term
 * t = min(wf,0):
 *
 *     actual ≈ baseline·1 + (baseline·kHead)·h + (baseline·kTail)·t
 *            =    A        +       B_h        ·h +       B_t        ·t
 *
 * A weighted linear regression on the design [1, h, t] recovers all three:
 *     baseline = A,  kHead = B_h / A,  kTail = B_t / A
 * No circularity; each slope is informed only by rides with wind in its
 * direction (h = 0 for tailwind rides, t = 0 for headwind rides).
 *
 * ── Online via weighted recursive least squares ──────────────────────
 * We keep the weighted normal-equations accumulators XtX (3×3 symmetric) and
 * Xty (3-vector). Each ride updates them in O(1); recency decay multiplies the
 * accumulators by a factor < 1 before adding the newest ride, so old rides
 * fade exponentially. The state is still recomputable from the ride log by
 * replaying rides oldest-to-newest.
 */

// Confidence-widening k clamp. The band tightens when data is thin (guarding
// against a flukey early fit) and relaxes toward the full physical range as
// rides accumulate in that direction. Felt-wind reduction spans ~0.15 (dense
// urban) to ~2.0 (high-rise channelling); since k ≈ (speed factor)², that's
// ~0.05–4.0 fully open. At zero rides we hold near the seed (0.2–1.0).
const K_TIGHT_MIN = 0.2;
const K_TIGHT_MAX = 1.0;
const K_FULL_MIN = 0.05;
const K_FULL_MAX = 4.0;
const K_WIDEN_RIDES = 10; // directional rides to reach the full band

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
    // Weighted normal equations for design x = [1, h, t]:
    //   h = max(wind_factor, 0)  (headwind term)
    //   t = min(wind_factor, 0)  (tailwind term, ≤ 0)
    // XtX is symmetric; store its 6 unique entries. Xty is the 3-vector.
    //   indices: 0 = const, 1 = head, 2 = tail
    xtx: [0, 0, 0,   // [00, 01, 02]
             0, 0,   //      [11, 12]
                0],  //           [22]
    xty: [0, 0, 0],
    // separate ride counts per direction, for identifiability/confidence
    n: 0,        // total usable rides
    nHead: 0,    // rides with a meaningful headwind (h > 0)
    nTail: 0,    // rides with a meaningful tailwind (t < 0)
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
  const { tol = 0.4, minRides = 5, seed } = opts;
  if (state.n < minRides) {
    return { flagged: false, predicted: null, ratio: null };
  }
  const fit = fitModel(state, {
    seedKHead: seed?.kHead ?? 1.0,
    seedKTail: seed?.kTail ?? 1.0,
  });
  if (!fit || !fit.baselineSec) return { flagged: false, predicted: null, ratio: null };
  const k = windFactor >= 0 ? fit.kHead : fit.kTail;
  const predicted = fit.baselineSec * (1 + k * windFactor);
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
  const h = Math.max(windFactor, 0);     // headwind term
  const t = Math.min(windFactor, 0);     // tailwind term (≤ 0)
  const y = actualSec;
  // design row x = [1, h, t]; add x·xᵀ (weight 1) to decayed XtX, x·y to Xty
  const xtx = state.xtx;
  const xty = state.xty;
  return {
    ...state,
    xtx: [
      xtx[0] * d + 1,        // 00: 1·1
      xtx[1] * d + h,        // 01: 1·h
      xtx[2] * d + t,        // 02: 1·t
      xtx[3] * d + h * h,    // 11: h·h
      xtx[4] * d + h * t,    // 12: h·t
      xtx[5] * d + t * t,    // 22: t·t
    ],
    xty: [
      xty[0] * d + y,        // 1·y
      xty[1] * d + h * y,    // h·y
      xty[2] * d + t * y,    // t·y
    ],
    n: state.n + 1,
    nHead: state.nHead + (h > 0 ? 1 : 0),
    nTail: state.nTail + (t < 0 ? 1 : 0),
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
/**
 * Solve the weighted least-squares fit for baseline, kHead, kTail from the
 * normal-equations accumulators. Degrades gracefully:
 *   - both directions have spread → full 3-param solve
 *   - only one direction has spread → fit intercept + that slope, hold the
 *     other at its seed (each slope informed only by its own rides)
 *   - neither → weighted-mean baseline, both slopes at seed
 *
 * @param {Object} state
 * @param {Object} [opts]
 * @param {number} [opts.seedKHead=1.0]
 * @param {number} [opts.seedKTail=1.0]
 * @returns {{baselineSec, kHead, kTail, identifiableHead, identifiableTail}|null}
 */
export function fitModel(state, opts = {}) {
  const { seedKHead = 1.0, seedKTail = 1.0, seedK } = opts;
  // seedK kept for back-compat callers; use it for both sides if given.
  const sH = seedKHead ?? seedK ?? 1.0;
  const sT = seedKTail ?? seedK ?? 1.0;
  if (state.n === 0) return null;

  const m = state.xtx;
  const sw = m[0]; // Σw (the [0][0] entry, since const·const = 1)
  if (!(sw > 0)) return null;

  // Weighted spread of each directional term, to judge identifiability.
  // var(h) = E[h²] − E[h]²  using weighted sums.
  const meanH = m[1] / sw, meanT = m[2] / sw;
  const varH = m[3] / sw - meanH * meanH;
  const varT = m[5] / sw - meanT * meanT;
  const MIN_STD = 0.1;                 // same threshold as before, per side
  const haveH = varH > MIN_STD * MIN_STD && state.nHead >= 2;
  const haveT = varT > MIN_STD * MIN_STD && state.nTail >= 2;

  // Helper: weighted mean time (baseline fallback)
  const meanY = state.xty[0] / sw;

  if (haveH && haveT) {
    const sol = solve3(m, state.xty);
    if (sol && sol[0] > 0) {
      return {
        baselineSec: sol[0],
        kHead: clampK(sol[1] / sol[0], state.nHead),
        kTail: clampK(sol[2] / sol[0], state.nTail),
        identifiableHead: true,
        identifiableTail: true,
      };
    }
    // fall through to degraded paths on a pathological solve
  }

  // One-direction fits: regress y on [1, term] for the direction that has
  // spread; hold the other slope at seed. Uses the relevant 2×2 subsystem.
  if (haveH && !haveT) {
    const fit = solve2(sw, m[1], m[3], state.xty[0], state.xty[1]); // const + head
    if (fit && fit.A > 0) {
      return {
        baselineSec: fit.A,
        kHead: clampK(fit.B / fit.A, state.nHead),
        kTail: clampK(sT, 0),
        identifiableHead: true,
        identifiableTail: false,
      };
    }
  }
  if (haveT && !haveH) {
    const fit = solve2(sw, m[2], m[5], state.xty[0], state.xty[2]); // const + tail
    if (fit && fit.A > 0) {
      return {
        baselineSec: fit.A,
        kHead: clampK(sH, 0),
        kTail: clampK(fit.B / fit.A, state.nTail),
        identifiableHead: false,
        identifiableTail: true,
      };
    }
  }

  // Neither identifiable (e.g. only near-calm rides): mean time + seeds.
  return {
    baselineSec: meanY > 0 ? meanY : null,
    kHead: clampK(sH, 0),
    kTail: clampK(sT, 0),
    identifiableHead: false,
    identifiableTail: false,
  };
}

/**
 * Solve a 2-variable weighted normal system for y = A + B·u:
 *   [ sw    su  ] [A]   [sy ]
 *   [ su    suu ] [B] = [suy]
 * given sw=Σw, su=Σw·u, suu=Σw·u², sy=Σw·y, suy=Σw·u·y.
 */
function solve2(sw, su, suu, sy, suy) {
  const det = sw * suu - su * su;
  if (!(Math.abs(det) > 1e-9)) return null;
  const A = (suu * sy - su * suy) / det;
  const B = (sw * suy - su * sy) / det;
  return { A, B };
}

/**
 * Solve the symmetric 3×3 system XtX·β = Xty for β, where XtX is given by its
 * 6 unique entries [00,01,02,11,12,22]. Returns [β0,β1,β2] or null if singular.
 * Uses cofactor expansion (small fixed size, no pivoting needed for a
 * well-conditioned weighted Gram matrix; singular → null).
 */
function solve3(m, b) {
  const a00 = m[0], a01 = m[1], a02 = m[2], a11 = m[3], a12 = m[4], a22 = m[5];
  // cofactors of the symmetric matrix
  const c00 = a11 * a22 - a12 * a12;
  const c01 = a12 * a02 - a01 * a22;
  const c02 = a01 * a12 - a11 * a02;
  const det = a00 * c00 + a01 * c01 + a02 * c02;
  if (!(Math.abs(det) > 1e-9)) return null;
  const c11 = a00 * a22 - a02 * a02;
  const c12 = a02 * a01 - a00 * a12;
  const c22 = a00 * a11 - a01 * a01;
  // inverse · b  (inverse = adjugate/det; adjugate is symmetric here)
  const inv = det;
  const x0 = (c00 * b[0] + c01 * b[1] + c02 * b[2]) / inv;
  const x1 = (c01 * b[0] + c11 * b[1] + c12 * b[2]) / inv;
  const x2 = (c02 * b[0] + c12 * b[1] + c22 * b[2]) / inv;
  return [x0, x1, x2];
}

/**
 * Clamp k to a band that widens with directional ride count n. At n=0 the band
 * is tight (near seed); it interpolates linearly to the full physical range by
 * K_WIDEN_RIDES rides. n is the count of rides in the relevant direction
 * (nHead for kHead, nTail for kTail).
 */
function clampK(k, n = 0) {
  const DEFAULT_FALLBACK = 0.33;
  if (!Number.isFinite(k)) return DEFAULT_FALLBACK;
  const f = Math.max(0, Math.min(1, n / K_WIDEN_RIDES)); // 0 → tight, 1 → full
  const lo = K_TIGHT_MIN + (K_FULL_MIN - K_TIGHT_MIN) * f;
  const hi = K_TIGHT_MAX + (K_FULL_MAX - K_TIGHT_MAX) * f;
  return Math.max(lo, Math.min(hi, k));
}

/* ------------------------------------------------------------------ *
 * Convenience: predict + confidence
 * ------------------------------------------------------------------ */

/**
 * Predicted ride time for a given wind_factor using the current model.
 * Falls back to the supplied seed baseline/k when the model can't fit yet.
 *
 * The raw model predicted = baseline·(1 + k·wind_factor) is fine near calm but
 * unphysical at strong wind: a big tailwind drives the multiplier toward zero
 * or negative (impossible), a big headwind unbounded. The real limits are on
 * SPEED, so we clamp the implied average speed and convert back to time:
 *   - headwind floor: the rider can always at least walk → WALK_PACE (5 km/h)
 *   - tailwind ceiling: bike control → SPEED_CAP × still-air speed (3×)
 * Expressing the headwind limit as walking pace makes it route-aware: a route
 * ridden at 30 km/h caps at a 6× time blow-out, a 15 km/h route at 3×.
 *
 * @param {Object} state
 * @param {number} windFactor
 * @param {Object} seed - { baselineSec, kHead, kTail }
 * @param {Object} [opts]
 * @param {number} [opts.distanceM] - route distance (m); enables the route-aware
 *        walking-pace headwind ceiling. Without it, a fixed fallback is used.
 * @param {number} [opts.walkPaceKmh=5]
 * @param {number} [opts.speedCapMult=3] - tailwind ceiling as ×still-air speed
 * @returns {{predictedSec, baselineSec, k, kHead, kTail, provisional, multiplier, clamped}}
 */
export function predict(state, windFactor, seed, opts = {}) {
  const { distanceM = null, walkPaceKmh = 5, speedCapMult = 3, multMaxFallback = 6 } = opts;
  const seedKHead = seed.kHead ?? seed.k ?? 0.33;
  const seedKTail = seed.kTail ?? seed.k ?? 0.33;
  const fit = fitModel(state, { seedKHead, seedKTail });
  const baselineSec = fit && fit.baselineSec ? fit.baselineSec : seed.baselineSec;
  const kHead = fit ? fit.kHead : seedKHead;
  const kTail = fit ? fit.kTail : seedKTail;
  // directional sensitivity: headwind (wf>0) uses kHead, tailwind uses kTail
  const k = windFactor >= 0 ? kHead : kTail;

  const raw = 1 + k * windFactor;

  // Speed-clamp expressed as bounds on the time multiplier:
  //   tailwind ceiling: speed ≤ speedCapMult × still → multiplier ≥ 1/speedCapMult
  //   headwind floor:   speed ≥ walkPace → multiplier ≤ stillSpeed/walkPace
  const multMin = 1 / speedCapMult;
  let multMax = multMaxFallback;
  if (distanceM > 0 && baselineSec > 0) {
    const stillSpeedKmh = (distanceM / 1000) / (baselineSec / 3600);
    multMax = Math.max(1, stillSpeedKmh / walkPaceKmh); // never below 1 (no wind can't speed a headwind cap)
  }
  const multiplier = Math.max(multMin, Math.min(multMax, raw));
  return {
    predictedSec: baselineSec * multiplier,
    baselineSec,
    k,
    kHead,
    kTail,
    multiplier,
    clamped: multiplier !== raw,
    provisional: !fit || (!fit.identifiableHead && !fit.identifiableTail),
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
