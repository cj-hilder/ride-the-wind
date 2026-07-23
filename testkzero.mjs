// k = 0 and k → 0 safety: no division by zero, no value explosion.
import { effortNorm, invHead, invTail, computeWindFactor, seedK } from './src/lib/windModel.js';
import { rideK, clampK, K_MIN, K_LEARN_REJECT, resolveModel } from './src/lib/learning.js';
let pass=0,fail=0;
const ok=(n,c,d='')=>{ c?(pass++,console.log(`  PASS  ${n}`)):(fail++,console.log(`  FAIL  ${n} ${d}`)); };
const fin=(x)=>x===null||Number.isFinite(x);

console.log('k = 0 / k → 0 safety:');
const segs=[{bearing:0},{bearing:90},{bearing:180}], times=[10,10,10], windAt=()=>({speed:25,fromDeg:0});
ok('effortNorm(0) finite & 0', effortNorm(0)===0);
ok('computeWindFactor k=0 → 0', computeWindFactor(segs,windAt,times,0)===0);
ok('computeWindFactor {0,0} → 0', computeWindFactor(segs,windAt,times,{kHead:0,kTail:0})===0);
ok('computeWindFactor k=1e-12 finite', fin(computeWindFactor(segs,windAt,times,1e-12)));
ok('clampK(0)=0, clampK(−5)=0', clampK(0)===0 && clampK(-5)===0);
ok('invHead(0)=0, invTail(0)=0', invHead(0)===0 && invTail(0)===0);

console.log('\nrideK never non-finite; explosions are quarantined (k>reject) not crashes:');
const patho=[
  {rideWindKmh:-3, actualSec:1000*(1-0.6)}, // fast tailwind
  {rideWindKmh:-0.001, actualSec:990},       // tiny tailwind
  {rideWindKmh:0.001, actualSec:1100},        // tiny headwind
  {rideWindKmh:2, actualSec:3000},            // slow, weak headwind
  {rideWindKmh:-3, actualSec:1},              // near-instant (dev→−1)
];
for(const p of patho){
  const k=rideK({wfv:2,rideWindKmh:p.rideWindKmh,actualSec:p.actualSec,baselineRef:'current'},1000);
  ok(`rideK finite for w=${p.rideWindKmh}, t=${p.actualSec}`, fin(k), `${k}`);
}

console.log('\nresolveModel with a user k of 0 on all rides (fully sheltered) is stable:');
const rides=[];
const day=86400000, t0=Date.now();
for(let i=0;i<6;i++) rides.push({ id:'r'+i, wfv:2, rideWindKmh:(i%2?12:-12), actualSec:1000, baselineRef:'current', startedAt:t0-(6-i)*day, included:true });
const rm=resolveModel(rides, { kMode:'manual', sliderKHead:0, sliderKTail:0, baselineMode:'learn' }, t0);
ok('resolveModel k=0 baseline finite', Number.isFinite(rm.baselineSec), `${rm.baselineSec}`);
ok('resolveModel k=0 kHead/kTail finite', Number.isFinite(rm.kHead) && Number.isFinite(rm.kTail), `${rm.kHead}/${rm.kTail}`);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail?1:0);
