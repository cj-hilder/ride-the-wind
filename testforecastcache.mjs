// Persisted forecast cache: reopening the app inside the refresh window must
// make NO network requests, and an offline fallback must keep the data's real
// age rather than claiming it is current.
import { createAppController } from './src/lib/app.js';
import { MemoryBackend, Store } from './src/lib/storage.js';
import * as learning from './src/lib/learning.js';
import { parseForecast } from './src/lib/windModel.js';
import { DOMParser } from './domshim.mjs';

let pass = 0, fail = 0;
const ok = (n, c, d = '') => { c ? (pass++, console.log('  PASS ' + n)) : (fail++, console.log('  FAIL ' + n + '  ' + d)); };

let clock = new Date(2026, 5, 1, 8, 0, 0).getTime();
const base = Math.floor(new Date(2026, 5, 1, 0, 0, 0).getTime() / 1000);
const mkSeries = () => {
  const t = [], ws = [], wd = [], tc = [], pr = [], pp = [];
  for (let i = 0; i < 24 * 8; i++) { t.push(base + i * 3600); ws.push(15); wd.push(90); tc.push(10); pr.push(0); pp.push(0); }
  return parseForecast({ hourly: { time: t, wind_speed_10m: ws, wind_direction_10m: wd, temperature_2m: tc, precipitation: pr, precipitation_probability: pp } });
};

// ONE backend across "restarts" — a new controller over the same storage is how
// reopening the app is simulated.
const backend = new MemoryBackend();
const store = new Store({ backend, learning });
let detCalls = 0, ensCalls = 0, offline = false;
const mkApp = () => createAppController({
  backend,
  fetchForecastFor: async () => { detCalls++; if (offline) throw new Error('offline'); return mkSeries(); },
  fetchEnsembleFor: async () => { ensCalls++; if (offline) throw new Error('offline'); return [mkSeries()]; },
  now: () => clock,
  domParser: new DOMParser(),
});

let pts = '';
for (let i = 0; i <= 40; i++) pts += `<trkpt lat="0" lon="${(i * 0.001).toFixed(5)}"><ele>10</ele></trkpt>`;
const gpx = `<?xml version="1.0"?><gpx><trk><trkseg>${pts}</trkseg></trk></gpx>`;

const app1 = mkApp();
const route = await app1.createRoute(gpx, {
  name: 'R', seedStillAirSec: 1200, targetArrival: '09:00', timeMode: 'arrive',
  activeDays: ['MO', 'TU', 'WE', 'TH', 'FR'],
});

console.log('\nFirst run fetches and persists:');
{
  detCalls = 0;
  await app1.getHomeVerdict(route.id, clock);
  ok('first run hit the network', detCalls > 0, `${detCalls}`);
  const rows = await store.loadForecastEntries();
  ok('forecast persisted to storage', rows.some((r) => r.kind === 'det'), `${rows.length} rows`);
  const det = rows.find((r) => r.kind === 'det');
  ok('entry carries the real fetch time', det.at === clock, `${det.at} vs ${clock}`);
  ok('entry keyed by rounded station coords', /^-?\d+\.\d\d,-?\d+\.\d\d$/.test(det.key), det.key);
}

console.log('\nReopening inside the window makes NO requests:');
{
  clock += 10 * 60 * 1000; // 10 min later — still fresh
  detCalls = 0; ensCalls = 0;
  const app2 = mkApp();  // "app restarted": fresh in-memory caches
  await app2.getHomeVerdict(route.id, clock);
  ok('no deterministic fetch after restart', detCalls === 0, `${detCalls} calls`);
  ok('no ensemble fetch after restart', ensCalls === 0, `${ensCalls} calls`);
}

console.log('\nAfter the window expires it refetches:');
{
  clock += 40 * 60 * 1000; // now >30 min since the fetch
  detCalls = 0;
  const app3 = mkApp();
  await app3.getHomeVerdict(route.id, clock);
  ok('refetched once stale', detCalls > 0, `${detCalls}`);
  const det = (await store.loadForecastEntries()).find((r) => r.kind === 'det');
  ok('stored timestamp updated on refetch', det.at === clock, `${det.at} vs ${clock}`);
}

console.log('\nOffline: stale data is used, and its age is reported honestly:');
{
  const fetchedAt = clock;          // when the good data was fetched
  clock += 6 * 60 * 60 * 1000;      // 6 hours later, no connectivity
  offline = true;
  detCalls = 0;
  const app4 = mkApp();
  const res = await app4.getHomeVerdict(route.id, clock);
  ok('tried the network', detCalls > 0, `${detCalls}`);
  ok('still produced a verdict from cached data', res && res.verdict != null);
  // The crux: freshness must reflect the ORIGINAL fetch, not "just now".
  ok('reports the true fetch time, not now', res.debug.forecastUpdatedMs === fetchedAt,
    `${res.debug.forecastUpdatedMs} vs ${fetchedAt}`);
  ok('does not claim to be current', res.debug.forecastUpdatedMs !== clock);
  offline = false;
}

