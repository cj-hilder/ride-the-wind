# Ride the Wind

**[Open the app → ridethewind.nz](https://ridethewind.nz/)**

A Progressive Web App that predicts bike commute times from forecast
wind.

**Free and open source**, released under the MIT License by Chris Hilder — free
to use, study, modify, and share. Your routes and rides stay on your device.

Everything runs locally
in the browser; the only network calls are to the
[Open-Meteo](https://open-meteo.com) forecast and ensemble APIs.

## Develop

```
npm install
npm run dev
```

Built with Vite and React. The prediction logic lives in `src/lib/` as small,
separately-tested modules (wind model, ensemble, learning, verdict, storage);
run the test suites in the project root with `node test*.mjs`.

## Deploy

Pushing to `main` triggers a Cloudflare Pages build (`npm run build`, output
`dist/`), which deploys to [ridethewind.nz](https://ridethewind.nz/). The
GitHub Pages workflow that previously served this app has been disabled; the
project now lives at its own domain rather than a `github.io` subdirectory.

### Versioning a release

The version shown in the app's help panel comes from two places:

- **`package.json`** — the `version` field (e.g. `1.0.0`) is the deliberate
  release number. Bump it by hand when you want to mark a release; it follows
  semver (major.minor.patch) at your discretion.
- **Build identifier** — a short git commit hash and the build date are
  captured automatically by `vite.config.js` on every build (via Vite's
  `define`), so each deploy is independently identifiable without any manual
  step. No file to edit for this part.

To cut a new version: edit `version` in `package.json`, commit, and push to
`main` — the next Cloudflare build picks up the new version and a fresh build
identifier together.

## License

MIT — see [LICENSE](LICENSE). Free to use, modify, and distribute. Provided as
is, without warranty: the times it gives are forecast-based estimates, not
guarantees, so ride safely and within the law.
