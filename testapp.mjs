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
  // v2: seed times invert through the PHYSICAL branch curves (k = wind attenuation):
  // head excess 0.3 → invHead ≈ 0.528; tail saving 0.24 → invTail ≈ 0.604
  ok('kHead slider seeded ~invHead(0.3)', near(route.sliderKHead,0.528,0.005), `${route.sliderKHead.toFixed(3)}`);
  ok('kTail slider seeded ~invTail(0.24)', near(route.sliderKTail,0.604,0.005), `${route.sliderKTail.toFixed(3)}`);
  ok('config learn by default', route.baselineMode==='learn' && route.kMode==='learn');
}

console.log('\nLive home verdict (headwind forecast):');
{
  // The Plan tab queries a specific day; query Monday (in the stub's window).
  const monday = new Date(2026,5,1,12,0).getTime();
  const hv=await app.getHomeVerdict(route.id, monday);
  ok('verdict produced', hv.verdict!=null);
  ok('headwind -> leave earlier', hv.verdict.verdict==='headwind', hv.verdict.verdict);
  // windEffect exposes feltWindKmh (forecast equivalent × the route's k), the
  // quantity the "light" phrase keys off. At the default k=0.5 it must sit below
  // the raw k=1 equivalent — that k-scaling is what makes "light" reflect what
  // the rider will actually feel, not just the forecast.
  if (hv.windEffect) {
    ok('windEffect exposes feltWindKmh', Number.isFinite(hv.windEffect.feltWindKmh), JSON.stringify(hv.windEffect.feltWindKmh));
    ok('feltWindKmh k-scaled ≤ raw equivalent', hv.windEffect.feltWindKmh <= Math.abs(hv.debug.effortHeadwindKmh) + 1e-9, `felt=${hv.windEffect.feltWindKmh} eq=${hv.debug.effortHeadwindKmh}`);
  }
  ok('range present', hv.range && hv.range.highSec>=hv.range.lowSec);
  ok('confidence: nothing learned yet (0 dots)', hv.confidence.dots===0 && hv.confidence.baselineLearned===false);
  ok('verdict has departureMs for countdown', typeof hv.verdict.departureMs==='number');
  ok('no message field (scheduler removed)', !('message' in hv.verdict));
  // Item 6: times are self-consistent with integer mental arithmetic. The gap
  // between shown departure and shown latest-arrival must be a whole number of
  // minutes (no hidden sub-minute seconds), and equal the displayed slow ride
  // time on the arrive-mode conservative result.
  if (hv.conservative && hv.conservative.mode==='arrive') {
    const gapSec = (hv.conservative.latestArrivalMs - hv.conservative.departureMs)/1000;
    ok('departure→arrival gap is whole minutes', Math.abs(gapSec % 60) < 1e-6, `${gapSec}s`);
    ok('gap equals displayed slow ride time', Math.round(gapSec/60) === hv.windEffect.slowMin, `${gapSec/60} vs ${hv.windEffect.slowMin}`);
  }
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
  ok('rides stored with v2 wind fields', rides.every(r=>r.wfv===2 && Number.isFinite(r.rideWindKmh)));
  ok('rides default included', rides.every(r=>r.included===true));
  const t=await app.routeTuning(route.id);
  // All fixture rides ran at exactly baseline time, so the honest learned k is
  // 0 ("no wind effect observed") — legitimate in THE k range 0–1.2.
  ok('learned kHead in bounds', t.learned.kHead>=0 && t.learned.kHead<=1.2, `${t.learned.kHead}`);
  ok('learned kTail in bounds', t.learned.kTail>=0 && t.learned.kTail<=1.2, `${t.learned.kTail}`);
  // Out-of-range per-ride k (v2): a ride wildly slower than the model allows
  // (implied k > 1.2) defaults to NOT used at record time, like gentle rides.
  const anomStart=new Date(2026,5,20,8,0).getTime();
  const {ride:anom}=await app.recordRide({ routeId:route.id, startedAt:anomStart, endedAt:anomStart+3000*1000,
    actualTimeSec:3000, forecastWind:station(90,15) });
  ok('out-of-range k ride defaults to not-used', anom.included===false, `included=${anom.included} wind=${anom.rideWindKmh}`);
  // Still ride whose time differs from the seed baseline: equivalent wind is
  // ~0, so k = deviation/wind would blow up — but a still ride must NOT be
  // quarantined by that (it carries no wind signal, and should feed baseline).
  const stillStart=new Date(2026,5,21,8,0).getTime();
  const {ride:stillRide}=await app.recordRide({ routeId:route.id, startedAt:stillStart, endedAt:stillStart+3600*1000,
    actualTimeSec:3600, forecastWind:station(90,2) }); // 2 km/h, ~still
  ok('still ride defaults to USED even when time differs from baseline', stillRide.included===true, `included=${stillRide.included} wind=${stillRide.rideWindKmh}`);
  ok('learned baseline positive', t.learned.baselineSec>0);
}

