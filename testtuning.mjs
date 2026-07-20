import { createAppController } from './src/lib/app.js';
import { MemoryBackend } from './src/lib/storage.js';
import { parseForecast } from './src/lib/windModel.js';
import { DOMParser } from './domshim.mjs';
let pts=''; for(let i=0;i<=50;i++) pts+=`<trkpt lat="0" lon="${(i*0.0009).toFixed(5)}"><ele>10</ele></trkpt>`;
const gpx=`<?xml version="1.0"?><gpx><trk><trkseg>${pts}</trkseg></trk></gpx>`;
const det=()=>Promise.resolve(parseForecast({hourly:{time:[Math.floor(Date.now()/1000)],wind_speed_10m:[10],wind_direction_10m:[90],temperature_2m:[10],precipitation:[0],precipitation_probability:[0]}}));
const app=createAppController({backend:new MemoryBackend(),fetchForecastFor:det,fetchEnsembleFor:()=>{throw 0;},now:()=>Date.now(),domParser:new DOMParser()});
let pass=0,fail=0; const ok=(n,c,d='')=>{c?(pass++,console.log('  PASS '+n)):(fail++,console.log('  FAIL '+n+'  '+d));};
const r=await app.createRoute(gpx,{name:'R',seedStillAirSec:1800,seedHeadwind20Sec:2700,seedTailwind20Sec:900,targetArrival:'08:30',timeMode:'arrive',activeDays:['MO']});
const t=await app.routeTuning(r.id);
ok('returns distanceM', t.distanceM>0);
ok('manual speed derived', t.manual.speedKmh>0, t.manual.speedKmh);
// v2 PHYSICAL inversion: excess 0.5 → invHead ≈ 0.778. A 50% saving at the
// 20 km/h seed exceeds nominal physics (max 35%), so invTail gives 1.75 →
// clamped to K_MAX 1.4 — the clamp catching an over-optimistic seed.
ok('manual kHead ~invHead(0.5)', Math.abs(t.manual.kHead-0.778)<0.005, t.manual.kHead);
ok('manual kTail clamped to 1.4', t.manual.kTail===1.4, t.manual.kTail);
ok('nothing learned (0 rides)', t.learned.baselineSource==='slider' && t.learned.kHeadSource==='slider' && t.learned.kTailSource==='slider' && t.dots===0);
ok('stats present', t.stats && t.stats.totalDistance>0 && t.stats.pointCount>1, JSON.stringify(t.stats));
ok('example present', t.example && typeof t.example.headFactor==='number');
ok('example has compass label (<=2 letters)', /^[NESW]{1,2}$/.test(t.example.headBearingLabel), t.example.headBearingLabel);
ok('head factor positive, tail factor negative', t.example.headFactor>0 && t.example.tailFactor<0, `${t.example.headFactor} / ${t.example.tailFactor}`);
ok('polyline present and bounded', Array.isArray(t.polyline) && t.polyline.length>=2 && t.polyline.length<=40, t.polyline && t.polyline.length);
console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail?1:0);
