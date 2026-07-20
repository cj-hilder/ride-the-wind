import React, { useState, useEffect, useCallback, useRef } from "react";

/* ============================================================================
 * Ride the Wind — App shell
 *
 * The thin top layer that ties the three screens together over the real
 * AppController (app.js → composes gpxRoute, windModel, learning, alertEngine,
 * prediction, storage). This file owns navigation and the live data
 * lifecycle; the screens are presentational and receive controller results.
 *
 * In production this imports the real controller:
 *     import { createAppController } from "./app.js";
 *     const controller = createAppController();   // IndexedDB + Open-Meteo
 *
 * For this standalone artifact, a faithful in-memory controller stub stands in
 * (same method surface, demo data + synthetic forecast) so the navigation and
 * full screen flow are explorable without a backend. Swap the stub import for
 * the real createAppController and nothing else changes.
 * ========================================================================== */

import { createAppController } from "./lib/app.js";
import { solarTimes } from "./lib/solar.js";
import {
  speedToAngle, polarPoint, clockAngles, arrivalBezel, expectedArrivalMs,
  emaStep, routePolyline, projectToRoute,
  needleTauMs, needleTauMsFromSpeedAcc, NEEDLE_TAU_SCALE, PACE_EMA_TAU_MS, PACE_MOVING_MIN_MPS, SPEED_SANE_MAX_MPS, GPS_ACCURACY_GATE_M, GPS_ACCURACY_HARD_M, NEEDLE_WARMUP_ACC_M, NEEDLE_MAX_ACCEL_MPS2, NEEDLE_MAX_DT_MS, SPEEDO_MAX_KMH,
} from "./lib/rideReadout.js";
import HelpPanel from "./HelpPanel.jsx";
import { setFormatSettings, DEFAULT_UNITS, formatTemperature, formatTimeOfDay, formatElapsed, formatRideSpeed, formatWindSpeed, formatDistance, formatDistanceAdaptive, formatRainfall, formatClockString, formatElevation, rainfallValue, rainfallUnitLabel, exampleWindLabel, canonicalKmhToRideSpeed, rideSpeedToCanonicalKmh, rideSpeedStep, rideSpeedBounds, rideSpeedUnitLabel } from "./lib/format.js";
import { RAIN_RATE_BANDS, RAIN_TOTAL_BANDS } from "./lib/whatToExpect.js";
import { effortNorm } from "./lib/windModel.js";
import { DEFAULT_K } from "./lib/windModel.js";
import { rideK as computeRideK } from "./lib/learning.js";

/* Error boundary around the active screen. A render error in one screen (e.g. a
 * transient bad shape during a forecast refresh) must NOT tear down the whole
 * app and the tab bar — the user has to be able to navigate away. This catches
 * the error, shows a recoverable message, and keeps the tabs alive. The reset
 * key (the current screen) clears the error when the user switches tabs. */