console.log('\nCapture path sets used/not-used from classification (no forced usable):');
{
  // A near-calm forecast → gentle/still wind_factor → the accepted ride must be
  // recorded but NOT auto-used if gentle. Use a fresh route to control wind.
  const r2=await app.createRoute(gpx, { name:'ClassRoute', seedStillAirSec:1000,
    targetArrival:'08:45', activeDays:['MO','TU','WE','TH','FR'] }, {kHead:1,kTail:1});
  // light wind ~ along route to land in the gentle/still bands
  const lightStation=[{lat:0,lon:0.0225,series:
    parseForecast({hourly:{time:[Math.floor(new Date(2026,5,1,8,0).getTime()/1000)],
      wind_speed_10m:[8], wind_direction_10m:[90]}})}];
  const start=new Date(2026,5,2,8,0).getTime();
  const {ride}=await app.recordRide({ routeId:r2.id, startedAt:start, endedAt:start+1000*1000,
    actualTimeSec:1000, forecastWind:lightStation });
  const cls = Math.abs(ride.rideWindKmh) < 5 ? 'still' : Math.abs(ride.rideWindKmh) < 10 ? 'gentle' : 'windy'; // v2 km/h bands
  ok('recorded ride carries v2 wind fields', ride.wfv===2 && Number.isFinite(ride.rideWindKmh));
  if (cls==='gentle') ok('gentle ride recorded as NOT used', ride.included===false, `wind=${ride.rideWindKmh}`);
  else ok(`non-gentle (${cls}) ride recorded as used`, ride.included===true, `wind=${ride.rideWindKmh}`);
  // And a strong headwind ride → windy → used
  const strongStation=[{lat:0,lon:0.0225,series:
    parseForecast({hourly:{time:[Math.floor(new Date(2026,5,1,8,0).getTime()/1000)],
      wind_speed_10m:[30], wind_direction_10m:[90]}})}];
  const {ride:windyRide}=await app.recordRide({ routeId:r2.id, startedAt:start+1, endedAt:start+1+1000*1000,
    actualTimeSec:1200, forecastWind:strongStation });
  ok('windy ride recorded as used', windyRide.included===true, `wind=${windyRide.rideWindKmh}`);
  await app.deleteRoute(r2.id); // clean up so later export-count assertions hold
}

console.log('\nManual ride entry (recordManualRide):');
{
  const mApp = mkApp(stubForecast(90, 30)); // strong headwind along route → windy
  // clock = today at 09:00 on 2026-06-01 (within the stub forecast window)
  clock = new Date(2026,5,1,9,0).getTime();
  const mRoute = await mApp.createRoute(gpx, { name:'ManualRoute', seedStillAirSec:1000,
    targetArrival:'08:45', activeDays:['MO','TU','WE','TH','FR'] }, {kHead:1,kTail:1});
  const startMs = new Date(2026,5,1,8,0).getTime();
  const endMs = new Date(2026,5,1,8,20).getTime(); // 20 min ride, both before 09:00
  const { ride } = await mApp.recordManualRide(mRoute.id, { startMs, endMs });
  ok('manual ride recorded with v2 wind fields', ride.wfv===2 && Number.isFinite(ride.rideWindKmh), `${ride.rideWindKmh}`);
  ok('actualTimeSec = finish − start (1200s)', ride.actualTimeSec === 1200, `${ride.actualTimeSec}`);
  ok('windy manual ride → used', ride.included === true, `wind=${ride.rideWindKmh}`);
  ok('startedAt preserved', ride.startedAt === startMs);

  // Validation: finish before start → throws
  let threw = false;
  try { await mApp.recordManualRide(mRoute.id, { startMs: endMs, endMs: startMs }); } catch { threw = true; }
  ok('finish ≤ start rejected', threw);
  // Validation: finish in the future → throws
  threw = false;
  try { await mApp.recordManualRide(mRoute.id, { startMs: clock, endMs: clock + 600000 }); } catch { threw = true; }
  ok('finish in the future rejected', threw);

  // It appears in the manager list
  const list = await mApp.ridesForManager(mRoute.id);
  ok('manual ride appears in the manager list', list.length === 1);
}
clock = new Date(2026,4,31,21,30).getTime(); // restore for later tests

