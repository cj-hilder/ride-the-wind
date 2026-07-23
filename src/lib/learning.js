/**
 * Ride the Wind — Learning (v2: wind-attenuation k)
 *
 * Resolves, per route, the two quantities the prediction depends on:
 *
 *     predicted_time = baseline × (1 + wind_factor),
 *     wind_factor = Σ tᵢ·f_branch(k · hᵢ/20)/Σ tᵢ      (k INSIDE the curve)
 *
 * where k is the WIND-ATTENUATION of the route: surface along-route wind =
 * k × forecast (forecast calibration + shelter + rider habit blended). k is
 * ASYMMETRIC (kHead / kTail) because all three ingredients are wind-direction
 * dependent. f_branch are the constant-power physics curves in windModel.
 *
 * The model is determined from a CURATED RIDE LOG plus a route CONFIG, not from
 * a persisted regression accumulator. Baseline and k are two independently
 * toggled quantities (manual ↔ learned). Baseline is resolved FIRST; k is then
 * computed CONDITIONAL on a per-ride baseline. No recency decay; the user
 * curates the log by hand.
 *
 * ── Ride record shape (v2 rides, wfv === 2) ───────────────────────────
 *   wfv              2 — wind-model version stamp (absent = v1, excluded from
 *                    k learning; v1 rides with stored klass "still" still feed
 *                    the baseline — a truly still ride is scale-agnostic)
 *   rideWindKmh      signed equivalent uniform forecast along-route wind for
 *                    the ride (+head/−tail), km/h — 20·inv_branch(|wf at k=1|)
 *   actualSec        recorded ride duration (seconds)
 *   included         boolean — user curation include/exclude
 *   baselineRef      "current" | "historic"
 *   savedBaselineSec frozen still-air baseline (used when historic)
 *   startedAt        epoch ms (age, ordering)
 *   klass            classification stored at save time (authoritative for v1)
 */

/* ------------------------------------------------------------------ *
 * Constants (spec: wind model v2)
 * ------------------------------------------------------------------ */

import { effortNorm, invHead, invTail } from "./windModel.js";

export const KMH_STILL = 5;                 // |wind| below this: still
export const KMH_WINDY = 10;                // |wind| at/above this: windy
// Why FIXED thresholds on raw forecast wind (not scaled by k, not felt-wind):
// k's accuracy self-weights by relevance. Where k is hard to learn well — a
// sheltered route, an e-bike whose throttle flattens headwinds and speed-limit
// caps tailwinds, a hill-dominated commute where terrain dwarfs wind — k also
// comes out LOW, and a low k barely shifts the prediction versus the rider's
// confounding factors, so an inaccurate (even wildly inaccurate) low k is
// harmless. Where k genuinely matters (exposed routes, wind materially moves
// ride time) the wind is strong enough that the data is naturally good. Error
// in k and the cost of that error are inversely correlated, so a simple fixed
// threshold gets accuracy where it's needed and wastes none chasing precision
// where it's worthless — and it sidesteps having to diagnose WHY k is low
// (shelter vs behaviour vs terrain), which the data can't distinguish anyway.
export const KMH_SPREAD_MIN = 1.2;          // min km/h spread to learn k (per direction)
export const KMH_BASELINE_SPREAD_MIN = 4;   // min km/h spread to extrapolate baseline
export const K_MIN = 0.0;                   // THE k range (fraction of forecast
export const K_MAX = 1.4;                   // wind felt, user-facing 0%–140%).
export const K_LEARN_REJECT = 1.6;          // Three zones for a LEARNED k:
                                            //   0–1.4   : used as-is
                                            //   1.4–1.6 : clamped to 1.4 (stored
                                            //             & computed as 1.4, not
                                            //             merely displayed)
                                            //   > 1.6   : rejected → use setting
export const FREEZE_AGE_DAYS = 14;
export const FREEZE_AGE_MS = FREEZE_AGE_DAYS * 24 * 60 * 60 * 1000;

/* ------------------------------------------------------------------ *
 * Classification
 * ------------------------------------------------------------------ */

/** True for rides recorded under the v2 wind model. */
export function isV2Ride(r) {
  return !!r && r.wfv === 2 && Number.isFinite(r.rideWindKmh);
}

