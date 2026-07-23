import {
  KMH_STILL, KMH_WINDY, K_MIN, K_MAX, K_LEARN_REJECT, FREEZE_AGE_MS,
  classifyRide, classifyRideRecord, isV2Ride, clampK, isFrozenByAge, applyFreeze,
  effectiveBaseline, rideK,
  resolveBaseline, resolveK, resolveModel, dotCount, predictFromModel, predict,
} from './src/lib/learning.js';
import { effortNorm, invHead, invTail } from './src/lib/windModel.js';

let pass = 0, fail = 0;
const ok = (n, c, d = '') => { c ? (pass++, console.log(`  PASS  ${n}`)) : (fail++, console.log(`  FAIL  ${n}  ${d}`)); };
const near = (a, b, t) => Math.abs(a - b) <= t;

const DAY = 24 * 60 * 60 * 1000;
const NOW = 1_700_000_000_000;
// Build a v2 ride: wind in signed km/h (+head/−tail). age in days back from NOW.
function ride(windKmh, actualSec, { ageDays = 0, included = true, ref = 'current', saved = null } = {}) {
  return {
    wfv: 2, rideWindKmh: windKmh, actualSec,
    included, baselineRef: ref, savedBaselineSec: saved,
    startedAt: NOW - ageDays * DAY,
  };
}
// Build a v1 legacy ride (old signed-square windFactor, no v2 fields).
function rideV1(wf, actualSec, { ageDays = 0, included = true, ref = 'current', saved = null } = {}) {
  return {
    windFactor: wf, actualSec,
    included, baselineRef: ref, savedBaselineSec: saved,
    startedAt: NOW - ageDays * DAY,
  };
}
// Synthetic actual for a true attenuation k at wind w (v2 forward model).
const synth = (b, k, windKmh) => b * (1 + effortNorm(k * windKmh));

console.log('Classification (equivalent km/h scale):');
{
  ok('calm -> still', classifyRide(0) === 'still');
  ok('just below KMH_STILL -> still', classifyRide(KMH_STILL - 0.01) === 'still');
  ok('between -> gentle', classifyRide(7) === 'gentle');
  ok('at KMH_WINDY -> windy', classifyRide(KMH_WINDY) === 'windy');
  ok('negative windy -> windy', classifyRide(-15) === 'windy');
  ok('strong crosswind (along ~0) reads still', classifyRide(0.5) === 'still');
}

console.log('\nRecord classification (v1 carve-out uses frozen v1 thresholds):');
{
  ok('v2 record classifies by rideWindKmh (raw forecast, no k)', classifyRideRecord(ride(12, 1000)) === 'windy');
  ok('v1 still (wf 0.02) -> still', classifyRideRecord(rideV1(0.02, 1000)) === 'still');
  ok('v1 gentle (wf 0.15) -> gentle', classifyRideRecord(rideV1(0.15, 1000)) === 'gentle');
  ok('v1 windy (wf 0.5) -> windy', classifyRideRecord(rideV1(0.5, 1000)) === 'windy');
  ok('isV2Ride false for v1', isV2Ride(rideV1(0.5, 1000)) === false);
}

console.log('\nClamp (slider band 0-1.4, user-facing 0%-140%):');
{
  ok('huge k clamps to K_MAX 1.4', clampK(99) === K_MAX && K_MAX === 1.4);
  ok('K_MIN is 0 (tiny k passes through)', clampK(0.001) === 0.001 && K_MIN === 0);
  ok('NaN -> null', clampK(NaN) === null);
}

