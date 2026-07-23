import { fetchForecast } from './src/lib/windModel.js';
let pass=0,fail=0;
const ok=(n,c,d='')=>{ c?(pass++,console.log(`  PASS  ${n}`)):(fail++,console.log(`  FAIL  ${n} ${d}`)); };

// Minimal valid Open-Meteo shape so parseForecast succeeds on the retry.
const base=Math.floor(Date.now()/1000);
const good={ hourly:{ time:[base,base+3600], wind_speed_10m:[10,10], wind_direction_10m:[270,270], wind_gusts_10m:[15,15], temperature_2m:[12,12], precipitation:[0,0], precipitation_probability:[0,0], snowfall:[0,0], weather_code:[0,0] } };
const resp=(status,body)=>({ ok: status>=200&&status<300, status, json: async()=>body });

console.log('fetchForecast retry on transient failures:');
{
  // 429 once, then 200 → should succeed via the automatic retry.
  let calls=0;
  const f=async()=>{ calls++; return calls===1 ? resp(429,{}) : resp(200,good); };
  const series=await fetchForecast(0,0,{ fetchImpl:f, retryBackoffMs:1 });
  ok('retries once after 429 then succeeds', Array.isArray(series) && series.length===2, `calls=${calls}`);
  ok('made exactly 2 calls', calls===2, `calls=${calls}`);
}
{
  // network error once, then 200 → retry recovers.
  let calls=0;
  const f=async()=>{ calls++; if(calls===1) throw new Error('network'); return resp(200,good); };
  const series=await fetchForecast(0,0,{ fetchImpl:f, retryBackoffMs:1 });
  ok('retries once after network error', Array.isArray(series) && calls===2, `calls=${calls}`);
}
{
  // persistent 429 → still throws after the single retry (no infinite loop).
  let calls=0;
  const f=async()=>{ calls++; return resp(429,{}); };
  let threw=false;
  try { await fetchForecast(0,0,{ fetchImpl:f, retryBackoffMs:1 }); } catch { threw=true; }
  ok('persistent 429 throws after one retry', threw && calls===2, `threw=${threw} calls=${calls}`);
}
{
  // non-transient 400 → no retry wasted.
  let calls=0;
  const f=async()=>{ calls++; return resp(400,{}); };
  let threw=false;
  try { await fetchForecast(0,0,{ fetchImpl:f, retryBackoffMs:1 }); } catch { threw=true; }
  ok('non-transient 400 does NOT retry', threw && calls===1, `threw=${threw} calls=${calls}`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail?1:0);
