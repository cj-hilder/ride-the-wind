// Ephemeral example route: shown only at zero-state, never stored, never
// learns, vanishes once a real route exists.
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
  ok('example defaults speed 16 / k = DEFAULT_K 0.5', t.manual.speedKmh===16 && Math.abs(t.manual.kHead-0.5)<0.001, `${t.manual.kHead}`);
  a.updateExampleSeeds({speedKmh:24, kHead:0.5, kTail:0.2});
  t=await a.routeTuning('__example__');
  ok('in-memory edit sticks (speed 24, k 0.5/0.2)', t.manual.speedKmh===24 && Math.abs(t.manual.kHead-0.5)<0.01 && Math.abs(t.manual.kTail-0.2)<0.01);
  ok('editing example persists nothing', (await a.listRoutes()).length===0);
  const fresh=mk();
  ok('fresh controller back to defaults (not persisted)', (await fresh.routeTuning('__example__')).manual.speedKmh===16);
}


// Example mirrors the default new-route experience: learn/learn, toggleable
// in-memory to illustrate manual vs learn. With no rides, learn falls back to
// the slider values (sources stay "slider", 0 dots) — identical prediction.
{
  const a=mk();
  let t=await a.routeTuning('__example__');
  ok('example defaults to learn/learn', t.config.baselineMode==='learn' && t.config.kMode==='learn');
  ok('example learn-with-no-rides falls back to slider (0 dots)', t.dots===0 && t.learned.baselineSource==='slider');
  a.updateExampleSeeds({baselineMode:'manual', kMode:'manual'});
  t=await a.routeTuning('__example__');
  ok('example mode toggle to manual sticks in-memory', t.config.baselineMode==='manual' && t.config.kMode==='manual');
  ok('mode toggle persists nothing', (await a.listRoutes()).length===0);
  ok('fresh controller back to learn/learn', (await mk().routeTuning('__example__')).config.baselineMode==='learn');
}


{
  const a=mk();
  a.updateExampleSeeds({targetArrival:'07:15', activeDays:['MO','WE','FR'], timeMode:'depart'});
  const r=(await a.listRoutesWithVerdict())[0].route;
  ok('example arrival editable in-memory', r.targetArrival==='07:15');
  ok('example activeDays editable in-memory', JSON.stringify(r.activeDays)===JSON.stringify(['MO','WE','FR']));
  ok('example timeMode editable in-memory', r.timeMode==='depart');
  ok('schedule edit persists nothing', (await a.listRoutes()).length===0);
}

console.log(`\n${pass} passed, ${fail} failed`);process.exit(fail?1:0);
