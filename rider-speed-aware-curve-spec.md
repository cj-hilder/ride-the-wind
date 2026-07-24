# Rider-speed-aware wind curve (SPEC — BUILT in 1.6.0)

Status: BUILT and shipped in 1.6.0. Full suite green (793 tests, incl. the
114-check consistency suite testv0.mjs and a new testcruise.mjs integration
suite).

## Where v0 comes from — REDESIGNED after field testing

The curve is parametrised by the rider's still-air speed v0. The ORIGINAL 1.6.0
build derived v0 per route from distance/baseline. Field testing (a real
Wellington residential→CBD commute, 3.79 km, exposed to a 42 km/h southerly)
showed this was wrong, for reasons worth recording:

- A per-route average speed is a BIASED estimator of v0. Stops, traffic, and
  hills only ever drag it DOWN, never up — so derived v0 is systematically too
  low, over-steepening the curve and over-warning. There's no offsetting error.
- The bias is worst exactly where it hurts: a normal commuter in strong wind
  (the Wellington case), where curve SHAPE matters most.
- It can't be rescued by fine-grained movement data (stops vs moving), because
  that doesn't address hills, e-bikes, or walkers — those aren't dead time,
  they're "constant-power road-cyclist physics is the wrong model here."
- v0 is a property of the RIDER, not the route. A given person has ~one cruising
  speed whatever route they ride; stops/hills/assist are per-route BEHAVIOUR,
  which is exactly what the learned k already absorbs.

RESOLUTION: v0 is now a single GLOBAL rider setting — "Cruising speed: how fast
you typically ride on the flat with no wind" — in Settings, defaulting to 20
km/h (metric) or 15 mph (imperial), NOT one converted to the other. Read at
prediction time; changing it re-shapes every route at once. The per-route
distance-derived v0 machinery is removed. Clean division of labour: cruising
speed (rider, declared, fixed) sets curve SHAPE; k (per route, learned) absorbs
how hard you ride each route plus shelter, e-bike assist, gait, and stops.

This also quietly handles the e-bike/walker/hill cases we'd written off as
undetectable: they become DECLARED (set your cruising speed) rather than
detected. It does not fix the cold-start over-warning on a brand-new exposed
manual route with default k — that's a separate default-k question, noted below.

Seed times are now a v0-INDEPENDENT encoding (created and read at the nominal
reference), so changing your cruising speed never makes stored seeds stale; only
live k-derivation and prediction use the global speed.

## Curve constants (refit against true physics)

The drafted linear constants missed the ≤0.03 bar (0.06 at band edges); refit
per-v0 against true constant-power physics, then linear in v0:
  C_H = 0.01589·v0 + 0.5243     A = 0.01782·v0 + 0.3705
  C_T = 0.00338·v0 + 0.3095     B = 0.00201·v0 + 0.2860
≤0.032 for winds up to the rider's own speed, ≤0.038 in extreme winds (w>v0);
residual magnitude there is absorbed by k. Consistency bound set at 0.032
(practical) / 0.04 (extreme). Tighter would need a quadratic-in-v0 term on C_H.

## OPEN ITEM (not this spec): cold-start over-warning

On a fresh exposed manual route with the default k=0.5 and no windy rides yet,
strong-wind predictions still over-warn (the Wellington case showed +72.6% on a
14-min ride). That's a default-k / seed question, independent of v0 sourcing.
Worth a separate look: is k=0.5 too high a default for exposed commutes, or is
the number actually right and it's expectations that need managing? Flagged for
Chris, not decided.

This is a MODEL change (touches the branch curves, seeds, inverses,
k-derivation, and now a global rider setting).

## Problem (original)
The v2 branch curves are fitted at a single nominal rider still-air speed
(v0 = 24 km/h) and normalised by a fixed reference wind wref = 20 km/h. The
curve shape was assumed "insensitive to rider speed 18–30" — true for MODERATE
winds, but it breaks in STRONG winds relative to a slow rider's pace, because a
slow rider loses a larger FRACTION of speed to a given wind.

Measured (true constant-power model, headwind time-penalty %):

    w \ v0   16     20     24     28     32
     10      40%    34%    29%    25%    22%
     20     103%    85%    71%    60%    52%
     30     197%   158%   129%   107%    91%

