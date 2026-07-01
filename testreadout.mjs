import {
  speedToAngle, polarPoint, clockAngles, arrivalBezel, expectedArrivalMs,
  averageSpeedKmh, emaStep, estimatedDistanceM,
  SPEEDO_START_DEG, SPEEDO_SWEEP_DEG, SPEEDO_MAX_KMH, ARRIVAL_LIVE_AFTER_M,
} from './src/lib/rideReadout.js';

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => { if (cond) { pass++; console.log(`  PASS  ${name}`); } else { fail++; console.log(`  FAIL  ${name}  ${extra}`); } };
const near = (a, b, e = 1e-6) => Math.abs(a - b) <= e;

console.log('speedToAngle:');
ok('0 km/h → start (225°)', near(speedToAngle(0), SPEEDO_START_DEG));
ok('max → start+sweep (495°≡135°)', near(speedToAngle(40), SPEEDO_START_DEG + SPEEDO_SWEEP_DEG));
ok('20 (mid) → straight up (360°≡0)', near(speedToAngle(20), 225 + 135));
ok('pegs at max above 40', near(speedToAngle(55), speedToAngle(40)));
ok('clamps negative to 0', near(speedToAngle(-5), SPEEDO_START_DEG));

console.log('\npolarPoint (0°=up, clockwise):');
{
  const up = polarPoint(0, 0, 10, 0);
  ok('0° is straight up (y negative)', near(up.x, 0, 1e-9) && near(up.y, -10, 1e-9), `${up.x},${up.y}`);
  const right = polarPoint(0, 0, 10, 90);
  ok('90° is to the right', near(right.x, 10, 1e-9) && near(right.y, 0, 1e-9), `${right.x},${right.y}`);
}

console.log('\nclockAngles:');
{
  const t = new Date(2026, 0, 1, 3, 0, 0).getTime(); // 03:00
  const a = clockAngles(t);
  ok('3:00 hour hand at 90°', near(a.hour, 90));
  ok('3:00 minute hand at 0°', near(a.minute, 0));
  const t2 = new Date(2026, 0, 1, 6, 30, 0).getTime(); // 06:30
  const a2 = clockAngles(t2);
  ok('6:30 hour hand at 195°', near(a2.hour, 195));
  ok('6:30 minute hand at 180°', near(a2.minute, 180));
}

console.log('\narrivalBezel (always shows minute; grey ≥1h, amber <1h):');
{
  const now = new Date(2026, 0, 1, 8, 0, 0).getTime();
  const in25 = now + 25 * 60000; // arrive 08:25 → minute 25 → 150°, imminent
  const b25 = arrivalBezel(now, in25);
  ok('25 min away → marker at 150°, imminent', near(b25.angle, 150) && b25.imminent === true);
  const in90 = now + 90 * 60000; // 09:30 → minute 30 → 180°, not imminent
  const b90 = arrivalBezel(now, in90);
  ok('90 min away → still shows (180°), not imminent', near(b90.angle, 180) && b90.imminent === false);
  ok('null arrival → null', arrivalBezel(now, null) === null);
  // boundary: exactly 60 min away is NOT imminent (< 60 required)
  const b60 = arrivalBezel(now, now + 60 * 60000);
  ok('exactly 60 min → not imminent', b60.imminent === false);
  // at/just after arrival → still returns angle, imminent
  const bnow = arrivalBezel(now, now);
  ok('at arrival still returns angle, imminent', bnow != null && bnow.imminent === true);
}

