# Wind model v2 — physics curve with k as wind attenuation (SPEC, ready to build)

Status: **SHIPPED in 1.5.0** (incl. the k-percent amendment below).

## AMENDMENT (post-ship, same release): k as percentage, single 0–1.2 range
- k is user-facing as a PERCENTAGE everywhere (fraction of forecast wind
  felt): plan tab, ride list, editor line, and the ground-effect slider
  (0%–120% + live readout "ground effect: NN% of forecast wind felt").
- THE k range is 0–1.2, the only range in the system (K_MIN/K_MAX everywhere,
  incl. seeds and the storage migration; the old 0.1–1.5 band is gone).
- Per-ride k is UNCLAMPED. If it lands outside 0–1.2 the ride defaults to
  NOT-USED at record time (same mechanism as gentle rides; user can opt it
  back in). Wrong-sign deviations still invert to k = 0 (in range).
- Learned (fitted) k is ACCEPTED only inside 0–1.2 — outside, the fit is
  rejected (not clamped) and the route keeps using the slider setting. Supersedes the earlier draft
(which kept k as a time multiplier). All stored learning data is discarded
except old STILL rides feeding the baseline. Target: next minor after 1.4.0.

## The model (Chris's formulation, points 1–6 + 8 of the audit)

1. Forecast calibration (forecast ↔ actual at this location): a multiplier.
2. Ground effect (10 m forecast ↔ surface wind): a multiplier.
3. Both fold into ONE learned coefficient per route+direction, **k**, defined
   as: **surface along-route wind = k × forecast along-route wind**. One k is
   valid at all wind speeds — exactly true by construction, since all
   nonlinearity lives in the fixed physics curve.
4. Only the along-route component matters: h = forecast_speed·cos(Δbearing).
   Crosswinds cost no time (known-imperfect; kept as a warning, not modelled).
5. Rider power is constant (the baseline). Measured reality (+~30% on windy
   days) is absorbed into k as pseudo-attenuation; k stays a deliberate blend
   of calibration + shelter + habit, split head/tail because all three are
   direction-dependent.
6. Constant power P = a·v·(v+h)² + c·v, solved for v, converted to time,
   gives the time curve. NOT speed-addition (v ≠ v₀ − h): power = force ×
   GROUND speed, so a 24 km/h headwind leaves a 24 km/h rider at ~12.5 km/h,
   not 0, and a 24 km/h tailwind yields ~40 km/h, not 48.

Prediction:

    predicted_time = baseline_time · (1 + wf)
    wf = Σ tᵢ · f_branch(k · xᵢ) / Σ tᵢ        (k INSIDE the curve)
    xᵢ = hᵢ / w_ref,  w_ref = 20 km/h,  hᵢ = forecast along-route component

Branch curves (least-squares fits to the solved constant-power curve; nominal
CdA 0.45, Crr 0.006, 90 kg, 24 km/h still-air; each branch ≤~0.02 abs error at
nominal, shape insensitive to rider speed 18–30 km/h so NO per-rider params):

    head (h>0):  g_H(x) = C_H·x·(1 + A·x)/(1 + A)   A = 0.715, C_H = 0.708
    tail (h<0):  g_T(x) = C_T·x/(1 + B·(x − 1))      B = 0.30,  C_T = 0.350
    exact inverses (u = w/C_branch, w = PHYSICAL deviation):
                    invH(w) = (−1 + √(1 + 4A(1+A)·u))/(2A)
                    invT(w) = (1−B)·u/(1 − B·u)

BUILD CORRECTION (supersedes the earlier "anchor ±1" claim): the curves carry
the PHYSICAL magnitudes C_H/C_T (nominal-rider time excess at 20 km/h), not a
±1 normalisation. Under k-inside, effortNorm must BE the fractional time
change; a ±1-normalised curve would force an unsheltered nominal rider to
learn kHead 0.78 / kTail 0.27 — breaking "k = fraction of forecast wind felt"
and manufacturing artificial head/tail asymmetry. With the physical curves,
k = 1 reproduces nominal-rider physics in both directions. Rider-speed
magnitude differences (~±20% over 18–30 km/h) are absorbed by k, as shelter
is; K_MAX 1.5 leaves headroom for slower riders.

