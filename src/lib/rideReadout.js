/* ============================================================================
 * rideReadout — pure math for the live ride instrument panel (clock bezel,
 * speedometer gauge, progress bar, derived/smoothed speed, dynamic arrival,
 * and route projection for gap-immune progress/pace).
 * No DOM, no React: everything here is unit-testable.
 * ========================================================================== */
import { haversine } from "./gpxRoute.js";

export const OFF_ROUTE_M = 150; // beyond this perpendicular distance = off-route

export const SPEEDO_MAX_KMH = 40;        // gauge full-scale; needle pegs here
export const SPEEDO_START_DEG = 225;     // 0 km/h at the 7:30 position
export const SPEEDO_SWEEP_DEG = 270;     // clockwise sweep 0→max (to 4:30 = 315°)
export const ARRIVAL_BEZEL_WINDOW_MIN = 60; // bezel marker shows only within this
export const ARRIVAL_LIVE_AFTER_M = 1000;   // switch forecast→live after 1 km
export const SPEED_EMA_TAU_MS = 5000;        // legacy fixed needle τ (kept for reference/fallback)
export const SPEED_SANE_MAX_MPS = 19.4;      // ~70 km/h: above this a per-fix speed is a GPS artefact, not cycling
export const GPS_ACCURACY_GATE_M = 30;       // (legacy) fixes worse than this were skipped for the needle
export const PACE_EMA_TAU_MS = 45 * 60000;   // arrival pace EMA time constant ~45min
export const PACE_MOVING_MIN_MPS = 1.0;      // below this the rider is treated as stopped; excluded from moving
                                             // pace so a light-stop doesn't drag the arrival projection down

// Adaptive needle smoothing. Each GPS fix reports a horizontal accuracy (metres);
// a speed sample derived from two fixes has an error that scales with
// sqrt(acc_prev² + acc_now²)/dt, so an accurate fix should move the needle fast
// and a poor one barely at all. We turn the per-sample position variance into an
// EMA time constant τ (inverse-variance weighting): small τ (snappy) for tight
// fixes, large τ (heavily smoothed) for loose ones.
export const NEEDLE_ACC_REF_M = 4;           // accuracy at which a sample is basically trusted (τ ≈ min)
export const NEEDLE_ACC_FLOOR_M = 2.5;       // consumer GPS is essentially never truly better than this; clamp
                                             // reported accuracy UP to it so a device lying with a tiny value
                                             // (e.g. 0.5 m) can't make the needle over-trust and snap
export const NEEDLE_TAU_MIN_MS = 2500;       // floor τ for an excellent fix — deliberately calm (a position-
                                             // differenced speedo has an irreducible ±1–2 km/h wander; this
                                             // trades a little needle lag for a steadier read)
export const NEEDLE_TAU_MAX_MS = 40000;      // ceiling τ for a poor fix (≈ dozens of samples to converge)
export const NEEDLE_TAU_SCALE = 1.20;        // multiplier on the adaptive τ — road-tested balance of
                                             // responsiveness vs damping for the Doppler-primary needle
export const GPS_ACCURACY_HARD_M = 50;       // above this a fix is still dropped for the needle (garbage)

/**
 * (A) Physical jump-limiter: clamp a new speed sample relative to the current
 * needle speed. Asymmetric — riders brake much harder than they accelerate, so
 * a symmetric 1.75 m/s² bound made the needle lag on every firm stop.
 */
export function clampNeedleAccel(prevMps, instMps, dtMs) {
  const s = dtMs / 1000;
  return Math.max(prevMps - NEEDLE_MAX_DECEL_MPS2 * s, Math.min(prevMps + NEEDLE_MAX_ACCEL_MPS2 * s, instMps));
}

// ── Speedo response (user setting) ──────────────────────────────────────────
// Users choose how damped the needle is, Quick → Smooth. Each step is a
// multiplier on the whole adaptive τ curve (replacing the fixed
// NEEDLE_TAU_SCALE), so the needle still slows on degraded fixes — just
// proportionally. Stored as a step index; the default step is NEEDLE_TAU_SCALE.
export const SPEEDO_RESPONSE_SCALES = [0.4, 0.7, NEEDLE_TAU_SCALE, 1.6, 2.0];
export const SPEEDO_RESPONSE_LABELS = ["Quick", "Brisk", "Balanced", "Steady", "Smooth"];
export const SPEEDO_RESPONSE_DEFAULT = 2;

