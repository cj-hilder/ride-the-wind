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
  ios: 'Tap the Share button, then \u201cAdd to Home Screen\u201d.',
  android: 'Open the browser menu, then \u201cInstall app\u201d (or \u201cAdd to Home Screen\u201d).',
  desktop: 'Click the install icon in the address bar, or browser menu \u2192 \u201cInstall\u201d.',
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
        <div style={{ fontFamily: "'Fraunces',serif", fontSize: 24, fontWeight: 600, marginBottom: 16 }}>Ride the Wind</div>
        <div style={{ fontSize: 13.5, color: "rgba(255,255,255,0.6)", marginBottom: 14 }}>
         <ul style={ol}><li>Predicts your bike commute time from the forecast wind for your exact route.
</li><li>Uses multiple forecasts to give you a range of predicted ride times.
</li><li>You control how much the spread of forecasts affects your ride times by adjusting the <i>margin of error</i>.
</li><li>Recommends when to leave in order to arrive on time, based on those ride times.</li></ul>
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
            <b>1. Plan</b> shows forecast ride times and recommended departures for the week ahead. Also alerts you when rain, snow, fog, thunderstorms or sidewinds are forecast for your ride. 
          </p>
          <p style={p}>
            <b>2. Ride</b> let's you record actual ride times which are then used to tune the model and make more accurate predictions. 
          </p>
          <p style={p}>
            <b>3. Routes</b> is where you add and tune your routes, and set the margin of error.
          </p>
        </div>

        <div style={section}>
          <h3 style={h3}>Tuning a route</h3>
          <p style={p}>
            Each route starts from two things you set: your <b>still‑air speed</b> and a <b>ground effect</b> (how much the wind slows or speeds you up on this particular route). That's enough to use it from day one.
          </p>
          <p style={p}>
            As you record rides it learns your real numbers and takes over the tuning. You might need about <b>ten rides in each direction</b>. If the learned times aren't working for you, just move a slider to go back to setting them by hand.
          </p>
          <p style={{ ...p, color: "rgba(255,255,255,0.5)" }}>
           The app blends about 50 wind forecasts for your route. This enables it to predict a best case and worst case ride time by applying a margin of error taken from the spread of the forecasts. This means it can recommend departure times with a higher level of certainty of getting you there on time than a single forecast. You configure the margin of error according to how important it is for you to arrive on time.
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
            Either way the file lands in your Downloads folder. Choose <b>New</b> in Ride the Wind to load the GPX and add the route. You actually need to make two GPX files and add two routes per destination, one for riding out, and one for the return ride.
          </p>
        </div>

        <div style={{ padding: "16px 0 4px" }}>
          <p style={{ fontSize: 12.5, color: "rgba(255,255,255,0.55)", lineHeight: 1.55, margin: 0 }}>
            Ride the Wind gives estimates from weather forecasts. Provided as is, with no warranty and no liability for lateness or any other outcome. It's free and open source — made by Chris Hilder and released under the MIT License, so anyone can use, study, modify, and share it.
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
