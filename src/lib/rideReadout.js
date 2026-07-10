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
export const NEEDLE_WARMUP_ACC_M = 8;        // needle stays at 0 until the first fix at least this accurate
                                             // (kills GPS-acquisition spikes in the first few seconds)
export const NEEDLE_MAX_ACCEL_MPS2 = 1.75;   // (A) sane cycling accel; per-sample speed change is clamped to this × dt
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

export function needleTauMs(accPrev, accNow) {
  // Clamp each reported accuracy UP to a realistic floor: consumer GPS is
  // essentially never truly sub-2.5 m, so a device claiming (or lying) better is
  // treated as no better than the floor — otherwise one over-optimistic fix
  // makes τ snap short and the needle jumps.
  const clamp = (a) => Math.max(NEEDLE_ACC_FLOOR_M, a);
  const ap = clamp((accPrev == null || Number.isNaN(accPrev)) ? NEEDLE_ACC_REF_M : accPrev);
  const an = clamp((accNow == null || Number.isNaN(accNow)) ? NEEDLE_ACC_REF_M : accNow);
  const variance = ap * ap + an * an;
  const refVar = 2 * NEEDLE_ACC_REF_M * NEEDLE_ACC_REF_M;
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
 * (drives *remaining*). `gpsDistanceM` is the real distance ridden (drives the
 * forecast→live switch). `paceMps` is the smoothed live pace.
 *
 * Three stages:
 *  - **On-route, first km** (before live pace is trustworthy): a *progress-scaled*
 *    estimate — the whole-ride estimate times the fraction of the route still
 *    ahead, `estimate × remaining/total`. This refines as the rider advances
 *    instead of sitting flat until 1 km. The estimate scaled is the wind-aware
 *    `forecastRemainingSec` when available, else the still-air `baselineRemainingSec`.
 *  - **After 1 km of real distance:** `remaining ÷ live pace`.
 *  - **No estimate available / off-route (caller passes null):** null.
 *
 * `remaining` uses along-route distance (so a detour keeps remaining near true
 * route length) while pace comes from real GPS distance (so a detour doesn't
 * crater pace).
 */
export function expectedArrivalMs({
  nowMs, estDistanceM, gpsDistanceM, routeTotalM, paceMps, forecastRemainingSec, baselineRemainingSec,
}) {
  if (routeTotalM == null || routeTotalM <= 0) return null; // new-route recording: no total
  const remaining = Math.max(0, routeTotalM - (estDistanceM || 0));
  if ((gpsDistanceM || 0) < ARRIVAL_LIVE_AFTER_M) {
    // Progress-scaled whole-ride estimate: prefer the wind-aware forecast, fall
    // back to the still-air baseline. Scale by the fraction of route remaining.
    const wholeRideSec = forecastRemainingSec != null ? forecastRemainingSec
      : (baselineRemainingSec != null ? baselineRemainingSec : null);
    if (wholeRideSec == null) return null;
    const remainingFraction = remaining / routeTotalM;
    return nowMs + wholeRideSec * remainingFraction * 1000;
  }
  if (!(paceMps > 0)) return null;
  return nowMs + (remaining / paceMps) * 1000;
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