class ScreenBoundary extends React.Component {
  constructor(props) { super(props); this.state = { error: null }; }
  static getDerivedStateFromError(error) { return { error }; }
  componentDidUpdate(prev) {
    // Clear the error when the reset key changes (e.g. user switched screen).
    if (this.state.error && prev.resetKey !== this.props.resetKey) this.setState({ error: null });
  }
  render() {
    if (this.state.error) {
      return (
        <div style={{ height: "100%", display: "grid", placeItems: "center", padding: 28, textAlign: "center", color: "rgba(255,255,255,0.7)", background: "linear-gradient(165deg,#12152b,#1d1b38 55%,#281f44)" }}>
          <div>
            <div style={{ fontFamily: "'Fraunces',serif", fontSize: 19, fontWeight: 600, color: "#fff", marginBottom: 8 }}>Something went wrong here</div>
            <div style={{ fontSize: 13.5, lineHeight: 1.5 }}>This screen hit a snag. Use the tabs below to switch away and back, or pull a fresh forecast.</div>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

/* dawn-to-dusk palette shared with the screens */
const SKY = {
  predawn: ["#12152b", "#1d1b38", "#281f44"],
  sunrise: ["#6b3a3f", "#7a4156", "#5a3a63"],
  day: ["#1f4a63", "#2a5a78", "#356b8a"],
  dusk: ["#6b3f2e", "#5e3a44", "#3c2d50"],
  night: ["#0f1226", "#171530", "#201a3a"],
};
const SKY_BAND_MS = 40 * 60000; // ± window around sunrise/sunset for the transition palettes

/**
 * Pick a sky palette by comparing the departure instant against the route's real
 * sunrise/sunset instants (all absolute UTC ms — no timezone conversion). A fixed
 * ±SKY_BAND_MS band around each event gets the sunrise/dusk palettes; between the
 * bands is day, outside is night/predawn. `solar` may be null (no geometry yet),
 * or a polar-day/polar-night marker at high latitudes.
 */
const skyFor = (instantMs, solar) => {
  if (!solar) return SKY.predawn;
  if (solar.polar === 'day') return SKY.day;
  if (solar.polar === 'night') return SKY.night;
  const { sunriseMs, sunsetMs } = solar;
  if (instantMs < sunriseMs - SKY_BAND_MS) return SKY.predawn;
  if (instantMs < sunriseMs + SKY_BAND_MS) return SKY.sunrise;
  if (instantMs < sunsetMs - SKY_BAND_MS) return SKY.day;
  if (instantMs < sunsetMs + SKY_BAND_MS) return SKY.dusk;
  return SKY.night;
};

/**
 * Sky palette for a ride, chosen by the ride's MIDPOINT rather than its start —
 * a ride spanning two daylight bands (e.g. departs in the sunrise band, arrives
 * in day) should reflect where most of the ride actually is. Midpoint =
 * departure + half the predicted duration. `startRegion` gives the departure
 * lat/lon for the (timezone-free) solar calc. The plan and ride screens both
 * call this the same way, so a rider who checks "go now" and then rides sees the
 * same colour (both use departure = now).
 */
const skyForRide = (startRegion, departureMs, predictedSec) => {
  if (departureMs == null) return SKY.predawn;
  const midpointMs = departureMs + (predictedSec ? predictedSec * 500 : 0); // +half duration (sec·1000/2)
  const solar = startRegion ? solarTimes(startRegion.lat, startRegion.lon, midpointMs) : null;
  return skyFor(midpointMs, solar);
};
const ACCENT = { headwind: "#5b8fc7", tailwind: "#e0a45e", normal: "#9aa7b0" };
const fmtMin = (sec) => formatElapsed(sec);

// "Uncertainty allowance" slider speaks 0–100% (how much of the forecast spread to
// apply); the model wants a percentile in 50–99. 0% → 50 (median, no margin),
// 100% → 99 (most cautious). Linear map, with a clean round-trip.
const sliderToPct = (s) => Math.round(50 + (Math.max(0, Math.min(100, s)) / 100) * 49);
const pctToSlider = (p) => Math.round(((Math.max(50, Math.min(99, p)) - 50) / 49) * 100);

// Label the forecast day: "today"/"tomorrow" when close, else the weekday name.
const WEEKDAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

// Wind-effect description: direction word + effect as a range of minutes.
// loMin/hiMin are (predicted − baseline) at the fast/slow ends; + = slower.
/* Live countdown to the displayed departure time. Shown only within the window
 * from 2 hours before to 1 hour after. Returns "" outside that window so the
 * time alone stands. No scheduler/notifications — this is the passive, always-
 * correct replacement, useful exactly while the app is open. */
function countdownPhrase(departMs, nowMs) {
  if (departMs == null) return "";
  const diffMin = Math.round((departMs - nowMs) / 60000); // + = future
  if (diffMin > 120 || diffMin < -60) return "";
  if (diffMin === 0) return "now";
  if (diffMin < 0) return `${-diffMin} min${diffMin === -1 ? "" : "s"} ago`;
  if (diffMin < 60) return `in ${diffMin} min${diffMin === 1 ? "" : "s"}`;
  const h = Math.floor(diffMin / 60), m = diffMin % 60;
  if (m === 0) return `in ${h} hour${h === 1 ? "" : "s"}`;
  return `in ${h} hour${h === 1 ? "" : "s"} ${m} min${m === 1 ? "" : "s"}`;
}

function windEffectPhrase(we, light = false) {
  if (!we) return "";
  const WIND_FLOOR = 7.5; // km/h
  const fast = we.fastMin, slow = we.slowMin, likely = we.likelyMin;
  const ride = fast === slow
    ? `ride for ${formatElapsed(likely * 60)}`
    : `ride for ${formatElapsed(fast * 60)} to ${formatElapsed(slow * 60)} (likely ${formatElapsed(likely * 60)})`;
  if (we.direction === "calm") {
    // "No wind" only when the forecast wind is genuinely slight; if there's a
    // real wind that simply has little net along-route effect, say so instead.
    const noWindLabel = (we.windSpeedKmh ?? 0) > WIND_FLOOR ? "No wind effect" : "No wind";
    return `${noWindLabel}: ${ride}`;
  }
  if (we.direction === "mixed") return `${we.headPct}% chance headwind: ${ride}`;
  // "Light head/tailwind" applies only when the verdict is under-threshold AND
  // the mean headwind is genuinely slight (< 7.5 km/h). A strong wind that
  // happens to fall just under the time threshold still reads as a full
  // "Headwind/Tailwind", not "Light".
  const base = we.direction === "headwind" ? "headwind" : "tailwind";
  const isLight = light && (we.meanHeadKmh ?? 0) < WIND_FLOOR;
  const label = isLight
    ? `Light ${base}`
    : base.charAt(0).toUpperCase() + base.slice(1);
  return `${label}: ${ride}`;
}

function dayLabel(arrivalMs) {
  if (!arrivalMs) return "";
  const arr = new Date(arrivalMs);
  const today = new Date();
  const startOfDay = (d) => { const x = new Date(d); x.setHours(0, 0, 0, 0); return x.getTime(); };
  const days = Math.round((startOfDay(arr) - startOfDay(today)) / 86400000);
  if (days <= 0) return "today";
  if (days === 1) return "tomorrow";
  return WEEKDAY_NAMES[arr.getDay()];
}

/**
 * If a route lies in a very different timezone region than the phone is set to,
 * return the phone's IANA timezone name to show as a caption (times are always
 * in the phone's timezone). No geolocation: we infer the phone's expected
 * longitude from its standard (non-DST) UTC offset and compare to the route's
 * longitude. Using the standard offset (not the current, possibly DST-shifted
 * one) keeps the reference longitude stable year-round, so the hint doesn't
 * appear/disappear across a DST change for the same route. Returns null when
 * within TZ_HINT_DEG (the common case → no caption). 22.5° ≈ 1.5 timezones, so
 * the hint only speaks up for a route clearly in another part of the world, not
 * a merely adjacent zone (timezones are wide and political, so a smaller
 * threshold gives false positives e.g. across a single wide country).
 */
const TZ_HINT_DEG = 22.5;
function phoneTimezoneHint(routeLon) {
  if (typeof routeLon !== "number" || Number.isNaN(routeLon)) return null;
  // Standard (non-DST) offset: getTimezoneOffset is DST-corrected for the given
  // date, so sample January and July and take the more-positive (= standard
  // time, DST removed; DST springs forward and reduces the offset). Then shift
  // 30 min west: timezones nominally cover the offset meridian ±7.5° but in
  // practice sit east of it, so this better centres the "is this route elsewhere"
  // test. getTimezoneOffset is minutes behind UTC (positive = west), so negate.
  const y = new Date().getFullYear();
  const stdOffsetMin = Math.max(
    new Date(y, 0, 1).getTimezoneOffset(),
    new Date(y, 6, 1).getTimezoneOffset()
  );
  const offsetHours = (-stdOffsetMin - 30) / 60;
  let expectedLon = offsetHours * 15;
  // Normalise both to [-180,180] and compare on the shortest angular distance.
  const norm = (x) => { let v = ((x + 180) % 360 + 360) % 360 - 180; return v; };
  let diff = Math.abs(norm(routeLon) - norm(expectedLon));
  if (diff > 180) diff = 360 - diff;
  if (diff <= TZ_HINT_DEG) return null;
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || null;
  } catch {
    return null;
  }
}

export default function App() {
  const controllerRef = useRef(null);
  if (!controllerRef.current) controllerRef.current = createAppController();
  const controller = controllerRef.current;

  const [screen, setScreen] = useState("home"); // home | setup | capture
  const [recording, setRecording] = useState(false); // ride in progress → lock nav
  const [routes, setRoutes] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(null);
  const [progress, setProgress] = useState({ done: 0, total: 0 });
  const [activeRouteId, setActiveRouteId] = useState(null);
  const activeRouteIdRef = useRef(null);
  useEffect(() => { activeRouteIdRef.current = activeRouteId; }, [activeRouteId]);
  const [showHelp, setShowHelp] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [displayUnits, setDisplayUnits] = useState(DEFAULT_UNITS);
  const [nowTick, setNowTick] = useState(Date.now()); // drives the Plan day strip; bumped on midnight rollover
  const [forecastGen, setForecastGen] = useState(0); // bumped whenever routes/forecasts refresh, so Plan recomputes in place

  // First launch (helpSeen unset) → show the welcome/help panel once.
  useEffect(() => {
    controller.store.getSetting("helpSeen", false).then((seen) => {
      if (!seen) setShowHelp(true);
    });
  }, [controller]);

  // Load display-unit preferences at startup and prime the format seam so every
  // formatter reflects them immediately (option B: module-level snapshot).
  useEffect(() => {
    controller.store.getSetting("displayUnits", null).then((u) => {
      const merged = { ...DEFAULT_UNITS, ...(u || {}) };
      setFormatSettings(merged);
      setDisplayUnits(merged);
    });
  }, [controller]);

  // Persist a display-unit change and re-prime the seam.
  const changeUnits = useCallback(async (next) => {
    const merged = { ...DEFAULT_UNITS, ...next };
    setFormatSettings(merged);
    setDisplayUnits(merged);
    setForecastGen((g) => g + 1); // nudge a re-render so visible values reformat
    await controller.store.setSetting("displayUnits", merged);
  }, [controller]);

  const acceptHelp = useCallback(async () => {
    setShowHelp(false);
    await controller.store.setSetting("helpSeen", true);
  }, [controller]);

  const refresh = useCallback(async (opts = {}) => {
    if (!opts.quiet) { setLoading(true); setProgress({ done: 0, total: 0 }); setLoadError(null); }
    try {
      const list = await controller.listRoutesWithVerdict(
        opts.quiet ? undefined : (done, total) => setProgress({ done, total })
      );
      setRoutes(list);
      // Auto-select on first load, AND re-point if the current selection is no
      // longer in the list — e.g. after deleting the last real route, the list
      // becomes just the example, so the stale id must hand off to it without a
      // restart.
      const cur = activeRouteIdRef.current;
      const stillPresent = cur && list.some((r) => r.route.id === cur);
      if (!stillPresent && list[0]) setActiveRouteId(list[0].route.id);
      // Signal the Plan tab to recompute the displayed ride against fresh data,
      // preserving its day/route/explored-time selection.
      setForecastGen((g) => g + 1);
    } catch (e) {
      // A forecast fetch can fail (offline, API outage). Never leave the loader
      // hanging — surface it and let the user retry. A quiet background refresh
      // fails silently, keeping whatever is already on screen.
      if (!opts.quiet) setLoadError(e && e.message ? e.message : "Couldn’t reach the forecast.");
    } finally {
      if (!opts.quiet) setLoading(false);
    }
  }, [controller]);

  useEffect(() => {
    controller.start();
    refresh();

    // Keep a long-open session fresh: recompute the verdict periodically and on
    // regaining focus. The forecast fetch itself is throttled by the cache TTL,
    // so frequent recompute is cheap and only re-fetches when data is stale.
    // This also handles midnight rollover (the day strip advancing) since the
    // Plan tab recomputes against the new day on each refresh.
    let lastDay = new Date().getDate();
    const tick = () => {
      if (document.visibilityState !== "visible") return;
      refresh({ quiet: true });
    };
    const interval = setInterval(tick, 15 * 60 * 1000); // every 15 min while visible

    // A faster check purely for day rollover, so the screen flips to the next
    // ride promptly after midnight without waiting for the 15-min tick.
    const dayCheck = setInterval(() => {
      const d = new Date().getDate();
      if (d !== lastDay) { lastDay = d; setNowTick(Date.now()); if (document.visibilityState === "visible") refresh({ quiet: true }); }
    }, 60 * 1000); // once a minute, near-free (no fetch unless verdict changes)

    const onVisible = () => { if (document.visibilityState === "visible") refresh({ quiet: true }); };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", onVisible);

    return () => {
      clearInterval(interval);
      clearInterval(dayCheck);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", onVisible);
    };
  }, []); // eslint-disable-line

  const active = routes.find((r) => r.route.id === activeRouteId) || routes[0];

  return (
    <div style={{
      maxWidth: 430, margin: "0 auto", height: "100dvh", position: "relative",
      fontFamily: "'Spline Sans', system-ui, sans-serif", background: "#111",
      display: "flex", flexDirection: "column", overflow: "hidden",
      boxShadow: "0 0 60px rgba(0,0,0,0.4)",
    }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,500;9..144,600&family=Spline+Sans:wght@400;500;600&display=swap');
        @keyframes drift { from { transform: translateX(0);} to { transform: translateX(160vw);} }
        @keyframes rise { from { opacity:0; transform: translateY(16px);} to {opacity:1; transform:none;} }
        @keyframes slidedown { from { transform: translateY(-100%);} to { transform: none;} }
        * { box-sizing: border-box; -webkit-tap-highlight-color: transparent; }
        input::placeholder { color: rgba(255,255,255,0.3);} input { color-scheme: dark; }
      `}</style>

      <div style={{ flex: 1, overflow: "hidden", position: "relative" }}>
        <ScreenBoundary resetKey={screen}>
        {loading ? (
          <Loading progress={progress} />
        ) : loadError && screen === "home" ? (
          <LoadErrorScreen message={loadError} onRetry={() => refresh()} />
        ) : screen === "home" ? (
          <Home controller={controller} activeRouteId={activeRouteId} routes={routes}
            setActiveRouteId={setActiveRouteId} nowMs={nowTick} forecastGen={forecastGen} />
        ) : screen === "routes" ? (
          <Routes
            controller={controller}
            routes={routes}
            onChanged={refresh}
            onAddNew={() => setScreen("setup")}
            onHelp={() => setShowHelp(true)}
            onSettings={() => setShowSettings(true)}
          />
        ) : screen === "setup" ? (
          <Setup controller={controller}
            onDone={async () => { await refresh(); setScreen("routes"); }}
            onCancel={() => setScreen("routes")} />
        ) : (
          <Capture controller={controller} route={active?.route}
            onRecordingChange={setRecording}
            onDone={async () => { await refresh(); setScreen("home"); }} />
        )}
        </ScreenBoundary>
      </div>

      {!recording && <TabBar screen={screen} setScreen={setScreen} hasRoutes={routes.length > 0} />}

      {showHelp && <HelpPanel onClose={acceptHelp} />}
      {showSettings && <SettingsPanel units={displayUnits} onChange={changeUnits} onClose={() => setShowSettings(false)} />}
    </div>
  );
}

/* ============================================================================
 * Home — verdict for the active route
 * ========================================================================== */
function Home({ controller, activeRouteId, routes, setActiveRouteId, nowMs, forecastGen }) {
  const [showDebug, setShowDebug] = useState(false);
  // start of today (local) — the strip is today + next 6 days, today pinned left
  const startOfToday = (() => { const d = new Date(nowMs); d.setHours(0, 0, 0, 0); return d.getTime(); })();
  const [selectedDayMs, setSelectedDayMs] = useState(startOfToday);
  const [dayVerdict, setDayVerdict] = useState(null);
  const [fetching, setFetching] = useState(false);
  // Explore: per-(route, day) what-if time overrides, held in session only.
  // Key "routeId:dayMs" → "HH:MM". Never persisted; survives background refresh
  // and route/day switches, cleared only on full reload.
  const [explored, setExplored] = useState({});
  const [showExplore, setShowExplore] = useState(false);

  const exploreKey = `${activeRouteId}:${selectedDayMs}`;
  // An override is either null, a plain "HH:MM" (respects the route's mode), or
  // { hhmm, depart:true } for a "Go now" instance that forces depart mode.
  const exploredEntry = explored[exploreKey] || null;
  const exploredHHMM = exploredEntry ? (exploredEntry.hhmm ?? exploredEntry) : null;
  const exploredDepart = !!(exploredEntry && exploredEntry.depart);

  // If the calendar day rolls over (midnight) and the selection was an old
  // "today", snap it forward so the strip and selection stay coherent.
  useEffect(() => {
    if (selectedDayMs < startOfToday) setSelectedDayMs(startOfToday);
  }, [startOfToday, selectedDayMs]);

  // Fetch the verdict for the selected route + day + any explored time.
  // Re-fires on forecastGen so a background refresh updates the displayed ride
  // in place, preserving the explore override and the day/route selection.
  useEffect(() => {
    let alive = true;
    if (!activeRouteId) { setDayVerdict(null); return; }
    setFetching(true);
    controller.getHomeVerdict(activeRouteId, selectedDayMs, exploredHHMM, exploredDepart).then((v) => {
      if (alive) { setDayVerdict(v); setFetching(false); }
    });
    return () => { alive = false; };
  }, [controller, activeRouteId, selectedDayMs, exploredHHMM, exploredDepart, forecastGen]);

  const activeRoute = routes.find((r) => r.route.id === activeRouteId)?.route
    || (routes[0] && routes[0].route);
  if (!activeRoute) return <Empty />;

  // Build the day strip: today + next 6 days. Tag each with whether it's one of
  // the route's active days (for a subtle de-emphasis; still tappable).
  const DOW_CODES = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"];
  const activeDays = activeRoute.activeDays || [];
  const days = [];
  for (let i = 0; i < 7; i++) {
    const ms = startOfToday + i * 86400e3;
    const d = new Date(ms);
    days.push({
      ms,
      label: i === 0 ? "Today" : WEEKDAY_NAMES[d.getDay()].slice(0, 3),
      isToday: i === 0,
      active: activeDays.includes(DOW_CODES[d.getDay()]),
    });
  }

  const verdict = dayVerdict && dayVerdict.verdict;
  const accent = verdict ? ACCENT[verdict.verdict] : ACCENT.normal;
  const sky = verdict
    ? skyForRide(activeRoute.startRegion, verdict.departureMs, verdict.predictedSec)
    : SKY.predawn;

  // The route's configured time for the selected day (per-weekday override, else
  // the default). Used so an explored time equal to the default counts as none.
  const WD = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"];
  const dayCode = WD[new Date(selectedDayMs).getDay()];
  const defaultHHMM =
    (activeRoute.arrivalOverrides && activeRoute.arrivalOverrides[dayCode]) ||
    activeRoute.targetArrival;
  const applyExplore = (hhmm) => {
    setExplored((m) => {
      const n = { ...m };
      if (!hhmm || hhmm === defaultHHMM) delete n[exploreKey]; // same as default → no override
      else n[exploreKey] = hhmm; // plain time: respects the route's own mode
      return n;
    });
    setShowExplore(false);
  };
  // "Go now": treat this instance as a DEPARTURE at the current clock time,
  // regardless of the route's configured mode. Today only. Frozen at the time
  // tapped, persisted in the day's cell like any explore override.
  const isToday = selectedDayMs === startOfToday;
  const goNow = () => {
    const d = new Date();
    const hhmm = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
    setExplored((m) => ({ ...m, [exploreKey]: { hhmm, depart: true } }));
    setShowExplore(false);
  };

  return (
    <div style={{
      position: "relative", height: "100%",
      background: `linear-gradient(165deg, ${sky[0]}, ${sky[1]} 55%, ${sky[2]})`,
      transition: "background 1.2s ease", display: "flex", flexDirection: "column",
    }}>
      {verdict && <WindField verdict={verdict.verdict} accent={accent} />}

      {/* Header: route selector pills (if >1) handled below; title + day strip */}
      <div style={{ position: "relative", zIndex: 2, padding: "calc(22px + env(safe-area-inset-top)) 16px 0" }}>
        {activeRoute.isExample && (
          <div style={{
            margin: "0 8px 10px", padding: "8px 12px", borderRadius: 10,
            background: "rgba(224,164,94,0.16)", border: "1px solid rgba(224,164,94,0.32)",
            fontSize: 12.5, color: "#f0d8a8", lineHeight: 1.45,
          }}>
            <b>Example route.</b> This is a demo so you can see how it works — add your own route to get started.
          </div>
        )}
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", padding: "0 8px 12px" }}>
          <span style={{ fontFamily: "'Fraunces', serif", fontSize: 19, fontWeight: 600, color: "rgba(255,255,255,0.95)" }}>Plan</span>
          <span style={{ fontSize: 12.5, color: "rgba(255,255,255,0.6)" }}>{activeRoute.name}</span>
        </div>
        {/* Day strip */}
        <div style={{ display: "flex", gap: 5 }}>
          {days.map((d) => {
            const selected = d.ms === selectedDayMs;
            return (
              <button key={d.ms} onClick={() => setSelectedDayMs(d.ms)} style={{
                flex: 1, minWidth: 0, padding: "8px 2px", borderRadius: 10, cursor: "pointer",
                fontFamily: "inherit", fontSize: 12, fontWeight: selected ? 600 : 400,
                border: d.isToday ? "1px solid rgba(255,255,255,0.55)" : "1px solid transparent",
                background: selected ? "#e0a45e" : "rgba(255,255,255,0.1)",
                color: selected ? "#1a1f3a" : "rgba(255,255,255,0.8)",
                // Subtle de-emphasis for days the route isn't normally ridden;
                // still fully tappable.
                opacity: selected || d.active ? 1 : 0.45,
              }}>{d.label}</button>
            );
          })}
        </div>
        {/* Route selector (if more than one route) */}
        {routes.length > 1 && (
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 8 }}>
            {routes.map((r) => (
              <button key={r.route.id} onClick={() => setActiveRouteId(r.route.id)} style={{
                flex: "1 1 calc(33.333% - 4px)", minWidth: 70, padding: "7px 4px", borderRadius: 10, border: "none", cursor: "pointer",
                fontFamily: "inherit", fontSize: 11.5, fontWeight: 600,
                background: r.route.id === activeRoute.id ? "rgba(255,255,255,0.22)" : "rgba(0,0,0,0.18)",
                color: r.route.id === activeRoute.id ? "#fff" : "rgba(255,255,255,0.6)",
              }}>{r.route.name.split(" ")[0]}</button>
            ))}
          </div>
        )}
      </div>

      <PlanBody verdict={verdict} dayVerdict={dayVerdict} fetching={fetching}
        routeLon={activeRoute.startRegion ? activeRoute.startRegion.lon : undefined}
        accent={accent} showDebug={showDebug} setShowDebug={setShowDebug}
        timeMode={activeRoute.timeMode === "depart" ? "depart" : "arrive"}
        exploredHHMM={exploredHHMM} canGoNow={isToday}
        showExplore={showExplore} setShowExplore={setShowExplore}
        onExplore={applyExplore} onGoNow={goNow}
        onRestore={() => { setExplored((m) => { const n = { ...m }; delete n[exploreKey]; return n; }); setShowExplore(false); }}
      />
    </div>
  );
}

/* Mode-aware time picker for Explore: enter an arrival (arrive routes) or a
 * departure (depart routes) for the selected day; apply or restore default. */
function ExplorePicker({ timeMode, current, hasOverride, canGoNow, onApply, onGoNow, onRestore, onCancel }) {
  const [t, setT] = useState(current);
  const label = timeMode === "depart" ? "Depart at" : "Arrive by";
  return (
    <div style={{
      margin: "2px 0 10px", padding: "12px 14px", borderRadius: 14,
      background: "rgba(0,0,0,0.28)", border: "1px solid rgba(255,255,255,0.16)",
    }}>
      <div style={{ fontSize: 12.5, color: "rgba(255,255,255,0.7)", marginBottom: 8 }}>
        See this ride at a different time — {label.toLowerCase()}:
      </div>
      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
        <TimeField value={t} onChange={setT} style={{ flex: 1 }} />
        <button onClick={() => t && onApply(t)} style={{
          padding: "10px 16px", borderRadius: 10, border: "none", cursor: "pointer",
          fontFamily: "inherit", fontSize: 14, fontWeight: 600, background: "#e0a45e", color: "#1a1f3a",
        }}>Show</button>
      </div>
      {canGoNow && (
        <button onClick={onGoNow} style={{
          marginTop: 10, width: "100%", padding: "11px 12px", borderRadius: 10, border: "none", cursor: "pointer",
          fontFamily: "'Fraunces', serif", fontSize: 15, fontWeight: 600, background: "#6fd49a", color: "#0f2a1c",
          display: "inline-flex", alignItems: "center", justifyContent: "center", gap: 7,
        }}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>
          Go now
        </button>
      )}
      <div style={{ fontSize: 11, color: "rgba(255,255,255,0.45)", marginTop: canGoNow ? 6 : 0, lineHeight: 1.4 }}>
        {canGoNow ? "“Go now” shows the ride leaving at the current time." : ""}
      </div>
      <div style={{ display: "flex", gap: 14, marginTop: 10 }}>
        {hasOverride && (
          <button onClick={onRestore} style={{ border: "none", background: "none", cursor: "pointer", fontFamily: "inherit", fontSize: 12.5, color: "#f0c08c", padding: 0 }}>
            Restore default time
          </button>
        )}
        <button onClick={onCancel} style={{ border: "none", background: "none", cursor: "pointer", fontFamily: "inherit", fontSize: 12.5, color: "rgba(255,255,255,0.55)", padding: 0 }}>
          Cancel
        </button>
      </div>
    </div>
  );
}

/* Plan detail body for the selected route+day (the former Home centre block). */
function PlanBody({ verdict, dayVerdict, fetching, routeLon, accent, showDebug, setShowDebug,
  timeMode, exploredHHMM, canGoNow, showExplore, setShowExplore, onExplore, onGoNow, onRestore }) {
  // Per-minute tick so the live countdown beside the time stays current without
  // depending on forecast refreshes. Declared before any early return (hooks).
  const [nowMs, setNowMs] = useState(Date.now());
  useEffect(() => {
    const id = setInterval(() => setNowMs(Date.now()), 30 * 1000);
    return () => clearInterval(id);
  }, []);
  if (fetching && !verdict) {
    return <div style={{ flex: 1, display: "grid", placeItems: "center", color: "rgba(255,255,255,0.5)", fontSize: 14 }}>Checking the forecast…</div>;
  }
  if (!verdict) {
    return <div style={{ flex: 1, display: "grid", placeItems: "center", color: "rgba(255,255,255,0.5)", fontSize: 14, padding: 24, textAlign: "center" }}>No forecast for this day yet — it's beyond the forecast horizon.</div>;
  }
  const { range, conservative, windEffect, rangeUnavailable, confidence, expect, debug } = dayVerdict;
  const isDepart = conservative && conservative.mode === "depart";
  // "Leave early / Usual time / Leave late" (an instruction to shift departure)
  // applies ONLY to an arrival-anchored route shown at its real scheduled time.
  // For departure-based routes, or any explored/custom time, the useful framing
  // is how the ride compares: Slow / Usual speed / Fast.
  const useAction = !isDepart && !exploredHHMM;
  const headline = useAction
    ? { headwind: "Leave early", tailwind: "Leave late", normal: "Usual time" }[verdict.verdict]
    : { headwind: "Slow", tailwind: "Fast", normal: "Usual speed" }[verdict.verdict];
  const hasWindow = conservative && conservative.windowMin >= 2;
  // Countdown targets the displayed leave-by/leave-at time (which already
  // reflects any explored/custom time). Shown only within −2h…+1h.
  const countdown = countdownPhrase(verdict.departureMs, nowMs);

  return (
    <div style={{ position: "relative", zIndex: 2, flex: 1, display: "flex", flexDirection: "column", justifyContent: "space-between", padding: "18px 24px 16px", overflowY: "auto" }}>
      <div style={{ animation: "rise 0.5s both" }}>
        <div style={{ fontFamily: "'Fraunces', serif", fontWeight: 600, fontSize: "clamp(34px,9vw,50px)", lineHeight: 1.03, color: "#fff", letterSpacing: "-0.03em" }}>
          {headline}
        </div>
        <div style={{ marginTop: 22 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 4 }}>
            <span style={{ fontSize: 13, color: "rgba(255,255,255,0.6)" }}>{isDepart ? "Leave at" : "Leave by"}</span>
            <button onClick={() => setShowExplore((v) => !v)} title="Explore a different time" style={{
              border: "none", cursor: "pointer", padding: "4px 8px", borderRadius: 8, fontFamily: "inherit", fontSize: 12, fontWeight: 600,
              background: exploredHHMM ? "#e0a45e" : "rgba(255,255,255,0.12)",
              color: exploredHHMM ? "#1a1f3a" : "rgba(255,255,255,0.8)",
              display: "inline-flex", alignItems: "center", gap: 5,
            }}>
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>
              {exploredHHMM ? `custom · ${isDepart ? "leave" : "arrive by"} ${formatClockString(exploredHHMM)}` : "Explore"}
            </button>
          </div>
          {showExplore && (
            <ExplorePicker timeMode={timeMode} current={exploredHHMM || verdict.arrivalHHMM}
              hasOverride={!!exploredHHMM} canGoNow={canGoNow}
              onApply={onExplore} onGoNow={onGoNow} onRestore={onRestore} onCancel={() => setShowExplore(false)} />
          )}
          <div style={{ display: "flex", alignItems: "baseline", gap: 12, flexWrap: "wrap" }}>
            <span style={{ fontFamily: "'Fraunces', serif", fontSize: 56, fontWeight: 600, lineHeight: 1, color: "#fff", fontVariantNumeric: "tabular-nums" }}>
              {verdict.departureHHMM}
            </span>
            {!isDepart && verdict.verdict !== "normal" && (
              <span style={{ fontSize: 15, color: "rgba(255,255,255,0.55)", textDecoration: "line-through" }}>{verdict.normalDepartureHHMM}</span>
            )}
            {countdown && (
              <span style={{ fontSize: 15, fontWeight: 600, color: countdown === "now" ? "#6fd49a" : "#e0a45e" }}>{countdown}</span>
            )}
          </div>
          <div style={{ fontSize: 14, color: "rgba(255,255,255,0.7)", marginTop: 10 }}>
            {!conservative
              ? <>to arrive {verdict.arrivalHHMM} {dayLabel(verdict.arrivalMs)}</>
              : isDepart
              ? (hasWindow
                  ? <>arrive between {conservative.earliestArrivalHHMM} and {conservative.latestArrivalHHMM} {dayLabel(conservative.latestArrivalMs)}</>
                  : <>arrive around {conservative.earliestArrivalHHMM} {dayLabel(conservative.earliestArrivalMs)}</>)
              : (hasWindow
                  ? <>to arrive between {conservative.earliestArrivalHHMM} and {conservative.latestArrivalHHMM} {dayLabel(conservative.latestArrivalMs)}</>
                  : <>to arrive {verdict.arrivalHHMM} {dayLabel(verdict.arrivalMs)}</>)}
          </div>
          {(() => {
            const tz = phoneTimezoneHint(routeLon);
            return tz ? (
              <div style={{ fontSize: 12, color: "rgba(255,255,255,0.5)", marginTop: 6 }}>
                Times in your phone's timezone: {tz}
              </div>
            ) : null;
          })()}
          {windEffect && (
            <div style={{ fontSize: 13.5, color: "rgba(255,255,255,0.6)", marginTop: 6 }}>
              {windEffectPhrase(windEffect, verdict.verdict === "normal")}
            </div>
          )}
          {rangeUnavailable && (
            <div style={{ fontSize: 12.5, color: "rgba(255,255,255,0.45)", marginTop: 6, fontStyle: "italic" }}>
              forecast range unavailable — showing best estimate
            </div>
          )}
          {expect && expect.line && (
            <div onClick={() => setShowDebug((v) => !v)} style={{ fontSize: 13.5, color: "rgba(255,255,255,0.6)", marginTop: 8, letterSpacing: "0.01em", cursor: "pointer" }}>
              {expect.line}
            </div>
          )}
          {showDebug && debug && <DebugReadout debug={debug} />}
        </div>
      </div>

      <div style={{
        position: "relative", zIndex: 2, marginTop: 20, padding: "14px 16px", borderRadius: 18,
        background: "rgba(255,255,255,0.1)", backdropFilter: "blur(14px)", border: "1px solid rgba(255,255,255,0.16)",
      }}>
        <RowLine label="Still-air baseline" value={fmtMin(verdict.baselineSec)} />
        <RowLine label="Wind allowance" value={`${verdict.deltaMin > 0 ? "+" : verdict.deltaMin < 0 ? "−" : ""}${formatElapsed(Math.abs(verdict.deltaMin) * 60)}`} color={accent} />
        <div style={{ marginTop: 10, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <ConfidenceDots confidence={confidence} />
          {verdict.kHead != null && verdict.kTail != null ? (
            Math.abs(verdict.kHead - verdict.kTail) < 0.005 ? (
              <span style={{ fontSize: 12, color: "rgba(255,255,255,0.5)" }}>k {kPct(verdict.kHead)}</span>
            ) : (
              <span style={{ fontSize: 12, color: "rgba(255,255,255,0.5)" }}>
                {/* headwind slows you → down arrow; tailwind speeds you → up arrow */}
                k <span style={{ color: verdict.windFactor >= 0 ? "#fff" : "rgba(255,255,255,0.5)", fontWeight: verdict.windFactor >= 0 ? 600 : 400 }}>↓{kPct(verdict.kHead)}</span>
                {" / "}
                <span style={{ color: verdict.windFactor < 0 ? "#fff" : "rgba(255,255,255,0.5)", fontWeight: verdict.windFactor < 0 ? 600 : 400 }}>↑{kPct(verdict.kTail)}</span>
              </span>
            )
          ) : (
            <span style={{ fontSize: 12, color: "rgba(255,255,255,0.5)" }}>k = {verdict.k?.toFixed(2) ?? "—"}</span>
          )}
        </div>
      </div>
    </div>
  );
}

/* Tech info panel for the Plan detail — a tidy, labelled readout of the
 * forecast figures behind the prediction. */
function DebugReadout({ debug }) {
  const fmtClock = (ms) => (ms == null ? "—" : formatTimeOfDay(ms));
  const Row = ({ label, children }) => (
    <div style={{ display: "flex", justifyContent: "space-between", gap: 12, padding: "3px 0" }}>
      <span style={{ color: "rgba(255,255,255,0.5)" }}>{label}</span>
      <span style={{ color: "rgba(255,255,255,0.9)", textAlign: "right" }}>{children}</span>
    </div>
  );
  return (
    <div style={{
      marginTop: 10, borderRadius: 12, overflow: "hidden",
      fontSize: 12.5, lineHeight: 1.5,
      background: "rgba(0,0,0,0.25)", border: "1px solid rgba(255,255,255,0.1)",
    }}>
      <div style={{ fontSize: 10.5, letterSpacing: "0.08em", textTransform: "uppercase", color: "rgba(255,255,255,0.4)", padding: "8px 12px 0", fontFamily: "inherit" }}>
        Tech info
      </div>
      {/* Highlighted top line: wind speed + two-letter direction + bearing */}
      <div style={{
        margin: "6px 12px 4px", padding: "8px 10px", borderRadius: 8,
        background: "rgba(224,164,94,0.14)", border: "1px solid rgba(224,164,94,0.3)",
        color: "#f0d8a8", fontWeight: 600,
      }}>
        wind: {formatWindSpeed(debug.windSpeedKmh)} {debug.windFromLabel} ({debug.windFromDeg}°)
      </div>
      <div style={{ padding: "2px 12px 10px" }}>
        <Row label="route avg bearing">{debug.avgBearingDeg}°</Row>
        <Row label="mean headwind">{formatWindSpeed(debug.meanHeadwindKmh)} ({debug.meanHeadwindKmh >= 0 ? "head" : "tail"})</Row>
        {debug.effortHeadwindKmh != null && (
          <Row label="equivalent wind">{formatWindSpeed(debug.effortHeadwindKmh)}</Row>
        )}
        {debug.effortHeadwindKmh != null && (
          <div style={{ fontSize: 10.5, color: "rgba(255,255,255,0.4)", lineHeight: 1.45, padding: "0 0 4px" }}>
            The single steady wind that would cost the same time as the actual wind. Headwinds cost more than tailwinds save, so this is different from the mean.
          </div>
        )}
        <Row label="mean crosswind">{formatWindSpeed(debug.meanCrosswindKmh)}</Row>
        <Row label="wind factor">{debug.windFactor} ({debug.windFactor >= 0 ? "slows" : "speeds"})</Row>
        <div style={{ height: 1, background: "rgba(255,255,255,0.08)", margin: "6px 0" }} />
        <Row label="wind tuning">
          {debug.kIdHead && debug.kIdTail ? "head & tail learned"
            : debug.kIdHead ? "head learned, tail manual"
            : debug.kIdTail ? "tail learned, head manual"
            : "manual (not enough windy rides yet)"}
        </Row>
        <Row label="forecast updated">{fmtClock(debug.forecastUpdatedMs)}</Row>
        <Row label="next update">{fmtClock(debug.forecastNextUpdateMs)}</Row>
        {(debug.rainPeakRateMmH != null || debug.rainTotalMm != null) && (
          <>
            <div style={{ height: 1, background: "rgba(255,255,255,0.08)", margin: "6px 0" }} />
            <Row label="rain peak rate · total">{debug.rainPeakRateMmH != null ? `${formatRainfall(debug.rainPeakRateMmH, undefined, { rate: true })} · ${formatRainfall(debug.rainTotalMm)}` : "—"}</Row>
            <Row label="rain max prob">{debug.rainMaxProbPct != null ? `${debug.rainMaxProbPct}%` : "—"}</Row>
            <Row label="wettest forecast">{debug.rainWettestPeakMmH != null ? `${formatRainfall(debug.rainWettestPeakMmH, undefined, { rate: true })} · ${formatRainfall(debug.rainWettestTotalMm)}` : "—"}</Row>
            <div style={{ fontSize: 10.5, color: "rgba(255,255,255,0.4)", lineHeight: 1.45, padding: "2px 0 0" }}>
              bands — rate: {RAIN_RATE_BANDS.map((b) => rainfallValue(b)).join(" / ")} {rainfallUnitLabel(undefined, { rate: true })} · total: {RAIN_TOTAL_BANDS.map((b) => rainfallValue(b)).join(" / ")} {rainfallUnitLabel()} (a little / wet / very).
            </div>
          </>
        )}
      </div>
    </div>
  );
}

/* ============================================================================
 * Routes — list, edit, delete existing routes + backup (export/import)
 * ========================================================================== */
const DAY_CODES = [["MO", "M"], ["TU", "T"], ["WE", "W"], ["TH", "T"], ["FR", "F"], ["SA", "S"], ["SU", "S"]];

function Routes({ controller, routes, onChanged, onAddNew, onHelp, onSettings }) {
  const [editing, setEditing] = useState(null); // route id being edited
  const [conservatism, setConservatism] = useState(75); // % uncertainty allowance (5% steps)
  const fileRef = useRef();

  // Drag-to-reorder: keep a local id order so the list rearranges live while
  // dragging; persist on drop. Synced to props whenever the route set changes.
  const [order, setOrder] = useState(() => routes.map((r) => r.route.id));
  const [dragId, setDragId] = useState(null);
  const dragRef = useRef({ id: null, y: 0 });
  useEffect(() => {
    // Re-sync when routes are added/removed (not on every render).
    const ids = routes.map((r) => r.route.id);
    setOrder((prev) => {
      const same = prev.length === ids.length && prev.every((p) => ids.includes(p));
      return same ? prev : ids;
    });
  }, [routes]);

  const byId = new Map(routes.map((r) => [r.route.id, r]));
  const orderedRoutes = order.map((id) => byId.get(id)).filter(Boolean);
  const isExampleList = routes.length === 1 && routes[0].route.isExample;
  const canReorder = routes.length > 1 && !isExampleList;

  const onHandleDown = (id) => (e) => {
    e.stopPropagation();
    dragRef.current = { id, y: e.clientY };
    setDragId(id);
  };
  const onPointerMove = (e) => {
    const d = dragRef.current;
    if (!d.id) return;
    const cards = Array.from(e.currentTarget.querySelectorAll("[data-route-card]"));
    const overEl = cards.find((c) => {
      const r = c.getBoundingClientRect();
      return e.clientY >= r.top && e.clientY <= r.bottom;
    });
    if (!overEl) return;
    const overId = overEl.getAttribute("data-route-card");
    if (overId === d.id) return;
    setOrder((prev) => {
      const from = prev.indexOf(d.id), to = prev.indexOf(overId);
      if (from < 0 || to < 0) return prev;
      const next = prev.slice();
      next.splice(to, 0, next.splice(from, 1)[0]);
      return next;
    });
  };
  const endDrag = async () => {
    const d = dragRef.current;
    dragRef.current = { id: null, y: 0 };
    if (!d.id) return;
    setDragId(null);
    await controller.reorderRoutes(order);
    await onChanged();
  };

  useEffect(() => {
    let alive = true;
    controller.store.getSetting("conservatismPct", 87).then((v) => {
      if (alive && v != null) setConservatism(Math.round(pctToSlider(Number(v)) / 5) * 5);
    });
    return () => { alive = false; };
  }, [controller]);

  // The slider speaks 0–100% ("how much of the forecast margin to apply"); the
  // model wants a percentile in 50–99 (50 = median, no margin; 99 = most
  // cautious). Map linearly between the two.
  const saveConservatism = async (sliderVal) => {
    const s = Math.max(0, Math.min(100, Math.round(Number(sliderVal) || 0)));
    setConservatism(s);
    await controller.store.setSetting("conservatismPct", sliderToPct(s));
    await onChanged();
  };

  const doExport = async () => {
    const bundle = await controller.exportAll();
    const blob = new Blob([JSON.stringify(bundle, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `ride-the-wind-backup-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };
  const doImport = async (file) => {
    try {
      const bundle = JSON.parse(await file.text());
      await controller.importAll(bundle, "replace");
      await onChanged();
    } catch (e) { alert("Couldn't import that file: " + e.message); }
  };

  return (
    <div style={{ height: "100%", overflowY: "auto", background: "linear-gradient(165deg,#12152b,#1d1b38 55%,#281f44)", color: "#fff", paddingBottom: 30 }}>
      <div style={{ padding: "26px 22px 4px", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <span style={{ fontFamily: "'Fraunces',serif", fontSize: 26, fontWeight: 600 }}>Routes</span>
        <button onClick={onAddNew} style={{
          padding: "9px 16px", borderRadius: 100, border: "none", cursor: "pointer",
          fontFamily: "'Fraunces',serif", fontSize: 14, fontWeight: 600, background: "#e0a45e", color: "#1a1f3a",
        }}>+ New</button>
      </div>
      <div style={{ padding: "0 22px 16px", fontSize: 13.5, color: "rgba(255,255,255,0.55)" }}>
        Each destination needs two routes, one going and one returning.
      </div>

      <div style={{ margin: "0 22px 18px", padding: "12px 14px", borderRadius: 14, background: "rgba(255,255,255,0.06)" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <span style={{ fontSize: 14 }}>Uncertainty allowance</span>
          <span style={{ fontFamily: "ui-monospace,monospace", fontSize: 14, color: "#e0a45e" }}>{conservatism}%</span>
        </div>
        <input type="range" min={0} max={100} step={5} value={conservatism}
          onChange={(e) => setConservatism(Number(e.target.value))}
          onMouseUp={(e) => saveConservatism(e.target.value)}
          onTouchEnd={(e) => saveConservatism(e.target.value)}
          style={{ width: "100%", marginTop: 8, accentColor: "#e0a45e" }} />
        <div style={{ fontSize: 12, color: "rgba(255,255,255,0.5)", marginTop: 4, lineHeight: 1.4 }}>
          Ride the Wind uses multiple forecast models to calculate a spread of forecast wind speeds. Your uncertainty allowance controls how much of that spread is applied to your ride times. Higher will have you leave earlier to be more likely on time.
        </div>
      </div>

      {routes.length === 0 ? (
        <div style={{ padding: "40px 22px", textAlign: "center", color: "rgba(255,255,255,0.55)" }}>
          No routes yet. Tap <b style={{ color: "#e0a45e" }}>+ New</b> to add one from a GPX file.
        </div>
      ) : (
        <div style={{ padding: "0 16px" }}
          onPointerMove={canReorder ? onPointerMove : undefined}
          onPointerUp={canReorder ? endDrag : undefined}
          onPointerCancel={canReorder ? endDrag : undefined}>
          {orderedRoutes.map(({ route, verdict, confidence }) => (
            <div key={route.id} data-route-card={route.id} style={{
              marginBottom: 12, borderRadius: 16, overflow: "hidden",
              background: "rgba(255,255,255,0.07)", border: "1px solid rgba(255,255,255,0.14)",
              opacity: dragId === route.id ? 0.5 : 1,
              boxShadow: dragId === route.id ? "0 6px 20px rgba(0,0,0,0.4)" : "none",
              touchAction: dragId ? "none" : "auto",
            }}>
              <div style={{ display: "flex", alignItems: "stretch" }}>
                {canReorder && (
                  <div onPointerDown={onHandleDown(route.id)} title="Drag to reorder" style={{
                    display: "flex", alignItems: "center", justifyContent: "center",
                    padding: "0 12px", cursor: "grab", touchAction: "none",
                    color: "rgba(255,255,255,0.35)", fontSize: 18, userSelect: "none",
                  }}>⋮⋮</div>
                )}
                <div onClick={() => setEditing(editing === route.id ? null : route.id)} style={{ flex: 1, padding: canReorder ? "14px 16px 14px 0" : "14px 16px", cursor: "pointer" }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
                    <span style={{ fontFamily: "'Fraunces',serif", fontSize: 18, fontWeight: 600 }}>{route.name}</span>
                    <span style={{ fontSize: 12.5, color: "rgba(255,255,255,0.5)" }}>
                      {formatDistance(route.totalDistance / 1000)}
                    </span>
                  </div>
                  <div style={{ display: "flex", gap: 12, marginTop: 6, fontSize: 12.5, color: "rgba(255,255,255,0.6)" }}>
                    <span>{route.timeMode === "depart" ? "depart" : "arrive"} {formatClockString(route.targetArrival)}</span>
                    <span>·</span>
                    <span>{route.activeDays.length} days/wk</span>
                    <span>·</span>
                  <ConfidenceDots confidence={confidence} />
                </div>
                </div>
              </div>
              {editing === route.id && (
                <RouteEditor
                  route={route}
                  controller={controller}
                  onSaved={async () => { await onChanged({ quiet: true }); }}
                  onDeleted={async () => { setEditing(null); await onChanged(); }}
                />
              )}
            </div>
          ))}
        </div>
      )}

      {/* backup */}
      <div style={{ padding: "20px 22px 0" }}>
        <div style={{ fontSize: 13, color: "rgba(255,255,255,0.5)", marginBottom: 10 }}>Backup</div>
        <div style={{ display: "flex", gap: 10 }}>
          <button onClick={doExport} style={backupBtn}>Export data</button>
          <button onClick={() => fileRef.current.click()} style={backupBtn}>Import data</button>
          <input ref={fileRef} type="file" accept="application/json,.json" hidden
            onChange={(e) => e.target.files[0] && doImport(e.target.files[0])} />
        </div>
        <div style={{ fontSize: 11.5, color: "rgba(255,255,255,0.4)", marginTop: 8 }}>
          Your routes and rides live only on this device. Export regularly to keep a backup.
        </div>
      </div>

      <div style={{ padding: "22px 22px 0" }}>
        <div style={{ display: "flex", gap: 10 }}>
          <button onClick={onHelp} style={{ ...backupBtn }}>Help</button>
          <button onClick={onSettings} style={{ ...backupBtn }}>Settings</button>
        </div>
        <div style={{ fontSize: 11, color: "rgba(255,255,255,0.35)", marginTop: 14, lineHeight: 1.5, textAlign: "center" }}>
          Ride the Wind · free &amp; open source (MIT) · by Chris Hilder
        </div>
      </div>
    </div>
  );
}

/* ============================================================================
 * RouteMap — an interactive map of the route (Leaflet + OpenStreetMap tiles),
 * drawn as a polyline with start/end pins. Keyless. Leaflet is loaded from CDN
 * on first use. Needs a network connection for the tiles; on any failure
 * (offline, CDN/tiles unreachable) it falls back to a tidy note rather than a
 * blank box. The polyline is pre-downsampled by the controller.
 * ========================================================================== */
const LEAFLET_CSS = "https://unpkg.com/leaflet@1.9.4/dist/leaflet.css";
const LEAFLET_JS = "https://unpkg.com/leaflet@1.9.4/dist/leaflet.js";
let _leafletPromise = null;
function loadLeaflet() {
  if (typeof window !== "undefined" && window.L) return Promise.resolve(window.L);
  if (_leafletPromise) return _leafletPromise;
  _leafletPromise = new Promise((resolve, reject) => {
    if (!document.querySelector(`link[href="${LEAFLET_CSS}"]`)) {
      const link = document.createElement("link");
      link.rel = "stylesheet"; link.href = LEAFLET_CSS;
      document.head.appendChild(link);
    }
    const s = document.createElement("script");
    s.src = LEAFLET_JS; s.async = true;
    s.onload = () => resolve(window.L);
    s.onerror = () => reject(new Error("leaflet load failed"));
    document.head.appendChild(s);
  });
  return _leafletPromise;
}

function RouteMap({ polyline }) {
  const elRef = useRef(null);
  const mapRef = useRef(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!polyline || polyline.length < 2) return;
    let cancelled = false;
    loadLeaflet().then((L) => {
      if (cancelled || !elRef.current) return;
      // Guard against re-init on the same node.
      if (mapRef.current) { mapRef.current.remove(); mapRef.current = null; }
      const latlngs = polyline.map((p) => [p.lat, p.lon]);
      const map = L.map(elRef.current, {
        zoomControl: true, attributionControl: true, scrollWheelZoom: false,
      });
      mapRef.current = map;
      const tiles = L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
        maxZoom: 19, attribution: "© OpenStreetMap contributors",
      });
      tiles.addTo(map);
      const line = L.polyline(latlngs, { color: "#e0a45e", weight: 4, opacity: 0.95 }).addTo(map);
      const dot = (latlng, color) => L.circleMarker(latlng, { radius: 6, color: "#1a1f3a", weight: 2, fillColor: color, fillOpacity: 1 }).addTo(map);
      dot(latlngs[0], "#6fd49a");
      dot(latlngs[latlngs.length - 1], "#e0785e");
      map.fitBounds(line.getBounds(), { padding: [20, 20] });
    }).catch(() => { if (!cancelled) setFailed(true); });
    return () => {
      cancelled = true;
      if (mapRef.current) { mapRef.current.remove(); mapRef.current = null; }
    };
  }, [polyline]);

  if (!polyline || polyline.length < 2) return null;
  if (failed) {
    return (
      <div style={{
        borderRadius: 12, padding: "18px 14px", marginBottom: 12, textAlign: "center",
        background: "rgba(255,255,255,0.05)", border: "1px solid rgba(255,255,255,0.1)",
        fontSize: 12.5, color: "rgba(255,255,255,0.5)",
      }}>
        Map couldn’t load — distance and elevation are shown below.
      </div>
    );
  }
  return (
    <div ref={elRef} style={{
      height: 220, borderRadius: 12, overflow: "hidden", marginBottom: 12,
      border: "1px solid rgba(255,255,255,0.12)", background: "rgba(0,0,0,0.2)",
    }} />
  );
}

/* ============================================================================
 * TerrainControls — physically-meaningful manual tuning shared by Setup and
 * RouteEditor. Speed spinner + "Ground effect" slider(s) + split switch.
 * Maps to the existing seeds (no model change): baselineSec = D / speed;
 * head = baseline·(1+kHead), tail = baseline·(1−kTail).
 * ========================================================================== */
// v2 k semantics: fraction of the forecast wind felt on the route (surface =
// k × forecast). 0 = fully sheltered, 1 = full forecast wind at the nominal
// rider, up to 1.4 for exposed / wind-funnelling routes (forecast under-
// prediction on gullies, coastal gaps, ridgelines can push the felt wind above
// the model-cell forecast). Slider and the learned clamp share the 1.4 max.
const TERRAIN_MIN = 0.0, TERRAIN_MAX = 1.4;
const kClampUI = (k) => Math.max(TERRAIN_MIN, Math.min(TERRAIN_MAX, k));

/* Two-segment Manual | Learn pill. Compact, matches the day/time-mode buttons. */
function ModePill({ mode, onChange, disabled }) {
  const seg = (m, label) => (
    <button key={m} disabled={disabled} onClick={() => !disabled && onChange(m)} style={{
      padding: "3px 10px", borderRadius: 7, cursor: disabled ? "default" : "pointer",
      fontFamily: "inherit", fontSize: 11, fontWeight: 600, border: "none",
      background: mode === m ? "rgba(224,164,94,0.9)" : "transparent",
      color: mode === m ? "#1a1f3a" : "rgba(255,255,255,0.5)",
      opacity: disabled ? 0.5 : 1,
    }}>{label}</button>
  );
  return (
    <span style={{ display: "inline-flex", padding: 2, borderRadius: 9, background: "rgba(255,255,255,0.08)", border: "1px solid rgba(255,255,255,0.12)" }}>
      {seg("manual", "Manual")}{seg("learn", "Learn")}
    </span>
  );
}

/* ============================================================================
 * SettingsPanel — display units & formatting. Full-screen overlay (sibling to
 * HelpPanel). Each row is a labelled segmented control; a live preview line at
 * the top reflects the current (tentative) selection. Changes are applied live
 * via onChange (which persists + re-primes the format seam).
 * ========================================================================== */
function SettingsPanel({ units, onChange, onClose }) {
  const u = { ...DEFAULT_UNITS, ...(units || {}) };
  const set = (key, value) => onChange({ ...u, [key]: value });

  // Preview, split into two explicit lines. Order mirrors the controls below so
  // each sample maps to its toggle. Line 1: ride metrics; line 2: weather values.
  // Decimal separator has no sample of its own; it shows through every number.
  const previewLine1 = [
    formatElapsed(90 * 60, u),
    formatDistance(5.2, u),
    formatRideSpeed(24, u),
    formatWindSpeed(18, u),
  ].join("  ·  ");
  const previewLine2 = [
    formatTemperature(12, u),
    formatRainfall(1.2, u, { rate: true }),
  ].join("  ·  ");

  const label = { fontSize: 13.5, color: "rgba(255,255,255,0.8)", fontWeight: 600 };
  const row = { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, padding: "13px 0", borderBottom: "1px solid rgba(255,255,255,0.08)" };

  return (
    <div style={{
      position: "absolute", inset: 0, zIndex: 50, display: "flex", flexDirection: "column",
      background: "linear-gradient(165deg,#12152b,#1d1b38 55%,#281f44)", color: "#fff",
    }}>
      <div style={{ flex: 1, overflowY: "auto", padding: "calc(28px + env(safe-area-inset-top)) 24px 20px" }}>
        <div style={{ fontFamily: "'Fraunces',serif", fontSize: 24, fontWeight: 600, marginBottom: 16 }}>Settings</div>

        {/* Live preview */}
        <div style={{ padding: "12px 14px", borderRadius: 12, background: "rgba(0,0,0,0.25)", border: "1px solid rgba(255,255,255,0.14)", marginBottom: 18 }}>
          <div style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: 0.5, color: "rgba(255,255,255,0.4)", marginBottom: 6 }}>Preview</div>
          <div style={{ fontSize: 14, color: "rgba(255,255,255,0.9)", lineHeight: 1.6 }}>{previewLine1}</div>
          <div style={{ fontSize: 14, color: "rgba(255,255,255,0.9)", lineHeight: 1.6 }}>{previewLine2}</div>
        </div>

        <div style={row}>
          <span style={label}>Duration</span>
          <Segmented value={u.duration} onChange={(v) => set("duration", v)} options={[["min", "90 min"], ["hrmin", "1 hr 30"], ["colon", "1:30"]]} />
        </div>
        <div style={row}>
          <span style={label}>Distance</span>
          <Segmented value={u.distance} onChange={(v) => set("distance", v)} options={[["km", "km"], ["mi", "mi"]]} />
        </div>
        <div style={row}>
          <span style={label}>Ride speed</span>
          <Segmented value={u.rideSpeed} onChange={(v) => set("rideSpeed", v)} options={[["kmh", "km/h"], ["mph", "mph"]]} />
        </div>
        <div style={row}>
          <span style={label}>Wind speed</span>
          <Segmented value={u.windSpeed} onChange={(v) => set("windSpeed", v)} options={[["kmh", "km/h"], ["mph", "mph"], ["kt", "kt"]]} />
        </div>
        <div style={row}>
          <span style={label}>Temperature</span>
          <Segmented value={u.temp} onChange={(v) => set("temp", v)} options={[["c", "°C"], ["f", "°F"]]} />
        </div>
        <div style={row}>
          <span style={label}>Rainfall</span>
          <Segmented value={u.rainfall} onChange={(v) => set("rainfall", v)} options={[["mm", "mm"], ["in", "in"]]} />
        </div>
        <div style={{ ...row, borderBottom: "none" }}>
          <span style={label}>Decimal separator</span>
          <Segmented value={u.decimal} onChange={(v) => set("decimal", v)} options={[["dot", "1.5"], ["comma", "1,5"]]} />
        </div>
      </div>

      <div style={{ padding: "12px 24px calc(16px + env(safe-area-inset-bottom))", borderTop: "1px solid rgba(255,255,255,0.1)" }}>
        <button onClick={onClose} style={{
          width: "100%", padding: 13, borderRadius: 12, border: "none", cursor: "pointer",
          fontFamily: "'Fraunces',serif", fontSize: 15, fontWeight: 600, background: "#e0a45e", color: "#1a1f3a",
        }}>Done</button>
      </div>
    </div>
  );
}

/* Generic segmented control (2–3 options), ModePill visual style. options is an
 * array of [value, label] pairs. */
function Segmented({ value, onChange, options }) {
  return (
    <span style={{ display: "inline-flex", padding: 2, borderRadius: 9, background: "rgba(255,255,255,0.08)", border: "1px solid rgba(255,255,255,0.12)" }}>
      {options.map(([v, lbl]) => (
        <button key={v} onClick={() => onChange(v)} style={{
          padding: "4px 11px", borderRadius: 7, cursor: "pointer", fontFamily: "inherit", fontSize: 11.5, fontWeight: 600, border: "none",
          background: value === v ? "rgba(224,164,94,0.9)" : "transparent",
          color: value === v ? "#1a1f3a" : "rgba(255,255,255,0.5)",
        }}>{lbl}</button>
      ))}
    </span>
  );
}

/* Status line under a control: what the quantity is currently using. */
function SourceNote({ mode, source, rides }) {
  let text;
  if (mode !== "learn") text = "using your setting";
  else if (source === "learned") text = `calculated from ${rides} ride${rides === 1 ? "" : "s"}`;
  else text = "using your setting until enough rides recorded";
  const learned = source === "learned" && mode === "learn";
  return <div style={{ fontSize: 11.5, color: learned ? "#6fd49a" : "rgba(255,255,255,0.5)", marginTop: 4 }}>{text}</div>;
}

/* ============================================================================
 * TerrainControls — speed + ground-effect tuning, each with a Manual/Learn
 * pill. In Learn with data, the control is read-only and shows the learned
 * value; in Learn without enough data it stays editable (it IS the fallback the
 * model uses). Split can be set manually, or fires automatically in Learn once
 * both directions qualify — at which point the split control is disabled.
 * ========================================================================== */
function TerrainControls({ distanceM, value, onChange, modes, onModeChange, learned, example, autoSplit }) {
  const speedKmh = value.speedKmh;
  const baselineSec = distanceM / (speedKmh / 3.6);

  // Is each control read-only? Only when Learn is actively serving a learned
  // value for that quantity.
  const baseLearned = modes.baselineMode === "learn" && learned && learned.baselineSource === "learned";
  const headLearned = modes.kMode === "learn" && learned && learned.kHeadSource === "learned";
  const tailLearned = modes.kMode === "learn" && learned && learned.kTailSource === "learned";

  // Baseline speed is stored canonical (km/h) but shown/stepped in the ride-speed
  // unit. Work in display units for the +/- logic (0.5 step, converted bounds),
  // then convert once to canonical on commit — never re-derive from a rounded
  // display, so mph↔km/h round-tripping doesn't drift. (Canonical bounds 1–50 km/h.)
  const setSpeedDisplay = (nextDisplay) => {
    if (baseLearned) return;
    const b = rideSpeedBounds(1, 50);
    const clamped = Math.max(b.min, Math.min(b.max, Math.round(nextDisplay * 2) / 2));
    onChange({ ...value, speedKmh: rideSpeedToCanonicalKmh(clamped) });
  };
  const setK = (which, k) => {
    const kk = kClampUI(k);
    if (value.split) onChange({ ...value, [which]: kk });
    else onChange({ ...value, kHead: kk, kTail: kk });
  };

  // Displayed k values: the learned value only when THAT k direction is served
  // from rides; otherwise the editable slider value. (Baseline being learned
  // must not pin k — that desynced the slider on revert.)
  const headK = headLearned ? learned.kHead : value.kHead;
  const tailK = tailLearned ? learned.kTail : value.kTail;
  const dispKmh = baseLearned ? learned.speedKmh : speedKmh;
  const dispSpeed = canonicalKmhToRideSpeed(dispKmh); // shown/stepped in ride-speed unit
  const speedStep = rideSpeedStep();
  const speedUnit = rideSpeedUnitLabel();
  const dispBaselineSec = baseLearned ? learned.baselineSec : baselineSec;

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 4 }}>
        <label style={{ ...lbl, marginBottom: 0 }}>Still-air speed</label>
        <ModePill mode={modes.baselineMode} onChange={(m) => onModeChange("baselineMode", m)} />
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 4, opacity: baseLearned ? 0.85 : 1 }}>
        <button onClick={() => setSpeedDisplay(dispSpeed - speedStep)} disabled={baseLearned} style={{ ...spinBtn, opacity: baseLearned ? 0.4 : 1, cursor: baseLearned ? "default" : "pointer" }} aria-label="slower">−</button>
        <div style={{ flex: 1, textAlign: "center" }}>
          <span style={{ fontFamily: "'Fraunces',serif", fontSize: 24, fontWeight: 600 }}>{Number.isInteger(dispSpeed) ? dispSpeed : dispSpeed.toFixed(1)}</span>
          <span style={{ fontSize: 13, color: "rgba(255,255,255,0.6)" }}> {speedUnit}</span>
        </div>
        <button onClick={() => setSpeedDisplay(dispSpeed + speedStep)} disabled={baseLearned} style={{ ...spinBtn, opacity: baseLearned ? 0.4 : 1, cursor: baseLearned ? "default" : "pointer" }} aria-label="faster">+</button>
      </div>
      <div style={{ fontSize: 12.5, color: "rgba(255,255,255,0.55)" }}>
        Still-air ride time: <b style={{ color: "rgba(255,255,255,0.85)" }}>{formatElapsed(dispBaselineSec)}</b>
      </div>
      <SourceNote mode={modes.baselineMode} source={learned ? learned.baselineSource : "slider"} rides={learned ? learned.ridesBaseline : 0} />

      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginTop: 16, marginBottom: 4 }}>
        <label style={{ ...lbl, marginBottom: 0 }}>{value.split ? "Ground effect" : "Ground effect"}</label>
        <ModePill mode={modes.kMode} onChange={(m) => onModeChange("kMode", m)} />
      </div>

      {!value.split ? (
        <TerrainSlider title="Ground effect" k={headK} baselineSec={dispBaselineSec}
          readOnly={headLearned} showBoth example={example}
          mode={modes.kMode}
          source={learned && (learned.kHeadSource === "learned" || learned.kTailSource === "learned") ? "learned" : "slider"}
          rides={learned ? Math.max(learned.ridesHead, learned.ridesTail) : 0}
          onCommit={(k) => setK("kHead", k)} />
      ) : (
        <>
          <TerrainSlider title="Ground effect on headwind" k={headK} baselineSec={dispBaselineSec}
            readOnly={headLearned} sign={+1} example={example}
            mode={modes.kMode}
            source={learned && learned.kHeadSource === "learned" ? "learned" : "slider"}
            rides={learned ? learned.ridesHead : 0}
            onCommit={(k) => setK("kHead", k)} />
          <TerrainSlider title="Ground effect on tailwind" k={tailK} baselineSec={dispBaselineSec}
            readOnly={tailLearned} sign={-1} example={example}
            mode={modes.kMode}
            source={learned && learned.kTailSource === "learned" ? "learned" : "slider"}
            rides={learned ? learned.ridesTail : 0}
            onCommit={(k) => setK("kTail", k)} />
        </>
      )}

      <label style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginTop: 14, cursor: autoSplit ? "default" : "pointer", opacity: autoSplit ? 0.6 : 1 }}>
        <span style={{ fontSize: 13.5, color: "rgba(255,255,255,0.8)" }}>
          Split headwind &amp; tailwind{autoSplit ? " (learned separately)" : ""}
        </span>
        <input type="checkbox" checked={!!value.split} disabled={autoSplit}
          onChange={(e) => { if (autoSplit) return; if (e.target.checked) onChange({ ...value, split: true }); else onChange({ ...value, split: false, _collapse: true }); }}
          style={{ width: 40, height: 22, accentColor: "#e0a45e", cursor: autoSplit ? "default" : "pointer" }} />
      </label>
    </div>
  );
}

