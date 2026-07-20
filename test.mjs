import { haversine, bearing, resample, processGpx, parseGpx, reverseRoute,
  processPoints, processTrace, denoiseTrace, gpsQualityGate,
  REC_MIN_DISTANCE_M, REC_MIN_FIXES } from './src/lib/gpxRoute.js';

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

console.log('\nGPS recording: denoise + quality gate + processTrace:');
{
  // Build a straight ~east trace at the equator: N fixes 1s apart, ~5 m/s.
  // 5 m ≈ 0.0000449 deg lon at the equator.
  const dLon = 5 / 111320;
  const mkTrace = (n, startT = 0) => {
    const t = [];
    for (let i = 0; i < n; i++) t.push({ lat: 0, lon: i * dLon, t: startT + i * 1000 });
    return t;
  };

  // denoiseTrace drops an impossible-speed spike but keeps clean fixes.
  const spiked = mkTrace(12);
  spiked.splice(6, 0, { lat: 0.5, lon: 6 * dLon, t: 5500 }); // ~55 km north in 0.5s → impossible
  const cleaned = denoiseTrace(spiked);
  ok('denoise drops the impossible spike', cleaned.length === 12, `${cleaned.length}`);
  ok('denoise keeps clean fixes', denoiseTrace(mkTrace(12)).length === 12);

  // gpsQualityGate: too few fixes → block
  ok('gate blocks too-few fixes', gpsQualityGate(mkTrace(5)).ok === false);
  // long enough & dense → ok (60 fixes × 5 m ≈ 295 m > 200 m)
  const good = gpsQualityGate(mkTrace(60));
  ok('gate passes a good trace', good.ok === true, JSON.stringify(good.reason));
  // too short in distance → block (12 fixes × 5 m = 55 m < 200)
  ok('gate blocks too-short distance', gpsQualityGate(mkTrace(12)).ok === false);
  // dominant TIME gap → now TOLERATED (rider paused): gate passes, no rejection.
  // (Time-only gaps are ignored per spec; distance gaps warn downstream.)
  const gappy = mkTrace(60);
  gappy[30].t += 10 * 60 * 1000; for (let i = 31; i < gappy.length; i++) gappy[i].t += 10 * 60 * 1000;
  ok('gate tolerates a dominant time-only gap', gpsQualityGate(gappy).ok === true);

  // processTrace end-to-end → processed route shape like GPX
  const pt = processTrace(mkTrace(120)); // ~595 m
  ok('processTrace ok on a good trace', pt.ok === true);
  ok('processTrace yields segments', pt.ok && pt.processed.segments.length > 0);
  ok('processTrace has start/end', pt.ok && pt.processed.start && pt.processed.end);
  ok('processTrace reports plausible distance', pt.ok && pt.processed.totalDistance > 400);
  // blocked trace returns a reason, no processed
  const blocked = processTrace(mkTrace(5));
  ok('processTrace blocks with a reason', blocked.ok === false && typeof blocked.reason === 'string');

  // processPoints matches the GPX path shape (start/end/segments/warnings)
  const pp = processPoints([{lat:0,lon:0},{lat:0,lon:dLon*100}]);
  ok('processPoints returns route shape', !!pp.segments && !!pp.start && !!pp.end && Array.isArray(pp.warnings));
}

console.log('\nGPS gap handling (v1.5: distance-gaps warn, time-only gaps ignored):');
{
  const mk=(lat,lon,t)=>({lat,lon,t,ele:10});
  // (a) time-only gap: rider pauses 8 min mid-ride (fixes at same spot), then
  // continues. Must be tolerated — no rejection, no gap warning.
  let lat=0,t=1e12; const paused=[];
  for(let i=0;i<20;i++){paused.push(mk(lat,0,t));lat+=0.00018;t+=5000;}
  paused.push(mk(lat,0,t+480000)); t+=480000; // 8-min stationary gap
  for(let i=0;i<20;i++){lat+=0.00018;t+=5000;paused.push(mk(lat,0,t));}
  const rp=processTrace(paused);
  ok('time-only gap: recording accepted', rp.ok, rp.ok?'':rp.reason);
  ok('time-only gap: no gap warning', rp.ok && !rp.processed.warnings.some(w=>/gaps in the GPS data/.test(w)), JSON.stringify(rp.ok&&rp.processed.warnings));

  // (b) distance gap: a ~90 m jump between consecutive fixes (GPS dropout).
  // Must be accepted (not rejected) but carry the review/re-record warning.
  let lat2=0,t2=1e12; const jump=[];
  for(let i=0;i<20;i++){jump.push(mk(lat2,0,t2));lat2+=0.00018;t2+=5000;}
  lat2+=0.00081; t2+=5000; // ~90 m jump, one fix later
  for(let i=0;i<20;i++){jump.push(mk(lat2,0,t2));lat2+=0.00018;t2+=5000;}
  const rj=processTrace(jump);
  ok('distance gap: recording still accepted', rj.ok, rj.ok?'':rj.reason);
  ok('distance gap: raises review/re-record warning',
    rj.ok && rj.processed.warnings.some(w=>/gaps in the GPS data.*delete and re-record/i.test(w)),
    JSON.stringify(rj.ok&&rj.processed.warnings));
  ok('distance gap: reported size is the raw jump (~90-110 m)',
    rj.ok && rj.processed.diagnostics.rawMaxGapM > 60 && rj.processed.diagnostics.rawMaxGapM < 130, `${rj.ok&&rj.processed.diagnostics.rawMaxGapM?.toFixed(1)}`);

  // (c) sub-threshold spacing: normal ~20 m fixes never warn.
  let lat3=0,t3=1e12; const normal=[];
  for(let i=0;i<40;i++){normal.push(mk(lat3,0,t3));lat3+=0.00018;t3+=5000;}
  const rn=processTrace(normal);
  ok('normal spacing: no gap warning', rn.ok && !rn.processed.warnings.some(w=>/gaps in the GPS data/.test(w)));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
