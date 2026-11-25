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

Phone-specific behaviour (GPS accuracy, Android touch handling on range sliders, flaky mobile connections) can't be reproduced in the preview; say so and leave it to the user's live test.
