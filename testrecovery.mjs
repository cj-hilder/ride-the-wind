// Interrupted-recording recovery (recording-recovery-spec.md).
// Kills a recording mid-flight (drops the controller without finishing), then
// resumes from the persisted session and checks the timing/trace/flag policy.
import { createAppController } from './src/lib/app.js';
import { MemoryBackend, Store } from './src/lib/storage.js';
import * as learning from './src/lib/learning.js';
import { parseForecast } from './src/lib/windModel.js';
import { DOMParser } from './domshim.mjs';

let pass = 0, fail = 0;
const ok = (n, c, d = '') => { c ? (pass++, console.log('  PASS ' + n)) : (fail++, console.log('  FAIL ' + n + '  ' + d)); };

let clock = new Date(2026, 5, 1, 8, 0, 0).getTime();
const base = Math.floor(new Date(2026, 5, 1, 0, 0, 0).getTime() / 1000);
const stubForecast = () => () => {
  const t = [], ws = [], wd = [], tc = [], pr = [], pp = [];
  for (let i = 0; i < 24 * 8; i++) { t.push(base + i * 3600); ws.push(15); wd.push(90); tc.push(10); pr.push(0); pp.push(0); }
  return Promise.resolve(parseForecast({ hourly: { time: t, wind_speed_10m: ws, wind_direction_10m: wd, temperature_2m: tc, precipitation: pr, precipitation_probability: pp } }));
};
// ONE shared backend across "app restarts" — that's what makes recovery testable.
const backend = new MemoryBackend();
const mkApp = () => createAppController({
  backend,
  fetchForecastFor: stubForecast(),
  fetchEnsembleFor: () => { throw new Error('no ensemble'); },
  now: () => clock,
  domParser: new DOMParser(),
});
const store = new Store({ backend, learning });

let pts = '';
for (let i = 0; i <= 40; i++) pts += `<trkpt lat="0" lon="${(i * 0.001).toFixed(5)}"><ele>10</ele></trkpt>`;
const gpx = `<?xml version="1.0"?><gpx><trk><trkseg>${pts}</trkseg></trk></gpx>`;
const dLon = 5 / 111320; // ~5 m

const app0 = mkApp();
const route = await app0.createRoute(gpx, {
  name: 'R', seedStillAirSec: 1200, targetArrival: '09:00', timeMode: 'arrive',
  activeDays: ['MO', 'TU', 'WE', 'TH', 'FR'],
});

console.log('\nRide: kill mid-ride, then resume (gap counts as RIDING time):');
{
  let cb = null;
  const geo = { watchPosition: (s) => { cb = s; return 1; }, clearWatch: () => {} };
  const app = mkApp();
  const h = await app.startRide(route, { geo, onTick: () => {} });
  const emit = (i) => { clock += 1000; cb({ coords: { latitude: 0, longitude: i * dLon, accuracy: 5, speed: 5 } }); };
  for (let i = 0; i < 40; i++) emit(i);   // 40 s of riding, ~200 m
  const sessionId = h.sessionId;

  // --- app is killed here: no finish, no stop. Session must survive. ---
  const s = await store.loadSession();
  ok('session persisted while recording', s != null && s.id === sessionId, `${s && s.id}`);
  ok('session records the route', s.routeId === route.id, `${s.routeId}`);
  const fixes = await store.loadSessionFixes(sessionId);
  ok('fixes persisted', fixes.length === 40, `${fixes.length}`);
  ok('not flagged paused', !s.pausedAt, `${s.pausedAt}`);

  // 3 minutes pass with the app closed.
  clock += 3 * 60 * 1000;

  const found = await mkApp().findResumableSession();
  ok('session is offered for resume', found != null && found.kind === 'ride', JSON.stringify(found && found.kind));
  ok('resume summary names the route', found.routeName === 'R', `${found.routeName}`);
  ok('resume summary reports not-paused', found.paused === false);
  // Elapsed spans the closed gap: 40 s ridden + 180 s closed = ~220 s.
  ok('closed gap counts as riding time', Math.abs(found.elapsedSec - 220) < 2, `${found.elapsedSec}`);

  // Resume and finish.
  let cb2 = null;
  const geo2 = { watchPosition: (s2) => { cb2 = s2; return 2; }, clearWatch: () => {} };
  let result = null;
  const app2 = mkApp();
  const h2 = await app2.startRide(route, {
    geo: geo2, onTick: () => {}, resumeSession: found.session,
    onFinish: (r) => { result = r; },
  });
  ok('resumed session keeps its id', h2.sessionId === sessionId, `${h2.sessionId}`);
  clock += 1000; cb2({ coords: { latitude: 0, longitude: 41 * dLon, accuracy: 5, speed: 5 } });
  h2.manualFinish();
  ok('resumed ride finished', result != null);
  // actualSec spans everything: 40 s + 180 s gap + 1 s = ~221 s, no paused time.
  ok('actualSec spans the gap', Math.abs(result.actualSec - 221) < 2, `${result.actualSec}`);
  ok('no paused time recorded', result.pausedSec === 0, `${result.pausedSec}`);
  // The trace continues from the prior fixes (straight-line join left in).
  ok('trace continues across the gap', result.trace.length === 41, `${result.trace.length}`);
  ok('session cleared after finish', (await store.loadSession()) == null);
  ok('session fixes cleaned up', (await store.loadSessionFixes(sessionId)).length === 0);
}

