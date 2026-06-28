/**
 * Ride the Wind — Learning (refactored)
 *
 * Resolves, per route, the two quantities the prediction depends on:
 *
 *     predicted_time = baseline × (1 + k · wind_factor)
 *
 * where k is ASYMMETRIC: kHead applies when wind_factor > 0 (headwind, slower)
 * and kTail when wind_factor < 0 (tailwind, faster), with a kink at 0.
 *
 * The model is determined from a CURATED RIDE LOG plus a route CONFIG, not from
 * a persisted regression accumulator. Baseline and k are two independently
 * toggled quantities (manual ↔ learned). Baseline is resolved FIRST; k is then
 * computed CONDITIONAL on a per-ride baseline. There is no recency decay: a
 * ride's k is measured against the baseline contemporaneous with that ride (its
 * own current/historic reference), and the user curates the log by hand.
 *
 * ── Ride record shape (the units this module consumes) ────────────────
 *   windFactor       signed, dimensionless (windModel: ≈ (along-route km/h / 20)²)
 *   actualSec        recorded ride duration (seconds)
 *   included         boolean — user curation include/exclude
 *   baselineRef      "current" | "historic"
 *   savedBaselineSec frozen still-air baseline (used when historic)
 *   startedAt        epoch ms (age, ordering)
 *
 * ── wind_factor scale & classification ───────────────────────────────
 * wind_factor is the signed-square effort normalised to W_REF (20 km/h), so the
 * relationship to the intuitive along-route component h is quadratic:
 * wind_factor ≈ (h/20)². The class thresholds below follow from that mapping.
 */

/* ------------------------------------------------------------------ *
 * Constants (spec §2.10)
 * ------------------------------------------------------------------ */

export const WF_STILL = 0.06;                // |wf| below this: still (~<5 km/h)
export const WF_WINDY = 0.25;                // |wf| at/above this: windy (~>=10 km/h)
export const WF_SPREAD_MIN = 0.06;           // min wf spread to learn k (per direction)
export const WF_BASELINE_SPREAD_MIN = 0.20;  // min wf spread to extrapolate baseline
export const K_MIN = 0.05;
export const K_MAX = 4.0;
export const FREEZE_AGE_DAYS = 14;
export const FREEZE_AGE_MS = FREEZE_AGE_DAYS * 24 * 60 * 60 * 1000;

/* ------------------------------------------------------------------ *
 * Classification
 * ------------------------------------------------------------------ */

/**
 * Classify a ride by |wind_factor| into "still" | "gentle" | "windy".
 * @param {number} windFactor
 * @returns {"still"|"gentle"|"windy"}
 */
