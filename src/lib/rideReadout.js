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
export const SPEED_SMOOTH_WINDOW_MS = 6000; // smoothing window for derived speed

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
 * Expected arrival instant (ms). Until `distanceM` reaches ARRIVAL_LIVE_AFTER_M,
 * use the forecast estimate (now + forecastRemainingSec). After that, switch to
 * the live estimate: remaining distance ÷ average speed so far.
 *   remaining = max(0, routeTotalM - distanceM)
 *   avgSpeedMps = distanceM / movingSec   (moving time excludes pauses)
 * Returns null if it can't be computed (e.g. no route total for a new recording).
 */
export function expectedArrivalMs({
  nowMs, distanceM, routeTotalM, movingSec, forecastRemainingSec,
}) {
  if (routeTotalM == null) return null; // new-route recording: no total
  const remaining = Math.max(0, routeTotalM - (distanceM || 0));
  if ((distanceM || 0) < ARRIVAL_LIVE_AFTER_M) {
    if (forecastRemainingSec == null) return null;
    return nowMs + forecastRemainingSec * 1000;
  }
  const avg = movingSec > 0 ? distanceM / movingSec : 0; // m/s
  if (avg <= 0) return null;
  return nowMs + (remaining / avg) * 1000;
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

/**
 * Smooth instantaneous speed from a buffer of recent {t, distanceM} samples by
 * taking total distance over total time across the window. Returns km/h.
 * `samples` are cumulative-distance readings; the window is the most recent
 * `windowMs`. Falls back to 0 with fewer than two samples in window.
 */
export function smoothedSpeedKmh(samples, nowMs, windowMs = SPEED_SMOOTH_WINDOW_MS) {
  if (!samples || samples.length < 2) return 0;
  const cutoff = nowMs - windowMs;
  const win = samples.filter((s) => s.t >= cutoff);
  const use = win.length >= 2 ? win : samples.slice(-2);
  const first = use[0], last = use[use.length - 1];
  const dt = (last.t - first.t) / 1000;
  if (dt <= 0) return 0;
  const dd = last.distanceM - first.distanceM;
  return Math.max(0, (dd / dt) * 3.6);
}
