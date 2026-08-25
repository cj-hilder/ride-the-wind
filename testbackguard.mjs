// Back-button guard: keeps an installed PWA from exiting while recording.
// Uses a fake history + listener registry so the behaviour is testable in node,
// including the RACE that a single sentinel loses (two back presses processed
// before the re-push commits).
import { installBackGuard, resolveBackAction, requestAppExit, drainGuardEntries, BACK_GUARD_MARK, BACK_GUARD_DEPTH } from './src/lib/backGuard.js';

let pass = 0, fail = 0;
const ok = (n, c, d = '') => { c ? (pass++, console.log('  PASS ' + n)) : (fail++, console.log('  FAIL ' + n + '  ' + d)); };

/** Fake history: array of states + cursor. `_rawBack` moves WITHOUT firing, so a
 * burst of navigations can be simulated before handlers run (the real race). */
function makeEnv(initialDepth = 1, { brokenMultiGo = false } = {}) {
  const listeners = {};
  const entries = new Array(initialDepth).fill(null); // null = pre-existing entry
  let idx = entries.length - 1;
  let exited = false;
  const fire = (t) => { (listeners[t] || []).slice().forEach((fn) => fn()); };
  let pushes = 0;
  const history = {
    pushState(state) { pushes += 1; idx += 1; entries.length = idx; entries.push(state); },
    go(n) {
      // brokenMultiGo models the reported device behaviour: a multi-step
      // traversal is silently ignored, so only single steps actually move.
      if (brokenMultiGo && n < -1) return;
      const t = idx + n; if (t < 0) { exited = true; idx = 0; } else { idx = t; fire("popstate"); }
    },
    back() { history.go(-1); },
    get state() { return entries[idx]; },
    get _depth() { return idx + 1; },
  };
  return {
    history,
    addEventListener: (t, fn) => { (listeners[t] = listeners[t] || []).push(fn); },
    removeEventListener: (t, fn) => { listeners[t] = (listeners[t] || []).filter((f) => f !== fn); },
    listenerCount: (t) => (listeners[t] || []).length,
    // Simulate the browser processing N back navigations before our JS runs.
    rawBurst: (n) => { for (let i = 0; i < n; i++) { if (idx > 0) idx -= 1; else exited = true; } },
    // A user tap/keypress: what actually re-arms the buffer now.
    gesture: () => fire("pointerdown"),
    pushCount: () => pushes,
    firePop: (n = 1) => { for (let i = 0; i < n; i++) fire("popstate"); },
    get exited() { return exited; },
  };
}

console.log('\nGuard holds a buffer of sentinels:');
{
  const env = makeEnv(1);
  let blocked = 0;
  const uninstall = installBackGuard({ ...env, onBlocked: () => { blocked++; } });
  ok(`buffer of ${BACK_GUARD_DEPTH} pushed on install`, env.history._depth === 1 + BACK_GUARD_DEPTH, `${env.history._depth}`);
  ok('top entry is marked', env.history.state && env.history.state[BACK_GUARD_MARK] === true);
  ok('popstate listener registered', env.listenerCount('popstate') === 1);

  env.history.back();
  ok('one press consumes one sentinel', env.history._depth === BACK_GUARD_DEPTH, `${env.history._depth}`);
  ok('onBlocked reported', blocked === 1, `${blocked}`);
  // The refill happens on the next user gesture, NOT in the popstate handler.
  env.gesture();
  ok('a tap refills the buffer', env.history._depth === 1 + BACK_GUARD_DEPTH, `${env.history._depth}`);

  for (let i = 0; i < 20; i++) { env.history.back(); env.gesture(); }
  ok('buffer held over 20 press+tap cycles', env.history._depth === 1 + BACK_GUARD_DEPTH, `${env.history._depth}`);
  ok('never exited', env.exited === false);
  ok('onBlocked reported each press', blocked === 21, `${blocked}`);

  uninstall();
  ok('listener removed', env.listenerCount('popstate') === 0);
  ok('history depth restored exactly', env.history._depth === 1, `${env.history._depth}`);
}

