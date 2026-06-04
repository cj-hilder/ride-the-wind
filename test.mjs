import { haversine, bearing, resample, processGpx, parseGpx } from './src/lib/gpxRoute.js';

let pass = 0, fail = 0;
function ok(name, cond, detail='') {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}  ${detail}`); }
}
function near(a, b, tol) { return Math.abs(a - b) <= tol; }

console.log('Geometry:');
// Known: London (51.5074,-0.1278) -> Paris (48.8566,2.3522) ~ 343 km, bearing ~148 deg
const d = haversine(51.5074, -0.1278, 48.8566, 2.3522);
ok('London->Paris distance ~343km', near(d/1000, 343, 5), `got ${(d/1000).toFixed(1)}km`);
const b = bearing(51.5074, -0.1278, 48.8566, 2.3522);
ok('London->Paris bearing ~148deg', near(b, 148, 3), `got ${b.toFixed(1)}deg`);
// Due north / east sanity
ok('due north = 0deg', near(bearing(0,0,1,0), 0, 0.01), `got ${bearing(0,0,1,0)}`);
ok('due east  = 90deg', near(bearing(0,0,0,1), 90, 0.01), `got ${bearing(0,0,0,1)}`);
ok('zero distance', haversine(10,10,10,10) === 0);

console.log('\nResample:');
// Straight line along equator, ~1000m of points spaced ~111m (0.001 deg lon ~ 111.32m)
const line = [];
for (let i = 0; i <= 10; i++) line.push({ lat: 0, lon: i * 0.001, ele: i * 2 });
const rs = resample(line, 50);
// Check spacing between resampled points is close to 50m
let maxErr = 0;
for (let i = 0; i < rs.length - 1; i++) {
  const seg = haversine(rs[i].lat, rs[i].lon, rs[i+1].lat, rs[i+1].lon);
  if (i < rs.length - 2) maxErr = Math.max(maxErr, Math.abs(seg - 50)); // ignore final stub
}
ok('resample spacing ~50m', maxErr < 1, `max err ${maxErr.toFixed(2)}m`);
ok('resample keeps endpoints', rs[0].lon === 0 && near(rs[rs.length-1].lon, 0.01, 1e-9));
ok('resample interpolates elevation', rs.every(p => p.ele !== null));

console.log('\nFull pipeline (synthetic GPX):');
const gpx = `<?xml version="1.0"?>
<gpx><trk><trkseg>
  <trkpt lat="0" lon="0"><ele>10</ele></trkpt>
  <trkpt lat="0" lon="0.005"><ele>20</ele></trkpt>
  <trkpt lat="0.005" lon="0.005"><ele>15</ele></trkpt>
</trkseg></trk></gpx>`;
// Provide a DOMParser shim via xmldom-less minimal parser:
import { DOMParser } from './domshim.mjs';
const route = processGpx(gpx, { domParser: new DOMParser(), spacing: 100 });
ok('produces segments', route.segments.length > 0, `got ${route.segments.length}`);
ok('total distance ~1112m', near(route.totalDistance, 1112, 30), `got ${route.totalDistance.toFixed(0)}m`);
ok('detects elevation', route.hasElevation === true);
ok('start at origin', route.start.lat === 0 && route.start.lon === 0);
ok('first leg heads east (~90deg)', near(route.segments[0].bearing, 90, 1), `got ${route.segments[0].bearing.toFixed(1)}`);
ok('no spurious warnings', route.warnings.length === 0, JSON.stringify(route.warnings));

console.log('\nError handling:');
try { parseGpx('', { domParser: new DOMParser() }); ok('empty throws', false); }
catch (e) { ok('empty throws EMPTY_FILE', e.code === 'EMPTY_FILE'); }
try { parseGpx('<gpx></gpx>', { domParser: new DOMParser() }); ok('no points throws', false); }
catch (e) { ok('no points throws NO_POINTS', e.code === 'NO_POINTS'); }

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
