// Persisted UI state — the settings App.jsx writes so that closing and
// reopening the app returns you to where you were.
//
// The persistence itself lives in App.jsx effects, which this dependency-free
// harness can't render. What IS testable, and what this file covers, is the
// DATA those effects hand to the store: which keys exist, whether each one
// belongs in a backup, and whether its stored shape survives the round trip
// through export → JSON file → import.
//
// The first section is a static guard: it scans App.jsx for every persisted
// key and fails if one isn't classified below. That's the check that catches
// the next key added to App.jsx without a matching decision about export.
//
// NOT covered here (needs component-level rendering): the restore *predicates*
// — the "setup" screen exclusion, the `screenHydrated` / `hydrated` write
// gates, and the drop-if-in-the-past filters for day and explore entries.

import { readFileSync } from 'node:fs';
import { Store, MemoryBackend } from './src/lib/storage.js';
import { DEFAULT_UNITS, setFormatSettings, getFormatSettings, defaultCruiseSpeedKmh } from './src/lib/format.js';
import * as learning from './src/lib/learning.js';

let pass = 0, fail = 0;
const ok = (n, c, d = '') => { c ? (pass++, console.log(`  PASS  ${n}`)) : (fail++, console.log(`  FAIL  ${n}  ${d}`)); };
const near = (a, b, t) => Math.abs(a - b) <= t;

let uid = 0; const uuid = () => `id${++uid}`;
const mkStore = () => new Store({ backend: new MemoryBackend(), uuid, learning });

/* ==========================================================================
 * Classification of every setting App.jsx persists.
 *
 *   EXPORTED     — a preference belonging to the RIDER. Must survive
 *                  export/import, or restoring a backup on a new device
 *                  silently resets it.
 *   DEVICE_LOCAL — transient view state describing where this particular
 *                  install was last looking. Deliberately not exported:
 *                  meaningless (or stale) on another device.
 *
 * Keys may appear in SETTING_KEYS without appearing here (e.g. forward-looking
 * ones App.jsx doesn't write yet); that's harmless. The failure mode this
 * guards is the reverse — App.jsx persisting something that quietly falls
 * outside the export.
 * ========================================================================== */
const EXPORTED = [
  'lastOpenedRouteId', // which route to reopen — survives so a restore lands you home
  'cruiseSpeedKmh',    // rider's flat no-wind cruising speed (curve v0)
  'conservatismPct',   // uncertainty allowance
  'displayUnits',      // metric/imperial etc. — a property of the rider, not the device
];
const DEVICE_LOCAL = [
  'lastScreen',        // last open tab
  'lastSelectedDayMs', // last viewed day on the Plan strip (absolute epoch — stale once exported)
  'exploredOverrides', // per-(route,day) what-if times, keyed by day (likewise stale)
  'helpSeen',          // welcome panel dismissal; showing it once on a new device is reasonable
];

console.log('Static guard — every persisted key is classified:');
{
  const src = readFileSync(new URL('./src/App.jsx', import.meta.url), 'utf8');
  const re = /\b(?:set|get)Setting\(\s*"([^"]+)"/g;
  const discovered = new Set();
  let m; while ((m = re.exec(src))) discovered.add(m[1]);

  ok('scanner found the persisted keys', discovered.size >= 8, `found ${discovered.size}`);
  const classified = new Set([...EXPORTED, ...DEVICE_LOCAL]);
  const unclassified = [...discovered].filter((k) => !classified.has(k));
  ok('no unclassified key in App.jsx', unclassified.length === 0,
    `classify these as EXPORTED or DEVICE_LOCAL: ${unclassified.join(', ')}`);
  const stale = [...classified].filter((k) => !discovered.has(k));
  ok('no classification for a key App.jsx no longer writes', stale.length === 0,
    `remove from the lists: ${stale.join(', ')}`);
}

/* Derive the real export whitelist behaviourally rather than reading the
 * SETTING_KEYS constant — this exercises the path a user's backup actually
 * takes, so it can't pass while exportAll is broken. */
