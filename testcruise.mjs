// Global cruising-speed setting → curve v0, end-to-end through the controller.
// Verifies: (1) the unit-aware default, (2) changing the setting re-shapes a
// route's wind response (a faster cruising speed → smaller fractional time hit
// for the same wind), (3) the setting is global (one value, all routes).
import { createAppController } from './src/lib/app.js';
import { MemoryBackend } from './src/lib/storage.js';
import { parseForecast, effortNorm, V0_NOMINAL } from './src/lib/windModel.js';
import { defaultCruiseSpeedKmh } from './src/lib/format.js';
import { DOMParser } from './domshim.mjs';

let pass = 0, fail = 0;
const ok = (n, c, d = '') => { c ? (pass++, console.log('  PASS ' + n)) : (fail++, console.log('  FAIL ' + n + '  ' + d)); };
const near = (a, b, e) => Math.abs(a - b) < e;
const KMH_PER_MPH = 1.609344;

console.log('\nUnit-aware default:');
ok('metric default 20 km/h', defaultCruiseSpeedKmh({ rideSpeed: 'kmh' }) === 20);
ok('imperial default 15 mph', near(defaultCruiseSpeedKmh({ rideSpeed: 'mph' }), 15 * KMH_PER_MPH, 1e-9));

// A straight eastward route; steady strong headwind from the east.
let pts = '';
for (let i = 0; i <= 40; i++) pts += `<trkpt lat="0" lon="${(i * 0.001).toFixed(5)}"><ele>10</ele></trkpt>`;
const gpx = `<?xml version="1.0"?><gpx><trk><trkseg>${pts}</trkseg></trk></gpx>`;
const base = Math.floor(new Date(2026, 5, 1, 0, 0, 0).getTime() / 1000);
const fc = (deg, kmh) => () => {
  const t = [], ws = [], wd = [], tc = [], pr = [], pp = [];
  for (let i = 0; i < 24 * 8; i++) { t.push(base + i * 3600); ws.push(kmh); wd.push(deg); tc.push(10); pr.push(0); pp.push(0); }
  return Promise.resolve(parseForecast({ hourly: { time: t, wind_speed_10m: ws, wind_direction_10m: wd, temperature_2m: tc, precipitation: pr, precipitation_probability: pp } }));
};
const mk = () => createAppController({
  backend: new MemoryBackend(), fetchForecastFor: fc(90, 25), fetchEnsembleFor: () => { throw 0; },
  now: () => new Date(2026, 5, 1, 7, 0).getTime(), domParser: new DOMParser(),
});

console.log('\nGlobal setting drives v0 (manual route, default k):');
const app = mk();
const r = await app.createRoute(gpx, { name: 'W', seedStillAirSec: 1000, targetArrival: '08:30', timeMode: 'arrive', activeDays: ['MO'] });

// Slow cruising speed → steeper curve → bigger time effect.
await app.store.setSetting('cruiseSpeedKmh', 16);
const dSlow = (await app.getHomeVerdict(r.id, new Date(2026, 5, 1, 8, 0).getTime())).debug;
// Fast cruising speed → flatter curve → smaller time effect for the SAME wind.
await app.store.setSetting('cruiseSpeedKmh', 30);
const dFast = (await app.getHomeVerdict(r.id, new Date(2026, 5, 1, 8, 0).getTime())).debug;

ok('slow rider sees larger time effect than fast rider',
  Math.abs(dSlow.windFactorK1) > Math.abs(dFast.windFactorK1),
  `slow ${dSlow.windFactorK1.toFixed(3)} vs fast ${dFast.windFactorK1.toFixed(3)}`);
// The debug equivalent wind is the same forecast wind either way (k=1 summary is
// physical), but the TIME effect differs — that's the whole point of v0.
ok('both see a headwind (positive effect)', dSlow.windFactorK1 > 0 && dFast.windFactorK1 > 0,
  `${dSlow.windFactorK1} / ${dFast.windFactorK1}`);

// Sanity: at a given cruise speed, the k=1 factor equals effortNorm of the
// equivalent wind at that same v0 (reconciliation, already covered elsewhere but
// re-checked here through the settings path).
const impliedFast = effortNorm(dFast.effortHeadwindKmh, 30);
ok('fast-rider factor reconciles at v0=30', near(impliedFast, dFast.windFactorK1, 0.02),
  `${impliedFast.toFixed(3)} vs ${dFast.windFactorK1.toFixed(3)}`);

console.log('\nSetting is global (a second route uses the same v0):');
const r2 = await app.createRoute(gpx, { name: 'W2', seedStillAirSec: 1000, targetArrival: '08:30', timeMode: 'arrive', activeDays: ['MO'] });
const d2 = (await app.getHomeVerdict(r2.id, new Date(2026, 5, 1, 8, 0).getTime())).debug;
ok('second route matches first at the current global speed',
  near(d2.windFactorK1, dFast.windFactorK1, 1e-6),
  `${d2.windFactorK1} vs ${dFast.windFactorK1}`);

console.log('\nUnset setting falls back to nominal:');
const app2 = mk();
const r3 = await app2.createRoute(gpx, { name: 'W3', seedStillAirSec: 1000, targetArrival: '08:30', timeMode: 'arrive', activeDays: ['MO'] });
// No cruiseSpeedKmh set on app2's store → model uses V0_NOMINAL.
const d3 = (await app2.getHomeVerdict(r3.id, new Date(2026, 5, 1, 8, 0).getTime())).debug;
const impliedNom = effortNorm(d3.effortHeadwindKmh, V0_NOMINAL);
ok('unset → nominal v0 reconciliation', near(impliedNom, d3.windFactorK1, 0.02),
  `${impliedNom.toFixed(3)} vs ${d3.windFactorK1.toFixed(3)}`);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
