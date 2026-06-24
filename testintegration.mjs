import { DOMParser } from './domshim.mjs';
import { processGpx } from './src/lib/gpxRoute.js';
import { parseForecast } from './src/lib/windModel.js';
// learning is now driven by a ride log + config (no accumulator to seed)
import { evaluateAlert, arrivalOnDate, VERDICT, formatHHMM } from './src/lib/alertEngine.js';
import { makePredictor, chooseStations, predictWithRange, speedFromBaseline } from './src/lib/prediction.js';

let pass=0,fail=0;
const ok=(n,c,d='')=>{ c?(pass++,console.log(`  PASS  ${n}`)):(fail++,console.log(`  FAIL  ${n}  ${d}`)); };
const near=(a,b,t)=>Math.abs(a-b)<=t;

// --- Build a ~5km route heading due EAST (bearing ~90) ---
// 0.045 deg lon at equator ~ 5008m. Points every 0.0009 deg (~100m).
let pts='';
for(let i=0;i<=50;i++){ const lon=(i*0.0009).toFixed(5); pts+=`<trkpt lat="0" lon="${lon}"><ele>10</ele></trkpt>\n`; }
const gpx=`<?xml version="1.0"?><gpx><trk><trkseg>${pts}</trkseg></trk></gpx>`;
const route=processGpx(gpx,{domParser:new DOMParser(), spacing:100});
route.id='r1'; route.name='East Route';
route.activeDays=['MO','TU','WE','TH','FR']; route.targetArrival='08:45';
console.log(`Route: ${(route.totalDistance/1000).toFixed(2)}km, ${route.segments.length} segs, bearing0=${route.segments[0].bearing.toFixed(0)}`);
ok('route heads east (~90)', near(route.segments[0].bearing,90,2));

// --- Forecast helper: uniform wind FROM a given direction, all day ---
function forecast(fromDeg, speedKmh){
  const time=[], ws=[], wd=[];
  const base=Math.floor(new Date(2026,5,1,0,0,0).getTime()/1000);
  for(let h=0;h<48;h++){ time.push(base+h*3600); ws.push(speedKmh); wd.push(fromDeg); }
  return parseForecast({hourly:{time, wind_speed_10m:ws, wind_direction_10m:wd}});
}
const stations=chooseStations(route);
console.log(`Stations chosen: ${stations.length}`);
ok('at least one station', stations.length>=1);

// Seed: still-air 1000s (~18km/h over 5km), k=1.0
// Manual config: still-air 1000s baseline, symmetric k=1.0, no rides logged.
const rides=[];
const config={baselineMode:"manual", sliderBaselineSec:1000, kMode:"manual", split:false, sliderKHead:1.0, sliderKTail:1.0};

const sunNight=new Date(2026,4,31,21,0,0).getTime();
// The caller resolves the arrival (Plan-tab path); evaluateAlert needs it.
const monArrival=arrivalOnDate(route, new Date(2026,5,1,12,0).getTime());

console.log('\nEnd-to-end: EAST route, wind FROM the east (headwind):');
{
  // Going east (90), wind from east (90) = headwind -> slower -> leave earlier
  const series=stations.map(s=>({...s, series:forecast(90,25)}));
  const pred=makePredictor({route, rides, config, stationSeries:series});
  const v=evaluateAlert(route, pred, {nowMs:sunNight, fixedArrival:monArrival});
  console.log(`  verdict=${v.verdict} predicted=${(v.predictedSec/60).toFixed(1)}min delta=${v.deltaMin} depart=${v.departureHHMM} (normal ${v.normalDepartureHHMM}) wf=${v.windFactor.toFixed(3)}`);
  ok('headwind -> HEADWIND verdict', v.verdict===VERDICT.HEADWIND, v.verdict);
  ok('headwind -> positive wind_factor', v.windFactor>0);
  ok('headwind -> predicted slower than baseline', v.predictedSec>1000);
  ok('headwind -> departure earlier than normal', v.departureMs<v.normalDepartureMs);
}

console.log('\nEnd-to-end: EAST route, wind FROM the west (tailwind):');
{
  // wind from west (270) pushing you east = tailwind -> faster -> sleep in
  const series=stations.map(s=>({...s, series:forecast(270,25)}));
  const pred=makePredictor({route, rides, config, stationSeries:series});
  const v=evaluateAlert(route, pred, {nowMs:sunNight, fixedArrival:monArrival});
  console.log(`  verdict=${v.verdict} predicted=${(v.predictedSec/60).toFixed(1)}min delta=${v.deltaMin} depart=${v.departureHHMM} wf=${v.windFactor.toFixed(3)}`);
  ok('tailwind -> TAILWIND verdict', v.verdict===VERDICT.TAILWIND, v.verdict);
  ok('tailwind -> negative wind_factor', v.windFactor<0);
  ok('tailwind -> predicted faster than baseline', v.predictedSec<1000);
}

console.log('\nEnd-to-end: crosswind (from north) -> normal:');
{
  const series=stations.map(s=>({...s, series:forecast(0,25)})); // from north, route east
  const pred=makePredictor({route, rides, config, stationSeries:series});
  const v=evaluateAlert(route, pred, {nowMs:sunNight, fixedArrival:monArrival});
  console.log(`  verdict=${v.verdict} wf=${v.windFactor.toFixed(4)}`);
  ok('crosswind -> NORMAL', v.verdict===VERDICT.NORMAL, v.verdict);
  ok('crosswind -> wind_factor ~ 0', near(v.windFactor,0,0.01));
}

console.log('\nConvergence stability (more passes -> same answer):');
{
  const series=stations.map(s=>({...s, series:forecast(90,30)}));
  const p2=makePredictor({route, rides, config, stationSeries:series, opts:{passes:2}})(new Date(2026,5,1,8,45).getTime());
  const p5=makePredictor({route, rides, config, stationSeries:series, opts:{passes:5}})(new Date(2026,5,1,8,45).getTime());
  ok('2 vs 5 passes converge', near(p2.predictedSec,p5.predictedSec,2), `${p2.predictedSec.toFixed(1)} vs ${p5.predictedSec.toFixed(1)}`);
}

console.log('\nForecast uncertainty range (§5):');
{
  const series=stations.map(s=>({...s, series:forecast(90,25)}));
  const r=predictWithRange({route, rides, config, stationSeries:series}, new Date(2026,5,1,8,45).getTime());
  console.log(`  low=${(r.lowSec/60).toFixed(1)} center=${(r.centerSec/60).toFixed(1)} high=${(r.highSec/60).toFixed(1)} min`);
  ok('range brackets center', r.lowSec<=r.centerSec && r.centerSec<=r.highSec);
  ok('range has width (headwind uncertain)', r.highSec-r.lowSec>1);
}

console.log('\nspeedFromBaseline sanity:');
ok('5km in 1000s ~ 18km/h', near(speedFromBaseline(5000,1000),18,0.5), `${speedFromBaseline(5000,1000).toFixed(2)}`);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail?1:0);