export function classifyRide(windFactor) {
  const a = Math.abs(windFactor);
  if (a < WF_STILL) return "still";
  if (a < WF_WINDY) return "gentle";
  return "windy";
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
 * Per-ride k, for display and as the windy-ride contribution to the k fit:
 *   k_ride = (actual / b − 1) / wf
 * where b is the ride's effective baseline. Null for ~zero wind_factor (still).
 */
export function rideK(ride, liveBaselineSec) {
  const b = effectiveBaseline(ride, liveBaselineSec);
  if (!(b > 0)) return null;
  const wf = ride.windFactor;
  if (!Number.isFinite(wf) || Math.abs(wf) < 1e-9) return null;
  return (ride.actualSec / b - 1) / wf;
}

/* ------------------------------------------------------------------ *
 * Spread helper
 * ------------------------------------------------------------------ */

/** Spread (max−min) of wind_factor across a set of rides. */
function wfSpread(rides) {
  if (rides.length === 0) return 0;
  let lo = Infinity, hi = -Infinity;
  for (const r of rides) {
    if (r.windFactor < lo) lo = r.windFactor;
    if (r.windFactor > hi) hi = r.windFactor;
  }
  return hi - lo;
}

/* ------------------------------------------------------------------ *
 * Baseline resolution (spec §2.5)
 * ------------------------------------------------------------------ */

/**
 * Resolve still-air baseline (seconds) from the curated ride log.
 *   1. >=1 still ride            → mean of still-ride times
 *   2. else windy rides, spread >= WF_BASELINE_SPREAD_MIN
 *                                → intercept of actual ~ wind_factor (extrapolate to wf=0)
 *   3. else                      → slider fallback
 *
 * @param {Array} rides - included rides only (caller filters), with class info
 * @param {number} sliderBaselineSec
 * @returns {{baselineSec:number, source:"learned"|"slider", branch:1|2|3, ridesUsed:number}}
 */
export function resolveBaseline(rides, sliderBaselineSec) {
  const still = rides.filter((r) => classifyRide(r.windFactor) === "still");
  if (still.length >= 1) {
    const mean = still.reduce((s, r) => s + r.actualSec, 0) / still.length;
    if (mean > 0) {
      return { baselineSec: mean, source: "learned", branch: 1, ridesUsed: still.length };
    }
  }

  const windy = rides.filter((r) => classifyRide(r.windFactor) === "windy");
  if (windy.length >= 2 && wfSpread(windy) >= WF_BASELINE_SPREAD_MIN) {
    // Ordinary least squares actual = A + B·wf; baseline = A (intercept at wf=0).
    const n = windy.length;
    let sx = 0, sy = 0, sxx = 0, sxy = 0;
    for (const r of windy) {
      sx += r.windFactor; sy += r.actualSec;
      sxx += r.windFactor * r.windFactor; sxy += r.windFactor * r.actualSec;
    }
    const det = n * sxx - sx * sx;
    if (Math.abs(det) > 1e-12) {
      const A = (sy * sxx - sx * sxy) / det;
      if (A > 0) {
        return { baselineSec: A, source: "learned", branch: 2, ridesUsed: n };
      }
    }
  }

  return { baselineSec: sliderBaselineSec, source: "slider", branch: 3, ridesUsed: 0 };
}

/* ------------------------------------------------------------------ *
 * k resolution (spec §2.6)
 * ------------------------------------------------------------------ */

/**
 * Fit k for a set of windy rides via least-squares through the origin of
 *   (actualᵢ/bᵢ − 1) = k·wfᵢ
 * each ride using its own effective baseline bᵢ. Returns null if the gate fails
 * (need >=2 rides AND spread >= WF_SPREAD_MIN) or the fit is degenerate.
 *
 * @param {Array} windyRides
 * @param {number} liveBaselineSec
 * @returns {{k:number, ridesUsed:number}|null}
 */
function fitKThroughOrigin(windyRides, liveBaselineSec) {
  if (windyRides.length < 2) return null;
  if (wfSpread(windyRides) < WF_SPREAD_MIN) return null;
  // origin LS: k = Σ(wf·y) / Σ(wf²), y = actual/b − 1
  let sxy = 0, sxx = 0;
  for (const r of windyRides) {
    const b = effectiveBaseline(r, liveBaselineSec);
    if (!(b > 0)) continue;
    const y = r.actualSec / b - 1;
    const wf = r.windFactor;
    sxy += wf * y;
    sxx += wf * wf;
  }
  if (!(sxx > 1e-12)) return null;
  const k = clampK(sxy / sxx);
  if (k == null) return null;
  return { k, ridesUsed: windyRides.length };
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

  // k is learned from windy rides, PLUS any gentle rides the user has
  // explicitly opted in. Gentle rides default to not-used (filtered out before
  // this point in resolveModel), so the only gentle rides here are ones the user
  // deliberately marked used — honour that by letting them feed k. Still rides
  // never feed k (they carry no usable wind signal). Gentle rides have small
  // wind_factor, so they're naturally low-leverage in the origin fit.
  const forK = rides.filter((r) => {
    const c = classifyRide(r.windFactor);
    return c === "windy" || c === "gentle";
  });
  const head = forK.filter((r) => r.windFactor > 0);
  const tail = forK.filter((r) => r.windFactor < 0);

  if (kMode !== "learn") {
    // Manual: slider values, split exactly as the user set it.
    return {
      kHead: sH, kTail: sT,
      sourceHead: "slider", sourceTail: "slider",
      split: !!split, autoSplit: false,
      ridesHead: 0, ridesTail: 0,
    };
  }

  const headFit = fitKThroughOrigin(head, liveBaselineSec);
  const tailFit = fitKThroughOrigin(tail, liveBaselineSec);
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
  const pooled = fitKThroughOrigin(forK, liveBaselineSec);
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
  const k = windFactor >= 0 ? kHead : kTail;
  const raw = 1 + k * windFactor;

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
