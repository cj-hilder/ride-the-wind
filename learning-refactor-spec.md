# Ride the Wind — Learning Feature Refactor Specification

Status: design complete, ready for implementation.
Scope: `src/lib/learning.js`, the ride/model storage in `src/lib/storage.js`,
the Plan-tab confidence indicator and the Routes-tab editor in `src/App.jsx`
(plus a new Rides Manager and Ride Editor), and the prediction call sites in
`src/lib/app.js` / `src/lib/prediction.js`. `windModel.js` is unchanged.

---

## 1. Motivation

The current learning module performs a single joint weighted least-squares
regression that recovers `baseline`, `kHead` and `kTail` simultaneously from
the ride log, with exponential recency decay. Two problems drive this refactor:

1. **The data is sparse and noisy, and the user has working knowledge that
   should shape it.** Today the ride log is effectively write-only from the
   user's perspective: rides flow into the model and only the fitted output is
   visible. The user needs to see, edit, include/exclude and annotate the
   recorded rides so they can curate what the model learns from.

2. **The still-air baseline is more stable and predictable than the k factors
   and should sit more centrally in the model.** Baseline (still-air time) is a
   property of rider fitness, observable from nearly every ride and pinned
   directly by any near-calm ride; it drifts slowly. The k factors are a
   property of route/bike terrain interaction, need *windy* rides per direction
   to estimate, and carry most of the uncertainty. The old joint regression
   lets a couple of noisy windy rides drag the baseline around. The refactor
   resolves **baseline first**, then computes **k conditional on baseline**.

---

## 2. Model

### 2.1 Form

Unchanged in form:

    predicted_time = baseline × (1 + k · wind_factor)

with asymmetric sensitivities: `kHead` applies when `wind_factor > 0`
(headwind, slower), `kTail` when `wind_factor < 0` (tailwind, faster), kinked
at `wind_factor = 0`.

What changes is determination: `baseline` and `k` are two **independently
toggled** quantities (manual ↔ learned); baseline is resolved first; k is
computed conditional on per-ride baselines.

### 2.2 wind_factor (existing — reference only)

`wind_factor` is a signed, dimensionless, time-weighted mean of signed-square
effort along the route (from `windModel.js`, unchanged):

    wind_factor = Σ tᵢ · f_norm(hᵢ) / Σ tᵢ
    f_norm(h)   = sign(h) · (h / W_REF_KMH)²        W_REF_KMH = 20
    h           = windSpeed · cos(windFromDeg − bearing)   (km/h, along-route component)

A uniform pure head/tailwind at 20 km/h over the whole route gives
`wind_factor = ±1`. The relationship between the intuitive "along-route wind in
km/h" and `wind_factor` is therefore **quadratic**: `wind_factor ≈ (h / 20)²`.
This is why the classification thresholds below are not round numbers.

### 2.3 Ride classification

Each ride is classified by `|wind_factor|`:

| class  | condition                              | ≈ along-route component | used for       |
|--------|----------------------------------------|-------------------------|----------------|
| still  | `|wf| < WF_STILL` (0.06)               | < 5 km/h                | baseline only  |
| gentle | `WF_STILL ≤ |wf| < WF_WINDY`           | 5–10 km/h               | neither        |
| windy  | `|wf| ≥ WF_WINDY` (0.25)               | ≥ 10 km/h               | k only         |

Classification rides on the net along-route effect already baked into
`wind_factor`. Consequences, both deliberate and accepted:

- A strong **crosswind** projects to `h ≈ 0`, so `wind_factor ≈ 0` and the ride
  is correctly classified **still** despite a high raw wind speed.
- A ride with strong **head and tail sections that average to near zero** also
  classifies still. The net effect is what the model predicts, so this is
  acceptable; noted so it reads as designed, not as a bug.

### 2.4 Per-ride baseline reference (current / historic)

k is a stable terrain property; baseline is a drifting fitness property.
Therefore a ride's k must be measured against the baseline **contemporaneous
with that ride**, not against today's (possibly fitter) baseline. Each ride
carries a `baselineRef` switch:

- **current** — the ride's k is measured against the **live configured
  baseline** and recomputes whenever that baseline changes. Correct for recent
  rides (today's fitness ≈ ride-day fitness).
- **historic** — the ride's k is measured against its own frozen
  `savedBaselineSec` and is inert to live baseline changes. Correct for old
  rides.

**Auto-freeze at 14 days.** When a ride's age reaches `FREEZE_AGE_DAYS` (14), it
freezes: snapshot the **live configured baseline at that instant** into
`savedBaselineSec`, set `baselineRef = historic`. The snapshot deliberately
captures up to two weeks of post-hoc baseline *refinement* (the user tweaking
the slider / accumulating still rides while the ride is still current) while
excluding later fitness *drift*. After 14 days the ride is settled: the switch
is **locked historic** and the UI control is disabled. There is no manual
override past 14 days, and no re-opening.

**Manual override before 14 days.** While age < 14 days the user may flick the
switch either way (in the Ride Editor):
- → historic early: freeze `savedBaselineSec` to the live baseline now.
- → current: re-attach to the live baseline; any previously frozen value
  becomes dormant (retained, unused) until/unless it freezes again.

**Implementation note.** The freeze is a *persisted state transition with a
side effect* (it writes `savedBaselineSec`), evaluated deterministically on app
load and whenever the ride list is (re)computed — not a display-time-only
calculation. The UI decides whether the switch is enabled purely from ride age
(`age ≥ 14 days` → disabled), so no extra "has frozen" marker is stored.

### 2.5 Baseline resolution

**Manual mode:** from the speed slider (km/h) → still-air seconds for the route
distance.

**Learned mode**, in priority order:

1. **≥ 1 still ride** → mean of still-ride times. (Windy and gentle rides
   ignored in this branch.)
2. **else windy rides with wind_factor spread ≥ `WF_BASELINE_SPREAD_MIN`
   (0.20)** → baseline by regression extrapolation to `wind_factor = 0` (the
   intercept). A larger spread is required here than for k (§2.6) because
   extrapolating an *intercept* back to zero from rides that all sit ≥ 0.25 away
   in magnitude is a lever-arm problem — sensitive to noise. *(This branch is a
   candidate for a low-confidence visual treatment; see §5.)*
3. **else** → fall back to the slider value.

A baseline is "learned" (and earns its dot, §4) only when it resolves on branch
1 or branch 2. Branch 3 is a fallback and does **not** count as learned.

### 2.6 k resolution (per direction, independent)

**Manual mode:** from the k slider.

**Learned mode**, per direction (head / tail):
- Uses **only windy rides** in that direction.
- Each windy ride uses **its own effective baseline** `bᵢ` — the live
  configured baseline if the ride is `current`, or its frozen
  `savedBaselineSec` if `historic`. There is no single global baseline in the k
  fit.
- **Gate:** ≥ 2 windy rides in the direction **and** wind_factor spread
  ≥ `WF_SPREAD_MIN` (0.06). If the gate fails, that direction's k falls back to
  the slider (and does not count as learned).
- **Estimator:** least-squares **through the origin** of

      (actualᵢ / bᵢ − 1) = k · wfᵢ

  fit separately for the head windy rides and the tail windy rides. Solving with
  a fixed per-ride baseline (rather than a free intercept) is what lets as few
  as 2–3 *varied* windy rides yield a usable k.

**Combined-k learned fit (see §3.2 for when this applies).** When k is combined
(not yet split) and in learn mode, all windy rides in *both* directions are
pooled into a single origin fit `(actualᵢ / bᵢ − 1) = k · wfᵢ`, giving one k
applied to both directions until the model splits.

### 2.7 Per-ride displayed k

For each ride, `k_ride = (actual / b − 1) / wf`, where `b` is the ride's
effective baseline (live if current, frozen if historic). It recomputes live
for `current` rides whenever the configured baseline changes.

- **still** rides → display "still" (no number; their `wf` is ~0 and k is
  meaningless).
- **gentle** rides → display the `k_ride` number, **greyed and marked "not
  used."**
- **windy** rides → display `k_ride`.

The same `k_ride` formula drives both the displayed per-ride number and (via the
origin regression) the learned k, so they are consistent; the learned aggregate
will differ slightly from a plain mean of the per-ride numbers because the
regression down-weights small-`wf` rides — this is expected and informative.

### 2.8 Clamp

A single fixed clamp `[K_MIN, K_MAX] = [0.05, 4.0]` applied everywhere k is
produced. The old count-widening band is removed.

### 2.9 Removed machinery

- **Exponential recency decay** (`halfLifeRides`, `decay`, the
  decay-then-accumulate update). Replaced by the per-ride current/historic
  baseline reference (§2.4) and explicit user curation (§3.3).
- **k count-widening clamp band** (replaced by §2.8).
- **The joint 3-parameter solve as the primary path.** Intercept regression
  survives only as baseline branch 2 (§2.5).
- The persisted `regressionState` accumulators (XtX / Xty) on each route. State
  is now derived live from the curated ride log.

### 2.10 Constants

| name                      | value | meaning                                       |
|---------------------------|-------|-----------------------------------------------|
| `WF_STILL`                | 0.06  | upper bound of "still" `|wf|`                 |
| `WF_WINDY`                | 0.25  | lower bound of "windy" `|wf|`                  |
| `WF_SPREAD_MIN`           | 0.06  | min `wf` spread to learn k (per direction)    |
| `WF_BASELINE_SPREAD_MIN`  | 0.20  | min `wf` spread to extrapolate baseline       |
| `W_REF_KMH`               | 20    | reference wind (existing, in windModel)       |
| `K_MIN`                   | 0.05  | k clamp lower                                 |
| `K_MAX`                   | 4.0   | k clamp upper                                 |
| `FREEZE_AGE_DAYS`         | 14    | age at which a ride freezes to historic       |

---

## 3. Routes tab — the big refactor

### 3.1 Manual / learn switch per visible slider

Add a manual/learn switch to **each slider currently exposed to the user**:

- **Baseline** (speed) slider → one switch.
- **k** slider → one switch while k is combined. When k is split (§3.2) the
  single k slider becomes two sliders (kHead, kTail), **each with its own
  switch**.

So there are two switches in combined mode (baseline, k) and three when split
(baseline, kHead, kTail). The model always has three learnable quantities; the
combined-k switch drives both kHead and kTail together via the pooled fit
(§2.6).

**Explanatory text under each switch**, three states, quantity-specific:

- **manual** → "using your setting"
- **learn, not enough rides** → "using your setting until enough rides recorded"
- **learn, enough rides** → "calculated from X rides"

`X` is the count of rides actually feeding *that* quantity:
- baseline: the still-ride count (branch 1) or the windy-ride count (branch 2).
- each k direction: the windy rides in that direction.
- combined k: the pooled windy rides (both directions).

### 3.2 k split — manual and automatic

k can be split into kHead/kTail by two triggers:

- **Manual:** the user checks the split box. Works in either mode. In learn
  mode with only one direction qualifying, that direction learns and the other
  falls back to its slider.
- **Automatic (learn mode only):** when **both** directions independently pass
  the k gate (§2.6: ≥ 2 windy rides and spread ≥ `WF_SPREAD_MIN`, each side),
  k splits automatically and surfaces the two sliders/switches. "Enough rides to
  differentiate" is exactly the both-sides-qualify condition.

At the combined→split transition the applied k changes (pooled value → two
directional values). This is a visible, intended jump.

**Un-split:** in learn mode, once both directions qualify, the split is forced
and the un-split control is **disabled** (re-combining would be immediately
overridden, so disabling is the honest representation). Manual un-split is only
available in manual mode, or in learn mode before both directions qualify.

### 3.3 Rides Manager (new)

A new **Rides Manager** button per route opens the list of that route's rides.

**List columns** (kept narrow for phone width):

| column         | content                                                        |
|----------------|----------------------------------------------------------------|
| date           | ride date                                                      |
| time           | ride start time                                                |
| length         | recorded ride duration                                         |
| k              | per-ride k (§2.7): "still", a greyed number (gentle), or a number (windy) |
| class          | windy / gentle / still                                         |
| include        | checkbox (include/exclude)                                     |
| edit           | icon → opens Ride Editor (§3.4)                                |

**Default include state by class:**
- **gentle** → default **excluded** (used in neither calculation), can be
  included by checking the box.
- **still / windy** → default **included**, can be excluded by unchecking.

The list **reflects** each ride's current/historic state (it determines the k
shown — live vs. frozen baseline) but does **not** surface or edit that switch
inline; that control lives in the Ride Editor to save horizontal space.