/** Clamp a stored step to a valid index (bad/missing → default). */
export function speedoResponseStep(v) {
  if (v == null || v === "") return SPEEDO_RESPONSE_DEFAULT;
  const n = Math.round(Number(v));
  return Number.isFinite(n) && n >= 0 && n < SPEEDO_RESPONSE_SCALES.length ? n : SPEEDO_RESPONSE_DEFAULT;
}

/** τ multiplier for a stored speedo-response step. */
export function speedoTauScale(step) {
  return SPEEDO_RESPONSE_SCALES[speedoResponseStep(step)];
}

/** Settling time (s, one τ) at good signal for a step — for the Settings readout. */
export function speedoSettleSec(step) {
  return (NEEDLE_TAU_MIN_MS * speedoTauScale(step)) / 1000;
}

/**
 * Average moving speed (km/h) of a just-recorded route, used to start the New
 * route form's still-air time from the real ride instead of a generic default.
 * Null when the inputs are missing or the result isn't a plausible ride speed.
 */
export const RECORDED_SPEED_MIN_KMH = 3;
export const RECORDED_SPEED_MAX_KMH = 60;
export function recordedSpeedKmh(distanceM, actualSec) {
  if (!(distanceM > 0) || !(actualSec > 0)) return null;
  const kmh = (distanceM / actualSec) * 3.6;
  return kmh >= RECORDED_SPEED_MIN_KMH && kmh <= RECORDED_SPEED_MAX_KMH ? kmh : null;
}

// ── GPS warm-up ─────────────────────────────────────────────────────────────
// The needle and average speed stay at 0 until GPS has "warmed up", which kills
// acquisition spikes in the first few seconds. Phones report accuracy very
// differently (iOS in coarse steps ~5/10/16/35/65 m; Android a 68% radius whose
// floor ranges from ~2 m to ~10+ m by make), so a single absolute threshold
// stalls on some devices forever. Warm-up therefore passes on ANY of:
//   1. a fix ≤ WARMUP_GOOD_ACC_M                       (good lock, any phone)
//   2. accuracy has plateaued: best ≤ WARMUP_PLATEAU_MAX_ACC_M with no >10%
//      improvement for WARMUP_PLATEAU_MS, on a fix carrying Doppler speed
//      (coords.speed is generally null until a real satellite lock)
//   3. WARMUP_TIMEOUT_MS elapsed and the current fix ≤ WARMUP_TIMEOUT_MAX_ACC_M
//      (also the path for devices that report no accuracy at all, or never
//      report coords.speed)
// Downstream, the needle EMA already down-weights poorer fixes, so a slightly
// looser gate is safe.
export const WARMUP_GOOD_ACC_M = 10;
export const WARMUP_PLATEAU_MAX_ACC_M = 20;
export const WARMUP_PLATEAU_MS = 8000;
export const WARMUP_PLATEAU_IMPROVE_FRAC = 0.10; // an improvement smaller than this doesn't restart the plateau clock
export const WARMUP_TIMEOUT_MS = 30000;
export const WARMUP_TIMEOUT_MAX_ACC_M = 30;      // = GPS_ACCURACY_GATE_M, what route projection accepts
export const WARMUP_COARSE_ACC_M = 100;          // still worse than this → likely approximate location
export const WARMUP_COARSE_HINT_MS = 15000;      // …after this long → show the Precise Location hint

/** Fresh warm-up state; one per ride. */
export function newGpsWarmup() {
  return { warmed: false, startT: null, bestAccM: null, plateauT: null, pct: 0 };
}

/**
 * Advance the warm-up state `w` (mutated) with one fix. Returns
 * { warmed, justWarmed, pct, coarse }: pct is a monotonic 0–100 progress figure
 * for the "GPS initialising N%" readout (held ≤ 99 until actually warmed);
 * coarse is true when accuracy is so poor for so long that location is probably
 * set to approximate.
 */
