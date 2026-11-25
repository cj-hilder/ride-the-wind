// Google Drive backup (spec, Storage → Google Drive backup; build-plan §4
// item 11). Every layer is driven in Node: the token source and the Drive
// client against a fake fetch, and the scheduler against a fake Drive, a fake
// clock and fake timers. That includes the cases that only show up in real
// life: an app kill in the middle of the quiet period, a change arriving
// during an upload, and a week offline.
process.env.TZ = 'UTC'; // the file names use the local date, so pin "local"

import {
  createTokenSource, createDriveClient, createBackupScheduler, runBackup, planPrune, listForRestore,
  autoName, manualName, kindOf, DriveError, messageFor, KEYS, QUIET_MS, RETRY_MS, OVERDUE_MS,
} from './src/lib/driveBackup.js';
import { createAppController } from './src/lib/app.js';
import { MemoryBackend, Store } from './src/lib/storage.js';
import { DOMParser } from './domshim.mjs';
import { createPkce, buildAuthUrl, parseCallback, exchangeCode } from './src/lib/googleAuth.js';
import { GOOGLE_CLIENT_ID, DRIVE_SCOPE } from './src/lib/googleClient.js';
import { webcrypto, createHash } from 'node:crypto';

let pass = 0, fail = 0;
const ok = (n, c, d = '') => { c ? (pass++, console.log('  PASS ' + n)) : (fail++, console.log('  FAIL ' + n + '  ' + d)); };
const settle = async () => { for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r)); };

const DAY = 24 * 60 * 60 * 1000;
const T0 = Date.UTC(2026, 10, 17, 9, 30); // 2026-11-17 09:30

const jsonRes = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

// ---------------------------------------------------------------------------
console.log('\nnames — the local date, and only our own files are ever recognised:');
{
  ok('auto: one per day', autoName(T0) === 'ridethewind-auto-2026-11-17.json', autoName(T0));
  ok('manual: to the minute', manualName(T0) === 'ridethewind-backup-2026-11-17-0930.json', manualName(T0));
  ok('kindOf auto / manual', kindOf(autoName(T0)) === 'auto' && kindOf(manualName(T0)) === 'manual');
  ok('anything else is not ours', kindOf('notes.json') === null && kindOf('ridethewind-auto-2026-11-17.json.bak') === null);
}

// ---------------------------------------------------------------------------
console.log('\nplanPrune — newest 14 auto, newest 10 manual, nothing else touched:');
{
  const autos = Array.from({ length: 20 }, (_, i) => ({ id: `a${i}`, name: autoName(T0 - i * DAY) }));
  const manuals = Array.from({ length: 12 }, (_, i) => ({ id: `m${i}`, name: manualName(T0 - i * 60_000) }));
  const stranger = { id: 'x', name: 'something-else.json' };
  const del = planPrune([...autos, ...manuals, stranger].sort(() => 0.5 - Math.random()));
  ok('deletes the 6 oldest autos', ['a14', 'a15', 'a16', 'a17', 'a18', 'a19'].every((id) => del.includes(id)));
  ok('keeps the 14 newest autos', ['a0', 'a13'].every((id) => !del.includes(id)));
  ok('deletes the 2 oldest manuals', del.includes('m10') && del.includes('m11') && !del.includes('m9'));
  ok('never deletes a file it doesn\'t recognise', !del.includes('x'));
  ok('exactly 8 deletions', del.length === 8, del.length);
  ok('under the limits → nothing', planPrune(autos.slice(0, 14).concat(manuals.slice(0, 10))).length === 0);
}

// ---------------------------------------------------------------------------
console.log('\nlistForRestore — newest first, marked automatic or manual, with route and ride counts:');
{
  const files = [
    { id: '1', name: autoName(T0 - DAY), appProperties: { exportedAt: String(T0 - DAY), routeCount: '3', rideCount: '30' } },
    { id: '2', name: manualName(T0), appProperties: { exportedAt: String(T0), routeCount: '4', rideCount: '41' } },
    { id: '3', name: 'other.json', appProperties: { exportedAt: String(T0 + 1) } },
  ];
  const list = listForRestore(files);
  ok('our two files only', list.length === 2);
  ok('newest first', list[0].id === '2' && list[1].id === '1');
  ok('kind and route/ride counts', list[0].kind === 'manual' && list[0].routeCount === 4 && list[0].rideCount === 41 && list[1].kind === 'auto');
}

