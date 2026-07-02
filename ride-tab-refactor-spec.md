# Ride the Wind — Ride / Route-Creation Refactor Specification

Status: design agreed, ready for implementation.
Scope: the route-creation flow (Setup), the Ride/Capture tab, the Rides Manager
(manual ride entry), and a new "record route by GPS" capability. Builds on the
completed learning refactor (see `learning-refactor-spec.md`); the learning model
and curation behaviour are unchanged here.

This spec covers five features:
1. Rename "Add route" → "New route".
2. Setup uses the same Manual/Learn controls as the editor (consistency).
3. New-route creation offers three ordered methods: record by GPS, reverse an
   existing route, or import a GPX file.
4. Manual ride entry (start/finish times) in the Rides Manager.
5. Extra live readouts on the Ride tab: clock, current speed, average speed, and
   a (deliberately naive) route-progress bar.

---

## 1. Rename "Add route" → "New route"

Pure wording. The Setup screen heading already reads "New route"; sweep any
remaining "Add route" / "Add a route" strings (e.g. the empty-state hint "Add a
route in the Routes tab to see your morning verdict" → "Create a route…" or "Add
a new route…", wording TBD but not "Add route" as a button label). No
behavioural change.

---

## 2. Setup consistent with editing (Manual/Learn controls)

Today the Setup screen renders a simplified always-manual `TerrainControls`
(no Manual/Learn pills). The editor renders the full version with per-control
pills. Make Setup use the **same control set as the editor**:

- New routes already default to **learn/learn** in the data model. Setup shows
  the **Manual | Learn pills visible and toggleable** for baseline and ground
  effect (and the k-split control), exactly as the editor does.
- At setup there are normally **zero rides**, so every learned control falls
  back to the slider and the status line reads "using your setting until enough
  rides recorded"; the sliders stay editable (they are the fallback the model
  uses). A user with a firm number can flip a control to Manual at setup.
  (**Exception:** a route created by recording via GPS (3A) arrives with exactly
  **one** ride — the recording traversal itself — so a learned control may
  already reflect that single ride. See 3A.)
- This means extracting/sharing the editor's tuning UI so Setup and RouteEditor
  render the identical component with identical behaviour (pills, read-only-
  while-learned, split auto/manual, source notes). The goal is that tuning a
  route looks and behaves the same whether creating or editing.

No change to the learning model or defaults; this is UI consolidation.

---

## 3. New-route creation: three methods

The Setup entry presents a **method chooser** before the details form, in this
order:

### 3A. Record route by GPS (primary)

Build a route by physically travelling it once while the app records the GPS
track.

- **Reuses the ride-capture GPS machinery.** The same `watchPosition`-based
  trace collection used by `startRide` records a list of `{lat,lon,t}` fixes.
  (`startRide` already exposes a `manualFinish()`; the record-route flow uses an
  equivalent trace collector without end-region finish detection — there is no
  end region yet.)
- **Manual finish.** The user ends recording with a **Finish** button. There is
  no automatic end detection (no end region exists during creation).
- **UX during recording** mirrors normal ride recording (elapsed time, live
  distance, GPS-active state, pause support if cheap to reuse) **without** the
  progress bar and **without** a map.
- **On finish**, the collected trace is converted to the same internal route
  representation as an imported GPX: feed the trace through the **same
  processing path as `processGpx`/`previewGpx`** (resample to ~50 m spacing,
  compute segments/bearings/distances, derive start/end regions). The trace →
  GPX-equivalent conversion may either synthesise minimal GPX text and reuse
  `processGpx`, or call the underlying processing on the raw point list — either
  way the output must be identical in shape to an imported route so all
  downstream code is unaffected.
- After processing, the user lands on the **same details form** (name, schedule,
  tuning) as the other methods.

