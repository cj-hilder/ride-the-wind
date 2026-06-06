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
const skyFor = (hour) =>
  hour < 6 ? SKY.predawn : hour < 9 ? SKY.sunrise : hour < 17 ? SKY.day : hour < 20 ? SKY.dusk : SKY.night;
const ACCENT = { headwind: "#5b8fc7", tailwind: "#e0a45e", normal: "#9aa7b0" };
const fmtMin = (sec) => `${Math.round(sec / 60)} min`;

// "Margin of error" slider speaks 0–100% (how much of the forecast spread to
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
    ? `ride for ${likely} mins`
    : `ride for ${fast} to ${slow} mins (likely ${likely} mins)`;
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

export default function App() {
  const controllerRef = useRef(null);
  if (!controllerRef.current) controllerRef.current = createAppController();
  const controller = controllerRef.current;

  const [screen, setScreen] = useState("home"); // home | setup | capture
  const [routes, setRoutes] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(null);
  const [progress, setProgress] = useState({ done: 0, total: 0 });
  const [activeRouteId, setActiveRouteId] = useState(null);
  const activeRouteIdRef = useRef(null);
  useEffect(() => { activeRouteIdRef.current = activeRouteId; }, [activeRouteId]);
  const [showHelp, setShowHelp] = useState(false);
  const [nowTick, setNowTick] = useState(Date.now()); // drives the Plan day strip; bumped on midnight rollover
  const [forecastGen, setForecastGen] = useState(0); // bumped whenever routes/forecasts refresh, so Plan recomputes in place

  // First launch (helpSeen unset) → show the welcome/help panel once.
  useEffect(() => {
    controller.store.getSetting("helpSeen", false).then((seen) => {
      if (!seen) setShowHelp(true);
    });
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
      // Only auto-select when nothing is chosen yet (first load). Read the live
      // value via ref so this stable callback never stomps an existing selection
      // on a background refresh.
      if (!activeRouteIdRef.current && list[0]) setActiveRouteId(list[0].route.id);
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
          />
        ) : screen === "setup" ? (
          <Setup controller={controller}
            onDone={async () => { await refresh(); setScreen("routes"); }}
            onCancel={() => setScreen("routes")} />
        ) : (
          <Capture controller={controller} route={active?.route}
            onDone={async () => { await refresh(); setScreen("home"); }} />
        )}
        </ScreenBoundary>
      </div>

      <TabBar screen={screen} setScreen={setScreen} hasRoutes={routes.length > 0} />

      {showHelp && <HelpPanel onClose={acceptHelp} />}
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
  const sky = verdict ? skyFor(new Date(verdict.departureMs).getHours()) : SKY.predawn;

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
        <input type="time" value={t} onChange={(e) => setT(e.target.value)} style={{
          flex: 1, padding: "10px 12px", borderRadius: 10, border: "1px solid rgba(255,255,255,0.2)",
          background: "rgba(255,255,255,0.08)", color: "#fff", fontFamily: "inherit", fontSize: 15,
        }} />
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
function PlanBody({ verdict, dayVerdict, fetching, accent, showDebug, setShowDebug,
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
              {exploredHHMM ? `custom · ${isDepart ? "leave" : "arrive by"} ${exploredHHMM}` : "Explore"}
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
        <RowLine label="Wind allowance" value={`${verdict.deltaMin > 0 ? "+" : ""}${verdict.deltaMin} min`} color={accent} />
        <div style={{ marginTop: 10, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <ConfidenceDots confidence={confidence} />
          {verdict.kHead != null && verdict.kTail != null ? (
            Math.abs(verdict.kHead - verdict.kTail) < 0.005 ? (
              <span style={{ fontSize: 12, color: "rgba(255,255,255,0.5)" }}>k {verdict.kHead.toFixed(2)}</span>
            ) : (
              <span style={{ fontSize: 12, color: "rgba(255,255,255,0.5)" }}>
                {/* headwind slows you → down arrow; tailwind speeds you → up arrow */}
                k <span style={{ color: verdict.windFactor >= 0 ? "#fff" : "rgba(255,255,255,0.5)", fontWeight: verdict.windFactor >= 0 ? 600 : 400 }}>↓{verdict.kHead.toFixed(2)}</span>
                {" / "}
                <span style={{ color: verdict.windFactor < 0 ? "#fff" : "rgba(255,255,255,0.5)", fontWeight: verdict.windFactor < 0 ? 600 : 400 }}>↑{verdict.kTail.toFixed(2)}</span>
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
  const fmtClock = (ms) => {
    if (ms == null) return "—";
    const d = new Date(ms);
    return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  };
  const Row = ({ label, children }) => (
    <div style={{ display: "flex", justifyContent: "space-between", gap: 12, padding: "3px 0" }}>
      <span style={{ color: "rgba(255,255,255,0.5)" }}>{label}</span>
      <span style={{ color: "rgba(255,255,255,0.9)", textAlign: "right" }}>{children}</span>
    </div>
  );
  return (
    <div style={{
      marginTop: 10, borderRadius: 12, overflow: "hidden",
      fontSize: 12.5, fontFamily: "ui-monospace, monospace", lineHeight: 1.5,
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
        wind: {debug.windSpeedKmh} km/h {debug.windFromLabel} ({debug.windFromDeg}°)
      </div>
      <div style={{ padding: "2px 12px 10px" }}>
        <Row label="route avg bearing">{debug.avgBearingDeg}°</Row>
        <Row label="mean headwind">{debug.meanHeadwindKmh} km/h ({debug.meanHeadwindKmh >= 0 ? "head" : "tail"})</Row>
        {debug.effortHeadwindKmh != null && (
          <Row label="effort headwind">{debug.effortHeadwindKmh} km/h</Row>
        )}
        {debug.effortHeadwindKmh != null && (
          <div style={{ fontSize: 10.5, color: "rgba(255,255,255,0.4)", lineHeight: 1.45, padding: "0 0 4px" }}>
            Wind resistance grows with speed², so uneven wind slows you more than the mean suggests — effort captures that.
          </div>
        )}
        <Row label="mean crosswind">{debug.meanCrosswindKmh} km/h</Row>
        <Row label="wind factor">{debug.windFactor} ({debug.windFactor >= 0 ? "slows" : "speeds"})</Row>
        <div style={{ height: 1, background: "rgba(255,255,255,0.08)", margin: "6px 0" }} />
        <Row label="forecast updated">{fmtClock(debug.forecastUpdatedMs)}</Row>
        <Row label="next update">{fmtClock(debug.forecastNextUpdateMs)}</Row>
      </div>
    </div>
  );
}

/* ============================================================================
 * Routes — list, edit, delete existing routes + backup (export/import)
 * ========================================================================== */
const DAY_CODES = [["MO", "M"], ["TU", "T"], ["WE", "W"], ["TH", "T"], ["FR", "F"], ["SA", "S"], ["SU", "S"]];

function Routes({ controller, routes, onChanged, onAddNew, onHelp }) {
  const [editing, setEditing] = useState(null); // route id being edited
  const [conservatism, setConservatism] = useState(pctToSlider(95));
  const fileRef = useRef();

  useEffect(() => {
    let alive = true;
    controller.store.getSetting("conservatismPct", 95).then((v) => {
      if (alive && v != null) setConservatism(pctToSlider(Number(v)));
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
          <span style={{ fontSize: 14 }}>Margin of error</span>
          <span style={{ fontFamily: "ui-monospace,monospace", fontSize: 14, color: "#e0a45e" }}>{conservatism}%</span>
        </div>
        <input type="range" min={0} max={100} value={conservatism}
          onChange={(e) => setConservatism(Number(e.target.value))}
          onMouseUp={(e) => saveConservatism(e.target.value)}
          onTouchEnd={(e) => saveConservatism(e.target.value)}
          style={{ width: "100%", marginTop: 8, accentColor: "#e0a45e" }} />
        <div style={{ fontSize: 12, color: "rgba(255,255,255,0.5)", marginTop: 4, lineHeight: 1.4 }}>
          Ride the Wind uses multiple forecast models to calculate a margin of error for the forecast. This setting controls how much of that margin of error is applied to your ride times. Higher will have you leave earlier to be more likely on time.
        </div>
      </div>

      {routes.length === 0 ? (
        <div style={{ padding: "40px 22px", textAlign: "center", color: "rgba(255,255,255,0.55)" }}>
          No routes yet. Tap <b style={{ color: "#e0a45e" }}>+ New</b> to add one from a GPX file.
        </div>
      ) : (
        <div style={{ padding: "0 16px" }}>
          {routes.map(({ route, verdict, confidence }) => (
            <div key={route.id} style={{
              marginBottom: 12, borderRadius: 16, overflow: "hidden",
              background: "rgba(255,255,255,0.07)", border: "1px solid rgba(255,255,255,0.14)",
            }}>
              <div onClick={() => setEditing(editing === route.id ? null : route.id)} style={{ padding: "14px 16px", cursor: "pointer" }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
                  <span style={{ fontFamily: "'Fraunces',serif", fontSize: 18, fontWeight: 600 }}>{route.name}</span>
                  <span style={{ fontSize: 12.5, color: "rgba(255,255,255,0.5)" }}>
                    {(route.totalDistance / 1000).toFixed(1)} km
                  </span>
                </div>
                <div style={{ display: "flex", gap: 12, marginTop: 6, fontSize: 12.5, color: "rgba(255,255,255,0.6)" }}>
                  <span>{route.timeMode === "depart" ? "depart" : "arrive"} {route.targetArrival}</span>
                  <span>·</span>
                  <span>{route.activeDays.length} days/wk</span>
                  <span>·</span>
                  <span>{confidence?.rides ?? 0} rides</span>
                </div>
              </div>
              {editing === route.id && (
                <RouteEditor
                  route={route}
                  controller={controller}
                  onSaved={async () => { setEditing(null); await onChanged(); }}
                  onDeleted={async () => { setEditing(null); await onChanged(); }}
                  onCancel={() => setEditing(null)}
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
        <button onClick={onHelp} style={{ ...backupBtn, width: "100%" }}>Help &amp; getting started</button>
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
const TERRAIN_MIN = 0.15, TERRAIN_MAX = 0.8;
const kClampUI = (k) => Math.max(TERRAIN_MIN, Math.min(TERRAIN_MAX, k));

function TerrainControls({ distanceM, value, onChange, learned, onLearnedEdit, example }) {
  const isLearned = !!learned;
  const speedKmh = value.speedKmh;
  const baselineSec = distanceM / (speedKmh / 3.6);
  const baselineMin = Math.round(baselineSec / 60);

  const commit = (next) => { if (isLearned) onLearnedEdit(next); else onChange(next); };
  const setSpeed = (kmh) => commit({ ...value, speedKmh: Math.max(1, Math.min(50, Math.round(kmh))) });
  const setK = (which, k) => {
    const kk = kClampUI(k);
    if (value.split) commit({ ...value, [which]: kk });
    else commit({ ...value, kHead: kk, kTail: kk });
  };

  return (
    <div>
      <label style={lbl}>Still-air speed</label>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 4 }}>
        <button onClick={() => setSpeed(speedKmh - 1)} style={spinBtn} aria-label="slower">−</button>
        <div style={{ flex: 1, textAlign: "center" }}>
          <span style={{ fontFamily: "'Fraunces',serif", fontSize: 24, fontWeight: 600 }}>{speedKmh}</span>
          <span style={{ fontSize: 13, color: "rgba(255,255,255,0.6)" }}> km/h</span>
        </div>
        <button onClick={() => setSpeed(speedKmh + 1)} style={spinBtn} aria-label="faster">+</button>
      </div>
      <div style={{ fontSize: 12.5, color: "rgba(255,255,255,0.55)", marginBottom: 16 }}>
        Still-air ride time: <b style={{ color: "rgba(255,255,255,0.85)" }}>{baselineMin} min</b>
      </div>

      {!value.split ? (
        <TerrainSlider title="Ground effect" k={value.kHead} baselineSec={baselineSec}
          learnedK={isLearned ? learned.kHead : null} showBoth example={example}
          onCommit={(k) => setK("kHead", k)} />
      ) : (
        <>
          <TerrainSlider title="Ground effect on headwind" k={value.kHead} baselineSec={baselineSec}
            learnedK={isLearned ? learned.kHead : null} sign={+1} example={example}
            onCommit={(k) => setK("kHead", k)} />
          <TerrainSlider title="Ground effect on tailwind" k={value.kTail} baselineSec={baselineSec}
            learnedK={isLearned ? learned.kTail : null} sign={-1} example={example}
            onCommit={(k) => setK("kTail", k)} />
        </>
      )}

      <label style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginTop: 14, cursor: "pointer" }}>
        <span style={{ fontSize: 13.5, color: "rgba(255,255,255,0.8)" }}>Split headwind &amp; tailwind</span>
        <input type="checkbox" checked={!!value.split}
          onChange={(e) => { if (e.target.checked) commit({ ...value, split: true }); else commit({ ...value, split: false, _collapse: true }); }}
          style={{ width: 40, height: 22, accentColor: "#e0a45e", cursor: "pointer" }} />
      </label>
    </div>
  );
}

function TerrainSlider({ title, k, baselineSec, learnedK, sign, showBoth, example, onCommit }) {
  const [local, setLocal] = useState(kClampUI(k));
  useEffect(() => { setLocal(kClampUI(k)); }, [k]);
  const offLow = learnedK != null && learnedK < TERRAIN_MIN;
  const offHigh = learnedK != null && learnedK > TERRAIN_MAX;
  const effK = learnedK != null ? learnedK : local;
  // Example times come from the real route geometry: a steady 20 km/h wind from
  // the route's mean bearing (headward) or its opposite (tailward). The factors
  // are k-independent, so time = baseline·(1 + k·factor).
  const hf = example ? example.headFactor : 1;
  const tf = example ? example.tailFactor : -1;
  const headT = Math.round((baselineSec * (1 + effK * hf)) / 60);
  const tailT = Math.round((baselineSec * (1 + effK * tf)) / 60);
  const oneT = sign === -1 ? tailT : headT;
  const headLabel = example ? example.headBearingLabel : "";
  const tailLabel = example ? example.tailBearingLabel : "";
  // Unsplit covers both examples → name both directions (head/tail are
  // opposite). Split: each slider uses its own wind direction.
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
      <input type="range" min={TERRAIN_MIN} max={TERRAIN_MAX} step={0.01} value={local}
        onChange={(e) => setLocal(Number(e.target.value))}
        onMouseUp={(e) => onCommit(Number(e.target.value))}
        onTouchEnd={(e) => onCommit(Number(e.target.value))}
        style={{ width: "100%", accentColor: "#e0a45e" }} />
      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 9.5, color: "rgba(255,255,255,0.4)", marginTop: 2 }}>
        <span style={{ textAlign: "center" }}>Sheltered<br />steep</span>
        <span>Urban</span>
        <span>Open</span>
        <span style={{ textAlign: "center" }}>Exposed<br />flat</span>
      </div>
      <div style={{ fontSize: 11.5, color: "#e0a45e", marginTop: 6 }}>
        ground effect factor k={effK.toFixed(2)}
      </div>
      <div style={{ fontSize: 12.5, color: "rgba(255,255,255,0.6)", marginTop: 3, lineHeight: 1.4 }}>
        <span style={{ color: "rgba(255,255,255,0.45)" }}>example ride, steady 20 km/h wind from {dirLabel}</span><br />
        {showBoth
          ? <>headwind <b style={{ color: "rgba(255,255,255,0.85)" }}>{headT} min</b> / tailwind <b style={{ color: "rgba(255,255,255,0.85)" }}>{tailT} min</b></>
          : <>{sign === -1 ? "tailwind" : "headwind"} <b style={{ color: "rgba(255,255,255,0.85)" }}>{oneT} min</b></>}
      </div>
    </div>
  );
}

const spinBtn = { width: 44, height: 44, borderRadius: 12, border: "1px solid rgba(255,255,255,0.2)", background: "rgba(255,255,255,0.08)", color: "#fff", fontSize: 22, cursor: "pointer", fontFamily: "inherit", lineHeight: 1 };

function RouteEditor({ route, controller, onSaved, onDeleted, onCancel }) {
  const [name, setName] = useState(route.name);
  const [arrival, setArrival] = useState(route.targetArrival);
  const [days, setDays] = useState(route.activeDays);
  const [timeMode, setTimeMode] = useState(route.timeMode === "depart" ? "depart" : "arrive");
  const [confirmDel, setConfirmDel] = useState(false);
  const toggleDay = (d) => setDays(days.includes(d) ? days.filter((x) => x !== d) : [...days, d]);

  // Tuning: load manual + learned state from the controller.
  const [tuning, setTuning] = useState(null); // { distanceM, manual, learned }
  const [val, setVal] = useState(null);       // { speedKmh, kHead, kTail, split }
  const [pending, setPending] = useState(null); // a Learned-state edit awaiting confirm
  const [collapseAsk, setCollapseAsk] = useState(null); // {next} split-off, which to keep
  useEffect(() => {
    let alive = true;
    controller.routeTuning(route.id).then((t) => {
      if (!alive || !t) return;
      setTuning(t);
      const src = t.learned || t.manual;
      const split = Math.abs((t.learned ? t.learned.kHead : t.manual.kHead) - (t.learned ? t.learned.kTail : t.manual.kTail)) > 0.02;
      setVal({ speedKmh: src.speedKmh, kHead: src.kHead, kTail: src.kTail, split });
    });
    return () => { alive = false; };
  }, [controller, route.id]);

  const isLearned = !!(tuning && tuning.learned);

  // Convert widget values → seed fields.
  const valToSeeds = (v) => {
    const baselineSec = tuning.distanceM / (v.speedKmh / 3.6);
    return {
      seedStillAirSec: Math.round(baselineSec),
      seedHeadwind20Sec: Math.round(baselineSec * (1 + v.kHead)),
      seedTailwind20Sec: Math.round(baselineSec * (1 - v.kTail)),
    };
  };

  const save = async () => {
    // In Manual state, persist the speed/ground-effect values as seeds — but
    // ONLY if they actually changed, because reseeding throws away any logged
    // rides. An unrelated edit (rename, schedule) must not wipe ride history.
    // In Learned state the seeds are model-driven and only change through the
    // explicit discard-learning confirm, so Save never reseeds here.
    if (!isLearned && val && tuning) {
      const m = tuning.manual;
      const changed =
        val.speedKmh !== m.speedKmh ||
        Math.abs(val.kHead - m.kHead) > 0.001 ||
        Math.abs(val.kTail - m.kTail) > 0.001;
      if (changed) await controller.resetRoute(route.id, valToSeeds(val));
    }
    await controller.updateRoute(route.id, {
      name: name.trim() || route.name,
      targetArrival: arrival,
      activeDays: days,
      timeMode,
    });
    onSaved();
  };
  const del = async () => { await controller.deleteRoute(route.id); onDeleted(); };

  // Manual edit: apply locally (and persist as seeds on Save changes).
  const onManualChange = (next) => {
    if (next._collapse) { delete next._collapse; setCollapseAsk({ next }); return; }
    setVal(next);
  };
  // Learned edit: hold it pending and ask to discard learning.
  const onLearnedEdit = (next) => {
    if (next._collapse) { delete next._collapse; setCollapseAsk({ next, learned: true }); return; }
    setPending(next);
  };
  const confirmDiscard = async () => {
    const v = pending;
    setVal(v); setPending(null);
    await controller.resetRoute(route.id, valToSeeds(v));
    await controller.updateRoute(route.id, {
      name: name.trim() || route.name, targetArrival: arrival, activeDays: days, timeMode,
    });
    onSaved();
  };
  const resolveCollapse = (keep) => {
    const base = collapseAsk.next;
    const k = keep === "head" ? val.kHead : val.kTail;
    const next = { ...base, split: false, kHead: k, kTail: k };
    setCollapseAsk(null);
    if (collapseAsk.learned) setPending(next); else setVal(next);
  };

  if (!val) return <div style={{ padding: 20, color: "rgba(255,255,255,0.5)" }}>Loading…</div>;

  return (
    <div style={{ padding: "4px 16px 16px", borderTop: "1px solid rgba(255,255,255,0.1)" }}>
      <label style={lbl}>Route name</label>
      <input value={name} onChange={(e) => setName(e.target.value)} style={INP} />

      <label style={{ ...lbl, marginTop: 12 }}>{timeMode === "depart" ? "Departure time" : "Target arrival"}</label>
      <input type="time" value={arrival} onChange={(e) => setArrival(e.target.value)} style={INP} />

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

      {/* Tuning: speed + terrain, manual or learned */}
      <div style={{ marginTop: 18, padding: "14px 14px", borderRadius: 12, background: "rgba(0,0,0,0.18)" }}>
        <RouteMap polyline={tuning.polyline} />
        {tuning.stats && (
          <div style={{ display: "flex", gap: 18, marginBottom: 14, paddingBottom: 12, borderBottom: "1px solid rgba(255,255,255,0.1)" }}>
            <Stat label="Distance" value={`${(tuning.stats.totalDistance / 1000).toFixed(2)} km`} />
            <Stat label="Elevation" value={tuning.stats.hasElevation ? `${Math.round(tuning.stats.climb)} m` : "—"} />
            <Stat label="Points" value={tuning.stats.pointCount} />
          </div>
        )}
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
          <span style={{ fontSize: 13, fontWeight: 600, color: "rgba(255,255,255,0.85)" }}>Ride times</span>
          <span style={{ fontSize: 11.5, color: isLearned ? "#6fd49a" : "rgba(255,255,255,0.45)" }}>
            {isLearned ? "learned from your rides" : "manual"}
          </span>
        </div>
        <TerrainControls distanceM={tuning.distanceM} value={val}
          onChange={(next) => { onManualChange(next); }}
          learned={isLearned ? tuning.learned : null}
          onLearnedEdit={onLearnedEdit} example={tuning.example} />
      </div>

      <div style={{ display: "flex", gap: 10, marginTop: 18 }}>
        <button onClick={onCancel} style={backupBtn}>Cancel</button>
        <button onClick={save} style={{ flex: 1, padding: 13, borderRadius: 12, border: "none", cursor: "pointer", fontFamily: "'Fraunces',serif", fontSize: 15, fontWeight: 600, background: "#e0a45e", color: "#1a1f3a" }}>Save changes</button>
      </div>

      {/* Confirm: discard learning to use manual edit */}
      {pending && (
        <div style={{ marginTop: 14, padding: "12px 14px", borderRadius: 12, background: "rgba(224,164,94,0.12)", border: "1px solid rgba(224,164,94,0.4)" }}>
          <div style={{ fontSize: 13, color: "#f0d8a8", marginBottom: 10, lineHeight: 1.45 }}>
            This route is tuned from your logged rides. Switch to these manual settings and discard the learned data?
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <button onClick={() => setPending(null)} style={backupBtn}>Keep learning</button>
            <button onClick={confirmDiscard} style={{ ...backupBtn, background: "rgba(224,164,94,0.9)", color: "#1a1f3a", border: "none" }}>Use manual</button>
          </div>
        </div>
      )}

      {/* Split-off: which value to keep */}
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

      {/* Delete route entirely */}
      <div style={{ display: "flex", gap: 10, marginTop: 16 }}>
        {!confirmDel ? (
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
 * Setup — create a route from a GPX file (real controller.createRoute)
 * ========================================================================== */
function Setup({ controller, onDone, onCancel }) {
  const [gpxText, setGpxText] = useState(null);
  const [preview, setPreview] = useState(null);
  const [err, setErr] = useState(null);
  const [form, setForm] = useState({ name: "", speedKmh: 16, kHead: 0.35, kTail: 0.35, split: false, arrival: "08:45", timeMode: "arrive", days: ["MO", "TU", "WE", "TH", "FR"] });
  const [saving, setSaving] = useState(false);
  const fileRef = useRef();
  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));

  const onFile = async (file) => {
    setErr(null);
    try {
      const text = await file.text();
      const p = await controller.previewGpx(text);
      setGpxText(text); setPreview(p);
      if (!form.name) set("name", file.name.replace(/\.gpx$/i, "").replace(/[_-]/g, " "));
    } catch (e) { setErr(e.message); }
  };

  const valid = preview && form.name.trim() && form.speedKmh > 0 && form.days.length;
  const save = async () => {
    setSaving(true);
    const baselineSec = preview.totalDistance / (form.speedKmh / 3.6);
    await controller.createRoute(gpxText, {
      name: form.name.trim(),
      seedStillAirSec: Math.round(baselineSec),
      seedHeadwind20Sec: Math.round(baselineSec * (1 + form.kHead)),
      seedTailwind20Sec: Math.round(baselineSec * (1 - form.kTail)),
      targetArrival: form.arrival, timeMode: form.timeMode, activeDays: form.days,
    });
    onDone();
  };
  const toggleDay = (d) => set("days", form.days.includes(d) ? form.days.filter((x) => x !== d) : [...form.days, d]);

  return (
    <div style={{ height: "100%", overflowY: "auto", background: "linear-gradient(165deg,#12152b,#1d1b38 55%,#281f44)", color: "#fff", paddingBottom: 30 }}>
      <div style={{ padding: "26px 22px 8px", display: "flex", alignItems: "center", gap: 12 }}>
        {onCancel && (
          <button onClick={onCancel} style={{ background: "transparent", border: "none", cursor: "pointer", color: "rgba(255,255,255,0.6)", fontSize: 22, padding: 0, lineHeight: 1 }} aria-label="Back">‹</button>
        )}
        <span style={{ fontFamily: "'Fraunces',serif", fontSize: 26, fontWeight: 600 }}>New route</span>
      </div>
      <div style={{ padding: "0 22px 16px", fontSize: 13.5, color: "rgba(255,255,255,0.55)" }}>Each destination needs two routes, one going and one returning.</div>

      <Block n="1" title="Load GPX">
        {!preview ? (
          <div onClick={() => fileRef.current.click()} style={{
            padding: "28px 18px", borderRadius: 16, textAlign: "center", cursor: "pointer",
            border: "1.5px dashed rgba(255,255,255,0.28)", background: "rgba(255,255,255,0.04)",
          }}>
            <div style={{ fontSize: 15, fontWeight: 500 }}>Tap to choose a .gpx file</div>
            <input ref={fileRef} type="file" accept=".gpx" hidden onChange={(e) => e.target.files[0] && onFile(e.target.files[0])} />
          </div>
        ) : (
          <div style={{ borderRadius: 16, padding: 16, background: "rgba(255,255,255,0.07)", border: "1px solid rgba(255,255,255,0.14)" }}>
            <RouteMap polyline={preview.polyline} />
            <div style={{ display: "flex", gap: 18 }}>
              <Stat label="Distance" value={`${(preview.totalDistance / 1000).toFixed(2)} km`} />
              <Stat label="Elevation" value={preview.hasElevation ? `${Math.round(preview.climb)} m` : "—"} />
              <Stat label="Points" value={preview.pointCount} />
            </div>
            {preview.warnings?.map((w, i) => <Warn key={i}>{w}</Warn>)}
          </div>
        )}
        {err && <Warn>{err}</Warn>}
      </Block>

      {preview && (
        <>
          <Block n="2" title="Name">
            <input value={form.name} onChange={(e) => set("name", e.target.value)} placeholder="Home → Office" style={INP} />
          </Block>
          <Block n="3" title="Ride times">
            <TerrainControls distanceM={preview.totalDistance}
              value={{ speedKmh: form.speedKmh, kHead: form.kHead, kTail: form.kTail, split: form.split }}
              onChange={(next) => {
                if (next._collapse) {
                  // collapsing the split during setup: keep the headwind value
                  // (setup is always manual; no confirm needed)
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
            <input type="time" value={form.arrival} onChange={(e) => set("arrival", e.target.value)} style={INP} />
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
 * Capture — tap to start, auto-finish, confirm (real controller.recordRide)
 * ========================================================================== */
function Capture({ controller, route, onDone }) {
  const [state, setState] = useState("armed");
  const [elapsed, setElapsed] = useState(0);
  const [paused, setPaused] = useState(false);
  const [result, setResult] = useState(null);
  const [confirm, setConfirm] = useState(null);
  const [adjustMin, setAdjustMin] = useState(0); // minutes added/removed at review
  const ref = useRef({});

  if (!route) return <Empty />;

  const [farConfirm, setFarConfirm] = useState(null); // {metres} when far from start

  // Begin recording. If GPS says we're well away from the route's start, ask
  // first — guards against accidentally recording from the wrong place.
  const beginRecording = async () => {
    setState("riding"); setElapsed(0); setPaused(false); setConfirm(null); setAdjustMin(0);
    const handle = await controller.startRide(route, {
      onTick: ({ elapsedSec }) => setElapsed(elapsedSec),
      onFinish: (r) => {
        setResult({ actualSec: r.actualSec, distance: r.distanceM, startedAt: r.startedAt, endedAt: r.endedAt, pausedSec: r.pausedSec || 0, forecastWind: r.forecastWind });
        setState("done");
      },
    }).catch((e) => { alert(e.message); setState("armed"); });
    ref.current = { handle };
  };

  const start = async () => {
    const metres = await controller.distanceToStart(route);
    if (metres != null && metres > 100) {
      setFarConfirm({ metres }); // ask before recording
      return;
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

  useEffect(() => () => ref.current.handle?.stop?.(), []);

  const togglePause = () => {
    const h = ref.current.handle;
    if (!h) return;
    if (paused) { h.resume?.(); setPaused(false); }
    else { h.pause?.(); setPaused(true); }
  };

  const fmtC = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;

  // Final ride time after any manual adjustment (never below zero).
  const adjustedSec = result ? Math.max(0, result.actualSec + adjustMin * 60) : 0;

  const submit = async () => {
    setConfirm("yes");
    await controller.recordRide({
      routeId: route.id, startedAt: result.startedAt, endedAt: result.endedAt,
      actualTimeSec: adjustedSec, forecastWind: result.forecastWind,
      adjustMin: adjustMin || 0, pausedSec: result.pausedSec || 0,
      usable: true,
    });
  };
  const discard = () => { setConfirm("discarded"); /* nothing stored */ };

  return (
    <div style={{
      height: "100%", color: "#fff", padding: 24, position: "relative",
      background: state === "riding" ? (paused ? "linear-gradient(165deg,#2a2438,#3a3048 55%,#473c52)" : "linear-gradient(165deg,#16324a,#1d4258 55%,#2a5a6e)") : "linear-gradient(165deg,#12152b,#1d1b38 55%,#281f44)",
      transition: "background 1s", display: "flex", flexDirection: "column",
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
              You are {farConfirm.metres >= 1000 ? `${(farConfirm.metres / 1000).toFixed(1)} km` : `${farConfirm.metres} metres`} away from the start of this route. Record anyway?
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
      {state === "riding" && (
        <div style={{ flex: 1, paddingTop: 40 }}>
          <div style={{ fontSize: 13, color: "rgba(255,255,255,0.55)" }}>{paused ? "Paused · time not counting" : "Elapsed · GPS active"}</div>
          <div style={{ fontFamily: "'Fraunces',serif", fontSize: 76, fontWeight: 600, fontVariantNumeric: "tabular-nums", opacity: paused ? 0.6 : 1 }}>{fmtC(elapsed)}</div>
          <div style={{ fontSize: 13, color: "rgba(255,255,255,0.5)", marginTop: 20 }}>
            {paused ? "Resume when you're moving again." : "Finish detected automatically near your destination."}
          </div>
          <div style={{ display: "flex", gap: 12, marginTop: 28 }}>
            <button onClick={togglePause} style={{ flex: 1, padding: 14, borderRadius: 14, cursor: "pointer", fontFamily: "'Fraunces',serif", fontSize: 15, fontWeight: 600, background: paused ? "#6fd49a" : "rgba(255,255,255,0.12)", color: paused ? "#0f2a1c" : "#fff", border: paused ? "none" : "1px solid rgba(255,255,255,0.18)" }}>
              {paused ? "Continue" : "Pause"}
            </button>
            <button onClick={() => ref.current.handle?.manualFinish?.()} style={{ flex: 1, padding: 14, borderRadius: 14, cursor: "pointer", fontFamily: "inherit", fontSize: 14, fontWeight: 500, background: "rgba(255,255,255,0.1)", color: "#fff", border: "1px solid rgba(255,255,255,0.18)" }}>Finish now</button>
          </div>
        </div>
      )}
      {state === "done" && result && (
        <div style={{ flex: 1, paddingTop: 20, overflowY: "auto" }}>
          <div style={{ textAlign: "center" }}>
            <div style={{ fontSize: 13, color: "rgba(255,255,255,0.55)" }}>Ride complete</div>
            <div style={{ fontFamily: "'Fraunces',serif", fontSize: 70, fontWeight: 600 }}>{fmtC(adjustedSec)}</div>
            <div style={{ fontSize: 14, color: "rgba(255,255,255,0.65)" }}>
              {(result.distance / 1000).toFixed(2)} km{result.pausedSec >= 30 ? ` · ${Math.round(result.pausedSec / 60)} min paused (excluded)` : ""}
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
                Accept to train the model, or discard if it isn't representative.
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
                {confirm === "yes" ? "Added to your model" : "Ride discarded"}
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
  const n = confidence?.rides || 0;
  const dots = confidence?.level === "good" ? 3 : confidence?.level === "learning" ? 2 : 1;
  return <span style={{ display: "inline-flex", alignItems: "center", gap: 7, fontSize: 12, color: "rgba(255,255,255,0.7)" }}>
    <span style={{ display: "inline-flex", gap: 3 }}>{[0, 1, 2].map((i) => <span key={i} style={{ width: 6, height: 6, borderRadius: 6, background: i < dots ? "rgba(255,255,255,0.9)" : "rgba(255,255,255,0.25)" }} />)}</span>
    {n} rides
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
 * HelpPanel — first-launch welcome + re-readable help (install, GPX, training)
 * ========================================================================== */
function detectInstall() {
  if (typeof navigator === "undefined") return "unknown";
  const standalone =
    (typeof window !== "undefined" && window.matchMedia && window.matchMedia("(display-mode: standalone)").matches) ||
    (typeof navigator !== "undefined" && navigator.standalone);
  if (standalone) return "installed";
  const ua = navigator.userAgent || "";
  if (/iPhone|iPad|iPod/i.test(ua)) return "ios";
  if (/Android/i.test(ua)) return "android";
  return "desktop";
}

const INSTALL_TEXT = {
  ios: "Tap the Share button, then “Add to Home Screen”.",
  android: "Open the browser menu, then “Install app” (or “Add to Home Screen”).",
  desktop: "Click the install icon in the address bar, or browser menu → “Install”.",
  unknown: "Add this page to your home screen from your browser’s menu.",
};

function HelpPanel({ onClose }) {
  const platform = detectInstall();
  const installed = platform === "installed";
  const h3 = { fontFamily: "'Fraunces',serif", fontSize: 17, fontWeight: 600, color: "#fff", margin: "0 0 6px" };
  const p = { fontSize: 13.5, color: "rgba(255,255,255,0.75)", lineHeight: 1.5, margin: "0 0 4px" };
  const ol = { fontSize: 13.5, color: "rgba(255,255,255,0.75)", lineHeight: 1.55, margin: "2px 0 4px", paddingLeft: 20 };
  const section = { padding: "16px 0", borderBottom: "1px solid rgba(255,255,255,0.1)" };

  return (
    <div style={{
      position: "absolute", inset: 0, zIndex: 50, display: "flex", flexDirection: "column",
      background: "linear-gradient(165deg,#12152b,#1d1b38 55%,#281f44)", color: "#fff",
    }}>
      <div style={{ flex: 1, overflowY: "auto", padding: "calc(28px + env(safe-area-inset-top)) 24px 20px" }}>
        <div style={{ fontFamily: "'Fraunces',serif", fontSize: 24, fontWeight: 600, marginBottom: 2 }}>Ride the Wind</div>
        <div style={{ fontSize: 13.5, color: "rgba(255,255,255,0.6)", marginBottom: 14 }}>
          Predicts your bike commute time from the forecast wind, so you know when to leave.
        </div>

        {!installed && (
          <div style={section}>
            <h3 style={h3}>Install it</h3>
            <p style={p}>{INSTALL_TEXT[platform] || INSTALL_TEXT.unknown}</p>
            <p style={{ ...p, color: "rgba(255,255,255,0.5)" }}>Gives a full-screen app that works offline and opens like any other.</p>
          </div>
        )}

        <div style={section}>
          <h3 style={h3}>The three tabs</h3>
          <p style={p}>
            <b>Plan</b> shows when to leave for the selected route on any day this week — tap a day along the top. The headline tells you if the wind means leaving earlier or later than usual, with the leave‑by time and a live countdown when it’s near.
          </p>
          <p style={p}>
            <b>Ride</b> records an actual ride by GPS. Pause for stops, and at the end nudge the time or discard it — accepted rides train the model.
          </p>
          <p style={p}>
            <b>Routes</b> is where you add and tune routes, and set the margin of error.
          </p>
          <p style={{ ...p, color: "rgba(255,255,255,0.5)" }}>
            On the Plan tab, <b>Explore</b> lets you check a different time on the chosen day, and <b>Go now</b> shows the ride if you left this minute.
          </p>
        </div>

        <div style={section}>
          <h3 style={h3}>Tuning a route</h3>
          <p style={p}>
            Each route starts from two things you set: your <b>still‑air speed</b> and a <b>ground effect</b> (how sheltered or exposed the route is, which sets how much wind slows or speeds you). That’s enough to use it from day one.
          </p>
          <p style={p}>
            As you log rides it learns your real numbers — separately for headwind and tailwind days — and takes over the tuning, well‑settled after about <b>ten rides in each direction</b>. If the learned times aren’t working for you, just move a slider to go back to setting them by hand.
          </p>
          <p style={{ ...p, color: "rgba(255,255,255,0.5)" }}>
            Behind each forecast the app blends an ensemble of about 50 separate wind forecasts for your route — more detailed wind data than a typical weather app shows. Each destination needs two routes, one going and one returning.
          </p>
        </div>

        <div style={section}>
          <h3 style={h3}>Making a GPX file for a route</h3>
          <p style={p}>
            A route needs a GPX file (its path on the map). If you’ve already got one from Strava, Komoot, Garmin or similar, just open it here. Otherwise it takes a minute to make one:
          </p>
          <p style={{ ...p, fontWeight: 600, color: "rgba(255,255,255,0.85)", marginTop: 8 }}>Mapy.com — good for dedicated bike lanes</p>
          <ol style={ol}>
            <li>Open <b>Mapy.com</b>, then the planner (menu → directions).</li>
            <li>Choose the <b>bike</b> mode so it routes along bike‑friendly streets.</li>
            <li>Type your start in box A and destination in box B — the line draws itself.</li>
            <li>Expand the route panel, scroll down, and tap <b>Export</b>.</li>
          </ol>
          <p style={{ ...p, fontWeight: 600, color: "rgba(255,255,255,0.85)", marginTop: 8 }}>OnTheGoMap.com — the fast click‑and‑go way</p>
          <ol style={ol}>
            <li>Open <b>OnTheGoMap.com</b> and set the mode to <b>bike</b> (top centre).</li>
            <li>Click your start on the map, then your destination — it snaps to the roads.</li>
            <li>Open the menu (top right) and tap <b>Export as GPX</b>.</li>
          </ol>
          <p style={{ ...p, color: "rgba(255,255,255,0.5)" }}>
            Either way the file lands in your Downloads folder — open it here to add the route.
          </p>
        </div>

        <div style={{ padding: "16px 0 4px" }}>
          <p style={{ fontSize: 12.5, color: "rgba(255,255,255,0.55)", lineHeight: 1.55, margin: 0 }}>
            Ride the Wind gives estimates from weather forecasts. Forecasts are uncertain and conditions change — treat the times as a guide, not a guarantee, and ride safely and within the law. Provided as is, with no warranty and no liability for lateness or any other outcome. It’s free and open source — made by Chris Hilder and released under the MIT License, so anyone can use, study, modify, and share it.
          </p>
        </div>
      </div>

      <div style={{ padding: "12px 24px calc(16px + env(safe-area-inset-bottom))", borderTop: "1px solid rgba(255,255,255,0.12)" }}>
        <div style={{ fontSize: 11.5, color: "rgba(255,255,255,0.45)", textAlign: "center", marginBottom: 10 }}>
          By using Ride the Wind you agree to these terms.
        </div>
        <button onClick={onClose} style={{
          width: "100%", padding: 14, borderRadius: 12, border: "none", cursor: "pointer",
          fontFamily: "'Fraunces',serif", fontSize: 16, fontWeight: 600, background: "#e0a45e", color: "#1a1f3a",
        }}>Got it</button>
      </div>
    </div>
  );
}

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
      <div style={{ fontSize: 14, color: "rgba(255,255,255,0.6)", marginTop: 8 }}>Add a route in the Routes tab to see your morning verdict.</div>
    </div>
  </div>;
}

const INP = { width: "100%", padding: "12px 14px", borderRadius: 12, fontSize: 15, fontFamily: "inherit", background: "rgba(255,255,255,0.07)", border: "1px solid rgba(255,255,255,0.16)", color: "#fff", outline: "none" };
