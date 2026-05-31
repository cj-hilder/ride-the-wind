import React, { useState, useEffect, useCallback, useRef } from "react";

/* ============================================================================
 * Ride the Wind — App shell
 *
 * The thin top layer that ties the three screens together over the real
 * AppController (app.js → composes gpxRoute, windModel, learning, alertEngine,
 * prediction, storage, scheduler). This file owns navigation and the live data
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

/* dawn-to-dusk palette shared with the screens */
const SKY = {
  predawn: ["#1a1f3a", "#2d2a52", "#3d3463"],
  sunrise: ["#f4a07c", "#e8849a", "#a76b97"],
  day: ["#7db8d8", "#9fc9e0", "#c5dced"],
  dusk: ["#e89b6c", "#cf7a82", "#7a5b8c"],
  night: ["#1a1f3a", "#2d2a52", "#3d3463"],
};
const skyFor = (hour) =>
  hour < 6 ? SKY.predawn : hour < 9 ? SKY.sunrise : hour < 17 ? SKY.day : hour < 20 ? SKY.dusk : SKY.night;
const ACCENT = { headwind: "#5b8fc7", tailwind: "#e0a45e", normal: "#9aa7b0" };
const fmtMin = (sec) => `${Math.round(sec / 60)} min`;

// Label the forecast day: "today"/"tomorrow" when close, else the weekday name.
const WEEKDAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
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
  const [activeRouteId, setActiveRouteId] = useState(null);
  const [banner, setBanner] = useState(null); // alert summary banner

  const refresh = useCallback(async () => {
    setLoading(true);
    const list = await controller.listRoutesWithVerdict();
    setRoutes(list);
    if (!activeRouteId && list[0]) setActiveRouteId(list[0].route.id);
    setLoading(false);
  }, [controller, activeRouteId]);

  useEffect(() => {
    controller.start({
      onAlerts: (produced) => {
        const notable = produced.filter((p) => p.verdict.verdict !== "normal");
        if (notable.length) setBanner(notable[0].verdict.message);
      },
    });
    refresh();
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

      {banner && (
        <div onClick={() => setBanner(null)} style={{
          position: "absolute", top: 0, left: 0, right: 0, zIndex: 50, cursor: "pointer",
          padding: "14px 18px calc(14px + env(safe-area-inset-top))",
          background: "rgba(91,143,199,0.95)", backdropFilter: "blur(8px)", color: "#fff",
          fontSize: 13.5, fontWeight: 500, animation: "slidedown 0.4s both",
        }}>{banner} <span style={{ opacity: 0.6, marginLeft: 6 }}>· tap to dismiss</span></div>
      )}

      <div style={{ flex: 1, overflow: "hidden", position: "relative" }}>
        {loading ? (
          <Loading />
        ) : screen === "home" ? (
          <Home active={active} routes={routes} setActiveRouteId={setActiveRouteId} />
        ) : screen === "routes" ? (
          <Routes
            controller={controller}
            routes={routes}
            onChanged={refresh}
            onAddNew={() => setScreen("setup")}
          />
        ) : screen === "setup" ? (
          <Setup controller={controller}
            onDone={async () => { await refresh(); setScreen("routes"); }}
            onCancel={() => setScreen("routes")} />
        ) : (
          <Capture controller={controller} route={active?.route}
            onDone={async () => { await refresh(); setScreen("home"); }} />
        )}
      </div>

      <TabBar screen={screen} setScreen={setScreen} hasRoutes={routes.length > 0} />
    </div>
  );
}

/* ============================================================================
 * Home — verdict for the active route
 * ========================================================================== */