// ---------------------------------------------------------------------------
console.log('\ntoken source — refresh via our endpoint, cached in memory until near expiry:');
{
  let clock = T0;
  const calls = [];
  let answer = () => jsonRes(200, { access_token: `at${calls.length}`, expires_in: 3600 });
  const fetch = async (url, init) => { calls.push({ url, body: JSON.parse(init.body) }); return answer(); };
  const ts = createTokenSource({ fetch, now: () => clock, loadRefreshToken: async () => 'rt' });
  const a = await ts.getAccessToken();
  ok('posts the refresh token to /api/google-token', calls[0].url === '/api/google-token' && calls[0].body.refreshToken === 'rt');
  ok('returns the access token', a === 'at1');
  await ts.getAccessToken();
  ok('second call within the hour: cached, no request', calls.length === 1);
  clock += 3600_000 - 30_000; // inside the 60 s safety margin
  await ts.getAccessToken();
  ok('near expiry: refreshed', calls.length === 2);
  await ts.getAccessToken({ forceRefresh: true });
  ok('forceRefresh always refreshes', calls.length === 3);

  answer = () => jsonRes(400, { error: 'invalid_grant', error_description: 'Token has been expired or revoked.' });
  let err; try { await ts.getAccessToken({ forceRefresh: true }); } catch (e) { err = e; }
  ok('invalid_grant → auth (reconnect needed)', err instanceof DriveError && err.kind === 'auth');

  answer = () => jsonRes(502, { error: 'upstream_unreachable' });
  err = null; try { await ts.getAccessToken({ forceRefresh: true }); } catch (e) { err = e; }
  ok('endpoint 502 → server (retry later)', err?.kind === 'server');

  answer = () => jsonRes(500, { error: 'not_configured' });
  err = null; try { await ts.getAccessToken({ forceRefresh: true }); } catch (e) { err = e; }
  ok('not_configured → server, not auth (the user can\'t fix it by reconnecting)', err?.kind === 'server');

  const offline = createTokenSource({ fetch: async () => { throw new TypeError('Failed to fetch'); }, now: () => clock, loadRefreshToken: async () => 'rt' });
  err = null; try { await offline.getAccessToken(); } catch (e) { err = e; }
  ok('network failure → offline', err?.kind === 'offline');

  const none = createTokenSource({ fetch, now: () => clock, loadRefreshToken: async () => null });
  err = null; try { await none.getAccessToken(); } catch (e) { err = e; }
  ok('no refresh token held → auth, and no request made', err?.kind === 'auth');
}