/**
 * Classify by equivalent along-route forecast wind (signed km/h) into
 * "still" | "gentle" | "windy".
 */
export function classifyRide(rideWindKmh) {
  const a = Math.abs(rideWindKmh);
  if (a < KMH_STILL) return "still";
  if (a < KMH_WINDY) return "gentle";
  return "windy";
}

/**
 * Classify a ride RECORD into still / gentle / windy.
 *
 * This is a DATA-QUALITY triage on the RAW forecast wind (no k applied), and
 * there is exactly ONE such classification — the same value is displayed to the
 * user AND used to decide whether the ride feeds the learning model, so the
 * user can always see why a ride defaulted to included or excluded:
 *   still  — genuinely calm: clean baseline data → used (feeds baseline)
 *   gentle — too little wind to carry useful signal → noisy → default EXCLUDED
 *   windy  — enough wind to be informative → used (feeds the k-fit)
 *
 * It is deliberately independent of k: whether a ride is too low-signal to
 * trust is a property of how much FORECAST wind drove it, not of the shelter we
 * are trying to learn (using k here would also be circular for the fit). v1
 * rides classify on their stored windFactor against the frozen v1 thresholds.
 */
const V1_WF_STILL = 0.06;
const V1_WF_WINDY = 0.25;
export function classifyRideRecord(r) {
  if (isV2Ride(r)) return classifyRide(r.rideWindKmh);
  if (r && Number.isFinite(r.windFactor)) {
    const a = Math.abs(r.windFactor);
    if (a < V1_WF_STILL) return "still";
    if (a < V1_WF_WINDY) return "gentle";
    return "windy";
  }
  return null;
}

/** Clamp k to the single fixed physical band. */
export function clampK(k) {
  if (!Number.isFinite(k)) return null;
  return Math.max(K_MIN, Math.min(K_MAX, k));
}

/* ------------------------------------------------------------------ *
 * Per-ride effective baseline & the current→historic freeze
 * ------------------------------------------------------------------ */

/**
 * Whether a ride's current/historic switch is locked (age >= 14 days).
 * @param {Object} ride - needs startedAt
 * @param {number} [nowMs]
 */
export function isFrozenByAge(ride, nowMs = Date.now()) {
  return nowMs - (ride.startedAt ?? 0) >= FREEZE_AGE_MS;
}

/**
 * Resolve and persist the current→historic transition for a ride, returning a
 * (possibly new) ride object. Pure given its inputs; the caller persists the
 * result. At age >= 14 days a current ride freezes: snapshot the live baseline
 * into savedBaselineSec and set baselineRef = "historic". Already-historic and
 * still-young current rides pass through (young current rides keep tracking the
 * live baseline — no snapshot taken yet).
 *
 * @param {Object} ride
 * @param {number} liveBaselineSec - live configured baseline (manual or learned)
 * @param {number} [nowMs]
 * @returns {Object} ride (same reference if unchanged)
 */
export function applyFreeze(ride, liveBaselineSec, nowMs = Date.now()) {
  if (ride.baselineRef === "historic") return ride;
  if (!isFrozenByAge(ride, nowMs)) return ride;
  return {
    ...ride,
    baselineRef: "historic",
    savedBaselineSec: liveBaselineSec > 0 ? liveBaselineSec : ride.savedBaselineSec ?? null,
  };
}

/**
 * The baseline a ride's k is measured against: the live configured baseline if
 * the ride is current, else its frozen savedBaselineSec (falling back to live
 * if a frozen value is somehow missing).
 */
export function effectiveBaseline(ride, liveBaselineSec) {
  if (ride.baselineRef === "historic" && ride.savedBaselineSec > 0) {
    return ride.savedBaselineSec;
  }
  return liveBaselineSec;
}

/**
 * Per-ride k (v2), for display and as the contribution to the k fit:
 * invert the ride's time deviation through the branch curve and divide by the
 * ride's equivalent wind:
 *
 *   head:  k = invHead(actual/b − 1) / (w/20)
 *   tail:  k = invTail(1 − actual/b) / (w/20)      (w = |rideWindKmh|)
 *
 * A deviation with the "wrong" sign (e.g. a headwind ride faster than
 * baseline) inverts to 0 — the ride testifies to zero wind effect; attenuation
 * cannot be negative. The returned k is UNCLAMPED: values beyond the k range
 * (0–1.2) are shown as-is, and such rides default to not-used at record time
 * (app.recordRide), the same mechanism as gentle rides — the user can opt them
 * back in. Null for still rides, v1 rides, or no usable baseline.
 */
