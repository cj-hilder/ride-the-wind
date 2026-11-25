# Ride the Wind — notes for Claude sessions

## Build, test, deploy

- `npm test` runs every `test*.mjs` suite in the project root (plain Node, no framework).
- `npm run build` is the production build. If `node_modules` is missing, run `npm install` first, then delete the untracked `package-lock.json` it creates (the repo doesn't track one).
- Pushing to `main` deploys to https://ridethewind.nz/ (Cloudflare Pages). Commit and push only when the user asks; they test each change live on their Android phone.

## Previewing the app locally (`.claude/launch.json`)

`.claude/launch.json` defines a `dev` configuration (`npm run dev`, Vite on port 5173) so the desktop app's browser pane can run and inspect the app: start it with `preview_start` using the name `dev`, and stop it with `preview_stop` when done.

- **Welcome panel:** a fresh browser profile opens on the welcome panel with "By using Ride the Wind you agree to these terms" and a **Got it** button. The user (the app's author) has authorised clicking Got it in the local dev app to get past it. This covers localhost only, not the live site.
- **Example route:** with no routes saved, Home shows the Greymouth → Kumara example route (3 forecast stations), so the forecast flow is testable without creating anything.
- **Forecast details:** tapping the weather line under the departure time (e.g. "13°C · a little wet") toggles the details readout ("forecast updated", "Open-Meteo allowance used", "next update").
- **Local data:** IndexedDB database `ride-the-wind`, stores `forecastCache`, `settings`, `routes`, `rides`, `sessions`, … Saved forecasts are reused for 30 min, so clear `forecastCache` (and the `omUsage` setting, for allowance tallies) before measuring network requests. `performance.getEntriesByType('resource')` filtered on `open-meteo` lists what was actually fetched.
- **Simulating conditions in the page** (debugging only; reload to undo):
  - Move time forward: replace `Date.now` with an offset version (the controller calls `Date.now()` each time), then `window.dispatchEvent(new Event('focus'))` to trigger a quiet refresh.
  - Open-Meteo allowance used up: replace `window.fetch` so open-meteo URLs return a `429` response with `Retry-After` and `X-RateLimit-*` headers. Combined with a time offset past the 30-min cache, this shows the allowance banner and fallback.

- **Stale code in the preview:** the app registers its service worker on localhost too, and the worker serves same-origin files cache-first. Vite's dev modules aren't content-hashed, so after editing code the preview can keep running the OLD code. Before checking a change, unregister the worker and clear its cache in the page (`navigator.serviceWorker.getRegistrations()` → `unregister()`, `caches.keys()` → `caches.delete()`), then reload.

Phone-specific behaviour (GPS accuracy, Android touch handling on range sliders, flaky mobile connections) can't be reproduced in the preview; say so and leave it to the user's live test.

## Google Drive backup

Ported from Temperatura (`/Users/caffeinechris/temperatura`, see its `docs/Temperatura.md` → "Google Drive backup" for the behaviour spec). Pure logic in `src/lib/driveBackup.js` (token source, Drive client, scheduler), `googleAuth.js` (PKCE popup), `googleToken.js` (the token relay), `googleClient.js` (client ID + scope); React wiring in `src/driveSync.js`; UI in `src/DriveSection.jsx` on the Routes screen. Tests: `testdrive.mjs`, `testtoken.mjs`.

- **Server code:** only `/api/google-token`, in `worker/index.js` (Cloudflare Worker; `wrangler.jsonc` routes only `/api/*` to it) and mirrored on the Vite dev server in `vite.config.js`. It adds the client secret and relays to Google; it stores nothing.
- **Backup triggers** are marked in one place, `markBackupOwed` / `backupWorthy` in `src/lib/app.js`. A new controller function that changes saved user data must be wrapped there, or its changes won't trigger a backup.
- **Setup outside the repo:** a Google OAuth Web client for Ride the Wind (redirect URIs `https://ridethewind.nz/oauth-callback.html` and `http://localhost:5173/oauth-callback.html`, scope `drive.appdata` only), its client ID in `googleClient.js` (a placeholder disables Connect until then), and `GOOGLE_CLIENT_SECRET` as a Cloudflare Worker secret plus a line in the uncommitted `.env.development` for local sign-in (`generate-env.mjs` keeps lines it doesn't own).
- **Testing the UI without Google:** the Drive state lives in the IndexedDB `settings` store under `drive*` keys (`driveRefreshToken`, `driveAccountEmail`, `driveLastBackupAt`, `driveNeedsReconnect`, …). Writing fake values shows the connected / reconnect states; delete every `drive*` key afterwards. With no secret configured, the dev token endpoint answers `not_configured`, so any real backup attempt fails cleanly. `oauth-callback.html` closes its own tab after ~300 ms.