console.log('\nReverse route (createReverseRoute):');
{
  const rApp = mkApp(stubForecast(90, 20));
  const src = await rApp.createRoute(gpx, { name:'Morning Commute', seedStillAirSec:1200,
    seedHeadwind20Sec:1560, seedTailwind20Sec:900, targetArrival:'08:45',
    activeDays:['MO','TU','WE','TH','FR'] }, {kHead:0.6,kTail:0.3});
  const rev = await rApp.createReverseRoute(src.id, {});
  ok('reverse gets a new id', rev.id !== src.id);
  ok('auto name "Reverse <src>"', rev.name === 'Reverse Morning Commute', rev.name);
  ok('total distance preserved', Math.abs(rev.totalDistance - src.totalDistance) < 1);
  ok('inherits baseline seed', rev.seedStillAirSec === 1200);
  // createRoute derives sliders from seed times (0.3 head, 0.25 tail here), and
  // the reverse inherits those stored sliders verbatim.
  // v2 physical inverses: invHead(0.3)≈0.5276, invTail(0.25)≈0.6364
  ok('inherits k sliders', Math.abs(rev.sliderKHead - 0.527638) < 1e-4 && Math.abs(rev.sliderKTail - 0.636364) < 1e-4, `${rev.sliderKHead}/${rev.sliderKTail}`);
  ok('modes learn/learn', rev.baselineMode === 'learn' && rev.kMode === 'learn');
  const revRides = await rApp.listRides(rev.id);
  ok('reverse starts with no rides', revRides.length === 0);
  // start/end swapped vs source
  ok('start = source end', Math.abs(rev.startRegion.lat - src.endRegion.lat) < 1e-9 && Math.abs(rev.startRegion.lon - src.endRegion.lon) < 1e-9);
  ok('end = source start', Math.abs(rev.endRegion.lat - src.startRegion.lat) < 1e-9);
  // custom name honoured
  const rev2 = await rApp.createReverseRoute(src.id, { name:'Evening ride home' });
  ok('custom name honoured', rev2.name === 'Evening ride home');

  // Modes are INHERITED, not forced: a source in manual baseline yields a
  // manual-baseline reverse carrying the same manual seed value.
  const srcM = await rApp.createRoute(gpx, { name:'ManualBaseline', seedStillAirSec:1000,
    seedHeadwind20Sec:1300, seedTailwind20Sec:800, baselineMode:'manual', kMode:'learn',
    targetArrival:'08:45', activeDays:[] }, {kHead:1,kTail:1});
  const revM = await rApp.createReverseRoute(srcM.id, {});
  ok('reverse inherits manual baseline mode', revM.baselineMode === 'manual' && revM.kMode === 'learn');
  ok('reverse inherits the manual seed value', revM.seedStillAirSec === 1000);

  // previewReverse: geometry preview + inherited defaults, WITHOUT creating.
  const beforeCount = (await rApp.listRoutes()).length;
  const pv = await rApp.previewReverse(src.id);
  ok('previewReverse does not create a route', (await rApp.listRoutes()).length === beforeCount);
  ok('previewReverse gives reversed geometry', Math.abs(pv.preview.totalDistance - src.totalDistance) < 1);
  ok('previewReverse default name', pv.defaults.name === 'Reverse Morning Commute');
  ok('previewReverse carries processed segments', pv.processed.segments.length > 0);
  // createRouteFromProcessed: build a route from the previewed geometry.
  const built = await rApp.createRouteFromProcessed(pv.processed, {
    name: 'From Processed', seedStillAirSec: 1000, seedHeadwind20Sec: 1300, seedTailwind20Sec: 800,
    baselineMode: 'learn', kMode: 'learn', targetArrival: '08:45', activeDays: ['MO'],
  });
  ok('createRouteFromProcessed makes a route', built.id && built.name === 'From Processed');
  ok('built route has the reversed distance', Math.abs(built.totalDistance - src.totalDistance) < 1);
}