export function gpsWarmupStep(w, { fixT, accuracyM, gpsSpeedMps }) {
  if (w.warmed) return { warmed: true, justWarmed: false, pct: 100, coarse: false };
  if (fixT == null) return { warmed: false, justWarmed: false, pct: w.pct, coarse: false };
  if (w.startT == null) w.startT = fixT;
  const elapsed = Math.max(0, fixT - w.startT);
  const acc = (typeof accuracyM === "number" && accuracyM >= 0) ? accuracyM : null;
  const doppler = typeof gpsSpeedMps === "number" && gpsSpeedMps >= 0;

  if (acc != null) {
    if (w.bestAccM == null || acc < w.bestAccM * (1 - WARMUP_PLATEAU_IMPROVE_FRAC)) w.plateauT = fixT; // meaningful gain
    if (w.bestAccM == null || acc < w.bestAccM) w.bestAccM = acc;
  }
  const best = w.bestAccM;
  const plateauMs = w.plateauT != null ? fixT - w.plateauT : 0;

  const good = acc != null && acc <= WARMUP_GOOD_ACC_M;
  const plateau = doppler && acc != null && acc <= WARMUP_PLATEAU_MAX_ACC_M
    && best <= WARMUP_PLATEAU_MAX_ACC_M && plateauMs >= WARMUP_PLATEAU_MS;
  const timeout = elapsed >= WARMUP_TIMEOUT_MS && (acc == null || acc <= WARMUP_TIMEOUT_MAX_ACC_M);

  if (good || plateau || timeout) {
    w.warmed = true; w.pct = 100;
    return { warmed: true, justWarmed: true, pct: 100, coarse: false };
  }

  // Progress = whichever route is closest to passing.
  let p = 0;
  if (best != null) {
    p = Math.max(p, WARMUP_GOOD_ACC_M / best);
    if (best <= WARMUP_PLATEAU_MAX_ACC_M) p = Math.max(p, plateauMs / WARMUP_PLATEAU_MS);
    if (best <= WARMUP_TIMEOUT_MAX_ACC_M) p = Math.max(p, elapsed / WARMUP_TIMEOUT_MS);
  } else {
    p = elapsed / WARMUP_TIMEOUT_MS; // no accuracy reported at all
  }
  w.pct = Math.max(w.pct, Math.min(99, Math.round(p * 100)));
  const coarse = elapsed >= WARMUP_COARSE_HINT_MS && best != null && best > WARMUP_COARSE_ACC_M;
  return { warmed: false, justWarmed: false, pct: w.pct, coarse };
}
export const NEEDLE_MAX_ACCEL_MPS2 = 1.75;   // (A) sane cycling accel; per-sample speed INCREASE is clamped to this × dt
export const NEEDLE_MAX_DECEL_MPS2 = 4.0;    // (A) firm braking is 3–4 m/s², so allow faster DECREASES than increases
export const NEEDLE_MAX_DT_MS = 6000;        // (B) cap the dt used for α so one sample after a gap can't seize the needle

/**
 * Adaptive needle EMA time constant (ms) from the two fixes' reported accuracies.
 * τ scales with the speed-sample position variance (acc_prev² + acc_now²),
 * normalised so that two reference-accuracy fixes give τ ≈ NEEDLE_TAU_MIN_MS,
 * clamped to [MIN, MAX]. Missing accuracies are treated as the reference (assume
 * ok) so behaviour is unchanged on devices that don't report accuracy.
 */
export const NEEDLE_SPEED_ACC_REF_MPS = 1.0; // Doppler speed accuracy (m/s) at which a sample is ~trusted
export const NEEDLE_SPEED_ACC_FLOOR_MPS = 0.3; // floor: Doppler is essentially never truly better than this

