import { temperatureToken, rainToken, sideWindToken, whatToExpect, sampleConditions } from './src/lib/whatToExpect.js';
let pass=0,fail=0;
const ok=(n,c,d='')=>{ c?(pass++,console.log(`  PASS  ${n}`)):(fail++,console.log(`  FAIL  ${n}  ${d}`)); };

console.log('Temperature:');
ok('min when all mild', temperatureToken([8,6,9,7])==='6°C', temperatureToken([8,6,9,7]));
ok('max when hot (>=26)', temperatureToken([22,27,24])==='27°C', temperatureToken([22,27,24]));
ok('rounds to integer', temperatureToken([4.4,4.6])==='4°C', temperatureToken([4.4,4.6]));
ok('null when empty', temperatureToken([])===null);

console.log('\nRain (time-weighted mm/h, gated at 25% prob):');
const w=(rate)=>[{rate,t:600}]; // single 10-min segment
ok('blank when prob below gate', rainToken(5,[10])===null);
ok('blank when dry', rainToken(0,[90])===null);
ok('maybe wet (0.05-0.5)', rainToken(0.2,[80])==='maybe wet', rainToken(0.2,[80]));
ok('wet (0.5-2)', rainToken(1,[80])==='wet', rainToken(1,[80]));
ok('very wet (>=2)', rainToken(3,[80])==='very wet', rainToken(3,[80]));
ok('boundary 0.05 -> maybe', rainToken(0.05,[80])==='maybe wet');
ok('just under 0.05 -> blank', rainToken(0.04,[80])===null);
ok('prob just over 15 gate counts', rainToken(1,[16])==='wet', rainToken(1,[16]));

console.log('\nSide wind (time-weighted |crosswind| km/h):');
const cw=(v)=>[{v,t:600}];
ok('blank under 15', sideWindToken(cw(10))===null);
ok('side winds 15-30', sideWindToken(cw(20))==='side winds', sideWindToken(cw(20)));
ok('strong over 30', sideWindToken(cw(35))==='strong side winds');
ok('boundary 15 -> side', sideWindToken(cw(15))==='side winds');

console.log('\nCrosswind geometry (sampleConditions):');
{
  // route heading east (bearing 90); wind from north (fromDeg 0) is pure crosswind
  const segs=[{lat:0,lon:0,bearing:90}];
  const times=[600];
  const windFn=()=>({speed:25,fromDeg:0,tempC:5,precipMm:0,precipProb:0});
  const c=sampleConditions({segments:segs,times,windFn,departMs:0});
  ok('north wind on east route = full crosswind ~25', Math.abs(c.crosswinds[0].v-25)<0.01, `${c.crosswinds[0].v.toFixed(2)}`);
  // wind from east (90) on east route = headwind, zero crosswind
  const windFn2=()=>({speed:25,fromDeg:90,tempC:5,precipMm:0,precipProb:0});
  const c2=sampleConditions({segments:segs,times,windFn:windFn2,departMs:0});
  ok('head/tail wind = ~0 crosswind', Math.abs(c2.crosswinds[0].v)<0.01, `${c2.crosswinds[0].v.toFixed(2)}`);
}

console.log('\nAssembly:');
{
  const segs=[{lat:0,lon:0,bearing:90},{lat:0,lon:0.01,bearing:90}];
  const times=[600,600];
  const windFn=()=>({speed:22,fromDeg:0,tempC:3,precipMm:3,precipProb:80}); // crosswind, wet, cold
  const r=whatToExpect({segments:segs,times,windFn,departMs:0});
  ok('full line assembles', r.line==='3°C · wet · side winds', r.line);
  // calm dry mild -> just temp
  const windFn2=()=>({speed:5,fromDeg:90,tempC:14,precipMm:0,precipProb:0});
  const r2=whatToExpect({segments:segs,times,windFn:windFn2,departMs:0});
  ok('calm dry -> temp only', r2.line==='14°C', r2.line);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail?1:0);
