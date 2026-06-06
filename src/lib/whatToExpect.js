/**
 * Ride the Wind — "What to expect" line  (spec §8)
 *
 * Computes three short condition tokens for the home card, from the same
 * forecast already fetched for the wind model:
 *   - temperature (°C, integer): min over the ride, unless max ≥ 26 °C → max
 *   - rain: blank | "maybe wet" | "wet" | "very wet", by mm-per-riding-hour
 *           (gated behind ≥25% probability)
 *   - side wind: blank | "side winds" | "strong side winds", by time-weighted
 *           mean absolute crosswind
 *
 * Pure functions over injected forecast + segments + segment time weights, so
 * it is fully testable offline. The caller supplies a windFn(lat,lon,atMs) that
 * returns the full sample { speed, fromDeg, tempC, precipMm, precipProb } at a
 * point and time — built from windModel.makeWindFn over parsed series.
 */

const DEG = Math.PI / 180;

export const TEMP_HOT_C = 26; // at/above this, show the max not the min
export const RAIN_PROB_GATE = 15; // %, below which rain stays blank
export const RAIN_BANDS = [0.05, 0.5, 2]; // total mm boundaries: maybe / wet / very
export const SIDEWIND_BANDS = [15, 30]; // km/h: side / strong
export const SNOW_CM_GATE = 0.1; // cm in an hour: any snow worth flagging
// WMO weather codes (Open-Meteo `weather_code`) for fog and snow.
export const FOG_CODES = [45, 48];
export const SNOW_CODES = [71, 73, 75, 77, 85, 86];

/* ------------------------------------------------------------------ *
 * Per-segment sampling along the arrival window
 * ------------------------------------------------------------------ */

/**
 * Walk the route from departure, sampling the full forecast at each segment's
 * arrival time, and collect the raw series needed for all three tokens.
 *
 * @param {Object} args
 * @param {Array}  args.segments  - [{lat,lon,bearing}]
 * @param {number[]} args.times   - still-air seconds per segment (weights)
 * @param {Function} args.windFn  - (lat,lon,atMs)=>{speed,fromDeg,tempC,precipMm,precipProb}
 * @param {number} args.departMs
 * @returns {{temps:number[], crosswinds:number[], precipTotalMm:number, precipProb:number[], rideHours:number}}
 */
export function sampleConditions({ segments, times, windFn, departMs }) {
  const temps = [];
  const crosswinds = [];
  let precipTotalMm = 0; // mm actually falling during the ride
  const precipProb = [];
  let snow = false; // snow forecast at any point during the ride
  let fog = false;  // fog forecast at any point during the ride
  let clock = departMs;
  let totalSec = 0;

  for (let i = 0; i < segments.length; i++) {
    const s = segments[i];
    const w = windFn(s.lat, s.lon, clock);
    if (w.tempC != null) temps.push(w.tempC);
    // crosswind = |wind · sin(φ − θ)|
    const cross = Math.abs(w.speed * Math.sin((w.fromDeg - s.bearing) * DEG));
    crosswinds.push({ v: cross, t: times[i] });
    // precipMm is the mm for the whole hour; the rider is only in this segment
    // for times[i] seconds, so the rain that falls on them here is the hourly
    // rate prorated by their fraction of the hour. Summed = total over ride.
    precipTotalMm += (w.precipMm || 0) * (times[i] / 3600);
    precipProb.push(w.precipProb || 0);
    // Snow / fog: present if forecast at ANY point along the ride. snowfall is a
    // direct cm/hour figure; fog has no dedicated field so we read the WMO code.
    if ((w.snowfallCm || 0) >= SNOW_CM_GATE || SNOW_CODES.includes(w.weatherCode)) snow = true;
    if (FOG_CODES.includes(w.weatherCode)) fog = true;
    clock += times[i] * 1000;
    totalSec += times[i];
  }
  return { temps, crosswinds, precipTotalMm, precipProb, snow, fog, rideHours: totalSec / 3600 };
}

/* ------------------------------------------------------------------ *
 * Tokens
 * ------------------------------------------------------------------ */

/** Integer temperature: min over ride, unless max ≥ TEMP_HOT_C → max. */
export function temperatureToken(temps) {
  if (!temps || temps.length === 0) return null;
  const min = Math.min(...temps);
  const max = Math.max(...temps);
  const show = max >= TEMP_HOT_C ? max : min;
  return `${Math.round(show)}°C`;
}

/**
 * Rain token from TOTAL precipitation accumulated over the ride (mm), gated by
 * probability. Total (not rate) so a longer ride in the same rain reads wetter
 * — the honest measure of arrival wetness. Returns null when dry, low-
 * confidence, or below the first band.
 */
export function rainToken(precipTotalMm, precipProb) {
  const maxProb = precipProb && precipProb.length ? Math.max(...precipProb) : 0;
  if (maxProb < RAIN_PROB_GATE) return null;

  const total = precipTotalMm || 0; // mm over the ride
  const [maybe, wet, very] = RAIN_BANDS;
  if (total < maybe) return null;
  if (total < wet) return "maybe wet";
  if (total < very) return "wet";
  return "very wet";
}

/** Side-wind token from time-weighted mean absolute crosswind (km/h). */
export function sideWindToken(crosswinds) {
  if (!crosswinds || crosswinds.length === 0) return null;
  let num = 0, den = 0;
  for (const c of crosswinds) { num += c.v * c.t; den += c.t; }
  const mean = den > 0 ? num / den : 0;
  const [side, strong] = SIDEWIND_BANDS;
  if (mean < side) return null;
  if (mean < strong) return "side winds";
  return "strong side winds";
}

/* ------------------------------------------------------------------ *
 * Assembly
 * ------------------------------------------------------------------ */

/**
 * Full "what to expect" result for a route at a departure time.
 * Returns { tokens: string[], line: string } — line is tokens joined by " · ".
 */
export function whatToExpect({ segments, times, windFn, departMs }) {
  const c = sampleConditions({ segments, times, windFn, departMs });
  const tokens = [
    temperatureToken(c.temps),
    rainToken(c.precipTotalMm, c.precipProb),
    c.snow ? "snow" : null,
    c.fog ? "fog" : null,
    sideWindToken(c.crosswinds),
  ].filter(Boolean);
  return { tokens, line: tokens.join(" · ") };
}