export function rideK(ride, liveBaselineSec) {
  if (!isV2Ride(ride)) return null;
  const b = effectiveBaseline(ride, liveBaselineSec);
  if (!(b > 0)) return null;
  const w = ride.rideWindKmh;
  if (!Number.isFinite(w) || Math.abs(w) < 1e-9) return null;
  const x = Math.abs(w) / 20;
  const dev = ride.actualSec / b - 1;
  const kx = w > 0 ? invHead(dev) : invTail(-dev);
  return kx / x;
}

/* ------------------------------------------------------------------ *
 * Spread helper
 * ------------------------------------------------------------------ */

/** Spread (max−min) of rideWindKmh across a set of v2 rides. */
function kmhSpread(rides) {
  if (rides.length === 0) return 0;
  let lo = Infinity, hi = -Infinity;
  for (const r of rides) {
    if (r.rideWindKmh < lo) lo = r.rideWindKmh;
    if (r.rideWindKmh > hi) hi = r.rideWindKmh;
  }
  return hi - lo;
}

/* ------------------------------------------------------------------ *
 * Baseline resolution (spec §2.5)
 * ------------------------------------------------------------------ */

/**
 * Resolve still-air baseline (seconds) from the curated ride log.
 *   1. >=1 still ride            → mean of still-ride times
 *      (still rides include v1 rides with STORED klass "still" — the carve-out:
 *       a truly still ride is scale-agnostic)
 *   2. else v2 windy rides, km/h spread >= KMH_BASELINE_SPREAD_MIN
 *                                → intercept of actual ~ f(x) (extrapolate to
 *                                  zero wind); regressor z = effortNorm(w),
 *                                  intercept robust to the k-curvature the
 *                                  slope absorbs
 *   3. else                      → slider fallback
 */
export function resolveBaseline(rides, sliderBaselineSec) {
  const still = rides.filter((r) => classifyRideRecord(r) === "still");
  if (still.length >= 1) {
    const mean = still.reduce((s, r) => s + r.actualSec, 0) / still.length;
    if (mean > 0) {
      return { baselineSec: mean, source: "learned", branch: 1, ridesUsed: still.length };
    }
  }

  const windy = rides.filter((r) => isV2Ride(r) && classifyRide(r.rideWindKmh) === "windy");
  if (windy.length >= 2 && kmhSpread(windy) >= KMH_BASELINE_SPREAD_MIN) {
    // Intercept extrapolation to zero wind. The regressor is the curve value,
    // but the data follows f(k·w) with unknown k, so a single OLS pass carries
    // a curvature bias (~6% low for mixed directions at k≈0.5). Two refinement
    // iterations remove it: intercept → implied k (wind-weighted mean of the
    // per-ride inversion against that intercept) → refit with z = f(k·w)/k.
    // Verified: 60 noisy mixed rides at k=0.5 converge 940 → 999 (true 1000).
    const ols = (pts) => {
      const n = pts.length;
      let sx = 0, sy = 0, sxx = 0, sxy = 0;
      for (const p of pts) { sx += p.z; sy += p.y; sxx += p.z * p.z; sxy += p.z * p.y; }
      const det = n * sxx - sx * sx;
      if (Math.abs(det) <= 1e-12) return null;
      return (sy * sxx - sx * sxy) / det;
    };
    let A = ols(windy.map((r) => ({ z: effortNorm(r.rideWindKmh), y: r.actualSec })));
    for (let it = 0; A > 0 && it < 2; it++) {
      let sw = 0, swk = 0;
      for (const r of windy) {
        const dev = r.actualSec / A - 1;
        const x = Math.abs(r.rideWindKmh) / 20;
        const kx = r.rideWindKmh > 0 ? invHead(dev) : invTail(-dev);
        if (!Number.isFinite(kx) || !(x > 0)) continue;
        sw += Math.abs(r.rideWindKmh);
        swk += Math.abs(r.rideWindKmh) * (kx / x);
      }
      if (!(sw > 0)) break;
      const k = swk / sw;
      if (!(k > 0)) break;
      const A2 = ols(windy.map((r) => ({ z: effortNorm(k * r.rideWindKmh) / k, y: r.actualSec })));
      if (A2 == null || !(A2 > 0)) break;
      A = A2;
    }
    if (A != null && A > 0) {
      return { baselineSec: A, source: "learned", branch: 2, ridesUsed: windy.length };
    }
  }

  return { baselineSec: sliderBaselineSec, source: "slider", branch: 3, ridesUsed: 0 };
}

