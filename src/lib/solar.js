/**
 * Ride the Wind — local sunrise/sunset computation (NOAA-style).
 *
 * Pure, offline, no network. Sunrise and sunset are timezone-independent
 * *absolute instants* determined only by geography and the date, so this returns
 * UTC milliseconds and the caller compares them against other absolute instants
 * (e.g. the departure time) — no timezone conversion is needed or wanted.
 *
 * Based on the NOAA solar-position equations (the same ones behind the NOAA
 * solar calculator). Accuracy is well within a minute or two, which is far more
 * than enough for choosing a background palette.
 *
 * Returns { sunriseMs, sunsetMs } for the given date, or, when the sun does not
 * cross the horizon that day (polar day / polar night), { polar: 'day' } or
 * { polar: 'night' } so the caller can pick a sensible constant palette.
 */

const RAD = Math.PI / 180;
const DEG = 180 / Math.PI;

// Julian day for a given UTC instant.
function julianDay(ms) {
  return ms / 86400000 + 2440587.5;
}

// Solar declination and equation of time for a Julian century.
function solarGeom(jc) {
  const gml = (280.46646 + jc * (36000.76983 + jc * 0.0003032)) % 360; // geom mean longitude
  const gma = 357.52911 + jc * (35999.05029 - 0.0001537 * jc);         // geom mean anomaly
  const ecc = 0.016708634 - jc * (0.000042037 + 0.0000001267 * jc);    // eccentricity
  const sinM = Math.sin(gma * RAD);
  const eqCtr = sinM * (1.914602 - jc * (0.004817 + 0.000014 * jc))
    + Math.sin(2 * gma * RAD) * (0.019993 - 0.000101 * jc)
    + Math.sin(3 * gma * RAD) * 0.000289;
  const trueLong = gml + eqCtr;
  const appLong = trueLong - 0.00569 - 0.00478 * Math.sin((125.04 - 1934.136 * jc) * RAD);
  const obliq = 23 + (26 + (21.448 - jc * (46.815 + jc * (0.00059 - jc * 0.001813))) / 60) / 60;
  const obliqCorr = obliq + 0.00256 * Math.cos((125.04 - 1934.136 * jc) * RAD);
  const declin = Math.asin(Math.sin(obliqCorr * RAD) * Math.sin(appLong * RAD)) * DEG;

  const y = Math.tan(obliqCorr / 2 * RAD) ** 2;
  const eqTime = 4 * DEG * (
    y * Math.sin(2 * gml * RAD)
    - 2 * ecc * sinM
    + 4 * ecc * y * sinM * Math.cos(2 * gml * RAD)
    - 0.5 * y * y * Math.sin(4 * gml * RAD)
    - 1.25 * ecc * ecc * Math.sin(2 * gma * RAD)
  ); // minutes
  return { declin, eqTime };
}

// Compute sunrise/sunset (UTC ms) for a specific UTC calendar-day midnight.
function solarForDay(lat, lon, midnight) {
  const jcNoon = (julianDay(midnight + 43200000) - 2451545) / 36525;
  const { declin, eqTime } = solarGeom(jcNoon);
  const zenith = 90.833;
  const cosH = (Math.cos(zenith * RAD) - Math.sin(lat * RAD) * Math.sin(declin * RAD))
    / (Math.cos(lat * RAD) * Math.cos(declin * RAD));
  if (cosH > 1) return { polar: 'night' };
  if (cosH < -1) return { polar: 'day' };
  const haDeg = Math.acos(cosH) * DEG;
  const noonMin = 720 - 4 * lon - eqTime; // minutes from this UTC midnight to solar noon
  return {
    sunriseMs: midnight + (noonMin - 4 * haDeg) * 60000,
    sunsetMs: midnight + (noonMin + 4 * haDeg) * 60000,
    noonMs: midnight + noonMin * 60000,
  };
}

export function solarTimes(lat, lon, dateMs) {
  if (lat == null || lon == null || !Number.isFinite(dateMs)) return null;
  // Try the UTC day of the target and its neighbours, and keep the solar day
  // whose local NOON is closest to the target instant. This makes sunrise/sunset
  // correctly bracket the target regardless of longitude — at high east/west
  // longitudes the local day's events straddle a UTC midnight, so the naive "UTC
  // day of the target" can pick the wrong day (the bug where morning stayed dark
  // until midday at UTC+12).
  const utcMid = (ms) => { const d = new Date(ms); return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()); };
  const base = utcMid(dateMs);
  let best = null;
  for (const off of [-1, 0, 1]) {
    const s = solarForDay(lat, lon, base + off * 86400000);
    if (s.polar) return s; // polar day/night: unambiguous, return directly
    const dist = Math.abs(s.noonMs - dateMs);
    if (!best || dist < best.dist) best = { s, dist };
  }
  return { sunriseMs: best.s.sunriseMs, sunsetMs: best.s.sunsetMs };
}
