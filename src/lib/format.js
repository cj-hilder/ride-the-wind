/**
 * Ride the Wind — display format seam (v1.4.0).
 *
 * Every value shown to the user passes through one of these pure functions, so a
 * units/format preference is honoured everywhere and there is ONE place to change
 * each format. Settings NEVER change stored or computed data — display only.
 *
 * Canonical units the app stores/computes in (unchanged by settings):
 *   temperature °C · speed km/h · duration seconds · time-of-day epoch ms ·
 *   distance km · rainfall mm (rate mm/h).
 *
 * Wiring (option B): a module-level settings snapshot, set via setFormatSettings()
 * at startup and whenever settings change. Call sites call e.g. formatRideSpeed(24)
 * with no settings arg. Each function ALSO accepts an optional explicit settings
 * override (2nd/3rd arg) used only by tests — the arg wins over the snapshot, so
 * tests stay pure without touching global state.
 */

export const DEFAULT_UNITS = Object.freeze({
  temp: "c",         // "c" | "f"
  duration: "hrmin", // "min" | "hrmin" | "colon"   (form 1 / 2 / 3)
  rideSpeed: "kmh",  // "kmh" | "mph"
  windSpeed: "kmh",  // "kmh" | "mph" | "kt"
  distance: "km",    // "km" | "mi"
  rainfall: "mm",    // "mm" | "in"
  decimal: "dot",    // "dot" | "comma"
});
// NOTE: time-of-day 12/24h is intentionally NOT a setting. Native time inputs
// (the entry widget + OS picker) always follow the system locale and can't be
// overridden, so the app follows the system too — that way the chip, the verdict
// times, the entry widget, and the picker all agree. Detected once here.

/** True if the system locale uses 12-hour time. Resolved from Intl; defaults to
 * true if unavailable. Cached (system locale doesn't change mid-session). */
let _systemHour12 = null;
export function systemHour12() {
  if (_systemHour12 === null) {
    try {
      const opt = new Intl.DateTimeFormat().resolvedOptions();
      // hour12 may be undefined on some engines; fall back to probing hourCycle.
      _systemHour12 = typeof opt.hour12 === "boolean"
        ? opt.hour12
        : (opt.hourCycle ? /h11|h12/.test(opt.hourCycle) : true);
    } catch {
      _systemHour12 = true;
    }
  }
  return _systemHour12;
}
/** Test seam: override the detected system clock (pass true/false), or null to
 * re-detect. */
export function _setSystemHour12(v) { _systemHour12 = v; }

// ── settings snapshot ───────────────────────────────────────────────────────
let _settings = { ...DEFAULT_UNITS };

/** Replace the live settings snapshot. Unknown/missing keys fall back to defaults. */
export function setFormatSettings(s) {
  _settings = { ...DEFAULT_UNITS, ...(s || {}) };
}
/** Current snapshot (copy). */
export function getFormatSettings() {
  return { ..._settings };
}
/** Resolve the settings to use for a call: explicit override wins, else snapshot. */
function use(s) {
  return s ? { ...DEFAULT_UNITS, ..._settings, ...s } : _settings;
}

// ── conversion constants ────────────────────────────────────────────────────
const KMH_PER_MPH = 1.609344;      // 1 mph = 1.609344 km/h
const KMH_PER_KT = 1.852;          // 1 kt  = 1.852 km/h
const KM_PER_MI = 1.609344;
const MM_PER_IN = 25.4;

// ── number helpers ──────────────────────────────────────────────────────────
/** Round to `dp` decimals and render with the chosen decimal separator. Trailing
 * zeros are kept (so 1 dp always shows 1 dp) — consistent columns beat brevity. */
function num(value, dp, s) {
  const settings = s; // already-resolved settings passed in
  const fixed = (Math.abs(value) < 5e-9 ? 0 : value).toFixed(dp); // avoid "-0"
  return settings.decimal === "comma" ? fixed.replace(".", ",") : fixed;
}

// ── temperature ─────────────────────────────────────────────────────────────
/** °C canonical → "12°C" | "54°F" (whole degrees, as today). */
export function formatTemperature(celsius, s) {
  const st = use(s);
  if (celsius == null || Number.isNaN(celsius)) return "";
  if (st.temp === "f") return `${num(celsius * 9 / 5 + 32, 0, st)}°F`;
  return `${num(celsius, 0, st)}°C`;
}

// ── time of day ─────────────────────────────────────────────────────────────
/** epoch ms → "08:45" (24h) | "8:45 am" (12h, lowercase). Follows the SYSTEM
 * clock format (not a setting) so it agrees with native time widgets. */
export function formatTimeOfDay(epochMs, s) {
  if (epochMs == null || Number.isNaN(epochMs)) return "";
  const d = new Date(epochMs);
  let h = d.getHours();
  const m = d.getMinutes();
  const mm = String(m).padStart(2, "0");
  if (systemHour12()) {
    const ampm = h < 12 ? "am" : "pm";
    let h12 = h % 12;
    if (h12 === 0) h12 = 12; // 0→12 (midnight), 12→12 (noon)
    return `${h12}:${mm} ${ampm}`;
  }
  return `${String(h).padStart(2, "0")}:${mm}`;
}

// ── duration / elapsed ──────────────────────────────────────────────────────
/** seconds → duration. <1 h → "«mins» min". ≥1 h → per `duration` setting:
 *  "min" form1 "«total mins» min"; "hrmin" form2 "«h» hr «mm»"; "colon" form3 "«h»:«mm»".
 *  Minutes carry a leading zero in forms 2 & 3 only. Rounds to whole minutes. */
