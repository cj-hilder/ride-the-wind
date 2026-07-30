# Interrupted recording recovery (SPEC — for review, NOT yet built)

Status: drafted for Chris. Target: 1.7.0. This touches the RECORDING path, which
cannot be bundle-tested in the build environment — so it wants careful review and
device testing before release.

## Problem

Closing the app (accidental swipe-away, OS kill, crash, reload) while recording
throws away the entire recording. Both recorders hold all state in a closure
(`trace`, `startedAt`, pause totals, `hasLeftStart`, `arrivalDeclined`,
`forecastWind`) and the GPS watch dies with the page. Nothing is persisted until
the recording finishes, so an hour-long ride or a carefully-ridden new route is
lost with no warning and no recovery.

## Guiding principle (Chris, decided)

**Do not throw away ride data.** On relaunch, ask whether to continue; continue if
confirmed. Specifically:

- Gap time (app closed) **counts as riding time**. The rider was most likely
  riding. If they were actually stopped, they can adjust the ride time at the
  finish screen (the existing adjust-minutes control).
- Any straight line the gap creates in the GPS trace **is left in**. The user can
  examine the map after saving and delete the ride if the gap is too big; the
  existing large-gap warning tells them to look.
- **Learning-inclusion rules are unchanged.** Whether a ride feeds the model
  depends on forecast wind class (still/gentle/windy) and the existing k-range
  sanity check — NOT on gaps. Recording accuracy is the user's responsibility.

This is deliberately simple: no gap flags, no new exclusion logic, no special
casing in `learning.js`. Recovery restores state and carries on.

## Scope

Applies to BOTH recorders:
1. `startRide` — recording a ride on an existing route.
2. `recordRoute` — recording a new route from a GPX-less track.

## What must be persisted

A single in-progress session (there can only be one at a time).

```
session = {
  id,                 // stable id for the session
  kind,               // "ride" | "route"
  routeId,            // ride only
  startedAt,          // ms
  totalPausedMs,      // accumulated completed pauses
  pausedAt,           // ms if paused when persisted, else null
  hasLeftStart,       // ride only — finish-detection arming
  arrivalDeclined,    // ride only — "keep riding" latch
  forecastWind,       // ride only — station series captured at start
  trace: [fix, ...],  // ALL fixes so far (both kinds)
  updatedAt,          // ms, for staleness
}
```

The trace must be persisted for BOTH kinds. For a ride it is archival (written to
the ride record, never read back), but per the guiding principle we keep the data
rather than discard it, and the map view after saving is how the user judges the
gap — which requires the trace.

## Persistence cadence

Per-fix writes of the whole session would rewrite a growing array ~1×/second.
Instead:

- Store the session header in a new `sessions` store, keyed by `id`.
- Store fixes in a `sessionFixes` store keyed `[sessionId, seq]` — one small
  `put` per fix, append-only, no rewriting of prior data.
- Update the header (timing/flags) on a throttle: every ~5 s, and additionally on
  `visibilitychange` → hidden and on `pagehide`, which is the last reliable hook
  before an OS kill.

Schema change: `DB_VERSION` 1 → 2, adding the two stores in `onupgradeneeded`.
Existing data is untouched (additive migration only).

## Resume flow

On app start, after routes load:

1. Look for a session. If none → normal start.
2. If found and **stale** (see below) → discard silently, clean up.
3. Otherwise prompt: *"You were recording <ride on Route X | a new route> —
   N minutes so far. Continue recording?"* with **Continue** and **Discard**.
   - Discard requires a confirm step (it destroys data — inconsistent with the
     guiding principle to do it on one tap).
4. **Continue** → rehydrate and resume:
   - reopen the GPS watch,
   - restore `trace` (from `sessionFixes`), `startedAt`, `totalPausedMs`,
     `hasLeftStart`, `arrivalDeclined`, `forecastWind`,
   - do NOT add to `totalPausedMs` for the closed period → the gap counts as
     riding time, per the principle,
   - resume in the **state it was killed in**: if `pausedAt` was set, come back
     PAUSED with that pause still open (decided — faithful to what the rider
     chose). See "Gap time when killed while paused" below.
   - the next fix creates the straight-line join; left as-is.
