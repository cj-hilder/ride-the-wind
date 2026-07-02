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
export const SPEED_EMA_TAU_MS = 5000;        // needle speed EMA time constant ~5s
export const SPEED_SANE_MAX_MPS = 19.4;      // ~70 km/h: above this a per-fix speed is a GPS artefact, not cycling
export const GPS_ACCURACY_GATE_M = 30;       // fixes with reported accuracy worse than this are skipped for the needle
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
