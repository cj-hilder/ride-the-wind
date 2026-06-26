import {
  WF_STILL, WF_WINDY, FREEZE_AGE_MS,
  classifyRide, clampK, isFrozenByAge, applyFreeze, effectiveBaseline, rideK,
  resolveBaseline, resolveK, resolveModel, dotCount, predictFromModel, predict,
} from './src/lib/learning.js';

let pass = 0, fail = 0;
const ok = (n, c, d = '') => { c ? (pass++, console.log(`  PASS  ${n}`)) : (fail++, console.log(`  FAIL  ${n}  ${d}`)); };
const near = (a, b, t) => Math.abs(a - b) <= t;

const DAY = 24 * 60 * 60 * 1000;
const NOW = 1_700_000_000_000;
// Build a ride. age in days back from NOW.
function ride(wf, actualSec, { ageDays = 0, included = true, ref = 'current', saved = null } = {}) {
  return {
    windFactor: wf, actualSec,
    included, baselineRef: ref, savedBaselineSec: saved,
    startedAt: NOW - ageDays * DAY,
  };
}

console.log('Classification (quadratic wf scale):');
{
  ok('crosswind/calm -> still', classifyRide(0.0) === 'still');
  ok('just below WF_STILL -> still', classifyRide(WF_STILL - 0.001) === 'still');
  ok('between -> gentle', classifyRide(0.15) === 'gentle');
  ok('at WF_WINDY -> windy', classifyRide(WF_WINDY) === 'windy');
  ok('negative windy -> windy', classifyRide(-0.4) === 'windy');
  ok('strong crosswind (wf~0) reads still', classifyRide(0.01) === 'still');
}

console.log('\nClamp:');
{
  ok('huge k clamps to 4.0', clampK(99) === 4.0);
  ok('tiny k clamps to 0.05', clampK(0.001) === 0.05);
  ok('NaN -> null', clampK(NaN) === null);
}

console.log('\nFreeze by age + applyFreeze:');
{
  ok('young ride not frozen by age', isFrozenByAge(ride(0, 1000, { ageDays: 5 }), NOW) === false);
  ok('old ride frozen by age', isFrozenByAge(ride(0, 1000, { ageDays: 15 }), NOW) === true);

  const young = ride(0.3, 1100, { ageDays: 5 });
  ok('young current ride passes through unchanged', applyFreeze(young, 1000, NOW) === young);

  const old = ride(0.3, 1100, { ageDays: 20 });
  const frozen = applyFreeze(old, 1234, NOW);
  ok('old current ride flips to historic', frozen.baselineRef === 'historic');
  ok('freeze snapshots LIVE baseline at freeze instant', frozen.savedBaselineSec === 1234);

  const alreadyHist = ride(0.3, 1100, { ageDays: 20, ref: 'historic', saved: 900 });
  ok('already-historic untouched', applyFreeze(alreadyHist, 1234, NOW) === alreadyHist);
}

console.log('\nEffective baseline & per-ride k:');
{
  const cur = ride(0.5, 1200, { ref: 'current' });
  ok('current uses live baseline', effectiveBaseline(cur, 1000) === 1000);
  const hist = ride(0.5, 1200, { ref: 'historic', saved: 950 });
  ok('historic uses frozen baseline', effectiveBaseline(hist, 1000) === 950);

  // k_ride = (actual/b − 1)/wf ; for current b=1000, actual=1200, wf=0.5 → 0.4
  ok('rideK current', near(rideK(cur, 1000), (1200 / 1000 - 1) / 0.5, 1e-9));
  // historic uses 950 → (1200/950 −1)/0.5
  ok('rideK historic uses frozen b', near(rideK(hist, 1000), (1200 / 950 - 1) / 0.5, 1e-9));
  ok('still ride (wf~0) -> null k', rideK(ride(0, 1000), 1000) === null);
}