// ---------------------------------------------------------------------------
console.log('\nDrive client — the REST calls:');
{
  const calls = [];
  let responder = () => jsonRes(200, { files: [] });
  const fetch = async (url, init = {}) => { calls.push({ url, init }); return responder(url, init, calls.length); };
  let tokens = 0;
  const getAccessToken = async ({ forceRefresh } = {}) => `tok${++tokens}${forceRefresh ? '-fresh' : ''}`;
  const drive = createDriveClient({ fetch, getAccessToken });

  await drive.list();
  const lu = new URL(calls[0].url);
  ok('list: appDataFolder only', lu.searchParams.get('spaces') === 'appDataFolder');
  ok('list: bearer token', calls[0].init.headers.authorization === 'Bearer tok1');

  calls.length = 0;
  responder = () => jsonRes(200, { id: 'new1', name: 'n' });
  await drive.upload({ name: 'ridethewind-auto-2026-11-17.json', content: '{"a":1}', appProperties: { routeCount: '2' } });
  const up = calls[0];
  ok('create: POST to the upload endpoint, multipart', up.init.method === 'POST' && up.url.includes('/upload/drive/v3/files?uploadType=multipart'));
  ok('create: multipart/related content type with a boundary', /^multipart\/related; boundary=/.test(up.init.headers['content-type']));
  const boundary = up.init.headers['content-type'].split('boundary=')[1];
  const parts = up.init.body.split(`--${boundary}`);
  const meta = JSON.parse(parts[1].split('\r\n\r\n')[1]);
  ok('create: metadata names the file and puts it in appDataFolder', meta.name === 'ridethewind-auto-2026-11-17.json' && meta.parents[0] === 'appDataFolder' && meta.appProperties.routeCount === '2');
  ok('create: content is the bundle', parts[2].split('\r\n\r\n')[1].trim() === '{"a":1}');
  ok('create: body closes the boundary', up.init.body.endsWith(`--${boundary}--`));

  calls.length = 0;
  await drive.upload({ name: 'x', content: '{}', appProperties: {}, existingId: 'f9' });
  const patchMeta = JSON.parse(calls[0].init.body.split('\r\n\r\n')[1].split('\r\n')[0]);
  ok('replace: PATCH the existing file id', calls[0].init.method === 'PATCH' && calls[0].url.includes('/files/f9?uploadType=multipart'));
  ok('replace: no parents in the metadata (Drive rejects them on update)', !('parents' in patchMeta));

  calls.length = 0;
  responder = (url, init, n) => (n === 1 ? jsonRes(401, { error: { message: 'expired' } }) : jsonRes(200, { files: [] }));
  await drive.list();
  ok('401 → one retry with a forced fresh token', calls.length === 2 && calls[1].init.headers.authorization.endsWith('-fresh'));

  const errorFor = async (status, body) => {
    responder = () => jsonRes(status, body);
    try { await drive.list(); } catch (e) { return e; }
  };
  ok('401 twice → auth', (await errorFor(401, {}))?.kind === 'auth');
  ok('403 storageQuotaExceeded → quota', (await errorFor(403, { error: { errors: [{ reason: 'storageQuotaExceeded' }] } }))?.kind === 'quota');
  ok('403 userRateLimitExceeded → rate', (await errorFor(403, { error: { errors: [{ reason: 'userRateLimitExceeded' }] } }))?.kind === 'rate');
  ok('429 → rate', (await errorFor(429, {}))?.kind === 'rate');
  ok('403 insufficientPermissions (user unticked the scope) → auth', (await errorFor(403, { error: { errors: [{ reason: 'insufficientPermissions' }] } }))?.kind === 'auth');
  ok('503 → server', (await errorFor(503, {}))?.kind === 'server');
  responder = () => { throw new TypeError('Failed to fetch'); };
  let e; try { await drive.list(); } catch (x) { e = x; }
  ok('network failure → offline', e?.kind === 'offline');
  ok('every kind has a readable message', ['auth', 'offline', 'quota', 'rate', 'server', 'other'].every((k) => messageFor(new DriveError(k, 'm')).length > 10));
}

// ---------------------------------------------------------------------------
// A fake Drive with the client's own interface, holding files in memory.
function fakeDrive() {
  const files = new Map();
  let n = 0;
  const d = {
    files, failNext: null, uploads: 0, removes: 0, onUpload: null,
    async list() { if (d.failNext) { const e = d.failNext; d.failNext = null; throw e; } return [...files.values()].map(({ id, name, appProperties }) => ({ id, name, appProperties })); },
    async upload({ name, content, appProperties, existingId }) {
      if (d.onUpload) await d.onUpload();
      d.uploads++;
      if (existingId) { const f = files.get(existingId); files.set(existingId, { ...f, content, appProperties }); return { id: existingId, name: f.name }; }
      const id = `f${++n}`; files.set(id, { id, name, content, appProperties }); return { id, name };
    },
    async download(id) { return JSON.parse(files.get(id).content); },
    async remove(id) { d.removes++; files.delete(id); },
  };
  return d;
}

function fakeTimers(clockRef) {
  const pending = [];
  return {
    pending,
    setTimeout(fn, ms) { const t = { at: clockRef.now + ms, fn }; pending.push(t); return t; },
    clearTimeout(t) { const i = pending.indexOf(t); if (i >= 0) pending.splice(i, 1); },
    // Move the clock forward, firing whatever comes due, in order.
    async advance(ms) {
      const end = clockRef.now + ms;
      for (;;) {
        pending.sort((a, b) => a.at - b.at);
        const next = pending[0];
        if (!next || next.at > end) break;
        pending.shift();
        clockRef.now = next.at;
        await next.fn();
        await settle();
      }
      // Never backwards: a callback may itself have moved the clock on.
      clockRef.now = Math.max(end, clockRef.now);
    },
  };
}

