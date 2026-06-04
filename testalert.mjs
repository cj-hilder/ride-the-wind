import {
  evaluateAlert, arrivalOnDate,
  formatHHMM, atLocalTime, VERDICT, DEFAULT_THRESHOLD_MIN
} from './src/lib/alertEngine.js';

let pass=0,fail=0;
const ok=(n,c,d='')=>{ c?(pass++,console.log(`  PASS  ${n}`)):(fail++,console.log(`  FAIL  ${n}  ${d}`)); };

const sunday2100 = new Date(2026,4,31,21,0,0,0).getTime();

const route = {
  id:'r1', name:'Home -> Office',
  activeDays:['MO','TU','WE','TH','FR'],
  targetArrival:'08:45',
  arrivalOverrides:{ WE:'09:30' },
  alertThresholdMin:4,
};

const predFactory = (predictedSec, extra={}) => () =>
  ({ predictedSec, baselineSec:1500, k:1, provisional:false, windFactor:0.2, ...extra });

const onDay = (y,m,d,override) => arrivalOnDate(route, new Date(y,m,d,12,0).getTime(), override);

console.log('arrivalOnDate (Plan-tab day resolution; ignores activeDays/past):');
{
  const n = onDay(2026,5,1);
  ok('Monday resolves to 08:45', n.arrivalHHMM==='08:45' && n.weekday==='MO', `${n.arrivalHHMM} ${n.weekday}`);
  ok('arrivalMs matches 08:45 local', n.arrivalMs===atLocalTime(new Date(2026,5,1),'08:45'));
}
{
  const n = onDay(2026,5,3);
  ok('Wednesday uses override 09:30', n.weekday==='WE' && n.arrivalHHMM==='09:30', `${n.weekday} ${n.arrivalHHMM}`);
}
{
  const n = onDay(2026,5,6);
  ok('Saturday resolves despite inactive', n.weekday==='SA' && n.arrivalHHMM==='08:45', `${n.weekday} ${n.arrivalHHMM}`);
}
{
  const n = onDay(2026,5,1,'10:00');
  ok('explored override applied', n.arrivalHHMM==='10:00', n.arrivalHHMM);
}

console.log('\nVerdict branches at threshold boundary (threshold 4 min = 240s):');
const mon = onDay(2026,5,1);
{
  const v=evaluateAlert(route, predFactory(1800), {nowMs:sunday2100, fixedArrival:mon});
  ok('headwind when +5min', v.verdict===VERDICT.HEADWIND, v.verdict);
  ok('deltaMin = +5', v.deltaMin===5, `${v.deltaMin}`);
  ok('departure = 08:15', v.departureHHMM==='08:15', v.departureHHMM);
  ok('normal departure = 08:20', v.normalDepartureHHMM==='08:20', v.normalDepartureHHMM);
}
{
  const v=evaluateAlert(route, predFactory(1200), {nowMs:sunday2100, fixedArrival:mon});
  ok('tailwind when -5min', v.verdict===VERDICT.TAILWIND, v.verdict);
  ok('deltaMin = -5', v.deltaMin===-5, `${v.deltaMin}`);
}
{
  const v=evaluateAlert(route, predFactory(1620), {nowMs:sunday2100, fixedArrival:mon});
  ok('normal when +2min (< 4 threshold)', v.verdict===VERDICT.NORMAL, v.verdict);
}
{
  const v=evaluateAlert(route, predFactory(1740), {nowMs:sunday2100, fixedArrival:mon});
  ok('exactly at threshold stays normal', v.verdict===VERDICT.NORMAL, `${v.deltaSec}`);
  const v2=evaluateAlert(route, predFactory(1741), {nowMs:sunday2100, fixedArrival:mon});
  ok('just over threshold triggers', v2.verdict===VERDICT.HEADWIND);
}

console.log('\nVerdict carries the fields the Plan tab needs:');
{
  const v=evaluateAlert(route, predFactory(1800), {nowMs:sunday2100, fixedArrival:mon});
  ok('has departureMs', typeof v.departureMs==='number');
  ok('has arrivalHHMM', v.arrivalHHMM==='08:45', v.arrivalHHMM);
  ok('carries kHead/kTail fields', 'kHead' in v && 'kTail' in v);
  ok('no message field (scheduler removed)', !('message' in v));
}
{
  const v=evaluateAlert(route, predFactory(1800), {nowMs:sunday2100});
  ok('null without fixedArrival', v===null);
}

console.log('\nDefault threshold fallback:');
{
  const noThresh={...route}; delete noThresh.alertThresholdMin;
  const v=evaluateAlert(noThresh, predFactory(1680), {nowMs:sunday2100, fixedArrival:mon});
  ok(`uses default ${DEFAULT_THRESHOLD_MIN}min`, v.thresholdMin===DEFAULT_THRESHOLD_MIN && v.verdict===VERDICT.NORMAL, `${v.thresholdMin} ${v.verdict}`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail?1:0);
