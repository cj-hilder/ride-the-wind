/**
 * Ride the Wind — "What to expect" line  (spec §8)
 *
 * Computes three short condition tokens for the home card, from the same
 * forecast already fetched for the wind model:
 *   - temperature (°C, integer): min over the ride, unless max ≥ 26 °C → max
 *   - rain: blank | "maybe wet" | "wet" | "very wet", by mm-per-riding-hour
 *           (gated behind ≥25% probability)
 *   - crosswind: blank | "crosswinds" | "strong crosswinds", by time-weighted
 *           mean absolute crosswind
 *
 * Pure functions over injected forecast + segments + segment time weights, so
 * it is fully testable offline. The caller supplies a windFn(lat,lon,atMs) that
 * returns the full sample { speed, fromDeg, tempC, precipMm, precipProb } at a
 * point and time — built from windModel.makeWindFn over parsed series.
 */

const DEG = Math.PI / 180;

export const TEMP_HOT_C = 26; // at/above this, show the max not the min
// Rain is judged on TOTAL mm over the ride (a long drizzle soaks like a short
// shower). Bands anchored to the cycling kit decision: light = water-resistant
// layer copes (arrive damp); wet = full waterproofs justified; very wet = soaked
// regardless. "maybe" is a separate probability-driven prefix (below).
export const RAIN_PROB_GATE = 10;   // %, below which rain stays blank
export const RAIN_PROB_MAYBE = 50;  // %, 10–50 → "maybe <x>"; ≥50 → "<x>"
export const RAIN_BANDS = [0.1, 1, 4]; // total mm boundaries: light / wet / very
export const CROSSWIND_BANDS = [15, 30]; // km/h: crosswinds / strong
// Snow is a cm/HOUR rate. Any settling snow matters for traction/visibility, so
// the bar is low. Intensity-labelled (no "maybe": the deterministic feed carries
// no snow probability, so a likelihood claim would be invented confidence).
export const SNOW_LIGHT_CM = 0.05; // cm/h: flurries, not settling much → "light snow"
export const SNOW_FULL_CM = 0.5;   // cm/h: meaningful accumulation → "snow"
// Strong-gust alert. The danger is the lull→gust DIFFERENTIAL that unsettles
// handling, not absolute force, so require both a high absolute gust AND a
// meaningful margin over sustained wind. 50 km/h is a 10 m-forecast figure
// chosen with ground effect in mind (gusts attenuate at rider height, so a
// forecast 50 reaches the rider as the speed that starts shoving them).
export const GUST_ABS_KMH = 50;    // km/h: absolute gust floor
export const GUST_OVER_SUSTAINED_KMH = 15; // km/h: gust must exceed sustained by this
// WMO weather codes (Open-Meteo `weather_code`) for fog and snow.
export const FOG_CODES = [45, 48];
export const SNOW_CODES = [71, 73, 75, 77, 85, 86];
// Cycling-critical extremes worth flagging on their own:
export const THUNDER_CODES = [95, 96, 99];       // thunderstorm (96/99 with hail)
export const FREEZING_CODES = [56, 57, 66, 67];  // freezing drizzle / freezing rain → black ice

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
  let snowMaxCm = 0; // max snowfall rate (cm/h) seen along the ride
  let snowCode = false; // a definite snow WMO code at any point
  let fog = false;  // fog forecast at any point during the ride
  let thunder = false; // thunderstorm at any point
  let freezing = false; // freezing rain/drizzle (black-ice hazard) at any point
  let strongGust = false; // a destabilising gust (high + gusty) at any point
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
    // Hazard flags: present if forecast at ANY point along the ride. snowfall is
    // a direct cm/hour rate (track the max for intensity banding); the rest read
    // the WMO code. Strong gusts need both a high absolute gust and a gust that
    // exceeds the sustained wind by a margin (the destabilising differential).
    if ((w.snowfallCm || 0) > snowMaxCm) snowMaxCm = w.snowfallCm || 0;
    if (SNOW_CODES.includes(w.weatherCode)) snowCode = true;
    if (FOG_CODES.includes(w.weatherCode)) fog = true;
    if (THUNDER_CODES.includes(w.weatherCode)) thunder = true;
    if (FREEZING_CODES.includes(w.weatherCode)) freezing = true;
    const gust = w.gustKmh;
    if (typeof gust === "number" && gust >= GUST_ABS_KMH &&
        gust - (w.speed || 0) >= GUST_OVER_SUSTAINED_KMH) strongGust = true;
    clock += times[i] * 1000;
    totalSec += times[i];
  }
  return { temps, crosswinds, precipTotalMm, precipProb, snowMaxCm, snowCode, fog, thunder, freezing, strongGust, rideHours: totalSec / 3600 };
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
 * Rain token from TOTAL precipitation over the ride (mm), with a probability-
 * driven "maybe" prefix. Intensity (light / wet / very wet) comes from the mm
 * total; "maybe" is prepended when the forecast probability is in the middling
 * band (RAIN_PROB_GATE..RAIN_PROB_MAYBE), meaning "on the cards, not certain".
 * Below the gate, or below the light band, returns null. Being liberal with
 * "maybe" is deliberate: forecast rain often doesn't eventuate, and the cost of
 * a needless jacket is far less than a soaked commute.
 */
export function rainToken(precipTotalMm, precipProb) {
  const maxProb = precipProb && precipProb.length ? Math.max(...precipProb) : 0;
  if (maxProb < RAIN_PROB_GATE) return null;

  const total = precipTotalMm || 0; // mm over the ride
  const [light, wet, very] = RAIN_BANDS;
  if (total < light) return null;
  const intensity = total < wet ? "light rain" : total < very ? "wet" : "very wet";
  const maybe = maxProb < RAIN_PROB_MAYBE;
  return maybe ? `maybe ${intensity}` : intensity;
}

/**
 * Snow token from the max snowfall RATE over the ride (cm/h), or a definite snow
 * WMO code. Intensity-labelled: "light snow" (flurries, not settling) vs "snow"
 * (meaningful accumulation). No "maybe" — the deterministic feed has no snow
 * probability, so a likelihood claim would be invented. A definite snow code
 * with a sub-light rate still reads "light snow" (the code confirms it's snow,
 * the low rate says it's light). Returns null below the light floor and no code.
 */
export function snowToken(snowMaxCm, snowCode) {
  const rate = snowMaxCm || 0;
  if (rate >= SNOW_FULL_CM) return "snow";
  if (rate >= SNOW_LIGHT_CM) return "light snow";
  if (snowCode) return "light snow"; // code says snow but rate is trace/absent
  return null;
}

/** Crosswind token from time-weighted mean absolute crosswind (km/h). */
export function crosswindToken(crosswinds) {
  if (!crosswinds || crosswinds.length === 0) return null;
  let num = 0, den = 0;
  for (const c of crosswinds) { num += c.v * c.t; den += c.t; }
  const mean = den > 0 ? num / den : 0;
  const [side, strong] = CROSSWIND_BANDS;
  if (mean < side) return null;
  if (mean < strong) return "crosswinds";
  return "strong crosswinds";
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
    c.thunder ? "thunderstorms" : null,
    c.freezing ? "freezing rain" : null,
    snowToken(c.snowMaxCm, c.snowCode),
    c.fog ? "fog" : null,
    c.strongGust ? "strong gusts" : null,
    crosswindToken(c.crosswinds),
  ].filter(Boolean);
  return { tokens, line: tokens.join(" · ") };
}