**Curation** replaces automatic decay: include/exclude per ride, plus the
"exclude this ride and all earlier" affordance (a quick way to drop a stale
training era). See §3.5.

### 3.5 "Exclude this ride and all earlier"

A bulk-curation action for dropping a stale training era in one step.

**Behaviour.** Sets `included = false` on the selected ride **and** every ride
on this route with an **earlier timestamp** (ordering by ride timestamp, not
list position; the selected ride is itself included in the exclusion). It is
**reversible** — it only flips the `included` flag, so affected rides can be
re-included individually afterwards (or via an "include all" affordance if one
is offered). It is **not** destructive; deletion (§3.4 A) remains the only
destructive action.

**Confirm step.** Because it can flip many rides at once, it opens a confirm
dialog stating the count, e.g. "Exclude this ride and 6 earlier rides?"

**Surfaces (two):**
- **Ride Editor — primary.** A dedicated button beside the per-ride
  include/exclude toggle. This is the discoverable, deliberate home for the
  action.
- **Rides Manager list — shortcut.** A **long-press** on a row's
  include/exclude checkbox opens the same confirm dialog. A power-user
  shortcut; discoverability does not rest on it because the editor is the
  primary surface. The long-press must open the confirm dialog (never act
  immediately), to guard against accidental triggering on what is normally a
  tap target.

