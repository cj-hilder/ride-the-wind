// Google Drive backup (ported from Temperatura). Pure: fetch, the
// clock, timers, storage and the refresh token all come in as parameters, so
// testdrive.mjs drives every path in Node with no browser and no Google. The
// browser-only half (the Connect popup) is googleAuth.js.
//
// Three parts:
//   1. createTokenSource: refresh token → short-lived access token, via our
//      /api/google-token endpoint (see googleToken.js for why a server is
//      involved at all).
//   2. createDriveClient: list / upload / download / delete in the hidden
//      appDataFolder, over the plain Drive v3 REST API, with no client library.
//   3. createBackupScheduler: decides WHEN to back up. It persists "a backup
//      is owed" at the moment of the change, so an app kill, a reboot or a
//      week offline can delay a backup but never lose one.

const DRIVE_FILES = "https://www.googleapis.com/drive/v3/files";
const DRIVE_UPLOAD = "https://www.googleapis.com/upload/drive/v3/files";

export const QUIET_MS = 30 * 1000;
export const RETRY_MS = 5 * 60 * 1000;
export const OVERDUE_MS = 24 * 60 * 60 * 1000;
export const KEEP_AUTO = 14;
export const KEEP_MANUAL = 10;

// Settings-store keys. All scheduler state lives here, not in memory, for the
// same reason running instances use epoch timestamps: the app can be killed
// at any moment and must pick up exactly where it was.
export const KEYS = {
  REFRESH_TOKEN: "driveRefreshToken",
  ACCOUNT: "driveAccountEmail",
  OWED_SINCE: "driveOwedSince",       // earliest change not yet backed up, or null
  LAST_CHANGE: "driveLastChangeAt",   // the 30 s quiet period runs from here
  CHANGE_SEQ: "driveChangeSeq",       // tells "changed during the upload" apart
  LAST_BACKUP: "driveLastBackupAt",
  LAST_ATTEMPT: "driveLastFailedAt",  // the 5 min retry floor runs from here
  LAST_ERROR: "driveLastError",
  NEEDS_RECONNECT: "driveNeedsReconnect",
};

// ---- Errors -----------------------------------------------------------------

// kind decides what happens next. Only "auth" stops automatic backup until
// the user reconnects. Every other kind is retried, because offline, Google
// having a bad minute, or a full Drive can all fix themselves without the
// app doing anything.
export class DriveError extends Error {
  constructor(kind, message) {
    super(message);
    this.kind = kind; // "auth" | "offline" | "quota" | "rate" | "server" | "other"
  }
}

export function messageFor(error) {
  switch (error?.kind) {
    case "auth": return "Google Drive access was removed or has expired. Reconnect in Settings.";
    case "offline": return "No connection to Google Drive. It will try again when you're back online.";
    case "quota": return "Your Google Drive is full. Free up space and it will try again.";
    case "rate": return "Google Drive is busy. It will try again shortly.";
    case "server": return "Google Drive had a problem. It will try again shortly.";
    default: return `Backup failed: ${error?.message || "unknown error"}`;
  }
}

async function driveErrorFrom(res) {
  let reason = "", message = `HTTP ${res.status}`;
  try {
    const body = await res.json();
    reason = body?.error?.errors?.[0]?.reason || body?.error?.status || "";
    message = body?.error?.message || message;
  } catch { /* non-JSON error body: status alone decides */ }
  if (res.status === 401) return new DriveError("auth", message);
  if (res.status === 429 || /rateLimit/i.test(reason)) return new DriveError("rate", message);
  if (/storageQuotaExceeded|quotaExceeded/i.test(reason)) return new DriveError("quota", message);
  // Any other 403 means the token doesn't carry the permission: Google's
  // granular consent lets a user untick drive.appdata on the consent screen.
  // Retrying can't fix that. Reconnecting can.
  if (res.status === 403) return new DriveError("auth", message);
  if (res.status >= 500) return new DriveError("server", message);
  return new DriveError("other", message);
}

// ---- 1. Token source ----------------------------------------------------------

/**
 * @param {object} d
 * @param {Function} d.fetch
 * @param {() => number} d.now
 * @param {() => Promise<string|null>} d.loadRefreshToken
 * @param {string} [d.endpoint]
 */
