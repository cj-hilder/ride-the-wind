/* ============================================================================
 * allowance — Open-Meteo request-allowance accounting (pure, testable).
 *
 * Open-Meteo's free, non-commercial API is limited per client IP: 600 calls
 * per minute, 5,000 per hour, 10,000 per day (published limits; an ensemble
 * request costs ~15 "calls", a normal forecast 1). Each response reports its
 * cost and the CURRENT window's limit/remaining in X-RateLimit-* headers —
 * in practice the per-minute window — so the hour/day picture is tallied
 * locally from the reported costs. That tally covers this device only; other
 * devices or apps sharing the same IP (e.g. a mobile carrier's shared
 * address) also count against the real limit, which is why a 429 is always
 * treated as authoritative regardless of what the tally says.
 * ========================================================================== */

export const OM_WINDOWS = [
  { name: "minute", ms: 60 * 1000, limit: 600 },
  { name: "hour", ms: 60 * 60 * 1000, limit: 5000 },
  { name: "day", ms: 24 * 60 * 60 * 1000, limit: 10000 },
];
const DAY_MS = OM_WINDOWS[OM_WINDOWS.length - 1].ms;

/** Drop tally entries older than a day (the longest window). */
export function pruneUsage(entries, nowMs) {
  return (entries || []).filter((e) => e && e.at > nowMs - DAY_MS && e.at <= nowMs + 60000 && e.cost > 0);
}

/**
 * Summarise allowance use. `entries` = [{at, cost}] from this device;
 * `server` = latest parsed X-RateLimit headers ({limit, remaining, windowSec,
 * at}) — authoritative for its own window while it's current.
 * Returns { pct, window, windows: {minute, hour, day} } where pct is the
 * HIGHEST percentage used across windows (the one closest to running out)
 * and window names it. pct is 0–100, rounded.
 */
export function allowanceSummary(entries, server, nowMs) {
  const windows = {};
  for (const w of OM_WINDOWS) {
    const used = (entries || []).reduce((s, e) => (e.at > nowMs - w.ms && e.at <= nowMs ? s + e.cost : s), 0);
    windows[w.name] = Math.min(100, (used / w.limit) * 100);
  }
  if (server && server.limit > 0 && server.remaining != null && server.windowSec > 0
      && nowMs - server.at < server.windowSec * 1000) {
    const name = server.windowSec <= 60 ? "minute" : server.windowSec <= 3600 ? "hour" : "day";
    const serverPct = Math.min(100, Math.max(0, ((server.limit - server.remaining) / server.limit) * 100));
    windows[name] = Math.max(windows[name] || 0, serverPct);
  }
  let window = "day", pct = -1;
  for (const w of OM_WINDOWS) if (windows[w.name] > pct) { pct = windows[w.name]; window = w.name; }
  for (const k of Object.keys(windows)) windows[k] = Math.round(windows[k]);
  return { pct: Math.round(Math.max(0, pct)), window, windows };
}
