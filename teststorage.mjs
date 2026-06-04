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

console.log('Route creation + model init:');
{
  uid=0; const s=mkStore();
  const route=await s.createRoute(processed, setup, {kHead:0.5,kTail:0.5});
  ok('route stored with id', route.id==='id1');
  ok('baseline seeded', route.baselineTimeSec===1000);
  ok('start region built', route.startRegion.radius===60);
  const model=await s.getModel(route.id);
  ok('model created with seeded k', model.kHead===0.5 && model.usableRideCount===0);
}

console.log('\nRide capture updates model (usable):');
{
  uid=0; const s=mkStore();
  const route=await s.createRoute(processed, setup, {kHead:1.0,kTail:1.0});
  // record several usable rides matching baseline 1000, k=0.5
  const wfs=[-1,1,-0.5,0.5,0,0.8,-0.7,0.3];
  for(let i=0;i<wfs.length;i++){
    await s.recordRide({
      routeId:route.id, startedAt:1000+i, endedAt:2000+i,
      actualTimeSec:1000*(1+0.5*wfs[i]), windFactor:wfs[i], usable:true,
    });
  }
  const model=await s.getModel(route.id);
  ok('ride count tracked', model.usableRideCount===wfs.length, `${model.usableRideCount}`);
  ok('k learned ~0.5', near(model.kHead,0.5,0.02), `${model.kHead.toFixed(3)}`);
  const r2=await s.getRoute(route.id);
  ok('route baseline updated ~1000', near(r2.baselineTimeSec,1000,5), `${r2.baselineTimeSec.toFixed(1)}`);
  const rides=await s.listRides(route.id);
  ok('rides indexed by routeId', rides.length===wfs.length);
}

console.log('\nUnusable ride stored but excluded from learning:');
{
  uid=0; const s=mkStore();
  const route=await s.createRoute(processed, setup, {kHead:1.0,kTail:1.0});
  await s.recordRide({routeId:route.id, startedAt:1, endedAt:2, actualTimeSec:9999, windFactor:0.5, usable:false, excludeReason:'puncture'});
  const model=await s.getModel(route.id);
  ok('unusable does not bump count', model.usableRideCount===0);
  const rides=await s.listRides(route.id);
  ok('unusable still stored', rides.length===1 && rides[0].excludeReason==='puncture');
}

console.log('\nRecompute == online (data spec §4):');
{
  uid=0; const s=mkStore();
  const route=await s.createRoute(processed, setup, {kHead:1.0,kTail:1.0});
  const wfs=[-0.8,0.6,0.2,-1,0.9,-0.3,0.5,0,1,-0.6];
  for(let i=0;i<wfs.length;i++){
    await s.recordRide({routeId:route.id, startedAt:i, endedAt:i+1, actualTimeSec:1000*(1+0.5*wfs[i]), windFactor:wfs[i], usable:true});
  }
  const online=await s.getModel(route.id);
  const recomputed=await s.recomputeModel(route.id);
  ok('recompute k matches online', near(online.kHead, recomputed.kHead, 1e-9), `${online.kHead} vs ${recomputed.kHead}`);
  ok('recompute count matches', online.usableRideCount===recomputed.usableRideCount);
}

console.log('\nCascade delete:');
{
  uid=0; const s=mkStore();
  const route=await s.createRoute(processed, setup, {kHead:1.0,kTail:1.0});
  await s.recordRide({routeId:route.id, startedAt:1, endedAt:2, actualTimeSec:1000, windFactor:0, usable:true});
  await s.deleteRoute(route.id);
  ok('route gone', (await s.getRoute(route.id))===undefined);
  ok('model gone', (await s.getModel(route.id))===undefined);
  ok('rides gone', (await s.listRides(route.id)).length===0);
}

console.log('\nExport / import round-trip:');
{
  uid=0; const s=mkStore();
  const route=await s.createRoute(processed, setup, {kHead:0.7,kTail:0.7});
  await s.recordRide({routeId:route.id, startedAt:1, endedAt:2, actualTimeSec:1100, windFactor:0.2, usable:true});
  await s.setSetting('globalAlertThresholdMin', 5);
  const bundle=await s.exportAll();
  ok('bundle has format tag', bundle.format==='ride-the-wind/export');
  ok('bundle has route, ride, model', bundle.routes.length===1 && bundle.rides.length===1 && bundle.models.length===1);
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

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail?1:0);
