import {
  speedToAngle, polarPoint, clockAngles, arrivalBezel, expectedArrivalMs,
  averageSpeedKmh, emaStep, routePolyline, projectToRoute, OFF_ROUTE_M,
  needleTauMs, NEEDLE_TAU_MIN_MS, NEEDLE_TAU_MAX_MS, NEEDLE_ACC_REF_M,
  SPEEDO_START_DEG, SPEEDO_SWEEP_DEG, SPEEDO_MAX_KMH,
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
  // hoursAway: floor(minsAway/60), drives grey overlay (≥1) and hours integer (≥2)
  ok('25 min away → hoursAway 0', arrivalBezel(now, now + 25*60000).hoursAway === 0);
  ok('90 min away → hoursAway 1 (grey, no number)', arrivalBezel(now, now + 90*60000).hoursAway === 1);
  ok('150 min away → hoursAway 2 (grey + "2")', arrivalBezel(now, now + 150*60000).hoursAway === 2);
  ok('exactly 120 min → hoursAway 2', arrivalBezel(now, now + 120*60000).hoursAway === 2);
  ok('at arrival → hoursAway 0', bnow.hoursAway === 0);
}

console.log('\nexpectedArrivalMs (single rule: remaining ÷ seeded pace):');
{
  const now = 1_000_000_000_000;
  // With a valid pace, ALWAYS remaining/pace — no 1 km switch. Pace is seeded at
  // ride start with the predicted pace and drifts to actual, so it's valid from
  // the first fix. est 200 of 5000 → remaining 4800; pace 5 → 960 s.
  const a = expectedArrivalMs({ nowMs: now, estDistanceM: 200, routeTotalM: 5000, paceMps: 5 });
  ok('early: remaining/pace (no forecast switch)', a === now + 960 * 1000, `${a}`);
  // advancing shortens remaining: 2000 of 5000 → 3000 → 600 s
  const b = expectedArrivalMs({ nowMs: now, estDistanceM: 2000, routeTotalM: 5000, paceMps: 5 });
  ok('advancing shortens arrival', b === now + 600 * 1000, `${b}`);
  // pace is used even when forecast/baseline present (they're fallback only)
  const a4 = expectedArrivalMs({ nowMs: now, estDistanceM: 0, routeTotalM: 5000, paceMps: 5, forecastRemainingSec: 9999, baselineRemainingSec: 8888 });
  ok('pace beats forecast/baseline when present', a4 === now + 1000 * 1000, `${a4}`);
  // DETOUR: est distance small (clamped) but pace healthy → arrival sensible.
  const detour = expectedArrivalMs({ nowMs: now, estDistanceM: 500, routeTotalM: 5000, paceMps: 5 });
  ok('detour: healthy pace keeps arrival sensible', detour === now + 900 * 1000, `${detour}`);
  // FALLBACK: no pace yet → progress-scaled forecast (rare; EMA seeded at start).
  const f = expectedArrivalMs({ nowMs: now, estDistanceM: 200, routeTotalM: 5000, paceMps: null, forecastRemainingSec: 1200 });
  ok('no pace → progress-scaled forecast fallback', f === now + 1152 * 1000, `${f}`);
  const f2 = expectedArrivalMs({ nowMs: now, estDistanceM: 500, routeTotalM: 5000, paceMps: 0, baselineRemainingSec: 1000 });
  ok('no pace → baseline fallback when no forecast', f2 === now + 900 * 1000, `${f2}`);
  ok('no pace and no estimate → null', expectedArrivalMs({ nowMs: now, estDistanceM: 200, routeTotalM: 5000, paceMps: 0 }) === null);
  ok('no total → null', expectedArrivalMs({ nowMs: now, estDistanceM: 2000, routeTotalM: null, paceMps: 5 }) === null);
  // overshot est → remaining 0 → arrival now
  const c = expectedArrivalMs({ nowMs: now, estDistanceM: 5000, routeTotalM: 5000, paceMps: 5 });
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

console.log('\nroutePolyline + projectToRoute (along-route projection):');
{
  // A simple ~east-west route near the equator for easy geometry. Two segments
  // of ~1 km each along a line of latitude (lon increases). At the equator,
  // 1 deg lon ≈ 111320 m, so ~0.008983 deg ≈ 1000 m.
  const dLon = 1000 / 111320;
  const route = {
    segments: [
      { lat: 0, lon: 0, distance: 1000 },
      { lat: 0, lon: dLon, distance: 1000 },
    ],
    endRegion: { lat: 0, lon: 2 * dLon },
    totalDistance: 2000,
  };
  const poly = routePolyline(route);
  ok('polyline has 3 points', poly.length === 3);
  ok('cumulative distances 0/1000/2000', poly[0].cumM === 0 && Math.abs(poly[1].cumM - 1000) < 1 && Math.abs(poly[2].cumM - 2000) < 1);

  // A fix exactly at the midpoint of segment 1 → alongM ≈ 500
  const mid = projectToRoute({ lat: 0, lon: dLon / 2 }, poly, null);
  ok('midpoint of seg1 → ~500 m along', !mid.offRoute && Math.abs(mid.alongM - 500) < 5, `${mid.alongM}`);

  // A fix at the start → ~0
  const startP = projectToRoute({ lat: 0, lon: 0 }, poly, null);
  ok('start → ~0 along', Math.abs(startP.alongM) < 5 && !startP.offRoute);

  // A fix near the end → ~2000
  const endP = projectToRoute({ lat: 0, lon: 2 * dLon }, poly, null);
  ok('end → ~2000 along', Math.abs(endP.alongM - 2000) < 5, `${endP.alongM}`);

  // A fix far off the route (well beyond OFF_ROUTE_M perpendicular) → offRoute,
  // alongM held at the supplied lastAlongM, and offRouteM ≈ the stray distance.
  const off = projectToRoute({ lat: 0.01, lon: dLon / 2 }, poly, 500); // ~1.1 km north
  ok('far off route → offRoute, holds lastAlong', off.offRoute && off.alongM === 500, `${JSON.stringify(off)}`);
  ok('far off route → offRouteM ≈ 1.1 km', off.offRouteM > 1000 && off.offRouteM < 1200, `${off.offRouteM}`);
  // on-route fix reports a small offRouteM
  const onr = projectToRoute({ lat: 0, lon: dLon / 2 }, poly, null);
  ok('on route → small offRouteM', onr.offRouteM < 5, `${onr.offRouteM}`);

  // Continuity: a fix equidistant-ish is disambiguated by lastAlongM. Place a
  // fix at seg-boundary area and check it prefers near the hint.
  const cont = projectToRoute({ lat: 0, lon: dLon }, poly, 950);
  ok('continuity picks near hint (~1000)', Math.abs(cont.alongM - 1000) < 5, `${cont.alongM}`);

  // Gap self-heal: no hint (null), fix halfway along seg2 → ~1500, no stale bias
  const heal = projectToRoute({ lat: 0, lon: 1.5 * dLon }, poly, null);
  ok('post-gap (no hint) snaps to nearest ~1500', Math.abs(heal.alongM - 1500) < 5, `${heal.alongM}`);

  ok('empty route → offRoute', projectToRoute({ lat: 0, lon: 0 }, [], null).offRoute === true);
}

console.log('\nneedleTauMs (adaptive needle smoothing from GPS accuracy):');
{
  // Two reference-accuracy fixes → τ at the floor (snappy).
  ok('reference accuracy → τ ≈ min', needleTauMs(NEEDLE_ACC_REF_M, NEEDLE_ACC_REF_M) === NEEDLE_TAU_MIN_MS);
  // Excellent fixes (0.5 m) → clamped at the floor (can't go below).
  ok('excellent fixes → τ at floor', needleTauMs(0.5, 0.5) === NEEDLE_TAU_MIN_MS);
  // Poor fixes (30 m) → τ near/at the ceiling (heavily smoothed).
  const t30 = needleTauMs(30, 30);
  ok('30 m fixes → τ large (near ceiling)', t30 >= NEEDLE_TAU_MAX_MS * 0.9, `${t30}`);
  // Monotonic: worse accuracy → larger τ.
  ok('worse accuracy → larger τ', needleTauMs(10, 10) > needleTauMs(4, 4));
  ok('τ monotonic across range', needleTauMs(20, 20) >= needleTauMs(10, 10));
  // Missing accuracy treated as reference (unchanged behaviour on silent devices).
  ok('null accuracy → treated as reference', needleTauMs(null, null) === NEEDLE_TAU_MIN_MS);
  // Always within the clamp band.
  ok('always within [min,max]', (() => { for (const a of [0, 1, 5, 15, 40, 100]) { const v = needleTauMs(a, a); if (v < NEEDLE_TAU_MIN_MS || v > NEEDLE_TAU_MAX_MS) return false; } return true; })());
  // A tight fix moves the EMA much more than a loose one over the same dt.
  const tight = emaStep(0, 10, 1000, needleTauMs(2, 2));
  const loose = emaStep(0, 10, 1000, needleTauMs(30, 30));
  ok('tight fix moves needle more than loose', tight > loose * 3, `tight ${tight.toFixed(2)} loose ${loose.toFixed(2)}`);
  // Accuracy floor: a device lying with sub-floor accuracy is treated as no
  // better than the floor, so it can't produce a shorter τ than a floor-accuracy fix.
  ok('sub-floor accuracy clamped to floor', needleTauMs(0.5, 0.5) === needleTauMs(2.5, 2.5), `${needleTauMs(0.5,0.5)} vs ${needleTauMs(2.5,2.5)}`);
  ok('0.5 m does not beat 2.5 m (no over-trust)', needleTauMs(0.5, 0.5) >= needleTauMs(2.5, 2.5));
}

console.log(`\n${pass} passed, ${fail} failed`);
