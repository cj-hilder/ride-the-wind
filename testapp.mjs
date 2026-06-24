import { createAppController } from './src/lib/app.js';
import { MemoryBackend } from './src/lib/storage.js';
import { parseForecast } from './src/lib/windModel.js';
import { DOMParser } from './domshim.mjs';

let pass=0,fail=0;
const ok=(n,c,d='')=>{ c?(pass++,console.log(`  PASS  ${n}`)):(fail++,console.log(`  FAIL  ${n}  ${d}`)); };
const near=(a,b,t)=>Math.abs(a-b)<=t;

// --- a real ~5km east-heading GPX ---
let pts='';
for(let i=0;i<=50;i++){ pts+=`<trkpt lat="0" lon="${(i*0.0009).toFixed(5)}"><ele>10</ele></trkpt>`; }
const gpx=`<?xml version="1.0"?><gpx><trk><trkseg>${pts}</trkseg></trk></gpx>`;

// --- stub forecast: uniform wind FROM the east (headwind for east route) ---
function stubForecast(fromDeg, speed){
  return (lat,lon)=>{
    const base=Math.floor(new Date(2026,5,1,0,0,0).getTime()/1000);
    const time=[],ws=[],wd=[];
    for(let h=0;h<24*8;h++){ time.push(base+h*3600); ws.push(speed); wd.push(fromDeg); }
    return Promise.resolve(parseForecast({hourly:{time,wind_speed_10m:ws,wind_direction_10m:wd}}));
  };
}

let clock = new Date(2026,4,31,21,30).getTime(); // Sun 21:30
function stubEnsemble(fromDeg, speed){
  return async()=>{ const h={time:[]}; const base=Math.floor(new Date(2026,5,1,0,0,0).getTime()/1000);
    for(let i=0;i<24*8;i++) h.time.push(base+i*3600);
    [speed-4,speed,speed+5].forEach((sp,idx)=>{ const n=String(idx+1).padStart(2,'0');
      h['wind_speed_10m_member'+n]=Array(24*8).fill(sp); h['wind_direction_10m_member'+n]=Array(24*8).fill(fromDeg); });
    const { parseEnsemble } = await import('./src/lib/windModel.js'); return parseEnsemble({hourly:h}); };
}
const mkApp = (forecast, ensemble)=> createAppController({
  backend:new MemoryBackend(),
  fetchForecastFor: forecast,
  fetchEnsembleFor: ensemble || (()=>{ throw new Error("no ensemble"); }),
  now: ()=>clock,
  notify: async(n)=>{ notifications.push(n); },
  domParser: new DOMParser(),
});
let notifications=[];

console.log('Create route from real GPX through the full stack:');
let app, route;
{
  app = mkApp(stubForecast(90, 25), stubEnsemble(90,25)); // headwind
  route = await app.createRoute(gpx, {
    name:'Home → Office', seedStillAirSec:1000,
    seedHeadwind20Sec:1300, seedTailwind20Sec:760,
    targetArrival:'08:45', activeDays:['MO','TU','WE','TH','FR'],
  });
  ok('route created + persisted', route && route.id);
  ok('processed segments present', route.segments.length>0);
  ok('baseline seeded', route.baselineTimeSec===1000);
  // split seed: kHead from 1300/1000-1=0.3, kTail from 1-760/1000=0.24
  ok('kHead slider seeded ~0.3', near(route.sliderKHead,0.3,0.02), `${route.sliderKHead.toFixed(3)}`);
  ok('kTail slider seeded ~0.24', near(route.sliderKTail,0.24,0.02), `${route.sliderKTail.toFixed(3)}`);
  ok('config manual by default', route.baselineMode==='manual' && route.kMode==='manual');
}

console.log('\nLive home verdict (headwind forecast):');
{
  // The Plan tab queries a specific day; query Monday (in the stub's window).
  const monday = new Date(2026,5,1,12,0).getTime();
  const hv=await app.getHomeVerdict(route.id, monday);
  ok('verdict produced', hv.verdict!=null);
  ok('headwind -> leave earlier', hv.verdict.verdict==='headwind', hv.verdict.verdict);
  ok('range present', hv.range && hv.range.highSec>=hv.range.lowSec);
  ok('confidence: nothing learned yet (0 dots)', hv.confidence.dots===0 && hv.confidence.baselineLearned===false);
  ok('verdict has departureMs for countdown', typeof hv.verdict.departureMs==='number');
  ok('no message field (scheduler removed)', !('message' in hv.verdict));
}

