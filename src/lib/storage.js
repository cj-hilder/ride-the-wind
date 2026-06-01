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
   * @param {Object} deps.learning     - { createModelState, updateModel, fitModel, rebuildFromRides }
   *                                      injected to avoid an import cycle
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
      targetArrival: setup.targetArrival,
      timeMode: setup.timeMode === "depart" ? "depart" : "arrive",
      arrivalOverrides: setup.arrivalOverrides ?? {},
      activeDays: setup.activeDays ?? [],
      alertThresholdMin: setup.alertThresholdMin ?? null,
      createdAt: now,
      updatedAt: now,
      rawGpx: setup.rawGpx ?? null,
    };
    await this.b.put(STORES.ROUTES, route);

    // seededK is now { kHead, kTail }
    const model = {
      routeId: id,
      kHead: seededK.kHead ?? 1.0,
      kTail: seededK.kTail ?? 1.0,
      regressionState: this.learning.createModelState(),
      usableRideCount: 0,
      lastUpdated: now,
    };
    await this.b.put(STORES.MODEL, model);
    return route;
  }

  getRoute(id) {
    return this.b.get(STORES.ROUTES, id);
  }
  listRoutes() {
    return this.b.getAll(STORES.ROUTES);
  }

  async updateRoute(id, patch) {
    const route = await this.getRoute(id);
    if (!route) throw new Error(`No route ${id}`);
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

  /* ---- Model state ---- */

  async getModel(routeId) {
    const model = await this.b.get(STORES.MODEL, routeId);
    if (!model) return model;
    // Migration: models stored before the kHead/kTail split have only `k`
    // (or nothing). Per the reset-and-reseed decision, rebuild both directional
    // sensitivities from the route's stored setup estimates and persist.
    if (model.kHead == null || model.kTail == null) {
      const route = await this.getRoute(routeId);
      const seed = splitSeedFromRoute(route);
      const upgraded = {
        ...model,
        kHead: seed.kHead,
        kTail: seed.kTail,
        // a reset also discards the old single-k regression assumption
        regressionState: this.learning.createModelState(),
        usableRideCount: 0,
      };
      delete upgraded.k;
      await this.b.put(STORES.MODEL, upgraded);
      return upgraded;
    }
    return model;
  }

  /* ---- Rides ---- */

  /**
   * Persist a captured ride and, if usable, fold it into the model state
   * (regression update, refit k + baseline, bump count). Returns
   * { ride, model } — model unchanged when the ride is not usable.
   *
   * @param {Object} capture - routeId, startedAt, endedAt, actualTimeSec,
   *                           trace, forecastWind, windFactor, predictedTimeSec,
   *                           usable, excludeReason, autoFlagged
   */
  async recordRide(capture) {
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
      usable: !!capture.usable,
      excludeReason: capture.excludeReason ?? null,
      autoFlagged: !!capture.autoFlagged,
    };
    await this.b.put(STORES.RIDES, ride);

    let model = await this.getModel(capture.routeId);
    if (ride.usable && model) {
      const newState = this.learning.updateModel(
        model.regressionState,
        ride.windFactor,
        ride.actualTimeSec
      );
      const fit = this.learning.fitModel(newState, {
        seedKHead: model.kHead ?? 1.0,
        seedKTail: model.kTail ?? 1.0,
      });
      model = {
        ...model,
        regressionState: newState,
        kHead: fit ? fit.kHead : model.kHead,
        kTail: fit ? fit.kTail : model.kTail,
        usableRideCount: model.usableRideCount + 1,
        lastUpdated: Date.now(),
      };
      await this.b.put(STORES.MODEL, model);

      // Keep the route's cached baseline in step with the refit.
      if (fit && fit.baselineSec > 0) {
        await this.updateRoute(capture.routeId, {
          baselineTimeSec: fit.baselineSec,
        });
      }
    }
    return { ride, model };
  }

  listRides(routeId) {
    return this.b.getAllByIndex(STORES.RIDES, "routeId", routeId);
  }

  /**
   * Recompute op (data spec §4): rebuild a route's model state from scratch by
   * replaying its usable rides oldest-to-newest. Use after an algorithm change.
   */
  async recomputeModel(routeId) {
    const rides = (await this.listRides(routeId)).sort(
      (a, b) => a.startedAt - b.startedAt
    );
    const state = this.learning.rebuildFromRides(rides);
    const existing = await this.getModel(routeId);
    const fit = this.learning.fitModel(state, {
      seedKHead: existing?.kHead ?? 1.0,
      seedKTail: existing?.kTail ?? 1.0,
    });
    const model = {
      routeId,
      regressionState: state,
      kHead: fit ? fit.kHead : existing?.kHead ?? 1.0,
      kTail: fit ? fit.kTail : existing?.kTail ?? 1.0,
      usableRideCount: rides.filter((r) => r.usable).length,
      lastUpdated: Date.now(),
    };
    await this.b.put(STORES.MODEL, model);
    if (fit && fit.baselineSec > 0) {
      await this.updateRoute(routeId, { baselineTimeSec: fit.baselineSec });
    }
    return model;
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