function TerrainSlider({ title, k, baselineSec, readOnly, sign, showBoth, example, mode, source, rides, onCommit }) {
  const [local, setLocal] = useState(kClampUI(k));
  useEffect(() => { setLocal(kClampUI(k)); }, [k]);
  const effK = kClampUI(k);
  const offLow = readOnly && k < TERRAIN_MIN;
  const offHigh = readOnly && k > TERRAIN_MAX;
  const shownK = readOnly ? effK : local;
  // Example times come from the real route geometry: a steady 20 km/h wind from
  // the route's mean bearing (headward) or its opposite (tailward), evaluated
  // through the v2 model with the slider's k INSIDE the physics curve:
  //   time = baseline·(1 + Σw·effortNorm(k·hᵢ)/Σw)
  const wfWith = (comps, kk) => {
    if (!comps || !comps.length) return 0;
    let num = 0, den = 0;
    for (const c of comps) { num += c.w * effortNorm(kk * c.h); den += c.w; }
    return den > 0 ? num / den : 0;
  };
  const headSec = baselineSec * (1 + (example ? wfWith(example.headComponents, shownK) : effortNorm(shownK * 20)));
  const tailSec = baselineSec * (1 + (example ? wfWith(example.tailComponents, shownK) : effortNorm(-shownK * 20)));
  const oneSec = sign === -1 ? tailSec : headSec;
  const headLabel = example ? example.headBearingLabel : "";
  const tailLabel = example ? example.tailBearingLabel : "";
  const dirLabel = showBoth
    ? `${headLabel}/${tailLabel}`
    : (sign === -1 ? tailLabel : headLabel);

  return (
    <div style={{ marginBottom: 14 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 6 }}>
        {offLow && <span style={{ color: "#e0a45e", fontWeight: 700 }} title="Learned value is below the scale">◄</span>}
        <span style={{ fontSize: 13.5, color: "rgba(255,255,255,0.8)", flex: 1 }}>{title}</span>
        {offHigh && <span style={{ color: "#e0a45e", fontWeight: 700 }} title="Learned value is above the scale">►</span>}
      </div>
      <input type="range" min={TERRAIN_MIN} max={TERRAIN_MAX} step={0.01} value={shownK} disabled={readOnly}
        onChange={(e) => { if (!readOnly) setLocal(Number(e.target.value)); }}
        onMouseUp={(e) => { if (!readOnly) onCommit(Number(e.target.value)); }}
        onTouchEnd={(e) => { if (!readOnly) onCommit(Number(e.target.value)); }}
        style={{ width: "100%", accentColor: "#e0a45e", opacity: readOnly ? 0.7 : 1 }} />
      {/* Top line: wind-EXPOSURE progression, evenly spaced. Positions are
          approximate — the terms just walk from most-sheltered to wind-
          amplifying (Funnelled is the >100% region terrain that accelerates
          wind above forecast, the reason the scale runs past 100%). */}
      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 9.5, color: "rgba(255,255,255,0.4)", marginTop: 2 }}>
        <span>Sheltered</span>
        <span>Urban</span>
        <span>Exposed</span>
        <span>Funnelled</span>
      </div>
      {/* Bottom line: gradient hint (independent of exposure). Steeper routes
          feel less wind effect for a given exposure; flatter feel more. */}
      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 9.5, color: "rgba(255,255,255,0.32)", marginTop: 1 }}>
        <span>◄ steeper</span>
        <span>flatter ►</span>
      </div>
      <div style={{ fontSize: 11.5, color: "#e0a45e", marginTop: 6 }}>
        ground effect: {kPct(shownK)} of forecast wind felt
      </div>
      <SourceNote mode={mode} source={source} rides={rides} />
      <div style={{ fontSize: 12.5, color: "rgba(255,255,255,0.6)", marginTop: 6, lineHeight: 1.4 }}>
        <span style={{ color: "rgba(255,255,255,0.45)" }}>example ride, steady {exampleWindLabel()} wind from {dirLabel}</span><br />
        {showBoth
          ? <>headwind <b style={{ color: "rgba(255,255,255,0.85)" }}>{formatElapsed(headSec)}</b> / tailwind <b style={{ color: "rgba(255,255,255,0.85)" }}>{formatElapsed(tailSec)}</b></>
          : <>{sign === -1 ? "tailwind" : "headwind"} <b style={{ color: "rgba(255,255,255,0.85)" }}>{formatElapsed(oneSec)}</b></>}
      </div>
    </div>
  );
}

