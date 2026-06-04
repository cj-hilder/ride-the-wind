// Weighted-member fold-in: the deterministic forecast is included in the
// ensemble as one weighted member, so center and spread emerge from ONE
// population. Key properties: agreement tightens the short-lead band,
// disagreement widens it (honest), and tomorrow is pure ensemble.
import { weightedPercentile } from './src/lib/prediction.js';

let pass=0,fail=0; const ok=(n,c,d='')=>{c?(pass++,console.log('  PASS '+n)):(fail++,console.log('  FAIL '+n+'  '+d));};

console.log('weightedPercentile:');
const eq=[{t:10,w:1},{t:20,w:1},{t:30,w:1},{t:40,w:1},{t:50,w:1}];
ok('equal-weight median = 30', Math.abs(weightedPercentile(eq,50,5)-30)<0.01);
ok('lo<med<hi', weightedPercentile(eq,10,5)<weightedPercentile(eq,50,5) && weightedPercentile(eq,50,5)<weightedPercentile(eq,90,5));
const heavy=[{t:10,w:1},{t:30,w:20},{t:50,w:1}];
ok('heavy central weight pins median', Math.abs(weightedPercentile(heavy,50,22)-30)<1.5);

console.log('\nfold-in spread behaviour (band width via percentiles):');
// model the population the way predictEnsembleRange does: ensemble members + weighted det
const ens = []; for(let i=0;i<51;i++) ens.push({t: 40 + (i-25)*0.4, w:1}); // ~30..50, median 40
const width = (samples,tot)=> weightedPercentile([...samples].sort((a,b)=>a.t-b.t),90,tot) - weightedPercentile([...samples].sort((a,b)=>a.t-b.t),10,tot);
const ensTot=51, ensW=width(ens,ensTot);
// det AGREES (at 40), weight M/2=25
const agree=[...ens,{t:40,w:25}], agreeW=width(agree,76);
ok('agreement tightens band vs pure ensemble', agreeW < ensW, `${agreeW.toFixed(1)} < ${ensW.toFixed(1)}`);
// det DISAGREES (at 20, far below), weight 25
const disagree=[...ens,{t:20,w:25}], disW=width(disagree,76);
ok('disagreement widens band vs pure ensemble', disW > ensW, `${disW.toFixed(1)} > ${ensW.toFixed(1)}`);
ok('disagreement pulls median below ensemble median', weightedPercentile([...disagree].sort((a,b)=>a.t-b.t),50,76) < 40);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail?1:0);