console.log('\nRide: killed while PAUSED → resumes paused, gap is PAUSED time:');
{
  let cb = null;
  const geo = { watchPosition: (s) => { cb = s; return 3; }, clearWatch: () => {} };
  const app = mkApp();
  const h = await app.startRide(route, { geo, onTick: () => {} });
  const emit = (i) => { clock += 1000; cb({ coords: { latitude: 0, longitude: i * dLon, accuracy: 5, speed: 5 } }); };
  for (let i = 0; i < 30; i++) emit(i);  // 30 s riding
  h.pause();                             // rider declares a stop
  const sessionId = h.sessionId;

  const s = await store.loadSession();
  ok('pause state persisted immediately', s.pausedAt === clock, `${s.pausedAt} vs ${clock}`);

  clock += 5 * 60 * 1000; // 5 min with the app closed, while paused

  const found = await mkApp().findResumableSession();
  ok('resume summary reports paused', found.paused === true);
  // Elapsed excludes the open pause: still ~30 s.
  ok('paused gap excluded from elapsed', Math.abs(found.elapsedSec - 30) < 2, `${found.elapsedSec}`);

  let cb2 = null;
  const geo2 = { watchPosition: (s2) => { cb2 = s2; return 4; }, clearWatch: () => {} };
  let result = null;
  const h2 = await mkApp().startRide(route, {
    geo: geo2, onTick: () => {}, resumeSession: found.session,
    onFinish: (r) => { result = r; },
  });
  ok('resumes in the paused state', h2.isPaused() === true);
  h2.resume(); // rider taps Continue → the whole closed span becomes paused time
  clock += 1000; cb2({ coords: { latitude: 0, longitude: 31 * dLon, accuracy: 5, speed: 5 } });
  h2.manualFinish();
  // 30 s ridden + 1 s after resuming = ~31 s; the 5 min closed is paused time.
  ok('paused gap excluded from actualSec', Math.abs(result.actualSec - 31) < 2, `${result.actualSec}`);
  ok('paused gap counted as pausedSec', Math.abs(result.pausedSec - 300) < 2, `${result.pausedSec}`);
  ok('session cleared', (await store.loadSession()) == null);
}

console.log('\nRoute recording: kill and resume keeps the partial track:');
{
  let cb = null;
  const geo = { watchPosition: (s) => { cb = s; return 5; }, clearWatch: () => {} };
  const h = await mkApp().recordRoute({ geo, onTick: () => {} });
  const emit = (i) => { clock += 1000; cb({ coords: { latitude: 0, longitude: i * dLon, accuracy: 5 } }); };
  for (let i = 0; i < 25; i++) emit(i);
  const sessionId = h.sessionId;
  ok('route session persisted', (await store.loadSession())?.kind === 'route');
  ok('route fixes persisted', (await store.loadSessionFixes(sessionId)).length === 25);

  clock += 60 * 1000; // app closed for a minute
  const found = await mkApp().findResumableSession();
  ok('route session offered for resume', found && found.kind === 'route');
  ok('route resume has no routeName', found.routeName === null);

  let cb2 = null;
  const geo2 = { watchPosition: (s2) => { cb2 = s2; return 6; }, clearWatch: () => {} };
  const h2 = await mkApp().recordRoute({ geo: geo2, onTick: () => {}, resumeSession: found.session });
  let rec = null; h2.onFinish((r) => { rec = r; });
  // Resume far along the route — this is the straight-line join, left in per spec.
  clock += 1000; cb2({ coords: { latitude: 0, longitude: 60 * dLon, accuracy: 5 } });
  h2.manualFinish();
  ok('resumed track keeps all prior fixes', rec.trace.length === 26, `${rec.trace.length}`);
  ok('resumed track spans the original start', rec.startedAt < clock - 60000);
  ok('route session cleared after finish', (await store.loadSession()) == null);
}

console.log('\nStaleness and discard:');
{
  // A session older than 12 h is discarded silently rather than offered.
  await store.saveSession({ id: 'old', kind: 'route', startedAt: clock - 20 * 3600 * 1000, totalPausedMs: 0, pausedAt: null, updatedAt: clock - 20 * 3600 * 1000 });
  await store.appendSessionFix('old', 0, { lat: 0, lon: 0, t: 0 });
  const found = await mkApp().findResumableSession();
  ok('stale session not offered', found === null, JSON.stringify(found));
  ok('stale session deleted', (await store.loadSession()) == null);
  ok('stale fixes cleaned up', (await store.loadSessionFixes('old')).length === 0);

  // A ride session whose route was deleted can't be resumed.
  await store.saveSession({ id: 'orphan', kind: 'ride', routeId: 'gone', startedAt: clock, totalPausedMs: 0, pausedAt: null, updatedAt: clock });
  ok('orphaned ride session not offered', (await mkApp().findResumableSession()) === null);
  ok('orphaned session deleted', (await store.loadSession()) == null);

  // Explicit discard.
  await store.saveSession({ id: 'd1', kind: 'route', startedAt: clock, totalPausedMs: 0, pausedAt: null, updatedAt: clock });
  await store.appendSessionFix('d1', 0, { lat: 0, lon: 0, t: 0 });
  await mkApp().discardSession('d1');
  ok('discard removes the session', (await store.loadSession()) == null);
  ok('discard removes its fixes', (await store.loadSessionFixes('d1')).length === 0);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
