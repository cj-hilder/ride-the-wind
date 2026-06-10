import React from "react";

/* ============================================================================
 * HelpPanel — full-screen overlay shown on first launch and via the help
 * button on the Routes tab. Edit this file to update the help content without
 * touching App.jsx.
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
  ios: "Tap the Share button, then "Add to Home Screen".",
  android: "Open the browser menu, then "Install app" (or "Add to Home Screen").",
  desktop: "Click the install icon in the address bar, or browser menu → "Install".",
  unknown: "Add this page to your home screen from your browser's menu.",
};

export default function HelpPanel({ onClose }) {
  const platform = detectInstall();
  const installed = platform === "installed";
  const h3 = { fontFamily: "'Fraunces',serif", fontSize: 17, fontWeight: 600, color: "#fff", margin: "0 0 6px" };
  const p = { fontSize: 13.5, color: "rgba(255,255,255,0.75)", lineHeight: 1.5, margin: "0 0 4px" };
  const ol = { fontSize: 13.5, color: "rgba(255,255,255,0.75)", lineHeight: 1.55, margin: "2px 0 4px", paddingLeft: 20 };
  const lnk = { color: "#e0a45e", textDecoration: "underline", fontWeight: 600 };
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
            <b>Plan</b> shows when to leave for the selected route on any day this week — tap a day along the top. The headline tells you if the wind means leaving earlier or later than usual, with the leave‑by time and a live countdown when it's near.
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
            Each route starts from two things you set: your <b>still‑air speed</b> and a <b>ground effect</b> (how sheltered or exposed the route is, which sets how much wind slows or speeds you). That's enough to use it from day one.
          </p>
          <p style={p}>
            As you log rides it learns your real numbers — separately for headwind and tailwind days — and takes over the tuning, well‑settled after about <b>ten rides in each direction</b>. If the learned times aren't working for you, just move a slider to go back to setting them by hand.
          </p>
          <p style={{ ...p, color: "rgba(255,255,255,0.5)" }}>
            Behind each forecast the app blends an ensemble of about 50 separate wind forecasts for your route — more detailed wind data than a typical weather app shows. Each destination needs two routes, one going and one returning.
          </p>
        </div>

        <div style={section}>
          <h3 style={h3}>Making a GPX file for a route</h3>
          <p style={p}>
            A route needs a GPX file (its path on the map). If you've already got one from Strava, Komoot, Garmin or similar, just open it here. Otherwise it takes a minute to make one:
          </p>
          <p style={{ ...p, fontWeight: 600, color: "rgba(255,255,255,0.85)", marginTop: 8 }}>
            <a href="https://mapy.com" target="_blank" rel="noopener noreferrer" style={lnk}>Mapy.com</a> — good for dedicated bike lanes
          </p>
          <ol style={ol}>
            <li>Open <a href="https://mapy.com" target="_blank" rel="noopener noreferrer" style={lnk}>Mapy.com</a>, then the planner (menu → directions).</li>
            <li>Choose the <b>bike</b> mode so it routes along bike‑friendly streets.</li>
            <li>Type your start in box A and destination in box B — the line draws itself.</li>
            <li>Expand the route panel, scroll down, and tap <b>Export</b>.</li>
          </ol>
          <p style={{ ...p, fontWeight: 600, color: "rgba(255,255,255,0.85)", marginTop: 8 }}>
            <a href="https://onthegomap.com" target="_blank" rel="noopener noreferrer" style={lnk}>OnTheGoMap.com</a> — the fast click‑and‑go way
          </p>
          <ol style={ol}>
            <li>Open <a href="https://onthegomap.com" target="_blank" rel="noopener noreferrer" style={lnk}>OnTheGoMap.com</a> and set the mode to <b>bike</b> (top centre).</li>
            <li>Click your start on the map, then your destination — it snaps to the roads.</li>
            <li>Open the menu (top right) and tap <b>Export as GPX</b>.</li>
          </ol>
          <p style={{ ...p, color: "rgba(255,255,255,0.5)" }}>
            Either way the file lands in your Downloads folder — open it here to add the route.
          </p>
        </div>

        <div style={{ padding: "16px 0 4px" }}>
          <p style={{ fontSize: 12.5, color: "rgba(255,255,255,0.55)", lineHeight: 1.55, margin: 0 }}>
            Ride the Wind gives estimates from weather forecasts. Forecasts are uncertain and conditions change — treat the times as a guide, not a guarantee, and ride safely and within the law. Provided as is, with no warranty and no liability for lateness or any other outcome. It's free and open source — made by Chris Hilder and released under the MIT License, so anyone can use, study, modify, and share it.
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