const spinBtn = { width: 44, height: 44, borderRadius: 12, border: "1px solid rgba(255,255,255,0.2)", background: "rgba(255,255,255,0.08)", color: "#fff", fontSize: 22, cursor: "pointer", fontFamily: "inherit", lineHeight: 1 };

/* Per-direction wind-learning status now lives inline under each control as a
 * SourceNote; the separate WindLearningStatus block was removed in the refactor. */

/* ============================================================================
 * RidesManager — full-screen overlay listing a route's rides for curation.
 * Columns: date, time, length, k, class, include checkbox, edit. Gentle rides
 * default excluded; still/windy default included. Long-press the include
 * checkbox to "exclude this ride and all earlier". Tapping edit opens the
 * RideEditor. The per-ride k reflects the currently-configured baseline.
 * ========================================================================== */
const OVERLAY = {
  position: "fixed", inset: 0, zIndex: 50, overflowY: "auto",
  background: "linear-gradient(165deg,#12152b,#1d1b38 55%,#281f44)", color: "#fff",
};
const fmtRideDate = (ms) => {
  const d = new Date(ms);
  return d.toLocaleDateString(undefined, { day: "numeric", month: "short" });
};
// Time-of-day and duration go through the shared format seam so ride-log times
// match the rest of the app exactly (system clock format; duration setting).
const fmtRideTime = (ms) => formatTimeOfDay(ms);
const fmtLen = (sec) => formatElapsed(sec);
/** Stopwatch/elapsed clock (keeps SECONDS, unlike the duration seam). Under 1 h:
 * "M:SS"; at 1 h or more: "H:MM:SS" (zero-padded m & s) so a value like 92:15 is
 * never ambiguous between 92 min and 92 h. */
const fmtStopwatch = (s) => {
  const t = Math.max(0, Math.floor(s));
  const hh = Math.floor(t / 3600), mm = Math.floor((t % 3600) / 60), ss = t % 60;
  const p2 = (n) => String(n).padStart(2, "0");
  return hh > 0 ? `${hh}:${p2(mm)}:${p2(ss)}` : `${mm}:${p2(ss)}`;
};
const CLASS_COLOR = {
  windy: "#e0a45e", // legacy key (windy now displays as headwind|tailwind)
  headwind: "#5b8fc7", tailwind: "#e0a45e", // verdict accent colours
  gentle: "rgba(255,255,255,0.45)", still: "rgba(140,190,255,0.85)",
};
// Windy rides display as "headwind" | "tailwind" by the sign of their wind:
// v2 rides from rideWindKmh; v1 rides from their stored (old-scale) windFactor,
// whose SIGN is still meaningful.
// k is user-facing as a PERCENTAGE (fraction of forecast wind felt): 0%–120%.
const kPct = (k) => `${Math.round(k * 100)}%`;
const rideWindSign = (r) => (r.wfv === 2 ? Math.sign(r.rideWindKmh ?? 0) : Math.sign(r.windFactor ?? 0));
const rideClassLabel = (r) => (r.klass === "windy" ? (rideWindSign(r) < 0 ? "tailwind" : "headwind") : r.klass);
// Mean along-route forecast wind for display: v2 rides store it directly;
// v1 rides recover it through the v1 inverse (20·√|wf|), honest to the scale
// that ride's factor was computed on.
const rideMeanWindKmh = (r) => (r.wfv === 2
  ? (Number.isFinite(r.rideWindKmh) ? Math.abs(r.rideWindKmh) : null)
  : (Number.isFinite(r.windFactor) ? 20 * Math.sqrt(Math.abs(r.windFactor)) : null));

