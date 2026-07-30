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
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