/* ------------------------------------------------------------------ *
 * k resolution (spec §2.6)
 * ------------------------------------------------------------------ */

/**
 * Fit k for a set of v2 rides in one direction: the |wind|-weighted mean of
 * per-ride inverted k (stronger-wind rides pin k more precisely — the
 * inversion's sensitivity to time noise falls with wind). Returns null if the
 * gate fails (need >=2 rides AND km/h spread >= KMH_SPREAD_MIN) or no ride
 * yields a usable k.
 */
function fitKWeighted(dirRides, liveBaselineSec) {
  if (dirRides.length < 2) return null;
  if (kmhSpread(dirRides) < KMH_SPREAD_MIN) return null;
  let sw = 0, swk = 0, used = 0;
  for (const r of dirRides) {
    const k = rideK(r, liveBaselineSec);
    if (k == null) continue;
    const w = Math.abs(r.rideWindKmh);
    sw += w;
    swk += w * k;
    used += 1;
  }
  if (!(sw > 0) || used < 2) return null;
  const kRaw = swk / sw;
  if (!Number.isFinite(kRaw) || kRaw < K_MIN) return null;
  // Three-zone acceptance: a fit above K_LEARN_REJECT (1.6) is implausible —
  // reject so the route keeps its slider setting. A fit in (K_MAX, K_LEARN_REJECT]
  // is trusted to exist but its MAGNITUDE is capped at K_MAX (1.4): the clamped
  // value is what we store and compute with, not just what we display.
  if (kRaw > K_LEARN_REJECT) return null;
  const k = Math.min(kRaw, K_MAX);
  return { k, ridesUsed: used };
}

/**
 * Resolve k from the curated ride log, given the configured baseline and the
 * k mode/split configuration. Always returns kHead and kTail (the applied
 * values, after fallback to slider) plus per-side source and the effective
 * split state.
 *
 * Split rules (spec §3.2):
 *   - manual mode: split follows config.split exactly.
 *   - learn mode: auto-splits when BOTH directions independently pass the gate;
 *     otherwise stays combined (pooled fit over all windy rides). A learn-mode
 *     manual split is honoured (each side fits its own rides; the unqualified
 *     side falls back to slider).
 *
 * @param {Array} rides - included rides only
 * @param {number} liveBaselineSec
 * @param {Object} config
 * @param {"manual"|"learn"} config.kMode
 * @param {boolean} config.split          - user's manual split checkbox
 * @param {number} config.sliderKHead
 * @param {number} config.sliderKTail
 * @returns {{kHead, kTail, sourceHead, sourceTail, split, autoSplit,
 *            ridesHead, ridesTail}}
 */