console.log('\nBaseline resolution:');
{
  // Branch 1: a still ride present → mean of still rides, windy ignored.
  const r1 = resolveBaseline([ride(0.0, 1000), ride(0.02, 1040), ride(0.5, 5000)], 1500);
  ok('branch1 mean of still rides', near(r1.baselineSec, 1020, 1e-9), `${r1.baselineSec}`);
  ok('branch1 source learned', r1.source === 'learned' && r1.branch === 1);

  // Branch 2: no still, windy with enough spread → intercept ≈ true baseline.
  // synth windy from baseline 1000, k 0.5: actual = 1000(1+0.5 wf)
  const wf2 = [0.25, 0.4, 0.5, 0.7, 0.9];
  const windy = wf2.map((w) => ride(w, 1000 * (1 + 0.5 * w)));
  const r2 = resolveBaseline(windy, 1500);
  ok('branch2 extrapolates baseline ~1000', near(r2.baselineSec, 1000, 1.0), `${r2.baselineSec}`);
  ok('branch2 source learned', r2.source === 'learned' && r2.branch === 2);

  // Branch 2 gate: windy but too little spread → fall through to slider.
  const tight = [0.30, 0.31, 0.32].map((w) => ride(w, 1000 * (1 + 0.5 * w)));
  const r2b = resolveBaseline(tight, 1500);
  ok('branch2 insufficient spread -> slider', r2b.source === 'slider' && r2b.baselineSec === 1500);

  // Branch 3: nothing usable → slider.
  const r3 = resolveBaseline([ride(0.15, 1100)], 1500); // only a gentle ride
  ok('branch3 slider fallback', r3.source === 'slider' && r3.baselineSec === 1500);
}

console.log('\nk resolution — manual mode:');
{
  const k = resolveK([ride(0.5, 1500)], 1000,
    { kMode: 'manual', split: false, sliderKHead: 0.8, sliderKTail: 0.3 });
  ok('manual uses slider', k.kHead === 0.8 && k.kTail === 0.3);
  ok('manual sources slider', k.sourceHead === 'slider' && k.sourceTail === 'slider');
  ok('manual no autosplit', k.autoSplit === false);
}

console.log('\nk resolution — learn, combined (one direction only):');
{
  // Only headwind windy rides → cannot split (tail has none) → combined pooled.
  const b = 1000;
  const head = [0.3, 0.5, 0.7].map((w) => ride(w, b * (1 + 0.6 * w)));
  const k = resolveK(head, b, { kMode: 'learn', split: false, sliderKHead: 1.0, sliderKTail: 1.0 });
  ok('combined (no tail data) learns pooled k', near(k.kHead, 0.6, 0.02), `${k.kHead}`);
  ok('combined: head==tail (single value)', k.kHead === k.kTail);
  ok('combined: not split, not autosplit', k.split === false && k.autoSplit === false);
}

console.log('\nk resolution — learn, AUTO-SPLIT when both directions qualify:');
{
  const b = 1000;
  const head = [0.3, 0.5, 0.7].map((w) => ride(w, b * (1 + 0.8 * w)));
  const tail = [-0.3, -0.5, -0.7].map((w) => ride(w, b * (1 + 0.3 * w)));
  const k = resolveK([...head, ...tail], b,
    { kMode: 'learn', split: false, sliderKHead: 1.0, sliderKTail: 1.0 });
  ok('auto-splits when both qualify', k.autoSplit === true && k.split === true);
  ok('learns kHead ~0.8', near(k.kHead, 0.8, 0.02), `${k.kHead}`);
  ok('learns kTail ~0.3', near(k.kTail, 0.3, 0.02), `${k.kTail}`);
  ok('both sources learned', k.sourceHead === 'learned' && k.sourceTail === 'learned');
}

console.log('\nk resolution — learn, manual split with one side short:');
{
  const b = 1000;
  const head = [0.3, 0.5, 0.7].map((w) => ride(w, b * (1 + 0.9 * w)));
  const tail = [-0.4].map((w) => ride(w, b * (1 + 0.3 * w))); // only 1 tail → gate fails
  const k = resolveK([...head, ...tail], b,
    { kMode: 'learn', split: true, sliderKHead: 1.0, sliderKTail: 0.5 });
  ok('manual split honoured', k.split === true);
  ok('head learned', k.sourceHead === 'learned' && near(k.kHead, 0.9, 0.03));
  ok('tail falls back to slider', k.sourceTail === 'slider' && k.kTail === 0.5);
}

console.log('\nclampK applied in k fit (extreme slope):');
{
  const b = 1000;
  const head = [0.3, 0.5, 0.7].map((w) => ride(w, b * (1 + 9 * w))); // k=9 → clamp 4
  const k = resolveK(head, b, { kMode: 'learn', split: false, sliderKHead: 1, sliderKTail: 1 });
  ok('learned k clamped to 4.0', k.kHead <= 4.0 + 1e-9 && k.kHead === 4.0, `${k.kHead}`);
}