A 20 km/h headwind costs a 16 km/h rider ~2× what it costs a 32 km/h rider.
The fixed-v0 curve under-predicts for slow riders in strong wind — the
"twice-my-pace headwind only adds a few minutes" symptom. (The cautious default
k=0.5 compounds it on unlearned routes, but that's separate and self-correcting.)

## Key finding — the right normalisation
Normalising the wind by the RIDER'S OWN still-air speed (x = w / v0) instead of
by fixed wref = 20 makes each rider's curve fit the SAME functional forms well
(head rmse ≤0.022, tail ≤0.011 over 0–2·v0). The constants then vary smoothly &
near-linearly with v0 (km/h), fitted over 16–32 km/h:

    x   = w / v0                      (w = along-route wind, v0 = route still-air speed)
    C_H ≈ 0.01596·v0 + 0.5236         (max resid 0.029)
    A   ≈ 0.03047·v0 + 0.3617         (max resid 0.029)
    C_T ≈ 0.00342·v0 + 0.3075         (max resid 0.011)
    B   ≈ 0.00097·v0 + 0.3257         (max resid 0.011)

Branch forms unchanged:
    head (w>0): g_H(x) = C_H · x(1 + A·x)/(1 + A)
    tail (w<0): g_T(x) = C_T · x/(1 + B·(x − 1))

NOTE: because the normalisation base changes from wref=20 to v0, the constants
differ from the shipped ones even at v0=24 (fit gives C_H≈0.924 with x=w/v0 vs
shipped 0.708 with x=w/20). This is expected — the shipped 0.708 is g at
w=20=wref; the new 0.924 is g at w=v0=24. Both describe the same physics; the
argument scaling moved. Do NOT "reconcile" them — they're in different variables.

## v0 source
v0 = route still-air speed = totalDistance / baselineTimeSec, already available
(baseline is the learned/seeded still-air time). Clamp v0 to the fit range
[16, 32] km/h so extrapolation beyond the fitted band can't produce odd
constants; outside that band the linear forms are used at the clamp edge.

A route with NO distance (manual baseline, no GPX) has no derivable v0 → fall
back to nominal v0 = 16 km/h (the slow end of the commuter range, = the clamp
floor). This is the CAUTIOUS fallback, not a "typical rider" guess: from the
penalty table a slower v0 gives the LARGER wind cost, so when we can't know the
rider's speed we predict wind costs more, which errs toward "leave early" — the
safe direction for this tool, and consistent with the cautious default k. (This
changes the old manual-route fallback, which used nominal 24.)

## What changes
1. windModel: effortNorm(w, v0) takes v0. Compute C_H,A,C_T,B from v0 via the
   linear laws (clamped), x = |w|/v0. Remove the fixed WF_*_C/WF_*_A/W_REF
   constants (or keep W_REF only for any non-curve use — audit).
2. Inverses invHead/invTail become v0-dependent (they invert v0-specific C,A,B).
   Still closed-form: the forms are unchanged, only the constants are now
   functions of v0. Re-derive and re-verify round-trip to machine precision.
3. computeWindFactor / windFactorTimed: thread v0 (from route baseline) into
   effortNorm. k still applied INSIDE as before: effortNorm(k·h, v0).
4. Seeds (seedK/seedKSplit, storage migration, example): invert using the
   route's v0, not fixed wref. Seeds are entered at "20 km/h wind" — that stays
   a 20 km/h WIND, but x = 20/v0 now, so the seed→k maths uses v0.
5. k-derivation (rideK, resolveK, branch-2 refinement): every effortNorm/invHead
   /invTail call gains v0. k semantics UNCHANGED (fraction of forecast felt);
   v0 only fixes the curve the felt wind runs through.
6. Displays: equivalent wind & ground-effect-equivalent (debug.effortHeadwindKmh,
   feltEquivWindKmh) invert with v0. "time effect" unchanged in meaning.

## What does NOT change
- k definition, range (0–1.4 / reject 1.6), percentage display, classification
  thresholds (still 5 / windy 10 on raw forecast), the 4-min rule, "light" rule.
- The self-weighting-by-relevance argument for fixed classification thresholds.
- Prediction structure: predicted = baseline·(1 + effortNorm(k·h, v0)).

## Consistency checks required before ship
- effortNorm(w, v0) vs true constant-power penalty at that v0: max abs err ≤0.03
  across v0∈[16,32], w∈[0,2·v0], both branches.
- first-order slope dΔv/dw → −2/3 at w→0 for every v0 (rider-speed independent
  at small wind — must still hold).
- invHead/invTail round-trip to ≤1e-9 at several v0.
- k identification round-trips: recover seeded k for rides synthesised at known
  k and v0.
- No div-by-zero as v0→ clamp floor or k→0 (existing k=0 suite + v0 variants).

## Resolved decisions
- Manual routes with no distance → v0 = 16 km/h fallback (cautious; see v0
  source above). No prompt for typical speed — the cautious fallback is
  preferred over asking, keeping route setup simple.