export function createTokenSource({ fetch, now, loadRefreshToken, endpoint = "/api/google-token" }) {
  let cached = null; // { token, expiresAt }. Memory only: an access token is never persisted.

  async function getAccessToken({ forceRefresh = false } = {}) {
    // A 60 s margin, so a token can't expire partway through an upload.
    if (!forceRefresh && cached && now() < cached.expiresAt - 60_000) return cached.token;
    const refreshToken = await loadRefreshToken();
    if (!refreshToken) throw new DriveError("auth", "Not connected to Google Drive.");
    let res;
    try {
      res = await fetch(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ refreshToken }),
      });
    } catch (e) {
      throw new DriveError("offline", e?.message || "network error");
    }
    let body = {};
    try { body = await res.json(); } catch { /* handled by status below */ }
    if (res.ok && body.access_token) {
      cached = { token: body.access_token, expiresAt: now() + (body.expires_in ?? 3600) * 1000 };
      return cached.token;
    }
    cached = null;
    // invalid_grant is Google saying the refresh token is dead: revoked by the
    // user, or expired. Only a new Connect fixes that.
    if (body.error === "invalid_grant") throw new DriveError("auth", body.error_description || "invalid_grant");
    if (res.status === 502 || res.status >= 500) throw new DriveError("server", body.error || `HTTP ${res.status}`);
    throw new DriveError("other", body.error || `HTTP ${res.status}`);
  }

  return { getAccessToken, forget: () => { cached = null; } };
}

// ---- 2. Drive client ----------------------------------------------------------------

export function createDriveClient({ fetch, getAccessToken }) {
  // One call with auth. A 401 gets one forced token refresh and a retry: an
  // access token can be revoked before its stated expiry.
  async function call(url, init = {}, { retried = false } = {}) {
    const token = await getAccessToken({ forceRefresh: retried });
    let res;
    try {
      res = await fetch(url, { ...init, headers: { ...(init.headers || {}), authorization: `Bearer ${token}` } });
    } catch (e) {
      throw new DriveError("offline", e?.message || "network error");
    }
    if (res.status === 401 && !retried) return call(url, init, { retried: true });
    if (!res.ok) throw await driveErrorFrom(res);
    return res;
  }

  async function list() {
    const q = new URLSearchParams({
      spaces: "appDataFolder",
      fields: "files(id,name,modifiedTime,appProperties)",
      pageSize: "1000",
    });
    const res = await call(`${DRIVE_FILES}?${q}`);
    return (await res.json()).files || [];
  }

  // multipart/related: metadata and content in one request. Creating a file
  // and filling it in two calls would leave an empty backup file behind if
  // the second call failed.
  function multipart(metadata, content) {
    const boundary = "ridethewind" + Math.random().toString(36).slice(2);
    const body =
      `--${boundary}\r\ncontent-type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n` +
      `--${boundary}\r\ncontent-type: application/json\r\n\r\n${content}\r\n` +
      `--${boundary}--`;
    return { body, contentType: `multipart/related; boundary=${boundary}` };
  }

  // existingId: replace that file's content in place (the day's auto file).
  // Otherwise create a new file in appDataFolder.
  async function upload({ name, content, appProperties, existingId = null }) {
    const metadata = existingId ? { appProperties } : { name, parents: ["appDataFolder"], appProperties };
    const { body, contentType } = multipart(metadata, content);
    const url = existingId
      ? `${DRIVE_UPLOAD}/${existingId}?uploadType=multipart&fields=id,name`
      : `${DRIVE_UPLOAD}?uploadType=multipart&fields=id,name`;
    const res = await call(url, { method: existingId ? "PATCH" : "POST", headers: { "content-type": contentType }, body });
    return res.json();
  }

  async function download(id) {
    const res = await call(`${DRIVE_FILES}/${id}?alt=media`);
    return res.json();
  }

  async function remove(id) {
    await call(`${DRIVE_FILES}/${id}`, { method: "DELETE" });
  }

  return { list, upload, download, remove };
}

// ---- Naming and keeping ------------------------------------------------------

const pad = (n) => String(n).padStart(2, "0");
// Local date, not UTC. A New Zealand evening is the next day in UTC, and the
// user thinks of "today's backup" as their own today.
const localDay = (ms) => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};
export const autoName = (ms) => `ridethewind-auto-${localDay(ms)}.json`;
export const manualName = (ms) => {
  const d = new Date(ms);
  return `ridethewind-backup-${localDay(ms)}-${pad(d.getHours())}${pad(d.getMinutes())}.json`;
};