**First traversal logged as the route's first ride.** The recording produces
both the geometry *and* a complete ride trace (start/finish times, track), so
that traversal **is** a ride and is logged as the route's first ride — the route
arrives at setup with **exactly one ride**, not zero. It is logged **normally**,
with no special-casing:
- `actualTimeSec` = the recording's elapsed time (excluding pauses if pause is
  reused); `windFactor` reconstructed from the forecast over the traversal
  window against the new route's own geometry; `included` set from its
  classification (still → baseline contribution; windy → k; gentle → not used by
  default per the usual rule); `included` set accordingly.
- It is **curatable** like any ride: if the scouting pace was unrepresentative
  (stopping to check turns, riding cautiously on an unfamiliar route), the user
  can exclude it in the Rides Manager. No automatic "unrepresentative" handling —
  classification and normal curation cover it.
- Consequence: a recorded route can start with a real baseline data point rather
  than pure slider guesswork (if the traversal was **still**), which is a
  benefit, while a windy first traversal simply can't establish k alone (needs
  ≥2 windy rides with spread) and k stays on the slider; a gentle first traversal
  defaults to unused and contributes nothing unless the user opts it in.

**Build note:** this is the largest new piece, but it reuses existing trace
collection and route processing, so the novel work is the recording UI screen
and the trace→segments hand-off, not new geometry or model code.

**Keep-alive (applies to BOTH route recording and ride capture):** recording
must survive the screen locking and the app being backgrounded (a route or
commute can be long). Two complementary techniques, both acquired on the
**Start** gesture (a user gesture is required for audio) and released on Finish:

- **Screen Wake Lock** — `navigator.wakeLock.request('screen')` keeps the screen
  awake while the page is visible (well-supported on Android Chrome and iOS
  Safari 16.4+). Re-acquire on `visibilitychange` back to visible (the lock is
  auto-released when the page is hidden).
