import {
  windComponent, effortNorm, invHead, invTail, computeWindFactor, segmentTimes,
  seedK, sampleWind, interpAngle, parseForecast, makeWindFn, windFactorTimed, W_REF_KMH
} from './src/lib/windModel.js';

let pass=0, fail=0;
const ok=(n,c,d='')=>{ c?(pass++,console.log(`  PASS  ${n}`)):(fail++,console.log(`  FAIL  ${n}  ${d}`)); };
const near=(a,b,t)=>Math.abs(a-b)<=t;

console.log('Sign convention (the one that silently inverts everything):');
// Travelling due north (bearing 0). Wind FROM the north (fromDeg 0) blows in
// your face -> headwind, positive.
ok('wind from ahead = headwind (+)', windComponent(20,0,0) > 0, `${windComponent(20,0,0)}`);
ok('headwind magnitude = wind speed', near(windComponent(20,0,0),20,1e-9));
// Wind FROM the south (180) while going north -> at your back -> tailwind, negative.
ok('wind from behind = tailwind (-)', windComponent(20,180,0) < 0, `${windComponent(20,180,0)}`);
// Wind FROM the east (90) while going north -> pure crosswind -> ~0.
ok('crosswind ~ 0', near(windComponent(20,90,0),0,1e-9));

console.log('\nBranch curves (constant-power physics, v2, PHYSICAL magnitudes):');
const head = effortNorm(20);   // +0.708: full 20 km/h headwind costs 70.8%
const tail = effortNorm(-20);  // -0.350: full 20 km/h tailwind saves 35.0%
ok('g(+wref) = +0.708 (physical anchor)', near(head,0.708,1e-9), `${head}`);
ok('g(-wref) = -0.350 (physical anchor)', near(tail,-0.350,1e-9), `${tail}`);
ok('head super-linear below anchor', effortNorm(10) < 0.708*0.5, `${effortNorm(10)}`);
ok('head super-linear above anchor', effortNorm(30) > 0.708*1.5, `${effortNorm(30)}`);
ok('tail concave below anchor', Math.abs(effortNorm(-10)) > 0.350*0.5, `${effortNorm(-10)}`);
ok('tail saturating above anchor', Math.abs(effortNorm(-30)) < 0.350*1.5, `${effortNorm(-30)}`);
ok('zero wind -> 0', effortNorm(0) === 0);
ok('sign preserved on small tailwind', effortNorm(-5) < 0);
// exact inverse round-trips
for (const hk of [3, 8, 15, 20, 27]) {
  ok(`invHead round-trip ${hk}`, near(invHead(effortNorm(hk)) * W_REF_KMH, hk, 1e-6), `${invHead(effortNorm(hk)) * W_REF_KMH}`);
  ok(`invTail round-trip ${hk}`, near(invTail(-effortNorm(-hk)) * W_REF_KMH, hk, 1e-6), `${invTail(-effortNorm(-hk)) * W_REF_KMH}`);
}

console.log('\nAngle interpolation (wraparound):');
ok('350->10 midpoint = 0', near(interpAngle(350,10,0.5),0,1e-9), `${interpAngle(350,10,0.5)}`);
ok('10->350 midpoint = 0', near(interpAngle(10,350,0.5),0,1e-9), `${interpAngle(10,350,0.5)}`);
ok('80->100 midpoint = 90', near(interpAngle(80,100,0.5),90,1e-9));

console.log('\nsampleWind interpolation:');
const series=[{time:0,speed:10,fromDeg:0},{time:3600e3,speed:20,fromDeg:90}];
const mid=sampleWind(series, 1800e3);
ok('speed interpolated', near(mid.speed,15,1e-9), `${mid.speed}`);
ok('dir interpolated', near(mid.fromDeg,45,1e-9), `${mid.fromDeg}`);
ok('clamps before range', sampleWind(series,-1).speed===10);
ok('clamps after range', sampleWind(series,9e9).speed===20);