const AUTO_RE = /^ridethewind-auto-\d{4}-\d{2}-\d{2}\.json$/;
const MANUAL_RE = /^ridethewind-backup-\d{4}-\d{2}-\d{2}-\d{4}\.json$/;
export function kindOf(name) {
  if (AUTO_RE.test(name)) return "auto";
  if (MANUAL_RE.test(name)) return "manual";
  return null;
}

// Ids to delete: autos beyond the newest KEEP_AUTO, manuals beyond the newest
// KEEP_MANUAL. The names sort by date, so a name sort is a date sort. A file
// with any other name is never touched, whatever put it there.
export function planPrune(files) {
  const newestFirst = (kind) => files.filter((f) => kindOf(f.name) === kind).sort((a, b) => (a.name < b.name ? 1 : -1));
  return [
    ...newestFirst("auto").slice(KEEP_AUTO),
    ...newestFirst("manual").slice(KEEP_MANUAL),
  ].map((f) => f.id);
}

// What the Restore list shows, newest first. The route and ride counts come
// from appProperties written at upload, so listing never has to download a file.
export function listForRestore(files) {
  return files
    .filter((f) => kindOf(f.name))
    .map((f) => ({
      id: f.id,
      name: f.name,
      kind: kindOf(f.name),
      exportedAt: Number(f.appProperties?.exportedAt) || Date.parse(f.modifiedTime) || 0,
      routeCount: f.appProperties?.routeCount != null ? Number(f.appProperties.routeCount) : null,
      rideCount: f.appProperties?.rideCount != null ? Number(f.appProperties.rideCount) : null,
    }))
    .sort((a, b) => b.exportedAt - a.exportedAt);
}

/**
 * One backup, start to finish: export, upload, then prune. The order is the
 * safety rule: nothing old is deleted until the new file is safely on Drive.
 * Pruning failures are swallowed. The backup itself succeeded, and the
 * extra files are pruned on the next run.
 */
export async function runBackup({ drive, exportBundle, now, kind }) {
  const bundle = await exportBundle();
  const at = now();
  const files = await drive.list();
  const name = kind === "auto" ? autoName(at) : manualName(at);
  const existing = kind === "auto" ? files.find((f) => f.name === name) : null;
  const appProperties = {
    exportedAt: String(bundle.exportedAt ?? at),
    routeCount: String(bundle.routes?.length ?? 0),
    rideCount: String(bundle.rides?.length ?? 0),
  };
  const saved = await drive.upload({ name, content: JSON.stringify(bundle), appProperties, existingId: existing?.id ?? null });
  const after = existing ? files : [...files, { id: saved.id, name }];
  for (const id of planPrune(after)) {
    try { await drive.remove(id); } catch { /* next run prunes it */ }
  }
  return { name, at };
}

// ---- 3. Scheduler ----------------------------------------------------------------

/**
 * @param {object} d
 * @param {object} d.settings - { get(key, fallback), set(key, value) }: the settings store
 * @param {object} d.drive - createDriveClient(...)
 * @param {() => Promise<object>} d.exportBundle - Store#exportAll
 * @param {() => Promise<boolean>} d.isConnected - is a refresh token held?
 * @param {() => number} d.now
 * @param {Function} d.setTimeout
 * @param {Function} d.clearTimeout
 * @param {() => boolean} [d.isOnline]
 * @param {(status) => void} [d.onStatus] - called after every state change, for the UI
 */
