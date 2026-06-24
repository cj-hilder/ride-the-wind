import { Store, MemoryBackend, requestPersistentStorage, STORES } from './src/lib/storage.js';
import * as learning from './src/lib/learning.js';

let pass=0,fail=0;
const ok=(n,c,d='')=>{ c?(pass++,console.log(`  PASS  ${n}`)):(fail++,console.log(`  FAIL  ${n}  ${d}`)); };
const near=(a,b,t)=>Math.abs(a-b)<=t;

// deterministic uuid for tests
let uid=0; const uuid=()=>`id${++uid}`;
const mkStore=()=> new Store({ backend:new MemoryBackend(), uuid, learning });

const processed={
  segments:[{lat:0,lon:0,bearing:90,distance:100,eleDelta:null}],
  totalDistance:5000, hasElevation:false,
  start:{lat:0,lon:0}, end:{lat:0,lon:0.045},
};
const setup={
  name:'Home → Office', seedStillAirSec:1000,
  targetArrival:'08:45', activeDays:['MO','TU','WE','TH','FR'],
};

console.log('Route creation + config init:');
{
  uid=0; const s=mkStore();
  const route=await s.createRoute(processed, setup, {kHead:0.5,kTail:0.5});
  ok('route stored with id', route.id==='id1');
  ok('baseline seeded', route.baselineTimeSec===1000);
  ok('start region built', route.startRegion.radius===60);
  ok('config: manual modes by default', route.baselineMode==='manual' && route.kMode==='manual' && route.split===false);
  ok('config: k sliders seeded', route.sliderKHead===0.5 && route.sliderKTail===0.5);
  const cfg=s.routeConfig(route);
  ok('routeConfig assembles', cfg.sliderBaselineSec===1000 && cfg.kMode==='manual');
}

console.log('\nRides persist with curation fields; model resolves from log (learn mode):');
{
  uid=0; const s=mkStore();
  const route=await s.createRoute(processed, setup, {kHead:1.0,kTail:1.0});
  // switch to learn mode for baseline + k
  await s.updateRoute(route.id, { baselineMode:'learn', kMode:'learn' });
  // a still ride pins baseline at 1000; windy rides both directions train k=0.5
  const day=24*60*60*1000; const t0=Date.now();
  const wfs=[0, -0.5, 0.5, -0.7, 0.7, -0.3, 0.3, -0.9];
  for(let i=0;i<wfs.length;i++){
    await s.recordRide({
      routeId:route.id, startedAt:t0 - (wfs.length-i)*60000, endedAt:t0,
      actualTimeSec:1000*(1+0.5*wfs[i]), windFactor:wfs[i],
    });
  }
  const rides=await s.listRides(route.id);
  ok('all rides stored', rides.length===wfs.length);
  ok('rides default included', rides.every(r=>r.included===true));
  ok('rides default current ref', rides.every(r=>r.baselineRef==='current'));
  const resolved=await s.resolveRouteModel(route.id, t0);
  ok('baseline learned ~1000 (still ride)', near(resolved.baselineSec,1000,1), `${resolved.baselineSec}`);
  ok('auto-split both directions', resolved.split===true && resolved.autoSplit===true);
  ok('kHead learned ~0.5', near(resolved.kHead,0.5,0.03), `${resolved.kHead.toFixed(3)}`);
  ok('kTail learned ~0.5', near(resolved.kTail,0.5,0.03), `${resolved.kTail.toFixed(3)}`);
  const r2=await s.getRoute(route.id);
  ok('route cached baseline updated ~1000', near(r2.baselineTimeSec,1000,2), `${r2.baselineTimeSec}`);
}

console.log('\nManual mode ignores rides (uses sliders):');
{
  uid=0; const s=mkStore();
  const route=await s.createRoute(processed, setup, {kHead:0.8,kTail:0.3});
  // default manual; record a wild ride — should not move the resolved model
  await s.recordRide({routeId:route.id, startedAt:Date.now(), endedAt:Date.now(), actualTimeSec:9999, windFactor:0.5});
  const resolved=await s.resolveRouteModel(route.id);
  ok('manual baseline = slider', resolved.baselineSec===1000 && resolved.baselineSource==='slider');
  ok('manual k = sliders', resolved.kHead===0.8 && resolved.kTail===0.3);
}

