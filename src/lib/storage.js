/**
 * Ride the Wind — Storage layer
 *
 * Local-first persistence (data spec). Three object stores — routes, rides,
 * modelState — plus small key-value settings. No server, no account.
 *
 * Architecture: the data logic (record construction, the capture→learn flow,
 * cascade delete, export/import shaping, recompute) is written against a
 * minimal async key-value interface (`Backend`). Two backends implement it:
 *
 *   - IndexedDBBackend : real persistence in the browser, raw IndexedDB, no
 *                        external dependency.
 *   - MemoryBackend    : in-memory map, for tests and SSR/no-IDB fallback.
 *
 * This split lets the whole data layer be unit-tested in Node with no IndexedDB
 * shim, while the browser gets durable storage through the same API.
 *
 * Model-state persistence stores the regression sufficient statistics from
 * learning.js verbatim; nothing here knows the regression math, it just holds
 * and replays. The recompute op (rebuildFromRides) is injected so this module
 * has no import cycle with learning.js.
 */

const STORES = {
  ROUTES: "routes",
  RIDES: "rides",
  MODEL: "modelState",
  SETTINGS: "settings",
};

const DB_NAME = "ride-the-wind";
const DB_VERSION = 1;

// Default k when a direction has no usable setup estimate. Mirrors
// windModel.DEFAULT_K; duplicated here to avoid a cross-module dependency in
// the storage layer (which otherwise knows no regression/wind math).
const MIGRATION_DEFAULT_K = 0.33;

/**
 * Derive { kHead, kTail } from a route's stored setup estimates, for migrating
 * pre-split models. Same formula as windModel.seedKSplit: kHead from the
 * headwind estimate, kTail from the tailwind estimate, each defaulting to
 * MIGRATION_DEFAULT_K and clamped to the full physical range 0.05–4.0.
 */
function splitSeedFromRoute(route) {
  const clamp = (x) => Math.max(0.05, Math.min(4.0, x));
  let kHead = MIGRATION_DEFAULT_K, kTail = MIGRATION_DEFAULT_K;
  const still = route?.seedStillAirSec;
  if (still > 0) {
    if (route.seedHeadwind20Sec > 0) kHead = clamp(route.seedHeadwind20Sec / still - 1);
    if (route.seedTailwind20Sec > 0) kTail = clamp(1 - route.seedTailwind20Sec / still);
  }
  return { kHead, kTail };
}

/**
 * Map stored ride records to the shape learning.resolveModel consumes, and
 * supply defaults for legacy rides predating the curation/baseline-reference
 * fields (clean-break migration): `actualSec` from `actualTimeSec`, `included`
 * from the old `usable` flag (default true), `baselineRef` default "current",
 * `savedBaselineSec` default null. Preserves `id` so the caller can match
 * freeze transitions back to stored records.
 */
function normalizeRides(rides) {
  return rides.map((r) => ({
    id: r.id,
    windFactor: r.windFactor,
    actualSec: r.actualTimeSec,
    startedAt: r.startedAt,
    included: r.included != null ? r.included : (r.usable != null ? !!r.usable : true),
    baselineRef: r.baselineRef ?? "current",
    savedBaselineSec: r.savedBaselineSec ?? null,
  }));
}

/* ================================================================== *
 * Backend interface
 *   get(store, key) -> value|undefined
 *   getAll(store) -> value[]
 *   getAllByIndex(store, indexName, value) -> value[]
 *   put(store, value)            (value carries its own key)
 *   putKV(store, key, value)     (explicit key, for settings)
 *   delete(store, key)
 *   deleteWhere(store, predicate)
 * ================================================================== */