// A whole rig: a store, a fake Drive, fake timers, and a scheduler over them.
// `restart()` builds a fresh scheduler on the same storage, which is what an
// app kill followed by a relaunch looks like.
function rig({ connected = true } = {}) {
  const clock = { now: T0 };
  const backend = new MemoryBackend();
  const store = new Store({ backend });
  const drive = fakeDrive();
  let online = true;
  let timers = fakeTimers(clock);
  const statuses = [];
  const settings = { get: (k, fb) => store.getSetting(k, fb), set: (k, v) => store.setSetting(k, v) };
  const build = () => createBackupScheduler({
    settings, drive, exportBundle: () => store.exportAll(), isConnected: async () => connected,
    now: () => clock.now, setTimeout: (f, ms) => timers.setTimeout(f, ms), clearTimeout: (t) => timers.clearTimeout(t),
    isOnline: () => online, onStatus: (s) => statuses.push(s),
  });
  const r = {
    clock, store, drive, statuses, settings, sched: build(),
    get timers() { return timers; },
    setOnline: (v) => { online = v; },
    setConnected: (v) => { connected = v; },
    restart() { timers = fakeTimers(clock); r.sched = build(); return r.sched; },
  };
  return r;
}

console.log('\nscheduler — 30 s quiet period: an editing session is one upload:');
{
  const r = rig();
  for (let i = 0; i < 10; i++) { await r.sched.noteChange(); await r.timers.advance(5_000); }
  ok('nothing uploaded while edits keep coming', r.drive.uploads === 0);
  const lastEdit = T0 + 9 * 5_000;
  await r.timers.advance(QUIET_MS);
  ok('exactly one upload after the edits stop', r.drive.uploads === 1, r.drive.uploads);
  ok('owed cleared', (await r.settings.get(KEYS.OWED_SINCE)) == null);
  ok('last backup time recorded: 30 s after the last edit', (await r.settings.get(KEYS.LAST_BACKUP)) === lastEdit + QUIET_MS, await r.settings.get(KEYS.LAST_BACKUP));
  ok('no timer left armed', r.timers.pending.length === 0);
}

console.log('\nscheduler — the day\'s auto file is replaced, not duplicated:');
{
  const r = rig();
  await r.sched.noteChange(); await r.timers.advance(QUIET_MS);
  await r.sched.noteChange(); await r.timers.advance(QUIET_MS);
  ok('two backups, one file', r.drive.uploads === 2 && r.drive.files.size === 1);
  r.clock.now += DAY;
  await r.sched.noteChange(); await r.timers.advance(QUIET_MS);
  ok('next day: a second file', r.drive.files.size === 2);
}

console.log('\nscheduler — owed survives an app kill in the quiet period:');
{
  const r = rig();
  await r.sched.noteChange();
  await r.timers.advance(10_000);
  r.restart(); // killed: the old timer is gone with the process
  ok('still owed after the kill', (await r.settings.get(KEYS.OWED_SINCE)) === T0);
  await r.sched.poke(); // app start
  await r.timers.advance(QUIET_MS);
  ok('backed up after relaunch', r.drive.uploads === 1 && (await r.settings.get(KEYS.OWED_SINCE)) == null);
}

console.log('\nscheduler — a change during the upload stays owed:');
{
  const r = rig();
  await r.sched.noteChange();
  let midChange = false;
  r.drive.onUpload = async () => { if (!midChange) { midChange = true; r.clock.now += 1000; await r.sched.noteChange(); } };
  await r.timers.advance(QUIET_MS);
  ok('first upload done', r.drive.uploads >= 1);
  ok('the mid-upload change is still owed after it', r.drive.uploads > 1 || (await r.settings.get(KEYS.OWED_SINCE)) != null);
  r.drive.onUpload = null;
  await r.timers.advance(QUIET_MS + 5_000);
  ok('and is backed up by the next run', r.drive.uploads === 2 && (await r.settings.get(KEYS.OWED_SINCE)) == null, r.drive.uploads);
}

console.log('\nscheduler — failures retry no faster than every 5 minutes:');
{
  const r = rig();
  r.drive.failNext = new DriveError('server', 'boom');
  await r.sched.noteChange();
  await r.timers.advance(QUIET_MS);
  ok('first attempt failed, still owed', r.drive.uploads === 0 && (await r.settings.get(KEYS.OWED_SINCE)) === T0);
  const err = await r.settings.get(KEYS.LAST_ERROR);
  ok('error recorded with a readable message', err?.kind === 'server' && err.message.length > 10);
  await r.timers.advance(RETRY_MS - 1000);
  ok('no retry before 5 min', r.drive.uploads === 0);
  await r.sched.noteChange(); // a new edit doesn't jump the queue
  await r.timers.advance(QUIET_MS - 5_000);
  ok('a new edit doesn\'t retry early', r.drive.uploads === 0);
  await r.timers.advance(10_000);
  ok('retried once both the floor and the quiet period have passed', r.drive.uploads === 1);
  ok('error cleared on success', (await r.settings.get(KEYS.LAST_ERROR)) == null);
}