console.log('\nCuration: exclude, edit duration, exclude-and-earlier:');
{
  uid=0; const s=mkStore();
  const route=await s.createRoute(processed, setup, {kHead:1,kTail:1});
  const t0=Date.now();
  const ids=[];
  for(let i=0;i<4;i++){
    const {ride}=await s.recordRide({routeId:route.id, startedAt:t0+i*1000, endedAt:t0+i*1000+60, actualTimeSec:1000+i, windFactor:0.3});
    ids.push(ride.id);
  }
  await s.updateRide(ids[3], { included:false });
  ok('exclude one ride', (await s.getRide(ids[3])).included===false);
  await s.updateRide(ids[0], { actualTimeSec:1234 });
  ok('edit duration', (await s.getRide(ids[0])).actualTimeSec===1234);
  // exclude ids[2] and all earlier (ids[0], ids[1], ids[2])
  const n=await s.excludeRideAndEarlier(ids[2]);
  ok('exclude-and-earlier count', n===3, `${n}`);
  const rides=await s.listRides(route.id);
  const inc=(id)=>rides.find(r=>r.id===id).included;
  ok('earlier+self excluded', inc(ids[0])===false && inc(ids[1])===false && inc(ids[2])===false);
}

console.log('\nFreeze: ride older than 14 days flips to historic, snapshots baseline:');
{
  uid=0; const s=mkStore();
  const route=await s.createRoute(processed, setup, {kHead:1,kTail:1});
  const t0=Date.now();
  const old=t0 - 20*24*60*60*1000; // 20 days ago
  const {ride}=await s.recordRide({routeId:route.id, startedAt:old, endedAt:old+60, actualTimeSec:1100, windFactor:0.4});
  // manual baseline 1000 → freeze should snapshot 1000
  await s.resolveRouteModel(route.id, t0);
  const after=await s.getRide(ride.id);
  ok('old ride frozen historic', after.baselineRef==='historic');
  ok('freeze snapshots live baseline', after.savedBaselineSec===1000, `${after.savedBaselineSec}`);
}

console.log('\nCascade delete:');
{
  uid=0; const s=mkStore();
  const route=await s.createRoute(processed, setup, {kHead:1.0,kTail:1.0});
  await s.recordRide({routeId:route.id, startedAt:1, endedAt:2, actualTimeSec:1000, windFactor:0});
  await s.deleteRoute(route.id);
  ok('route gone', (await s.getRoute(route.id))===undefined);
  ok('rides gone', (await s.listRides(route.id)).length===0);
}

console.log('\nExport / import round-trip:');
{
  uid=0; const s=mkStore();
  const route=await s.createRoute(processed, setup, {kHead:0.7,kTail:0.7});
  await s.recordRide({routeId:route.id, startedAt:1, endedAt:2, actualTimeSec:1100, windFactor:0.2});
  await s.setSetting('globalAlertThresholdMin', 5);
  const bundle=await s.exportAll();
  ok('bundle has format tag', bundle.format==='ride-the-wind/export');
  ok('bundle has route + ride', bundle.routes.length===1 && bundle.rides.length===1);
  ok('bundle has settings', bundle.settings.globalAlertThresholdMin===5);

  // import into a fresh store
  uid=100; const s2=mkStore();
  await s2.importAll(bundle);
  const r=await s2.getRoute(route.id);
  ok('imported route matches', r && r.name==='Home → Office');
  ok('imported ride', (await s2.listRides(route.id)).length===1);
  ok('imported setting', (await s2.getSetting('globalAlertThresholdMin'))===5);

  // merge mode keeps existing
  await s2.updateRoute(route.id, {name:'Renamed'});
  await s2.importAll(bundle, 'merge');
  ok('merge keeps existing name', (await s2.getRoute(route.id)).name==='Renamed');

  // replace mode overwrites
  await s2.importAll(bundle, 'replace');
  ok('replace overwrites back', (await s2.getRoute(route.id)).name==='Home → Office');

  // bad bundle rejected
  let threw=false; try{ await s2.importAll({format:'nope'}); }catch{ threw=true; }
  ok('rejects foreign bundle', threw);
}

console.log('\nPersistent storage request shim:');
{
  ok('null when unavailable', (await requestPersistentStorage({}))===null);
  ok('passes through true', (await requestPersistentStorage({storage:{persist:async()=>true}}))===true);
  ok('passes through false', (await requestPersistentStorage({storage:{persist:async()=>false}}))===false);
}

// Reorder routes: explicit order persists and listRoutes returns sorted.
{
  const s = mkStore();
  const r1 = await s.createRoute(processed, { ...setup, name:'One' }, { kHead:1, kTail:1 });
  const r2 = await s.createRoute(processed, { ...setup, name:'Two' }, { kHead:1, kTail:1 });
  const r3 = await s.createRoute(processed, { ...setup, name:'Three' }, { kHead:1, kTail:1 });
  let names = (await s.listRoutes()).map(r=>r.name);
  ok('routes list in creation order', JSON.stringify(names)===JSON.stringify(['One','Two','Three']), names.join(','));
  await s.reorderRoutes([r3.id, r1.id, r2.id]);
  names = (await s.listRoutes()).map(r=>r.name);
  ok('reorder persists new order', JSON.stringify(names)===JSON.stringify(['Three','One','Two']), names.join(','));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail?1:0);