console.log('\nFreeze by age + applyFreeze:');
{
  ok('young ride not frozen by age', isFrozenByAge(ride(0, 1000, { ageDays: 5 }), NOW) === false);
  ok('old ride frozen by age', isFrozenByAge(ride(0, 1000, { ageDays: 15 }), NOW) === true);

  const young = ride(12, 1100, { ageDays: 5 });
  ok('young current ride passes through unchanged', applyFreeze(young, 1000, NOW) === young);

  const old = ride(12, 1100, { ageDays: 20 });
  const frozen = applyFreeze(old, 1234, NOW);
  ok('old current ride flips to historic', frozen.baselineRef === 'historic');
  ok('freeze snapshots LIVE baseline at freeze instant', frozen.savedBaselineSec === 1234);

  const alreadyHist = ride(12, 1100, { ageDays: 20, ref: 'historic', saved: 900 });
  ok('already-historic untouched', applyFreeze(alreadyHist, 1234, NOW) === alreadyHist);
}

console.log('\nEffective baseline & per-ride k (inversion through the curve):');
{
  const cur = ride(10, synth(1000, 0.5, 10), { ref: 'current' });
  ok('current uses live baseline', effectiveBaseline(cur, 1000) === 1000);
  const hist = ride(10, synth(950, 0.5, 10), { ref: 'historic', saved: 950 });
  ok('historic uses frozen baseline', effectiveBaseline(hist, 1000) === 950);

  ok('rideK inverts to true k (head)', near(rideK(cur, 1000), 0.5, 1e-9), `${rideK(cur, 1000)}`);
  ok('rideK historic uses frozen b', near(rideK(hist, 1000), 0.5, 1e-9), `${rideK(hist, 1000)}`);
  const tailRide = ride(-14, synth(1000, 0.6, -14));
  ok('rideK inverts to true k (tail)', near(rideK(tailRide, 1000), 0.6, 1e-9), `${rideK(tailRide, 1000)}`);
  ok('still ride (wind 0) -> null k', rideK(ride(0, 1000), 1000) === null);
  ok('v1 ride -> null k', rideK(rideV1(0.5, 1200), 1000) === null);
  // wrong-sign deviation: head ride FASTER than baseline testifies zero effect
  ok('head ride faster than baseline -> k 0', rideK(ride(10, 950), 1000) === 0);
}

console.log('\nBaseline resolution:');
{
  // Branch 1: still rides (incl. a v1 still via the carve-out) → mean.
  const r1 = resolveBaseline([ride(0, 1000), rideV1(0.02, 1040), ride(12, 5000)], 1500);
  ok('branch1 mean of still rides (v1 carve-out counts)', near(r1.baselineSec, 1020, 1e-9), `${r1.baselineSec}`);
  ok('branch1 source learned', r1.source === 'learned' && r1.branch === 1);

  // Branch 2: no still, v2 windy with spread → intercept near true baseline.
  // KNOWN BIAS: the regressor is f(w) while data follows f(k·w); at k=0.5 the
  // curvature mismatch overestimates by ~3% (shrinks as k→1). Fallback branch.
  const windy = [10, 13, 16, 20, 25].map((w) => ride(w, synth(1000, 0.5, w)));
  const r2 = resolveBaseline(windy, 1500);
  ok('branch2 extrapolates baseline ~1000 (±40)', near(r2.baselineSec, 1000, 40), `${r2.baselineSec}`);
  ok('branch2 source learned', r2.source === 'learned' && r2.branch === 2);

  // Branch 2 excludes v1 windy rides entirely (garbage-scale wf).
  const withV1 = [...windy.slice(0, 1), rideV1(0.5, 9999), rideV1(0.9, 9999)];
  const r2v1 = resolveBaseline(withV1, 1500);
  ok('v1 windy rides never feed branch2', r2v1.source === 'slider', `${r2v1.source}`);

  // Branch 2 gate: too little km/h spread → slider.
  const tight = [11, 11.5, 12].map((w) => ride(w, synth(1000, 0.5, w)));
  const r2b = resolveBaseline(tight, 1500);
  ok('branch2 insufficient spread -> slider', r2b.source === 'slider' && r2b.baselineSec === 1500);

  // Branch 3: nothing usable → slider.
  const r3 = resolveBaseline([ride(7, 1100)], 1500); // only a gentle ride
  ok('branch3 slider fallback', r3.source === 'slider' && r3.baselineSec === 1500);
}

