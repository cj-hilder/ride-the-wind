/**
 * Back-button guard.
 *
 * A web app can't disable the Android back button, but it can make sure back
 * never finds an empty history — which is what makes an installed PWA exit. This
 * app does all its navigation in React state and never touches history, so
 * without the guard back exits immediately from anywhere: no confirmation, and
 * an open panel can't be dismissed with the gesture every other Android app
 * responds to.
 *
 * With the guard installed, back never reaches the history floor. Each press is
 * reported to the app instead, which decides what it should mean —
 * see resolveBackAction() for the ordering. Quitting therefore becomes
 * deliberate: the app asks first, and only steps aside once the user confirms
 * (see requestAppExit()).
 *
 * WHY A BUFFER, NOT ONE SENTINEL: the obvious approach — push one entry and
 * re-push it whenever back consumes it — loses a race. Android can process two
 * back presses before our popstate handler's pushState commits, so a quick
 * double-tap escapes and the app exits. We therefore hold SEVERAL sentinel
 * entries: rapid presses eat into the buffer instead of reaching the app's real
 * history floor.
 *
 * WHY WE REFILL ON USER GESTURES, NOT IN THE POPSTATE HANDLER: Chrome's history
 * manipulation intervention marks a history entry "skip on back/forward" when
 * the document pushes it WITHOUT a user activation — and it applies that mark to
 * every same-document entry, not just the new one. A back press is not a user
 * activation. So refilling from inside popstate (the obvious place) pushes a
 * gesture-less entry and thereby poisons the WHOLE buffer: the next back press
 * skips every sentinel at once, exits the app, and popstate never even fires.
 * That defeats the guard entirely, and it's why this used to absorb exactly one
 * press and then let go.
 *
 * A user gesture clears the mark on all same-document entries, so the fix is to
 * top up on gestures instead: any tap or key press both refills the buffer and
 * re-arms whatever is already in it. popstate therefore only counts down.
 *
 * Consequence worth knowing: between the app opening and the user's FIRST touch,
 * no guard is possible — Chrome will skip the sentinels and exit. Likewise a long
 * burst of back presses with no intervening tap eventually drains the buffer.
 * Both are browser policy, not something the page can override; the buffer depth
 * is what buys headroom.
 *
 * Injected deps rather than touching globals directly, so this is testable.
 *
 * @param {Object} deps
 * @param {History} deps.history              - window.history (pushState/go/state)
 * @param {Function} deps.addEventListener    - window.addEventListener
 * @param {Function} deps.removeEventListener - window.removeEventListener
 * @param {Function} [deps.onBack]            - called once per intercepted back
 *                                              press, so the app can decide what
 *                                              it means (close a panel, ask to
 *                                              quit, ...)
 * @param {Function} [deps.onBlocked]         - deprecated alias for onBack, kept
 *                                              so existing callers still work
 * @param {number} [deps.depth=3]             - sentinels held (absorbs a rapid
 *                                              multi-tap before the top-up lands)
 * @returns {Function} uninstall
 */
export const BACK_GUARD_MARK = "rtwRecordingGuard";
// Deeper than the old value: the buffer now only refills on a user gesture, so
// it has to absorb a mash of presses between taps rather than one press per pop.
export const BACK_GUARD_DEPTH = 8;
/** Events that count as a user activation for the intervention's purposes, and
 * so are safe moments to push. pointerdown covers tap and mouse; keydown covers
 * desktop; touchend is belt-and-braces for older WebKit. */
export const BACK_GUARD_GESTURES = ["pointerdown", "keydown", "touchend"];

export function installBackGuard({
  history, addEventListener, removeEventListener, onBack, onBlocked, depth = BACK_GUARD_DEPTH,
} = {}) {
  const notify = onBack || onBlocked;
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
    // A sentinel was consumed. Count it down and report the press — but do NOT
    // push a replacement here: a gesture-less push would mark every remaining
    // sentinel skippable (see the note at the top of this file). The next user
    // gesture refills.
    if (held > 0) held -= 1;
    if (notify) { try { notify(); } catch { /* ignore */ } }
  };
  addEventListener("popstate", onPop);

  // Refill on user activation. Cheap: topUp is a no-op while the buffer is full.
  const onGesture = () => { if (installed) topUp(); };
  for (const type of BACK_GUARD_GESTURES) addEventListener(type, onGesture, true);

  return function uninstall(opts) {
    if (!installed) return;
    installed = false;
    removeEventListener("popstate", onPop);
    for (const type of BACK_GUARD_GESTURES) removeEventListener(type, onGesture, true);
    // Drop exactly the entries we added, so history depth — and therefore normal
    // back-exits-the-app behaviour — is restored. One go() call, not repeated
    // back()s. Only if the top entry is still ours: if something else navigated
    // on top, leave history alone rather than yanking the user backwards.
    //
    // Pass { unwind: false } to stop intercepting WITHOUT touching history —
    // the quit path does that, because `held` is only what we BELIEVE is on the
    // stack and a single go(-held) is a best-effort guess that may not land.
    // drainGuardEntries() walks it back against the real history.state instead.
    const unwind = !(opts && opts.unwind === false);
    if (unwind) {
      try {
        const st = history.state;
        if (held > 0 && st && st[BACK_GUARD_MARK] && typeof history.go === "function") {
          history.go(-held);
        }
      } catch { /* ignore */ }
    }
    held = 0;
  };
}