export function createBackupScheduler(d) {
  const { settings, drive, exportBundle, isConnected, now } = d;
  const isOnline = d.isOnline || (() => true);
  const onStatus = d.onStatus || (() => {});
  let timer = null;
  let running = null; // the in-flight run's promise: single-flight

  const get = (k, fb = null) => settings.get(k, fb);
  const set = (k, v) => settings.set(k, v);

  async function status() {
    const [connected, needsReconnect, owedSince, lastBackupAt, lastError, account] = await Promise.all([
      isConnected(), get(KEYS.NEEDS_RECONNECT, false), get(KEYS.OWED_SINCE), get(KEYS.LAST_BACKUP),
      get(KEYS.LAST_ERROR), get(KEYS.ACCOUNT),
    ]);
    // The Routes-tab dot. Lost access shows at once, because nothing
    // will be backed up until the user acts. Ordinary failures show only once
    // a change has gone a whole day without a backup, since most failures
    // (offline, Google busy) clear by themselves well within that.
    const overdue = owedSince != null && now() - owedSince >= OVERDUE_MS;
    const attention = connected && (needsReconnect || overdue);
    return { connected, needsReconnect, owedSince, lastBackupAt, lastError, account, overdue, attention };
  }

  async function emit() { onStatus(await status()); }

  function cancel() { if (timer) { d.clearTimeout(timer); timer = null; } }

  // When the owed backup may next run: 30 s after the last change, and no
  // sooner than 5 min after the last failure.
  async function dueAt() {
    const [lastChange, lastFailed] = await Promise.all([get(KEYS.LAST_CHANGE, 0), get(KEYS.LAST_ATTEMPT)]);
    return Math.max(lastChange + QUIET_MS, lastFailed != null ? lastFailed + RETRY_MS : 0);
  }

  // Arm the timer for the owed backup, if one is owed and it can run.
  async function schedule() {
    cancel();
    if (running) return; // the run re-schedules itself when it finishes
    if ((await get(KEYS.OWED_SINCE)) == null) return;
    if (!(await isConnected()) || (await get(KEYS.NEEDS_RECONNECT, false))) return;
    if (!isOnline()) return; // poke("online") re-arms it
    const wait = Math.max(0, (await dueAt()) - now());
    timer = d.setTimeout(() => { timer = null; return run("auto"); }, wait);
  }

  async function run(kind) {
    if (running) return running;
    running = (async () => {
      const seqAtStart = await get(KEYS.CHANGE_SEQ, 0);
      try {
        const result = await runBackup({ drive, exportBundle, now, kind });
        await set(KEYS.LAST_BACKUP, result.at);
        await set(KEYS.LAST_ERROR, null);
        await set(KEYS.LAST_ATTEMPT, null);
        // The backup holds everything up to when it started. A change that
        // arrived during the upload is NOT in it, so it stays owed.
        if ((await get(KEYS.CHANGE_SEQ, 0)) === seqAtStart) await set(KEYS.OWED_SINCE, null);
        return { ok: true, ...result };
      } catch (e) {
        const error = e instanceof DriveError ? e : new DriveError("other", e?.message || String(e));
        await set(KEYS.LAST_ERROR, { kind: error.kind, message: messageFor(error), at: now() });
        if (error.kind === "auth") await set(KEYS.NEEDS_RECONNECT, true);
        else await set(KEYS.LAST_ATTEMPT, now());
        return { ok: false, error };
      } finally {
        running = null;
      }
    })();
    const result = await running;
    await schedule();
    await emit();
    return result;
  }

  return {
    status,

    /** A backup-worthy change (see markBackupOwed in app.js). The controller calls
     *  this after the change is saved, and it is persisted before returning. */
    async noteChange() {
      const t = now();
      if ((await get(KEYS.OWED_SINCE)) == null) await set(KEYS.OWED_SINCE, t);
      await set(KEYS.LAST_CHANGE, t);
      await set(KEYS.CHANGE_SEQ, (await get(KEYS.CHANGE_SEQ, 0)) + 1);
      await schedule();
      await emit();
    },

    /** App start, back online, or made visible. Picks up an owed backup that
     *  a kill, a reboot or a network outage interrupted. */
    async poke() {
      await schedule();
      await emit();
    },

    /** "Back up to Google Drive now" from the menu. It runs at once,
     *  whatever the quiet period or retry floor says, because the user asked.
     *  It also clears an owed backup, since it holds the same data. */
    async backupNow() {
      cancel();
      return run("manual");
    },

    /** After Connect or Reconnect. The first backup happens straight away,
     *  so Drive is never left holding nothing after a successful Connect. */
    async connected() {
      await set(KEYS.NEEDS_RECONNECT, false);
      await set(KEYS.LAST_ERROR, null);
      await set(KEYS.LAST_ATTEMPT, null);
      if ((await get(KEYS.OWED_SINCE)) == null) await set(KEYS.OWED_SINCE, now());
      cancel();
      return run("auto");
    },

    async disconnected() {
      cancel();
      await set(KEYS.NEEDS_RECONNECT, false);
      await set(KEYS.LAST_ERROR, null);
      await emit();
    },

    cancel,
  };
}