export class MemoryBackend {
  constructor() {
    this.data = {
      [STORES.ROUTES]: new Map(),
      [STORES.RIDES]: new Map(),
      [STORES.MODEL]: new Map(),
      [STORES.SETTINGS]: new Map(),
    };
  }
  async get(store, key) {
    return this.data[store].get(key);
  }
  async getAll(store) {
    return Array.from(this.data[store].values());
  }
  async getAllByIndex(store, _indexName, value) {
    // only index in use is rides.routeId
    return Array.from(this.data[store].values()).filter(
      (v) => v.routeId === value
    );
  }
  async put(store, value) {
    const key = keyFor(store, value);
    this.data[store].set(key, value);
    return value;
  }
  async putKV(store, key, value) {
    this.data[store].set(key, value);
    return value;
  }
  async delete(store, key) {
    this.data[store].delete(key);
  }
  async deleteWhere(store, predicate) {
    for (const [k, v] of this.data[store]) {
      if (predicate(v)) this.data[store].delete(k);
    }
  }
}

function keyFor(store, value) {
  if (store === STORES.MODEL) return value.routeId; // model keyed by routeId
  return value.id;
}

/**
 * IndexedDB backend. Browser only. Lazily opens the database and creates the
 * three stores plus the rides.routeId index on first use.
 */
export class IndexedDBBackend {
  constructor(idbFactory) {
    this.idb = idbFactory || (typeof indexedDB !== "undefined" ? indexedDB : null);
    if (!this.idb) throw new Error("IndexedDB unavailable in this environment.");
    this._dbPromise = null;
  }

  _open() {
    if (this._dbPromise) return this._dbPromise;
    this._dbPromise = new Promise((resolve, reject) => {
      const req = this.idb.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORES.ROUTES))
          db.createObjectStore(STORES.ROUTES, { keyPath: "id" });
        if (!db.objectStoreNames.contains(STORES.RIDES)) {
          const rides = db.createObjectStore(STORES.RIDES, { keyPath: "id" });
          rides.createIndex("routeId", "routeId", { unique: false });
        }
        if (!db.objectStoreNames.contains(STORES.MODEL))
          db.createObjectStore(STORES.MODEL, { keyPath: "routeId" });
        if (!db.objectStoreNames.contains(STORES.SETTINGS))
          db.createObjectStore(STORES.SETTINGS); // out-of-line keys
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return this._dbPromise;
  }

  async _tx(store, mode, fn) {
    const db = await this._open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(store, mode);
      const os = tx.objectStore(store);
      let result;
      Promise.resolve(fn(os)).then((r) => (result = r));
      tx.oncomplete = () => resolve(result);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  }

  _req(request) {
    return new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  get(store, key) {
    return this._tx(store, "readonly", (os) => this._req(os.get(key)));
  }
  getAll(store) {
    return this._tx(store, "readonly", (os) => this._req(os.getAll()));
  }
  getAllByIndex(store, indexName, value) {
    return this._tx(store, "readonly", (os) =>
      this._req(os.index(indexName).getAll(value))
    );
  }
  put(store, value) {
    return this._tx(store, "readwrite", (os) => this._req(os.put(value))).then(
      () => value
    );
  }
  putKV(store, key, value) {
    return this._tx(store, "readwrite", (os) =>
      this._req(os.put(value, key))
    ).then(() => value);
  }
  delete(store, key) {
    return this._tx(store, "readwrite", (os) => this._req(os.delete(key)));
  }
  async deleteWhere(store, predicate) {
    const all = await this.getAll(store);
    const victims = all.filter(predicate);
    await this._tx(store, "readwrite", (os) =>
      Promise.all(victims.map((v) => this._req(os.delete(keyFor(store, v)))))
    );
  }
}

/* ================================================================== *
 * Store: the data API the app uses
 * ================================================================== */

export class Store {
  /**
   * @param {Object} deps
   * @param {Backend} deps.backend
   * @param {()=>string} [deps.uuid]   - id generator (injectable for tests)
   * @param {Object} deps.learning     - the learning module (resolveModel,
   *                                      classifyRide, ...) injected to avoid an
   *                                      import cycle
   */
  constructor({ backend, uuid, learning }) {
    this.b = backend;
    this.uuid = uuid || defaultUuid;
    this.learning = learning;
  }

