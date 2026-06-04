// The debug readout's "effort headwind" must reconcile with wind_factor:
// (effortHead/20)^2 ≈ wind_factor. Guards against the old bug where the debug
// mean wind was sampled differently from the factor and looked unjustified.
import { createAppController } from './src/lib/app.js';
import { MemoryBackend } from './src/lib/storage.js';
import { parseForecast } from './src/lib/windModel.js';
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
const implied = Math.sign(d.effortHeadwindKmh)*(d.effortHeadwindKmh/20)**2;
ok('(effortHead/20)^2 reconciles with wind_factor', Math.abs(implied - d.windFactor) < 0.02, `${implied.toFixed(3)} vs ${d.windFactor}`);
ok('effort headwind >= |mean headwind| in magnitude', Math.abs(d.effortHeadwindKmh) >= Math.abs(d.meanHeadwindKmh) - 0.05, `${d.effortHeadwindKmh} vs ${d.meanHeadwindKmh}`);
console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail?1:0);
