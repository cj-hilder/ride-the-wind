# v1.4.0 — Units & Formatting Settings (SPEC, for review)

Status: **draft for Chris to review/amend before implementation.** Nothing built yet.

## Goal
Let the user choose display units and formats. Every value shown to the user
passes through one of a small set of pure format functions, so the preference is
honoured everywhere and there is a single place to change each format.

## User-facing preferences (EIGHT settings)
| Setting | Options | Default |
|---|---|---|
| Temperature | °C / °F | °C |
| Time of day | 24-hour / 12-hour | 12-hour |
| Duration (≥1 h) | `90 min` / `1 hr 30` / `1:30` | `1 hr 30` (form 2) |
| Ride speed | km/h / mph | km/h |
| Wind speed | km/h / mph / kt | km/h |
| Distance | km / mi | km (independent of ride-speed) |
| Rainfall | mm(/h) / in(/h) | mm |
| Decimal separator | dot `.` / comma `,` | dot |

**Duration (locked):** under 1 h → always `«mins» min`. At ≥1 h: (1) `«total mins»
min`; (2) `«hours» hr «mins, leading zero»` (`1 hr 30`); (3) `«hours»:«mins, leading
zero»` (`1:30`). Default = form 2. Leading-zero minutes in forms 2 & 3 only.

**Time of day 12 h:** lowercase am/pm — `8:45 am`, `8:45 pm`. Noon = `12:00 pm`,
midnight = `12:00 am`.

**Decimal-place rules (locked):**
- Distance & speed: the SAME dp regardless of unit (mi mirrors km's dp; mph/kt
  mirror km/h's dp — today all whole numbers → whole in every unit).
- Rainfall: **inches use one more dp than mm** (`in-dp = mm-dp + 1`), because an
  inch is ~25× a mm. Today mm shows 1 dp → in shows 2 dp.

**Date:** OMITTED from 1.4.0 (deferred to full-i18n).

All design questions are resolved (see the decision list at the end); this spec
is ready to build.

## Architecture: the format seam

A new pure module `src/lib/format.js` exports one function per display category.
Each takes the **canonical value** (the units the app stores/computes in) plus the
current settings, and returns a display string. Canonical units stay exactly as
today — **settings never change stored or computed data, only display** (same
principle as the speedo needle: display-only).

Canonical units (unchanged):
- temperature: °C
- speed: m/s internally / km/h at the boundary — at build time, verify per call
  site which unit the value is in before passing to the formatter (canonical
  passed to `formatRideSpeed`/`formatWindSpeed` is km/h).
- duration & time: ms / seconds / epoch ms
- rainfall: mm and mm/h

Functions:
```
formatTemperature(celsius, s)        → "12°C" | "54°F"
formatTimeOfDay(epochMs, s)          → "08:45" | "8:45 AM"
formatElapsed(seconds, s)            → "9 min" | "90 min" | "1 hr 30" | "1:30"
formatRideSpeed(kmh, s)              → "24 km/h" | "15 mph"
formatWindSpeed(kmh, s)              → "22 km/h" | "14 mph" | "12 kt"
formatDistance(km, s, {dp})          → "5.2 km" | "3.2 mi"   (dp mirrors call site)
formatRainfall(mm, s, {rate})        → "1.2 mm" | "0.05 in"  (converts; rate flag adds /h)
```
(No `formatDate` in 1.4.0.) `formatRainfall` CONVERTS mm↔in (`in = mm/25.4`) with
in-dp = mm-dp + 1, and applies the decimal separator. `rate:true` appends the
per-hour suffix (`mm/h` / `in/h`).
Where `s` is an OPTIONAL explicit settings override; normally omitted, and the
function reads the module-level snapshot (see "Wiring", option B — approved).

## Input adaptation — the INVERSE seam (baseline-speed spinner)
Everything above is output (canonical → display). The **baseline-speed spinner**
is input (display → canonical) and needs the inverse:
- The spinner shows and steps in the user's **ride-speed unit** (km/h or mph),
  but the app still stores canonical **km/h**.
- **Step is 0.5 in the display unit regardless of unit** (0.5 km/h or 0.5 mph).
  Consequence (intended): entered in mph, the stored km/h won't be "round" (0.5
  mph ≈ 0.805 km/h) — fine, stored to full precision, only displayed rounded.
