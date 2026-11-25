// Pre-build script: generates the version/build-info env file before Vite
// runs. Plain Node — no Wrangler, no Vite config involved, no restrictions.
// Vite loads VITE_*-prefixed vars from these files automatically and exposes
// them via import.meta.env.
//
// Version: bump the `version` field in package.json to mark a release.
// Hash + date: captured automatically from the build environment (see below
// for which variable, depending on the deploy pipeline) or falls back to
// 'dev' for local builds with no matching env var.

import fs from "node:fs";

const pkg = JSON.parse(fs.readFileSync("./package.json", "utf8"));
// This project deploys via Workers Builds (npx wrangler deploy), which injects
// WORKERS_CI_COMMIT_SHA. CF_PAGES_COMMIT_SHA/GITHUB_SHA are kept as fallbacks
// in case the pipeline ever changes (legacy Pages builds, or GitHub Actions).
const hash = (
  process.env.WORKERS_CI_COMMIT_SHA ||
  process.env.CF_PAGES_COMMIT_SHA ||
  process.env.GITHUB_SHA ||
  "dev"
).slice(0, 7);
const date = new Date().toISOString().slice(0, 10); // YYYY-MM-DD UTC

const env = `VITE_APP_VERSION=${pkg.version}
VITE_BUILD_HASH=${hash}
VITE_BUILD_DATE=${date}
`;

// `vite build` loads .env.production; `vite` (dev server) loads
// .env.development. Write both so the version line works in either mode.
const mode = process.argv[2] === "dev" ? "development" : "production";
// Keep every line this script doesn't own. .env.development also holds
// hand-added local secrets (GOOGLE_CLIENT_SECRET for the dev token endpoint,
// see vite.config.js), and rewriting the file wholesale on every `npm run dev`
// would silently delete them.
const envFile = `.env.${mode}`;
const owned = /^VITE_(APP_VERSION|BUILD_HASH|BUILD_DATE)=/;
const kept = fs.existsSync(envFile)
  ? fs.readFileSync(envFile, "utf8").split("\n").filter((l) => l.trim() && !owned.test(l))
  : [];
fs.writeFileSync(envFile, env + kept.map((l) => l + "\n").join(""));
console.log(`✅ ${envFile} written: v${pkg.version} · ${hash} · ${date}`);

// Stamp the service worker's cache-busting build id (read by public/sw.js via
// importScripts). The old `sed` step lives in the GitHub Pages workflow, which
// the live Cloudflare deploy never runs, so the shell cache key stayed "dev"
// forever. Writing a separate generated file (gitignored) rather than editing
// public/sw.js in place keeps the tracked worker untouched by every build.
// Ported from Temperatura.
const buildId = `${hash}-${date}`;
fs.writeFileSync("public/build-id.js", `self.__RTW_BUILD_ID__ = "${buildId}";\n`);
console.log(`✅ public/build-id.js written: ${buildId}`);