console.log('\nOffline with no cache at all fails rather than inventing data:');
{
  const bareBackend = new MemoryBackend();
  const bare = createAppController({
    backend: bareBackend,
    fetchForecastFor: async () => { throw new Error('offline'); },
    fetchEnsembleFor: async () => { throw new Error('offline'); },
    now: () => clock, domParser: new DOMParser(),
  });
  const r2 = await bare.createRoute(gpx, { name: 'B', seedStillAirSec: 1200, targetArrival: '09:00', timeMode: 'arrive', activeDays: ['MO'] });
  let threw = false;
  try { await bare.getHomeVerdict(r2.id, clock); } catch { threw = true; }
  ok('no cache + offline surfaces the failure', threw);
}

console.log('\nMany routes: the working set must survive a restart (regression):');
{
  // REGRESSION: the cache cap was smaller than the number of stations in use, so
  // a user with more routes than the cap re-fetched everything on every open —
  // it only appeared to work with few routes. The cap must never evict stations
  // that are still in use.
  const b3 = new MemoryBackend();
  let calls = 0;
  const mk = () => createAppController({
    backend: b3,
    fetchForecastFor: async () => { calls++; return mkSeries(); },
    fetchEnsembleFor: async () => { calls++; return [mkSeries()]; },
    now: () => clock, domParser: new DOMParser(),
  });
  const appA = mk();
  const ids = [];
  for (let i = 0; i < 13; i++) {
    // Distinct locations so each route gets its own station key.
    let p2 = '';
    for (let j = 0; j <= 40; j++) p2 += `<trkpt lat="${(i * 0.5).toFixed(4)}" lon="${(j * 0.001).toFixed(5)}"><ele>10</ele></trkpt>`;
    const g = `<?xml version="1.0"?><gpx><trk><trkseg>${p2}</trkseg></trk></gpx>`;
    const r = await appA.createRoute(g, { name: 'R' + i, seedStillAirSec: 1200, targetArrival: '09:00', timeMode: 'arrive', activeDays: ['MO'] });
    ids.push(r.id);
  }
  for (const id of ids) await appA.getHomeVerdict(id, clock);
  const keys = new Set((await new Store({ backend: b3, learning }).loadForecastEntries()).filter(r => r.kind === 'det').map(r => r.key));
  ok('all 13 stations persisted (none evicted)', keys.size === 13, `${keys.size} keys kept`);

  clock += 5 * 60 * 1000; // still inside the refresh window
  calls = 0;
  const appB = mk(); // restart
  for (const id of ids) await appB.getHomeVerdict(id, clock);
  ok('restart with 13 routes makes no requests', calls === 0, `${calls} calls`);
}

console.log('\nPruning bounds storage without losing recent entries:');
{
  const b2 = new MemoryBackend();
  const s2 = new Store({ backend: b2, learning });
  for (let i = 0; i < 20; i++) {
    await s2.saveForecastEntry({ key: `k${i}`, kind: 'det', payload: [{ time: i }], at: 1000 + i });
    await s2.saveForecastEntry({ key: `k${i}`, kind: 'ens', payload: [[{ time: i }]], at: 1000 + i });
  }
  await s2.pruneForecastEntries(12);
  const rows = await s2.loadForecastEntries();
  const det = rows.filter((r) => r.kind === 'det');
  const ens = rows.filter((r) => r.kind === 'ens');
  ok('deterministic capped at 12', det.length === 12, `${det.length}`);
  ok('ensemble capped at 12', ens.length === 12, `${ens.length}`);
  ok('kept the NEWEST entries', Math.min(...det.map((r) => r.at)) === 1000 + 8, `${Math.min(...det.map(r=>r.at))}`);
  await s2.clearForecastEntries();
  ok('clear empties the cache', (await s2.loadForecastEntries()).length === 0);

  // Age is the PRIMARY retention rule: entries too old to be a useful fallback
  // go, regardless of how few there are, while recent ones survive a big cap.
  const t0 = 1_700_000_000_000; // realistic epoch (a small t0 made `at` negative)
  await s2.saveForecastEntry({ key: 'old', kind: 'det', payload: [{ time: 1 }], at: t0 - 72 * 3600 * 1000 });
  await s2.saveForecastEntry({ key: 'new', kind: 'det', payload: [{ time: 2 }], at: t0 - 60 * 1000 });
  await s2.pruneForecastEntries(200, 48 * 3600 * 1000, t0);
  const left = (await s2.loadForecastEntries()).map((r) => r.key);
  ok('aged-out entry dropped', !left.includes('old'), left.join(','));
  ok('recent entry retained', left.includes('new'), left.join(','));
  // Entries with no usable timestamp are dead weight — rehydrate skips them, so
  // prune must be what clears them.
  await s2.saveForecastEntry({ key: 'undated', kind: 'det', payload: [{ time: 3 }], at: 0 });
  await s2.pruneForecastEntries(200, 48 * 3600 * 1000, t0);
  ok('undated entry dropped', !(await s2.loadForecastEntries()).some((r) => r.key === 'undated'));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