/**
 * τ for the Doppler needle path, driven by the fix's VELOCITY accuracy
 * (coords.speedAccuracy, m/s) — the correct error signal for a Doppler-derived
 * speed, as opposed to horizontal POSITION accuracy which governs the
 * differencing path. Same shape as needleTauMs: τ scales with variance,
 * clamped to [τ_min, τ_max]. When speedAccuracy is unavailable, the caller
 * falls back to needleTauMs(position accuracy) — imperfect but better than a
 * fixed τ.
 */
export function needleTauMsFromSpeedAcc(speedAccPrev, speedAccNow) {
  const clamp = (a) => Math.max(NEEDLE_SPEED_ACC_FLOOR_MPS, a);
  const ap = clamp((speedAccPrev == null || Number.isNaN(speedAccPrev)) ? NEEDLE_SPEED_ACC_REF_MPS : speedAccPrev);
  const an = clamp((speedAccNow == null || Number.isNaN(speedAccNow)) ? NEEDLE_SPEED_ACC_REF_MPS : speedAccNow);
  const variance = ap * ap + an * an;
  const refVar = 2 * NEEDLE_SPEED_ACC_REF_MPS * NEEDLE_SPEED_ACC_REF_MPS;
  const tau = NEEDLE_TAU_MIN_MS * (variance / refVar);
  return Math.max(NEEDLE_TAU_MIN_MS, Math.min(NEEDLE_TAU_MAX_MS, tau));
}

// ── Doppler needle τ without speedAccuracy ──────────────────────────────────
// Browsers generally don't expose coords.speedAccuracy, so the Doppler needle
// used to fall back to needleTauMs(position accuracy), referenced to an
// absolute 4 m. τ grows with accuracy², so a phone whose normal accuracy is
// ~10 m smoothed ~6× harder than one at 4 m — sluggish on many devices. And
// position accuracy is only a loose proxy for Doppler speed error anyway.
// Instead, reference position accuracy to THIS phone's own typical accuracy
// (a low percentile of recent fixes), so each device's normal state gets the
// snappy τ and only a genuine degradation slows the needle; and cap τ lower.
export const NEEDLE_BASELINE_WINDOW = 60;      // recent fixes the per-phone baseline is drawn from
export const NEEDLE_BASELINE_PCTL = 0.2;       // percentile of that window taken as "typical good"
export const NEEDLE_DOPPLER_TAU_MAX_MS = 5000; // cap (×NEEDLE_TAU_SCALE → 6 s) for the Doppler path
// Damping for the Doppler needle is deliberately GENTLE in degraded accuracy:
// coords.speed comes from the satellites' Doppler shift, which holds up far
// better than position against what inflates the accuracy figure (multipath,
// fewer satellites, a wet jacket over the phone). Inverse-variance (squared)
// growth suits position-DIFFERENCED speed, where position error feeds straight
// into the speed; for Doppler it made the needle hit its ~10 s cap at only
// 1.8× the phone's normal accuracy — e.g. a phone that normally reports 10 m
// drifting to 18 m in rain. Reported accuracy also jitters (and some phones
// round it up), so small swings shouldn't matter at all.
export const NEEDLE_DOPPLER_DEADBAND = 1.5;     // up to this × the phone's normal accuracy: τ stays at min

/** Fresh per-ride accuracy baseline tracker. */
export function newAccBaseline() { return { recent: [] }; }

/**
 * Add one fix's horizontal accuracy (m) to the baseline tracker `b` (mutated)
 * and return the phone's current typical accuracy: the NEEDLE_BASELINE_PCTL
 * percentile of the last NEEDLE_BASELINE_WINDOW reported values, or null if
 * none yet. Null/garbage accuracies are ignored.
 */
export function accBaselinePush(b, accuracyM) {
  if (typeof accuracyM === "number" && accuracyM >= 0 && Number.isFinite(accuracyM)) {
    b.recent.push(accuracyM);
    if (b.recent.length > NEEDLE_BASELINE_WINDOW) b.recent.shift();
  }
  return accBaseline(b);
}

/** Current typical accuracy from tracker `b`, or null if empty. */
export function accBaseline(b) {
  if (!b || !b.recent.length) return null;
  const sorted = [...b.recent].sort((x, y) => x - y);
  return sorted[Math.floor(NEEDLE_BASELINE_PCTL * (sorted.length - 1))];
}

