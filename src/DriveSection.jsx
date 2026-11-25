import { useEffect, useRef, useState } from "react";
import { GOOGLE_CLIENT_CONFIGURED } from "./lib/googleClient.js";

// Routes → Backup → Google Drive. Ported from Temperatura's DriveSection,
// restyled for this app. `drive` is the useDriveBackup() handle, created once
// in App so there is exactly one scheduler whatever screen is showing.

// "When" in words a rider reads at a glance: today's backups by time alone,
// older ones with the date.
export function formatWhen(ms) {
  if (!ms) return "";
  const d = new Date(ms);
  const sameDay = d.toDateString() === new Date().toDateString();
  const time = d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  return sameDay ? `today ${time}` : `${d.toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short", year: "numeric" })} ${time}`;
}

const muted = { fontSize: 12.5, color: "rgba(255,255,255,0.55)", lineHeight: 1.5, margin: "6px 0 0" };
const errorText = { fontSize: 12.5, color: "#f0b9b2", lineHeight: 1.5, margin: "6px 0 0" };
const btn = { padding: "10px 14px", borderRadius: 12, cursor: "pointer", fontFamily: "inherit", fontSize: 13.5, fontWeight: 600, background: "rgba(255,255,255,0.08)", color: "#fff", border: "1px solid rgba(255,255,255,0.18)" };
const primary = { ...btn, background: "#e0a45e", color: "#1a1f3a", border: "none" };
const danger = { ...btn, background: "rgba(217,83,79,0.18)", border: "1px solid rgba(217,83,79,0.5)", color: "#f0b9b2" };
const disabled = { opacity: 0.45, cursor: "default" };
const row = { display: "flex", gap: 8, flexWrap: "wrap", marginTop: 10, alignItems: "center" };