console.log('\nk resolution — manual mode:');
{
  const k = resolveK([ride(12, 1500)], 1000,
    { kMode: 'manual', split: false, sliderKHead: 0.8, sliderKTail: 0.3 });
  ok('manual uses slider', k.kHead === 0.8 && k.kTail === 0.3);
  ok('manual sources slider', k.sourceHead === 'slider' && k.sourceTail === 'slider');
  ok('manual no autosplit', k.autoSplit === false);
}

console.log('\nk resolution — learn, combined (one direction only):');
{
  const b = 1000;
  const head = [12, 16, 20].map((w) => ride(w, synth(b, 0.6, w)));
  const k = resolveK(head, b, { kMode: 'learn', split: false, sliderKHead: 1.0, sliderKTail: 1.0 });
  ok('combined (no tail data) learns pooled k', near(k.kHead, 0.6, 1e-6), `${k.kHead}`);
  ok('combined: head==tail (single value)', k.kHead === k.kTail);
  ok('combined: not split, not autosplit', k.split === false && k.autoSplit === false);
}

console.log('\nk resolution — learn, AUTO-SPLIT when both directions qualify:');
{
  const b = 1000;
  const head = [12, 16, 20].map((w) => ride(w, synth(b, 0.8, w)));
  const tail = [-12, -16, -20].map((w) => ride(w, synth(b, 0.3, w)));
  const k = resolveK([...head, ...tail], b,
    { kMode: 'learn', split: false, sliderKHead: 1.0, sliderKTail: 1.0 });
  ok('auto-splits when both qualify', k.autoSplit === true && k.split === true);
  ok('learns kHead ~0.8', near(k.kHead, 0.8, 1e-6), `${k.kHead}`);
  ok('learns kTail ~0.3', near(k.kTail, 0.3, 1e-6), `${k.kTail}`);
  ok('both sources learned', k.sourceHead === 'learned' && k.sourceTail === 'learned');
}

console.log('\nk resolution — learn, manual split with one side short:');
{
  const b = 1000;
  const head = [12, 16, 20].map((w) => ride(w, synth(b, 0.9, w)));
  const tail = [ride(-14, synth(b, 0.3, -14))]; // only 1 tail → gate fails
  const k = resolveK([...head, ...tail], b,
    { kMode: 'learn', split: true, sliderKHead: 1.0, sliderKTail: 0.5 });
  ok('manual split honoured', k.split === true);
  ok('head learned', k.sourceHead === 'learned' && near(k.kHead, 0.9, 1e-6));
  ok('tail falls back to slider', k.sourceTail === 'slider' && k.kTail === 0.5);
}

console.log('\nk resolution — v1 rides never feed k:');
{
  const b = 1000;
  const v1s = [0.3, 0.5, 0.7].map((wf) => rideV1(wf, b * (1 + 0.6 * wf)));
  const k = resolveK(v1s, b, { kMode: 'learn', split: false, sliderKHead: 1.0, sliderKTail: 1.0 });
  ok('v1-only log resolves slider', k.sourceHead === 'slider' && k.kHead === 1.0);
}

console.log('\nk resolution — gentle rides contribute to k (option A):');
{
  const b = 1000;
  // gentle winds [5,10): opted-in gentle rides feed k.
  const gentleHead = [6, 9].map((w) => ride(w, synth(b, 0.5, w)));
  const k = resolveK(gentleHead, b, { kMode: 'learn', split: false, sliderKHead: 1, sliderKTail: 1 });
  ok('opted-in gentle rides feed k', k.sourceHead === 'learned' && near(k.kHead, 0.5, 1e-6), `${k.kHead}`);
}