/**
 * τ for the Doppler needle when speedAccuracy is unavailable, from position
 * accuracy relative to the phone's own baseline (never a tighter reference
 * than NEEDLE_ACC_REF_M, so phones already at ~4 m behave as before). The
 * degradation ratio is the RMS of the two fixes' accuracies over that
 * reference. No extra damping up to NEEDLE_DOPPLER_DEADBAND; beyond it τ grows
 * LINEARLY with the ratio (not squared — see NEEDLE_DOPPLER_DEADBAND), clamped
 * to [NEEDLE_TAU_MIN_MS, NEEDLE_DOPPLER_TAU_MAX_MS].
 */
export function needleTauMsDoppler(accPrev, accNow, baselineM) {
  const ref = accReference(baselineM);
  const clamp = (a) => Math.max(NEEDLE_ACC_FLOOR_M, a);
  const ap = clamp((accPrev == null || Number.isNaN(accPrev)) ? ref : accPrev);
  const an = clamp((accNow == null || Number.isNaN(accNow)) ? ref : accNow);
  const ratio = Math.sqrt((ap * ap + an * an) / 2) / ref;
  const tau = NEEDLE_TAU_MIN_MS * Math.max(1, ratio / NEEDLE_DOPPLER_DEADBAND);
  return Math.max(NEEDLE_TAU_MIN_MS, Math.min(NEEDLE_DOPPLER_TAU_MAX_MS, tau));
}

// The accuracy treated as "a good fix": this phone's own typical accuracy
// (accBaseline), but never tighter than NEEDLE_ACC_REF_M. Phones estimate
// accuracy differently (some report a conservative 10 m for fixes as good as
// another phone's 5 m), so judging fixes against a fixed 4 m punished whole
// devices, not bad fixes.
function accReference(baselineM) {
  return Math.max(NEEDLE_ACC_REF_M, (typeof baselineM === "number" && baselineM > 0) ? baselineM : NEEDLE_ACC_REF_M);
}

/**
 * τ for the position-DIFFERENCED needle (no coords.speed). Squared growth is
 * right here (position error feeds straight into the speed), but against the
 * phone's own baseline (optional `baselineM`; omitted → the fixed 4 m
 * reference), for the same reason as the Doppler path.
 */
export function needleTauMs(accPrev, accNow, baselineM) {
  // Clamp each reported accuracy UP to a realistic floor: consumer GPS is
  // essentially never truly sub-2.5 m, so a device claiming (or lying) better is
  // treated as no better than the floor — otherwise one over-optimistic fix
  // makes τ snap short and the needle jumps.
  const clamp = (a) => Math.max(NEEDLE_ACC_FLOOR_M, a);
  const ref = accReference(baselineM);
  const ap = clamp((accPrev == null || Number.isNaN(accPrev)) ? ref : accPrev);
  const an = clamp((accNow == null || Number.isNaN(accNow)) ? ref : accNow);
  const variance = ap * ap + an * an;
  const refVar = 2 * ref * ref;
  const tau = NEEDLE_TAU_MIN_MS * (variance / refVar);
  return Math.max(NEEDLE_TAU_MIN_MS, Math.min(NEEDLE_TAU_MAX_MS, tau));
}

/**
 * Time-aware exponential moving average step. Given the previous EMA value, a new
 * sample, and elapsed time since the last sample, returns the updated EMA.
 * α = 1 − exp(−Δt/τ) correctly handles irregular (GPS) sampling — a fixed α
 * would over/under-weight depending on fix cadence. If prev is null/NaN, the
 * sample seeds the EMA.
 */
export function emaStep(prev, sample, dtMs, tauMs) {
  if (prev == null || Number.isNaN(prev)) return sample;
  if (!(dtMs > 0) || !(tauMs > 0)) return prev;
  const alpha = 1 - Math.exp(-dtMs / tauMs);
  return prev + alpha * (sample - prev);
}