export function formatElapsed(seconds, s) {
  const st = use(s);
  if (seconds == null || Number.isNaN(seconds) || seconds < 0) return "";
  const totalMin = Math.round(seconds / 60);
  if (totalMin < 60) return `${totalMin} min`;
  if (st.duration === "min") return `${totalMin} min`;
  const h = Math.floor(totalMin / 60);
  const mm = String(totalMin % 60).padStart(2, "0");
  return st.duration === "colon" ? `${h}:${mm}` : `${h} hr ${mm}`;
}

// ── ride speed ──────────────────────────────────────────────────────────────
/** km/h canonical → "24 km/h" | "15 mph" (same dp as km/h; whole today). */
export function formatRideSpeed(kmh, s, { dp = 0 } = {}) {
  const st = use(s);
  if (kmh == null || Number.isNaN(kmh)) return "";
  if (st.rideSpeed === "mph") return `${num(kmh / KMH_PER_MPH, dp, st)} mph`;
  return `${num(kmh, dp, st)} km/h`;
}

// ── wind speed ──────────────────────────────────────────────────────────────
/** km/h canonical → "22 km/h" | "14 mph" | "12 kt". */
export function formatWindSpeed(kmh, s, { dp = 0 } = {}) {
  const st = use(s);
  if (kmh == null || Number.isNaN(kmh)) return "";
  if (st.windSpeed === "mph") return `${num(kmh / KMH_PER_MPH, dp, st)} mph`;
  if (st.windSpeed === "kt") return `${num(kmh / KMH_PER_KT, dp, st)} kt`;
  return `${num(kmh, dp, st)} km/h`;
}

// ── distance ────────────────────────────────────────────────────────────────
/** km canonical → "5.2 km" | "3.2 mi" (mi mirrors the call site's dp). */
export function formatDistance(km, s, { dp = 1 } = {}) {
  const st = use(s);
  if (km == null || Number.isNaN(km)) return "";
  if (st.distance === "mi") return `${num(km / KM_PER_MI, dp, st)} mi`;
  return `${num(km, dp, st)} km`;
}

// ── rainfall ────────────────────────────────────────────────────────────────
/** mm canonical → "1.2 mm" | "0.05 in". `rate:true` adds the per-hour suffix.
 *  Inches use one more dp than mm (in-dp = mmDp + 1). `mmDp` defaults to 1. */
export function formatRainfall(mm, s, { rate = false, mmDp = 1 } = {}) {
  const st = use(s);
  if (mm == null || Number.isNaN(mm)) return "";
  if (st.rainfall === "in") {
    const v = num(mm / MM_PER_IN, mmDp + 1, st);
    return rate ? `${v} in/h` : `${v} in`;
  }
  const v = num(mm, mmDp, st);
  return rate ? `${v} mm/h` : `${v} mm`;
}

/** Format a stored 24-hour "HH:MM" config string (e.g. a route's target arrival)
 * for DISPLAY. Follows the SYSTEM clock format (not a setting). The stored value
 * stays 24h; this only affects how it's shown. Invalid input returned unchanged. */
export function formatClockString(hhmm, s) {
  if (typeof hhmm !== "string") return "";
  const m = hhmm.match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return hhmm;
  const h = +m[1], mm = m[2];
  if (systemHour12()) {
    const ampm = h < 12 ? "am" : "pm";
    let h12 = h % 12; if (h12 === 0) h12 = 12;
    return `${h12}:${mm} ${ampm}`;
  }
  return `${String(h).padStart(2, "0")}:${mm}`;
}

/** Elevation gain (total ascent, metres canonical) → "340 m" | "1115 ft".
 * COUPLES to the distance setting (m with km, ft with mi) — the conventional
 * imperial/metric pairing — rather than being its own preference. Whole units. */
export function formatElevation(metres, s) {
  const st = use(s);
  if (metres == null || Number.isNaN(metres)) return "";
  if (st.distance === "mi") return `${num(metres * 3.28084, 0, st)} ft`;
  return `${num(metres, 0, st)} m`;
}

// ── inverse seam: baseline-speed spinner INPUT (display → canonical) ─────────
/** Convert a spinner value shown in the ride-speed unit back to canonical km/h. */
export function rideSpeedToCanonicalKmh(displayVal, s) {
  const st = use(s);
  if (displayVal == null || Number.isNaN(displayVal)) return null;
  return st.rideSpeed === "mph" ? displayVal * KMH_PER_MPH : displayVal;
}
/** Convert canonical km/h to a value in the current ride-speed unit (for seeding
 * the spinner when it opens). */
export function canonicalKmhToRideSpeed(kmh, s) {
  const st = use(s);
  if (kmh == null || Number.isNaN(kmh)) return null;
  return st.rideSpeed === "mph" ? kmh / KMH_PER_MPH : kmh;
}
/** Step for the spinner, in the display unit — always 0.5 regardless of unit. */
export function rideSpeedStep() { return 0.5; }
/** The ride-speed unit label ("km/h" | "mph"), for the spinner suffix. */
export function rideSpeedUnitLabel(s) {
  return use(s).rideSpeed === "mph" ? "mph" : "km/h";
}
/** Convert canonical km/h bounds to display-unit bounds (so the physical range is
 * identical, only the numbers + step-unit change). Returns {min,max} in display unit. */
export function rideSpeedBounds(minKmh, maxKmh, s) {
  const st = use(s);
  const conv = (v) => (st.rideSpeed === "mph" ? v / KMH_PER_MPH : v);
  return { min: conv(minKmh), max: conv(maxKmh) };
}
