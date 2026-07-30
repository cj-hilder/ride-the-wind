/**
 * Back-button guard.
 *
 * A web app can't disable the Android back button, but it can make sure back
 * never finds an empty history — which is what makes an installed PWA exit. This
 * app does all its navigation in React state and never touches history, so back
 * exits immediately from anywhere. That's fine everywhere EXCEPT while recording,
 * where leaving mid-ride destroys the recording.
 *
 * WHY A BUFFER, NOT ONE SENTINEL: the obvious approach — push one entry and
 * re-push it whenever back consumes it — loses a race. Android can process two
 * back presses before our popstate handler's pushState commits, so a quick
 * double-tap escapes and the app exits. We therefore hold SEVERAL sentinel
 * entries and top the stack back up after each pop: rapid presses eat into the
 * buffer instead of reaching the app's real history floor.
 *
 * Injected deps rather than touching globals directly, so this is testable.
 *
 * @param {Object} deps
 * @param {History} deps.history              - window.history (pushState/go/state)
 * @param {Function} deps.addEventListener    - window.addEventListener
 * @param {Function} deps.removeEventListener - window.removeEventListener
 * @param {Function} [deps.onBlocked]         - called when a back press was
 *                                              refused, so the UI can say why
 * @param {number} [deps.depth=3]             - sentinels held (absorbs a rapid
 *                                              multi-tap before the top-up lands)
 * @returns {Function} uninstall
 */
export const BACK_GUARD_MARK = "rtwRecordingGuard";
export const BACK_GUARD_DEPTH = 3;

export function installBackGuard({
  history, addEventListener, removeEventListener, onBlocked, depth = BACK_GUARD_DEPTH,
} = {}) {
  if (!history || typeof history.pushState !== "function" ||
      typeof addEventListener !== "function" || typeof removeEventListener !== "function") {
    return () => {}; // unsupported environment → no-op, never throw
  }
  const want = Math.max(1, depth | 0);
  let installed = true;
  let held = 0; // sentinels we believe are on the stack

  const push = () => {
    try { history.pushState({ [BACK_GUARD_MARK]: true }, ""); held += 1; }
    catch { /* ignore — a failed push just means a smaller buffer */ }
  };
  const topUp = () => { while (held < want) { const before = held; push(); if (held === before) break; } };

  topUp();

  const onPop = () => {
    if (!installed) return;
    // A sentinel was consumed. Refill so the next press — however fast — still
    // has something to eat, then let the UI explain the refusal.
    if (held > 0) held -= 1;
    topUp();
    if (onBlocked) { try { onBlocked(); } catch { /* ignore */ } }
  };
  addEventListener("popstate", onPop);

  return function uninstall() {
    if (!installed) return;
    installed = false;
    removeEventListener("popstate", onPop);
    // Drop exactly the entries we added, so history depth — and therefore normal
    // back-exits-the-app behaviour — is restored. One go() call, not repeated
    // back()s. Only if the top entry is still ours: if something else navigated
    // on top, leave history alone rather than yanking the user backwards.
    try {
      const st = history.state;
      if (held > 0 && st && st[BACK_GUARD_MARK] && typeof history.go === "function") {
        history.go(-held);
      }
    } catch { /* ignore */ }
    held = 0;
  };
}