/**
 * Map a speed (km/h) to a needle angle in degrees, measured clockwise from the
 * 12-o'clock (straight-up) position — i.e. standard SVG rotation. 0 km/h sits at
 * SPEEDO_START_DEG (225°, the 7:30 position); the scale sweeps SPEEDO_SWEEP_DEG
 * (270°) clockwise to the max (315°, 4:30). Speeds above max peg at max.
 */
export function speedToAngle(kmh, max = SPEEDO_MAX_KMH) {
  const v = Math.max(0, Math.min(max, kmh || 0));
  return SPEEDO_START_DEG + (v / max) * SPEEDO_SWEEP_DEG;
}

/**
 * Point on a circle for an angle measured clockwise from 12 o'clock (SVG-style:
 * y grows downward). Returns {x,y} relative to centre (cx,cy) at radius r.
 */
export function polarPoint(cx, cy, r, angleDeg) {
  const a = (angleDeg - 90) * Math.PI / 180; // -90: 0° = straight up
  return { x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) };
}

/** Clock hand angles (clockwise from 12) for a Date/ms. */
export function clockAngles(ms) {
  const d = new Date(ms);
  const h = d.getHours() % 12, m = d.getMinutes(), s = d.getSeconds();
  return {
    hour: (h + m / 60) * 30,      // 360/12
    minute: (m + s / 60) * 6,     // 360/60
    second: s * 6,
  };
}

/**
 * Bezel marker for the expected arrival time: returns { angle, imminent,
 * hoursAway } or null only when there is no arrival estimate. `angle` is the
 * arrival's minute-of-hour position on the dial (**regardless of how far away**
 * — on a 12-hour dial the hour is ambiguous beyond 60 min). The caller always
 * draws the amber marker at `angle`; when NOT imminent (≥ 60 min away) it also
 * overlays an opaque grey marker offset a fixed +12° clockwise so the amber peeks
 * out, and if `hoursAway` (= whole hours to arrival) is ≥ 2 it prints that
 * integer in the grey marker. This disambiguates the 1h+ / 2h+ cases that would
 * otherwise land on the same minute tick. The marker stays in place at/after
 * arrival.
 */
export function arrivalBezel(nowMs, arrivalMs, { windowMin = ARRIVAL_BEZEL_WINDOW_MIN } = {}) {
  if (arrivalMs == null) return null;
  const minsAway = (arrivalMs - nowMs) / 60000;
  const d = new Date(arrivalMs);
  const minute = d.getMinutes() + d.getSeconds() / 60;
  return {
    angle: minute * 6,
    imminent: minsAway < windowMin,
    hoursAway: Math.max(0, Math.floor(minsAway / 60)),
  };
}

/**
 * Expected arrival instant (ms). `estDistanceM` is the along-route distance
 * (drives *remaining*). `paceMps` is the smoothed live pace — an EMA that is
 * SEEDED at ride start with the predicted wind-affected pace and then drifts
 * toward the rider's actual pace. So a single continuous rule applies from the
 * first fix: `remaining ÷ pace`, with no forecast→live switch and no 1 km jump.
 *
 * `remaining` uses along-route distance (so a detour keeps remaining near true
 * route length) while pace comes from real GPS distance (so a detour doesn't
 * crater pace). Returns null with no total, no pace, or off-route (caller passes
 * paceMps null). The forecast/baseline remaining args are retained for callers
 * as a last-resort fallback before any pace exists.
 */
export function expectedArrivalMs({
  nowMs, estDistanceM, routeTotalM, paceMps, forecastRemainingSec, baselineRemainingSec,
}) {
  if (routeTotalM == null || routeTotalM <= 0) return null; // new-route recording: no total
  const remaining = Math.max(0, routeTotalM - (estDistanceM || 0));
  if (paceMps > 0) return nowMs + (remaining / paceMps) * 1000;
  // No pace yet (should be rare — the EMA is seeded at start): fall back to the
  // progress-scaled whole-ride estimate so arrival isn't blank.
  const wholeRideSec = forecastRemainingSec != null ? forecastRemainingSec
    : (baselineRemainingSec != null ? baselineRemainingSec : null);
  if (wholeRideSec == null) return null;
  return nowMs + wholeRideSec * (remaining / routeTotalM) * 1000;
}

