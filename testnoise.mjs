import { resolveModel } from './src/lib/learning.js';
import { effortNorm } from './src/lib/windModel.js';
let pass=0,fail=0;
const ok=(n,c,d='')=>{ c?(pass++,console.log(`  PASS  ${n}`)):(fail++,console.log(`  FAIL  ${n} ${d}`)); };
const near=(a,b,t)=>Math.abs(a-b)<=t;

// Realistic v2: baseline 1000s, true attenuation k=0.5, winds uniform in
// [-20,20] km/h, +/-30s random noise. All rides current; learn mode.
function rng(seed){ return ()=>(seed=(seed*1103515245+12345)&0x7fffffff)/0x7fffffff; }
const r=rng(42);
const NOW=1_700_000_000_000;
const rides=[];
let stillCount=0;
for(let i=0;i<60;i++){
  const w=(r()*2-1)*20; // signed km/h, good spread both directions
  const noise=(r()*2-1)*30;
  if (Math.abs(w) < 5) stillCount++;
  rides.push({
    id:`r${i}`, wfv:2, rideWindKmh:w, actualSec:1000*(1+effortNorm(0.5*w))+noise,
    startedAt:NOW - (60-i)*60000, included:true, baselineRef:'current', savedBaselineSec:null,
  });
}
const config={ baselineMode:'learn', sliderBaselineSec:1500, kMode:'learn', split:false, sliderKHead:1, sliderKTail:1 };
const m=resolveModel(rides, config, NOW);
console.log(`  resolved: baseline=${m.baselineSec.toFixed(1)} kHead=${m.kHead.toFixed(3)} kTail=${m.kTail.toFixed(3)} (still rides=${stillCount}, baseline branch=${m.baselineBranch})`);
ok('noisy baseline within 15s of 1000', near(m.baselineSec,1000,15), `${m.baselineSec}`);
ok('noisy kHead within 0.06 of 0.5', near(m.kHead,0.5,0.06), `${m.kHead}`);
ok('noisy kTail within 0.06 of 0.5', near(m.kTail,0.5,0.06), `${m.kTail}`);
ok('auto-split (both directions learned)', m.split && m.kHeadSource==='learned' && m.kTailSource==='learned');

// Stress baseline branch 2: NO still rides — |wind| in [10,20] km/h, both
// directions, same k=0.5 + noise. KNOWN BIAS: the intercept regressor assumes
// the k=1 curve shape while data follows f(0.5·w), overestimating ~3%; this is
// the coarse no-still-rides fallback, so assert within 60s.
const r2=rng(7); const windyOnly=[];
for(let i=0;i<60;i++){
  const sign = i%2 ? 1 : -1;
  const w = sign * (10 + r2()*10);
  const noise=(r2()*2-1)*30;
  windyOnly.push({ id:`w${i}`, wfv:2, rideWindKmh:w, actualSec:1000*(1+effortNorm(0.5*w))+noise,
    startedAt:NOW - (60-i)*60000, included:true, baselineRef:'current', savedBaselineSec:null });
}
const m2=resolveModel(windyOnly, config, NOW);
console.log(`  windy-only: baseline=${m2.baselineSec.toFixed(1)} (branch=${m2.baselineBranch}) kHead=${m2.kHead.toFixed(3)} kTail=${m2.kTail.toFixed(3)}`);
ok('branch-2 extrapolated baseline within 60s of 1000 (curvature bias ~3%)', near(m2.baselineSec,1000,60), `${m2.baselineSec}`);
ok('branch-2 used (no still rides)', m2.baselineBranch===2);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail?1:0);
