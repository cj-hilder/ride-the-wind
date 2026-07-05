import { solarTimes } from './src/lib/solar.js';

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => { if (cond) { pass++; console.log(`  PASS  ${name}`); } else { fail++; console.log(`  FAIL  ${name}${extra ? '  — ' + extra : ''}`); } };

// Format a UTC instant as NZST/NZDT local HH:MM for a rough human sanity read.
// Dunedin: NZST = UTC+12 (winter), NZDT = UTC+13 (summer, ~late Sep–early Apr).
const hhmm = (ms, offH) => {
  const d = new Date(ms + offH * 3600000);
  return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
};

const LAT = -45.87, LON = 170.50; // Dunedin

console.log('solarTimes (Dunedin):');
{
  // Midwinter: 21 Jun 2026. NZST (UTC+12). Sunrise ~08:20, sunset ~17:00 local.
  const win = solarTimes(LAT, LON, Date.UTC(2026, 5, 21, 0, 0));
  ok('midwinter returns instants', win.sunriseMs && win.sunsetMs, JSON.stringify(win));
  const wSr = hhmm(win.sunriseMs, 12), wSs = hhmm(win.sunsetMs, 12);
  ok('midwinter sunrise ~08:2x NZST', wSr >= '08:00' && wSr <= '08:40', wSr);
  ok('midwinter sunset ~17:0x NZST', wSs >= '16:45' && wSs <= '17:20', wSs);
  // day length short in winter (< 10 h)
  const wLenH = (win.sunsetMs - win.sunriseMs) / 3600000;
  ok('midwinter day length < 10 h', wLenH < 10, `${wLenH.toFixed(2)}h`);

  // Midsummer: 21 Dec 2026. NZDT (UTC+13). Sunrise ~05:45, sunset ~21:00 local.
  const sum = solarTimes(LAT, LON, Date.UTC(2026, 11, 21, 0, 0));
  const sSr = hhmm(sum.sunriseMs, 13), sSs = hhmm(sum.sunsetMs, 13);
  ok('midsummer sunrise ~05:4x NZDT', sSr >= '05:30' && sSr <= '06:10', sSr);
  ok('midsummer sunset ~21:1x–21:3x NZDT', sSs >= '21:05' && sSs <= '21:35', sSs);
  const sLenH = (sum.sunsetMs - sum.sunriseMs) / 3600000;
  ok('midsummer day length > 15 h', sLenH > 15, `${sLenH.toFixed(2)}h`);

  // sunrise is before sunset; both within the calendar day
  ok('sunrise before sunset', win.sunriseMs < win.sunsetMs && sum.sunriseMs < sum.sunsetMs);
  // REGRESSION: a morning departure at UTC+12 must have sunrise/sunset that
  // BRACKET the day correctly — earlier the UTC-day anchor picked the wrong day
  // and mornings read as pre-dawn until midday. An 08:30 NZST winter departure
  // (= 04 Jul 20:30 UTC) must fall AFTER that day's sunrise, not before it.
  const morn = Date.UTC(2026, 6, 4, 20, 30); // 08:30 NZST, 5 Jul
  const sMorn = solarTimes(LAT, LON, morn);
  ok('UTC+12 morning is after sunrise (not pre-dawn)', morn > sMorn.sunriseMs, `dep ${new Date(morn).toISOString()} sr ${new Date(sMorn.sunriseMs).toISOString()}`);
  ok('UTC+12 morning is before sunset', morn < sMorn.sunsetMs);
}

console.log('solarTimes (edge/guard cases):');
{
  ok('null lat → null', solarTimes(null, 170, Date.now()) === null);
  ok('bad date → null', solarTimes(-45, 170, NaN) === null);
  // High-arctic midsummer → polar day; midwinter → polar night.
  const arcticSummer = solarTimes(78, 15, Date.UTC(2026, 5, 21, 0, 0)); // Svalbard, Jun
  ok('arctic midsummer → polar day', arcticSummer.polar === 'day', JSON.stringify(arcticSummer));
  const arcticWinter = solarTimes(78, 15, Date.UTC(2026, 11, 21, 0, 0)); // Svalbard, Dec
  ok('arctic midwinter → polar night', arcticWinter.polar === 'night', JSON.stringify(arcticWinter));
  // Equator: ~12 h day, sunrise ~06:00 sunset ~18:00 local (UTC+0 at lon 0).
  const eq = solarTimes(0, 0, Date.UTC(2026, 2, 21, 0, 0)); // equinox
  const eqLenH = (eq.sunsetMs - eq.sunriseMs) / 3600000;
  ok('equator equinox ~12 h day', Math.abs(eqLenH - 12) < 0.3, `${eqLenH.toFixed(2)}h`);
}

console.log(`\n${pass} passed, ${fail} failed`);
