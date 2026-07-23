# "Forecast details" panel refactor (SPEC — ready to build)

Status: BUILT (1.5.0). Presentation-only change to the plan-tab diagnostic
panel (currently "Tech info"). No model/learning changes. Target: 1.5.0.

## Intent
Rename the panel and make it tell one coherent story: what the forecast says,
then how we get from that forecast to the predicted ride time. The panel already
walks forecast → geometry → equivalent wind → (factor); the changes below fix
the two least-intuitive steps at the end so a non-technical commuter can follow
the whole chain.

## 1. Panel title
"Tech info" → **"Forecast details"**.

## 2. The transformation chain (order of rows, top to bottom)
Unchanged through the geometry section; only the tail changes.

1. `wind: 15 km/h W (256°)`            — raw forecast (speed + direction)
2. `route avg bearing: 185°`
3. `mean headwind|tailwind: 4 km/h`    — raw along-route component (unsigned; dir in label)
4. `mean crosswind: 10 km/h`           — raw perpendicular component
5. `equivalent headwind|tailwind: 6 km/h`         — see §3
6. `ground effect equivalent headwind|tailwind: 3 km/h`  — see §4  [NEW LINE]
7. `time effect: +8.3%`                — see §5  (was "wind factor")

(Ordering note: keep crosswind BEFORE the two equivalent-wind lines so the raw
geometry (head + cross components) sits together, and the equivalent-wind pair
+ time effect form the "how this becomes ride time" tail. If the current order
has crosswind after equivalent wind, move it up so 3–4 are the raw components
and 5–7 are the derivation.)

## 3. Equivalent wind (row 5) — raw, k=1
Value: `effortHeadwindKmh` (unchanged source). Unsigned number, direction in the
label ("equivalent headwind" / "equivalent tailwind") — matching the mean-wind
row style. Keep the existing opposes-the-mean edge case: if its sign genuinely
opposes the mean wind (mixed route, asymmetric curve tips the net), keep an
explicit "(head)"/"(tail)" tag so the reversal is visible.

Description (caption under the row) — REPLACE current text with:
> the steady headwind|tailwind that matches the forecast's overall effect on
> this route

(Pick head/tail word to match the row's own direction.)

## 4. Ground effect equivalent wind (row 6) — NEW, k-adjusted
Value: `equivalent wind × k` for the row's direction = `feltWindKmh` (already
computed and carried on windEffect / derivable in debug as
`|effortHeadwindKmh| × kDir`). Add the underlying number to `debug` so the panel
can render it directly:
- `debug.feltEquivWindKmh` = signed, = `effortHeadwindKmh × (effortHeadwindKmh≥0 ? kHead : kTail)`, 2dp.

Label: **"ground effect equivalent headwind|tailwind"** (incorporates the
established "ground effect" name for k). Unsigned number, direction in label,
same opposes-the-mean tag rule as row 5. Same head/tail direction as row 5
(k scales magnitude, doesn't flip direction).

Description:
> the ground effect adjusted equivalent wind — the wind that actually affects
> your predicted ride time

Rationale: k is NOT re-displayed here (it's already shown on the plan tab
outside this panel, per Chris). Rows 5→6 show the before/after of ground effect
implicitly (6 is visibly smaller when sheltered), and the caption names it.

Visibility: show row 6 whenever row 5 shows (both gated on
`effortHeadwindKmh != null`). When k ≈ 1 (exposed route) rows 5 and 6 will read
nearly equal — that's correct and informative, not a bug.

## 5. Time effect (row 7) — was "wind factor"
Label: "wind factor" → **"time effect"**.
Value: the fractional time change as a **percentage, 1 decimal place, signed**:
`+8.3%` (slower) / `−3.2%` (faster). Source unchanged (`debug.windFactor`, the
k-applied fractional effect) × 100. Drop the raw decimal and the
"(slows)/(speeds)" word — the sign carries it (＋ = slower, − = faster); keep a
tiny "+ = slower" hint only if space allows, else omit.

## Out of scope
- k row inside the panel (deliberately omitted — shown on plan tab).
- Any change to how equivalent wind / feltWind / time effect are computed.
- Crosswind/gust wording elsewhere.

## Tests
- debug exposes `feltEquivWindKmh`, magnitude ≤ |equivalent wind| (k ≤ ~1) and
  = |equiv|×k within rounding; sign matches equivalent wind.
- time-effect percentage = windFactor×100 to 1dp, sign preserved.
- existing tech-panel reconciliation test (effortNorm(effortHead) ≈ windFactorK1)
  still holds — unaffected (raw equivalent unchanged).