console.log('\nresolveModel — gentle gating: default excluded, used → feeds k:');
{
  const b = 1000;
  const def = [6, 9].map((w) => ride(w, synth(b, 0.5, w), { included: false }));
  const still = ride(0, b, { ageDays: 1 });
  const mDefault = resolveModel([still, ...def], {
    baselineMode: 'learn', sliderBaselineSec: 1500,
    kMode: 'learn', split: false, sliderKHead: 1, sliderKTail: 1,
  }, NOW);
  ok('default (unused) gentle rides do NOT feed k', mDefault.kHeadSource === 'slider' && mDefault.kHead === 1);

  const used = [6, 9].map((w) => ride(w, synth(b, 0.5, w), { included: true }));
  const mUsed = resolveModel([still, ...used], {
    baselineMode: 'learn', sliderBaselineSec: 1500,
    kMode: 'learn', split: false, sliderKHead: 1, sliderKTail: 1,
  }, NOW);
  ok('used gentle rides feed k', mUsed.kHeadSource === 'learned' && near(mUsed.kHead, 0.5, 1e-6), `${mUsed.kHead}`);
  ok('baseline still from the still ride', near(mUsed.baselineSec, b, 1));
}

console.log('\nfit ACCEPTANCE — three zones (0-1.4 as-is, 1.4-1.6 clamped, >1.6 rejected):');
{
  const b = 1000;
  // zone 1: an in-range fit is used exactly.
  const z1 = [12, 16, 20].map((w) => ride(w, synth(b, 1.2, w)));
  const k1 = resolveK(z1, b, { kMode: 'learn', split: false, sliderKHead: 0.5, sliderKTail: 0.5 });
  ok('k=1.2 accepted as-is', k1.sourceHead === 'learned' && Math.abs(k1.kHead - 1.2) < 1e-6, `${k1.kHead}`);
  // zone 2: a fit of ~1.5 is trusted-but-clamped to exactly K_MAX 1.4 (stored/used, not just shown).
  const z2 = [12, 16, 20].map((w) => ride(w, synth(b, 1.5, w)));
  const k2 = resolveK(z2, b, { kMode: 'learn', split: false, sliderKHead: 0.5, sliderKTail: 0.5 });
  ok('k=1.5 clamped to K_MAX 1.4 (learned)', k2.sourceHead === 'learned' && k2.kHead === 1.4, `${k2.kHead} (${k2.sourceHead})`);
  // zone 3: a fit above K_LEARN_REJECT 1.6 is discarded → slider kept.
  const z3 = [12, 16, 20].map((w) => ride(w, synth(b, 1.9, w)));
  const k3 = resolveK(z3, b, { kMode: 'learn', split: false, sliderKHead: 0.5, sliderKTail: 0.5 });
  ok('k=1.9 rejected -> slider', k3.sourceHead === 'slider' && k3.kHead === 0.5, `${k3.kHead} (${k3.sourceHead})`);
  // boundary: exactly at the reject ceiling is still accepted (then clamped).
  const zb = [12, 16, 20].map((w) => ride(w, synth(b, 1.55, w)));
  const kb = resolveK(zb, b, { kMode: 'learn', split: false, sliderKHead: 0.5, sliderKTail: 0.5 });
  ok('k=1.55 (<1.6) accepted then clamped to 1.4', kb.sourceHead === 'learned' && kb.kHead === 1.4, `${kb.kHead}`);
}

console.log('\nresolveModel — per-ride baseline in k fit (historic frozen):');
{
  const still = ride(0, 1000, { ageDays: 1 });
  const histWindy = ride(10, synth(1200, 0.5, 10), { ageDays: 30, ref: 'historic', saved: 1200 });
  const histWindy2 = ride(16, synth(1200, 0.5, 16), { ageDays: 30, ref: 'historic', saved: 1200 });
  const m = resolveModel([still, histWindy, histWindy2], {
    baselineMode: 'learn', sliderBaselineSec: 1500,
    kMode: 'learn', split: false, sliderKHead: 1, sliderKTail: 1,
  }, NOW);
  ok('baseline learned from still ride', near(m.baselineSec, 1000, 1e-6), `${m.baselineSec}`);
  ok('k uses frozen per-ride baseline -> 0.5', near(m.kHead, 0.5, 1e-6), `${m.kHead}`);
}