### 3.4 Ride Editor (new)

Opened from the edit icon. Allows the user to:

- **A. Delete the ride** — removes the record entirely (distinct from exclude).
  Destructive and unrecoverable → confirm step.
- **B. Toggle include/exclude** — same state as the list checkbox. Also hosts
  the **"exclude this ride and all earlier"** button (primary surface for the
  bulk action, §3.5).
- **C. Toggle the current/historic baseline switch** — enabled and toggleable
  while ride age < 14 days; **disabled and locked historic** at age ≥ 14 days
  (§2.4).
- **D. Edit the recorded ride duration** (`actualSec`). Editing duration
  recomputes the ride's `k_ride` and, if the ride is windy and included, re-fits
  the learned k. **Classification is unaffected** (it derives from
  `wind_factor`, which does not change). **Distance is not editable.**

---

## 4. Plan tab — confidence dots

**Remove** the numeric ride-count displayed beside the dots on the ground-effect
line. The three dots are the only indicator.

**Dot count (0–3):** one filled dot for each of **baseline, kHead, kTail** that
is currently being **served from ride data** — i.e. its switch is on *learn*
**and** it has enough data to actually learn (it is not falling through to the
slider).

- baseline → dot when learned via branch 1 or 2 (§2.5); no dot on branch 3 or
  when manual.
- kHead / kTail → dot when that direction's k gate passes in learn mode; no dot
  when falling back to slider or when manual.
- **Combined-k earns at most one dot.** Two k-dots require the data to have
  forced (or the user to have manually split with both sides qualifying in learn
  mode) an actual split, with kHead and kTail each learned from their own
  direction. "2 k-dots" and "auto-split happened" are the same condition.

Therefore:
- all manual → 0 dots
- all learn but none has enough data (all fall back to slider) → 0 dots
- max 3 dots, reachable only when k has split and baseline + both directions are
  all learned.

**Implementation note.** The model must expose, per quantity, whether it
resolved from rides or from the slider (e.g. each of baseline/kHead/kTail
reporting a `source: "learned" | "slider"`), so the UI counts sources rather
than re-deriving identifiability. This replaces the old
`confidence()`/`kLevel`/ride-count path feeding `ConfidenceDots`.

---

## 5. Open / deferred UI nicety

