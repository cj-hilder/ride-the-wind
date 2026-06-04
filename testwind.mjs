import {
  windComponent, effortNorm, computeWindFactor, segmentTimes,
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

console.log('\nAsymmetry (headwind hurts more than tailwind helps):');
const head = effortNorm(20);   // +1
const tail = effortNorm(-20);  // -1
ok('f_norm(+wref) = +1', near(head,1,1e-9), `${head}`);
ok('f_norm(-wref) = -1', near(tail,-1,1e-9), `${tail}`);
// equal-magnitude head and tail cancel in the metric itself, but the
// asymmetry shows up because square grows: 30 headwind hurts 2.25x a 20,
// while the *signed square* keeps direction. Check growth is quadratic.
ok('quadratic growth', near(effortNorm(40), 4, 1e-9), `${effortNorm(40)}`);
ok('sign preserved on small tailwind', effortNorm(-5) < 0);

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

console.log('\nseedK round-trip:');
// still-air 1000s. With k=0.5: headwind20 = 1000*(1+0.5)=1500, tailwind20=1000*(1-0.5)=500
ok('recovers k=0.5 from both', near(seedK(1000,1500,500),0.5,1e-9), `${seedK(1000,1500,500)}`);
ok('recovers k from headwind only', near(seedK(1000,1300,null),0.3,1e-9), `${seedK(1000,1300,null)}`);
ok('defaults to DEFAULT_K (0.33) when none', seedK(1000,null,null)===0.33);
ok('clamps absurd seed to full max 4.0', seedK(1000,9000,null)===4.0);

console.log('\ncomputeWindFactor end-to-end:');
// 4 segments all heading north, uniform 20km/h headwind from north -> factor +1
const segs=[0,1,2,3].map(()=>({lat:0,lon:0,bearing:0,distance:100,eleDelta:null}));
const times=segmentTimes(segs,20,{useGradient:false});
const fHead=computeWindFactor(segs,()=>({speed:20,fromDeg:0}),times);
ok('uniform headwind -> +1', near(fHead,1,1e-9), `${fHead}`);
const fTail=computeWindFactor(segs,()=>({speed:20,fromDeg:180}),times);
ok('uniform tailwind -> -1', near(fTail,-1,1e-9), `${fTail}`);
const fCross=computeWindFactor(segs,()=>({speed:20,fromDeg:90}),times);
ok('uniform crosswind -> 0', near(fCross,0,1e-9), `${fCross}`);

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
