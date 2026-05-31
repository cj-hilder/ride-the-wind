/**
 * Ride the Wind — Alert scheduler
 *
 * The piece that actually drives alerts reliably. Because a PWA service worker
 * can't be trusted to wake at a wall-clock time, the guaranteed model is:
 * whenever the app becomes active (open, foreground, visibilitychange), check
 * which scheduled runs are now DUE and execute them. Push, where available, is
 * a separate best-effort enhancement on top.
 *
 * Two run types per spec §4.3:
 *   - night-before : evening before an active day (default 21:00)
 *   - morning      : early on the active day itself (default 06:00)
 *
 * This module is pure scheduling logic over injected dependencies — it holds
 * no clock or network of its own — so it is fully testable. It calls:
 *   - getRoutes()                         → active routes
 *   - getModelAndSeed(routeId)            → { modelState, seed }
 *   - fetchStations(route)                → forecast series per station
 *   - makePredictor / evaluateAlert       → injected from prediction/alertEngine
 *   - getLastRun(routeId,type)/setLastRun → dedupe so a run fires once per day
 *   - notify(alert)                       → deliver (SW notification or in-app)
 *   - reconcile(night,morning)            → alertEngine.reconcileMorning
 */

/* ------------------------------------------------------------------ *
 * Due-run detection
 * ------------------------------------------------------------------ */

/**
 * Given the current time and a route's active days, decide which runs are due
 * and have not yet fired for their target day.
 *
 * A night-before run for active day D is due during the window
 * [D-1 @ nightHour, D @ morningHour). A morning run for D is due during
 * [D @ morningHour, D @ arrival).
 *
 * `lastRunDay(type)` returns the YYYY-MM-DD of the active day a run last fired
 * for, or null. We fire once per (type, targetDay).
 *
 * @param {Object} route
 * @param {number} nowMs
 * @param {Object} deps - { nextActiveArrival, lastRunDay }
 * @param {Object} [opts] - { nightHour=21, morningHour=6 }
 * @returns {Array<{type:string, targetDayKey:string, arrivalMs:number}>}
 */
export function dueRuns(route, nowMs, deps, opts = {}) {
  const { nightHour = 21, morningHour = 6 } = opts;
  const { nextActiveArrival, lastRunDay } = deps;

  const next = nextActiveArrival(route, nowMs);
  if (!next) return [];
  const arrivalMs = next.arrivalMs;
  const targetDay = new Date(arrivalMs);
  const targetDayKey = dayKey(targetDay);

  const runs = [];

  // night-before window opens the previous evening at nightHour
  const nightOpen = atHour(addDays(targetDay, -1), nightHour);
  const morningOpen = atHour(targetDay, morningHour);

  if (
    nowMs >= nightOpen &&
    nowMs < morningOpen &&
    lastRunDay("night") !== targetDayKey
  ) {
    runs.push({ type: "night", targetDayKey, arrivalMs });
  }

  if (
    nowMs >= morningOpen &&
    nowMs < arrivalMs &&
    lastRunDay("morning") !== targetDayKey
  ) {
    runs.push({ type: "morning", targetDayKey, arrivalMs });
  }

  return runs;
}

/* ------------------------------------------------------------------ *
 * Execute due runs (the on-activate entry point)
 * ------------------------------------------------------------------ */

/**
 * Run all due alerts across all routes. Call this on app activation
 * (load, visibilitychange→visible, focus). Returns the alerts produced, which
 * the caller also renders as the in-app summary (the guaranteed channel).
 *
 * @param {Object} deps - everything injected; see module header
 * @param {number} [nowMs=Date.now()]
 * @param {Object} [opts]
 * @returns {Promise<Array>} alerts produced this pass
 */
export async function runDueAlerts(deps, nowMs = Date.now(), opts = {}) {
  const {
    getRoutes, getModelAndSeed, fetchStations,
    makePredictor, evaluateAlert, reconcile,
    getLastRun, setLastRun, getStoredVerdict, setStoredVerdict, notify,
  } = deps;

  const produced = [];
  const routes = await getRoutes();

  for (const route of routes) {
    if (!route.activeDays || route.activeDays.length === 0) continue;

    const runs = dueRuns(route, nowMs, {
      nextActiveArrival: deps.nextActiveArrival,
      lastRunDay: (type) => {
        const lr = getLastRun(route.id, type);
        return lr ? lr.targetDayKey : null;
      },
    }, opts);

    for (const run of runs) {
      const { modelState, seed } = await getModelAndSeed(route.id);
      const stationSeries = await fetchStations(route);

      const predictForArrival = makePredictor({
        route, modelState, seed, stationSeries,
      });
      const verdict = evaluateAlert(route, predictForArrival, { nowMs });
      if (!verdict) continue;

      let deliver = verdict;
      let changed = true;

      if (run.type === "morning") {
        // reconcile against the night-before verdict for this same day
        const night = getStoredVerdict(route.id, run.targetDayKey, "night");
        const rec = reconcile(night, verdict);
        changed = rec.changed;
        deliver = rec.verdict;
      }

      setStoredVerdict(route.id, run.targetDayKey, run.type, verdict);
      setLastRun(route.id, run.type, { targetDayKey: run.targetDayKey, at: nowMs });

      produced.push({ route, run, verdict: deliver, changed });

      // Only push a notification when it's worth interrupting: a real verdict
      // (not "normal"), and for the morning run only if it changed materially.
      const worthNotifying =
        deliver.verdict !== "normal" && (run.type !== "morning" || changed);
      if (worthNotifying) {
        await notify({
          routeId: route.id,
          title: titleFor(deliver, route),
          body: deliver.message,
          tag: `rtw-${route.id}-${run.targetDayKey}`,
          renotify: run.type === "morning" && changed,
        });
      }
    }
  }
  return produced;
}

function titleFor(verdict, route) {
  const v = verdict.verdict;
  if (v === "headwind") return `Headwind on ${route.name}`;
  if (v === "tailwind") return `Tailwind on ${route.name}`;
  return route.name;
}

/* ------------------------------------------------------------------ *
 * Date helpers (local time)
 * ------------------------------------------------------------------ */

export function dayKey(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}
function addDays(d, n) {
  const c = new Date(d);
  c.setDate(c.getDate() + n);
  return c;
}
function atHour(d, hour) {
  const c = new Date(d);
  c.setHours(hour, 0, 0, 0);
  return c.getTime();
}

/* ------------------------------------------------------------------ *
 * Registration helper (browser side)
 * ------------------------------------------------------------------ */

/**
 * Register the service worker and wire the on-activate trigger. Call once at
 * app startup. `onActive` is your runDueAlerts wrapper.
 */
export function installScheduler({ swUrl = "/sw.js", onActive, navigatorRef } = {}) {
  const nav = navigatorRef || (typeof navigator !== "undefined" ? navigator : null);
  if (nav && "serviceWorker" in nav) {
    nav.serviceWorker.register(swUrl).catch(() => {});
  }
  if (typeof document !== "undefined" && onActive) {
    const fire = () => {
      if (document.visibilityState === "visible") onActive();
    };
    document.addEventListener("visibilitychange", fire);
    window.addEventListener("focus", fire);
    onActive(); // run immediately on load
  }
}
