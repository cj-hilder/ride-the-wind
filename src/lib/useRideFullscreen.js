import { useEffect } from "react";

/**
 * Fullscreen while a ride (or route recording) is in progress, on touch
 * devices only.
 *
 * Why: in the rain, water on the screen presses Android's three navigation
 * buttons (back, home, recents) along the bottom edge. In fullscreen the
 * system bars are hidden; they come back only with a swipe in from the edge,
 * and then hide again by themselves. Water taps rather than swipes, so it
 * rarely brings them back. The rest of the app stays in normal (standalone)
 * mode, so the clock and battery are visible while planning.
 *
 * Browsers only allow entering fullscreen during a user gesture, and Android
 * drops fullscreen whenever the screen locks, the app is switched away from,
 * or Back is pressed. So:
 *   - entering is attempted as soon as `active` turns true (the Start tap is
 *     still a recent gesture then);
 *   - while active and NOT fullscreen, the next tap anywhere re-enters (this
 *     also covers a ride resumed after a relaunch, which has no gesture);
 *   - when `active` turns false or the screen unmounts, fullscreen is left.
 * Every failure is silent: fullscreen is a nicety, never a requirement.
 */
export function useRideFullscreen(active) {
  useEffect(() => {
    if (!active || !fullscreenWanted()) return;
    const enter = () => {
      if (document.fullscreenElement) return;
      try {
        const p = document.documentElement.requestFullscreen({ navigationUI: "hide" });
        p?.catch?.(() => {});
      } catch { /* not allowed right now; the next tap tries again */ }
    };
    enter();
    // Capture phase, so a tap that a control stops still counts.
    document.addEventListener("click", enter, true);
    return () => {
      document.removeEventListener("click", enter, true);
      if (document.fullscreenElement) {
        try { document.exitFullscreen()?.catch?.(() => {}); } catch {}
      }
    };
  }, [active]);
}

// Phones and tablets only: on a desktop browser, going fullscreen for a ride
// would only be surprising (and rides happen on phones).
function fullscreenWanted() {
  try {
    return !!document.documentElement.requestFullscreen &&
      !!window.matchMedia?.("(pointer: coarse)").matches;
  } catch { return false; }
}