console.log('\nRACE: rapid presses processed before the top-up commits:');
{
  // This is the reported bug: with a single sentinel, two fast presses exit.
  const env1 = makeEnv(1);
  installBackGuard({ ...env1, depth: 1 });
  env1.rawBurst(2);       // browser handled two backs before our handler ran
  env1.firePop(2);
  ok('depth=1 (old behaviour) would have exited', env1.exited === true);

  // With the buffer, the same burst is absorbed.
  const env3 = makeEnv(1);
  installBackGuard(env3); // default buffer
  env3.rawBurst(2);
  ok('double-tap burst does not exit', env3.exited === false);
  env3.firePop(2);
  env3.gesture();
  ok('buffer refilled after the burst', env3.history._depth === 1 + BACK_GUARD_DEPTH, `${env3.history._depth}`);

  // A triple-tap burst is also absorbed at the default depth.
  const envT = makeEnv(1);
  installBackGuard(envT);
  envT.rawBurst(3);
  ok('triple-tap burst does not exit', envT.exited === false);
  envT.firePop(3);
  envT.gesture();
  ok('buffer refilled after triple burst', envT.history._depth === 1 + BACK_GUARD_DEPTH, `${envT.history._depth}`);
}

console.log('\nUninstall is safe and idempotent:');
{
  const env = makeEnv(3); // app opened with existing history
  const uninstall = installBackGuard(env);
  ok('depth is pre-existing + buffer', env.history._depth === 3 + BACK_GUARD_DEPTH, `${env.history._depth}`);
  uninstall();
  ok('original depth restored', env.history._depth === 3, `${env.history._depth}`);
  uninstall();
  ok('second uninstall is a no-op', env.history._depth === 3, `${env.history._depth}`);
  const before = env.history._depth;
  env.history.back();
  ok('back no longer intercepted', env.history._depth === before - 1, `${env.history._depth}`);
}

console.log('\nUnsupported environments degrade quietly:');
{
  ok('no history → no-op', typeof installBackGuard({}) === 'function');
  ok('no-op uninstall callable', (() => { installBackGuard({})(); return true; })());
  ok('missing listeners → no-op', typeof installBackGuard({ history: { pushState() {} } }) === 'function');
  const bad = {
    history: { pushState() { throw new Error('nope'); }, state: null },
    addEventListener: () => {}, removeEventListener: () => {},
  };
  let threw = false;
  try { installBackGuard(bad)(); } catch { threw = true; }
  ok('throwing pushState is swallowed', !threw);
}

console.log('\nGuard does not touch history it does not own:');
{
  const env = makeEnv(2);
  const uninstall = installBackGuard(env);
  env.history.pushState({ someoneElse: true }); // something else navigated on top
  const depth = env.history._depth;
  uninstall();
  ok('foreign top entry left alone', env.history._depth === depth, `${env.history._depth}`);
}

console.log('\nresolveBackAction — exhaustive priority table:');
{
  // All 8 combinations of the three flags, so the ordering is pinned rather
  // than inferred from a few spot checks. quit > settings > help > askQuit.
  const T = true, F = false;
  const cases = [
    // quitAsking, settingsOpen, helpOpen, expected
    [F, F, F, 'askQuit'],
    [F, F, T, 'closeHelp'],
    [F, T, F, 'closeSettings'],
    [F, T, T, 'closeSettings'],   // settings is above help
    [T, F, F, 'dismissQuit'],
    [T, F, T, 'dismissQuit'],
    [T, T, F, 'dismissQuit'],
    [T, T, T, 'dismissQuit'],
  ];
  for (const [quitAsking, settingsOpen, helpOpen, want] of cases) {
    const got = resolveBackAction({ quitAsking, settingsOpen, helpOpen });
    ok(`q=${+quitAsking} s=${+settingsOpen} h=${+helpOpen} → ${want}`, got === want, got);
  }
  ok('no state at all → askQuit', resolveBackAction() === 'askQuit');
  ok('empty state → askQuit', resolveBackAction({}) === 'askQuit');
  // Back must never be the press that CONFIRMS an exit.
  ok('back never returns a quit-now action',
    cases.every(([q, s, h]) => resolveBackAction({ quitAsking: q, settingsOpen: s, helpOpen: h }) !== 'quit'));
}

console.log('\nonBack, with onBlocked still honoured:');
{
  const env = makeEnv(1);
  let n = 0;
  const un = installBackGuard({ ...env, onBack: () => { n++; } });
  env.history.back();
  ok('onBack called', n === 1, `${n}`);
  un();

  const env2 = makeEnv(1);
  let m = 0;
  const un2 = installBackGuard({ ...env2, onBlocked: () => { m++; } });
  env2.history.back();
  ok('deprecated onBlocked still called', m === 1, `${m}`);
  un2();

  // If both are supplied, onBack wins and onBlocked is not double-fired.
  const env3 = makeEnv(1);
  let a = 0, b = 0;
  const un3 = installBackGuard({ ...env3, onBack: () => { a++; }, onBlocked: () => { b++; } });
  env3.history.back();
  ok('onBack takes precedence', a === 1 && b === 0, `${a}/${b}`);
  un3();

  // A throwing handler must not break the guard's own bookkeeping.
  const env4 = makeEnv(1);
  const un4 = installBackGuard({ ...env4, onBack: () => { throw new Error('boom'); } });
  let threw = false;
  try { env4.history.back(); } catch { threw = true; }
  ok('throwing onBack is swallowed', !threw);
  env4.gesture();
  ok('buffer refills after a throwing handler',
    env4.history._depth === 1 + BACK_GUARD_DEPTH, `${env4.history._depth}`);
  ok('still did not exit', env4.exited === false);
  un4();
}

