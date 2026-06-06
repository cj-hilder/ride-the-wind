// distanceToStart: one-shot GPS distance to the route start, used to warn
// before recording from the wrong place. Null = couldn't check (proceed).
import { createAppController } from './src/lib/app.js';
import { MemoryBackend } from './src/lib/storage.js';
import { parseForecast } from './src/lib/windModel.js';
import { DOMParser } from './domshim.mjs';
let pts='',lat=-45.87,lon=170.50; for(let i=0;i<=50;i++){lat+=0.0007;lon+=0.0007;pts+=`<trkpt lat="${lat.toFixed(5)}" lon="${lon.toFixed(5)}"><ele>10</ele></trkpt>`;}
const det=()=>Promise.resolve(parseForecast({hourly:{time:[Math.floor(Date.now()/1000)],wind_speed_10m:[10],wind_direction_10m:[90],temperature_2m:[10],precipitation:[0],precipitation_probability:[0]}}));
const app=createAppController({backend:new MemoryBackend(),fetchForecastFor:det,fetchEnsembleFor:()=>{throw 0;},now:()=>Date.now(),domParser:new DOMParser()});
const r=await app.createRoute(`<?xml version="1.0"?><gpx><trk><trkseg>${pts}</trkseg></trk></gpx>`,{name:'R',seedStillAirSec:3000,targetArrival:'08:30',activeDays:['MO']});
let pass=0,fail=0;const ok=(n,c,d='')=>{c?(pass++,console.log('  PASS '+n)):(fail++,console.log('  FAIL '+n+' '+d));};
ok('null when no geo', (await app.distanceToStart(r,{geo:null}))===null);
const start=r.startRegion;
ok('near start ~0', (await app.distanceToStart(r,{geo:{getCurrentPosition:(s)=>s({coords:{latitude:start.lat,longitude:start.lon}})}}))<5);
const far=await app.distanceToStart(r,{geo:{getCurrentPosition:(s)=>s({coords:{latitude:start.lat+0.01,longitude:start.lon}})}});
ok('far > 100m and rounded int', far>100 && Number.isInteger(far), String(far));
ok('error -> null', (await app.distanceToStart(r,{geo:{getCurrentPosition:(s,e)=>e(new Error('denied'))}}))===null);
ok('exception -> null', (await app.distanceToStart(r,{geo:{getCurrentPosition:()=>{throw new Error('boom');}}}))===null);
console.log(`\n${pass} passed, ${fail} failed`);process.exit(fail?1:0);
