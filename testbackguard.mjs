// Back-button guard: keeps an installed PWA from exiting while recording.
// Uses a fake history + listener registry so the behaviour is testable in node,
// including the RACE that a single sentinel loses (two back presses processed
// before the re-push commits).
import { installBackGuard, BACK_GUARD_MARK, BACK_GUARD_DEPTH } from './src/lib/backGuard.js';

let pass = 0, fail = 0;
const ok = (n, c, d = '') => { c ? (pass++, console.log('  PASS ' + n)) : (fail++, console.log('  FAIL ' + n + '  ' + d)); };

/** Fake history: array of states + cursor. `_rawBack` moves WITHOUT firing, so a
 * burst of navigations can be simulated before handlers run (the real race). */
function makeEnv(initialDepth = 1) {
  const listeners = {};
  const entries = new Array(initialDepth).fill(null); // null = pre-existing entry
  let idx = entries.length - 1;
  let exited = false;
  const fire = (t) => { (listeners[t] || []).slice().forEach((fn) => fn()); };
  const history = {
    pushState(state) { idx += 1; entries.length = idx; entries.push(state); },
    go(n) { const t = idx + n; if (t < 0) { exited = true; idx = 0; } else { idx = t; fire("popstate"); } },
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
  ok('buffer restored after one press', env.history._depth === 1 + BACK_GUARD_DEPTH, `${env.history._depth}`);
  ok('onBlocked reported', blocked === 1, `${blocked}`);

  for (let i = 0; i < 20; i++) env.history.back();
  ok('buffer held over 20 presses', env.history._depth === 1 + BACK_GUARD_DEPTH, `${env.history._depth}`);
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
  ok('buffer refilled after the burst', env3.history._depth === 1 + BACK_GUARD_DEPTH, `${env3.history._depth}`);

  // A triple-tap burst is also absorbed at the default depth.
  const envT = makeEnv(1);
  installBackGuard(envT);
  envT.rawBurst(3);
  ok('triple-tap burst does not exit', envT.exited === false);
  envT.firePop(3);
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

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