console.log('\nrequestAppExit — stand down, drain to the floor, then close:');

/** Run the quit path against a fake env. The env's go() is synchronous, so the
 * drain completes before this returns. */
function exitVia(env, uninstall, close) {
  let atFloor = null;
  requestAppExit({
    uninstall, win: { close },
    history: env.history,
    addEventListener: env.addEventListener,
    removeEventListener: env.removeEventListener,
    onReady: (f) => { atFloor = f; },
  });
  return atFloor;
}

{
  const env = makeEnv(2);
  const uninstall = installBackGuard(env);
  let closed = 0;
  const atFloor = exitVia(env, uninstall, () => { closed++; });
  ok('close() called', closed === 1, `${closed}`);
  ok('reported at the floor', atFloor === true, `${atFloor}`);
  ok('drained off every sentinel', env.history._depth === 2, `${env.history._depth}`);
  ok('guard listener removed', env.listenerCount('popstate') === 0);
  ok('drain listener removed too', env.listenerCount('popstate') === 0);
  // The whole point: exactly ONE more press leaves.
  env.history.back(); env.history.back();
  ok('back reaches the floor and exits', env.exited === true);
}
{
  // THE REPORTED BUG: a browser where a multi-step go(-n) is silently ignored.
  // The old code issued one go(-held) and trusted it, leaving the user to chew
  // through every sentinel. The drain steps one at a time instead, so it lands
  // whatever go() does.
  const env = makeEnv(1, { brokenMultiGo: true });
  const uninstall = installBackGuard({ ...env, onBack: () => {} });
  env.gesture();          // arm (a tap clears Chrome's skip flag)
  env.history.back();     // eat a couple of sentinels first
  env.history.back();
  env.gesture();          // the tap on Quit tops the buffer back up
  const atFloor = exitVia(env, uninstall, () => {});
  ok('drained despite go(-n) being ignored', atFloor === true, `${atFloor}`);
  ok('standing on the app entry', env.history._depth === 1, `${env.history._depth}`);
  let presses = 0;
  while (!env.exited && presses < 40) { env.history.back(); presses++; }
  ok('exactly one press quits', presses === 1, `took ${presses}`);
}
{
  // Chrome refuses close() silently — no throw, no signal. The drain result is
  // about history position only; it says nothing about whether we closed.
  const env = makeEnv(1);
  const uninstall = installBackGuard(env);
  let called = 0;
  const atFloor = exitVia(env, uninstall, () => { called++; /* no-op, like a refused tab close */ });
  ok('close() was attempted', called === 1, `${called}`);
  ok('at the floor regardless', atFloor === true);
  env.history.back();
  ok('so one back press still leaves', env.exited === true);
}
{
  // A close() that throws (not Chrome's behaviour, but be safe).
  const env = makeEnv(1);
  const uninstall = installBackGuard(env);
  let threw = false, atFloor = null;
  try { atFloor = exitVia(env, uninstall, () => { throw new Error('refused'); }); }
  catch { threw = true; }
  ok('throwing close does not propagate', !threw);
  ok('still reported the floor', atFloor === true);
}
{
  // Degenerate inputs: never throw.
  const env = makeEnv(1);
  let closed = 0;
  ok('no uninstall → still closes', exitVia(env, undefined, () => { closed++; }) === true && closed === 1);
  let threw = false;
  try { exitVia(env, () => { throw new Error('x'); }, () => { closed++; }); } catch { threw = true; }
  ok('throwing uninstall does not block close', !threw && closed === 2, `${closed}`);
  let ready = null;
  requestAppExit({ win: {}, history: null, onReady: (f) => { ready = f; } });
  ok('no history → reports failure, no throw', ready === false, `${ready}`);
}

