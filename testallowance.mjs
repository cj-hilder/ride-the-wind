import { allowanceSummary, pruneUsage, OM_WINDOWS } from './src/lib/allowance.js';
import { fetchForecast, parseRateLimitHeaders } from './src/lib/windModel.js';

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => { if (cond) { pass++; console.log(`  PASS  ${name}`); } else { fail++; console.log(`  FAIL  ${name}  ${extra}`); } };
const T = 1_800_000_000_000;
const H = 3600e3;

console.log('allowanceSummary:');
{
  ok('empty → 0%', allowanceSummary([], null, T).pct === 0);
  // 2,500 calls spread over the last 20 h (none in the last hour) → day 25%.
  const e = Array.from({ length: 100 }, (_, i) => ({ at: T - 2 * H - i * 600e3, cost: 25 }));
  const s = allowanceSummary(e, null, T);
  ok('day window = 25%', s.windows.day === 25 && s.window === 'day' && s.pct === 25, JSON.stringify(s));
  // Heavy last hour: 4,000 in the last hour → hour 80% beats day 40%.
  const e2 = Array.from({ length: 40 }, (_, i) => ({ at: T - i * 60e3, cost: 100 }));
  const s2 = allowanceSummary(e2, null, T);
  ok('reports the tightest window (hour 80%)', s2.window === 'hour' && s2.pct === 80, JSON.stringify(s2));
  // Server-reported minute window (other devices on the IP) overrides when higher.
  const s3 = allowanceSummary([], { limit: 600, remaining: 150, windowSec: 60, at: T - 10e3 }, T);
  ok('server minute window counted (75%)', s3.window === 'minute' && s3.pct === 75, JSON.stringify(s3));
  const s4 = allowanceSummary([], { limit: 600, remaining: 150, windowSec: 60, at: T - 120e3 }, T);
  ok('expired server window ignored', s4.pct === 0);
  ok('entries older than a day ignored', allowanceSummary([{ at: T - 25 * H, cost: 9999 }], null, T).pct === 0);
  ok('pruneUsage drops old and bad entries', pruneUsage([{ at: T - 25 * H, cost: 1 }, { at: T - H, cost: 1 }, { at: T, cost: 0 }, null], T).length === 1);
  ok('published limits: 600/min, 5000/h, 10000/day', OM_WINDOWS.map((w) => w.limit).join() === '600,5000,10000');
}

console.log('\nrate-limit headers + 429 handling:');
const hdrs = (o) => ({ get: (k) => (k.toLowerCase() in o ? String(o[k.toLowerCase()]) : null) });
const base = Math.floor(Date.now() / 1000);
const good = { hourly: { time: [base, base + 3600], wind_speed_10m: [10, 10], wind_direction_10m: [270, 270], wind_gusts_10m: [15, 15], temperature_2m: [12, 12], precipitation: [0, 0], precipitation_probability: [0, 0], snowfall: [0, 0], weather_code: [0, 0] } };
{
  const u = parseRateLimitHeaders({ status: 200, headers: hdrs({ 'x-ratelimit-cost': '15.3', 'x-ratelimit-limit': '600.0', 'x-ratelimit-remaining': '584.7', 'x-ratelimit-window': '60', 'x-ratelimit-reset': '1795573258' }) }, T);
  ok('parses cost/limit/remaining/window/reset', u.cost === 15.3 && u.limit === 600 && u.remaining === 584.7 && u.windowSec === 60 && u.resetMs === 1795573258000);
  ok('no headers → null', parseRateLimitHeaders({ status: 200, headers: hdrs({}) }) === null);
}
{
  const seen = [];
  const f = async () => ({ ok: true, status: 200, headers: hdrs({ 'x-ratelimit-cost': '1.0', 'x-ratelimit-limit': '600', 'x-ratelimit-remaining': '599' }), json: async () => good });
  await fetchForecast(0, 0, { fetchImpl: f, onUsage: (u) => seen.push(u) });
  ok('onUsage reports each response', seen.length === 1 && seen[0].cost === 1);
}
{
  // Allowance used up: 429 with a long Retry-After → no retry, RateLimitError.
  let calls = 0, err = null;
  const f = async () => { calls++; return { ok: false, status: 429, headers: hdrs({ 'retry-after': '1800' }), json: async () => ({}) }; };
  try { await fetchForecast(0, 0, { fetchImpl: f, retryBackoffMs: 1 }); } catch (e) { err = e; }
  ok('used-up allowance is not retried', calls === 1, `calls=${calls}`);
  ok('throws RateLimitError with resume time', err && err.rateLimited && err.until > Date.now() + 1700e3, `${err && err.until}`);
}
{
  // Momentary burst: 429 with Retry-After 1 s → one retry.
  let calls = 0;
  const f = async () => { calls++; return calls === 1 ? { ok: false, status: 429, headers: hdrs({ 'retry-after': '0' }), json: async () => ({}) } : { ok: true, status: 200, headers: hdrs({}), json: async () => good }; };
  const s = await fetchForecast(0, 0, { fetchImpl: f, retryBackoffMs: 1 });
  ok('short burst 429 retried once and succeeds', Array.isArray(s) && calls === 2, `calls=${calls}`);
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