function RidesManager({ route, controller, reloadKey, onRidesChanged }) {
  const [rides, setRides] = useState(null);
  const [editing, setEditing] = useState(null); // a ride object
  const [bulkAsk, setBulkAsk] = useState(null);  // { rideId, count }
  const [manualOpen, setManualOpen] = useState(false); // "add ride manually" form
  const pressTimer = useRef(null);

  const load = useCallback(() => {
    return controller.ridesForManager(route.id).then((rs) => setRides(rs));
  }, [controller, route.id]);
  // Reload on mount and whenever reloadKey changes (e.g. the editor applied a
  // baseline change, which shifts per-ride k for current-baseline rides).
  useEffect(() => { load(); }, [load, reloadKey]);
  // After a mutation here, reload the list AND tell the editor to refresh its
  // tuning (curation changes what the model learns).
  const reloadAfterMutation = async () => { await load(); onRidesChanged && onRidesChanged(); };

  const toggleInclude = async (ride) => {
    await controller.updateRide(ride.id, { included: !ride.included });
    await reloadAfterMutation();
  };

  // Long-press on a checkbox → confirm "exclude this and all earlier".
  const startPress = (ride) => {
    clearTimeout(pressTimer.current);
    pressTimer.current = setTimeout(() => {
      const earlier = rides.filter((r) => (r.startedAt ?? 0) <= (ride.startedAt ?? 0)).length;
      setBulkAsk({ rideId: ride.id, count: earlier });
    }, 550);
  };
  const cancelPress = () => clearTimeout(pressTimer.current);
  const doBulk = async () => {
    await controller.excludeRideAndEarlier(bulkAsk.rideId);
    setBulkAsk(null);
    await reloadAfterMutation();
  };

  return (
    <div style={{ marginTop: 12, paddingTop: 4 }}>
      {rides == null ? (
          <div style={{ color: "rgba(255,255,255,0.5)", padding: 16 }}>Loading…</div>
        ) : rides.length === 0 ? (
          <div style={{ padding: "20px 14px", textAlign: "center", color: "rgba(255,255,255,0.55)", lineHeight: 1.5, border: "1px dashed rgba(255,255,255,0.16)", borderRadius: 12 }}>
            No rides logged yet. Record a ride on the Ride tab and it will appear here to tune this route.
          </div>
        ) : (
          <>
            {/* Header row */}
            <div style={{ display: "grid", gridTemplateColumns: "1fr 60px 52px 30px 34px", gap: 8, alignItems: "center", fontSize: 10.5, letterSpacing: "0.04em", textTransform: "uppercase", color: "rgba(255,255,255,0.4)", padding: "0 4px 6px" }}>
              <span>Date / time</span>
              <span style={{ textAlign: "right" }}>Length</span>
              <span style={{ textAlign: "right" }}>k</span>
              <span style={{ textAlign: "center" }}>Use</span>
              <span></span>
            </div>
            {rides.map((r) => (
              <div key={r.id} style={{
                display: "grid", gridTemplateColumns: "1fr 60px 52px 30px 34px", gap: 8, alignItems: "center",
                padding: "10px 4px", borderTop: "1px solid rgba(255,255,255,0.08)",
                opacity: r.included ? 1 : 0.5,
              }}>
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontSize: 13.5, fontWeight: 600 }}>{fmtRideDate(r.startedAt)} <span style={{ color: "rgba(255,255,255,0.5)", fontWeight: 400 }}>{fmtRideTime(r.startedAt)}</span></div>
                  <div style={{ fontSize: 11, color: CLASS_COLOR[rideClassLabel(r)] }}>{rideClassLabel(r)}</div>
                </div>
                <div style={{ textAlign: "right", fontSize: 13, fontFamily: "'Fraunces',serif" }}>{fmtLen(r.actualTimeSec)}</div>
                <div style={{ textAlign: "right", fontSize: 12.5, color: r.klass === "gentle" ? "rgba(255,255,255,0.4)" : "rgba(255,255,255,0.85)" }}>
                  {r.klass === "still" ? "still" : (r.rideK == null ? "—" : kPct(r.rideK))}
                </div>
                <div style={{ textAlign: "center" }}>
                  <input type="checkbox" checked={r.included}
                    onChange={() => toggleInclude(r)}
                    onMouseDown={() => startPress(r)} onMouseUp={cancelPress} onMouseLeave={cancelPress}
                    onTouchStart={() => startPress(r)} onTouchEnd={cancelPress}
                    style={{ width: 20, height: 20, accentColor: "#e0a45e", cursor: "pointer" }} />
                </div>
                <button onClick={() => setEditing(r)} aria-label="edit ride" style={{
                  width: 30, height: 30, borderRadius: 8, border: "1px solid rgba(255,255,255,0.16)",
                  background: "rgba(255,255,255,0.06)", color: "rgba(255,255,255,0.8)", cursor: "pointer", fontSize: 13,
                }}>✎</button>
              </div>
            ))}
            <div style={{ fontSize: 11, color: "rgba(255,255,255,0.4)", marginTop: 12, lineHeight: 1.5 }}>
              Gentle rides default to unused. Long-press a checkbox to exclude that ride and all earlier ones. A unique k value is calculated for each ride using the current baseline. Overall k is calculated from all included individual rides.
            </div>
          </>
        )}

      {!route.isExample && (
        <button onClick={() => setManualOpen(true)} style={{
          marginTop: 14, width: "100%", padding: "11px 16px", borderRadius: 12, cursor: "pointer",
          fontFamily: "inherit", fontSize: 13.5, fontWeight: 600,
          background: "rgba(255,255,255,0.08)", color: "#fff", border: "1px solid rgba(255,255,255,0.2)",
        }}>+ Enter a ride from earlier today</button>
      )}

      {manualOpen && (
        <ManualRideEntry route={route} controller={controller}
          onClose={() => setManualOpen(false)}
          onAdded={async () => { setManualOpen(false); await reloadAfterMutation(); }} />
      )}

      {editing && (
        <RideEditor ride={editing} controller={controller}
          onClose={async () => { setEditing(null); await reloadAfterMutation(); }} />
      )}

      {bulkAsk && (
        <div style={{ position: "fixed", inset: 0, zIndex: 60, display: "grid", placeItems: "center", background: "rgba(8,10,22,0.7)", padding: 24 }}>
          <div style={{ maxWidth: 320, padding: "18px 18px", borderRadius: 14, background: "#1d1b38", border: "1px solid rgba(255,255,255,0.18)" }}>
            <div style={{ fontSize: 14, color: "rgba(255,255,255,0.85)", marginBottom: 14, lineHeight: 1.45 }}>
              Exclude this ride and {bulkAsk.count - 1} earlier {bulkAsk.count - 1 === 1 ? "ride" : "rides"}? You can re-include them individually later.
            </div>
            <div style={{ display: "flex", gap: 8 }}>
              <button onClick={() => setBulkAsk(null)} style={backupBtn}>Cancel</button>
              <button onClick={doBulk} style={{ ...backupBtn, background: "rgba(224,164,94,0.9)", color: "#1a1f3a", border: "none" }}>Exclude {bulkAsk.count}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/* ============================================================================
 * ManualRideEntry — log a ride from earlier today by entering start/finish
 * times. Today-only (so today's forecast is always fetchable for wind
 * reconstruction). Delegates to controller.recordManualRide, which treats it
 * identically to a GPS-recorded ride (same wind_factor reconstruction and
 * classification).
 * ========================================================================== */
function ManualRideEntry({ route, controller, onClose, onAdded }) {
  const pad = (n) => String(n).padStart(2, "0");
  const nowHM = () => { const d = new Date(); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };
  const [start, setStart] = useState("");
  const [finish, setFinish] = useState(nowHM());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  // Combine an HH:MM (today, local) into an epoch ms.
  const toMsToday = (hm) => {
    const [h, m] = hm.split(":").map(Number);
    const d = new Date();
    d.setHours(h, m, 0, 0);
    return d.getTime();
  };

  const valid = /^\d{1,2}:\d{2}$/.test(start) && /^\d{1,2}:\d{2}$/.test(finish);
  const submit = async () => {
    setError(null);
    const startMs = toMsToday(start), endMs = toMsToday(finish);
    if (!(endMs > startMs)) { setError("Finish time must be after the start time."); return; }
    if (endMs > Date.now()) { setError("Finish time can't be in the future."); return; }
    setBusy(true);
    try {
      await controller.recordManualRide(route.id, { startMs, endMs });
      onAdded();
    } catch (e) {
      setError(e.message || "Couldn't add the ride.");
      setBusy(false);
    }
  };

  const dur = (() => {
    if (!valid) return null;
    const mins = Math.round((toMsToday(finish) - toMsToday(start)) / 60000);
    return mins > 0 ? mins : null;
  })();

  return (
    <div style={{ position: "fixed", inset: 0, zIndex: 60, display: "grid", placeItems: "center", background: "rgba(8,10,22,0.7)", padding: 24 }}>
      <div style={{ maxWidth: 340, width: "100%", padding: "20px 20px", borderRadius: 16, background: "#1d1b38", border: "1px solid rgba(255,255,255,0.18)" }}>
        <div style={{ fontFamily: "'Fraunces',serif", fontSize: 19, fontWeight: 600, marginBottom: 6 }}>Enter a ride from earlier today</div>
        <div style={{ fontSize: 13, color: "rgba(255,255,255,0.6)", lineHeight: 1.45, marginBottom: 16 }}>
          Enter when you started and finished. We'll work out the wind from today's forecast, just as if you'd recorded it.
        </div>
        <div style={{ display: "flex", gap: 12, marginBottom: 14 }}>
          <label style={{ flex: 1, fontSize: 12, color: "rgba(255,255,255,0.55)" }}>Start
            <TimeField value={start} onChange={setStart} style={{ marginTop: 4 }} />
          </label>
          <label style={{ flex: 1, fontSize: 12, color: "rgba(255,255,255,0.55)" }}>Finish
            <TimeField value={finish} onChange={setFinish} style={{ marginTop: 4 }} />
          </label>
        </div>
        {dur != null && <div style={{ fontSize: 13, color: "rgba(255,255,255,0.7)", marginBottom: 12 }}>Ride length: {formatElapsed(dur * 60)}</div>}
        {error && <div style={{ fontSize: 13, color: "#e8927c", marginBottom: 12, lineHeight: 1.4 }}>{error}</div>}
        <div style={{ display: "flex", gap: 10 }}>
          <button onClick={onClose} disabled={busy} style={backupBtn}>Cancel</button>
          <button onClick={submit} disabled={!valid || busy} style={{ ...backupBtn, background: valid && !busy ? "#e0a45e" : "rgba(224,164,94,0.4)", color: "#1a1f3a", border: "none", cursor: valid && !busy ? "pointer" : "default" }}>
            {busy ? "Adding…" : "Add ride"}
          </button>
        </div>
      </div>
    </div>
  );
}


function RideEditor({ ride, controller, onClose }) {
  const [durMin, setDurMin] = useState(Math.round(ride.actualTimeSec / 60));
  const [included, setIncluded] = useState(ride.included);
  const [ref, setRef] = useState(ride.baselineRef);
  const [confirmDel, setConfirmDel] = useState(false);
  const [bulkAsk, setBulkAsk] = useState(false);
  const locked = ride.locked; // age >= 14 days → current/historic frozen
  // Live k: recomputed from the EDITED duration and baseline-reference choice,
  // through the same inversion the model uses, so the headline updates as the
  // user adjusts — not only after save. Null (hidden) when not computable.
  const liveK = ride.wfv === 2 && ride.klass !== "still"
    ? computeRideK(
        { wfv: 2, rideWindKmh: ride.rideWindKmh, actualSec: durMin * 60,
          baselineRef: ref, savedBaselineSec: ride.savedBaselineSec },
        ride.liveBaselineSec)
    : ride.rideK;

  const save = async () => {
    await controller.updateRide(ride.id, {
      actualTimeSec: Math.max(1, Math.round(durMin * 60)),
      included,
      ...(locked ? {} : { baselineRef: ref }),
    });
    onClose();
  };
  const del = async () => { await controller.deleteRide(ride.id); onClose(); };
  const doBulk = async () => { await controller.excludeRideAndEarlier(ride.id); setBulkAsk(false); onClose(); };

  return (
    <div style={OVERLAY}>
      <div style={{ maxWidth: 460, margin: "0 auto", padding: "calc(18px + env(safe-area-inset-top)) 18px 28px" }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 18 }}>
          <span style={{ fontFamily: "'Fraunces',serif", fontSize: 20, fontWeight: 600 }}>Edit ride</span>
          <button onClick={onClose} style={{ ...backupBtn, flex: "0 0 auto", padding: "8px 16px" }}>Cancel</button>
        </div>

        <div style={{ fontSize: 12.5, color: "rgba(255,255,255,0.55)", marginBottom: 18 }}>
          {fmtRideDate(ride.startedAt)} · {fmtRideTime(ride.startedAt)} · <span style={{ color: CLASS_COLOR[rideClassLabel(ride)] }}>{rideClassLabel(ride)}</span>
          {ride.klass !== "still" && liveK != null && <> · k={kPct(liveK)}</>}
          {ride.klass !== "still" && rideMeanWindKmh(ride) != null && <> · equivalent wind {formatWindSpeed(rideMeanWindKmh(ride))}</>}
        </div>

        {/* Duration */}
        <label style={lbl}>Recorded ride time</label>
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 18 }}>
          <button onClick={() => setDurMin((m) => Math.max(1, m - 1))} style={spinBtn} aria-label="shorter">−</button>
          <div style={{ flex: 1, textAlign: "center" }}>
            <span style={{ fontFamily: "'Fraunces',serif", fontSize: 24, fontWeight: 600 }}>{formatElapsed(durMin * 60)}</span>
          </div>
          <button onClick={() => setDurMin((m) => m + 1)} style={spinBtn} aria-label="longer">+</button>
        </div>

        {/* Include / exclude */}
        <label style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "12px 0", cursor: "pointer", borderTop: "1px solid rgba(255,255,255,0.1)" }}>
          <span style={{ fontSize: 14, color: "rgba(255,255,255,0.85)" }}>Use this ride for tuning</span>
          <input type="checkbox" checked={included} onChange={(e) => setIncluded(e.target.checked)}
            style={{ width: 40, height: 22, accentColor: "#e0a45e", cursor: "pointer" }} />
        </label>

        {/* Current / historic baseline switch */}
        <div style={{ padding: "12px 0", borderTop: "1px solid rgba(255,255,255,0.1)" }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 6 }}>
            <span style={{ fontSize: 14, color: "rgba(255,255,255,0.85)" }}>Baseline</span>
            <span style={{ display: "inline-flex", padding: 2, borderRadius: 9, background: "rgba(255,255,255,0.08)", border: "1px solid rgba(255,255,255,0.12)", opacity: locked ? 0.5 : 1 }}>
              {[["current", "Current"], ["historic", "Historic"]].map(([m, l]) => (
                <button key={m} disabled={locked} onClick={() => !locked && setRef(m)} style={{
                  padding: "3px 10px", borderRadius: 7, border: "none", cursor: locked ? "default" : "pointer",
                  fontFamily: "inherit", fontSize: 11, fontWeight: 600,
                  background: ref === m ? "rgba(224,164,94,0.9)" : "transparent",
                  color: ref === m ? "#1a1f3a" : "rgba(255,255,255,0.5)",
                }}>{l}</button>
              ))}
            </span>
          </div>
          <div style={{ fontSize: 11.5, color: "rgba(255,255,255,0.5)", lineHeight: 1.45 }}>
            {locked
              ? "Locked to historic — this ride is over two weeks old, so it keeps the baseline from when it was ridden."
              : ref === "current"
                ? "Measured against your live baseline; updates as you refine it. Auto-locks to historic after two weeks."
                : "Measured against the baseline saved with this ride."}
          </div>
        </div>

        {/* Bulk exclude */}
        <button onClick={() => setBulkAsk(true)} style={{
          width: "100%", marginTop: 8, padding: "11px 0", borderRadius: 10, cursor: "pointer",
          fontFamily: "inherit", fontSize: 13, fontWeight: 600,
          border: "1px solid rgba(255,255,255,0.16)", background: "rgba(255,255,255,0.05)", color: "rgba(255,255,255,0.75)",
        }}>Exclude this ride and all earlier</button>

        {/* Save */}
        <div style={{ display: "flex", gap: 10, marginTop: 18 }}>
          <button onClick={onClose} style={backupBtn}>Cancel</button>
          <button onClick={save} style={{ flex: 1, padding: 13, borderRadius: 12, border: "none", cursor: "pointer", fontFamily: "'Fraunces',serif", fontSize: 15, fontWeight: 600, background: "#e0a45e", color: "#1a1f3a" }}>Save</button>
        </div>

        {/* Delete */}
        <div style={{ display: "flex", gap: 10, marginTop: 14 }}>
          {!confirmDel ? (
            <button onClick={() => setConfirmDel(true)} style={{ ...backupBtn, color: "#f0a08c", borderColor: "rgba(224,120,94,0.4)" }}>Delete ride</button>
          ) : (
            <>
              <span style={{ flex: 1, alignSelf: "center", fontSize: 13, color: "#f0b8a8" }}>Delete this ride permanently?</span>
              <button onClick={() => setConfirmDel(false)} style={backupBtn}>Cancel</button>
              <button onClick={del} style={{ ...backupBtn, background: "rgba(224,120,94,0.9)", color: "#1a1f3a", border: "none" }}>Delete</button>
            </>
          )}
        </div>
      </div>

      {bulkAsk && (
        <div style={{ position: "fixed", inset: 0, zIndex: 60, display: "grid", placeItems: "center", background: "rgba(8,10,22,0.7)", padding: 24 }}>
          <div style={{ maxWidth: 320, padding: "18px 18px", borderRadius: 14, background: "#1d1b38", border: "1px solid rgba(255,255,255,0.18)" }}>
            <div style={{ fontSize: 14, color: "rgba(255,255,255,0.85)", marginBottom: 14, lineHeight: 1.45 }}>
              Exclude this ride and all earlier rides on this route? You can re-include them individually later.
            </div>
            <div style={{ display: "flex", gap: 8 }}>
              <button onClick={() => setBulkAsk(false)} style={backupBtn}>Cancel</button>
              <button onClick={doBulk} style={{ ...backupBtn, background: "rgba(224,164,94,0.9)", color: "#1a1f3a", border: "none" }}>Exclude</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function RouteEditor({ route, controller, onSaved, onDeleted }) {
  const [name, setName] = useState(route.name);
  const [arrival, setArrival] = useState(route.targetArrival);
  const [days, setDays] = useState(route.activeDays);
  const [timeMode, setTimeMode] = useState(route.timeMode === "depart" ? "depart" : "arrive");
  const [confirmDel, setConfirmDel] = useState(false);
  const [nameErr, setNameErr] = useState(null); // rename collision message
  const toggleDay = (d) => setDays(days.includes(d) ? days.filter((x) => x !== d) : [...days, d]);

  // Tuning: load the manual sliders, learned view (with per-quantity sources),
  // and the current modes from the controller.
  const [tuning, setTuning] = useState(null);
  const [val, setVal] = useState(null);     // { speedKmh, kHead, kTail, split } — the slider (manual) values
  const [modes, setModes] = useState(null); // { baselineMode, kMode }
  const [collapseAsk, setCollapseAsk] = useState(null); // {next} split-off, which to keep
  const [ridesOpen, setRidesOpen] = useState(false);    // inline View rides fold
  const [applyTick, setApplyTick] = useState(0);        // bumped on Apply → reloads open rides list
  // Snapshot of the last-applied editable state, for the dirty check + revert.
  const [applied, setApplied] = useState(null);

  // The current editable state, as a comparable object.
  const editState = () => ({
    name, arrival, days: [...days].sort(), timeMode,
    val: val ? { ...val } : null, modes: modes ? { ...modes } : null,
  });
  const dirty = applied != null && JSON.stringify(editState()) !== JSON.stringify(applied);

  const snapshot = () => setApplied(JSON.parse(JSON.stringify(editState())));

  const loadTuning = useCallback(() => {
    return controller.routeTuning(route.id).then((t) => {
      if (!t) return;
      setTuning(t);
      // Slider (manual) values come from t.manual; split reflects the current config.
      setVal({ speedKmh: t.manual.speedKmh, kHead: t.manual.kHead, kTail: t.manual.kTail, split: t.config.split });
      setModes({ baselineMode: t.config.baselineMode, kMode: t.config.kMode });
    });
  }, [controller, route.id]);

  // Keep a live ref to the route so the once-per-open init effect can read its
  // current schedule fields without taking them as deps (which would re-run the
  // init on every background/quiet refresh and stomp in-progress edits).
  const routeRef = useRef(route);
  routeRef.current = route;

  useEffect(() => {
    let alive = true;
    controller.routeTuning(route.id).then((t) => {
      if (!alive || !t) return;
      const r = routeRef.current;
      setTuning(t);
      const v = { speedKmh: t.manual.speedKmh, kHead: t.manual.kHead, kTail: t.manual.kTail, split: t.config.split };
      const m = { baselineMode: t.config.baselineMode, kMode: t.config.kMode };
      setVal(v); setModes(m);
      // Establish the initial applied snapshot from loaded state.
      setApplied({
        name: r.name, arrival: r.targetArrival,
        days: [...r.activeDays].sort(),
        timeMode: r.timeMode === "depart" ? "depart" : "arrive",
        val: { ...v }, modes: { ...m },
      });
    });
    return () => { alive = false; };
  }, [controller, route.id]);

  // Convert slider values → k-slider + baseline fields for persistence.
  const valToConfig = (v) => {
    const baselineSec = tuning.distanceM / (v.speedKmh / 3.6);
    return {
      seedStillAirSec: Math.round(baselineSec),
      baselineTimeSec: Math.round(baselineSec),
      sliderKHead: v.kHead,
      sliderKTail: v.kTail,
      split: !!v.split,
    };
  };

  // Apply: persist the current editable state. Does NOT close the editor — it is
  // closed by tapping the route chip again, opening another route, or switching
  // tab. After applying, the snapshot is refreshed so Apply/Cancel disable until
  // the next change.
  const apply = async () => {
    if (!dirty) return;
    if (route.isExample) {
      controller.updateExampleSeeds({
        speedKmh: val ? val.speedKmh : undefined,
        kHead: val ? val.kHead : undefined,
        kTail: val ? val.kTail : undefined,
        targetArrival: arrival, activeDays: days, timeMode,
        baselineMode: modes.baselineMode, kMode: modes.kMode, split: val ? val.split : undefined,
      });
    } else {
      // Persist slider values, modes, split, and schedule. Editing a slider NEVER
      // wipes rides — manual/learn is a per-quantity switch and ride history is
      // curated separately in View rides.
      try {
        await controller.updateRoute(route.id, {
          ...valToConfig(val),
          baselineMode: modes.baselineMode,
          kMode: modes.kMode,
          name: name.trim() || route.name,
          targetArrival: arrival,
          activeDays: days,
          timeMode,
        });
      } catch (e) {
        setNameErr(e.message || "Couldn't save changes.");
        return; // abort: don't snapshot/close on a rejected save (e.g. name clash)
      }
    }
    setNameErr(null);
    snapshot();
    // Refresh the editor's own learned view / dots from the just-applied state,
    // and quietly recompute the verdict beneath — without closing or collapsing
    // the editor or the View-rides fold. Bump applyTick so an open rides list
    // re-fetches (per-ride k for current-baseline rides shifts with the baseline).
    setApplyTick((t) => t + 1);
    await loadTuning();
    onSaved();
  };

  // Cancel: revert all unsaved edits to the last-applied snapshot, then disable.
  const revert = () => {
    if (!applied || !dirty) return;
    setName(applied.name);
    setArrival(applied.arrival);
    setDays([...applied.days]);
    setTimeMode(applied.timeMode);
    setVal({ ...applied.val });
    setModes({ ...applied.modes });
  };

  const del = async () => { await controller.deleteRoute(route.id); onDeleted(); };

  const onTuningChange = (next) => {
    if (next._collapse) { delete next._collapse; setCollapseAsk({ next }); return; }
    setVal(next);
  };
  const onModeChange = (which, m) => setModes((prev) => ({ ...prev, [which]: m }));
  const resolveCollapse = (keep) => {
    const base = collapseAsk.next;
    const k = keep === "head" ? val.kHead : val.kTail;
    setCollapseAsk(null);
    setVal({ ...base, split: false, kHead: k, kTail: k });
  };

  if (!val || !modes) return <div style={{ padding: 20, color: "rgba(255,255,255,0.5)" }}>Loading…</div>;

  // Auto-split: in Learn-k mode once both directions qualify, split is forced.
  const autoSplit = modes.kMode === "learn" && !!(tuning.learned && tuning.learned.autoSplit);
  const effSplit = autoSplit || val.split;

  return (
    <div style={{ padding: "4px 16px 16px", borderTop: "1px solid rgba(255,255,255,0.1)" }}>
      <label style={lbl}>Route name</label>
      <input value={name} onChange={(e) => { setName(e.target.value); if (nameErr) setNameErr(null); }} disabled={route.isExample}
        style={{ ...INP, ...(route.isExample ? { opacity: 0.5, cursor: "not-allowed" } : {}), ...(nameErr ? { borderColor: "#e8927c" } : {}) }} />
      {nameErr && <div style={{ fontSize: 12.5, color: "#e8927c", marginTop: 6, lineHeight: 1.4 }}>{nameErr}</div>}

      <label style={{ ...lbl, marginTop: 12 }}>{timeMode === "depart" ? "Departure time" : "Target arrival"}</label>
      <TimeField value={arrival} onChange={setArrival} />

      <label style={{ ...lbl, marginTop: 12 }}>Active days</label>
      <div style={{ display: "flex", gap: 6 }}>
        {DAY_CODES.map(([c, l], i) => (
          <button key={i} onClick={() => toggleDay(c)} style={{
            flex: 1, padding: "9px 0", borderRadius: 10, cursor: "pointer", fontFamily: "inherit", fontSize: 13, fontWeight: 600,
            border: `1px solid ${days.includes(c) ? "#e0a45e" : "rgba(255,255,255,0.16)"}`,
            background: days.includes(c) ? "rgba(224,164,94,0.18)" : "transparent",
            color: days.includes(c) ? "#fff" : "rgba(255,255,255,0.45)",
          }}>{l}</button>
        ))}
      </div>

      <label style={{ ...lbl, marginTop: 12 }}>Time mode</label>
      <div style={{ display: "flex", gap: 6 }}>
        {[["arrive", "Arrive by"], ["depart", "Depart at"]].map(([m, l]) => (
          <button key={m} onClick={() => setTimeMode(m)} style={{
            flex: 1, padding: "10px 0", borderRadius: 10, cursor: "pointer", fontFamily: "inherit", fontSize: 13.5, fontWeight: 600,
            border: `1px solid ${timeMode === m ? "#e0a45e" : "rgba(255,255,255,0.16)"}`,
            background: timeMode === m ? "rgba(224,164,94,0.18)" : "transparent",
            color: timeMode === m ? "#fff" : "rgba(255,255,255,0.45)",
          }}>{l}</button>
        ))}
      </div>

      {/* Tuning: speed + terrain, each with its own Manual/Learn switch */}
      <div style={{ marginTop: 18, padding: "14px 14px", borderRadius: 12, background: "rgba(0,0,0,0.18)" }}>
        <RouteMap polyline={tuning.polyline} />
        {tuning.stats && (
          <div style={{ display: "flex", gap: 18, marginBottom: 14, paddingBottom: 12, borderBottom: "1px solid rgba(255,255,255,0.1)" }}>
            <Stat label="Distance" value={formatDistance(tuning.stats.totalDistance / 1000, undefined, { dp: 2 })} />
            <Stat label="Elevation gain" value={tuning.stats.hasElevation ? formatElevation(tuning.stats.climb) : "—"} />
            <Stat label="Points" value={tuning.stats.pointCount} />
          </div>
        )}
        <TerrainControls distanceM={tuning.distanceM}
          value={{ ...val, split: effSplit }}
          onChange={onTuningChange}
          modes={modes} onModeChange={onModeChange}
          learned={tuning.learned} example={tuning.example}
          autoSplit={autoSplit} />

        {/* Split-off: which value to keep. Sits right below the split control that
            triggered it, above Apply/Cancel — not at the bottom of the card. */}
        {collapseAsk && (
          <div style={{ marginTop: 14, padding: "12px 14px", borderRadius: 12, background: "rgba(0,0,0,0.25)", border: "1px solid rgba(255,255,255,0.18)" }}>
            <div style={{ fontSize: 13, color: "rgba(255,255,255,0.8)", marginBottom: 10 }}>Keep which ground effect setting for both directions?</div>
            <div style={{ display: "flex", gap: 8 }}>
              <button onClick={() => resolveCollapse("head")} style={backupBtn}>Headwind</button>
              <button onClick={() => resolveCollapse("tail")} style={backupBtn}>Tailwind</button>
              <button onClick={() => setCollapseAsk(null)} style={{ ...backupBtn, flex: 0.6 }}>Cancel</button>
            </div>
          </div>
        )}

        {/* Apply / Cancel sit above View rides. Apply persists but does NOT
            close the editor (close by tapping the chip, opening another route,
            or switching tab). Both disable until the next change. */}
        <div style={{ display: "flex", gap: 10, marginTop: 16 }}>
          <button onClick={revert} disabled={!dirty}
            style={{ ...backupBtn, opacity: dirty ? 1 : 0.4, cursor: dirty ? "pointer" : "default" }}>Cancel</button>
          <button onClick={apply} disabled={!dirty}
            style={{ flex: 1, padding: 13, borderRadius: 12, border: "none", fontFamily: "'Fraunces',serif", fontSize: 15, fontWeight: 600, background: "#e0a45e", color: "#1a1f3a", opacity: dirty ? 1 : 0.4, cursor: dirty ? "pointer" : "default" }}>Apply</button>
        </div>

        {!route.isExample && (
          <>
            <button onClick={() => setRidesOpen((o) => !o)} style={{
              width: "100%", marginTop: 14, padding: "11px 0", borderRadius: 10, cursor: "pointer",
              fontFamily: "inherit", fontSize: 13.5, fontWeight: 600, display: "flex", alignItems: "center", justifyContent: "center", gap: 8,
              border: "1px solid rgba(255,255,255,0.18)", background: "rgba(255,255,255,0.06)", color: "rgba(255,255,255,0.85)",
            }}>
              <span>View rides</span>
              <span style={{ fontSize: 11, transform: ridesOpen ? "rotate(180deg)" : "none", transition: "transform 0.15s" }}>▼</span>
            </button>
            {ridesOpen && (
              <RidesManager route={route} controller={controller}
                reloadKey={applyTick} onRidesChanged={loadTuning} />
            )}
          </>
        )}
      </div>

      {/* Delete route entirely (disabled for the ephemeral example) */}
      <div style={{ display: "flex", gap: 10, marginTop: 16 }}>
        {route.isExample ? (
          <button disabled style={{ ...backupBtn, color: "#f0a08c", borderColor: "rgba(224,120,94,0.4)", opacity: 0.4, cursor: "not-allowed" }}>Delete route</button>
        ) : !confirmDel ? (
          <button onClick={() => setConfirmDel(true)} style={{ ...backupBtn, color: "#f0a08c", borderColor: "rgba(224,120,94,0.4)" }}>Delete route</button>
        ) : (
          <>
            <span style={{ flex: 1, alignSelf: "center", fontSize: 13, color: "#f0b8a8" }}>Delete this route and its rides?</span>
            <button onClick={() => setConfirmDel(false)} style={backupBtn}>Cancel</button>
            <button onClick={del} style={{ ...backupBtn, background: "rgba(224,120,94,0.9)", color: "#fff", border: "none" }}>Delete</button>
          </>
        )}
      </div>
    </div>
  );
}

const backupBtn = { flex: 1, padding: "11px 14px", borderRadius: 12, cursor: "pointer", fontFamily: "inherit", fontSize: 13.5, fontWeight: 600, background: "rgba(255,255,255,0.08)", color: "#fff", border: "1px solid rgba(255,255,255,0.18)" };
const lbl = { display: "block", fontSize: 12.5, color: "rgba(255,255,255,0.6)", margin: "0 0 6px" };

/* ============================================================================
 * RouteRecorder — record a new route by GPS. Mirrors ride capture (elapsed,
 * live distance/speed, pause) but with NO end detection and NO progress/map.
 * Keep-alive: screen Wake Lock + a near-silent looping audio element so the
 * browser doesn't suspend watchPosition when the screen locks / app backgrounds.
 * On Finish, hands the raw traversal up via onRecorded (the parent gates it).
 * ========================================================================== */
function RouteRecorder({ controller, onCancel, onRecorded }) {
  const [state, setState] = useState("armed"); // armed | recording | blocked
  const [blocked, setBlocked] = useState(null); // gate-failure message
  const [gpsError, setGpsError] = useState(null); // {code,message} when geolocation fails
  const [confirmFinish, setConfirmFinish] = useState(false); // guard against an accidental Finish tap
  const [elapsed, setElapsed] = useState(0);
  const [paused, setPaused] = useState(false);
  const [live, setLive] = useState({ distanceM: 0, speedKmh: 0, avgKmh: 0 });
  const [nowMs, setNowMs] = useState(Date.now());
  const ref = useRef({});
  const emaRef = useRef({ speedMps: 0, lastT: null, lastDistM: 0 });
  // Wake Lock only: keep the screen on (and thus the document visible) so GPS
  // keeps delivering. There is deliberately no audio/MediaSession keep-alive —
  // the Geolocation spec gates watchPosition on document visibility, and screen
  // lock makes the document hidden, so NO web-app keep-alive can record GPS in
  // the background; audio would only cost battery and a media notification for
  // no benefit. The recorder tells the user to keep the app visible instead.
  const wakeRef = useRef(null);
  const acquireWake = async () => {
    try {
      if (navigator.wakeLock && !wakeRef.current) {
        wakeRef.current = await navigator.wakeLock.request("screen");
        wakeRef.current.addEventListener?.("release", () => { wakeRef.current = null; });
      }
    } catch { /* wake lock unavailable or denied; harmless */ }
  };
  const releaseWake = () => { try { wakeRef.current?.release?.(); } catch {} wakeRef.current = null; };
  useEffect(() => {
    const onVis = () => { if (document.visibilityState === "visible" && state === "recording" && !paused) acquireWake(); };
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  }, [state, paused]);

  useEffect(() => () => { releaseWake(); ref.current.handle?.stop?.(); }, []);

  useEffect(() => {
    if (state !== "recording" || paused) return;
    const id = setInterval(() => setElapsed((e) => e + 1), 1000);
    return () => clearInterval(id);
  }, [state, paused]);
  useEffect(() => {
    if (state !== "recording") return;
    const id = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(id);
  }, [state]);

  const begin = async () => {
    setState("recording"); setElapsed(0); setPaused(false); setGpsError(null);
    setLive({ distanceM: 0, speedKmh: 0, avgKmh: 0, initialising: true, initPct: null });
    emaRef.current = { speedMps: 0, lastFixT: null, lastAccM: null, lastSpeedAccM: null, warmed: false, warmDistM: 0, warmSec: null, bestAccM: null };
    acquireWake();
    const handle = await controller.recordRoute({
      onError: (e) => { setGpsError(e || { code: 2 }); },
      onTick: ({ elapsedSec, distanceM, speedMps, gpsSpeedMps, speedAccMps, fixT, accuracyM }) => {
        setElapsed(elapsedSec);
        setGpsError(null); // a fix arrived → clear any prior error (no-op if already null)
        // Needle smoothing identical to ride capture: smooth the controller's
        // per-fix speed with the variance-weighted EMA, dt measured between GPS
        // fix timestamps (not Date.now()), warm-up gate, accel jump-limiter (A)
        // and dt cap (B). See the ride-capture tick for the rationale.
        const em = emaRef.current;
        const needleUsable = accuracyM == null || accuracyM <= GPS_ACCURACY_HARD_M;
        if (em.lastFixT != null && needleUsable) {
          const dt = fixT - em.lastFixT;
          if (!em.warmed && accuracyM != null && accuracyM <= NEEDLE_WARMUP_ACC_M) {
            em.warmed = true;
            // Anchor the average here (as in ride capture): acquisition-phase
            // distance over a near-zero elapsed otherwise reads as ~40 km/h.
            em.warmDistM = distanceM;
            em.warmSec = elapsedSec;
          }
          if (dt > 0 && em.warmed) {
            const useDoppler = gpsSpeedMps != null && gpsSpeedMps >= 0;
            // 1) instantaneous sample — device Doppler speed when available,
            //    else position-derived. Same needle pipeline as ride capture.
            let instMps = useDoppler ? gpsSpeedMps : Math.max(0, speedMps || 0);
            if (instMps > SPEED_SANE_MAX_MPS) instMps = useDoppler ? SPEED_SANE_MAX_MPS : 0;
            // 2) acceleration clamp (source-agnostic physical bound)
            const maxDelta = NEEDLE_MAX_ACCEL_MPS2 * (dt / 1000);
            instMps = Math.max(em.speedMps - maxDelta, Math.min(em.speedMps + maxDelta, instMps));
            // 3) adaptive τ from the source-appropriate accuracy, ×NEEDLE_TAU_SCALE
            const baseTau = useDoppler
              ? ((speedAccMps != null || em.lastSpeedAccM != null)
                  ? needleTauMsFromSpeedAcc(em.lastSpeedAccM, speedAccMps)
                  : needleTauMs(em.lastAccM, accuracyM))
              : needleTauMs(em.lastAccM, accuracyM);
            const tau = baseTau * NEEDLE_TAU_SCALE;
            em.speedMps = emaStep(em.speedMps, instMps, Math.min(dt, NEEDLE_MAX_DT_MS), tau);
            em.lastSpeedAccM = speedAccMps != null ? speedAccMps : em.lastSpeedAccM;
          }
        }
        if (needleUsable || em.lastFixT == null) { em.lastFixT = fixT; em.lastAccM = accuracyM; }
        // Track the best (lowest) accuracy seen for the "GPS initialising" readout
        // shown during warm-up. The pseudo-percentage 8/best×100 approaches 100 as
        // fixes sharpen; monotonic (best only improves) so it never ticks backward.
        if (accuracyM != null && (em.bestAccM == null || accuracyM < em.bestAccM)) em.bestAccM = accuracyM;
        const initPct = em.bestAccM != null ? Math.min(100, Math.round((NEEDLE_WARMUP_ACC_M / em.bestAccM) * 100)) : null;
        // Average from the warm-up anchor (0 until warmed), same as ride capture.
        let avgKmh = 0;
        if (em.warmed && em.warmSec != null) {
          const dSec = elapsedSec - em.warmSec;
          const dDist = distanceM - em.warmDistM;
          if (dSec > 0 && dDist > 0) avgKmh = (dDist / dSec) * 3.6;
        }
        setLive({ distanceM, speedKmh: (em.speedMps || 0) * 3.6, avgKmh, initialising: !em.warmed, initPct });
      },
    }).catch((e) => { alert(e.message); setState("armed"); releaseWake(); });
    handle?.onFinish?.((rec) => {
      releaseWake();
      // Gate the trace here so we own the blocked UI (with a Cancel path). On a
      // good recording, hand it up; on a blocked one, show why + let the user
      // record again or cancel out entirely.
      const res = controller.previewTrace(rec.trace);
      if (res.ok) { onRecorded(rec, res); }
      else { setBlocked(res.reason); setState("blocked"); }
    });
    ref.current = { handle };
  };
  const togglePause = () => {
    const h = ref.current.handle; if (!h) return;
    if (paused) { h.resume?.(); setPaused(false); acquireWake(); }
    else { h.pause?.(); setPaused(true); releaseWake(); }
  };
  const finish = () => setConfirmFinish(true);
  const doFinish = () => { setConfirmFinish(false); ref.current.handle?.manualFinish?.(); };
  const avg = Math.round((live.avgKmh || 0) * 2) / 2;

  if (state === "blocked") {
    // Recording couldn't form a usable route — offer re-record or cancel.
    return (
      <div style={{ padding: "0 22px" }}>
        <div style={{ padding: "16px 16px", borderRadius: 14, background: "rgba(217,83,79,0.12)", border: "1px solid rgba(217,83,79,0.4)", color: "#f0b9b2", fontSize: 14, lineHeight: 1.5, marginBottom: 16 }}>
          {blocked}
        </div>
        <div style={{ display: "flex", gap: 12 }}>
          <button onClick={onCancel} style={backupBtn}>Cancel</button>
          <button onClick={begin} style={{ ...backupBtn, background: "#e0a45e", color: "#1a1f3a", border: "none" }}>Record again</button>
        </div>
      </div>
    );
  }

  if (state === "recording") {
    // Full black instrument screen, identical to ride capture. Differences per
    // spec: center line reads "Recording new route" (red) in place of the
    // off-route message; the bottom slot shows km recorded (no progress bar); no
    // arrival marker (arrivalMs null); no what-to-expect caption.
    return (
      <div style={{ position: "fixed", inset: 0, zIndex: 50, background: "#000", color: "#fff", display: "flex", flexDirection: "column", padding: "16px 14px 20px" }}>
        <InstrumentPanel
          elapsed={elapsed} paused={paused} avg={avg}
          nowMs={nowMs} arrivalMs={null} speedKmh={live.speedKmh}
          centerMessage={gpsError
            ? { text: gpsError.code === 1 ? "Location permission denied" : gpsError.code === 3 ? "GPS timed out — no signal" : "GPS not available", color: "#d9534f" }
            : (live.initialising
              ? { text: live.initPct != null ? `GPS initialising ${live.initPct}%` : "GPS initialising…", color: "#e0a45e" }
              : { text: "Recording new route", color: "#d9534f" })}
          onPause={togglePause} onFinish={finish} finishLabel="Finish"
          bottom={<div style={{ textAlign: "center", fontFamily: "'Fraunces',serif", fontSize: 18, fontWeight: 600 }}>{formatDistance(live.distanceM / 1000, undefined, { dp: 2 })}</div>}
        />
        {confirmFinish && (
          <div style={{ position: "absolute", inset: 0, zIndex: 60, display: "grid", placeItems: "center", background: "rgba(0,0,0,0.6)", padding: 28 }}>
            <div style={{ maxWidth: 320, background: "#1d1b38", borderRadius: 18, padding: "22px 22px", border: "1px solid rgba(255,255,255,0.14)", textAlign: "center" }}>
              <div style={{ fontFamily: "'Fraunces',serif", fontSize: 19, fontWeight: 600, marginBottom: 8 }}>Finish recording?</div>
              <div style={{ fontSize: 14, color: "rgba(255,255,255,0.7)", lineHeight: 1.5, marginBottom: 18 }}>
                Stop recording and use this route? Only do this once you've reached the end of your route.
              </div>
              <div style={{ display: "flex", gap: 10 }}>
                <button onClick={() => setConfirmFinish(false)} style={{ flex: 1, padding: 12, borderRadius: 12, cursor: "pointer", fontFamily: "inherit", fontSize: 14, fontWeight: 600, background: "rgba(255,255,255,0.1)", color: "#fff", border: "1px solid rgba(255,255,255,0.18)" }}>Keep recording</button>
                <button onClick={doFinish} style={{ flex: 1, padding: 12, borderRadius: 12, cursor: "pointer", fontFamily: "'Fraunces',serif", fontSize: 14, fontWeight: 600, background: "#d9534f", color: "#fff", border: "none" }}>Finish</button>
              </div>
            </div>
          </div>
        )}
      </div>
    );
  }

  return (
    <div style={{ padding: "0 22px" }}>
      <div style={{ fontSize: 13.5, color: "rgba(255,255,255,0.65)", lineHeight: 1.5, marginBottom: 14 }}>
        Start at the beginning of your route, then ride it once. Keep the app open — tap Finish when you arrive.
      </div>
      <div style={{ fontSize: 13, color: "rgba(255,255,255,0.8)", lineHeight: 1.5, marginBottom: 18, padding: "12px 14px", borderRadius: 12, background: "rgba(224,164,94,0.12)", border: "1px solid rgba(224,164,94,0.35)" }}>
        Keep this app open and visible while recording. The ability to record GPS data in the background is not currently available. (It is a possible future enhancement.)
      </div>
      <button onClick={begin} style={{ width: "100%", padding: 15, borderRadius: 14, cursor: "pointer", fontFamily: "'Fraunces',serif", fontSize: 16, fontWeight: 600, background: "#e0a45e", color: "#1a1f3a", border: "none" }}>Start recording</button>
    </div>
  );
}

/* A single tappable creation-method card in the New route chooser. */
function MethodOption({ title, desc, onClick, disabled }) {
  return (
    <button onClick={disabled ? undefined : onClick} disabled={disabled} style={{
      display: "block", width: "100%", textAlign: "left", marginBottom: 10, padding: "15px 16px", borderRadius: 14,
      cursor: disabled ? "default" : "pointer", opacity: disabled ? 0.5 : 1,
      fontFamily: "inherit", color: "#fff",
      background: "rgba(255,255,255,0.07)", border: "1px solid rgba(255,255,255,0.16)",
    }}>
      <div style={{ fontFamily: "'Fraunces',serif", fontSize: 16, fontWeight: 600 }}>{title}</div>
      <div style={{ fontSize: 12.5, color: "rgba(255,255,255,0.55)", marginTop: 4, lineHeight: 1.4 }}>{desc}</div>
    </button>
  );
}

/* ============================================================================
 * Setup — create a route: choose a method (record / reverse / GPX), then the
 * shared details form (name, tuning, schedule).
 * ========================================================================== */
function Setup({ controller, onDone, onCancel }) {
  const [method, setMethod] = useState(null); // null=chooser, "gpx", "reverse"
  const [gpxText, setGpxText] = useState(null);
  const [processed, setProcessed] = useState(null); // reverse/record path: pre-built geometry
  const [recording, setRecording] = useState(null); // record path: the raw traversal (for first-ride logging)
  const [preview, setPreview] = useState(null);
  const [err, setErr] = useState(null);
  const [routeList, setRouteList] = useState(null); // for the reverse picker
  const [form, setForm] = useState({ name: "", speedKmh: 16, kHead: DEFAULT_K, kTail: DEFAULT_K, split: false, arrival: "08:45", timeMode: "arrive", days: ["MO", "TU", "WE", "TH", "FR"] });
  // Tuning modes default to learn/learn (the new-route default), toggleable here
  // for consistency with the route editor. At setup there are no rides, so learn
  // controls fall back to the sliders and read "using your setting until enough
  // rides recorded" — the same behaviour the editor shows for a starved route.
  const [modes, setModes] = useState({ baselineMode: "learn", kMode: "learn" });
  const [saving, setSaving] = useState(false);
  const fileRef = useRef();
  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));
  const onModeChange = (which, m) => setModes((p) => ({ ...p, [which]: m }));

  const onFile = async (file) => {
    setErr(null);
    try {
      const text = await file.text();
      const p = await controller.previewGpx(text);
      setGpxText(text); setProcessed(null); setPreview(p);
      if (!form.name) set("name", file.name.replace(/\.gpx$/i, "").replace(/[_-]/g, " "));
    } catch (e) { setErr(e.message); }
  };

  // Reverse path: pick a source route → preview reversed geometry + pre-fill the
  // details form from the source's inherited config.
  const chooseReverse = async () => {
    setErr(null); setMethod("reverse");
    try { setRouteList(await controller.listRoutes()); }
    catch (e) { setErr(e.message); }
  };
  const pickSource = async (sourceId) => {
    setErr(null);
    try {
      const r = await controller.previewReverse(sourceId);
      setProcessed({ ...r.processed, sourceId });
      setGpxText(null);
      setPreview(r.preview);
      const d = r.defaults;
      setForm((f) => ({ ...f, name: d.name, speedKmh: d.speedKmh, kHead: d.kHead, kTail: d.kTail, split: d.split,
        arrival: d.targetArrival ?? f.arrival, timeMode: d.timeMode ?? f.timeMode }));
      setModes({ baselineMode: d.baselineMode, kMode: d.kMode });
    } catch (e) { setErr(e.message); }
  };

  const valid = preview && form.name.trim() && form.speedKmh > 0 && form.days.length;
  const save = async () => {
    setErr(null);
    setSaving(true);
    const baselineSec = preview.totalDistance / (form.speedKmh / 3.6);
    const setup = {
      name: form.name.trim(),
      seedStillAirSec: Math.round(baselineSec),
      // v2 forward map: seed time = still·(1 + f_branch(k·20)); exact
      // counterpart of seedKSplit's inverse so slider k round-trips.
      seedHeadwind20Sec: Math.round(baselineSec * (1 + effortNorm(form.kHead * 20))),
      seedTailwind20Sec: Math.round(baselineSec * (1 + effortNorm(-form.kTail * 20))),
      baselineMode: modes.baselineMode, kMode: modes.kMode, split: form.split,
      targetArrival: form.arrival, timeMode: form.timeMode, activeDays: form.days,
    };
    try {
      if (recording) {
        const res = await controller.finalizeRecordedRoute(recording, setup);
        if (!res.ok) { setErr(res.reason || "Recording couldn't be used."); setSaving(false); return; }
      } else if (processed) {
        await controller.createRouteFromProcessed(processed, setup);
      } else {
        await controller.createRoute(gpxText, setup);
      }
      onDone();
    } catch (e) {
      setErr(e.message || "Couldn't save the route.");
      setSaving(false);
    }
  };
  const toggleDay = (d) => set("days", form.days.includes(d) ? form.days.filter((x) => x !== d) : [...form.days, d]);

  const back = () => {
    // Back steps: preview → method's picker; picker → chooser; chooser → cancel.
    if (preview) { setPreview(null); setProcessed(null); setGpxText(null); setRecording(null); return; }
    if (method) { setMethod(null); setErr(null); return; }
    onCancel && onCancel();
  };

  return (
    <div style={{ height: "100%", overflowY: "auto", background: "linear-gradient(165deg,#12152b,#1d1b38 55%,#281f44)", color: "#fff", paddingBottom: 30 }}>
      <div style={{ padding: "26px 22px 8px", display: "flex", alignItems: "center", gap: 12 }}>
        <button onClick={back} style={{ background: "transparent", border: "none", cursor: "pointer", color: "rgba(255,255,255,0.6)", fontSize: 22, padding: 0, lineHeight: 1 }} aria-label="Back">‹</button>
        <span style={{ fontFamily: "'Fraunces',serif", fontSize: 26, fontWeight: 600 }}>New route</span>
      </div>
      <div style={{ padding: "0 22px 16px", fontSize: 13.5, color: "rgba(255,255,255,0.55)" }}>Each destination needs two routes, one going and one returning.</div>

      {/* Step 1: method chooser */}
      {method === null && (
        <div style={{ padding: "0 22px" }}>
          <MethodOption title="Record with GPS" desc="Ride the route once and let your phone trace it."
            onClick={() => { setMethod("record"); setErr(null); }} />
          <MethodOption title="Reverse an existing route" desc="Create the return trip from a route you already have."
            onClick={chooseReverse} />
          <MethodOption title="Import a GPX file" desc="Load a route exported from another app or a mapping site."
            onClick={() => { setMethod("gpx"); setErr(null); }} />
          {err && <Warn>{err}</Warn>}
        </div>
      )}

      {/* Step 2a: reverse — pick which route to reverse */}
      {method === "reverse" && !preview && (
        <div style={{ padding: "0 22px" }}>
          <div style={{ fontSize: 13.5, color: "rgba(255,255,255,0.6)", marginBottom: 12 }}>Which route do you want to reverse?</div>
          {routeList == null ? (
            <div style={{ color: "rgba(255,255,255,0.5)" }}>Loading…</div>
          ) : routeList.filter((r) => !r.isExample).length === 0 ? (
            <div style={{ padding: "18px 14px", textAlign: "center", color: "rgba(255,255,255,0.55)", border: "1px dashed rgba(255,255,255,0.16)", borderRadius: 12, lineHeight: 1.5 }}>
              No routes to reverse yet. Record a route or import a GPX file first, then you can create its return trip.
            </div>
          ) : (
            routeList.filter((r) => !r.isExample).map((r) => (
              <button key={r.id} onClick={() => pickSource(r.id)} style={{
                display: "block", width: "100%", textAlign: "left", marginBottom: 8, padding: "13px 15px", borderRadius: 12, cursor: "pointer",
                fontFamily: "inherit", fontSize: 14.5, fontWeight: 600, color: "#fff",
                background: "rgba(255,255,255,0.07)", border: "1px solid rgba(255,255,255,0.16)",
              }}>{r.name}
                <span style={{ display: "block", fontSize: 12, fontWeight: 400, color: "rgba(255,255,255,0.5)", marginTop: 3 }}>{formatDistance(r.totalDistance / 1000)}</span>
              </button>
            ))
          )}
          {err && <Warn>{err}</Warn>}
        </div>
      )}

      {/* Step 2c: record by GPS */}
      {method === "record" && !preview && (
        <RouteRecorder controller={controller}
          onCancel={() => { setMethod(null); setErr(null); }}
          onRecorded={(rec, res) => {
            // res = { ok:true, processed, preview } from the recorder's gate.
            setRecording(rec);
            setProcessed(res.processed);
            setPreview(res.preview);
            if (!form.name) set("name", "");
          }} />
      )}

      {/* Step 2b: GPX loader (reached via the chooser) */}
      {method === "gpx" && !preview && (
        <Block n="1" title="Load GPX">
          <div onClick={() => fileRef.current.click()} style={{
            padding: "28px 18px", borderRadius: 16, textAlign: "center", cursor: "pointer",
            border: "1.5px dashed rgba(255,255,255,0.28)", background: "rgba(255,255,255,0.04)",
          }}>
            <div style={{ fontSize: 15, fontWeight: 500 }}>Tap to choose a .gpx file</div>
            <input ref={fileRef} type="file" accept=".gpx" hidden onChange={(e) => e.target.files[0] && onFile(e.target.files[0])} />
          </div>
          {err && <Warn>{err}</Warn>}
        </Block>
      )}

      {/* Step 3: shared details form (both GPX and reverse land here) */}
      {preview && (
        <>
          <Block n="1" title="Route">
            <div style={{ borderRadius: 16, padding: 16, background: "rgba(255,255,255,0.07)", border: "1px solid rgba(255,255,255,0.14)" }}>
              <RouteMap polyline={preview.polyline} />
              <div style={{ display: "flex", gap: 18 }}>
                <Stat label="Distance" value={formatDistance(preview.totalDistance / 1000, undefined, { dp: 2 })} />
                <Stat label="Elevation gain" value={preview.hasElevation ? formatElevation(preview.climb) : "—"} />
                <Stat label="Points" value={preview.pointCount} />
              </div>
              {preview.warnings?.map((w, i) => <Warn key={i}>{w}</Warn>)}
            </div>
          </Block>
          <Block n="2" title="Name">
            <input value={form.name} onChange={(e) => set("name", e.target.value)} placeholder="Home → Office" style={INP} />
          </Block>
          <Block n="3" title="Ride times">
            <TerrainControls distanceM={preview.totalDistance}
              value={{ speedKmh: form.speedKmh, kHead: form.kHead, kTail: form.kTail, split: form.split }}
              modes={modes}
              onModeChange={onModeChange} learned={null} autoSplit={false}
              onChange={(next) => {
                if (next._collapse) {
                  // collapsing the split: keep the headwind value (no rides yet,
                  // so no learned values to arbitrate — no confirm needed)
                  setForm((f) => ({ ...f, split: false, kHead: f.kHead, kTail: f.kHead }));
                  return;
                }
                setForm((f) => ({ ...f, speedKmh: next.speedKmh, kHead: next.kHead, kTail: next.kTail, split: next.split }));
              }} example={preview.example} />
          </Block>
          <Block n="4" title="When you ride">
            <div style={{ display: "flex", gap: 8, marginBottom: 10 }}>
              {[["arrive", "Arrive by"], ["depart", "Depart at"]].map(([m, label]) => (
                <button key={m} onClick={() => set("timeMode", m)} style={{
                  flex: 1, padding: "10px 0", borderRadius: 10, cursor: "pointer", fontFamily: "inherit", fontSize: 13, fontWeight: 600,
                  border: "none", background: form.timeMode === m ? "#e0a45e" : "rgba(255,255,255,0.1)",
                  color: form.timeMode === m ? "#1a1f3a" : "rgba(255,255,255,0.8)",
                }}>{label}</button>
              ))}
            </div>
            <div style={{ fontSize: 12.5, color: "rgba(255,255,255,0.5)", marginBottom: 8 }}>
              {form.timeMode === "arrive"
                ? "Fixed arrival — we tell you when to leave."
                : "Fixed departure (e.g. end of work) — we tell you when you'll arrive."}
            </div>
            <TimeField value={form.arrival} onChange={(v) => set("arrival", v)} />
            <div style={{ display: "flex", gap: 6, marginTop: 12 }}>
              {[["MO", "M"], ["TU", "T"], ["WE", "W"], ["TH", "T"], ["FR", "F"], ["SA", "S"], ["SU", "S"]].map(([c, l], i) => (
                <button key={i} onClick={() => toggleDay(c)} style={{
                  flex: 1, padding: "10px 0", borderRadius: 10, cursor: "pointer", fontFamily: "inherit", fontSize: 13, fontWeight: 600,
                  border: `1px solid ${form.days.includes(c) ? "#e0a45e" : "rgba(255,255,255,0.16)"}`,
                  background: form.days.includes(c) ? "rgba(224,164,94,0.18)" : "transparent",
                  color: form.days.includes(c) ? "#fff" : "rgba(255,255,255,0.45)",
                }}>{l}</button>
              ))}
            </div>
          </Block>
          <div style={{ padding: "8px 22px 0" }}>
            {err && <Warn>{err}</Warn>}
            <button onClick={save} disabled={!valid || saving} style={{
              width: "100%", padding: 16, borderRadius: 16, border: "none", cursor: valid ? "pointer" : "default",
              fontFamily: "'Fraunces',serif", fontSize: 17, fontWeight: 600,
              background: valid ? "#e0a45e" : "rgba(255,255,255,0.12)", color: valid ? "#1a1f3a" : "rgba(255,255,255,0.35)",
            }}>{saving ? "Saving…" : valid ? "Save route" : "Fill required fields"}</button>
          </div>
        </>
      )}
    </div>
  );
}

