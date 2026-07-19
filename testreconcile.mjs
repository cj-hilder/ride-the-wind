// The debug readout's "effort headwind" must reconcile with the k=1 wind
// factor via the v2 curve: effortNorm(effortHead) ≈ windFactorK1. Guards
// against the old bug where the debug
// mean wind was sampled differently from the factor and looked unjustified.
import { createAppController } from './src/lib/app.js';
import { MemoryBackend } from './src/lib/storage.js';
import { parseForecast, effortNorm } from './src/lib/windModel.js';
import { DOMParser } from './domshim.mjs';
let pts='', lat=0, lon=0;
for(let i=0;i<=60;i++){ const ne=(i%2===0); lat += ne?0.0006:-0.0002; lon += 0.0007; pts+=`<trkpt lat="${lat.toFixed(5)}" lon="${lon.toFixed(5)}"><ele>10</ele></trkpt>`; }
const gpx=`<?xml version="1.0"?><gpx><trk><trkseg>${pts}</trkseg></trk></gpx>`;
const base=Math.floor(new Date(2026,5,1,0,0,0).getTime()/1000);
const det=()=>{const t=[],ws=[],wd=[],tc=[],pr=[],pp=[];for(let i=0;i<24*8;i++){t.push(base+i*3600);ws.push(9);wd.push(295);tc.push(10);pr.push(0);pp.push(0);}return Promise.resolve(parseForecast({hourly:{time:t,wind_speed_10m:ws,wind_direction_10m:wd,temperature_2m:tc,precipitation:pr,precipitation_probability:pp}}));};
const app=createAppController({backend:new MemoryBackend(),fetchForecastFor:det,fetchEnsembleFor:()=>{throw 0;},now:()=>new Date(2026,5,1,7,0).getTime(),domParser:new DOMParser()});
let pass=0,fail=0; const ok=(n,c,d='')=>{c?(pass++,console.log('  PASS '+n)):(fail++,console.log('  FAIL '+n+'  '+d));};
const r=await app.createRoute(gpx,{name:'R',seedStillAirSec:3000,seedHeadwind20Sec:4560,seedTailwind20Sec:1830,targetArrival:'08:30',timeMode:'arrive',activeDays:['MO']});
const d=(await app.getHomeVerdict(r.id, new Date(2026,5,1,8,0).getTime())).debug;
ok('effortHeadwindKmh present', d.effortHeadwindKmh != null);
const implied = effortNorm(d.effortHeadwindKmh);
ok('effortNorm(effortHead) reconciles with windFactorK1', Math.abs(implied - d.windFactorK1) < 0.02, `${implied.toFixed(3)} vs ${d.windFactorK1}`);
// effort headwind is the exact inverse of the factor, carrying its sign — so it
// agrees in sign with wind_factor even when head/tail segments cancel.
ok('effort headwind sign matches k=1 factor', Math.sign(d.effortHeadwindKmh) === Math.sign(d.windFactorK1) || d.windFactorK1 === 0, `${d.effortHeadwindKmh} vs ${d.windFactorK1}`);
// Direct check of the effort↔factor identity across signs and a cancelling
// case (small positive factor, like a near-perpendicular wind on a winding
// route): the v2 branch inverses must round-trip exactly.
import { invHead, invTail } from './src/lib/windModel.js';
for (const wf of [0.042, -0.094, 0.172, -0.3, 0]) {
  const eff = wf === 0 ? 0 : (wf > 0 ? 20 * invHead(wf) : -20 * invTail(-wf));
  const back = effortNorm(eff);
  ok(`exact inverse for wf=${wf}`, Math.abs(back - wf) < 1e-9, `${back}`);
}

// RECORD-TIME MATCHING: the editor's "equivalent wind" (stored rideWindKmh)
// and the tech panel's "equivalent wind" must agree at the moment a ride is
// recorded, given the same forecast — the plan tab always uses the latest
// forecast, so they only diverge as later forecast updates arrive. Record a
// ride ending exactly at the verdict's arrival, carrying the same wind field.
{
  const v = await app.getHomeVerdict(r.id, new Date(2026,5,1,8,0).getTime());
  // The route's target arrival (08:30 on the active Monday) — the same instant
  // the verdict anchored on; getHomeVerdict does not expose it directly.
  const arrivalMs = new Date(2026,5,1,8,30).getTime();
  const series = await det();
  const capture = {
    routeId: r.id,
    startedAt: arrivalMs - 3000 * 1000,
    endedAt: arrivalMs,
    actualTimeSec: 3000,
    forecastWind: [{ lat: 0, lon: 0.02, series }],
  };
  const { ride } = await app.recordRide(capture);
  ok('ride records an equivalent wind', Number.isFinite(ride.rideWindKmh), `${ride.rideWindKmh}`);
  ok('equivalent wind matches tech panel at record time',
    Math.abs(Math.abs(ride.rideWindKmh) - Math.abs(v.debug.effortHeadwindKmh)) < 0.05
      && Math.sign(ride.rideWindKmh) === Math.sign(v.debug.effortHeadwindKmh),
    `ride=${ride.rideWindKmh} vs tech=${v.debug.effortHeadwindKmh}`);
}
// DEPART-MODE ANCHOR: with a fixed departure ("leave at 8:00"), the verdict
// must sample the wind over the RIDE window (8:00 → ~8:17), not one ride-
// length early (7:43 → 8:00, the old bug of treating the entered time as the
// arrival). A wind GRADIENT through the morning exposes any anchor shift:
// under the gradient the recorded ride's equivalent wind must still match the
// tech panel at record time.
{
  const grad=()=>{const t=[],ws=[],wd=[];for(let i=0;i<24*8;i++){t.push(base+i*3600);ws.push(4+(i%24)*1.5);wd.push(295);}return parseForecast({hourly:{time:t,wind_speed_10m:ws,wind_direction_10m:wd}});};
  const app2=createAppController({backend:new MemoryBackend(),fetchForecastFor:()=>Promise.resolve(grad()),fetchEnsembleFor:()=>{throw 0;},now:()=>new Date(2026,5,1,7,0).getTime(),domParser:new DOMParser()});
  const r2=await app2.createRoute(gpx,{name:'D',seedStillAirSec:3000,seedHeadwind20Sec:4560,seedTailwind20Sec:1830,targetArrival:'08:00',timeMode:'depart',activeDays:['MO']});
  const v2=await app2.getHomeVerdict(r2.id, new Date(2026,5,1,8,0).getTime());
  ok('depart mode keeps entered departure', v2.conservative && v2.conservative.mode==='depart', JSON.stringify(v2.conservative && v2.conservative.mode));
  const departMs=new Date(2026,5,1,8,0).getTime();
  const endMs=departMs + Math.round(v2.verdict.predictedSec)*1000;
  const cap2={routeId:r2.id, startedAt:departMs, endedAt:endMs,
    actualTimeSec:Math.round(v2.verdict.predictedSec), forecastWind:[{lat:0,lon:0.02,series:grad()}]};
  const {ride:ride2}=await app2.recordRide(cap2);
  ok('depart-mode equivalent wind matches tech panel at record time',
    Math.abs(Math.abs(ride2.rideWindKmh) - Math.abs(v2.debug.effortHeadwindKmh)) < 0.05
      && Math.sign(ride2.rideWindKmh) === Math.sign(v2.debug.effortHeadwindKmh),
    `ride=${ride2.rideWindKmh} vs tech=${v2.debug.effortHeadwindKmh}`);
}
console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail?1:0);