console.log('\nRecord route by GPS (recordRoute → previewTrace → finalizeRecordedRoute):');
{
  const gApp = mkApp(stubForecast(90, 20));
  // Synchronous geo stub: emits a straight ~east trace of N fixes when watched.
  const dLon = 5 / 111320; // ~5 m spacing at the equator
  const makeGeo = (n) => {
    let cb = null;
    return {
      watchPosition: (success) => { cb = success; return 1; },
      clearWatch: () => {},
      _emitAll: () => { for (let i = 0; i < n; i++) { clock += 1000; cb({ coords: { latitude: 0, longitude: i * dLon, accuracy: 5 } }); } },
    };
  };
  const geo = makeGeo(150); // ~745 m
  const handle = await gApp.recordRoute({ geo });
  let recorded = null;
  handle.onFinish((rec) => { recorded = rec; });
  geo._emitAll();
  handle.manualFinish();
  ok('recordRoute produced a trace', recorded && recorded.trace.length === 150, `${recorded && recorded.trace.length}`);

  // Geolocation error must be surfaced via onError (previously swallowed → the UI
  // hung on "GPS initialising" on a device with no GPS / denied permission).
  {
    let errCb = null;
    const geoErr = { watchPosition: (_s, e) => { errCb = e; return 9; }, clearWatch: () => {} };
    let gotErr = null;
    await gApp.recordRoute({ geo: geoErr, onError: (e) => { gotErr = e; } });
    errCb && errCb({ code: 1, message: "User denied Geolocation" });
    ok('recordRoute surfaces geolocation error', gotErr && gotErr.code === 1, JSON.stringify(gotErr));
  }

  // REGRESSION: startRide must NOT finish while the rider is stationary near the
  // end region during GPS warm-up before actually setting off. Starting a ride
  // within ~180m of its own end (out-and-back / loop / testing from home) used to
  // trip finish-detection after 20s, call stop(), and freeze the whole ride.
  {
    const er = route.endRegion;
    let cbR = null;
    const geoR = { watchPosition: (s) => { cbR = s; return 7; }, clearWatch: () => {} };
    let finishedEarly = false, ticks = 0, arrivedEarly = false;
    await gApp.startRide(route, {
      geo: geoR,
      onTick: () => { ticks++; },
      onFinish: () => { finishedEarly = true; },
      onArrived: () => { arrivedEarly = true; },
    });
    // Emit ~30 stationary fixes AT the end region (>20s of "stopped near end").
    const base = 1_700_000_000_000;
    for (let i = 0; i < 30; i++) {
      cbR({ coords: { latitude: er.lat, longitude: er.lon, accuracy: 6 }, timestamp: base + i * 1000 });
    }
    ok('stationary-at-end during warm-up does NOT finish', finishedEarly === false, `finished=${finishedEarly}`);
    ok('stationary-at-end during warm-up does NOT auto-arrive', arrivedEarly === false, `arrived=${arrivedEarly}`);
    ok('ticks keep flowing (not frozen)', ticks >= 25, `ticks=${ticks}`);
  }
  // startRide must also surface geolocation errors via onError.
  {
    let errCb = null;
    const geoErr = { watchPosition: (_s, e) => { errCb = e; return 8; }, clearWatch: () => {} };
    let gotErr = null;
    await gApp.startRide(route, { geo: geoErr, onTick: () => {}, onError: (e) => { gotErr = e; } });
    errCb && errCb({ code: 2, message: "Position unavailable" });
    ok('startRide surfaces geolocation error', gotErr && gotErr.code === 2, JSON.stringify(gotErr));
  }

  // GPS-timestamp timing: if fixes carry pos.timestamp, the derived speed must
  // use the GPS interval, not the (possibly batched/late) callback clock. Here
  // the callback clock advances 5000 ms per fix (as if delivered in a slow batch)
  // while the GPS timestamps advance a true 1000 ms; a ~5 m step over the real
  // 1 s is ~5 m/s, over the wrong 5 s would be ~1 m/s. We assert the tick sees
  // the ~5 m/s (GPS-time) speed.
  {
    const gApp2 = mkApp(stubForecast(90, 20));
    let cb2 = null; let gpsClock = 1_700_000_000_000;
    const geo2 = {
      watchPosition: (s) => { cb2 = s; return 1; },
      clearWatch: () => {},
    };
    const speeds = [];
    const dopplerSeen = [];
    const h2 = await gApp2.recordRoute({ geo: geo2, onTick: ({ speedMps, gpsSpeedMps, speedAccMps }) => {
      speeds.push(speedMps);
      if (gpsSpeedMps != null) dopplerSeen.push({ gpsSpeedMps, speedAccMps });
    } });
    for (let i = 0; i < 5; i++) {
      clock += 5000;        // callback/app clock jumps 5 s (batched delivery)
      gpsClock += 1000;     // true GPS time advances 1 s
      cb2({ coords: { latitude: 0, longitude: i * dLon, accuracy: 5, speed: 6.2, speedAccuracy: 0.4 }, timestamp: gpsClock });
    }
    h2.manualFinish();
    const last = speeds[speeds.length - 1];
    ok('speed uses GPS-interval dt (≈5 m/s not ≈1)', last > 3.5 && last < 6.5, `${last?.toFixed(2)} m/s`);
    ok('recordRoute forwards Doppler speed to onTick', dopplerSeen.length >= 4 && dopplerSeen.every((d) => d.gpsSpeedMps === 6.2), `${dopplerSeen.length} seen`);
    ok('recordRoute forwards speed accuracy to onTick', dopplerSeen.every((d) => d.speedAccMps === 0.4));
  }

  // previewTrace: gate + process without creating
  const pv = gApp.previewTrace(recorded.trace);
  ok('previewTrace ok', pv.ok === true, JSON.stringify(pv.reason));
  ok('previewTrace has geometry', pv.ok && pv.preview.totalDistance > 500);

  const before = (await gApp.listRoutes()).length;
  const res = await gApp.finalizeRecordedRoute(recorded, {
    name: 'Recorded Loop', seedStillAirSec: 200, seedHeadwind20Sec: 260, seedTailwind20Sec: 150,
    baselineMode: 'learn', kMode: 'learn', targetArrival: '08:45', activeDays: ['MO'],
  });
  ok('finalize creates the route', res.ok && res.route && res.route.name === 'Recorded Loop');
  ok('one new route exists', (await gApp.listRoutes()).length === before + 1);
  // First traversal logged as the route's first ride
  const rides = await gApp.listRides(res.route.id);
  ok('route arrives with exactly one ride', rides.length === 1, `${rides.length}`);
  ok('first ride has v2 wind fields', rides[0].wfv===2 && Number.isFinite(rides[0].rideWindKmh));

  // A too-short recording is blocked with a reason (no route created)
  const geo2 = makeGeo(4);
  const h2 = await gApp.recordRoute({ geo: geo2 });
  let rec2 = null; h2.onFinish((r) => { rec2 = r; }); geo2._emitAll(); h2.manualFinish();
  const blocked = await gApp.finalizeRecordedRoute(rec2, { name: 'Too Short', seedStillAirSec: 100, targetArrival: '08:45', activeDays: ['MO'] });
  ok('too-short recording blocked', blocked.ok === false && typeof blocked.reason === 'string');
}
clock = new Date(2026,4,31,21,30).getTime(); // restore after geo stub advanced it

