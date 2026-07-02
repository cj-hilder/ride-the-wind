import { haversine, bearing, resample, processGpx, parseGpx, reverseRoute } from './src/lib/gpxRoute.js';

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

console.log('\nreverseRoute:');
{
  const rev = reverseRoute({
    segments: route.segments, totalDistance: route.totalDistance,
    hasElevation: route.hasElevation, start: route.start, end: route.end,
  });
  ok('same segment count', rev.segments.length === route.segments.length, `${rev.segments.length} vs ${route.segments.length}`);
  ok('total distance preserved', near(rev.totalDistance, route.totalDistance, 1), `${rev.totalDistance}`);
  ok('start/end swapped', near(rev.start.lat, route.end.lat, 1e-9) && near(rev.start.lon, route.end.lon, 1e-9) && near(rev.end.lat, route.start.lat, 1e-9), JSON.stringify({s:rev.start,e:rev.end}));
  // first leg of the original heads ~east (90); the reversed route's LAST leg
  // should head ~west (270) — reversed direction.
  const revLast = rev.segments[rev.segments.length - 1].bearing;
  ok('reversed last leg heads ~west (~270)', near(revLast, 270, 2), `got ${revLast.toFixed(1)}`);
  // reversing twice returns (approximately) the original geometry
  const back = reverseRoute({ segments: rev.segments, totalDistance: rev.totalDistance, hasElevation: rev.hasElevation, start: rev.start, end: rev.end });
  ok('double reverse restores start', near(back.start.lat, route.start.lat, 1e-9) && near(back.start.lon, route.start.lon, 1e-9));
  ok('double reverse restores first bearing', near(back.segments[0].bearing, route.segments[0].bearing, 0.5), `${back.segments[0].bearing} vs ${route.segments[0].bearing}`);
  // elevation still detected after reverse
  ok('reversed route keeps elevation flag', rev.hasElevation === route.hasElevation);
  // empty route → swaps regions, no segments
  const empty = reverseRoute({ segments: [], start: {lat:1,lon:2}, end: {lat:3,lon:4} });
  ok('empty reverse swaps regions', empty.segments.length === 0 && empty.start.lat === 3 && empty.end.lat === 1);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