The extrapolated-baseline case (branch 2, §2.5) is a softer estimate than a
still-ride mean. A low-confidence visual treatment (distinct dot styling, or a
note in the switch's explanatory text) is *optional* and deferred — not required
for a correct implementation.

---

## 6. Ride tab

**No changes** in this refactor.

---

## 7. Data model & migration

### 7.1 Ride record fields

Each ride stores:

- `windFactor` — the ride's wind_factor (observation).
- `actualSec` — recorded duration (editable, §3.4 D).
- ride timestamp — for age / 14-day freeze and list display.
- `included` — curation include/exclude state.
- `baselineRef` — `"current" | "historic"`.
- `savedBaselineSec` — frozen still-air baseline, written when the ride freezes
  to historic (auto at 14 days, or on a manual early flip to historic).

Classification (still/gentle/windy) is derived from `windFactor` and need not be
stored (may be cached for display).

### 7.2 Route / model state

The persisted per-route `regressionState` (XtX/Xty accumulators, `halfLifeRides`)
is **removed**. Learned baseline and k are derived live from the curated ride
log on demand. Routes retain their settings, which together form the **config**
the resolver consumes: still-air baseline (slider), k slider value(s), the two
manual/learn modes (`baselineMode`, `kMode`), and the manual split flag.

Config shape consumed by the resolver:

    {
      baselineMode:      "manual" | "learn",
      sliderBaselineSec: number,            // still-air seconds from the speed slider
      kMode:             "manual" | "learn",
      split:             boolean,           // user's manual split checkbox
      sliderKHead:       number,
      sliderKTail:       number,
    }

**New-route defaults.** New routes start in **learn** for both `baselineMode`
and `kMode`, `split` false, with the k sliders seeded from the user's setup
estimates (their entered head/tail times via `seedKSplit`; `1.0` only if none
given). With no rides the resolver falls back to those slider values, so the
prediction is identical to manual on day one — but the route then begins
learning automatically as rides accumulate, with no toggle for the user to flip.
Legacy routes lacking the mode fields resolve as learn too (consistent with new
ones; harmless under the clean-slate ride migration). The ephemeral example/
onboarding route is also **learn/learn**, to mirror exactly what a user sees by
default; its Manual/Learn toggles and the "until enough rides recorded" status
are themselves explanatory, illustrating the difference between the modes. The
example has no rides, so learn falls back to the sliders (identical prediction);
its mode toggles persist in memory only and reset on reload.
### 7.3 Migration

**Clean break — losing learned state is acceptable.** On encountering old data,
wipe whatever does not fit the new model: drop `regressionState` and any decay
state; drop or ignore rides that lack the fields needed for the new log. Routes
and user settings (speed, k, mode switches) are preserved. Learned state is then
rebuilt from whatever valid rides remain, or starts empty. No migration shim is
required.

---

## 7A. Implemented `learning.js` API

The module is pure: it consumes a ride log and a config and returns resolved
values. It persists nothing and imports nothing from storage. Exact signatures
as built:

**Constants** (exported): `WF_STILL` 0.06, `WF_WINDY` 0.25, `WF_SPREAD_MIN`
0.06, `WF_BASELINE_SPREAD_MIN` 0.20, `K_MIN` 0.05, `K_MAX` 4.0,
`FREEZE_AGE_DAYS` 14, `FREEZE_AGE_MS`.

**Ride record fields consumed:** `windFactor`, `actualSec`, `included` (treated
as included unless `=== false`), `baselineRef` (`"current"|"historic"`),
`savedBaselineSec`, `startedAt` (epoch ms).

- `classifyRide(windFactor) → "still"|"gentle"|"windy"`
- `clampK(k) → number|null` — single fixed `[0.05, 4.0]` clamp.
- `isFrozenByAge(ride, nowMs?) → boolean` — true at age ≥ 14 days.
- `applyFreeze(ride, liveBaselineSec, nowMs?) → ride` — pure; if a current ride
  is ≥14 days old, returns a copy with `baselineRef = "historic"` and
  `savedBaselineSec` snapshotted to `liveBaselineSec`. Otherwise returns the
  same reference. The caller persists any changed ride.
- `effectiveBaseline(ride, liveBaselineSec) → number` — frozen value if
  historic, else live.
- `rideK(ride, liveBaselineSec) → number|null` — per-ride displayed k
  `(actual/b − 1)/wf` against the effective baseline; null for still (`wf≈0`).
- `resolveBaseline(includedRides, sliderBaselineSec) → { baselineSec, source:
  "learned"|"slider", branch: 1|2|3, ridesUsed }`.
- `resolveK(includedRides, liveBaselineSec, { kMode, split, sliderKHead,
  sliderKTail }) → { kHead, kTail, sourceHead, sourceTail, split, autoSplit,
  ridesHead, ridesTail }`.
- **`resolveModel(allRides, config, nowMs?)`** — the top-level entry. Resolves
  baseline (using the slider as the contemporaneous live value for young current
  rides), applies the freeze to every ride, then resolves k conditional on
  per-ride effective baselines. Returns:

      { baselineSec, kHead, kTail,
        baselineSource, kHeadSource, kTailSource,
        split, autoSplit, baselineBranch,
        ridesBaseline, ridesHead, ridesTail,
        rides }   // rides with freeze transitions applied — PERSIST these

- `dotCount(resolved) → 0..3` — counts `"learned"` sources; combined-k yields at
  most one dot, split-with-both-learned yields two.
- `predictFromModel({baselineSec, kHead, kTail}, windFactor, opts?) →
  { predictedSec, baselineSec, k, kHead, kTail, multiplier, clamped }` — keeps
  the physical speed clamp (walking-pace headwind floor, `speedCapMult` tailwind
  ceiling). `opts`: `distanceM`, `walkPaceKmh` (5), `speedCapMult` (3),
  `multMaxFallback` (6).
- `predict(allRides, config, windFactor, opts?, nowMs?)` — convenience:
  `resolveModel` then `predictFromModel`; also returns `provisional` (true when
  all three quantities fell back to slider), `resolved`, and `rides`.

**Caller responsibility — persisting freeze transitions.** `resolveModel` and
`predict` return a `rides` array with the current→historic freeze applied. The
storage/controller layer must write back any ride whose `baselineRef`/
`savedBaselineSec` changed, so the freeze is durable rather than recomputed each
load.



- `src/lib/learning.js` — **DONE.** Rewritten around §2 / §7A: classification,
  baseline resolution (3 branches), per-ride-baseline origin k fit (per direction
  + pooled combined), single clamp, per-quantity `source` reporting, freeze
  machinery, dots, no decay, no persisted accumulators.
- `src/lib/app.js` — **DONE (controller).** `regressionState` threading replaced
  with live derivation via `modelInputsFor` + `resolveModel`; dots/confidence
  from resolved sources; `routeTuning` resolves live; new `ridesForManager` and
  ride-curation methods exposed; outlier/recompute paths removed; 14-day freeze
  persisted via `persistResolved`. (UI in App.jsx is separate — see below.)
- `src/lib/prediction.js` — **DONE.** `makePredictor` consumes `{ rides, config }`,
  resolves the model once at construction (exposed as `.resolved`), and the
  ensemble loop uses pure `predictFromModel`.
- `src/lib/storage.js` — **DONE.** Ride record schema (§7.1), route config fields
  (§7.2), `routeConfig`/`resolveRouteModel`/`getRide`/`updateRide`/`deleteRide`/
  `excludeRideAndEarlier`, clean-break `normalizeRides` migration (§7.3); model
  accumulator store no longer written.
- `src/App.jsx` — **PENDING (the UI pass).** Per-slider manual/learn switches +
  explanatory text (§3.1), k split control with auto-split + disabled un-split
  (§3.2), new Rides Manager (§3.3) and Ride Editor (§3.4), Plan-tab dots from
  quantity sources (§4), remove the numeric ride count. NOTE: the `confidence`
  object shape changed (now `dots`/`baselineLearned`/`kHeadLearned`/`kTailLearned`
  rather than `level`/`kLevel`/`idHead`/`idTail`), so `ConfidenceDots` and the
  route-editor manual/learned display must be updated; until then the app will
  not render correctly in the browser even though the logic layer is complete.

---

## 9. Tests

**Status: DONE — full suite green (280 passed, 0 failed across 15 files).**

`testlearn.mjs` was rebuilt for the new model (53 cases): classification
thresholds incl. the crosswind→still case; clamp; freeze-by-age and
`applyFreeze` (snapshot at freeze instant); effective baseline + per-ride k for
current vs. historic; baseline branches (still mean, windy intercept with the
stronger spread gate, slider fallback); manual / combined-learn / auto-split /
manual-split-one-side-short k resolution; per-ride-baseline k fit using frozen
baselines; freeze transitions returned for persistence; dot counts (0 manual,
0 starved, 2 baseline+combined-k, 3 full split); prediction speed clamp;
provisional flag.

Migrated to the new API:
- `teststorage.mjs` (38) — config init, rides persist with curation/baseline-ref
  fields, `resolveRouteModel` learning, manual mode ignores rides, curation
  (exclude / edit duration / exclude-and-earlier), 14-day freeze persistence,
  cascade delete, export/import (no model records now), reorder.
- `testapp.mjs` (26) — config-seeded route, verdict + new `confidence` shape,
  real `recordRide` path in learn mode resolving via `routeTuning`, excluded
  ride ignored by the resolver.
- `testintegration.mjs` (15) — `makePredictor({ rides, config })`.
- `testtuning.mjs` (10) — `routeTuning` learned-object shape + dots.
- `testnoise.mjs` (6) — resolver noise robustness; additionally stress-validates
  branch-2 baseline extrapolation on windy-only noisy data (recovers ~1s).

Retired from the old model: joint kHead/kTail recovery from `fitModel`,
online==rebuild, exponential decay, outlier auto-flag.

Per project convention, run the full suite (`node test*.mjs`) and verify App.jsx
brace/paren/div balance after the UI pass.

---

## 10. Implementation status (checkpoint)

Logic + data layer **complete and tested**; UI pass **complete** (bundles clean,
all suites green).

| Module | Status |
|--------|--------|
| `learning.js` | Done — new resolver model, 53 tests |
| `prediction.js` | Done — resolve-once predictor |
| `storage.js` | Done — config + curation + freeze persistence |
| `app.js` (controller) | Done — resolver wiring, ride-manager + curation API |
| All `test*.mjs` | Done — 280 passing |
| `App.jsx` (UI) | Done — per-control Manual/Learn pills (read-only-while-learned), auto-split with disabled un-split, Rides Manager + Ride Editor full-screen overlays, dots rewired to the new shape, ride count removed from Plan |

### UI notes (as built)
- Each tuning control (still-air speed, ground effect, and the two split k
  sliders) carries a two-segment **Manual | Learn** pill. A control is read-only
  only when its source is actually `"learned"`; in Learn-but-starved it stays
  editable (it is the fallback the model uses). The status line ("using your
  setting" / "using your setting until enough rides recorded" / "calculated from
  N rides") sits **immediately under the value, above the 20 km/h example** — for
  both the speed control and each ground-effect slider. When split, each slider
  shows its own direction's source.
- Split: manual checkbox, or auto-fires in Learn once both directions qualify,
  at which point the checkbox is disabled and labelled "(learned separately)".
- **View rides** is an inline fold/unfold control (not a full-screen overlay)
  that expands the ride list in flow within the editor. The per-ride **Ride
  Editor** (✎) remains a full-screen overlay.
- Ride list columns: date/time, length, k, class, include checkbox, edit.
  Gentle rides show their k greyed; still shows "still". Footer note: "Gentle
  rides default to unused." Long-press the include checkbox → "exclude this ride
  and all earlier" (confirm dialog).
- **New-ride used/unused is set at record time from classification:** still and
  windy default to used, gentle defaults to unused (an explicit `included` on
  the capture overrides this). The flag is baked into the stored record, not
  just displayed.
- **Editor buttons:** **Cancel** and **Apply** sit *above* View rides. Apply
  persists but does **not** close the editor — it is closed by tapping the route
  chip again, opening another route, or switching tab. Cancel **reverts** all
  unsaved edits to the last-applied state. Both start disabled; any change
  enables both; tapping either (Apply persists + re-snapshots; Cancel reverts)
  disables both until the next change.
- The current/historic switch in the Ride Editor is disabled + locked historic
  at 14 days, with explanatory copy.
- Editing a slider no longer wipes ride history; `resetRoute` is not called from
  the editor any more. Edits persist via `updateRoute` only.

The refactor is functionally complete end to end.