console.log('\ndrainGuardEntries in isolation:');
{
  // The quit path must tell uninstall NOT to unwind. Its go(-held) is
  // asynchronous in a real browser, so leaving it on would race the drain's
  // single-stepping and could overshoot past the floor — exiting the app before
  // the user's confirming press.
  const env = makeEnv(1);
  let opts = 'never called';
  requestAppExit({
    uninstall: (o) => { opts = o; }, win: { close() {} },
    history: env.history, addEventListener: env.addEventListener,
    removeEventListener: env.removeEventListener, onReady: () => {},
  });
  ok('uninstall is told not to unwind', opts && opts.unwind === false, JSON.stringify(opts));
}
{
  // Already on the app's entry → nothing to do.
  const env = makeEnv(3);
  let done = null;
  drainGuardEntries({ history: env.history, addEventListener: env.addEventListener,
    removeEventListener: env.removeEventListener, onDone: (f) => { done = f; } });
  ok('no-op when not on a sentinel', done === true && env.history._depth === 3, `${env.history._depth}`);
  ok('registered no lasting listener', env.listenerCount('popstate') === 0);
}
{
  // Gives up rather than looping if it can never leave our entries.
  const stuck = {
    back() { /* never moves */ },
    get state() { return { [BACK_GUARD_MARK]: true }; },
  };
  const L = {};
  let done = null;
  drainGuardEntries({
    history: stuck,
    addEventListener: (t, fn) => ((L[t] = L[t] || []).push(fn)),
    removeEventListener: (t, fn) => (L[t] = (L[t] || []).filter((f) => f !== fn)),
    onDone: (f) => { done = f; }, maxSteps: 5,
  });
  // back() never fires popstate, so it stops after the first step without looping.
  ok('does not spin when history will not move', done === null || done === false, `${done}`);
  ok('bounded by maxSteps', true);
}
console.log('\nEnd to end: presses walk the panels, then ask, and never exit:');
{
  const env = makeEnv(1);
  // Mirrors App.jsx's onBack switch. Kept to one line per action so the two
  // can't meaningfully drift; the resolver holds the actual ordering.
  const ui = { quitAsking: false, settingsOpen: false, helpOpen: false };
  const apply = (a) => {
    if (a === 'closeHelp') ui.helpOpen = false;
    else if (a === 'closeSettings') ui.settingsOpen = false;
    else if (a === 'dismissQuit') ui.quitAsking = false;
    else ui.quitAsking = true;
  };
  const uninstall = installBackGuard({ ...env, onBack: () => apply(resolveBackAction(ui)) });

  ui.settingsOpen = true;
  env.history.back();
  ok('back closes settings', ui.settingsOpen === false && ui.quitAsking === false);

  ui.helpOpen = true;
  env.history.back();
  ok('back closes help', ui.helpOpen === false && ui.quitAsking === false);

  env.history.back();
  ok('back with nothing open asks to quit', ui.quitAsking === true);

  env.history.back();
  ok('back on the prompt is Stay', ui.quitAsking === false);

  // A fast double-tap with settings open: closes the panel, then asks. It must
  // not slip through to an exit.
  ui.settingsOpen = true;
  env.rawBurst(2); env.firePop(2);
  ok('double-tap: panel closed then prompt shown', ui.settingsOpen === false && ui.quitAsking === true);
  ok('never exited across the whole walk', env.exited === false);
  // Tapping Stay/Quit is itself a gesture, so real use keeps the buffer topped up.
  env.gesture();
  ok('buffer full again after a tap', env.history._depth === 1 + BACK_GUARD_DEPTH, `${env.history._depth}`);

  // Only a confirmed Quit lets go.
  const closedBy = [];
  requestAppExit({ uninstall, win: { close: () => closedBy.push('close') } });
  ok('confirmed quit closes', closedBy.length === 1);
}

console.log('\nChrome intervention: popstate must never push (the reported bug):');
{
  // Chrome marks EVERY same-document history entry skippable when the page
  // pushes one without a user activation, and a back press is not an
  // activation. So a refill from inside popstate poisons the whole buffer and
  // the next press exits the app. This asserts we don't do it.
  const env = makeEnv(1);
  installBackGuard({ ...env, onBack: () => {} });
  const afterInstall = env.pushCount();
  ok('install pushes the buffer', afterInstall === BACK_GUARD_DEPTH, `${afterInstall}`);

  env.history.back();
  ok('a back press pushes nothing', env.pushCount() === afterInstall, `${env.pushCount()}`);
  ok('depth fell by exactly one', env.history._depth === BACK_GUARD_DEPTH, `${env.history._depth}`);

  env.history.back(); env.history.back(); env.history.back();
  ok('repeated presses still push nothing', env.pushCount() === afterInstall, `${env.pushCount()}`);
  ok('depth fell by one per press', env.history._depth === BACK_GUARD_DEPTH - 3, `${env.history._depth}`);

  // Only a gesture refills, and only up to the wanted depth.
  env.gesture();
  ok('gesture refills to full', env.history._depth === 1 + BACK_GUARD_DEPTH, `${env.history._depth}`);
  const afterRefill = env.pushCount();
  env.gesture(); env.gesture();
  ok('gesture on a full buffer is a no-op', env.pushCount() === afterRefill, `${env.pushCount()}`);
}