async function exportedKeysFor(values) {
  const s = mkStore();
  for (const [k, v] of Object.entries(values)) await s.setSetting(k, v);
  const bundle = await s.exportAll();
  return new Set(Object.keys(bundle.settings));
}

const SAMPLE = {
  lastOpenedRouteId: 'route-abc',
  cruiseSpeedKmh: 24,
  conservatismPct: 87,
  displayUnits: { temp: 'f', duration: 'colon', rideSpeed: 'mph', windSpeed: 'kt', distance: 'mi', rainfall: 'in', decimal: 'comma' },
  lastScreen: 'capture',
  lastSelectedDayMs: 1756000000000,
  exploredOverrides: { 'route-abc:1756000000000': '07:45' },
  helpSeen: true,
};

console.log('\nRider preferences survive export; view state stays local:');
{
  const keys = await exportedKeysFor(SAMPLE);
  for (const k of EXPORTED) ok(`exported: ${k}`, keys.has(k), 'missing from bundle.settings');
  for (const k of DEVICE_LOCAL) ok(`not exported: ${k}`, !keys.has(k), 'leaked into bundle.settings');
}

console.log('\nDisplay units round-trip through a real JSON backup file:');
{
  uid = 0; const s = mkStore();
  await s.setSetting('displayUnits', SAMPLE.displayUnits);
  await s.setSetting('cruiseSpeedKmh', 24.14016);
  // The user's backup is a JSON file, so serialise/parse the way one does.
  const bundle = JSON.parse(JSON.stringify(await s.exportAll()));

  uid = 100; const s2 = mkStore();
  await s2.importAll(bundle);
  const u = await s2.getSetting('displayUnits');
  ok('units object survives as an object', u && typeof u === 'object');
  ok('every unit field intact',
    u && Object.keys(SAMPLE.displayUnits).every((k) => u[k] === SAMPLE.displayUnits[k]),
    JSON.stringify(u));
  ok('fractional cruising speed keeps precision',
    near(await s2.getSetting('cruiseSpeedKmh'), 24.14016, 1e-9));
}

console.log('\nA partial stored units object merges over the defaults:');
{
  // Forward/backward compatibility: a payload written by an older build (or a
  // hand-edited backup) carries only some fields. App.jsx spreads it over
  // DEFAULT_UNITS before priming the format seam; the seam must do the same so
  // no formatter ever sees an undefined unit.
  uid = 0; const s = mkStore();
  await s.setSetting('displayUnits', { rideSpeed: 'mph' });
  const stored = await s.getSetting('displayUnits', null);
  setFormatSettings({ ...DEFAULT_UNITS, ...(stored || {}) });
  const live = getFormatSettings();
  ok('stored field wins', live.rideSpeed === 'mph');
  ok('absent fields fall back to defaults', live.temp === DEFAULT_UNITS.temp && live.rainfall === DEFAULT_UNITS.rainfall);
  ok('no undefined unit fields', Object.keys(DEFAULT_UNITS).every((k) => live[k] !== undefined));

  // The unit-aware cruising-speed default is seeded AFTER units are restored,
  // so a partial imperial payload must still yield the imperial default.
  ok('imperial default from a partial payload', near(defaultCruiseSpeedKmh(live), 15 * 1.609344, 1e-9),
    `${defaultCruiseSpeedKmh(live)}`);
  setFormatSettings(DEFAULT_UNITS); // restore the shared module snapshot
}

