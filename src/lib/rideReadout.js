/* ============================================================================
 * rideReadout — pure math for the live ride instrument panel (clock bezel,
 * speedometer gauge, progress bar, derived/smoothed speed, dynamic arrival).
 * No DOM, no React: everything here is unit-testable. The SVG components in
 * App.jsx consume these.
 * ========================================================================== */

export const SPEEDO_MAX_KMH = 40;        // gauge full-scale; needle pegs here
export const SPEEDO_START_DEG = 225;     // 0 km/h at the 7:30 position
export const SPEEDO_SWEEP_DEG = 270;     // clockwise sweep 0→max (to 4:30 = 315°)
export const ARRIVAL_BEZEL_WINDOW_MIN = 60; // bezel marker shows only within this
export const ARRIVAL_LIVE_AFTER_M = 1000;   // switch forecast→live after 1 km
export const SPEED_EMA_TAU_MS = 5000;        // needle speed EMA time constant ~5s
export const SPEED_SANE_MAX_MPS = 19.4;      // ~70 km/h: above this a per-fix speed is a GPS artefact, not cycling
export const PACE_EMA_TAU_MS = 45 * 60000;   // arrival pace EMA time constant ~45min

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
 * Bezel marker for the expected arrival time: returns { angle, imminent } or
 * null only when there is no arrival estimate. The marker shows the arrival's
 * minute-of-hour position **regardless of how far away** it is (on a 12-hour
 * dial the hour is ambiguous beyond 60 min, understood as approximate). The
 * caller colours it: grey when arrival is ≥ 60 min away, amber when < 60 min
 * (imminent). The marker stays in place at/after arrival.
 */
export function arrivalBezel(nowMs, arrivalMs, { windowMin = ARRIVAL_BEZEL_WINDOW_MIN } = {}) {
  if (arrivalMs == null) return null;
  const minsAway = (arrivalMs - nowMs) / 60000;
  const d = new Date(arrivalMs);
  const minute = d.getMinutes() + d.getSeconds() / 60;
  return { angle: minute * 6, imminent: minsAway < windowMin };
}

/**
 * Expected arrival instant (ms). `estDistanceM` is the estimated distance along
 * the route (clamped; drives *remaining*). `gpsDistanceM` is the real distance
 * ridden (drives the forecast→live switch). `paceMps` is the smoothed pace
 * (a GPS-distance-based EMA, supplied by the caller) used for the live estimate.
 *
 * Until the rider has genuinely ridden ARRIVAL_LIVE_AFTER_M (real GPS distance),
 * use the forecast estimate. After that: remaining ÷ pace.
 *
 * Crucially, `remaining` uses the clamped *estimated* distance (so a detour keeps
 * remaining near the true route length) while `pace` comes from *real* GPS
 * distance (so a detour doesn't crater the pace). Feeding the clamped distance
 * into both — the old bug — made pace collapse during an early detour and blew
 * arrival out to hours.
 */
export function expectedArrivalMs({
  nowMs, estDistanceM, gpsDistanceM, routeTotalM, paceMps, forecastRemainingSec,
}) {
  if (routeTotalM == null) return null; // new-route recording: no total
  const remaining = Math.max(0, routeTotalM - (estDistanceM || 0));
  if ((gpsDistanceM || 0) < ARRIVAL_LIVE_AFTER_M) {
    if (forecastRemainingSec == null) return null;
    return nowMs + forecastRemainingSec * 1000;
  }
  if (!(paceMps > 0)) return null;
  return nowMs + (remaining / paceMps) * 1000;
}

/**
 * Estimated distance travelled along the route:
 *   min( GPS distance travelled, routeTotal − lineOfSightToEnd )
 * The second term is the most you can geometrically have covered given you are
 * still `lineOfSightToEnd` (straight-line) from the destination — so a detour or
 * GPS over-count can't push the estimate past the route length. The min means
 * the geometric term only ever *reduces* the estimate (early on a curvy/looping
 * route, GPS wins). Clamped to [0, routeTotal]; arrival/progress derived from
 * this never overshoot. Returns gpsDistanceM unchanged if inputs are missing.
 */
export function estimatedDistanceM(gpsDistanceM, routeTotalM, lineOfSightToEndM) {
  const gps = Math.max(0, gpsDistanceM || 0);
  if (routeTotalM == null || lineOfSightToEndM == null) return gps;
  const geom = routeTotalM - lineOfSightToEndM; // most you can have covered
  return Math.max(0, Math.min(routeTotalM, Math.min(gps, geom)));
}

/** Average speed (km/h) so far = distance / moving-time (pauses excluded). */
export function averageSpeedKmh(distanceM, movingSec) {
  if (!movingSec || movingSec <= 0) return 0;
  return (distanceM / movingSec) * 3.6;
}