Why k-inside: with k outside (time multiplier), a true wind attenuation of
e.g. 0.6 forces k to drift ±10% across wind speeds, oppositely per branch.
k-inside absorbs attenuation exactly and makes k directly interpretable
("this route feels 60% of forecast wind").

## Per-ride summary value (replaces stored windFactor)

Each ride stores **rideWindKmh**: the equivalent uniform forecast along-route
wind, signed (+head/−tail) — the single wind reproducing the ride's aggregate
Σtᵢf(xᵢ)/Σtᵢ at k=1, i.e. 20·inv_branch(aggregate). Stated approximation: for
learning, a ride is treated as uniform at rideWindKmh (exact for a single
dominant bearing; second-order error otherwise). Prediction always uses full
segments — no approximation there.

## Learning (learning.js rework)

- Per-ride k:  k_ride = inv_branch(actual/baseline − 1) / (|rideWindKmh|/20),
  branch by sign. Null for still rides. This IS the displayed per-ride k.
- Route k fit: weighted mean of k_ride per direction, weights ∝ |rideWindKmh|
  (stronger-wind rides pin k better), over wfv=2 rides passing the gates.
- Classification: |rideWindKmh| < KMH_STILL(5) → still; ≥ KMH_WINDY(10) →
  head/tail-classified windy; else gentle. Spread gates in km/h:
  KMH_SPREAD_MIN 1.2, KMH_BASELINE_SPREAD_MIN 4.
- Baseline branch 2 (no still rides, windy extrapolation): the intercept
  regressor assumes the k=1 curve while data follows f(k·w), so a single OLS
  pass is biased (~6% at k=0.5, mixed directions). BUILD ADDITION: two
  refinement iterations (intercept → wind-weighted implied k → refit with
  z = f(k·w)/k) remove it — verified 940 → 999 on 60 noisy rides (true 1000).
- seedK: from the 20 km/h seed times, per branch: k = inv_branch(seed/still −1)
  (x = 1 at the seed wind, so the inverse alone gives k).
- DEFAULT_K = 0.5; slider (ground-effect) range 0.0–1.2, semantics "fraction
  of forecast wind felt on this route", clamp learned k to 0.1–1.5.
  [DECIDED: 0.5 default, 0–1.2 slider range]

## Ground-effect example (TerrainSlider)

exampleFor returns the steady-20 km/h per-segment (xᵢ, tᵢ) head and tail sets;
the slider computes example times as baseline·(1 + Σt f(k·xᵢ)/Σt) live with
the slider's k. Caption anchors stay 20 km/h / 10 mph / 10 kt.

## No-migration data handling (decided)
- New rides stamped `wfv: 2` and store rideWindKmh (no windFactor).
- Learning uses wfv=2 only, EXCEPT: old rides with stored klass === "still"
  keep feeding the baseline resolve. Old-ride classification = stored klass.
- Old rides display: k shows "—"; mean wind via v1 inverse 20·√|windFactor|.

## Ride list & editor display (decided)
1. Class label "windy" → **"headwind" | "tailwind"** by sign (v2: rideWindKmh;
   v1: stored windFactor), list chip + editor line, coloured with the verdict
   accents (headwind blue, tailwind amber); gentle/still unchanged.
2. Editor line appends **"· mean wind «formatWindSpeed(|rideWindKmh|)»"**
   (units-aware); omitted for still rides.

## Knock-on inventory
- windModel: effortNorm → branches; computeWindFactor(segments, windAt, times,
  k) with k inside; export A/B + inverses; docstrings rewritten (constant-power
  time analysis; speed-addition explicitly refuted for the record).
- prediction.js / app.js: pass route k into computeWindFactor; conservative
  range logic unchanged in structure.
- Tech panel: "wind factor" row = wf (fractional time effect) — unchanged
  meaning; no new k row (k already shown in the plan tab bottom panel) [DECIDED].
- alertEngine (minutes), whatToExpect (km/h bands), rideReadout: unchanged.
- Tests: testwind (branch values, inverse round-trips, anchor f(±1)=±1,
  k-inside separability: wf(k, h)=wf(1, k·h) for uniform wind), testlearning
  (classification at 5/10 km/h, per-ride k inversion, weighted fit, wfv filter
  + still carve-out, seedK inversion), testapp fixtures on the new scale.

## Out of scope
- Crosswind time cost; separating shelter vs behaviour; per-rider curve params.