console.log('\nExplore overrides keep both entry forms:');
{
  // An entry is either a plain "HH:MM" (respects the route's arrive/depart mode)
  // or { hhmm, depart:true } for a "Go now" instance. Both must come back
  // distinguishable, including across JSON.
  const overrides = {
    'route-abc:1756000000000': '07:45',
    'route-abc:1756086400000': { hhmm: '17:10', depart: true },
  };
  uid = 0; const s = mkStore();
  await s.setSetting('exploredOverrides', overrides);
  const back = await s.getSetting('exploredOverrides');
  ok('plain string entry preserved', back['route-abc:1756000000000'] === '07:45');
  const go = back['route-abc:1756086400000'];
  ok('depart entry preserved', go && go.hhmm === '17:10' && go.depart === true, JSON.stringify(go));

  const viaJson = JSON.parse(JSON.stringify(back));
  ok('both forms survive JSON', viaJson['route-abc:1756000000000'] === '07:45'
    && viaJson['route-abc:1756086400000'].depart === true);
  // App.jsx reads the entry as (entry.hhmm ?? entry), so a plain string must not
  // accidentally expose an `hhmm` property.
  ok('plain string has no hhmm property', back['route-abc:1756000000000'].hhmm === undefined);
}

console.log('\nExplore key format stays parseable (guards stale-entry pruning):');
{
  // App.jsx prunes past entries with Number(key.split(":")[1]), so a route id
  // must never contain a colon. Exercise the REAL id generator (no injected
  // uuid) rather than assuming the format.
  const s = new Store({ backend: new MemoryBackend(), learning });
  const { ride } = await s.recordRide({ routeId: 'r', startedAt: 1, endedAt: 2, actualTimeSec: 900 });
  ok('generated id contains no colon', !String(ride.id).includes(':'), ride.id);

  const dayMs = 1756000000000;
  const key = `${ride.id}:${dayMs}`;
  ok('day recovers from the composed key', Number(key.split(':')[1]) === dayMs);
  ok('recovered day is finite', Number.isFinite(Number(key.split(':')[1])));
}

console.log('\nValue fidelity for the restore comparisons:');
{
  uid = 0; const s = mkStore();
  await s.setSetting('lastSelectedDayMs', 1756000000000);
  await s.setSetting('lastScreen', 'capture');
  await s.setSetting('helpSeen', true);
  await s.setSetting('lastOpenedRouteId', 'route-abc');
  const day = await s.getSetting('lastSelectedDayMs');
  // Restore compares `savedDayMs >= startOfToday`; a number must stay a number.
  ok('day stored as a number', typeof day === 'number' && day === 1756000000000);
  ok('screen stored as a string', (await s.getSetting('lastScreen')) === 'capture');
  ok('helpSeen stored as a boolean', (await s.getSetting('helpSeen')) === true);
  ok('route id round-trips', (await s.getSetting('lastOpenedRouteId')) === 'route-abc');

  // Unset keys must yield the caller's fallback, not undefined — a fresh
  // install has none of these, and every read site supplies a default.
  const fresh = mkStore();
  ok('unset day → fallback null', (await fresh.getSetting('lastSelectedDayMs', null)) === null);
  ok('unset screen → fallback null', (await fresh.getSetting('lastScreen', null)) === null);
  ok('unset helpSeen → fallback false', (await fresh.getSetting('helpSeen', false)) === false);
  ok('unset overrides → fallback null', (await fresh.getSetting('exploredOverrides', null)) === null);
}

console.log('\nMerge import doesn\'t clobber this device\'s preferences:');
{
  uid = 0; const s = mkStore();
  await s.setSetting('displayUnits', { rideSpeed: 'mph' });
  await s.setSetting('conservatismPct', 60);
  const bundle = JSON.parse(JSON.stringify(await s.exportAll()));

  uid = 100; const s2 = mkStore();
  await s2.setSetting('displayUnits', { rideSpeed: 'kmh' });
  await s2.importAll(bundle, 'merge');
  ok('merge keeps local units', (await s2.getSetting('displayUnits')).rideSpeed === 'kmh');
  ok('merge still fills an unset key', (await s2.getSetting('conservatismPct')) === 60);

  await s2.importAll(bundle, 'replace');
  ok('replace overwrites units', (await s2.getSetting('displayUnits')).rideSpeed === 'mph');
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