console.log('\nseedK round-trip (v2: k = wind attenuation, inverted through the curve):');
// still-air 1000s, true k=0.5: head seed time = 1000·(1+f_H(0.5)), tail = 1000·(1−|f_T(−0.5)|)
const tHeadSeed = 1000 * (1 + effortNorm(0.5 * 20));
const tTailSeed = 1000 * (1 + effortNorm(-0.5 * 20));
ok('recovers k=0.5 from both', near(seedK(1000, tHeadSeed, tTailSeed), 0.5, 1e-9), `${seedK(1000, tHeadSeed, tTailSeed)}`);
ok('recovers k from headwind only', near(seedK(1000, tHeadSeed, null), 0.5, 1e-9), `${seedK(1000, tHeadSeed, null)}`);
ok('defaults to DEFAULT_K (0.5) when none', seedK(1000, null, null) === 0.5);
ok('clamps absurd seed to K_MAX 1.2', seedK(1000, 9000, null) === 1.2);

console.log('\ncomputeWindFactor end-to-end:');
// 4 segments all heading north, uniform 20km/h headwind from north -> factor +1
const segs=[0,1,2,3].map(()=>({lat:0,lon:0,bearing:0,distance:100,eleDelta:null}));
const times=segmentTimes(segs,20,{useGradient:false});
const fHead=computeWindFactor(segs,()=>({speed:20,fromDeg:0}),times);
ok('uniform headwind -> +0.708 (physical)', near(fHead,0.708,1e-9), `${fHead}`);
const fTail=computeWindFactor(segs,()=>({speed:20,fromDeg:180}),times);
ok('uniform tailwind -> -0.350 (physical)', near(fTail,-0.350,1e-9), `${fTail}`);
const fCross=computeWindFactor(segs,()=>({speed:20,fromDeg:90}),times);
ok('uniform crosswind -> 0', near(fCross,0,1e-9), `${fCross}`);
// k-inside separability: wf(k, wind w) === wf(1, wind k·w) for uniform wind
const fK=computeWindFactor(segs,()=>({speed:20,fromDeg:0}),times,0.6);
const fScaled=computeWindFactor(segs,()=>({speed:12,fromDeg:0}),times,1);
ok('k inside: wf(k=0.6, 20) = wf(1, 12)', near(fK,fScaled,1e-12), `${fK} vs ${fScaled}`);
// split k: a pure-head route uses kHead and ignores kTail entirely
const fSplitHead=computeWindFactor(segs,()=>({speed:20,fromDeg:0}),times,{kHead:0.6,kTail:9});
ok('split k: head route uses kHead only', near(fSplitHead,fK,1e-12), `${fSplitHead}`);
const fSplitTail=computeWindFactor(segs,()=>({speed:20,fromDeg:180}),times,{kHead:9,kTail:0.6});
ok('split k: tail route uses kTail only', near(fSplitTail,computeWindFactor(segs,()=>({speed:12,fromDeg:180}),times,1),1e-12), `${fSplitTail}`);
ok('k default 1 unchanged', near(computeWindFactor(segs,()=>({speed:20,fromDeg:0}),times,1),0.708,1e-9));

console.log('\nparseForecast (canned Open-Meteo shape):');
const canned={hourly:{time:[100,0,200],wind_speed_10m:[5,4,6],wind_direction_10m:[10,20,30]}};
const parsed=parseForecast(canned);
ok('sorted ascending', parsed[0].time===0 && parsed[2].time===200e3);
ok('unixtime -> ms', parsed[1].time===100e3);
ok('fields mapped', parsed[0].speed===4 && parsed[0].fromDeg===20);

console.log('\nwindFactorTimed convergence (wind shifts over the hour):');
// headwind early, dropping to calm later; factor should be positive but < 1
const station={lat:0,lon:0,series:[{time:0,speed:20,fromDeg:0},{time:3600e3,speed:0,fromDeg:0}]};
const windFn=makeWindFn([station]);
const longSegs=Array.from({length:20},()=>({lat:0,lon:0,bearing:0,distance:500,eleDelta:null}));
const lt=segmentTimes(longSegs,20,{useGradient:false});
const ft=windFactorTimed({segments:longSegs,times:lt,windFn,departMs:0,passes:2});
ok('timed factor in (0,1)', ft>0 && ft<1, `${ft}`);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail?1:0);