console.log('\nresolveModel — per-ride baseline in k fit (historic frozen):');
{
  // A historic ride should use its frozen baseline, not the live learned one.
  // Live baseline learned from a still ride at 1000. A historic windy ride was
  // ridden when baseline was 1200 (frozen), actual reflects k=0.5 on 1200.
  const still = ride(0.0, 1000, { ageDays: 1 });
  const histWindy = ride(0.5, 1200 * (1 + 0.5 * 0.5), { ageDays: 30, ref: 'historic', saved: 1200 });
  const histWindy2 = ride(0.8, 1200 * (1 + 0.5 * 0.8), { ageDays: 30, ref: 'historic', saved: 1200 });
  const m = resolveModel([still, histWindy, histWindy2], {
    baselineMode: 'learn', sliderBaselineSec: 1500,
    kMode: 'learn', split: false, sliderKHead: 1, sliderKTail: 1,
  }, NOW);
  ok('baseline learned from still ride', near(m.baselineSec, 1000, 1e-6), `${m.baselineSec}`);
  // k computed against frozen 1200 (not live 1000) recovers 0.5
  ok('k uses frozen per-ride baseline -> 0.5', near(m.kHead, 0.5, 0.02), `${m.kHead}`);
}

console.log('\nresolveModel — freeze transitions returned for persistence:');
{
  const young = ride(0.3, 1100, { ageDays: 3 });
  const old = ride(0.4, 1150, { ageDays: 20 });
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
  // all manual → 0
  const allManual = resolveModel([ride(0.5, 1500)], {
    baselineMode: 'manual', sliderBaselineSec: 1000,
    kMode: 'manual', split: false, sliderKHead: 0.5, sliderKTail: 0.5,
  }, NOW);
  ok('all manual -> 0 dots', dotCount(allManual) === 0);

  // learn but starved (one gentle ride) → 0
  const starved = resolveModel([ride(0.15, 1100)], {
    baselineMode: 'learn', sliderBaselineSec: 1000,
    kMode: 'learn', split: false, sliderKHead: 0.5, sliderKTail: 0.5,
  }, NOW);
  ok('learn but starved -> 0 dots', dotCount(starved) === 0);

  // baseline learned (still ride) + combined k learned → 2 dots (1 baseline + 1 combined k)
  const b = 1000;
  const ridesC = [ride(0.0, 1000, { ageDays: 1 }),
    ...[0.3, 0.5, 0.7].map((w) => ride(w, b * (1 + 0.6 * w), { ageDays: 1 }))];
  const combined = resolveModel(ridesC, {
    baselineMode: 'learn', sliderBaselineSec: 1500,
    kMode: 'learn', split: false, sliderKHead: 1, sliderKTail: 1,
  }, NOW);
  ok('baseline + combined k -> 2 dots', dotCount(combined) === 2, JSON.stringify({b:combined.baselineSource,h:combined.kHeadSource,t:combined.kTailSource,split:combined.split}));

  // full split both learned + baseline → 3 dots
  const ridesF = [ride(0.0, 1000, { ageDays: 1 }),
    ...[0.3, 0.5, 0.7].map((w) => ride(w, b * (1 + 0.8 * w), { ageDays: 1 })),
    ...[-0.3, -0.5, -0.7].map((w) => ride(w, b * (1 + 0.3 * w), { ageDays: 1 }))];
  const full = resolveModel(ridesF, {
    baselineMode: 'learn', sliderBaselineSec: 1500,
    kMode: 'learn', split: false, sliderKHead: 1, sliderKTail: 1,
  }, NOW);
  ok('baseline + split kHead + kTail -> 3 dots', dotCount(full) === 3, JSON.stringify({split:full.split,auto:full.autoSplit}));
}

console.log('\nPrediction + speed clamp:');
{
  const model = { baselineSec: 1000, kHead: 0.8, kTail: 0.3 };
  const ph = predictFromModel(model, 0.5, { distanceM: 5000 });
  ok('headwind slower', ph.predictedSec > 1000 && ph.k === 0.8);
  const pt = predictFromModel(model, -0.5, { distanceM: 5000 });
  ok('tailwind faster', pt.predictedSec < 1000 && pt.k === 0.3);
  // tailwind ceiling: multiplier >= 1/3
  const pbig = predictFromModel(model, -5, { distanceM: 5000 });
  ok('tailwind clamped to 1/3 floor', near(pbig.multiplier, 1 / 3, 1e-9) && pbig.clamped);
}

console.log('\npredict() convenience (provisional flag):');
{
  const p = predict([ride(0.15, 1100)], {
    baselineMode: 'learn', sliderBaselineSec: 1000,
    kMode: 'learn', split: false, sliderKHead: 0.5, sliderKTail: 0.5,
  }, 0.3, { distanceM: 5000 }, NOW);
  ok('all-slider resolve marked provisional', p.provisional === true);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