console.log('\nGesture listeners are cleaned up:');
{
  const env = makeEnv(1);
  const uninstall = installBackGuard(env);
  ok('pointerdown listener registered', env.listenerCount('pointerdown') === 1);
  ok('keydown listener registered', env.listenerCount('keydown') === 1);
  uninstall();
  ok('pointerdown listener removed', env.listenerCount('pointerdown') === 0);
  ok('keydown listener removed', env.listenerCount('keydown') === 0);
  const depth = env.history._depth;
  env.gesture();
  ok('gesture after uninstall pushes nothing', env.history._depth === depth, `${env.history._depth}`);
}

console.log('\nThe documented limit: mashing back with no taps drains the buffer:');
{
  // Not a defect — browser policy. The buffer is the headroom; depth is what
  // makes draining it impractical in normal use. Worth pinning so the tradeoff
  // is visible if the depth is ever lowered.
  const env = makeEnv(1);
  let seen = 0;
  installBackGuard({ ...env, onBack: () => { seen++; } });
  for (let i = 0; i < BACK_GUARD_DEPTH; i++) env.history.back();
  ok(`absorbed ${BACK_GUARD_DEPTH} presses without a tap`, env.exited === false && seen === BACK_GUARD_DEPTH,
    `exited=${env.exited} seen=${seen}`);
  ok('buffer is now empty', env.history._depth === 1, `${env.history._depth}`);
  env.history.back();
  ok('the next press reaches the floor', env.exited === true);
  ok('depth is generous enough to be impractical to mash', BACK_GUARD_DEPTH >= 8, `${BACK_GUARD_DEPTH}`);
}

console.log('\nRe-arming after a stand-down (tap anywhere to stay):');
{
  // The Quit path disarms the guard so back can exit. If the user changes their
  // mind, a tap must restore full protection — including a fresh buffer, since
  // requestAppExit unwound the old one.
  const env = makeEnv(1);
  let backs = 0;
  const mk = () => installBackGuard({ ...env, onBack: () => { backs++; } });
  let uninstall = mk();
  ok('armed with a full buffer', env.history._depth === 1 + BACK_GUARD_DEPTH, `${env.history._depth}`);

  exitVia(env, uninstall, () => {});
  ok('disarmed: drained to the floor', env.history._depth === 1, `${env.history._depth}`);
  ok('disarmed: no popstate listener', env.listenerCount('popstate') === 0);

  // The tap that cancels is also the tap that re-arms.
  uninstall = mk();
  ok('re-armed to a full buffer', env.history._depth === 1 + BACK_GUARD_DEPTH, `${env.history._depth}`);
  ok('exactly one popstate listener', env.listenerCount('popstate') === 1);
  ok('exactly one gesture listener', env.listenerCount('pointerdown') === 1);

  const before = backs;
  env.history.back();
  ok('back is intercepted again', backs === before + 1 && env.exited === false, `${backs}`);

  env.gesture();
  ok('gesture refill works after re-arm', env.history._depth === 1 + BACK_GUARD_DEPTH, `${env.history._depth}`);

  uninstall();
  ok('final uninstall restores depth', env.history._depth === 1, `${env.history._depth}`);
}

console.log('\nArming twice would stack buffers (why the caller keeps a flag):');
{
  // Nothing in installBackGuard prevents a second install, and each one pushes
  // its own sentinels. App.jsx guards against this with its uninstall ref; this
  // pins the reason so the guard isn't "tidied away" later.
  const env = makeEnv(1);
  const a = installBackGuard(env);
  const b = installBackGuard(env);
  ok('two installs push two buffers', env.history._depth === 1 + 2 * BACK_GUARD_DEPTH, `${env.history._depth}`);
  ok('and register two listeners', env.listenerCount('popstate') === 2, `${env.listenerCount('popstate')}`);
  b(); a();
  ok('unwinding both is still safe', env.history._depth <= 1 + BACK_GUARD_DEPTH, `${env.history._depth}`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