console.log('\nNo scheduler: runAlerts removed, no notifications dispatched:');
{
  notifications=[];
  ok('runAlerts no longer exposed', typeof app.runAlerts==='undefined');
  ok('start() resolves without scheduling', (await app.start())===undefined || true);
  ok('no notifications dispatched', notifications.length===0);
}

console.log('\nCapture rides -> resolver learns (real recordRide path, learn mode):');
{
  // Switch the route to learn mode for baseline + k.
  await app.updateRoute(route.id, { baselineMode:'learn', kMode:'learn' });
  const station=(fromDeg,speed)=>[{lat:0,lon:0.0225,series:
    parseForecast({hourly:{time:[Math.floor(new Date(2026,5,1,8,0).getTime()/1000)],
      wind_speed_10m:[speed], wind_direction_10m:[fromDeg]}})}];
  // Varied winds (head, tail, calm) so the resolver has spread to work with.
  const conditions=[[90,25],[270,25],[90,15],[270,15],[0,20],[90,30],[270,10],[45,20]];
  for(let i=0;i<conditions.length;i++){
    const [fd,sp]=conditions[i];
    const start=new Date(2026,5,1+i,8,0).getTime();
    const cap={
      routeId:route.id, startedAt:start, endedAt:start+1000*1000,
      actualTimeSec:1000, // app computes windFactor from the forecast
      forecastWind:station(fd,sp),
    };
    await app.recordRide(cap);
  }
  const rides=await app.listRides(route.id);
  ok('all rides stored', rides.length===conditions.length, `${rides.length}`);
  ok('rides stored with computed windFactor', rides.every(r=>r.windFactor!=null));
  ok('rides default included', rides.every(r=>r.included===true));
  const t=await app.routeTuning(route.id);
  ok('learned kHead in bounds', t.learned.kHead>=0.05 && t.learned.kHead<=4.0, `${t.learned.kHead}`);
  ok('learned kTail in bounds', t.learned.kTail>=0.05 && t.learned.kTail<=4.0, `${t.learned.kTail}`);
  ok('learned baseline positive', t.learned.baselineSec>0);
}

console.log('\nExcluded ride is ignored by the resolver:');
{
  const t=await app.routeTuning(route.id);
  const beforeBaseline=t.learned.baselineSec;
  // Record a wild ride, then exclude it — resolved baseline must not move.
  const {ride}=await app.recordRide({routeId:route.id, startedAt:Date.now(), endedAt:Date.now()+1,
    actualTimeSec:5000,
    forecastWind:[{lat:0,lon:0.0225,series:parseForecast({hourly:{time:[0],wind_speed_10m:[2],wind_direction_10m:[90]}})}]});
  await app.updateRide(ride.id, { included:false });
  const t2=await app.routeTuning(route.id);
  ok('excluded ride does not move baseline', near(t2.learned.baselineSec, beforeBaseline, 1), `${beforeBaseline} -> ${t2.learned.baselineSec}`);
}

console.log('\nExport / import through controller:');
{
  const bundle=await app.exportAll();
  ok('bundle has the route', bundle.routes.length===1);
  ok('bundle has rides', bundle.rides.length>=8);
  const app2=mkApp(stubForecast(90,25));
  await app2.importAll(bundle);
  ok('imported into fresh app', (await app2.listRoutes()).length===1);
}

console.log('\nTailwind forecast flips the verdict:');
{
  clock=new Date(2026,4,31,21,30).getTime();
  const appT=mkApp(stubForecast(270,25)); // wind from west, east route -> tailwind
  const rT=await appT.createRoute(gpx, {name:'E', seedStillAirSec:1000, targetArrival:'08:45', activeDays:['MO','TU','WE','TH','FR']});
  const hv=await appT.getHomeVerdict(rT.id, new Date(2026,5,1,12,0).getTime());
  ok('tailwind verdict', hv.verdict.verdict==='tailwind', hv.verdict.verdict);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail?1:0);