5. The finish flow is unchanged: existing validation for `recordRoute` (gap >500 m
   warns, doesn't block) and the existing adjust-minutes control for rides.

Session is deleted on finish, on discard, and on successful ride save.

## Gap time when killed while paused

The two decisions above interact, and the resolution should be explicit.

- Killed while **running** → the closed period counts as **riding time** (the
  rider was most likely riding). Per the guiding principle.
- Killed while **paused** → the pause was still open when the app died, so it
  stays open across the gap and the closed period accrues as **paused time** once
  resumed. This follows from resuming paused, and is the honest reading: the
  rider had explicitly declared themselves stopped.

Implementation: persist `pausedAt`. On resume, if `pausedAt` is set, restore
`paused = true` and set `pauseStartedAt = pausedAt` — the existing `resume()`
then adds the whole closed span to `totalPausedMs` when the rider taps Continue.
No special-casing beyond restoring the two fields.

If Chris would rather the gap ALWAYS count as riding time even when paused, the
change is to set `pauseStartedAt = now()` on resume instead of `pausedAt`. Flagged
because the principle said "gap counts as riding time" in the context of a rider
who was probably still moving; a declared pause seems the intended exception.

## Staleness

A session older than **12 h** (by `updatedAt`) is discarded without prompting —
resuming a ride from yesterday would produce a nonsense ride time, and the
prompt itself would be confusing. 12 h comfortably covers "closed it at the
office, reopened at lunch" while excluding "found it a week later".

Cleanup also runs on discard and on finish, so `sessionFixes` can't accumulate.

## New API surface

- `storage`: `saveSession(header)`, `appendSessionFix(sessionId, seq, fix)`,
  `loadSession()`, `loadSessionFixes(id)`, `deleteSession(id)`.
- `app.js`: `findResumableSession()` → header + summary for the prompt;
  `startRide(route, { resumeSession })` and `recordRoute({ resumeSession })`
  accepting a rehydrated session; both write to the session store as they run.
- `App.jsx`: launch-time check + prompt; route into the existing recorder screens
  in their "recording" state rather than "armed".

## Testing

Controller-level (the recorders are already tested with a stubbed `geo`):
- fixes are appended to `sessionFixes` as they arrive; header throttle fires.
- kill-and-resume: build a session, resume it, assert `trace` continuity,
  `startedAt` preserved, `totalPausedMs` preserved, and that the closed period is
  NOT added to paused time (gap counts as riding time).
- resumed ride finishes with `actualSec` spanning the gap.
- killed-while-running: closed period counts as riding time (`actualSec` includes
  it, `pausedSec` does not).
- killed-while-paused: session resumes PAUSED, and on Continue the closed period
  has accrued to `pausedSec`, not `actualSec`.
- stale session (>12 h) is discarded, not offered.
- session deleted on finish and on discard; no orphan fixes remain.
- `recordRoute` resume produces a trace containing the straight-line join, and
  the existing >500 m gap warning fires (warning, not block).

## Decisions taken (Chris)

1. **Resume paused if killed paused.** Faithful to the state the rider chose. See
   "Gap time when killed while paused" for the timing consequence.
2. **No stronger warning for resumed route recordings.** A resumed route with a
   big straight-line shortcut is no different from a recording that was
   backgrounded mid-way, which already happens — so it gets the same treatment.
   The existing large-gap warning (>500 m, warn not block) is the mechanism, and
   the user checks the map. No resumed-specific handling.

## Open question for Chris

**Prompt on relaunch, or on entering the Ride tab?** A modal at launch is
unmissable but intrudes if the user opened the app only to check a forecast.
Alternative: a persistent banner on the Ride tab. I lean launch prompt, since an
unfinished recording is time-critical — but it's the one placement decision left.

## Estimated size

Moderate. New store + version bump (contained, additive), ~2 new persistence
paths in `app.js`, resume entry points in both recorders, one prompt UI, cleanup,
and the tests above. The risk is concentrated in the recording path, so the plan
is: build storage + resume in `app.js` with tests first, wire the UI last.