  /* ---- Routes ---- */

  /**
   * Create a route from a processed GPX result plus setup fields. Initialises
   * the model state with the seeded k/baseline.
   * @param {Object} processed - gpxRoute.processGpx output
   * @param {Object} setup     - name, description, seeds, arrival, activeDays...
   * @param {number} seededK
   */
  async createRoute(processed, setup, seededK) {
    // Reject a duplicate name (case-insensitive, trimmed) so routes stay
    // distinguishable in lists/pickers. All creation paths (GPX, reverse, and
    // future record-by-GPS) funnel through here, so one guard covers them.
    const wanted = (setup.name ?? "").trim().toLowerCase();
    if (wanted) {
      const existing = await this.listRoutes();
      if (existing.some((r) => (r.name ?? "").trim().toLowerCase() === wanted)) {
        throw new Error(`A route named "${setup.name.trim()}" already exists. Please choose a different name.`);
      }
    }
    const now = Date.now();
    const id = this.uuid();
    const route = {
      id,
      name: setup.name,
      description: setup.description ?? "",
      segments: processed.segments,
      totalDistance: processed.totalDistance,
      hasElevation: processed.hasElevation,
      startRegion: {
        lat: processed.start.lat,
        lon: processed.start.lon,
        radius: setup.startRadius ?? 60,
      },
      endRegion: {
        lat: processed.end.lat,
        lon: processed.end.lon,
        radius: setup.endRadius ?? 60,
      },
      baselineTimeSec: setup.seedStillAirSec,
      seedStillAirSec: setup.seedStillAirSec,
      seedHeadwind20Sec: setup.seedHeadwind20Sec ?? null,
      seedTailwind20Sec: setup.seedTailwind20Sec ?? null,
      // Learning config (manual/learn toggles + split + k slider values).
      // New routes start in LEARN for baseline and k: with no rides the resolver
      // falls back to the user's slider values (their setup speed/k), so the
      // prediction is identical to manual on day one — but the route then starts
      // learning automatically as rides accumulate, with no toggle to flip. The
      // sliders still hold the user's entered values as the fallback/seed.
      baselineMode: setup.baselineMode ?? "learn",
      kMode: setup.kMode ?? "learn",
      split: setup.split ?? false,
      sliderKHead: seededK.kHead ?? 1.0,
      sliderKTail: seededK.kTail ?? 1.0,
      targetArrival: setup.targetArrival,
      timeMode: setup.timeMode === "depart" ? "depart" : "arrive",
      arrivalOverrides: setup.arrivalOverrides ?? {},
      activeDays: setup.activeDays ?? [],
      alertThresholdMin: setup.alertThresholdMin ?? null,
      createdAt: now,
      updatedAt: now,
      order: now, // explicit ordering; new routes append (drag to reorder)
      rawGpx: setup.rawGpx ?? null,
    };
    await this.b.put(STORES.ROUTES, route);
    return route;
  }

  /**
   * Build the learning config object for a route from its stored fields.
   * sliderBaselineSec is the still-air seconds the speed slider implies.
   */
  routeConfig(route) {
    return {
      baselineMode: route.baselineMode ?? "learn",
      sliderBaselineSec: route.seedStillAirSec ?? route.baselineTimeSec,
      kMode: route.kMode ?? "learn",
      split: route.split ?? false,
      sliderKHead: route.sliderKHead ?? 1.0,
      sliderKTail: route.sliderKTail ?? 1.0,
    };
  }

  getRoute(id) {
    return this.b.get(STORES.ROUTES, id);
  }
  async listRoutes() {
    const routes = await this.b.getAll(STORES.ROUTES);
    // Stable explicit ordering. Routes created before the `order` field fall
    // back to createdAt so they keep a sensible, stable position.
    return routes.sort((a, b) =>
      (a.order ?? a.createdAt ?? 0) - (b.order ?? b.createdAt ?? 0));
  }