console.log('\nscheduler — offline: waits for "online" instead of spinning:');
{
  const r = rig();
  r.setOnline(false);
  await r.sched.noteChange();
  ok('offline: no timer armed', r.timers.pending.length === 0);
  await r.timers.advance(DAY / 2);
  r.setOnline(true);
  await r.sched.poke(); // the online event
  await r.timers.advance(0);
  ok('uploaded as soon as it\'s back online (quiet period long passed)', r.drive.uploads === 1);
}

console.log('\nscheduler — overdue at 24 h drives the hamburger dot:');
{
  const r = rig();
  r.setOnline(false);
  await r.sched.noteChange();
  await r.timers.advance(OVERDUE_MS - 60_000);
  ok('under a day: no dot', !(await r.sched.status()).attention);
  await r.timers.advance(60_000);
  const s = await r.sched.status();
  ok('a day unbacked-up: overdue and dot', s.overdue && s.attention);
}

console.log('\nscheduler — lost access stops it at once, and Reconnect uploads the owed backup:');
{
  const r = rig();
  r.drive.failNext = new DriveError('auth', 'revoked');
  await r.sched.noteChange();
  await r.timers.advance(QUIET_MS);
  const s = await r.sched.status();
  ok('needs reconnect', s.needsReconnect === true);
  ok('dot straight away, not after 24 h', s.attention === true);
  ok('no retry timer', r.timers.pending.length === 0);
  await r.sched.noteChange();
  await r.timers.advance(DAY);
  ok('further changes don\'t retry either', r.drive.uploads === 0);
  await r.sched.connected();
  await settle();
  ok('reconnect uploads at once', r.drive.uploads === 1);
  const after = await r.sched.status();
  ok('cleared: no reconnect, no dot, nothing owed', !after.needsReconnect && !after.attention && after.owedSince == null);
}

console.log('\nscheduler — not connected: changes are remembered, nothing is attempted:');
{
  const r = rig({ connected: false });
  await r.sched.noteChange();
  await r.timers.advance(DAY * 3);
  ok('no upload', r.drive.uploads === 0);
  ok('no dot for someone who never connected', !(await r.sched.status()).attention);
  r.setConnected(true);
  await r.sched.connected();
  await settle();
  ok('first Connect backs up straight away', r.drive.uploads === 1);
}

console.log('\nscheduler — Connect with nothing owed still makes a first backup:');
{
  const r = rig();
  await r.sched.connected();
  await settle();
  ok('one backup', r.drive.uploads === 1 && r.drive.files.size === 1);
}

console.log('\nscheduler — "Back up now" runs at once and also clears an owed backup:');
{
  const r = rig();
  await r.sched.noteChange();
  const res = await r.sched.backupNow();
  ok('ran immediately, as a manual file', res.ok && kindOf(res.name) === 'manual' && r.drive.uploads === 1);
  ok('owed cleared', (await r.settings.get(KEYS.OWED_SINCE)) == null);
  await r.timers.advance(QUIET_MS);
  ok('the pending auto timer was cancelled', r.drive.uploads === 1);
}

console.log('\nrunBackup — prunes only after a successful upload:');
{
  const drive = fakeDrive();
  for (let i = 1; i <= 16; i++) drive.files.set(`old${i}`, { id: `old${i}`, name: autoName(T0 - i * DAY), content: '{}' });
  const bundle = { format: 'ride-the-wind/export', exportedAt: T0, routes: [{}, {}], rides: [{}, {}, {}] };
  drive.onUpload = async () => { throw new DriveError('offline', 'x'); };
  try { await runBackup({ drive, exportBundle: async () => bundle, now: () => T0, kind: 'auto' }); } catch { /* expected */ }
  ok('failed upload: nothing deleted', drive.files.size === 16 && drive.removes === 0);
  drive.onUpload = null;
  await runBackup({ drive, exportBundle: async () => bundle, now: () => T0, kind: 'auto' });
  ok('successful upload: pruned to 14 autos', [...drive.files.values()].filter((f) => kindOf(f.name) === 'auto').length === 14);
  ok('today\'s new file is among them', [...drive.files.values()].some((f) => f.name === autoName(T0)));
  { const props = [...drive.files.values()].find((f) => f.name === autoName(T0)).appProperties;
    ok('route and ride counts are written for the Restore list', props.routeCount === '2' && props.rideCount === '3'); }
}