/* ============================================================================
 * Live ride instruments (SVG). White-on-black; amber for active indicators.
 * Pure-math helpers live in lib/rideReadout.js.
 * ========================================================================== */
function AnalogClock({ nowMs, arrivalMs, size = 150 }) {
  const c = size / 2, r = c - 6;
  const a = clockAngles(nowMs);
  const hand = (angle, len, w, color) => {
    const p = polarPoint(c, c, len, angle);
    return <line x1={c} y1={c} x2={p.x} y2={p.y} stroke={color} strokeWidth={w} strokeLinecap="round" />;
  };
  const ticks = [];
  for (let i = 0; i < 12; i++) {
    const ang = i * 30;
    const heavy = i % 3 === 0;
    const o = polarPoint(c, c, r, ang);
    const inr = polarPoint(c, c, r - (heavy ? 11 : 7), ang);
    ticks.push(<line key={i} x1={o.x} y1={o.y} x2={inr.x} y2={inr.y} stroke="#fff" strokeWidth={heavy ? 2.4 : 1.2} strokeLinecap="round" opacity={heavy ? 0.95 : 0.78} />);
  }
  const bz = arrivalBezel(nowMs, arrivalMs);
  let marker = null;
  if (bz != null) {
    // The amber marker always sits at the exact arrival minute. When arrival is
    // ≥ 1 h away (not imminent) an OPAQUE grey marker is overlaid a fixed 12°
    // (=2 min) clockwise so the amber peeks out beneath it — this signals the
    // "1 h+" case that a 12-hour dial can't otherwise show. If ≥ 2 h away, the
    // whole-hours count is printed in black inside the grey marker.
    const triAt = (angle, fill) => {
      const tip = polarPoint(c, c, r + 3, angle);
      const baseL = polarPoint(c, c, r + 15, angle - 6);
      const baseR = polarPoint(c, c, r + 15, angle + 6);
      return <polygon points={`${tip.x},${tip.y} ${baseL.x},${baseL.y} ${baseR.x},${baseR.y}`} fill={fill} />;
    };
    const amber = triAt(bz.angle, "#e0a45e");
    let grey = null, hoursLabel = null;
    if (!bz.imminent) {
      const gAng = bz.angle - 5; // fixed 5° anticlockwise offset so amber peeks out
      grey = triAt(gAng, "#8a8a8a"); // opaque grey, drawn over the amber
      if (bz.hoursAway >= 2) {
        // centroid-ish of the triangle, for the black hours integer
        const lbl = polarPoint(c, c, r + 10, gAng);
        hoursLabel = (
          <text x={lbl.x} y={lbl.y} fill="#000" fontSize={9} fontWeight={700}
            textAnchor="middle" dominantBaseline="central">{bz.hoursAway}</text>
        );
      }
    }
    marker = <g>{amber}{grey}{hoursLabel}</g>;
  }
  return (
    <svg viewBox={`-18 -18 ${size + 36} ${size + 36}`} width="100%" style={{ display: "block" }}>
      <circle cx={c} cy={c} r={r} fill="none" stroke="rgba(255,255,255,0.5)" strokeWidth={1.5} />
      {ticks}
      {marker}
      {hand(a.hour, r * 0.5, 3.2, "#fff")}
      {hand(a.minute, r * 0.78, 2.2, "#fff")}
      <circle cx={c} cy={c} r={3} fill="#e0a45e" />
    </svg>
  );
}

