import { fetchForecast, fetchEnsemble, recordForecastBackoffMs, RECORD_FORECAST_BACKOFF_MAX_MS } from './src/lib/windModel.js';
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


console.log('\nfetch time limit (stalled connections):');
{
  // First attempt stalls forever (dead pooled connection); retry answers.
  let calls=0, aborted=false;
  const f=(url, init)=>{ calls++;
    if(calls===1) return new Promise((_, rej)=>{ init?.signal?.addEventListener('abort', ()=>{ aborted=true; rej(new Error('AbortError')); }); });
    return Promise.resolve(resp(200,good)); };
  const t0=Date.now();
  const series=await fetchForecast(0,0,{ fetchImpl:f, retryBackoffMs:1, timeoutMs:50 });
  ok('stalled request times out and the retry succeeds', Array.isArray(series) && calls===2, `calls=${calls}`);
  ok('stalled request is aborted', aborted);
  ok('recovers quickly (not waiting for the OS)', Date.now()-t0 < 1000, `${Date.now()-t0} ms`);
}
{
  // A fetch that ignores the AbortSignal still times out (race).
  let calls=0;
  const f=()=>{ calls++; return new Promise(()=>{}); };
  let err=null;
  try { await fetchForecast(0,0,{ fetchImpl:f, retryBackoffMs:1, timeoutMs:30 }); } catch(e){ err=e; }
  ok('every attempt stalls → throws a timeout error after 2 retries', err && /timed out/.test(err.message) && calls===3, `${err && err.message} calls=${calls}`);
}
{
  // Body stalls after headers: the limit covers the whole attempt.
  let calls=0;
  const f=()=>{ calls++; return Promise.resolve(calls===1 ? { ok:true, status:200, json:()=>new Promise(()=>{}) } : resp(200,good)); };
  const series=await fetchForecast(0,0,{ fetchImpl:f, retryBackoffMs:1, timeoutMs:30 });
  ok('stalled body read also times out and retries', Array.isArray(series) && calls===2, `calls=${calls}`);
}
{
  // Ensemble gets the same treatment.
  let calls=0;
  const f=(url, init)=>{ calls++; return calls===1 ? new Promise(()=>{}) : Promise.resolve(resp(200,{hourly:{time:[base],wind_speed_10m_member01:[5],wind_direction_10m_member01:[90]}})); };
  let res=null, err=null;
  try { res=await fetchEnsemble(0,0,{ fetchImpl:f, timeoutMs:30, retryBackoffMs:1 }); } catch(e){ err=e; }
  ok('ensemble stall times out and retries', calls===2 && !err, `${err && err.message} calls=${calls}`);
}

{
  // Two dead pooled connections in a row, then a live one: still succeeds.
  let calls=0;
  const f=()=>{ calls++; return calls<=2 ? new Promise(()=>{}) : Promise.resolve(resp(200,good)); };
  const series=await fetchForecast(0,0,{ fetchImpl:f, retryBackoffMs:1, timeoutMs:30 });
  ok('two stale connections then a live one → succeeds on 3rd attempt', Array.isArray(series) && calls===3, `calls=${calls}`);
}
{
  // 429 still gets only ONE retry (more would only add load on a rate limit).
  let calls=0;
  const f=async()=>{ calls++; return resp(503,{}); };
  let threw=false;
  try { await fetchForecast(0,0,{ fetchImpl:f, retryBackoffMs:1 }); } catch { threw=true; }
  ok('persistent 5xx throws after one retry', threw && calls===2, `calls=${calls}`);
}
{
  // The response limit is short but the download limit is separate: a slow
  // body that arrives within its own limit is accepted.
  const { FETCH_HEADER_TIMEOUT_MS, FETCH_BODY_TIMEOUT_MS, ENSEMBLE_BODY_TIMEOUT_MS } = await import('./src/lib/windModel.js');
  ok('first-response limit is 5 s', FETCH_HEADER_TIMEOUT_MS===5000);
  ok('download limits are longer than the response limit', FETCH_BODY_TIMEOUT_MS>FETCH_HEADER_TIMEOUT_MS && ENSEMBLE_BODY_TIMEOUT_MS>FETCH_BODY_TIMEOUT_MS);
}

console.log('\nrecording forecast backoff:');
ok('first failure waits 30 s', recordForecastBackoffMs(1)===30000);
ok('doubles per failure', recordForecastBackoffMs(2)===60000 && recordForecastBackoffMs(3)===120000);
ok('capped at 5 min', recordForecastBackoffMs(10)===RECORD_FORECAST_BACKOFF_MAX_MS);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail?1:0);