export default function DriveSection({ drive, onRestored }) {
  const s = drive.status;
  const [busy, setBusy] = useState(null); // null | "connecting" | "backing-up" | "disconnecting" | "listing" | "restoring"
  const [error, setError] = useState(null);
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);
  const [backups, setBackups] = useState(null); // restore list, when open
  const [pick, setPick] = useState(null);       // backup chosen to restore, awaiting confirm
  const abortRef = useRef(null);

  // Status is computed from storage, so read it fresh on open rather than
  // trust whatever was last emitted.
  useEffect(() => { drive.refreshStatus(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => abortRef.current?.abort(), []);

  // Not async up to the popup: connect() opens it synchronously, inside the
  // tap, or the browser may block it.
  const connect = () => {
    setError(null);
    const ac = new AbortController();
    abortRef.current = ac;
    setBusy("connecting");
    // A first backup that fails after a good Connect shows up in the status
    // line (lastError), not here. Here is only for Connect itself failing.
    drive.connect({ signal: ac.signal })
      .catch((e) => { if (e?.kind !== "cancelled") setError(e?.message || String(e)); })
      .finally(() => { abortRef.current = null; setBusy(null); });
  };

  const backupNow = async () => {
    setError(null);
    setBusy("backing-up");
    try { await drive.backupNow(); } finally { setBusy(null); }
  };

  const disconnect = async () => {
    setError(null);
    setBusy("disconnecting");
    try { await drive.disconnect(); } finally { setBusy(null); setConfirmDisconnect(false); }
  };

  const openRestore = async () => {
    setError(null);
    setBusy("listing");
    try { setBackups(await drive.listBackups()); }
    catch (e) { setError(e?.message || String(e)); }
    finally { setBusy(null); }
  };

  const restore = async () => {
    const chosen = pick;
    setBusy("restoring");
    setError(null);
    try {
      const bundle = await drive.downloadBackup(chosen.id);
      await onRestored(bundle);
      setBackups(null);
      setPick(null);
    } catch (e) {
      setError(`Couldn't restore that backup: ${e?.message || String(e)}`);
    } finally { setBusy(null); }
  };

  let body;
  if (!GOOGLE_CLIENT_CONFIGURED) {
    body = <p style={muted}>Google Drive backup isn't set up in this version yet. Use Export data for now.</p>;
  } else if (!s) {
    body = <p style={muted}>Checking…</p>;
  } else if (busy === "connecting") {
    body = (
      <>
        <p style={muted}>Waiting for Google. Finish signing in in the window that opened, then come back here.</p>
        <div style={row}><button style={btn} onClick={() => abortRef.current?.abort()}>Cancel</button></div>
      </>
    );
  } else if (!s.connected) {
    body = (
      <>
        <p style={muted}>
          Back up your routes, rides and settings to your own Google Drive, automatically after every change.
          Only Ride the Wind's own hidden folder is used. The app can't see your other files.
        </p>
        <div style={row}><button style={primary} onClick={connect}>Connect Google Drive</button></div>
      </>
    );
  } else {
    body = (
      <>
        <p style={{ ...muted, color: "rgba(255,255,255,0.85)" }}>
          {s.account ? <>Connected as <b>{s.account}</b></> : "Connected"}
        </p>
        {s.needsReconnect ? (
          <p style={errorText}>Google Drive access was removed or has expired. Automatic backup is stopped until you reconnect.</p>
        ) : (
          <p style={muted}>
            {busy === "backing-up" ? "Backing up…" : s.lastBackupAt ? `Last backup ${formatWhen(s.lastBackupAt)}` : "Not backed up yet"}
            {s.owedSince != null && busy !== "backing-up" && !s.lastError && " · changes waiting to back up"}
          </p>
        )}
        {s.lastError && !s.needsReconnect && <p style={errorText}>{s.lastError.message}</p>}
        <div style={row}>
          {s.needsReconnect ? (
            <button style={primary} onClick={connect}>Reconnect</button>
          ) : (
            <button style={busy ? { ...btn, ...disabled } : btn} disabled={!!busy} onClick={backupNow}>Back up now</button>
          )}
          <button style={busy ? { ...btn, ...disabled } : btn} disabled={!!busy} onClick={openRestore}>
            {busy === "listing" ? "Loading…" : "Restore from Drive"}
          </button>
        </div>
        <div style={row}>
          {confirmDisconnect ? (
            <>
              <span style={{ fontSize: 12.5, color: "rgba(255,255,255,0.7)" }}>Stop backing up? Backups already on Drive are kept.</span>
              <button style={danger} disabled={!!busy} onClick={disconnect}>Disconnect</button>
              <button style={btn} onClick={() => setConfirmDisconnect(false)}>Keep</button>
            </>
          ) : (
            <button style={{ ...btn, background: "transparent", border: "none", padding: "4px 0", color: "rgba(255,255,255,0.5)", fontWeight: 500 }} onClick={() => setConfirmDisconnect(true)}>Disconnect Google Drive</button>
          )}
        </div>
      </>
    );
  }

  return (
    <div style={{ marginTop: 16, paddingTop: 14, borderTop: "1px solid rgba(255,255,255,0.1)" }}>
      <div style={{ fontSize: 13, color: "rgba(255,255,255,0.5)" }}>Google Drive</div>
      {body}
      {error && <p style={errorText}>{error}</p>}
      {backups && (
        <RestoreList backups={backups} pick={pick} busy={busy}
          onPick={setPick} onConfirm={restore}
          onClose={() => { setBackups(null); setPick(null); }} />
      )}
    </div>
  );
}

// Drive backups newest first, marked automatic or manual, with date, time and
// counts; picking one asks for a confirm, because restoring REPLACES what's on
// this phone (same as importing a file).
function RestoreList({ backups, pick, busy, onPick, onConfirm, onClose }) {
  const count = (n, one, many) => (n == null ? null : `${n} ${n === 1 ? one : many}`);
  return (
    <div style={{ position: "fixed", inset: 0, zIndex: 60, display: "grid", placeItems: "center", background: "rgba(0,0,0,0.6)", padding: 20 }}>
      <div style={{ width: "100%", maxWidth: 380, maxHeight: "80dvh", display: "flex", flexDirection: "column", background: "#1d1b38", borderRadius: 18, border: "1px solid rgba(255,255,255,0.14)", color: "#fff" }}>
        <div style={{ padding: "18px 20px 8px", fontFamily: "'Fraunces',serif", fontSize: 19, fontWeight: 600 }}>Restore from Google Drive</div>
        {pick ? (
          <div style={{ padding: "6px 20px 20px" }}>
            <p style={{ fontSize: 14, lineHeight: 1.5, margin: "0 0 14px" }}>
              Replace all routes, rides and settings on this phone with the {pick.kind === "auto" ? "automatic" : "manual"} backup
              from <b>{formatWhen(pick.exportedAt)}</b>? Anything added since then will be lost.
            </p>
            <div style={{ display: "flex", gap: 10 }}>
              <button style={{ ...btn, flex: 1 }} disabled={busy === "restoring"} onClick={() => onPick(null)}>Back</button>
              <button style={{ ...primary, flex: 1, ...(busy === "restoring" ? disabled : {}) }} disabled={busy === "restoring"} onClick={onConfirm}>
                {busy === "restoring" ? "Restoring…" : "Restore"}
              </button>
            </div>
          </div>
        ) : (
          <>
            <div style={{ overflowY: "auto", padding: "0 12px" }}>
              {backups.length === 0 && <p style={{ ...muted, padding: "0 8px 12px" }}>No backups on Google Drive yet.</p>}
              {backups.map((b) => (
                <button key={b.id} onClick={() => onPick(b)} style={{
                  display: "block", width: "100%", textAlign: "left", margin: "0 0 8px", padding: "11px 12px", borderRadius: 12, cursor: "pointer",
                  background: "rgba(255,255,255,0.06)", border: "1px solid rgba(255,255,255,0.12)", color: "#fff", fontFamily: "inherit",
                }}>
                  <div style={{ fontSize: 14, fontWeight: 600 }}>{formatWhen(b.exportedAt)}</div>
                  <div style={{ fontSize: 12, color: "rgba(255,255,255,0.55)", marginTop: 2 }}>
                    {[b.kind === "auto" ? "Automatic" : "Manual", count(b.routeCount, "route", "routes"), count(b.rideCount, "ride", "rides")].filter(Boolean).join(" · ")}
                  </div>
                </button>
              ))}
            </div>
            <div style={{ padding: "8px 20px 18px" }}>
              <button style={{ ...btn, width: "100%" }} onClick={onClose}>Cancel</button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