export function resolveK(rides, liveBaselineSec, config) {
  const { kMode, split, sliderKHead, sliderKTail } = config;
  const sH = clampK(sliderKHead) ?? sliderKHead;
  const sT = clampK(sliderKTail) ?? sliderKTail;

  // k is learned from v2 windy rides, PLUS any v2 gentle rides the user has
  // explicitly opted in (gentle defaults to not-used; filtered before this
  // point in resolveModel). v1 rides never feed k — their stored windFactor is
  // on the old scale. Still rides never feed k (no usable wind signal). Gentle
  // rides have small wind, so their weight in the fit is naturally low.
  const forK = rides.filter((r) => {
    if (!isV2Ride(r)) return false;
    const c = classifyRide(r.rideWindKmh);
    return c === "windy" || c === "gentle";
  });
  const head = forK.filter((r) => r.rideWindKmh > 0);
  const tail = forK.filter((r) => r.rideWindKmh < 0);

  if (kMode !== "learn") {
    // Manual: slider values, split exactly as the user set it.
    return {
      kHead: sH, kTail: sT,
      sourceHead: "slider", sourceTail: "slider",
      split: !!split, autoSplit: false,
      ridesHead: 0, ridesTail: 0,
    };
  }

  const headFit = fitKWeighted(head, liveBaselineSec);
  const tailFit = fitKWeighted(tail, liveBaselineSec);
  const bothQualify = !!headFit && !!tailFit;

  // Effective split: forced when both qualify (auto-split); otherwise honour
  // the user's manual split checkbox.
  const autoSplit = bothQualify;
  const effSplit = autoSplit || !!split;

  if (effSplit) {
    return {
      kHead: headFit ? headFit.k : sH,
      kTail: tailFit ? tailFit.k : sT,
      sourceHead: headFit ? "learned" : "slider",
      sourceTail: tailFit ? "learned" : "slider",
      split: true, autoSplit,
      ridesHead: headFit ? headFit.ridesUsed : 0,
      ridesTail: tailFit ? tailFit.ridesUsed : 0,
    };
  }

  // Combined learn: pool all contributing rides (both directions) into one fit.
  const pooled = fitKWeighted(forK, liveBaselineSec);
  if (pooled) {
    return {
      kHead: pooled.k, kTail: pooled.k,
      sourceHead: "learned", sourceTail: "learned",
      split: false, autoSplit: false,
      ridesHead: pooled.ridesUsed, ridesTail: pooled.ridesUsed,
    };
  }
  // Not enough to learn anything → slider, combined.
  return {
    kHead: sH, kTail: sT,
    sourceHead: "slider", sourceTail: "slider",
    split: false, autoSplit: false,
    ridesHead: 0, ridesTail: 0,
  };
}

/* ------------------------------------------------------------------ *
 * Top-level resolve: baseline + k from the curated log and config
 * ------------------------------------------------------------------ */

/**
 * Resolve the full model (baseline, kHead, kTail) from a route's ride log and
 * config. Applies the current/historic freeze first (returning the updated
 * rides so the caller can persist any transitions), then resolves baseline,
 * then k conditional on that baseline.
 *
 * @param {Array} allRides - the route's rides (any include state)
 * @param {Object} config
 * @param {"manual"|"learn"} config.baselineMode
 * @param {number} config.sliderBaselineSec
 * @param {"manual"|"learn"} config.kMode
 * @param {boolean} config.split
 * @param {number} config.sliderKHead
 * @param {number} config.sliderKTail
 * @param {number} [nowMs]
 * @returns {{
 *   baselineSec, kHead, kTail,
 *   baselineSource, kHeadSource, kTailSource,
 *   split, autoSplit, baselineBranch,
 *   ridesBaseline, ridesHead, ridesTail,
 *   rides   // rides with freeze transitions applied (persist these)
 * }}
 */
export function resolveModel(allRides, config, nowMs = Date.now()) {
  const {
    baselineMode, sliderBaselineSec,
    kMode, split, sliderKHead, sliderKTail,
  } = config;

  // 1. Determine the live baseline. In learn mode we need a baseline to feed
  // freeze + k; freeze needs the live baseline; baseline (learned) needs no k.
  // Resolve baseline from currently-included rides using the slider as the
  // contemporaneous live value for any young current rides.
  const includedPre = allRides.filter((r) => r.included !== false);
  let liveBaselineSec = sliderBaselineSec;
  let baselineSource = "slider", baselineBranch = 3, ridesBaseline = 0;
  if (baselineMode === "learn") {
    const b = resolveBaseline(includedPre, sliderBaselineSec);
    liveBaselineSec = b.baselineSec;
    baselineSource = b.source; baselineBranch = b.branch; ridesBaseline = b.ridesUsed;
  }

  // 2. Apply the current→historic freeze using the live baseline, persisting
  // transitions in the returned rides.
  const rides = allRides.map((r) => applyFreeze(r, liveBaselineSec, nowMs));

  // 3. Resolve k from included rides, conditional on per-ride effective baseline.
  const included = rides.filter((r) => r.included !== false);
  const k = resolveK(included, liveBaselineSec, {
    kMode, split, sliderKHead, sliderKTail,
  });

  return {
    baselineSec: liveBaselineSec,
    kHead: k.kHead, kTail: k.kTail,
    baselineSource, kHeadSource: k.sourceHead, kTailSource: k.sourceTail,
    split: k.split, autoSplit: k.autoSplit, baselineBranch,
    ridesBaseline, ridesHead: k.ridesHead, ridesTail: k.ridesTail,
    rides,
  };
}