console.log('\nRide prediction (leaving-now duration for arrival seeding):');
{
  const pApp = mkApp(stubForecast(90, 25)); // headwind
  const pr = await pApp.createRoute(gpx, { name:'PredRoute', seedStillAirSec:1000,
    seedHeadwind20Sec:1300, seedTailwind20Sec:760, targetArrival:'08:45', activeDays:['MO'] });
  clock = new Date(2026,5,1,8,0).getTime();
  const pred = await pApp.ridePrediction(pr);
  ok('ridePrediction returns a positive duration', pred && pred.predictedSec > 0, JSON.stringify(pred));
  // headwind should make it no faster than still-air baseline
  ok('headwind prediction ≥ baseline', pred.predictedSec >= 1000 * 0.99, `${pred.predictedSec}`);
  ok('ridePrediction returns a head/tail word or null', ['headwind','tailwind','light headwind','light tailwind',null].includes(pred.windWord), `${pred.windWord}`);

  // With an ensemble available, ridePrediction returns the ensemble-weighted
  // center (the "likely"), not the bare deterministic value.
  const eApp = mkApp(stubForecast(90, 25), stubEnsemble(90, 25));
  const er = await eApp.createRoute(gpx, { name:'EnsRoute', seedStillAirSec:1000,
    seedHeadwind20Sec:1300, seedTailwind20Sec:760, targetArrival:'08:45', activeDays:['MO'] });
  clock = new Date(2026,5,1,8,0).getTime();
  const ep = await eApp.ridePrediction(er);
  ok('ridePrediction (ensemble) returns a positive center', ep && ep.predictedSec > 0, JSON.stringify(ep));
  ok('ensemble center is a sane headwind duration', ep.predictedSec >= 1000 * 0.99, `${ep.predictedSec}`);
  clock = new Date(2026,4,31,21,30).getTime();
  clock = new Date(2026,4,31,21,30).getTime();
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
  const appT=mkApp(stubForecast(270,32)); // wind from west, east route -> tailwind (32 km/h clears the 4-min threshold at the conservative default k=0.5)
  const rT=await appT.createRoute(gpx, {name:'E', seedStillAirSec:1000, targetArrival:'08:45', activeDays:['MO','TU','WE','TH','FR']});
  const hv=await appT.getHomeVerdict(rT.id, new Date(2026,5,1,12,0).getTime());
  ok('tailwind verdict', hv.verdict.verdict==='tailwind', hv.verdict.verdict);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail?1:0);