function Home({ active, routes, setActiveRouteId }) {
  if (!active) return <Empty />;
  const { route, verdict, range, confidence, expect } = active;
  if (!verdict) return <Empty name={route.name} />;

  const accent = ACCENT[verdict.verdict];
  const sky = skyFor(new Date(verdict.departureMs).getHours());
  const headline = {
    headwind: `Leave ${Math.abs(verdict.deltaMin)} min early`,
    tailwind: `Sleep in ${Math.abs(verdict.deltaMin)} min`,
    normal: "Normal morning",
  }[verdict.verdict];
  const rangeMin = range ? Math.round(Math.abs(range.highSec - range.lowSec) / 60) : 0;

  return (
    <div style={{
      position: "relative", height: "100%",
      background: `linear-gradient(165deg, ${sky[0]}, ${sky[1]} 55%, ${sky[2]})`,
      transition: "background 1.2s ease", display: "flex", flexDirection: "column",
    }}>
      <WindField verdict={verdict.verdict} accent={accent} />
      <div style={{ position: "relative", zIndex: 2, padding: "26px 24px 0", display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
        <span style={{ fontFamily: "'Fraunces', serif", fontSize: 19, fontWeight: 600, color: "rgba(255,255,255,0.95)" }}>Ride the Wind</span>
      </div>

      <div style={{ position: "relative", zIndex: 2, flex: 1, display: "flex", flexDirection: "column", justifyContent: "center", padding: "0 24px" }}>
        <div style={{ animation: "rise 0.8s both" }}>
          <div style={{
            display: "inline-flex", alignItems: "center", gap: 8, padding: "5px 12px", borderRadius: 100,
            background: "rgba(255,255,255,0.14)", backdropFilter: "blur(8px)", border: `1px solid ${accent}66`,
            fontSize: 12.5, color: "rgba(255,255,255,0.92)", marginBottom: 20,
          }}>
            <Arrow verdict={verdict.verdict} accent={accent} />
            {route.name}
          </div>
          <div style={{ fontFamily: "'Fraunces', serif", fontWeight: 600, fontSize: "clamp(36px,10vw,52px)", lineHeight: 1.03, color: "#fff", letterSpacing: "-0.03em" }}>
            {headline}
          </div>
          <div style={{ marginTop: 26 }}>
            <div style={{ fontSize: 13, color: "rgba(255,255,255,0.6)", marginBottom: 4 }}>Leave by</div>
            <div style={{ display: "flex", alignItems: "baseline", gap: 12 }}>
              <span style={{ fontFamily: "'Fraunces', serif", fontSize: 60, fontWeight: 600, lineHeight: 1, color: "#fff", fontVariantNumeric: "tabular-nums" }}>
                {verdict.departureHHMM}
              </span>
              {verdict.verdict !== "normal" && (
                <span style={{ fontSize: 15, color: "rgba(255,255,255,0.55)", textDecoration: "line-through" }}>{verdict.normalDepartureHHMM}</span>
              )}
            </div>
            <div style={{ fontSize: 14, color: "rgba(255,255,255,0.7)", marginTop: 10 }}>
              to arrive {verdict.arrivalHHMM} {dayLabel(verdict.arrivalMs)}
              {rangeMin >= 2 && <span style={{ color: "rgba(255,255,255,0.5)" }}> · ±{rangeMin} min spread</span>}
            </div>
            {expect && expect.line && (
              <div style={{ fontSize: 13.5, color: "rgba(255,255,255,0.6)", marginTop: 8, letterSpacing: "0.01em" }}>
                {expect.line}
              </div>
            )}
          </div>
        </div>
      </div>

      <div style={{
        position: "relative", zIndex: 2, margin: "0 16px 14px", padding: 16, borderRadius: 20,
        background: "rgba(255,255,255,0.1)", backdropFilter: "blur(14px)", border: "1px solid rgba(255,255,255,0.16)",
        animation: "rise 0.8s 0.12s both",
      }}>
        <RowLine label="Still-air baseline" value={fmtMin(verdict.baselineSec)} />
        <RowLine label="Wind effect" value={`${verdict.deltaMin >= 0 ? "+" : ""}${verdict.deltaMin} min`} color={accent} />
        <div style={{ marginTop: 12, paddingTop: 12, borderTop: "1px solid rgba(255,255,255,0.12)", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <ConfidenceDots confidence={confidence} />
          <span style={{ fontSize: 12, color: "rgba(255,255,255,0.5)" }}>k = {verdict.k?.toFixed(2) ?? "—"}</span>
        </div>
      </div>

      {routes.length > 1 && (
        <div style={{ position: "relative", zIndex: 2, display: "flex", gap: 8, padding: "0 16px 16px" }}>
          {routes.map((r) => (
            <button key={r.route.id} onClick={() => setActiveRouteId(r.route.id)} style={{
              flex: 1, padding: "9px 6px", borderRadius: 12, border: "none", cursor: "pointer",
              fontFamily: "inherit", fontSize: 12, fontWeight: 600,
              background: r.route.id === active.route.id ? "rgba(255,255,255,0.18)" : "rgba(255,255,255,0.06)",
              color: r.route.id === active.route.id ? "#fff" : "rgba(255,255,255,0.5)",
            }}>{r.route.name.split(" ")[0]}</button>
          ))}
        </div>
      )}
    </div>
  );
}

/* ============================================================================
 * Routes — list, edit, delete existing routes + backup (export/import)
 * ========================================================================== */
const DAY_CODES = [["MO", "M"], ["TU", "T"], ["WE", "W"], ["TH", "T"], ["FR", "F"], ["SA", "S"], ["SU", "S"]];

function Routes({ controller, routes, onChanged, onAddNew }) {
  const [editing, setEditing] = useState(null); // route id being edited
  const fileRef = useRef();

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
    <div style={{ height: "100%", overflowY: "auto", background: "linear-gradient(165deg,#1a1f3a,#2d2a52 55%,#3d3463)", color: "#fff", paddingBottom: 30 }}>
      <div style={{ padding: "26px 22px 4px", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <span style={{ fontFamily: "'Fraunces',serif", fontSize: 26, fontWeight: 600 }}>Routes</span>
        <button onClick={onAddNew} style={{
          padding: "9px 16px", borderRadius: 100, border: "none", cursor: "pointer",
          fontFamily: "'Fraunces',serif", fontSize: 14, fontWeight: 600, background: "#e0a45e", color: "#1a1f3a",
        }}>+ New</button>
      </div>
      <div style={{ padding: "0 22px 16px", fontSize: 13.5, color: "rgba(255,255,255,0.55)" }}>
        Each direction of a commute is its own route.
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
                  <span>arrive {route.targetArrival}</span>
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
    </div>
  );
}

function RouteEditor({ route, controller, onSaved, onDeleted }) {
  const [arrival, setArrival] = useState(route.targetArrival);
  const [days, setDays] = useState(route.activeDays);
  const [threshold, setThreshold] = useState(route.alertThresholdMin ?? "");
  const [confirmDel, setConfirmDel] = useState(false);
  const toggleDay = (d) => setDays(days.includes(d) ? days.filter((x) => x !== d) : [...days, d]);

  const save = async () => {
    await controller.updateRoute(route.id, {
      targetArrival: arrival,
      activeDays: days,
      alertThresholdMin: threshold === "" ? null : Math.round(parseFloat(threshold)),
    });
    onSaved();
  };
  const del = async () => { await controller.deleteRoute(route.id); onDeleted(); };

  return (
    <div style={{ padding: "4px 16px 16px", borderTop: "1px solid rgba(255,255,255,0.1)" }}>
      <label style={lbl}>Target arrival</label>
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

      <label style={{ ...lbl, marginTop: 12 }}>Alert threshold (minutes) <span style={{ color: "rgba(255,255,255,0.35)" }}>· blank = default</span></label>
      <input value={threshold} onChange={(e) => setThreshold(e.target.value)} inputMode="decimal" placeholder="4" style={INP} />

      <div style={{ display: "flex", gap: 10, marginTop: 16 }}>
        {!confirmDel ? (
          <>
            <button onClick={() => setConfirmDel(true)} style={{ ...backupBtn, flex: "0 0 auto", color: "#f0a08c", borderColor: "rgba(224,120,94,0.4)" }}>Delete</button>
            <button onClick={save} style={{ flex: 1, padding: 13, borderRadius: 12, border: "none", cursor: "pointer", fontFamily: "'Fraunces',serif", fontSize: 15, fontWeight: 600, background: "#e0a45e", color: "#1a1f3a" }}>Save changes</button>
          </>
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
  const [form, setForm] = useState({ name: "", still: "", head: "", tail: "", arrival: "08:45", days: ["MO", "TU", "WE", "TH", "FR"] });
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

  const valid = preview && form.name.trim() && parseFloat(form.still) > 0 && form.days.length;
  const save = async () => {
    setSaving(true);
    await controller.createRoute(gpxText, {
      name: form.name.trim(),
      seedStillAirSec: Math.round(parseFloat(form.still) * 60),
      seedHeadwind20Sec: form.head ? Math.round(parseFloat(form.head) * 60) : null,
      seedTailwind20Sec: form.tail ? Math.round(parseFloat(form.tail) * 60) : null,
      targetArrival: form.arrival, activeDays: form.days,
    });
    onDone();
  };
  const toggleDay = (d) => set("days", form.days.includes(d) ? form.days.filter((x) => x !== d) : [...form.days, d]);

  return (
    <div style={{ height: "100%", overflowY: "auto", background: "linear-gradient(165deg,#1a1f3a,#2d2a52 55%,#3d3463)", color: "#fff", paddingBottom: 30 }}>
      <div style={{ padding: "26px 22px 8px", display: "flex", alignItems: "center", gap: 12 }}>
        {onCancel && (
          <button onClick={onCancel} style={{ background: "transparent", border: "none", cursor: "pointer", color: "rgba(255,255,255,0.6)", fontSize: 22, padding: 0, lineHeight: 1 }} aria-label="Back">‹</button>
        )}
        <span style={{ fontFamily: "'Fraunces',serif", fontSize: 26, fontWeight: 600 }}>New route</span>
      </div>
      <div style={{ padding: "0 22px 16px", fontSize: 13.5, color: "rgba(255,255,255,0.55)" }}>Each direction is its own route.</div>

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
          <Block n="3" title="Your usual times (minutes)">
            <input value={form.still} onChange={(e) => set("still", e.target.value)} inputMode="decimal" placeholder="Still-air ride time *" style={INP} />
            <div style={{ display: "flex", gap: 10, marginTop: 10 }}>
              <input value={form.head} onChange={(e) => set("head", e.target.value)} inputMode="decimal" placeholder="20km/h headwind" style={INP} />
              <input value={form.tail} onChange={(e) => set("tail", e.target.value)} inputMode="decimal" placeholder="20km/h tailwind" style={INP} />
            </div>
          </Block>
          <Block n="4" title="When you ride">
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
  const [result, setResult] = useState(null);
  const [confirm, setConfirm] = useState(null);
  const ref = useRef({});

  if (!route) return <Empty />;

  const start = async () => {
    setState("riding"); setElapsed(0); setConfirm(null);
    const handle = await controller.startRide(route, {
      onTick: ({ elapsedSec }) => setElapsed(elapsedSec),
      onFinish: (r) => {
        setResult({ actualSec: r.actualSec, distance: r.distanceM, startedAt: r.startedAt, endedAt: r.endedAt, forecastWind: r.forecastWind });
        setState("done");
      },
    }).catch((e) => { alert(e.message); setState("armed"); });
    ref.current = { handle };
  };

  useEffect(() => () => ref.current.handle?.stop?.(), []);

  const fmtC = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
  const submit = async (usable, reason) => {
    setConfirm(usable ? "yes" : "no");
    await controller.recordRide({
      routeId: route.id, startedAt: result.startedAt, endedAt: result.endedAt,
      actualTimeSec: result.actualSec, forecastWind: result.forecastWind,
      usable, excludeReason: reason || null,
    });
  };

  return (
    <div style={{
      height: "100%", color: "#fff", padding: 24,
      background: state === "riding" ? "linear-gradient(165deg,#16324a,#1d4258 55%,#2a5a6e)" : "linear-gradient(165deg,#1a1f3a,#2d2a52 55%,#3d3463)",
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
      {state === "riding" && (
        <div style={{ flex: 1, paddingTop: 40 }}>
          <div style={{ fontSize: 13, color: "rgba(255,255,255,0.55)" }}>Elapsed · GPS active</div>
          <div style={{ fontFamily: "'Fraunces',serif", fontSize: 76, fontWeight: 600, fontVariantNumeric: "tabular-nums" }}>{fmtC(elapsed)}</div>
          <div style={{ fontSize: 13, color: "rgba(255,255,255,0.5)", marginTop: 20 }}>Finish detected automatically near your destination.</div>
          <button onClick={() => ref.current.handle?.manualFinish?.()} style={{ marginTop: 28, width: "100%", padding: 14, borderRadius: 14, cursor: "pointer", fontFamily: "inherit", fontSize: 14, fontWeight: 500, background: "rgba(255,255,255,0.1)", color: "#fff", border: "1px solid rgba(255,255,255,0.18)" }}>Finish now</button>
        </div>
      )}
      {state === "done" && result && (
        <div style={{ flex: 1, paddingTop: 20 }}>
          <div style={{ textAlign: "center" }}>
            <div style={{ fontSize: 13, color: "rgba(255,255,255,0.55)" }}>Ride complete</div>
            <div style={{ fontFamily: "'Fraunces',serif", fontSize: 70, fontWeight: 600 }}>{fmtC(result.actualSec)}</div>
            <div style={{ fontSize: 14, color: "rgba(255,255,255,0.65)" }}>{(result.distance / 1000).toFixed(2)} km</div>
          </div>
          {confirm === null && (
            <div style={{ marginTop: 36 }}>
              <div style={{ fontFamily: "'Fraunces',serif", fontSize: 20, fontWeight: 600, textAlign: "center" }}>Was this a typical ride?</div>
              <div style={{ fontSize: 13, color: "rgba(255,255,255,0.55)", textAlign: "center", margin: "8px 0 22px" }}>We only learn from clean rides.</div>
              <div style={{ display: "flex", gap: 12 }}>
                <button onClick={() => submit(false)} style={{ flex: 1, padding: 15, borderRadius: 14, cursor: "pointer", fontFamily: "inherit", fontSize: 15, fontWeight: 600, background: "rgba(255,255,255,0.08)", color: "#fff", border: "1px solid rgba(255,255,255,0.18)" }}>No, unusual</button>
                <button onClick={() => submit(true)} style={{ flex: 1.4, padding: 15, borderRadius: 14, cursor: "pointer", fontFamily: "'Fraunces',serif", fontSize: 16, fontWeight: 600, background: "#6fd49a", color: "#0f2a1c", border: "none" }}>Yes, typical</button>
              </div>
            </div>
          )}
          {confirm && (
            <div style={{ marginTop: 36, textAlign: "center" }}>
              <div style={{ fontSize: 36 }}>{confirm === "yes" ? "✓" : "·"}</div>
              <div style={{ fontFamily: "'Fraunces',serif", fontSize: 19, fontWeight: 600, marginTop: 6 }}>
                {confirm === "yes" ? "Added to your model" : "Stored, kept out of learning"}
              </div>
              <button onClick={onDone} style={{ marginTop: 26, width: "100%", padding: 14, borderRadius: 14, cursor: "pointer", fontFamily: "inherit", fontSize: 14, background: "rgba(255,255,255,0.1)", color: "#fff", border: "1px solid rgba(255,255,255,0.18)" }}>Done</button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/* ============================================================================
 * Shared bits
 * ========================================================================== */
function TabBar({ screen, setScreen, hasRoutes }) {
  const tabs = [["home", "Today"], ["capture", "Ride"], ["routes", "Routes"]];
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
function Loading() {
  return <div style={{ height: "100%", display: "grid", placeItems: "center", background: "linear-gradient(165deg,#1a1f3a,#2d2a52)", color: "rgba(255,255,255,0.5)", fontSize: 14 }}>Loading…</div>;
}
function Empty({ name }) {
  return <div style={{ height: "100%", display: "grid", placeItems: "center", background: "linear-gradient(165deg,#1a1f3a,#2d2a52 55%,#3d3463)", color: "#fff", textAlign: "center", padding: 30 }}>
    <div>
      <div style={{ fontFamily: "'Fraunces',serif", fontSize: 24, fontWeight: 600 }}>{name || "No routes yet"}</div>
      <div style={{ fontSize: 14, color: "rgba(255,255,255,0.6)", marginTop: 8 }}>Add a route in the Routes tab to see your morning verdict.</div>
    </div>
  </div>;
}

const INP = { width: "100%", padding: "12px 14px", borderRadius: 12, fontSize: 15, fontFamily: "inherit", background: "rgba(255,255,255,0.07)", border: "1px solid rgba(255,255,255,0.16)", color: "#fff", outline: "none" };