// A real ~5 km GPX through the full controller stack (as in testapp.mjs).
let gpxPts = '';
for (let i = 0; i <= 50; i++) gpxPts += `<trkpt lat="0" lon="${(i * 0.0009).toFixed(5)}"><ele>10</ele></trkpt>`;
const GPX = `<?xml version="1.0"?><gpx><trk><trkseg>${gpxPts}</trkseg></trk></gpx>`;
const SETUP = { name: 'Home → Office', seedStillAirSec: 1000, seedHeadwind20Sec: 1300, seedTailwind20Sec: 760, targetArrival: '08:45', activeDays: ['MO'] };
const mkApp = (clock) => createAppController({
  backend: new MemoryBackend(), now: () => clock.now, domParser: new DOMParser(),
  fetchForecastFor: () => Promise.reject(new Error('no network in tests')),
  fetchEnsembleFor: () => Promise.reject(new Error('no network in tests')),
});

console.log('\ncontroller — every saved user change marks a backup owed, and nothing else does:');
{
  const clock = { now: T0 };
  const app = mkApp(clock);
  let marks = 0;
  app.setBackupListener(async () => { marks++; });
  const count = async (fn) => { const before = marks; await fn(); return marks - before; };

  let route;
  ok('create route', (await count(async () => { route = await app.createRoute(GPX, SETUP); })) === 1);
  ok('edit route', (await count(() => app.updateRoute(route.id, { name: 'Commute' }))) === 1);
  ok('reorder routes', (await count(() => app.reorderRoutes([route.id]))) === 1);
  let ride;
  ok('record ride', (await count(async () => {
    ride = (await app.recordRide({ routeId: route.id, actualTimeSec: 1100, startedAt: T0 - 1100e3, endedAt: T0, forecastWind: [] })).ride;
  })) === 1);
  ok('edit ride', (await count(() => app.updateRide(ride.id, { actualTimeSec: 1050 }))) === 1);
  ok('mark ride and earlier not used', (await count(() => app.excludeRideAndEarlier(ride.id))) === 1);
  ok('delete ride', (await count(() => app.deleteRide(ride.id))) === 1);
  ok('cruising speed setting', (await count(() => app.store.setSetting('cruiseSpeedKmh', 22))) === 1);
  ok('uncertainty allowance setting', (await count(() => app.store.setSetting('conservatismPct', 90))) === 1);
  ok('units setting', (await count(() => app.store.setSetting('displayUnits', { distance: 'mi' }))) === 1);
  ok('view state is not a trigger', (await count(async () => {
    await app.store.setSetting('lastScreen', 'routes'); await app.store.setSetting('lastOpenedRouteId', route.id);
  })) === 0);
  ok('Drive bookkeeping is not a trigger', (await count(() => app.store.setSetting(KEYS.LAST_BACKUP, T0))) === 0);
  ok('the example route is not a trigger', (await count(() => app.recordRide({ routeId: '__example__', actualTimeSec: 900, endedAt: T0 }))) === 0);
  const bundle = await app.store.exportAll();
  ok('restoring a backup is not a trigger', (await count(() => app.importAll(bundle, 'replace'))) === 0);
  ok('delete route', (await count(() => app.deleteRoute(route.id))) === 1);

  app.setBackupListener(async () => { throw new Error('storage hiccup'); });
  const warn = console.warn; console.warn = () => {};
  let threw = false, saved = null;
  try { saved = await app.createRoute(GPX, { ...SETUP, name: 'Gym' }); } catch { threw = true; }
  console.warn = warn;
  ok('a failure to mark never fails the user\'s save', !threw && (await app.getRoute(saved.id))?.name === 'Gym');
}

