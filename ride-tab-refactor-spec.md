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

### 3B. Reverse an existing route (secondary)

Create the return trip from an existing route's geometry.

- **Geometry:** reverse the segment order, swap start/end regions, and reverse
  each segment bearing (bearing + 180°, normalised). Distance/elevation per
  segment carry over (elevation deltas negate). Total distance unchanged.
- **Tuning seed:** the reversed route **inherits the original's speed and k
  slider values** as a sensible starting seed (the bike is the same), but starts
  with **no rides** — the return trip has different wind exposure and gradient,
  so its learned k will diverge. Modes default to learn/learn like any new route.
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

## 5. Ride tab live readouts

Add to the recording screen (additive; existing elapsed/distance/pause stay):

- **Clock time** — current wall-clock time (phone timezone), updated each second.
- **Current speed** — **derived** from successive GPS fixes (not
  `coords.speed`, for cross-device reliability), lightly **smoothed** over the
  last few seconds / couple of fixes so it isn't jumpy. km/h.
- **Average speed so far** — `distance-so-far ÷ elapsed-moving-time`, where
  elapsed-moving-time **excludes paused time** (consistent with how the ride
  time itself excludes pauses). km/h.
- **Progress bar** — fill = `distance-travelled / total-route-length`, **not
  capped**: if the rider detours or overshoots, the value legitimately exceeds
  100% (e.g. 120%), which honestly signals they've ridden further than the route
  length. The **numeric percentage shown is uncapped**; the **visual bar fill is
  capped at 100%** so layout doesn't break, while the text reads the true value.
  Shown during recording with **no gating** (no on-route check, no geometry).
  **Deliberately naive:** it measures distance ridden against route length
  regardless of where the rider actually went, so a detour makes it inaccurate.
  This is an accepted simplification — a rough "how far through am I" indicator,
  not a positional one.

All four are display-only; none affect the recorded ride, its `actualSec`, or
wind reconstruction.

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
3. **Item 5** (live readouts) — self-contained additive UI on the existing Ride
   tab; derived-speed + average + clock + naive progress bar.
4. **Item 4** (manual ride entry) — moderate; reuses wind reconstruction.
5. **Item 3C / 3B** (GPX demotion + reverse) — the method chooser plus the
   reverse transform.
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