console.log('\nresolveModel — freeze transitions returned for persistence:');
{
  const young = ride(12, 1100, { ageDays: 3 });
  const old = ride(14, 1150, { ageDays: 20 });
  const m = resolveModel([young, old], {
    baselineMode: 'manual', sliderBaselineSec: 1000,
    kMode: 'manual', split: false, sliderKHead: 0.5, sliderKTail: 0.5,
  }, NOW);
  const oldOut = m.rides.find((r) => r.startedAt === old.startedAt);
  const youngOut = m.rides.find((r) => r.startedAt === young.startedAt);
  ok('old ride frozen to historic', oldOut.baselineRef === 'historic');
  ok('freeze captured live baseline 1000', oldOut.savedBaselineSec === 1000);
  ok('young ride still current', youngOut.baselineRef === 'current');
}

console.log('\nDot count:');
{
  const allManual = resolveModel([ride(12, 1500)], {
    baselineMode: 'manual', sliderBaselineSec: 1000,
    kMode: 'manual', split: false, sliderKHead: 0.5, sliderKTail: 0.5,
  }, NOW);
  ok('all manual -> 0 dots', dotCount(allManual) === 0);

  const starved = resolveModel([ride(7, 1100)], {
    baselineMode: 'learn', sliderBaselineSec: 1000,
    kMode: 'learn', split: false, sliderKHead: 0.5, sliderKTail: 0.5,
  }, NOW);
  ok('learn but starved -> 0 dots', dotCount(starved) === 0);

  const b = 1000;
  const ridesC = [ride(0, 1000, { ageDays: 1 }),
    ...[12, 16, 20].map((w) => ride(w, synth(b, 0.6, w), { ageDays: 1 }))];
  const combined = resolveModel(ridesC, {
    baselineMode: 'learn', sliderBaselineSec: 1500,
    kMode: 'learn', split: false, sliderKHead: 1, sliderKTail: 1,
  }, NOW);
  ok('baseline + combined k -> 2 dots', dotCount(combined) === 2, JSON.stringify({b:combined.baselineSource,h:combined.kHeadSource,split:combined.split}));

  const ridesF = [ride(0, 1000, { ageDays: 1 }),
    ...[12, 16, 20].map((w) => ride(w, synth(b, 0.8, w), { ageDays: 1 })),
    ...[-12, -16, -20].map((w) => ride(w, synth(b, 0.3, w), { ageDays: 1 }))];
  const full = resolveModel(ridesF, {
    baselineMode: 'learn', sliderBaselineSec: 1500,
    kMode: 'learn', split: false, sliderKHead: 1, sliderKTail: 1,
  }, NOW);
  ok('baseline + split kHead + kTail -> 3 dots', dotCount(full) === 3, JSON.stringify({split:full.split,auto:full.autoSplit}));
}

console.log('\nPrediction + speed clamp (NOTE: predictFromModel is reworked in the prediction-plumbing cluster):');
{
  const model = { baselineSec: 1000, kHead: 0.8, kTail: 0.3 };
  const ph = predictFromModel(model, 0.5, { distanceM: 5000 });
  ok('headwind slower', ph.predictedSec > 1000 && ph.k === 0.8);
  const pt = predictFromModel(model, -0.5, { distanceM: 5000 });
  ok('tailwind faster', pt.predictedSec < 1000 && pt.k === 0.3);
  const pbig = predictFromModel(model, -5, { distanceM: 5000 });
  ok('tailwind clamped to 1/3 floor', near(pbig.multiplier, 1 / 3, 1e-9) && pbig.clamped);
}

console.log('\npredict() convenience (provisional flag):');
{
  const p = predict([ride(7, 1100)], {
    baselineMode: 'learn', sliderBaselineSec: 1000,
    kMode: 'learn', split: false, sliderKHead: 0.5, sliderKTail: 0.5,
  }, 0.3, { distanceM: 5000 }, NOW);
  ok('all-slider resolve marked provisional', p.provisional === true);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