- To avoid round-trip drift, the spinner holds its value in **display units while
  open** and converts to canonical **once on commit** (never re-derive from a
  rounded display each render).
- `format.js` gains an inverse helper: `rideSpeedToCanonicalKmh(displayVal)` and
  `rideSpeedStep()`/`rideSpeedBounds()` returning step & min/max in display units.
- min/max bounds convert too (resolved), so the physical range is identical —
  only the numbers + step-unit change.

The **decimal separator** is applied centrally inside these functions (a single
`sep(numStr, s)` helper), so no call site formats numbers raw. This is why even
rainfall/speed with a dot today must route through the seam.

## Conversions (canonical → display)
- °C→°F: `c*9/5+32`, round to integer (temps shown as whole degrees today).
- km/h→mph: `*0.621371`. km/h→kt: `*0.539957`. Same dp as km/h (today whole → mph/kt whole).
- km→mi: `*0.621371`, same dp as the km call site. mm→in: `/25.4`, in-dp = mm-dp+1.
- Duration: <1 h → `«mins» min`; ≥1 h → form 1 `«mins» min` / form 2 `«h» hr «mm»` /
  form 3 `«h»:«mm»` (default form 2; leading-zero minutes in forms 2 & 3).
- Time of day 12 h: `8:45 am` / `8:45 pm` (lowercase, drop leading hour zero;
  noon `12:00 pm`, midnight `12:00 am`).

## The 134 call sites
A grep finds ~134 places doing `toFixed`, `°C`, `km/h`, `getHours()/padStart`,
`mm/h`, `min`, etc. Implementation replaces each with the matching format call.
High-value clusters:
- Ride screen: needle km/h, average, elapsed, arrival clock time, what-to-expect
  temp/rain, GPS-init %, off-route km.
- Plan screen: arrival time, countdown, verdict times, what-to-expect line,
  wind effect phrase.
- Route editor: still-air time, ground-effect example times.
- Rides list / debug panel: dates (deferred), durations, rain figures, wind. The
  debug rain section — measured `rain peak rate · total`, `wettest forecast`, AND
  the band-threshold hint line — all convert to in/h together when in/h selected
  (whole section in one unit). Band constants convert via the same in-dp = mm-dp+1
  rule (so `0.1 / 1.75 / 3.5 mm/h` → e.g. `0.004 / 0.069 / 0.138 in/h`); accept the
  small-number ugliness as the cost of consistency, since a user on in/h wants the
  reference in their unit.
- Recorder: elapsed, distance (now `formatDistance`), and the baseline-speed
  spinner INPUT (inverse seam — see above).

Rainfall is a full unit conversion (mm↔in) plus separator; date is deferred.
These flow into the debug panel's rain rows and the "wettest forecast" line too
(all currently hard-code mm → route through `formatRainfall`).

## Wiring the settings into the functions **(B — APPROVED)**
`format.js` holds a cached settings object, updated via `setFormatSettings(s)` at
startup and whenever settings change. Call sites call `formatRideSpeed(kmh)` with
no settings arg — the function reads the snapshot. Each function ALSO accepts an
optional explicit settings arg used only by tests (arg overrides snapshot), so
tests stay pure without touching global state. One data-specific function per
type (temperature, time-of-day, elapsed, ride-speed, wind-speed, distance,
rainfall) plus the inverse speed helper; no god-function.

## Storage
Settings persist in the existing KV store (`getSetting`/`setSetting`,
`STORES.SETTINGS`) — the same place `conservatismPct` lives, and already included
in backup/export/import. Single `displayUnits` object (one read/write, easy
backup): `{ temp, clock, duration, rideSpeed, windSpeed, distance, rainfall,
decimal }`. Absent in 1.3.0 backups → functions fall back to defaults.

