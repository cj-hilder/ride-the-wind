import {
  createModelState, updateModel, fitModel, predict, confidence,
  checkOutlier, rebuildFromRides
} from './src/lib/learning.js';

let pass=0, fail=0;
const ok=(n,c,d='')=>{ c?(pass++,console.log(`  PASS  ${n}`)):(fail++,console.log(`  FAIL  ${n}  ${d}`)); };
const near=(a,b,t)=>Math.abs(a-b)<=t;

// synth from known asymmetric ground truth
function synth(baseline, kHead, kTail, windFactors) {
  return windFactors.map((wf) => ({
    windFactor: wf,
    actualSec: baseline*(1+(wf>=0?kHead:kTail)*wf),
    usable: true,
  }));
}

console.log('Recovery of known asymmetric parameters (no noise):');
{
  const wfs=[-0.6,-0.5,-0.3,-0.2,-0.1,0,0.1,0.2,0.3,0.5,0.6,0.8,-0.7,0.4,-0.4];
  const rides=synth(1000,0.8,0.3,wfs);
  const state=rebuildFromRides(rides,{halfLifeRides:1e9});
  const fit=fitModel(state);
  ok('recovers baseline=1000', near(fit.baselineSec,1000,0.5), `${fit.baselineSec.toFixed(2)}`);
  ok('recovers kHead=0.8', near(fit.kHead,0.8,0.01), `${fit.kHead.toFixed(4)}`);
  ok('recovers kTail=0.3', near(fit.kTail,0.3,0.01), `${fit.kTail.toFixed(4)}`);
  ok('both identifiable', fit.identifiableHead && fit.identifiableTail);
}

console.log('\nSymmetric ground truth still recovered (kHead==kTail):');
{
  const wfs=[-0.6,-0.4,-0.2,0,0.2,0.4,0.6,0.8,-0.5,0.5];
  const fit=fitModel(rebuildFromRides(synth(1000,0.5,0.5,wfs),{halfLifeRides:1e9}));
  ok('kHead=0.5', near(fit.kHead,0.5,0.01), `${fit.kHead.toFixed(4)}`);
  ok('kTail=0.5', near(fit.kTail,0.5,0.01), `${fit.kTail.toFixed(4)}`);
}

console.log('\nFallback to seed when a direction lacks data:');
{
  // only headwind rides
  const fit=fitModel(rebuildFromRides(synth(1000,0.9,0.3,[0.1,0.2,0.3,0.4,0.5,0.6]),{halfLifeRides:1e9}),{seedKHead:1.0,seedKTail:0.5});
  ok('kHead learned', near(fit.kHead,0.9,0.05), `${fit.kHead}`);
  ok('kTail at seed', near(fit.kTail,0.5,1e-9), `${fit.kTail}`);
  ok('no NaN', Number.isFinite(fit.kHead)&&Number.isFinite(fit.baselineSec));
}

console.log('\nClamping:');
{
  // extreme slope should clamp to <=3.0
  const fit=fitModel(rebuildFromRides(synth(1000,5,5,[-0.5,-0.3,0,0.3,0.5,0.6]),{halfLifeRides:1e9}));
  ok('kHead clamped <=3.0', fit.kHead<=3.0+1e-9, `${fit.kHead}`);
  ok('kTail clamped <=3.0', fit.kTail<=3.0+1e-9, `${fit.kTail}`);
}

console.log('\nDirectional predict:');
{
  const seed={baselineSec:1100,kHead:0.8,kTail:0.3};
  const p0=predict(createModelState(),0.5,seed);
  ok('headwind seed slower', p0.predictedSec>1100 && near(p0.k,0.8,1e-9));
  const pt=predict(createModelState(),-0.5,seed);
  ok('tailwind seed faster', pt.predictedSec<1100 && near(pt.k,0.3,1e-9));
  ok('marked provisional when empty', p0.provisional===true);
}

console.log('\nOutlier flagging:');
{
  const rides=synth(1000,0.8,0.3,[-0.5,-0.3,0,0.2,0.4,0.5,-0.2,0.3]);
  const state=rebuildFromRides(rides,{halfLifeRides:1e9});
  const onPred=checkOutlier(state,0.4,1000*(1+0.8*0.4),{seed:{kHead:0.8,kTail:0.3}});
  ok('on-prediction not flagged', onPred.flagged===false);
  const wild=checkOutlier(state,0.4,3000,{seed:{kHead:0.8,kTail:0.3}});
  ok('wild ride flagged', wild.flagged===true);
  const green=checkOutlier(createModelState(),0.4,5000,{seed:{kHead:0.8,kTail:0.3}});
  ok('green model never flags', green.flagged===false);
}

console.log('\nConfidence levels:');
{
  let s=createModelState(); ok('provisional at 0', confidence(s).level==='provisional');
  for(let i=0;i<6;i++) s=updateModel(s,0.1*i-0.3,1000); ok('learning at 6', confidence(s).level==='learning');
  for(let i=0;i<12;i++) s=updateModel(s,0.1*(i%5)-0.2,1000); ok('good at 18', confidence(s).level==='good');
}

console.log('\nConfidence carries per-direction k-learning status:');
{
  // Empty: nothing learned.
  const c0=confidence(createModelState());
  ok('empty -> kLevel neither', c0.kLevel==='neither');
  ok('empty -> idHead/idTail false', c0.idHead===false && c0.idTail===false);
  ok('kLevel field always present', typeof c0.kLevel==='string');
  // Many headwind rides with spread -> head becomes identifiable, kLevel reflects it.
  let sh=createModelState();
  for(let i=0;i<20;i++) sh=updateModel(sh, 0.1+0.2*(i%5), 1000+50*(i%5)); // positive wind_factor spread (headwind)
  const ch=confidence(sh);
  ok('headwind spread -> idHead true', ch.idHead===true, JSON.stringify(ch));
  ok('kLevel one or both when a direction identified', ch.kLevel==='one'||ch.kLevel==='both');
}

console.log('\nOnline == rebuild:');
{
  const wfs=[-0.5,-0.2,0.1,0.3,-0.4,0.5,0.2,-0.1,0.6,-0.3];
  const rides=synth(1000,0.7,0.4,wfs);
  let online=createModelState({halfLifeRides:20});
  for(const r of rides) online=updateModel(online,r.windFactor,r.actualSec);
  const rebuilt=rebuildFromRides(rides,{halfLifeRides:20});
  const a=fitModel(online), b=fitModel(rebuilt);
  ok('baselines match', near(a.baselineSec,b.baselineSec,1e-6));
  ok('kHead match', near(a.kHead,b.kHead,1e-9));
  ok('kTail match', near(a.kTail,b.kTail,1e-9));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail?1:0);