function Speedometer({ kmh, size = 230 }) {
  const c = size / 2, r = c - 14;
  const labels = [0, 10, 20, 30, 40];
  // The dial face is a FIXED 0–50 scale: tick marks and the 10/20/30/40 numbers
  // are literal and never change. Only the UNIT changes — so in mph mode "30"
  // means 30 mph. For the needle to agree with the numbers, its speed must be
  // expressed in the SAME unit as the dial before mapping to an angle: 30 km/h
  // (≈18.6 mph) must point near 18–19, not at the "30" mark. So we convert the
  // canonical km/h to the ride-speed unit here; the scale/labels stay put.
  const dialSpeed = canonicalKmhToRideSpeed(kmh || 0) || 0;
  const unitLabel = rideSpeedUnitLabel();
  const ticks = [];
  for (let v = 0; v <= SPEEDO_MAX_KMH; v += 1) {
    const ang = speedToAngle(v);
    const major = v % 10 === 0;
    if (!major) {
      // minor dots: one per 1 unit, set just inside the circle, separated from
      // it. The "5" dots (5,15,25,35) are white and a touch larger.
      const five = v % 5 === 0;
      const p = polarPoint(c, c, r - 9, ang);
      ticks.push(<circle key={`d${v}`} cx={p.x} cy={p.y} r={five ? 2.1 : 1.3} fill={five ? "#fff" : "rgba(255,255,255,0.5)"} />);
    } else {
      const o = polarPoint(c, c, r, ang);
      const inr = polarPoint(c, c, r - 14, ang);
      ticks.push(<line key={`t${v}`} x1={o.x} y1={o.y} x2={inr.x} y2={inr.y} stroke="#fff" strokeWidth={2.4} strokeLinecap="round" />);
    }
  }
  const nums = labels.map((v) => {
    const ang = speedToAngle(v);
    // Classic radial speedo: every number sits inside the rim at a uniform
    // radius, rotated to its gauge angle. Numbers whose angle falls in the lower
    // half (would read upside-down) get an extra 180° so they stay readable —
    // here that's 0 (225°) and 40 (135°).
    const norm = ((ang % 360) + 360) % 360;
    const upsideDown = norm > 90 && norm < 270;
    const rot = ang + (upsideDown ? 180 : 0);
    const p = polarPoint(c, c, r - 21.5, ang);
    return (
      <text key={`n${v}`} x={p.x} y={p.y} fill="#fff" fontSize={15} fontWeight={600}
        textAnchor="middle" dominantBaseline="central" fontFamily="'Fraunces',serif"
        transform={`rotate(${rot} ${p.x} ${p.y})`}>{v}</text>
    );
  });
  // Needle angle straight from the (EMA-smoothed) speed, expressed in the dial's
  // unit — no rounding. The EMA itself supplies the easing: each new target is an
  // asymptotic approach to the true speed, so the *sequence* of targets already
  // decelerates. A LINEAR CSS transition slightly longer than the ~1 s fix
  // cadence then connects consecutive fixes into one continuous glide (the needle
  // is always still moving when the next value arrives and retargets it).
  const needleAng = speedToAngle(dialSpeed);
  return (
    <svg viewBox={`0 0 ${size} ${size}`} width="100%" style={{ display: "block" }}>
      <circle cx={c} cy={c} r={r} fill="none" stroke="rgba(255,255,255,0.5)" strokeWidth={1.5} />
      {ticks}{nums}
      {/* Needle drawn pointing straight up, rotated to the speed angle; linear
          1.1 s transition connects fixes into one continuous sweep (easing comes
          from the EMA, not the CSS curve). */}
      <g style={{ transform: `rotate(${needleAng}deg)`, transformOrigin: `${c}px ${c}px`, transition: "transform 1.1s linear" }}>
        <line x1={c} y1={c + 12} x2={c} y2={c - (r - 6)} stroke="#e0a45e" strokeWidth={3.2} strokeLinecap="round" />
      </g>
      <circle cx={c} cy={c} r={6} fill="#e0a45e" />
      <text x={c} y={c + r * 0.5} fill="rgba(255,255,255,0.55)" fontSize={12} textAnchor="middle">{unitLabel}</text>
    </svg>
  );
}

/* ============================================================================
 * InstrumentPanel — the shared black instrument screen used by BOTH ride capture
 * and route recording. Layout: elapsed+avg top-left, analog clock top-right,
 * a center status line, the speedometer hero, Pause/Finish buttons, then a
 * bottom slot (progress bar / distance) and an optional caption line. All the
 * variable content is passed in so the two modes stay pixel-identical.
 * ========================================================================== */