  /** Persist a new route order from an array of ids (first = top). */
  async reorderRoutes(orderedIds) {
    const routes = await this.b.getAll(STORES.ROUTES);
    const rank = new Map(orderedIds.map((id, i) => [id, i]));
    for (const r of routes) {
      const next = rank.has(r.id) ? rank.get(r.id) : Number.MAX_SAFE_INTEGER;
      if (r.order !== next) await this.b.put(STORES.ROUTES, { ...r, order: next });
    }
  }

  async updateRoute(id, patch) {
    const route = await this.getRoute(id);
    if (!route) throw new Error(`No route ${id}`);
    // If this patch changes the name, reject a collision with a DIFFERENT route
    // (case-insensitive, trimmed). Re-saving the same name (or unchanged) is fine.
    if (patch.name != null) {
      const wanted = patch.name.trim().toLowerCase();
      if (wanted) {
        const others = await this.listRoutes();
        if (others.some((r) => r.id !== id && (r.name ?? "").trim().toLowerCase() === wanted)) {
          throw new Error(`A route named "${patch.name.trim()}" already exists. Please choose a different name.`);
        }
      }
    }
    const updated = { ...route, ...patch, id, updatedAt: Date.now() };
    await this.b.put(STORES.ROUTES, updated);
    return updated;
  }

  /** Cascade: delete the route, its rides, and its model state. */
  async deleteRoute(id) {
    await this.b.deleteWhere(STORES.RIDES, (r) => r.routeId === id);
    await this.b.delete(STORES.MODEL, id);
    await this.b.delete(STORES.ROUTES, id);
  }

  /**
   * Reset a route's learning to freshly-entered base values: update the seed
   * still-air / head / tail times (and baseline + k sliders) and discard all
   * logged rides. With the refactor there is no separate model record to
   * rebuild — baseline and k are derived live from the (now empty) ride log and
   * the route's manual sliders. The GPX/segments and schedule are untouched.
   */
  async resetRoute(id, baseValues) {
    const route = await this.getRoute(id);
    if (!route) return null;
    const seed = splitSeedFromRoute({
      seedStillAirSec: baseValues.seedStillAirSec ?? route.seedStillAirSec,
      seedHeadwind20Sec: baseValues.seedHeadwind20Sec ?? null,
      seedTailwind20Sec: baseValues.seedTailwind20Sec ?? null,
    });
    const updated = {
      ...route,
      seedStillAirSec: baseValues.seedStillAirSec ?? route.seedStillAirSec,
      seedHeadwind20Sec: baseValues.seedHeadwind20Sec ?? null,
      seedTailwind20Sec: baseValues.seedTailwind20Sec ?? null,
      baselineTimeSec: baseValues.seedStillAirSec ?? route.baselineTimeSec,
      sliderKHead: seed.kHead,
      sliderKTail: seed.kTail,
      updatedAt: Date.now(),
    };
    await this.b.put(STORES.ROUTES, updated);
    // throw away every logged ride for this route
    await this.b.deleteWhere(STORES.RIDES, (r) => r.routeId === id);
    return updated;
  }

  /* ---- Model resolution (derived from the ride log + route config) ---- */

  /**
   * Resolve a route's learned model (baseline, kHead, kTail) live from its
   * curated ride log and config. Persists two side effects:
   *   - any current→historic freeze transitions the resolver applied;
   *   - the route's cached baselineTimeSec, kept in step with the resolution.
   * Returns the resolveModel result (incl. sources for the dots).
   *
   * @param {string} routeId
   * @param {number} [nowMs] - injectable for tests
   */
  async resolveRouteModel(routeId, nowMs = Date.now()) {
    const route = await this.getRoute(routeId);
    if (!route) return null;
    const rides = await this.listRides(routeId);
    const config = this.routeConfig(route);
    const resolved = this.learning.resolveModel(normalizeRides(rides), config, nowMs);

    // Persist freeze transitions: write back any ride whose baselineRef /
    // savedBaselineSec changed.
    const byId = new Map(rides.map((r) => [r.id, r]));
    for (const out of resolved.rides) {
      const orig = byId.get(out.id);
      if (orig && (orig.baselineRef !== out.baselineRef ||
                   orig.savedBaselineSec !== out.savedBaselineSec)) {
        await this.b.put(STORES.RIDES, { ...orig, ...out });
      }
    }

    // Keep the route's cached baseline aligned with the resolution.
    if (resolved.baselineSec > 0 && resolved.baselineSec !== route.baselineTimeSec) {
      await this.b.put(STORES.ROUTES, {
        ...route, baselineTimeSec: resolved.baselineSec, updatedAt: Date.now(),
      });
    }
    return resolved;
  }

