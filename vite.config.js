import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { readFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// Version shown in the app: the deliberate semver from package.json (bumped by
// hand when you choose), plus a build identifier captured automatically at
// build time — short git commit hash + build date. No manual step, no state
// to maintain, and the hash lets you pin down exactly which code is running.
//
// All of this runs inside a plugin's config() hook rather than at the top
// level of this file. Some CI tooling (Cloudflare's Wrangler, in particular)
// does its own static parse of vite.config.js before Vite ever loads it, and
// that parser is far stricter than Node/Vite — it can choke on top-level
// side-effecting code (reading files, running git, try/catch at module
// scope) with an opaque "Error parsing file" and no line number. Keeping the
// top-level of the file to plain imports and a plain defineConfig object, and
// deferring all real work to a hook that only runs once Vite itself takes
// over, avoids that static-parse step entirely.
function versionPlugin() {
  return {
    name: "version-define",
    config() {
      const pkgPath = fileURLToPath(new URL("./package.json", import.meta.url));
      const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
      const fromEnv = process.env.CF_PAGES_COMMIT_SHA || process.env.GITHUB_SHA;
      let hash = "dev";
      if (fromEnv) {
        hash = fromEnv.slice(0, 7);
      } else {
        try {
          hash = execSync("git rev-parse --short HEAD", { stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
        } catch {
          hash = "dev";
        }
      }
      const buildDate = new Date().toISOString().slice(0, 10); // YYYY-MM-DD, UTC
      return {
        define: {
          __APP_VERSION__: JSON.stringify(pkg.version),
          __BUILD_HASH__: JSON.stringify(hash),
          __BUILD_DATE__: JSON.stringify(buildDate),
        },
      };
    },
  };
}

// Custom domain — served from the root.
export default defineConfig({
  plugins: [react(), versionPlugin()],
  base: "/",
});