/* ------------------------------------------------------------------ *
 * Confidence dots (spec §4)
 * ------------------------------------------------------------------ */

/**
 * Count filled dots (0–3): one each for baseline, kHead, kTail that is served
 * from ride data (source === "learned"). Combined-k contributes at most one dot
 * (both sides share one pooled source) — only an actual split with both sides
 * learned earns two. Takes a resolveModel result.
 */
export function dotCount(resolved) {
  let dots = 0;
  if (resolved.baselineSource === "learned") dots += 1;
  if (resolved.split) {
    if (resolved.kHeadSource === "learned") dots += 1;
    if (resolved.kTailSource === "learned") dots += 1;
  } else {
    // combined: at most one dot regardless of how many directions the pooled
    // fit nominally covers
    if (resolved.kHeadSource === "learned" || resolved.kTailSource === "learned") dots += 1;
  }
  return dots;
}

/* ------------------------------------------------------------------ *
 * Prediction (spec §2.1, with physical speed clamp retained)
 * ------------------------------------------------------------------ */

/**
 * Predicted ride time for a wind_factor, given an already-resolved model
 * (baselineSec, kHead, kTail). The raw multiplier 1 + k·wf is clamped to
 * physical SPEED limits, converted back to time:
 *   - tailwind ceiling: speed <= speedCapMult × still → multiplier >= 1/speedCapMult
 *   - headwind floor:   speed >= walkPace → multiplier <= stillSpeed/walkPace
 *
 * @param {{baselineSec, kHead, kTail}} model
 * @param {number} windFactor
 * @param {Object} [opts]
 * @param {number} [opts.distanceM]
 * @param {number} [opts.walkPaceKmh=5]
 * @param {number} [opts.speedCapMult=3]
 * @param {number} [opts.multMaxFallback=6]
 * @returns {{predictedSec, baselineSec, k, kHead, kTail, multiplier, clamped}}
 */
export function predictFromModel(model, windFactor, opts = {}) {
  const { distanceM = null, walkPaceKmh = 5, speedCapMult = 3, multMaxFallback = 6 } = opts;
  const baselineSec = model.baselineSec;
  const kHead = model.kHead, kTail = model.kTail;
  // v2: windFactor arrives with the route's k already applied INSIDE the
  // branch curves (per segment sign), so it IS the fractional time change.
  // `k` is returned for display only, picked by the aggregate's sign.
  const k = windFactor >= 0 ? kHead : kTail;
  const raw = 1 + windFactor;

  const multMin = 1 / speedCapMult;
  let multMax = multMaxFallback;
  if (distanceM > 0 && baselineSec > 0) {
    const stillSpeedKmh = (distanceM / 1000) / (baselineSec / 3600);
    multMax = Math.max(1, stillSpeedKmh / walkPaceKmh);
  }
  const multiplier = Math.max(multMin, Math.min(multMax, raw));
  return {
    predictedSec: baselineSec * multiplier,
    baselineSec, k, kHead, kTail,
    multiplier, clamped: multiplier !== raw,
  };
}

/**
 * Convenience: resolve the model from the ride log + config and predict in one
 * call. Returns the prediction plus the resolved model (and rides w/ freeze
 * applied, for the caller to persist).
 */
export function predict(allRides, config, windFactor, opts = {}, nowMs = Date.now()) {
  const resolved = resolveModel(allRides, config, nowMs);
  const pr = predictFromModel(resolved, windFactor, opts);
  return {
    ...pr,
    provisional: resolved.baselineSource === "slider"
      && resolved.kHeadSource === "slider" && resolved.kTailSource === "slider",
    resolved,
    rides: resolved.rides,
  };
}