  /* ---- Rides ---- */

  /**
   * Persist a captured ride. With the refactor the ride log IS the model: there
   * is no accumulator to fold into. A new ride's used/not-used state is set from
   * its classification: still and windy rides default to USED, gentle rides
   * default to UNUSED (gentle rides feed neither baseline nor k). An explicit
   * `included` on the capture overrides this; the legacy `usable` flag is also
   * honoured as a fallback. New rides start at current baseline reference (they
   * freeze to historic automatically at 14 days) with no frozen baseline yet.
   * Returns { ride }.
   *
   * @param {Object} capture - routeId, startedAt, endedAt, actualTimeSec,
   *                           trace, forecastWind, windFactor, predictedTimeSec,
   *                           autoFlagged.
   */
  async recordRide(capture) {
    // Default used/not-used from classification unless explicitly set.
    let includedDefault;
    if (capture.included != null) includedDefault = !!capture.included;
    else if (capture.usable != null) includedDefault = !!capture.usable;
    else if (!Number.isFinite(capture.windFactor)) includedDefault = true;
    else {
      const klass = this.learning.classifyRide(capture.windFactor);
      includedDefault = klass !== "gentle"; // still & windy used; gentle not
    }
    const ride = {
      id: this.uuid(),
      routeId: capture.routeId,
      startedAt: capture.startedAt,
      endedAt: capture.endedAt,
      actualTimeSec: capture.actualTimeSec,
      trace: capture.trace ?? [],
      forecastWind: capture.forecastWind ?? [],
      windFactor: capture.windFactor,
      predictedTimeSec: capture.predictedTimeSec ?? null,
      autoFlagged: !!capture.autoFlagged,
      // New curation / baseline-reference fields.
      included: includedDefault,
      baselineRef: capture.baselineRef ?? "current",
      savedBaselineSec: capture.savedBaselineSec ?? null,
    };
    await this.b.put(STORES.RIDES, ride);
    return { ride };
  }

  listRides(routeId) {
    return this.b.getAllByIndex(STORES.RIDES, "routeId", routeId);
  }

  getRide(id) {
    return this.b.get(STORES.RIDES, id);
  }

  /**
   * Patch a single ride (editor: duration edit, include/exclude toggle,
   * current/historic switch). Only whitelisted fields are writable.
   */
  async updateRide(id, patch) {
    const ride = await this.b.get(STORES.RIDES, id);
    if (!ride) throw new Error(`No ride ${id}`);
    const allowed = {};
    if (patch.actualTimeSec != null) allowed.actualTimeSec = patch.actualTimeSec;
    if (patch.included != null) allowed.included = !!patch.included;
    if (patch.baselineRef != null) allowed.baselineRef = patch.baselineRef;
    if (patch.savedBaselineSec !== undefined) allowed.savedBaselineSec = patch.savedBaselineSec;
    const updated = { ...ride, ...allowed };
    await this.b.put(STORES.RIDES, updated);
    return updated;
  }

  /** Delete a single ride (destructive; distinct from exclude). */
  async deleteRide(id) {
    await this.b.delete(STORES.RIDES, id);
  }