/**
 * Walk back out of the guard's sentinel entries, one at a time, until history.state
 * is no longer ours — i.e. we're standing on the app's own entry, the floor, so
 * the next back press exits.
 *
 * Why one at a time instead of a single go(-n): `n` would have to come from the
 * guard's believed count, and a belief can drift (a popstate we didn't cause,
 * another script pushing, the browser pruning entries). A single traversal is
 * also asynchronous — if it doesn't land, the user is left with N sentinels still
 * to chew through and "press back once more" is a lie.
 *
 * Stepping is self-correcting because each step is triggered by the previous
 * step's popstate, and the stop condition is read from history.state rather than
 * counted. If it can't get there within maxSteps it gives up and reports failure
 * instead of looping.
 *
 * @param {Object} deps
 * @param {History} deps.history
 * @param {Function} deps.addEventListener
 * @param {Function} deps.removeEventListener
 * @param {Function} [deps.onDone]    - called with true once at the floor, false if it gave up
 * @param {number} [deps.maxSteps=64] - loop guard
 * @returns {Function} cancel
 */
export function drainGuardEntries({
  history, addEventListener, removeEventListener, onDone, maxSteps = 64,
} = {}) {
  const report = (okFlag) => { if (onDone) { try { onDone(okFlag); } catch { /* ignore */ } } };
  if (!history || typeof history.back !== "function" ||
      typeof addEventListener !== "function" || typeof removeEventListener !== "function") {
    report(false);
    return () => {};
  }
  const standingOnOurs = () => {
    try { const s = history.state; return !!(s && s[BACK_GUARD_MARK]); }
    catch { return false; }
  };
  if (!standingOnOurs()) { report(true); return () => {}; } // already at the floor

  let steps = 0, finished = false;
  const finish = (okFlag) => {
    if (finished) return;
    finished = true;
    removeEventListener("popstate", onPop);
    report(okFlag);
  };
  const step = () => {
    if (steps++ >= maxSteps) return finish(false);
    try { history.back(); } catch { finish(false); }
  };
  const onPop = () => {
    if (finished) return;
    if (standingOnOurs()) step(); else finish(true);
  };
  addEventListener("popstate", onPop);
  step();
  return () => finish(false);
}

/* ==========================================================================
 * What should a back press mean right now?
 * ========================================================================== */

/**
 * Resolve one intercepted back press against the current UI state. Pure, so the
 * ordering below is testable without a DOM.
 *
 * Order is "dismiss the most transient thing first", which is what back means
 * everywhere else on Android:
 *
 *   1. quitAsking   → "dismissQuit"    back out of the quit prompt = Stay. Back
 *                                      must never be the key that confirms an
 *                                      exit, or a double-tap quits by accident.
 *   2. settingsOpen → "closeSettings"  panels behave as their own close button.
 *   3. helpOpen     → "closeHelp"
 *   4. otherwise    → "askQuit"        nothing to dismiss, so offer to leave.
 *
 * Settings sits above help because help can be opened from within Settings; the
 * reverse doesn't happen, so the topmost panel closes first either way.
 *
 * @param {Object} [state]
 * @param {boolean} [state.quitAsking]   - the "Quit this app?" prompt is showing
 * @param {boolean} [state.settingsOpen] - the Settings panel is showing
 * @param {boolean} [state.helpOpen]     - the Help panel is showing
 * @returns {"dismissQuit"|"closeSettings"|"closeHelp"|"askQuit"}
 */
export function resolveBackAction({ quitAsking, settingsOpen, helpOpen } = {}) {
  if (quitAsking) return "dismissQuit";
  if (settingsOpen) return "closeSettings";
  if (helpOpen) return "closeHelp";
  return "askQuit";
}

/**
 * Leave the app, once the user has confirmed.
 *
 * There is no reliable way for a page to force an installed PWA to exit. The
 * sequence is: stop intercepting; walk back out of our sentinel entries until
 * we're standing on the app's own entry; then ask the window to close. Chrome
 * honours close() for an installed PWA window; a plain tab refuses it, because
 * the script didn't open the tab.
 *
 * Chrome refuses close() SILENTLY — no exception, no return value, just a console
 * warning. There is no synchronous way to tell success from a no-op, so callers
 * must assume it may have done nothing. If the close does land, the app is gone
 * and whatever the caller showed is never seen.
 *
 * onReady fires only once the drain has finished, so a "press back once more to
 * leave" message is only shown when it's actually true. If the drain gives up,
 * onReady still fires (with atFloor false) rather than leaving the UI hanging.
 *
 * @param {Object} deps
 * @param {Function} [deps.uninstall] - the guard's uninstall, from installBackGuard
 * @param {Window} [deps.win]         - window (injectable for tests)
 * @param {History} [deps.history]    - defaults to win.history
 * @param {Function} [deps.addEventListener]
 * @param {Function} [deps.removeEventListener]
 * @param {Function} [deps.onReady]   - (atFloor: boolean) => void
 */
export function requestAppExit({
  uninstall, win, history, addEventListener, removeEventListener, onReady, maxSteps,
} = {}) {
  const w = win || (typeof window !== "undefined" ? window : null);
  // Stand down without touching history — the drain below owns that, and does it
  // against the real history.state instead of a believed count.
  try { if (typeof uninstall === "function") uninstall({ unwind: false }); }
  catch { /* ignore — a failed stand-down shouldn't block the exit */ }

  const h = history || (w && w.history) || null;
  const add = addEventListener || (w && w.addEventListener ? w.addEventListener.bind(w) : null);
  const remove = removeEventListener || (w && w.removeEventListener ? w.removeEventListener.bind(w) : null);

  const tryClose = () => {
    try { if (w && typeof w.close === "function") { w.close(); } }
    catch { /* ignore — refused close leaves the app open but unguarded */ }
  };

  drainGuardEntries({
    history: h, addEventListener: add, removeEventListener: remove, maxSteps,
    onDone: (atFloor) => {
      tryClose();
      if (onReady) { try { onReady(atFloor); } catch { /* ignore */ } }
    },
  });
}