## UI: Help vs Settings **(item 1)**
Replace the single "Help & getting started" button with **two buttons, "Help" and
"Settings", side by side** (two columns). Settings opens a new `SettingsPanel`
(sibling to `HelpPanel`), same slide-over style. Each preference is a labelled row
with a segmented control (reuse the existing `ModePill`-style pills for the 2–3
option toggles). A live **preview line** at the top ("Sample: 24 km/h · 12°C ·
08:45 · 1 hr 30") updates as the user toggles, so the effect is visible
immediately.

## Testing
`format.js` is pure → a `testformat.mjs` suite: every function × every option,
boundary cases (12:00 noon/midnight in 12 h, exactly 1 h duration, 0°C→32°F,
negative °C, decimal-comma on each numeric type). No display-value assertions
elsewhere need changing if call sites delegate correctly, but a few existing
tests assert literal strings (e.g. "14°C", "24 km/h") — those move to asserting
the **canonical** value or the default-settings format.

## Migration / back-compat
Two defaults now DIFFER from today's output (both deliberate — nicer defaults
over zero-change-on-upgrade): durations ≥1 h default to form 2 (`1 hr 30`, was
`90 min`), and time-of-day defaults to **12-hour** (`8:45 am`, was `08:45`). All
other defaults (°C, km/h, km/h, km, mm, dot) match today exactly. Backup files
from 1.3.0 have no `displayUnits` key → defaults apply, so an upgrading user will
see the new clock and duration formats on first launch.

## Out of scope for 1.4.0 (noted, not built)
- Full i18n / translated UI strings (units & number format only; glossary/language
  work is separate — your list's #8).
- Date formatting (deferred to the i18n work).
- Per-value overrides; only global preferences.

## Decision list — all resolved, ready to build
Q-dur (three forms; **default form 2** `1 hr 30`), Q-scope (rainfall in as a UNIT,
date deferred), Q-distance (in, independent), Q-wiring (B — module snapshot +
optional test arg), Q-storekey (single `displayUnits` object, 8 keys),
Q-speedround (same dp per unit; rain in-dp = mm-dp+1), Q-ampm (lowercase am/pm),
Q-btnlayout (side by side), Q-preview (yes), baseline-speed INPUT inverse seam
(0.5 steps in display unit), Q-rainbands-hint (CONVERT the hint line to in/h too —
whole debug rain section in one unit), Q-baseline-range (CONVERT the spinner's
min/max bounds with the step — identical physical range, display unit only).

**Defaults that differ from today (deliberate):** time-of-day → **12-hour**;
duration ≥1 h → **form 2** (`1 hr 30`). All other defaults match today's output.

## Prose pass (FINAL threading pass — deferred until all standalone readouts done)
Values embedded inside generated sentences, handled together as one pass so the
lib/component boundary is treated consistently (some originate in lib functions
that currently return finished strings). Running checklist:
- `expect.line` (what-to-expect: temp / rain / wind embedded) — plan & ride screens.
- `windEffectPhrase` — "31% chance headwind: ride for 116 to 154 mins (likely 132
  mins)"; three durations → formatElapsed. In App.jsx (component), tractable.
- `countdownPhrase` — "in 2 hours 5 mins" (embedded duration).
- `exploredHHMM` — Explore picker's custom-time echo ("arrive by 09:15"); a
  user-entered value at the input/display boundary — decide format handling.
- "X km away from start/end" and off-route distance — embedded distance.
- **Example-ride wind caption** (TerrainSlider): "example ride, steady 20 km/h
  wind from [dir]". RULE: the example wind shows a ROUND value per unit —
  **20 km/h, 15 mph, 10 kt** — NOT a literal conversion of 20 km/h (which would be
  12.4 mph / 10.8 kt). Like the speedo dial numbers, it's a nominal round example.
  **Subtlety to resolve:** the 20 km/h is ALSO the actual wind speed FED INTO the
  example ride-time calc (headFactor/tailFactor). So either (a) cosmetic label
  only — times still reflect ~20 km/h regardless of the label shown (mild
  mismatch, like a rounding), or (b) recompute the example at 15 mph / 10 kt so
  the shown wind and the shown times agree. Decide during the pass; (b) is the
  honest choice if the discrepancy is noticeable, (a) is simpler.

Rule of thumb: standalone readouts convert at the display point (done per-cluster);
embedded-prose values either format in the component (if the string is built there)
or need the lib to return raw values / take formatters (if built in a lib). Keep
each item fully done, never half.
