import { useRef, useEffect } from "react";

/**
 * Background keep-alive for GPS recording with the screen locked.
 *
 * A locked screen makes Android/Chrome suspend page timers and throttle
 * `watchPosition` to nothing. The only reliable way a PWA holds execution
 * through the lock is to look like an *active media player*, which requires
 * THREE things together (all learned from a working reference PWA on the same
 * platform):
 *
 *   1. A running AudioContext producing (inaudible) output — but it MUST be
 *      resumed: a freshly-created context can start "suspended" even inside a
 *      user gesture, in which case the oscillator never actually plays and the
 *      keep-alive is dead on arrival. gain 0.001 (≈94 dB down) is inaudible but
 *      non-zero; a true 0 (or an over-quiet 0.0001) risks being treated as
 *      silence and denied audio focus. 1 Hz is safely sub-audible.
 *   2. navigator.mediaSession with metadata + playbackState 'playing' — THIS is
 *      what makes Android treat the tab as a foreground-equivalent media player
 *      (it appears in the notification shade) and exempts it from background
 *      suspension. Audio alone is not enough.
 *   3. A screen Wake Lock, re-acquired on the 'release' event and on
 *      visibilitychange. The Wake Lock API auto-releases when the page hides, so
 *      we track *intent* separately and re-acquire whenever we still want it.
 *
 * NOTE: this is best-effort. It is demonstrably enough to keep audio + timers
 * alive through a lock on Android/Chrome; whether Android also lets
 * `watchPosition` deliver fixes through the lock is a separate platform policy,
 * so recording with the screen off remains best-effort, not guaranteed.
 *
 * Returns { start, stop } — call start() from a user gesture (autoplay/AudioContext
 * both require one), stop() when recording ends.
 */
export function useKeepAlive() {
  const wakeRef = useRef(null);
  const wantWakeRef = useRef(false); // intent: should we be holding a lock?
  const audioRef = useRef(null);
  const activeRef = useRef(false);   // keep-alive running (for visibility handler)

  const acquireWake = async () => {
    wantWakeRef.current = true;
    try {
      if ("wakeLock" in navigator && (wakeRef.current === null)) {
        const lock = await navigator.wakeLock.request("screen");
        wakeRef.current = lock;
        lock.addEventListener?.("release", () => {
          wakeRef.current = null;
          // The API auto-releases on hide; if we still want it and are visible,
          // re-acquire immediately (visibilitychange may not fire in all
          // OS-initiated release cases).
          if (wantWakeRef.current && document.visibilityState === "visible") acquireWake();
        });
      }
    } catch { /* unavailable or denied; audio keep-alive still helps */ }
  };
  const releaseWake = () => {
    wantWakeRef.current = false;
    try { wakeRef.current?.release?.(); } catch {}
    wakeRef.current = null;
  };

  const start = async () => {
    activeRef.current = true;
    await acquireWake();
    // Audio keep-alive: a resumed AudioContext with an inaudible 1 Hz tone.
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (AC) {
        let a = audioRef.current;
        if (!a) {
          const ctx = new AC();
          a = { ctx, osc: null, gain: null };
          audioRef.current = a;
        }
        if (a.ctx.state === "suspended") { try { await a.ctx.resume(); } catch {} }
        if (!a.osc) {
          const gain = a.ctx.createGain();
          gain.gain.setValueAtTime(0.001, a.ctx.currentTime); // inaudible, non-zero
          gain.connect(a.ctx.destination);
          const osc = a.ctx.createOscillator();
          osc.type = "sine";
          osc.frequency.setValueAtTime(1, a.ctx.currentTime); // 1 Hz, sub-audible
          osc.connect(gain);
          osc.start();
          a.osc = osc; a.gain = gain;
        }
      }
    } catch { /* audio keep-alive unavailable; wake lock still helps */ }
    // MediaSession: register as an active player so Android keeps us alive.
    try {
      if ("mediaSession" in navigator && typeof MediaMetadata !== "undefined") {
        navigator.mediaSession.metadata = new MediaMetadata({ title: "Ride the Wind — recording" });
        navigator.mediaSession.playbackState = "playing";
        // Handlers are required for some browsers to honour the session; keep
        // them no-ops (we don't want lock-screen controls to alter the ride).
        try { navigator.mediaSession.setActionHandler("play", () => {}); } catch {}
        try { navigator.mediaSession.setActionHandler("pause", () => {}); } catch {}
      }
    } catch { /* mediaSession unavailable; harmless */ }
  };

  const stop = () => {
    activeRef.current = false;
    releaseWake();
    try { audioRef.current?.osc?.stop(); } catch {}
    try { audioRef.current?.gain?.disconnect(); } catch {}
    try { audioRef.current?.ctx?.close(); } catch {}
    audioRef.current = null;
    try {
      if ("mediaSession" in navigator) {
        navigator.mediaSession.playbackState = "none";
        navigator.mediaSession.metadata = null;
        try { navigator.mediaSession.setActionHandler("play", null); } catch {}
        try { navigator.mediaSession.setActionHandler("pause", null); } catch {}
      }
    } catch {}
  };

  // Re-acquire the wake lock when returning to the foreground (auto-released on
  // hide). Only while the keep-alive is active.
  useEffect(() => {
    const onVis = () => {
      if (document.visibilityState === "visible" && activeRef.current && wantWakeRef.current) acquireWake();
    };
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  }, []);
  // Safety: tear everything down on unmount.
  useEffect(() => () => stop(), []);

  return { start, stop };
}