  /**
   * Bulk curation: exclude the given ride and every earlier ride (by ride
   * timestamp) on the same route. Reversible — it only sets included=false.
   * Returns the number of rides affected.
   */
  async excludeRideAndEarlier(id) {
    const ride = await this.b.get(STORES.RIDES, id);
    if (!ride) return 0;
    const rides = await this.listRides(ride.routeId);
    let n = 0;
    for (const r of rides) {
      if ((r.startedAt ?? 0) <= (ride.startedAt ?? 0) && r.included !== false) {
        await this.b.put(STORES.RIDES, { ...r, included: false });
        n++;
      }
    }
    return n;
  }

  /* ---- Settings ---- */

  async getSetting(key, fallback = null) {
    const v = await this.b.get(STORES.SETTINGS, key);
    return v === undefined ? fallback : v;
  }
  setSetting(key, value) {
    return this.b.putKV(STORES.SETTINGS, key, value);
  }

  /* ---- Portability (data spec §5) ---- */

  /**
   * Export everything as one JSON-serialisable object. The user's backup and
   * device-migration path, since there is no server.
   */
  async exportAll() {
    const [routes, rides, models] = await Promise.all([
      this.b.getAll(STORES.ROUTES),
      this.b.getAll(STORES.RIDES),
      this.b.getAll(STORES.MODEL),
    ]);
    const settings = {};
    for (const k of SETTING_KEYS) {
      const v = await this.b.get(STORES.SETTINGS, k);
      if (v !== undefined) settings[k] = v;
    }
    return {
      format: "ride-the-wind/export",
      version: 1,
      exportedAt: Date.now(),
      routes,
      rides,
      models,
      settings,
    };
  }

  /**
   * Import an exported bundle. `mode` "replace" (default) overwrites by id;
   * "merge" keeps existing records when ids already exist. Routes carry their
   * rides and model; models are keyed by routeId.
   */
  async importAll(bundle, mode = "replace") {
    if (!bundle || bundle.format !== "ride-the-wind/export") {
      throw new Error("Not a Ride the Wind export file.");
    }
    const exists = async (store, key) =>
      (await this.b.get(store, key)) !== undefined;

    for (const route of bundle.routes ?? []) {
      if (mode === "merge" && (await exists(STORES.ROUTES, route.id))) continue;
      await this.b.put(STORES.ROUTES, route);
    }
    for (const ride of bundle.rides ?? []) {
      if (mode === "merge" && (await exists(STORES.RIDES, ride.id))) continue;
      await this.b.put(STORES.RIDES, ride);
    }
    for (const model of bundle.models ?? []) {
      if (mode === "merge" && (await exists(STORES.MODEL, model.routeId)))
        continue;
      await this.b.put(STORES.MODEL, model);
    }
    for (const [k, v] of Object.entries(bundle.settings ?? {})) {
      if (mode === "merge" && (await exists(STORES.SETTINGS, k))) continue;
      await this.b.putKV(STORES.SETTINGS, k, v);
    }
  }
}

const SETTING_KEYS = [
  "globalAlertThresholdMin",
  "conservatismPct", // the uncertainty allowance
  "wRefKmh",
  "lastOpenedRouteId",
  "persistentStorageGranted",
];

/* ================================================================== *
 * Persistence request (data spec note on eviction)
 * ================================================================== */

/**
 * Ask the browser to make storage persistent (resist eviction under pressure,
 * which matters on iOS). Returns the boolean result, or null where the API is
 * unavailable. The caller should warn the user if this resolves false.
 */
export async function requestPersistentStorage(nav) {
  const n = nav || (typeof navigator !== "undefined" ? navigator : null);
  if (!n || !n.storage || !n.storage.persist) return null;
  try {
    return await n.storage.persist();
  } catch {
    return null;
  }
}

/* ================================================================== *
 * Helpers
 * ================================================================== */

function defaultUuid() {
  if (typeof crypto !== "undefined" && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  // fallback
  return "id-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 10);
}

export { STORES, DB_NAME, DB_VERSION };
