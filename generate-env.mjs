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
const ciSha = (
  process.env.WORKERS_CI_COMMIT_SHA ||
  process.env.CF_PAGES_COMMIT_SHA ||
  process.env.GITHUB_SHA ||
  null
);
const hash = (ciSha || "dev").slice(0, 7);
const date = new Date().toISOString().slice(0, 10); // YYYY-MM-DD UTC

const env = `VITE_APP_VERSION=${pkg.version}
VITE_BUILD_HASH=${hash}
VITE_BUILD_DATE=${date}
`;

// `vite build` loads .env.production; `vite` (dev server) loads
// .env.development. Write both so the version line works in either mode.
const mode = process.argv[2] === "dev" ? "development" : "production";
fs.writeFileSync(`.env.${mode}`, env);
console.log(`✅ .env.${mode} written: v${pkg.version} · ${hash} · ${date}`);

// Stamp the same build id into the service worker's cache-version constant.
// public/sw.js is a static file — Vite copies it to dist/ verbatim and never
// runs its own define/replace substitutions on anything under public/, so
// this has to be a literal text edit of the file, done here, before `vite
// build` copies it. Without this, sw.js's bytes never change between builds,
// so the browser never detects an update, and the app can look permanently
// stuck on whatever version first installed the service worker — no console
// error, no build failure, just a deploy that silently never takes effect.
//
// On a real CI build, ciSha is a genuine commit hash, so reusing it here
// keeps this deterministic per-commit like the version footer above — a
// redeploy of the exact same commit correctly looks unchanged to the SW,
// rather than needlessly forcing every device to re-fetch and purge caches
// for no real change. Locally there's no such signal — ciSha is null on
// every local run — so falling back to hash ("dev") the same way would give
// every local build the identical id and reproduce the exact bug this is
// fixing, just for local testing instead of prod. A timestamp guarantees
// each local build is genuinely new, which is what local SW-update testing
// actually needs.
const swPath = "./public/sw.js";
const buildId = ciSha ? `${pkg.version}-${hash}` : `${pkg.version}-dev-${Date.now()}`;
const sw = fs.readFileSync(swPath, "utf8");
const stamped = sw.replace(/const VERSION = "[^"]*";/, `const VERSION = "${buildId}";`);
if (stamped === sw && !sw.includes(`"${buildId}"`)) {
  console.warn("⚠️  generate-env.mjs: couldn't find the VERSION line in public/sw.js — cache-busting was NOT stamped this build.");
} else {
  fs.writeFileSync(swPath, stamped);
  console.log(`✅ public/sw.js stamped: ${buildId}`);
}