console.log('\nexpectedArrivalMs:');
{
  const now = 1_000_000_000_000;
  // before 1 km of REAL gps distance: forecast estimate
  const a = expectedArrivalMs({ nowMs: now, estDistanceM: 200, gpsDistanceM: 200, routeTotalM: 5000, paceMps: 5, forecastRemainingSec: 1200 });
  ok('before 1km uses forecast', a === now + 1200 * 1000, `${a}`);
  // after 1 km: remaining (from est) / pace. est 2000 of 5000 → remaining 3000; pace 5 → 600s
  const b = expectedArrivalMs({ nowMs: now, estDistanceM: 2000, gpsDistanceM: 2000, routeTotalM: 5000, paceMps: 5, forecastRemainingSec: 9999 });
  ok('after 1km uses remaining/pace', b === now + 600 * 1000, `${b}`);
  // DETOUR case: gps distance large (rode far) but est distance small (clamped);
  // pace is healthy → arrival stays sensible, NOT blown out.
  const detour = expectedArrivalMs({ nowMs: now, estDistanceM: 500, gpsDistanceM: 3000, routeTotalM: 5000, paceMps: 5, forecastRemainingSec: 9999 });
  // remaining = 4500 / 5 = 900s — reasonable, not hours
  ok('detour: healthy pace keeps arrival sensible', detour === now + 900 * 1000, `${detour}`);
  ok('no total → null', expectedArrivalMs({ nowMs: now, estDistanceM: 2000, gpsDistanceM: 2000, routeTotalM: null, paceMps: 5 }) === null);
  ok('zero pace after 1km → null', expectedArrivalMs({ nowMs: now, estDistanceM: 2000, gpsDistanceM: 2000, routeTotalM: 5000, paceMps: 0 }) === null);
  // overshot est → remaining 0 → arrival now
  const c = expectedArrivalMs({ nowMs: now, estDistanceM: 5000, gpsDistanceM: 6000, routeTotalM: 5000, paceMps: 5 });
  ok('reached end → arrival now', c === now, `${c}`);
}

console.log('\nemaStep (time-aware):');
{
  ok('seeds on null prev', emaStep(null, 10, 1000, 5000) === 10);
  ok('zero dt → unchanged', emaStep(5, 20, 0, 5000) === 5);
  // one time-constant of elapsed → ~63% toward the sample
  const oneTau = emaStep(0, 10, 5000, 5000);
  ok('Δt = τ → ~63% toward sample', Math.abs(oneTau - 6.32) < 0.05, `${oneTau}`);
  // small Δt relative to τ → barely moves
  const small = emaStep(10, 20, 100, 45 * 60000);
  ok('Δt ≪ τ → barely moves', Math.abs(small - 10) < 0.01, `${small}`);
  // large Δt relative to τ → nearly reaches sample
  const big = emaStep(0, 10, 60000, 5000);
  ok('Δt ≫ τ → nearly reaches sample', big > 9.9, `${big}`);
}

console.log('\naverageSpeedKmh:');
ok('5000 m / 1000 s = 18 km/h', near(averageSpeedKmh(5000, 1000), 18));
ok('zero time → 0', averageSpeedKmh(100, 0) === 0);

console.log('\nestimatedDistanceM (GPS clamped by route − line-of-sight):');
{
  const total = 10000;
  // straight-line 2km from end → can have covered at most 8km
  ok('detour: GPS 9km but 2km from end → capped 8km', estimatedDistanceM(9000, total, 2000) === 8000);
  // GPS less than geometric cap → GPS wins (early on a looping route)
  ok('GPS 3km, 2km from end (cap 8km) → 3km', estimatedDistanceM(3000, total, 2000) === 3000);
  // at the end → full route
  ok('at end (los 0) → full route', estimatedDistanceM(12000, total, 0) === total);
  // line-of-sight to end exceeds route length (you're behind the start / early
  // GPS noise) → geometric term is negative → estimate clamps to 0.
  ok('los > route → clamps to 0', estimatedDistanceM(50, total, 12000) === 0);
  // missing inputs → GPS unchanged
  ok('no total → GPS unchanged', estimatedDistanceM(1234, null, 500) === 1234);
  ok('never exceeds route', estimatedDistanceM(99999, total, 100) <= total);
}

console.log(`\n${pass} passed, ${fail} failed`);