console.log('\nround trip — a Drive backup restores exactly like a backup file:');
{
  const clock = { now: T0 };
  const app = mkApp(clock);
  const route = await app.createRoute(GPX, SETUP);
  await app.recordRide({ routeId: route.id, actualTimeSec: 1100, startedAt: T0 - 1100e3, endedAt: T0, forecastWind: [] });
  await app.store.setSetting('cruiseSpeedKmh', 21);
  const drive = fakeDrive();
  const { name } = await runBackup({ drive, exportBundle: () => app.store.exportAll(), now: () => T0, kind: 'manual' });
  const file = [...drive.files.values()].find((f) => f.name === name);
  ok('restore list shows 1 route, 1 ride', file.appProperties.routeCount === '1' && file.appProperties.rideCount === '1');
  const bundle = await drive.download(file.id);
  const fresh = createAppController({ backend: new MemoryBackend(), now: () => T0, domParser: new DOMParser() });
  await fresh.importAll(bundle, 'replace');
  ok('route restored', (await fresh.getRoute(route.id))?.name === 'Home → Office');
  ok('ride restored', (await fresh.listRides(route.id)).length === 1 && (await fresh.listRides(route.id))[0].actualTimeSec === 1100);
  ok('settings restored', (await fresh.store.getSetting('cruiseSpeedKmh', null)) === 21);
}

console.log('\nConnect — PKCE and the sign-in URL:');
{
  const a = await createPkce(webcrypto), b = await createPkce(webcrypto);
  ok('verifier: 43 url-safe chars (RFC 7636 minimum)', /^[A-Za-z0-9_-]{43}$/.test(a.verifier), a.verifier);
  const expected = createHash('sha256').update(a.verifier).digest('base64url');
  ok('challenge is the S256 of the verifier', a.challenge === expected);
  ok('fresh verifier and state each time', a.verifier !== b.verifier && a.state !== b.state);
  const u = new URL(buildAuthUrl({ origin: 'https://ridethewind.nz', challenge: a.challenge, state: a.state }));
  const q = u.searchParams;
  ok('Google\'s auth endpoint', u.origin + u.pathname === 'https://accounts.google.com/o/oauth2/v2/auth');
  ok('our client id, code flow', q.get('client_id') === GOOGLE_CLIENT_ID && q.get('response_type') === 'code');
  ok('only the drive.appdata scope', q.get('scope') === DRIVE_SCOPE);
  ok('offline + consent, so a refresh token is always issued (Reconnect too)', q.get('access_type') === 'offline' && q.get('prompt') === 'consent');
  ok('S256 challenge and state carried', q.get('code_challenge') === a.challenge && q.get('code_challenge_method') === 'S256' && q.get('state') === a.state);
  ok('redirect to the registered callback page', q.get('redirect_uri') === 'https://ridethewind.nz/oauth-callback.html');
  ok('parseCallback: code and state', JSON.stringify(parseCallback('?code=c1&state=s1&scope=x')) === JSON.stringify({ code: 'c1', state: 's1', error: null }));
  ok('parseCallback: access_denied', parseCallback('?error=access_denied&state=s1').error === 'access_denied');
}

console.log('\nConnect — the exchange result is checked before it is trusted:');
{
  const answer = (status, body) => async (url, init) => { answer.last = { url, body: JSON.parse(init.body) }; return jsonRes(status, body); };
  let fetch = answer(200, { access_token: 'at', refresh_token: 'rt', expires_in: 3599, scope: DRIVE_SCOPE });
  const r = await exchangeCode({ fetch, code: 'c', verifier: 'v' });
  ok('posts code + verifier to our endpoint', answer.last.url === '/api/google-token' && answer.last.body.code === 'c' && answer.last.body.codeVerifier === 'v');
  ok('returns the refresh token', r.refreshToken === 'rt' && r.accessToken === 'at');
  const fails = async (f) => { try { await exchangeCode({ fetch: f, code: 'c', verifier: 'v' }); } catch (e) { return e; } };
  const unticked = await fails(answer(200, { access_token: 'at', refresh_token: 'rt', scope: 'openid' }));
  ok('Drive box unticked on the consent screen → auth, saying to leave it ticked', unticked?.kind === 'auth' && /ticked/.test(unticked.message));
  ok('no refresh token → error, not a half-connected state', (await fails(answer(200, { access_token: 'at', scope: DRIVE_SCOPE })))?.kind === 'other');
  ok('Google rejects the code → error with Google\'s reason', /bad code/.test((await fails(answer(400, { error: 'invalid_grant', error_description: 'bad code' })))?.message));
  ok('endpoint not configured → server', (await fails(answer(500, { error: 'not_configured' })))?.kind === 'server');
  ok('offline → offline', (await fails(async () => { throw new TypeError('Failed to fetch'); }))?.kind === 'offline');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
