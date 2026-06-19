// Pre-build script: generates the version/build-info env file before Vite
// runs. Plain Node — no Wrangler, no Vite config involved, no restrictions.
// Vite loads VITE_*-prefixed vars from these files automatically and exposes
// them via import.meta.env.
//
// Version: bump the `version` field in package.json to mark a release.
// Hash + date: captured automatically from the Cloudflare Pages env var
// (CF_PAGES_COMMIT_SHA) or falls back to 'dev' for local builds.

import fs from "node:fs";

const pkg = JSON.parse(fs.readFileSync("./package.json", "utf8"));
const hash = (process.env.CF_PAGES_COMMIT_SHA || process.env.GITHUB_SHA || "dev").slice(0, 7);
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