- **Silent looping audio** — a near-silent (very low amplitude, inaudible) looping
  audio element keeps a media session active, which keeps mobile browsers from
  suspending the page's timers and `watchPosition` when backgrounded or
  screen-locked. This is the technique that actually enables background GPS in a
  PWA. Must be started from the Start tap (autoplay is otherwise blocked) and
  stopped on Finish (don't hold audio focus needlessly).

**Honest caveats** (state in code comments / user copy, don't overclaim): this
is **best-effort, not a platform guarantee**. iOS media/background behaviour
varies by Safari version, and OS battery-saver or memory pressure can still
interrupt recording. The silent-audio + wake-lock stack **substantially
mitigates** background suspension but does not guarantee it. The gap-detection in
the quality gate (below) is the safety net for the cases where it still drops.

**GPS quality gate (block-or-re-record; there is no route editor):** since the
app deliberately has **no route editor**, a recording is binary — good enough to
use, or the user must **re-record**. There is no "warn but allow" tier and
nothing to salvage a marginal route with.

- **Silent denoising first** (not a gate, just not feeding garbage in): drop
  individual fixes implying impossible speeds (e.g. > ~80 km/h for a bike) to
  remove GPS spikes before assessment/processing.
- **Hard block on save** (force re-record, with a clear message) when the trace
  can't form a coherent route:
  - total recorded distance implausibly short (proposed **< 200 m** — an
    accidental start),
  - too few fixes to form a route (proposed **< ~10** usable fixes),
  - a dominant time gap between consecutive fixes that means a large stretch is
    missing (proposed: a single gap covering more than a set fraction of the
    elapsed recording, e.g. **> 25%**).
- Thresholds above are **tunable named constants**; firm values TBD.

**Trace treatment differs by purpose (design principle).** A recorded trace serves
two different jobs that want opposite handling, so filtering is applied per
purpose, never universally:
- **Route geometry (recording a new route, this section):** *filter* implausible
  fixes before resampling into segments. A bad fix baked into route geometry is a
  permanent zigzag (wrong bearings/distances forever), whereas a gap is bridged
  by a locally-straight line and is usually recoverable — so here **bad data is
  worse than a gap**, and since the trace is resampled anyway, filtering costs
  nothing.
- **Ride measurement (recording a ride on an existing route, item 4 / live
  capture):** **keep every fix** — do not filter the recorded trace. The ride's
  `actualSec` comes from the clock (start/finish), not the trace, and distance is
  a secondary input to wind_factor, so trace imperfections barely matter;
  filtering would add the risk of dropping real early movement for negligible
  benefit. Cleverness (accuracy gate, sane-speed clamp) is applied only at the
  **display** layer (the live speedometer needle) and at **route construction**,
  never by silently editing recorded ride ground truth. Principle: *record
  faithfully, interpret carefully.*

### 3B. Reverse an existing route (secondary)

Create the return trip from an existing route's geometry.

- **Geometry:** reverse the segment order, swap start/end regions, and reverse
  each segment bearing (bearing + 180°, normalised). Distance/elevation per
  segment carry over (elevation deltas negate). Total distance unchanged.
- **Tuning seed:** the reversed route **inherits the source's configuration** —
  its modes (baseline/k manual-or-learn, split) and its manual/slider seed values
  (speed and k). It starts with **no rides**, so in learn mode it shows the
  inherited manual seed with the "using your setting until enough rides" note
  (which may differ from what the source currently *displays* if the source has
  learned a value — but the underlying config is identical; the reverse simply
  hasn't learned yet). The return trip then learns its own k, which will diverge
  (different wind exposure and gradient).
- **Name:** auto-suggest **"Reverse ‹original route name›"** (editable — the
  user can accept or change it).
- The user lands on the standard details form to set name/schedule/confirm.

### 3C. Import GPX file (tertiary)

The current creation flow, demoted to the third option. No behavioural change —
file picker → `previewGpx` → details form.

---

## 4. Manual ride entry ("Add ride manually")

A button in the **Rides Manager** ("Add ride manually") lets the user log a ride
by entering times rather than recording via GPS.

- **Today only.** The ride is assumed to have happened **today**; the user
  enters a **start time and a finish time** (clock times, no date field).
- **Validation:** finish must be **≤ now** (can't log a ride that hasn't
  finished); finish must be after start.
- **Wind reconstruction:** the manual ride goes through the **same wind_factor
  reconstruction as a recorded ride** — fetch the route's forecast for today,
  sample along the route over the entered start→finish window, compute
  `wind_factor`, and **classify it still/gentle/windy** exactly like any other
  ride. `actualTimeSec` = finish − start.
- **Used/unused** then follows classification at record time (gentle → not used;
  still/windy → used), identical to a GPS-recorded ride.
- The new ride appears in the Rides Manager list immediately and participates in
  tuning per the normal curation rules (current baseline reference, 14-day
  freeze, etc.).

**Feasibility note:** today-only is what makes this simple — today's forecast is
always in the fetch/cache window, so wind reconstruction is always possible. (A
past-date version would hit the limit of retrievable historical forecast and is
explicitly out of scope.)

---

## 5. Ride tab live readouts (detailed design)

The recording screen is redesigned as a mostly-graphical instrument panel,
**white-on-black** for sunlight legibility and battery saving (true black
background), with the app's **amber (#e0a45e)** reserved for *active indicators*
(clock hands, speedometer needle, bezel marker, progress fill). Red is used only
for progress overage. SVG throughout for sharpness.

### Navigation lock while recording
- While a ride is actively recording (including while **paused**), the **tab bar
  is hidden** and navigation is locked to the ride screen. The only way off is
  **Finish** (manual — with the end-of-ride sanity check — or automatic at the
  end region). This prevents accidental taps navigating away mid-ride on a moving
  bike, and (deliberately) sidesteps lifting the ride session above the tab
  switch: since you can't leave the ride screen, the session never has to survive
  a tab change. Implemented by `Capture` reporting recording state up
  (`onRecordingChange`); `App` hides the `TabBar` while true.

### What-to-expect line (this ride)
- The recording screen shows a **what-to-expect line** — the same hazard/
  temperature summary as the Plan tab, computed for the **actual ride start
  time** (departing now) via `controller.rideExpectation(route)`. Below the
  progress bar; hidden for the example route.

### Keep-awake (this turn)
- **Screen Wake Lock** (`navigator.wakeLock.request('screen')`) acquired when
  recording starts, released on finish, re-acquired on `visibilitychange` back
  to visible. Keeps the screen on so the live readouts can be watched
  uninterrupted. (Silent-audio background keep-alive is NOT in this turn — it
  matters only for pocketed/backgrounded recording, addressed in turn 5.)

### End-of-ride sanity check
- Mirroring the existing start-of-ride check ("you're N km from the start —
  continue?"), the **manual Finish** triggers an end check: if GPS says the
  rider is more than the same threshold from the route's **end region**, confirm
  "You're N km from the end of the route — really stop?" before finishing.
  Reuses the `distanceToStart` machinery against `endRegion`. Same threshold as
  the start check, for symmetry.

### Layout (top → bottom)
The speedometer is the hero element; the clock is secondary. Proportions below
are starting points to tune on-device.

**2a. Elapsed time — top-right.** Essentially unchanged from the current display
(running elapsed, paused state). Plain white text.

**2b. Analogue clock — top-left (~40–50% width).** Minimalist SVG watch face:
- A simple circle, 12 hour markers (ticks), with **12 / 3 / 6 / 9 heavier** than
  the other eight; **no numerals**. Plain hour + minute hands (white) showing the
  current wall-clock time, updated each second (second hand optional/omitted for
  minimalism — TBD visually).
- **Bezel ring** around the face carrying a **single diver's-style arrival
  marker**: a pip at the clock-angle of the **expected arrival time** (e.g.
  arrive 8:47 → marker at the 47-minute angle, 282°). Mental model = the marker
  sits at the arrival o'clock-position and the real minute hand sweeps toward it.
  - Shown **always** (whenever an arrival estimate exists), coloured **grey when
    arrival is ≥ 60 min away** and **amber when < 60 min** (imminent). Beyond
    60 min the hour is ambiguous on a 12-h dial — understood as the approximate
    minute-of-arrival.
  - The marker **stays in place once arrival is reached**.
- **Expected arrival** is dynamic: `now + (route_total − estimated_distance) /
  speed`, where **estimated_distance** is the clamped value from 2e (so remaining
  is never negative and arrival is never in the past until actually arrived). The
  speed used is the **forecast ride-duration estimate until ≥ 1 km** of estimated
  distance, then the **average speed so far**. For a new-route recording (no
  total) the bezel marker does not show.

**2c. Speedometer — centre (hero element).** Classic-car-style SVG gauge,
stylistically matching the clock:
- A complete circle. **0 at the 7:30 position (225°)**, sweeping **clockwise**
  through **20 straight up (12 o'clock)** to **40 at the 4:30 position (315°)** —
  a **270° sweep** for 0–40 km/h.
- Numbers shown at **0, 10, 20, 30, 40**; intermediate values marked with small
  dots. White markings.
- **Amber needle** at the current **derived, smoothed** speed (see 2c-data).
  Needle **pegs at 40** if exceeded (cycling rarely sustains more; a pegged
  needle reads fine).

**2c-data. Speed derivation.** Current speed is **derived from successive GPS
fixes** (not `coords.speed`, which proved jumpier), smoothed with a time-aware
**EMA (τ≈5s)**, with the needle additionally CSS-transitioned for a classic-car
glide. Startup spikes are suppressed three ways, all **display-only** (the
recorded trace keeps every fix): the needle EMA seeds at 0, per-fix speeds above
a sane cycling max (~70 km/h) are rejected as GPS artefacts, and fixes with poor
reported **accuracy** (`coords.accuracy` worse than ~30 m, typical during GPS
acquisition) are skipped without advancing the EMA baseline so the next good fix
measures a clean interval.

**2d. Pause / Finish-now buttons — below the speedometer.** The existing controls
(pause toggle, finish), restyled to suit the white-on-black panel. Finish runs
the end-of-ride sanity check above.

**2e. Progress — bottom.**
- **Existing-route ride:** a graphical **progress bar**, **no numbers**, amber
  fill left→right = `along-route-distance / route-total`. The along-route
  distance comes from **projecting each GPS fix onto the route polyline**
  (`projectToRoute`): nearest point on the route, read as cumulative along-route
  distance. This is **gap-immune** — if GPS was suspended (phone off/pocketed)
  and resumes mid-ride, the next fix snaps to the route and progress is
  immediately correct, no accumulated trace needed. It never exceeds 100%, so
  there is **no red overage** and the old line-of-sight *estimated-distance
  clamp is retired* in favour of this projection.
  - **Continuity preference:** among route points within `OFF_ROUTE_M` (150 m)
    perpendicular, the projection nearest the last known along-route position is
    chosen, so a route passing near itself doesn't cause jumps. After a gap the
    hint is stale, so a self-crossing route *may snap to the wrong arm* — an
    accepted limitation (most commutes don't self-cross).
  - **Off-route (detour):** if no route point is within 150 m, progress
    **freezes** at the last along-route position (you make no route progress
    while off it).
- **New-route recording:** no route to project onto, so the bar is **replaced by
  a numeric distance covered so far** (raw GPS distance).

**Expected arrival** (2b) = `now + (route_total − along-route-distance) / pace`,
shown **only when on-route**. **Pace** is a 45-min EMA fed from **real
trace-distance** deltas between fixes every good fix — pace reflects how fast the
rider is moving and is therefore always live, on- or off-route (the time-aware
EMA absorbs GPS gaps correctly). Off-route it is *remaining distance* that is
undefined, not pace: since we can't know where an off-route rider will go next,
arrival is genuinely unknown, so the **bezel marker is hidden while off-route**
(deliberately, not as a side effect). The **speedometer needle** uses the same
trace-distance movement via a fast 5s EMA.

**Off-route status message.** While off-route, the frozen progress bar and absent
arrival marker would otherwise look like the app has died. To explain them and
reassure the rider that movement is still tracked, a message **"Off route by
x.x km"** is shown in the space between the clock and the speedometer (their
placement unchanged), using the nearest perpendicular distance to the route
(`projectToRoute` returns `offRouteM`), rounded to 1 dp — coarse enough not to
jitter, live enough to show tracking is active.

**Average speed** (used for the dynamic arrival, and a candidate small readout) =
`distance-so-far ÷ elapsed-moving-time`, excluding paused time (consistent with
how ride time excludes pauses).

### Notes
- All readouts are display-only; none affect the recorded ride, its `actualSec`,
  or wind reconstruction.
- The progress bar is deliberately **distance-travelled vs route-length**, no
  on-route geometry — a detour makes it read high (hence the red overage is a
  genuine "you've ridden further than the route" signal, not an error).

---

## 6. Data / API impact

- **Record route (3A):** new trace→route conversion reusing `processGpx`
  processing; produces a standard route record (segments, start/end regions).
  No schema change — a recorded route is indistinguishable from an imported one
  once processed. (Optionally retain the raw recorded trace in `rawGpx` for
  re-processing, mirroring how GPX import stores `rawGpx`.) The recording
  traversal is also written as the route's **first ride** (standard ride record:
  `actualTimeSec` from elapsed, `windFactor` reconstructed, `included` from
  classification), so a recorded route arrives with one curatable ride.
- **Reverse route (3B):** new geometry transform (reverse segments/bearings,
  swap regions); inherits slider seeds, no rides. Standard route record out.
- **Manual ride (4):** reuses the existing ride-capture forecast fetch +
  wind_factor reconstruction; writes a standard ride record. `actualTimeSec`
  from entered times; `windFactor` reconstructed; `included` from classification.
- **Live readouts (5):** no persistence; computed from the in-flight trace.
- **Keep-alive (3A / ride capture):** Wake Lock + silent-audio lifecycle tied to
  the Start/Finish of recording; no persistence. The GPS quality gate runs on
  the collected trace at Finish, before processing/save.

No changes to the learning model, storage schema (beyond a possibly-reused
`rawGpx` for recorded routes), or the forecast model.

---

## 7. Build sequencing (suggested)

1. **Item 1** (rename sweep) — trivial, do first. **[DONE]**
2. **Item 2** (Setup uses editor tuning controls) — UI consolidation; unblocks a
   consistent details form used by all three creation methods. **[DONE]** Note:
   `TerrainControls` was *already* the shared component used by both Setup and
   RouteEditor; Setup was merely passing dead manual-only mode props. The work
   was wiring Setup's Manual/Learn pills to real `modes` state (default
   learn/learn), a working `onModeChange`, and persisting the chosen modes via
   `createRoute` — not a new extraction. With zero rides at setup, learn controls
   correctly fall back to the sliders ("using your setting until enough rides
   recorded").
3. **Item 5** (live readouts) — the instrument-panel redesign (analogue clock +
   arrival bezel, classic speedometer, amber-on-black, progress bar with red
   overage), **plus** screen Wake Lock keep-awake and the end-of-ride sanity
   check (both pulled into this turn). Derived-speed + average + dynamic-arrival
   logic is unit-testable; the SVG/GPS/Wake-Lock parts are device-verified.
   **[DONE]** Pure math extracted to `lib/rideReadout.js` (gauge angle, clock
   angles, arrival bezel, dynamic arrival w/ 1 km forecast→live switch, avg +
   smoothed speed, progress amber/red fractions), covered by `testreadout.mjs`.
   `onTick` extended with `speedMps`/`distanceToEndM`; new `distanceToEnd`
   controller method; Wake Lock acquired on start / released on finish & pause /
   re-acquired on visibility.
4. **Item 4** (manual ride entry) — moderate; reuses wind reconstruction.
   **[DONE]** `controller.recordManualRide(routeId, {startMs, endMs})` fetches
   today's forecast and delegates to `recordRide`, so wind_factor reconstruction,
   classification and used/unused are identical to a GPS-recorded ride;
   `actualTimeSec = finish − start`. UI: an "Enter a ride from earlier today"
   button in the Rides Manager opens `ManualRideEntry` (two time inputs, today-
   only, finish ≤ now and > start).
5. **Item 3C / 3B** (GPX demotion + reverse) — the method chooser plus the
   reverse transform. **[3B DONE]** `reverseRoute` (gpxRoute.js) reconstructs the
   point list, reverses it, and re-runs `buildSegments` so bearings/distances/
   elevation-deltas recompute consistently; `controller.createReverseRoute(
   sourceId, {name?})` builds reversed geometry, inherits the source's speed/k
   slider seeds + split (learn/learn, no rides), names it "Reverse <source>" by
   default. UI: a "Create return trip" button in the route editor. (Method
   chooser + 3C GPX demotion still to do.)
6. **Item 3A** (record by GPS) — largest new piece; build last on top of the
   method chooser and the shared details form.

---

## 8. Tests (to add/adjust)

- Reverse-route geometry: reversed bearings, swapped regions, preserved total
  distance, negated elevation deltas; inherits slider seeds, zero rides.
- Trace→route processing for recorded routes: a synthetic point list produces a
  valid route record equivalent to the GPX path, **and** the traversal is logged
  as the route's first ride (classified, `included` from class, curatable).
- Manual ride entry: finish ≤ now and finish > start validation; wind_factor
  reconstructed and classified; `included` set from class; appears in the log.
- Average-speed and current-speed derivation (excluding paused time; smoothing).
- Progress-bar fill = travelled/total, **uncapped numeric** (can exceed 100%),
  visual fill capped at 100%; the documented detour-inaccuracy is intended.
- GPS quality gate: impossible-speed spikes dropped silently; block when total
  distance < threshold, fixes < threshold, or a dominant gap exceeds the
  fraction; otherwise pass. (Keep-alive Wake Lock / audio lifecycle is
  environment-dependent and verified on-device, not in the headless suite.)
- Setup tuning controls match the editor (pills present, learn/learn default,
  slider fallback with zero rides).

Run the full `node test*.mjs` suite and verify App.jsx brace/paren/div balance
after each item.