/** Average speed (km/h) so far = distance / moving-time (pauses excluded). */
export function averageSpeedKmh(distanceM, movingSec) {
  if (!movingSec || movingSec <= 0) return 0;
  return (distanceM / movingSec) * 3.6;
}

/**
 * Build a projection-ready polyline from a route: an ordered list of points
 * { lat, lon, cumM } where cumM is the cumulative along-route distance to that
 * point. Uses each segment's start (lat,lon)+distance and appends the final
 * end-region point so the last leg is represented.
 */
export function routePolyline(route) {
  if (!route || !route.segments || !route.segments.length) return [];
  const pts = [];
  let cum = 0;
  for (const s of route.segments) {
    pts.push({ lat: s.lat, lon: s.lon, cumM: cum });
    cum += s.distance || 0;
  }
  const end = route.endRegion;
  if (end) pts.push({ lat: end.lat, lon: end.lon, cumM: cum });
  return pts;
}

/**
 * Nearest point on segment AB to point P, all in lat/lon, using a local
 * equirectangular projection (accurate at segment scale). Returns the fraction
 * t∈[0,1] along AB of the nearest point and the perpendicular distance (m).
 */
function nearestOnSegment(pLat, pLon, aLat, aLon, bLat, bLon) {
  const latRef = (aLat + bLat) / 2 * Math.PI / 180;
  const mPerDegLat = 111320;
  const mPerDegLon = 111320 * Math.cos(latRef);
  const ax = 0, ay = 0;
  const bx = (bLon - aLon) * mPerDegLon, by = (bLat - aLat) * mPerDegLat;
  const px = (pLon - aLon) * mPerDegLon, py = (pLat - aLat) * mPerDegLat;
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy;
  let t = len2 > 0 ? ((px - ax) * dx + (py - ay) * dy) / len2 : 0;
  t = Math.max(0, Math.min(1, t));
  const cx = ax + t * dx, cy = ay + t * dy;
  const perp = Math.hypot(px - cx, py - cy);
  return { t, perp };
}

/**
 * Project a GPS fix onto the route polyline. Returns { alongM, offRoute }:
 *   - alongM: cumulative along-route distance (m) of the nearest point.
 *   - offRoute: true when no point on the route is within OFF_ROUTE_M — in that
 *     case alongM is held at `lastAlongM` (progress freezes off-route).
 * Continuity preference: among candidates within OFF_ROUTE_M, pick the one whose
 * alongM is closest to `lastAlongM` (so we don't jump to a far part of a route
 * that passes near itself); when `lastAlongM` is null (start, or after a gap),
 * pick the globally nearest by perpendicular distance.
 */
export function projectToRoute(fix, polyline, lastAlongM = null) {
  if (!fix || !polyline || polyline.length < 2) {
    return { alongM: lastAlongM || 0, offRoute: true, offRouteM: null };
  }
  let best = null;         // within-threshold winner: { along, perp }
  let nearestPerp = Infinity; // nearest perpendicular over the whole route
  for (let i = 0; i < polyline.length - 1; i++) {
    const a = polyline[i], b = polyline[i + 1];
    const legLen = b.cumM - a.cumM;
    const { t, perp } = nearestOnSegment(fix.lat, fix.lon, a.lat, a.lon, b.lat, b.lon);
    const along = a.cumM + t * legLen;
    if (perp < nearestPerp) nearestPerp = perp;
    if (perp > OFF_ROUTE_M) continue;
    if (best == null) { best = { along, perp }; continue; }
    if (lastAlongM != null) {
      if (Math.abs(along - lastAlongM) < Math.abs(best.along - lastAlongM)) best = { along, perp };
    } else if (perp < best.perp) {
      best = { along, perp };
    }
  }
  if (best == null) {
    return { alongM: lastAlongM == null ? 0 : lastAlongM, offRoute: true, offRouteM: nearestPerp };
  }
  return { alongM: best.along, offRoute: false, offRouteM: best.perp };
}