function InstrumentPanel({
  elapsed, paused, avg, nowMs, arrivalMs, speedKmh,
  centerMessage, onPause, onFinish, finishLabel = "Finish now",
  bottom, caption, label = "Elapsed",
}) {
  const fmtC = fmtStopwatch;
  return (
    <div style={{ flex: 1, display: "flex", flexDirection: "column", padding: "6px 4px 0" }}>
      {/* top row: elapsed left, clock right */}
      <div style={{ display: "flex", alignItems: "flex-start", gap: 8 }}>
        <div style={{ flex: 1, textAlign: "left", paddingTop: 6, minWidth: 0 }}>
          <div style={{ fontSize: 11, color: "rgba(255,255,255,0.5)", letterSpacing: "0.04em", textTransform: "uppercase", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{paused ? "Paused" : label}</div>
          <div style={{ fontFamily: "'Fraunces',serif", fontSize: 40, fontWeight: 600, fontVariantNumeric: "tabular-nums", opacity: paused ? 0.55 : 1, lineHeight: 1.1 }}>{fmtC(elapsed)}</div>
          <div style={{ fontSize: 23, color: "#fff", marginTop: 6 }}>avg {formatRideSpeed(avg, undefined, { dp: 1 })}</div>
        </div>
        <div style={{ width: "48%" }}>
          <AnalogClock nowMs={nowMs} arrivalMs={arrivalMs} />
        </div>
      </div>
      {/* center status line (off-route message, or "Recording") */}
      {centerMessage && (
        <div style={{ textAlign: "center", paddingTop: 8, fontSize: 15, fontWeight: 600, fontFamily: "'Fraunces',serif", color: centerMessage.color || "#e0a45e" }}>
          {centerMessage.text}
        </div>
      )}
      {/* speedometer */}
      <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", minHeight: 0 }}>
        <div style={{ width: "96%", maxWidth: 380 }}>
          <Speedometer kmh={speedKmh} />
        </div>
      </div>
      {/* buttons */}
      <div style={{ display: "flex", gap: 12 }}>
        <button onClick={onPause} style={{ flex: 1, padding: 14, borderRadius: 14, cursor: "pointer", fontFamily: "'Fraunces',serif", fontSize: 15, fontWeight: 600, background: paused ? "#6fd49a" : "rgba(255,255,255,0.12)", color: paused ? "#0f2a1c" : "#fff", border: paused ? "none" : "1px solid rgba(255,255,255,0.25)" }}>
          {paused ? "Continue" : "Pause"}
        </button>
        <button onClick={onFinish} style={{ flex: 1, padding: 14, borderRadius: 14, cursor: "pointer", fontFamily: "'Fraunces',serif", fontSize: 15, fontWeight: 600, background: "#d9534f", color: "#fff", border: "none" }}>{finishLabel}</button>
      </div>
      {/* bottom slot: progress bar (ride, known total) or distance number */}
      <div style={{ margin: "18px 0 6px" }}>{bottom}</div>
      {/* optional caption (what-to-expect on a ride) */}
      {caption && (
        <div style={{ textAlign: "center", fontSize: 13, color: "rgba(255,255,255,0.7)", lineHeight: 1.4, minHeight: 18 }}>
          {caption}
        </div>
      )}
    </div>
  );
}

function ProgressBar({ travelledM, totalM }) {
  const frac = totalM > 0 ? Math.max(0, Math.min(1, travelledM / totalM)) : 0;
  return (
    <div style={{ width: "100%", height: 20, borderRadius: 10, background: "rgba(255,255,255,0.12)", position: "relative", overflow: "hidden" }}
      aria-label={`progress ${Math.round(frac * 100)}%`}>
      <div style={{ position: "absolute", left: 0, top: 0, bottom: 0, width: `${frac * 100}%`, background: "#e0a45e" }} />
    </div>
  );
}

/* ============================================================================
 * Capture — tap to start, auto-finish, confirm (real controller.recordRide)
 * ========================================================================== */
function Capture({ controller, route, onDone, onRecordingChange }) {
  const [state, setState] = useState("armed");
  const [elapsed, setElapsed] = useState(0);
  const [paused, setPaused] = useState(false);
  const [result, setResult] = useState(null);
  const [confirm, setConfirm] = useState(null);
  const [adjustMin, setAdjustMin] = useState(0); // minutes added/removed at review
  const [nowMs, setNowMs] = useState(Date.now());   // ticking clock for the dial
  const [live, setLive] = useState({ distanceM: 0, alongM: 0, offRoute: false, speedKmh: 0, avgKmh: 0 });
  const [endConfirm, setEndConfirm] = useState(null); // {metres} when far from end on finish
  const [arrivedConfirm, setArrivedConfirm] = useState(false); // auto-detector reached the end → confirm or keep riding
  const [expectLine, setExpectLine] = useState(null); // what-to-expect for the ride
  const [forecastSec, setForecastSec] = useState(null); // wind+learning-aware duration (leaving now), for first-km arrival
  const [farConfirm, setFarConfirm] = useState(null); // {metres} when far from start
  const [gpsError, setGpsError] = useState(null); // {code,message} when geolocation fails
  const ref = useRef({});
  // EMA state (persist across ticks). `emaRef` holds the smoothed needle speed
  // (~5s) and the smoothed arrival pace (~45min), plus the last tick's distance
  // and timestamp so we can derive per-interval pace and elapsed Δt.
  const emaRef = useRef({ speedMps: null, paceMps: null, lastT: null, lastDistM: 0 });

  // Report recording state up so App can lock navigation (hide the tab bar)
  // while a ride is in progress — including while paused. On unmount, clear it.
  useEffect(() => {
    onRecordingChange?.(state === "riding");
  }, [state, onRecordingChange]);
  useEffect(() => () => onRecordingChange?.(false), [onRecordingChange]);

  // Screen Wake Lock only: keep the screen on while the rider is watching the
  // live readouts. Deliberately NO audio/MediaSession keep-alive here — for a
  // ride on a KNOWN route, GPS with the screen off would only feed live readouts
  // the rider isn't looking at; the final time/average reconstructs adequately
  // from distance-since-last-fix even with sparse fixes, so it isn't worth the
  // battery/audio-focus cost. (New-route RECORDING is different — there the
  // geometry itself depends on the fixes, so it uses the full keep-alive hook.)
  const wakeRef = useRef(null);
  const acquireWake = async () => {
    try {
      if (navigator.wakeLock && !wakeRef.current) {
        wakeRef.current = await navigator.wakeLock.request("screen");
        wakeRef.current.addEventListener?.("release", () => { wakeRef.current = null; });
      }
    } catch { /* wake lock unavailable or denied; harmless */ }
  };
  const releaseWake = () => { try { wakeRef.current?.release?.(); } catch {} wakeRef.current = null; };
  useEffect(() => {
    const onVis = () => { if (document.visibilityState === "visible" && state === "riding" && !paused) acquireWake(); };
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  }, [state, paused]);
  useEffect(() => () => releaseWake(), []);

  // Begin recording. If GPS says we're well away from the route's start, ask
  // first — guards against accidentally recording from the wrong place.
  const beginRecording = async () => {
    setState("riding"); setElapsed(0); setPaused(false); setConfirm(null); setAdjustMin(0); setGpsError(null);
    setLive({ distanceM: 0, alongM: 0, offRoute: false, speedKmh: 0, avgKmh: 0, initialising: true, initPct: null });
    // Needle speed seeds at 0 (rider stationary). Arrival pace is dormant (null)
    // and seeded at the 1 km along-route mark with the average speed so far, then
    // refined by the 45-min EMA. Pace samples use ALONG-ROUTE distance (gap- and
    // curve-immune); the needle uses raw trace distance (real instantaneous
    // speed, including off-route). Progress/remaining come from along-route
    // projection, so they self-heal after a GPS gap and never need the clamp.
    // Seed the arrival pace EMA immediately with the route's still-air baseline
    // pace (always known synchronously), so arrival is a smooth pace-based
    // projection from the very first fix — no forecast→live switch, no 1 km jump.
    // The wind-aware forecast pace re-seeds this a moment later when
    // ridePrediction resolves (below), before any real riding has accrued. Real
    // speeds then drift the EMA from predicted toward actual over the ride.
    const baselineSec = route.baselineTimeSec || null;
    const routeTotalM = route.totalDistance || null;
    const seedPaceMps = (baselineSec && routeTotalM) ? routeTotalM / baselineSec : null;
    // Pace EMA time constant = HALF the baseline ride time, so shorter routes
    // adapt faster (a 20-min route shouldn't cling to its predicted pace as long
    // as a 2-hour one). CAPPED at 30 min so very long rides don't become sluggish
    // to real pace changes (half of a 2 h ride would otherwise be a 1 h τ). Falls
    // back to the legacy ~45 min if baseline is unknown.
    const PACE_TAU_MAX_MS = 30 * 60000;
    const paceTauMs = baselineSec ? Math.min((baselineSec * 1000) / 2, PACE_TAU_MAX_MS) : PACE_EMA_TAU_MS;
    emaRef.current = {
      speedMps: 0, paceMps: seedPaceMps, paceSeeded: seedPaceMps != null, paceTauMs,
      warmed: false, warmDistM: 0, warmSec: null, bestAccM: null,
      moveDistM: 0, moveSec: 0, lastSpeedAccM: null,
      lastFixT: null, lastAlongM: null, lastAccM: null,
      polyline: routePolyline(route),
    };
    setExpectLine(null);
    setForecastSec(null);
    // Fetch the go-now prediction first (duration + head/tailwind word), then
    // build the what-to-expect line with that word inserted — on the ride screen
    // the home card's head/tailwind headline isn't visible, so the line carries
    // it. Shown for every route incl. the example (showcases the feature).
    controller.ridePrediction(route).then((p) => {
      setForecastSec(p && p.predictedSec ? p.predictedSec : null);
      // Re-seed the pace EMA with the WIND-AFFECTED predicted pace, replacing the
      // still-air seed — but only if real riding hasn't meaningfully started yet
      // (giving a slow forecast up to 60 s to land). Past that, the rider's own
      // accumulated pace is the better signal, so we leave the EMA to drift and
      // never yank it back to the prediction (which would be a late jump).
      const em = emaRef.current;
      if (em && p && p.predictedSec && routeTotalM && (em.moveSec || 0) < 60) {
        em.paceMps = routeTotalM / p.predictedSec;
        em.paceSeeded = true;
      }
      const windWord = p && p.windWord ? p.windWord : null;
      const timeScale = p && p.timeScale ? p.timeScale : 1;
      return controller.rideExpectation(route, windWord, timeScale);
    }).then((e) => setExpectLine(e && e.line ? e.line : null)).catch(() => {});
    acquireWake();
    const handle = await controller.startRide(route, {
      onTick: ({ elapsedSec, distanceM, speedMps, gpsSpeedMps, speedAccMps, fixT, accuracyM, lat, lon }) => {
        setElapsed(elapsedSec);
        setGpsError(null); // a fix arrived → clear any prior error (no-op if already null)
        const em = emaRef.current;
        const goodFix = accuracyM == null || accuracyM <= GPS_ACCURACY_GATE_M;

        // Project the fix onto the route for progress + pace (gap-immune).
        let proj = { alongM: em.lastAlongM || 0, offRoute: true };
        if (goodFix && lat != null && em.polyline.length >= 2) {
          proj = projectToRoute({ lat, lon }, em.polyline, em.lastAlongM);
        }

        if (em.lastFixT != null) {
          // dt is measured between GPS FIX timestamps (not Date.now() at callback
          // time). This matters: fixes are sometimes delivered late or batched, so
          // Date.now() at the tick can span a different interval than the distance
          // covered — mixing the two produced a spike (fast jump out, slow drift
          // back) whenever delivery was bunched. Using fix time keeps distance and
          // dt over the SAME interval.
          const dt = fixT - em.lastFixT;
          // Warm-up: GPS is very inaccurate for the first few seconds, so hold the
          // needle at 0 until the first genuinely-good fix arrives — otherwise the
          // acquisition garbage seeds a visible startup jump. A stationary start at
          // 0 is the honest prior.
          if (!em.warmed && accuracyM != null && accuracyM <= NEEDLE_WARMUP_ACC_M) {
            em.warmed = true;
            em.warmDistM = distanceM;
            em.warmSec = elapsedSec;
          }
          // ── NEEDLE ───────────────────────────────────────────────────────────
          // Doppler primary: coords.speed (the GNSS chip's own Doppler velocity)
          // is a cleaner signal than differencing positions — road-tested to give
          // smaller residual swings at the same filtering. We fall back to
          // position-differencing only when coords.speed is null (indoors, first
          // fixes after lock, some device/browser combos).
          // Both paths share the SAME filter: sane-max, acceleration clamp, and a
          // dt-capped adaptive-τ EMA. τ is driven by the source-appropriate
          // accuracy — VELOCITY accuracy (coords.speedAccuracy) for Doppler,
          // POSITION accuracy for differencing — and scaled by NEEDLE_TAU_SCALE
          // (1.20: the road-tested balance of responsiveness vs damping).
          const needleUsable = accuracyM == null || accuracyM <= GPS_ACCURACY_HARD_M;
          const useDoppler = gpsSpeedMps != null && gpsSpeedMps >= 0;
          if (dt > 0 && em.warmed && (useDoppler || needleUsable)) {
            // 1) instantaneous speed sample
            let instMps = useDoppler ? gpsSpeedMps : Math.max(0, speedMps || 0);
            if (instMps > SPEED_SANE_MAX_MPS) instMps = useDoppler ? SPEED_SANE_MAX_MPS : 0;
            // 2) acceleration clamp (source-agnostic physical bound)
            const maxDelta = NEEDLE_MAX_ACCEL_MPS2 * (dt / 1000);
            instMps = Math.max(em.speedMps - maxDelta, Math.min(em.speedMps + maxDelta, instMps));
            // 3) adaptive τ from the source-appropriate accuracy, ×NEEDLE_TAU_SCALE
            const baseTau = useDoppler
              ? ((speedAccMps != null || em.lastSpeedAccM != null)
                  ? needleTauMsFromSpeedAcc(em.lastSpeedAccM, speedAccMps)
                  : needleTauMs(em.lastAccM, accuracyM)) // fallback: position accuracy
              : needleTauMs(em.lastAccM, accuracyM);
            const tau = baseTau * NEEDLE_TAU_SCALE;
            const dtForAlpha = Math.min(dt, NEEDLE_MAX_DT_MS);
            em.speedMps = emaStep(em.speedMps, instMps, dtForAlpha, tau);
          }
          // Pace (arrival): MOVING pace — fed only from fixes where the rider is
          // actually moving (above PACE_MOVING_MIN_MPS). Time spent stopped is
          // excluded entirely: arrival is a pace-based projection ("time to ride
          // the remaining distance at my moving pace"), so a stop must not drag
          // the rate down and inflate the projection for the whole remaining
          // distance. This makes arrival mildly optimistic by however long the
          // rider is actually stopped (unforeseeable), which is the honest stance —
          // we have no better guess at future stops than none.
          if (dt > 0 && goodFix) {
            const instMps = Math.max(0, Math.min(SPEED_SANE_MAX_MPS, speedMps || 0));
            if (instMps >= PACE_MOVING_MIN_MPS) {
              // Accrue moving distance/time (used only to gate the early forecast
              // re-seed above; no longer a 1 km seed trigger).
              em.moveDistM = (em.moveDistM || 0) + instMps * (Math.min(dt, NEEDLE_MAX_DT_MS) / 1000);
              em.moveSec = (em.moveSec || 0) + Math.min(dt, NEEDLE_MAX_DT_MS) / 1000;
              // Pace EMA is seeded from the predicted (wind-affected) pace at the
              // start, so we always just step it — real speeds drift it smoothly
              // from predicted toward actual. τ is half the baseline ride time.
              const tauMs = em.paceTauMs || PACE_EMA_TAU_MS;
              if (em.paceMps == null) em.paceMps = instMps; // safety: unseeded → adopt
              else em.paceMps = emaStep(em.paceMps, instMps, Math.min(dt, NEEDLE_MAX_DT_MS), tauMs);
            }
            // Below the moving threshold: contribute nothing, so stops don't
            // affect moving pace.
          }
        }

        const needleUsable = accuracyM == null || accuracyM <= GPS_ACCURACY_HARD_M;
        if (needleUsable || em.lastFixT == null) { em.lastFixT = fixT; em.lastAccM = accuracyM; em.lastSpeedAccM = speedAccMps; }
        if (goodFix && !proj.offRoute) em.lastAlongM = proj.alongM;
        // "GPS initialising" readout during warm-up: best (lowest) accuracy so far,
        // 8/best×100 → approaches 100 as fixes sharpen; monotonic.
        if (accuracyM != null && (em.bestAccM == null || accuracyM < em.bestAccM)) em.bestAccM = accuracyM;
        const initPct = em.bestAccM != null ? Math.min(100, Math.round((NEEDLE_WARMUP_ACC_M / em.bestAccM) * 100)) : null;
        // Average speed measured from the warm-up anchor (0 until warmed), so
        // acquisition-noise distance over a near-zero time can't read as ~40 km/h.
        let avgKmh = 0;
        if (em.warmed && em.warmSec != null) {
          const dSec = elapsedSec - em.warmSec;
          const dDist = distanceM - em.warmDistM;
          if (dSec > 0 && dDist > 0) avgKmh = (dDist / dSec) * 3.6;
        }
        setLive({ distanceM, alongM: proj.alongM, offRoute: proj.offRoute, offRouteM: proj.offRouteM, speedKmh: (em.speedMps || 0) * 3.6, avgKmh, initialising: !em.warmed, initPct });
      },
      onFinish: (r) => {
        releaseWake();
        setResult({ actualSec: r.actualSec, distance: r.distanceM, startedAt: r.startedAt, endedAt: r.endedAt, pausedSec: r.pausedSec || 0, forecastWind: r.forecastWind });
        setState("done");
      },
      onArrived: () => {
        // The detector thinks the ride is finished (reached / stopped-at the end).
        // Don't end outright — offer the choice, so a rider who's paused at the
        // end or looping can keep going. "Finish" completes via manualFinish;
        // dismiss keeps riding (the lib latches this so it won't nag again).
        setArrivedConfirm(true);
      },
      onError: (e) => { setGpsError(e || { code: 2 }); },
    }).catch((e) => { alert(e.message); setState("armed"); releaseWake(); });
    ref.current = { handle };
  };

  const start = async () => {
    // Skip the distance guard for the ephemeral example — it's a demo, the
    // rider isn't expected to be at the example's start.
    if (!route.isExample) {
      const metres = await controller.distanceToStart(route);
      if (metres != null && metres > 100) {
        setFarConfirm({ metres }); // ask before recording
        return;
      }
    }
    await beginRecording();
  };

  // Local display clock so the timer ticks smoothly and freezes on pause,
  // independent of GPS fix cadence.
  useEffect(() => {
    if (state !== "riding" || paused) return;
    const id = setInterval(() => setElapsed((e) => e + 1), 1000);
    return () => clearInterval(id);
  }, [state, paused]);

  // Wall-clock tick for the analogue dial (once per second while riding).
  useEffect(() => {
    if (state !== "riding") return;
    setNowMs(Date.now());
    const id = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(id);
  }, [state]);

  useEffect(() => () => ref.current.handle?.stop?.(), []);

  // All hooks above run unconditionally; safe to bail on a missing route here.
  if (!route) return <Empty />;

  const togglePause = () => {
    const h = ref.current.handle;
    if (!h) return;
    if (paused) { h.resume?.(); setPaused(false); acquireWake(); }
    else { h.pause?.(); setPaused(true); releaseWake(); }
  };

  // Manual finish with an end-of-ride sanity check mirroring the start check:
  // if GPS says we're well away from the route end, confirm before stopping.
  const doFinish = () => ref.current.handle?.manualFinish?.();
  const finishNow = async () => {
    if (!route.isExample) {
      const metres = await controller.distanceToEnd(route).catch(() => null);
      if (metres != null && metres > 100) { setEndConfirm({ metres }); return; }
    }
    doFinish();
  };

  const fmtC = fmtStopwatch;

  // Final ride time after any manual adjustment (never below zero).
  const adjustedSec = result ? Math.max(0, result.actualSec + adjustMin * 60) : 0;

  const submit = async () => {
    setConfirm("yes");
    // Don't force `usable`: the ride's used/not-used state is set from its wind
    // classification at record time (gentle → not used; still/windy → used).
    await controller.recordRide({
      routeId: route.id, startedAt: result.startedAt, endedAt: result.endedAt,
      actualTimeSec: adjustedSec, forecastWind: result.forecastWind,
      adjustMin: adjustMin || 0, pausedSec: result.pausedSec || 0,
    });
  };
  const discard = () => { setConfirm("discarded"); /* nothing stored */ };

  return (
    <div style={{
      height: "100%", color: "#fff", padding: 24, position: "relative",
      background: state === "riding" ? "#000" : "linear-gradient(165deg,#12152b,#1d1b38 55%,#281f44)",
      transition: "background 0.6s", display: "flex", flexDirection: "column",
    }}>
      {state === "armed" && (
        <div style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 26 }}>
          <div style={{ textAlign: "center" }}>
            <div style={{ fontFamily: "'Fraunces',serif", fontSize: 28, fontWeight: 600 }}>Ready to ride</div>
            <div style={{ fontSize: 14, color: "rgba(255,255,255,0.6)", marginTop: 8 }}>{route.name}</div>
          </div>
          <button onClick={start} style={{
            width: 160, height: 160, borderRadius: "50%", border: "none", cursor: "pointer",
            background: "radial-gradient(circle at 35% 30%, #5b8fc7, #2a5a6e)", color: "#fff",
            fontFamily: "'Fraunces',serif", fontSize: 21, fontWeight: 600, boxShadow: "0 12px 50px rgba(91,143,199,0.4)",
          }}>Start Ride</button>
        </div>
      )}
      {farConfirm && (
        <div style={{
          position: "absolute", inset: 0, zIndex: 20, display: "grid", placeItems: "center",
          background: "rgba(0,0,0,0.6)", padding: 28,
        }}>
          <div style={{
            maxWidth: 320, background: "#1d1b38", borderRadius: 18, padding: "22px 22px",
            border: "1px solid rgba(255,255,255,0.14)", textAlign: "center",
          }}>
            <div style={{ fontFamily: "'Fraunces',serif", fontSize: 19, fontWeight: 600, marginBottom: 8 }}>
              Away from the start
            </div>
            <div style={{ fontSize: 14, color: "rgba(255,255,255,0.7)", lineHeight: 1.5, marginBottom: 18 }}>
              You are {formatDistanceAdaptive(farConfirm.metres)} away from the start of this route. Record anyway?
            </div>
            <div style={{ display: "flex", gap: 10 }}>
              <button onClick={() => setFarConfirm(null)} style={{ flex: 1, padding: 12, borderRadius: 12, cursor: "pointer", fontFamily: "inherit", fontSize: 14, fontWeight: 600, background: "rgba(255,255,255,0.1)", color: "#fff", border: "1px solid rgba(255,255,255,0.18)" }}>
                No
              </button>
              <button onClick={() => { setFarConfirm(null); beginRecording(); }} style={{ flex: 1, padding: 12, borderRadius: 12, cursor: "pointer", fontFamily: "'Fraunces',serif", fontSize: 14, fontWeight: 600, background: "#e0a45e", color: "#1a1f3a", border: "none" }}>
                Yes, record
              </button>
            </div>
          </div>
        </div>
      )}
      {state === "riding" && (() => {
        const totalM = route.totalDistance ?? null;
        // Along-route position from projection drives progress + remaining. It's
        // gap-immune (self-heals on any fix) and never exceeds the route, so no
        // clamp is needed. `gpsDistanceM` (real trace) still gates the 1 km
        // forecast→live arrival switch.
        const alongM = live.alongM || 0;
        // Arrival is only meaningful on-route (off-route we have a pace but no
        // defined remaining distance, so arrival is genuinely unknown → no
        // marker; an "Off route" message explains the frozen progress instead).
        const arrivalMs = live.offRoute ? null : expectedArrivalMs({
          nowMs, estDistanceM: alongM, routeTotalM: totalM,
          paceMps: emaRef.current.paceMps,
          // Wind + learning-aware predicted duration for leaving now (the same
          // prediction the home screen shows) when the forecast was fetchable;
          // the still-air baseline is the fallback. The first-km estimate is
          // progress-scaled from whichever is used.
          forecastRemainingSec: forecastSec,
          baselineRemainingSec: route.baselineTimeSec ?? null,
        });
        const avg = Math.round((live.avgKmh || 0) * 2) / 2;
        return (
          <InstrumentPanel
            elapsed={elapsed} paused={paused} avg={avg} label={route.name}
            nowMs={nowMs} arrivalMs={arrivalMs} speedKmh={live.speedKmh}
            centerMessage={gpsError
              ? { text: gpsError.code === 1 ? "Location permission denied" : gpsError.code === 3 ? "GPS timed out — no signal" : "GPS not available", color: "#d9534f" }
              : (live.initialising
                ? { text: live.initPct != null ? `GPS initialising ${live.initPct}%` : "GPS initialising…", color: "#e0a45e" }
                : (live.offRoute && live.offRouteM != null
                  ? { text: `Off route by ${formatDistanceAdaptive(live.offRouteM)}`, color: "#e0a45e" }
                  : null))}
            onPause={togglePause} onFinish={finishNow}
            bottom={totalM
              ? <ProgressBar travelledM={alongM} totalM={totalM} />
              : <div style={{ textAlign: "center", fontFamily: "'Fraunces',serif", fontSize: 18, fontWeight: 600 }}>{formatDistance(live.distanceM / 1000, undefined, { dp: 2 })}</div>}
            caption={expectLine}
          />
        );
      })()}
      {endConfirm && (
        <div style={{ position: "absolute", inset: 0, zIndex: 20, display: "grid", placeItems: "center", background: "rgba(0,0,0,0.6)", padding: 28 }}>
          <div style={{ maxWidth: 320, background: "#1d1b38", borderRadius: 18, padding: "22px 22px", border: "1px solid rgba(255,255,255,0.14)", textAlign: "center" }}>
            <div style={{ fontFamily: "'Fraunces',serif", fontSize: 19, fontWeight: 600, marginBottom: 8 }}>Away from the end</div>
            <div style={{ fontSize: 14, color: "rgba(255,255,255,0.7)", lineHeight: 1.5, marginBottom: 18 }}>
              You are {formatDistanceAdaptive(endConfirm.metres)} from the end of this route. Really stop?
            </div>
            <div style={{ display: "flex", gap: 10 }}>
              <button onClick={() => setEndConfirm(null)} style={{ flex: 1, padding: 12, borderRadius: 12, cursor: "pointer", fontFamily: "inherit", fontSize: 14, fontWeight: 600, background: "rgba(255,255,255,0.1)", color: "#fff", border: "1px solid rgba(255,255,255,0.18)" }}>Keep riding</button>
              <button onClick={() => { setEndConfirm(null); doFinish(); }} style={{ flex: 1, padding: 12, borderRadius: 12, cursor: "pointer", fontFamily: "'Fraunces',serif", fontSize: 14, fontWeight: 600, background: "#e0a45e", color: "#1a1f3a", border: "none" }}>Stop now</button>
            </div>
          </div>
        </div>
      )}
      {arrivedConfirm && (
        <div style={{ position: "absolute", inset: 0, zIndex: 20, display: "grid", placeItems: "center", background: "rgba(0,0,0,0.6)", padding: 28 }}>
          <div style={{ maxWidth: 320, background: "#1d1b38", borderRadius: 18, padding: "22px 22px", border: "1px solid rgba(255,255,255,0.14)", textAlign: "center" }}>
            <div style={{ fontFamily: "'Fraunces',serif", fontSize: 19, fontWeight: 600, marginBottom: 8 }}>Reached the end</div>
            <div style={{ fontSize: 14, color: "rgba(255,255,255,0.7)", lineHeight: 1.5, marginBottom: 18 }}>
              Looks like you've reached the end of this route. Finish the ride, or keep riding?
            </div>
            <div style={{ display: "flex", gap: 10 }}>
              <button onClick={() => setArrivedConfirm(false)} style={{ flex: 1, padding: 12, borderRadius: 12, cursor: "pointer", fontFamily: "inherit", fontSize: 14, fontWeight: 600, background: "rgba(255,255,255,0.1)", color: "#fff", border: "1px solid rgba(255,255,255,0.18)" }}>Keep riding</button>
              <button onClick={() => { setArrivedConfirm(false); doFinish(); }} style={{ flex: 1, padding: 12, borderRadius: 12, cursor: "pointer", fontFamily: "'Fraunces',serif", fontSize: 14, fontWeight: 600, background: "#e0a45e", color: "#1a1f3a", border: "none" }}>Finish</button>
            </div>
          </div>
        </div>
      )}
      {state === "done" && result && (
        <div style={{ flex: 1, paddingTop: 20, overflowY: "auto" }}>
          <div style={{ textAlign: "center" }}>
            <div style={{ fontSize: 13, color: "rgba(255,255,255,0.55)" }}>Ride complete</div>
            <div style={{ fontFamily: "'Fraunces',serif", fontSize: 70, fontWeight: 600 }}>{fmtC(adjustedSec)}</div>
            <div style={{ fontSize: 14, color: "rgba(255,255,255,0.65)" }}>
              {formatDistance(result.distance / 1000, undefined, { dp: 2 })}{result.pausedSec >= 30 ? ` · ${formatElapsed(result.pausedSec)} paused (excluded)` : ""}
            </div>
            {adjustMin !== 0 && (
              <div style={{ fontSize: 12.5, color: "#e0a45e", marginTop: 4 }}>
                adjusted {adjustMin > 0 ? "+" : ""}{adjustMin} min from {fmtC(result.actualSec)}
              </div>
            )}
          </div>

          {confirm === null && (
            <>
              {/* Adjust */}
              <div style={{ marginTop: 28, padding: "14px 16px", borderRadius: 16, background: "rgba(255,255,255,0.07)", border: "1px solid rgba(255,255,255,0.14)" }}>
                <div style={{ fontSize: 13.5, color: "rgba(255,255,255,0.8)", marginBottom: 4 }}>Adjust ride time</div>
                <div style={{ fontSize: 12, color: "rgba(255,255,255,0.5)", marginBottom: 12, lineHeight: 1.45 }}>
                  Correct for anything the timer couldn't know — a stop you forgot to pause, or recording started before you set off.
                </div>
                <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 14 }}>
                  <button onClick={() => setAdjustMin((m) => m - 1)} style={adjBtn}>−1 min</button>
                  <span style={{ fontFamily: "'Fraunces',serif", fontSize: 22, fontWeight: 600, minWidth: 64, textAlign: "center", fontVariantNumeric: "tabular-nums" }}>
                    {adjustMin > 0 ? "+" : ""}{adjustMin}
                  </span>
                  <button onClick={() => setAdjustMin((m) => m + 1)} style={adjBtn}>+1 min</button>
                </div>
              </div>

              {/* Accept / discard */}
              <div style={{ fontSize: 13.5, color: "rgba(255,255,255,0.65)", textAlign: "center", margin: "24px 0 16px", lineHeight: 1.45 }}>
                {route.isExample
                  ? "This is an example route — your ride time will not be saved. Create your first real route to save actual ride times."
                  : "Accept to make it available for learning, or discard if it isn't representative."}
              </div>
              <div style={{ display: "flex", gap: 10 }}>
                <button onClick={discard} style={{ flex: 1, padding: 14, borderRadius: 14, cursor: "pointer", fontFamily: "inherit", fontSize: 14, fontWeight: 600, background: "none", color: "#f0a08c", border: "1px solid rgba(224,120,94,0.4)" }}>Discard</button>
                <button onClick={() => submit()} style={{ flex: 1.3, padding: 14, borderRadius: 14, cursor: "pointer", fontFamily: "'Fraunces',serif", fontSize: 16, fontWeight: 600, background: "#6fd49a", color: "#0f2a1c", border: "none" }}>Accept</button>
              </div>
            </>
          )}

          {confirm && (
            <div style={{ marginTop: 36, textAlign: "center" }}>
              <div style={{ fontSize: 36 }}>{confirm === "yes" ? "✓" : "✕"}</div>
              <div style={{ fontFamily: "'Fraunces',serif", fontSize: 19, fontWeight: 600, marginTop: 6 }}>
                {confirm === "yes" ? (route.isExample ? "Demo complete" : "Added to your model") : "Ride discarded"}
              </div>
              <button onClick={onDone} style={{ marginTop: 26, width: "100%", padding: 14, borderRadius: 14, cursor: "pointer", fontFamily: "inherit", fontSize: 14, background: "rgba(255,255,255,0.1)", color: "#fff", border: "1px solid rgba(255,255,255,0.18)" }}>Done</button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

const adjBtn = {
  padding: "9px 14px", borderRadius: 10, cursor: "pointer", fontFamily: "inherit", fontSize: 14, fontWeight: 600,
  background: "rgba(255,255,255,0.12)", color: "#fff", border: "1px solid rgba(255,255,255,0.2)",
};

/* ============================================================================
 * Shared bits
 * ========================================================================== */
function TabBar({ screen, setScreen, hasRoutes }) {
  const tabs = [["home", "Plan"], ["capture", "Ride"], ["routes", "Routes"]];
  return (
    <div style={{ display: "flex", background: "#16181d", borderTop: "1px solid rgba(255,255,255,0.06)", padding: "8px 8px calc(8px + env(safe-area-inset-bottom))" }}>
      {tabs.map(([k, label]) => {
        const disabled = k === "capture" && !hasRoutes;
        // the setup sub-screen still belongs to the Routes tab
        const isActive = screen === k || (k === "routes" && screen === "setup");
        return (
          <button key={k} disabled={disabled} onClick={() => setScreen(k)} style={{
            flex: 1, padding: "10px 0", border: "none", cursor: disabled ? "default" : "pointer", background: "transparent",
            fontFamily: "inherit", fontSize: 12.5, fontWeight: 600,
            color: disabled ? "rgba(255,255,255,0.2)" : isActive ? "#e0a45e" : "rgba(255,255,255,0.5)",
          }}>{label}</button>
        );
      })}
    </div>
  );
}
function WindField({ verdict, accent }) {
  const lines = Array.from({ length: 18 }, (_, i) => ({ top: (i * 5.7) % 100, delay: (i * 0.4) % 6, len: 30 + (i % 5) * 12, dur: 5 + (i % 3), o: 0.05 + (i % 4) * 0.03 }));
  const rot = verdict === "headwind" ? 100 : verdict === "tailwind" ? -80 : 90;
  return (
    <div aria-hidden style={{ position: "absolute", inset: 0, overflow: "hidden", transform: `rotate(${rot}deg) scale(1.6)` }}>
      {lines.map((l, i) => (
        <div key={i} style={{ position: "absolute", top: `${l.top}%`, left: "-20%", width: l.len, height: 1.5, opacity: l.o, background: `linear-gradient(90deg, transparent, ${accent}, transparent)`, animation: `drift ${l.dur}s linear ${l.delay}s infinite` }} />
      ))}
    </div>
  );
}
function Arrow({ verdict, accent }) {
  const rot = verdict === "tailwind" ? 0 : verdict === "headwind" ? 180 : 90;
  return <svg width="12" height="12" viewBox="0 0 24 24" style={{ transform: `rotate(${rot}deg)` }}><path d="M12 4 L12 20 M12 4 L7 10 M12 4 L17 10" stroke={accent} strokeWidth="2.4" fill="none" strokeLinecap="round" strokeLinejoin="round" /></svg>;
}
function RowLine({ label, value, color }) {
  return <div style={{ display: "flex", justifyContent: "space-between", margin: "3px 0", fontSize: 13.5 }}><span style={{ color: "rgba(255,255,255,0.75)" }}>{label}</span><span style={{ fontWeight: 600, color: color || "#fff" }}>{value}</span></div>;
}
function ConfidenceDots({ confidence }) {
  // Dots reflect how much of the prediction is served from ride data: one dot
  // each for baseline, kHead, kTail that is currently learned (combined-k earns
  // at most one). 0 = entirely hand-set, 3 = fully learned both directions.
  const dots = confidence?.dots ?? 0;
  return <span style={{ display: "inline-flex", alignItems: "center", gap: 7, fontSize: 12, color: "rgba(255,255,255,0.7)" }}>
    <span style={{ display: "inline-flex", gap: 3 }}>{[0, 1, 2].map((i) => <span key={i} style={{ width: 6, height: 6, borderRadius: 6, background: i < dots ? "rgba(255,255,255,0.9)" : "rgba(255,255,255,0.25)" }} />)}</span>
  </span>;
}
function Block({ n, title, children }) {
  return <div style={{ padding: "8px 22px 16px" }}>
    <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 12 }}>
      <span style={{ width: 24, height: 24, borderRadius: 100, display: "grid", placeItems: "center", background: "rgba(255,255,255,0.12)", fontSize: 12, fontWeight: 600, fontFamily: "'Fraunces',serif" }}>{n}</span>
      <span style={{ fontSize: 16, fontWeight: 600 }}>{title}</span>
    </div>{children}
  </div>;
}
function Stat({ label, value }) {
  return <div><div style={{ fontSize: 11.5, color: "rgba(255,255,255,0.5)" }}>{label}</div><div style={{ fontSize: 16, fontWeight: 600, fontFamily: "'Fraunces',serif" }}>{value}</div></div>;
}
function Warn({ children }) {
  return <div style={{ marginTop: 8, padding: "8px 12px", borderRadius: 10, fontSize: 12.5, background: "rgba(224,120,94,0.12)", border: "1px solid rgba(224,120,94,0.3)", color: "#f0b8a8" }}>{children}</div>;
}
/* ============================================================================
 * HelpPanel — first-launch welcome + re-readable help (install, GPX, tuning)
 * ========================================================================== */
function LoadErrorScreen({ message, onRetry }) {
  // Don't assert a cause we can't be sure of. A 429 (rate limit) is the server
  // throttling us, not the user's connection — give accurate guidance for it.
  const rateLimited = message && /\b429\b/.test(message);
  const guidance = rateLimited
    ? "The forecast service is busy right now (too many requests). Wait a minute, then try again — your routes are saved."
    : "The forecast couldn’t be loaded. Try again in a moment — your routes are saved.";
  return (
    <div style={{ height: "100%", display: "grid", placeItems: "center", background: "linear-gradient(165deg,#12152b,#1d1b38 55%,#281f44)", color: "#fff", textAlign: "center", padding: 30 }}>
      <div style={{ maxWidth: 300 }}>
        <div style={{ fontFamily: "'Fraunces',serif", fontSize: 22, fontWeight: 600, marginBottom: 8 }}>
          {rateLimited ? "Forecast service busy" : "Couldn’t load the forecast"}
        </div>
        <div style={{ fontSize: 13.5, color: "rgba(255,255,255,0.6)", marginBottom: 18, lineHeight: 1.5 }}>
          {guidance}
        </div>
        <button onClick={onRetry} style={{
          padding: "12px 28px", borderRadius: 12, border: "none", cursor: "pointer",
          fontFamily: "'Fraunces',serif", fontSize: 15, fontWeight: 600, background: "#e0a45e", color: "#1a1f3a",
        }}>Try again</button>
      </div>
    </div>
  );
}

function Loading({ progress }) {
  const { done = 0, total = 0 } = progress || {};
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;
  const showBar = total > 1; // a real bar only when there are multiple routes to load
  return (
    <div style={{ height: "100%", display: "grid", placeItems: "center", background: "linear-gradient(165deg,#12152b,#1d1b38)", color: "rgba(255,255,255,0.7)" }}>
      <div style={{ width: 220, textAlign: "center" }}>
        <div style={{ fontFamily: "'Fraunces',serif", fontSize: 19, color: "rgba(255,255,255,0.92)", marginBottom: 14 }}>Ride the Wind</div>
        {showBar ? (
          <>
            <div style={{ height: 5, borderRadius: 3, background: "rgba(255,255,255,0.12)", overflow: "hidden" }}>
              <div style={{ height: "100%", width: `${pct}%`, background: "#e0a45e", borderRadius: 3, transition: "width 0.3s ease" }} />
            </div>
            <div style={{ fontSize: 12.5, color: "rgba(255,255,255,0.5)", marginTop: 8 }}>
              Checking forecasts · route {Math.min(done + 1, total)} of {total}
            </div>
          </>
        ) : (
          <div style={{ fontSize: 14, color: "rgba(255,255,255,0.5)" }}>Checking the forecast…</div>
        )}
      </div>
    </div>
  );
}
function Empty({ name }) {
  return <div style={{ height: "100%", display: "grid", placeItems: "center", background: "linear-gradient(165deg,#12152b,#1d1b38 55%,#281f44)", color: "#fff", textAlign: "center", padding: 30 }}>
    <div>
      <div style={{ fontFamily: "'Fraunces',serif", fontSize: 24, fontWeight: 600 }}>{name || "No routes yet"}</div>
      <div style={{ fontSize: 14, color: "rgba(255,255,255,0.6)", marginTop: 8 }}>Create a new route in the Routes tab to see your morning verdict.</div>
    </div>
  </div>;
}

const INP = { width: "100%", padding: "12px 14px", borderRadius: 12, fontSize: 15, fontFamily: "inherit", background: "rgba(255,255,255,0.07)", border: "1px solid rgba(255,255,255,0.16)", color: "#fff", outline: "none" };

/* Time entry that shows the value in the SYSTEM clock format (via
 * formatClockString) even when collapsed — working around native
 * <input type="time"> rendering its field in 24h on some OS/browser combos while
 * its picker uses 12h. A visually-hidden real time input sits behind a styled
 * read-only chip; tapping the chip opens the NATIVE picker via showPicker()
 * (focus fallback for browsers without it), so this is NOT a custom picker — the
 * OS picker still does all input, and onChange still yields a 24h "HH:MM" string.
 * Because the whole app now follows system format, chip and picker agree (no
 * mid-edit format flip). */
function TimeField({ value, onChange, disabled, style }) {
  const ref = useRef(null);
  const open = () => {
    if (disabled) return;
    const el = ref.current;
    if (!el) return;
    try {
      if (typeof el.showPicker === "function") { el.showPicker(); return; }
    } catch { /* showPicker can throw if not allowed; fall through to focus */ }
    el.focus();
    el.click(); // mobile browsers typically open the picker on focus/click
  };
  return (
    <div style={{ position: "relative", ...style }}>
      <button type="button" onClick={open} disabled={disabled}
        style={{ ...INP, display: "flex", alignItems: "center", justifyContent: "space-between",
          cursor: disabled ? "not-allowed" : "pointer", opacity: disabled ? 0.5 : 1, textAlign: "left" }}>
        <span>{formatClockString(value)}</span>
        <span aria-hidden="true" style={{ color: "rgba(255,255,255,0.45)", fontSize: 12, marginLeft: 8 }}>▾</span>
      </button>
      {/* Real native input, visually hidden but focusable/pickable. */}
      <input ref={ref} type="time" value={value} disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
        tabIndex={-1} aria-hidden="true"
        style={{ position: "absolute", left: 0, bottom: 0, width: 1, height: 1, opacity: 0, pointerEvents: "none", border: 0, padding: 0, margin: 0 }} />
    </div>
  );
}
