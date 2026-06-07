// Ephemeral example route: shown only at zero-state, never stored, never
// trains, vanishes once a real route exists.
import { createAppController } from './src/lib/app.js';
import { MemoryBackend } from './src/lib/storage.js';
import { parseForecast } from './src/lib/windModel.js';
import { DOMParser } from './domshim.mjs';
const base=Math.floor(Date.now()/1000/3600)*3600;
const det=()=>{const t=[],ws=[],wd=[],tc=[],pr=[],pp=[];for(let i=-24;i<48;i++){t.push(base+i*3600);ws.push(12);wd.push(200);tc.push(11);pr.push(0);pp.push(0);}return Promise.resolve(parseForecast({hourly:{time:t,wind_speed_10m:ws,wind_direction_10m:wd,temperature_2m:tc,precipitation:pr,precipitation_probability:pp}}));};
const mk=()=>createAppController({backend:new MemoryBackend(),fetchForecastFor:det,fetchEnsembleFor:()=>{throw 0;},now:()=>Date.now(),domParser:new DOMParser()});
let pass=0,fail=0;const ok=(n,c,d='')=>{c?(pass++,console.log('  PASS '+n)):(fail++,console.log('  FAIL '+n+' '+d));};
const app=mk();
const list=await app.listRoutesWithVerdict();
ok('zero-state surfaces one example', list.length===1 && list[0].route.isExample===true);
ok('example carries a verdict', !!list[0].verdict);
ok('example has real geometry for the map', list[0].route.segments.length>5 && list[0].route.totalDistance>0);
ok('example getHomeVerdict works', !!(await app.getHomeVerdict('__example__')));
ok('example routeTuning works', !!(await app.routeTuning('__example__')));
const rr=await app.recordRide({routeId:'__example__',actualTimeSec:1500,startedAt:Date.now(),endedAt:Date.now(),forecastWind:null});
ok('recordRide on example persists nothing', rr.skipped===true && (await app.listRoutes()).length===0);
// add a real route
let pts=''; for(let i=0;i<=30;i++) pts+=`<trkpt lat="${(-45.8+i*0.001).toFixed(5)}" lon="${(170.5+i*0.001).toFixed(5)}"><ele>10</ele></trkpt>`;
await app.createRoute(`<?xml version="1.0"?><gpx><trk><trkseg>${pts}</trkseg></trk></gpx>`,{name:'Real',seedStillAirSec:1500,targetArrival:'08:30',activeDays:['MO']});
const list2=await app.listRoutesWithVerdict();
ok('example gone once a real route exists', list2.length===1 && !list2[0].route.isExample);

// In-memory K experimentation: edits stick in-session, never persist.
{
  const a=mk();
  let t=await a.routeTuning('__example__');
  ok('example defaults speed 16 / k 0.35', t.manual.speedKmh===16 && Math.abs(t.manual.kHead-0.35)<0.001);
  a.updateExampleSeeds({speedKmh:24, kHead:0.5, kTail:0.2});
  t=await a.routeTuning('__example__');
  ok('in-memory edit sticks (speed 24, k 0.5/0.2)', t.manual.speedKmh===24 && Math.abs(t.manual.kHead-0.5)<0.01 && Math.abs(t.manual.kTail-0.2)<0.01);
  ok('editing example persists nothing', (await a.listRoutes()).length===0);
  const fresh=mk();
  ok('fresh controller back to defaults (not persisted)', (await fresh.routeTuning('__example__')).manual.speedKmh===16);
}

console.log(`\n${pass} passed, ${fail} failed`);process.exit(fail?1:0);
