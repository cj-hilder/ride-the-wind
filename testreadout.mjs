import {
  speedToAngle, polarPoint, clockAngles, arrivalBezelAngle, expectedArrivalMs,
  averageSpeedKmh, smoothedSpeedKmh, progressBar,
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

console.log('\narrivalBezelAngle:');
{
  const now = new Date(2026, 0, 1, 8, 0, 0).getTime();
  const in25 = now + 25 * 60000; // arrive 08:25 → minute 25 → 150°
  ok('25 min away → marker at 150°', near(arrivalBezelAngle(now, in25), 150));
  const in90 = now + 90 * 60000;
  ok('90 min away → null (beyond window)', arrivalBezelAngle(now, in90) === null);
  ok('null arrival → null', arrivalBezelAngle(now, null) === null);
  // at/just after arrival, still returns an angle (caller keeps it visible)
  ok('at arrival still returns angle', arrivalBezelAngle(now, now) != null);
}

console.log('\nexpectedArrivalMs:');
{
  const now = 1_000_000_000_000;
  // before 1 km: forecast estimate
  const a = expectedArrivalMs({ nowMs: now, distanceM: 200, routeTotalM: 5000, movingSec: 60, forecastRemainingSec: 1200 });
  ok('before 1km uses forecast', a === now + 1200 * 1000, `${a}`);
  // after 1 km: live remaining/avg
  // distance 2000 of 5000 → remaining 3000; moving 400s → avg 5 m/s → 600s
  const b = expectedArrivalMs({ nowMs: now, distanceM: 2000, routeTotalM: 5000, movingSec: 400, forecastRemainingSec: 9999 });
  ok('after 1km uses live estimate', b === now + 600 * 1000, `${b}`);
  // no route total (new recording) → null
  ok('no total → null', expectedArrivalMs({ nowMs: now, distanceM: 2000, routeTotalM: null, movingSec: 400 }) === null);
  // past the end → remaining 0 → arrival ~ now
  const c = expectedArrivalMs({ nowMs: now, distanceM: 6000, routeTotalM: 5000, movingSec: 1000, forecastRemainingSec: 0 });
  ok('overshot → arrival now', c === now, `${c}`);
}

console.log('\naverageSpeedKmh:');
ok('5000 m / 1000 s = 18 km/h', near(averageSpeedKmh(5000, 1000), 18));
ok('zero time → 0', averageSpeedKmh(100, 0) === 0);

console.log('\nsmoothedSpeedKmh:');
{
  const now = 100000;
  // two samples 5s apart, 50 m → 10 m/s → 36 km/h
  const s = [{ t: now - 5000, distanceM: 0 }, { t: now, distanceM: 50 }];
  ok('50m in 5s → 36 km/h', near(smoothedSpeedKmh(s, now), 36));
  ok('one sample → 0', smoothedSpeedKmh([{ t: now, distanceM: 0 }], now) === 0);
  // old samples outside window fall back to last two
  const s2 = [{ t: now - 60000, distanceM: 0 }, { t: now - 2000, distanceM: 10 }, { t: now, distanceM: 30 }];
  ok('uses in-window samples (20m/2s=36)', near(smoothedSpeedKmh(s2, now), 36));
}

console.log('\nprogressBar:');
{
  const p50 = progressBar(2500, 5000);
  ok('50% → amber .5, no red', near(p50.amberFill, 0.5) && p50.redFill === 0);
  const p100 = progressBar(5000, 5000);
  ok('100% → amber full, no red', near(p100.amberFill, 1) && p100.redFill === 0);
  const p150 = progressBar(7500, 5000);
  ok('150% → amber full, red .5', near(p150.amberFill, 1) && near(p150.redFill, 0.5));
  const p200 = progressBar(10000, 5000);
  ok('200% → red capped at full', near(p200.redFill, 1));
  const p250 = progressBar(12500, 5000);
  ok('250% → red still capped', near(p250.redFill, 1));
  ok('no total → zeros', progressBar(100, 0).amberFill === 0);
}

console.log(`\n${pass} passed, ${fail} failed`);
