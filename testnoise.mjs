import { rebuildFromRides, fitModel } from './src/lib/learning.js';
let pass=0,fail=0;
const ok=(n,c,d='')=>{ c?(pass++,console.log(`  PASS  ${n}`)):(fail++,console.log(`  FAIL  ${n} ${d}`)); };
const near=(a,b,t)=>Math.abs(a-b)<=t;

// Realistic: baseline 1000s, k=0.5, good wind spread, ±30s random noise.
function rng(seed){ return ()=>(seed=(seed*1103515245+12345)&0x7fffffff)/0x7fffffff; }
const r=rng(42);
const rides=[];
for(let i=0;i<60;i++){
  const wf=(r()*2-1); // uniform [-1,1] good spread
  const noise=(r()*2-1)*30;
  rides.push({windFactor:wf, actualSec:1000*(1+0.5*wf)+noise, usable:true});
}
const fit=fitModel(rebuildFromRides(rides,{halfLifeRides:1e9}));
console.log(`  fit: baseline=${fit.baselineSec.toFixed(1)} kHead=${fit.kHead.toFixed(3)} kTail=${fit.kTail.toFixed(3)}`);
ok('noisy baseline within 15s of 1000', near(fit.baselineSec,1000,15));
ok('noisy kHead within 0.06 of 0.5', near(fit.kHead,0.5,0.06), `${fit.kHead}`);
ok('noisy kTail within 0.06 of 0.5', near(fit.kTail,0.5,0.06), `${fit.kTail}`);
ok('both identifiable', fit.identifiableHead && fit.identifiableTail);
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail?1:0);
