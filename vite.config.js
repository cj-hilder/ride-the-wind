import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { readFileSync } from "node:fs";

// Version shown in the app: the deliberate semver from package.json (bumped by
// hand when you choose), plus a build identifier captured automatically at
// build time — short git commit hash from Cloudflare + build date.
const pkg = JSON.parse(readFileSync("./package.json", "utf8"));
const buildDate = new Date().toISOString().slice(0, 10); // YYYY-MM-DD, UTC

// Custom domain — served from the root.
export default defineConfig({
  plugins: [react()],
  base: "/",
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
    // Fallback to "dev" locally, use Cloudflare's commit SHA (shortened to 7 characters) on deployment
    __BUILD_HASH__: JSON.stringify(process.env.CF_PAGES_COMMIT_SHA?.slice(0, 7) || "dev"),
    __BUILD_DATE__: JSON.stringify(buildDate),
  },
});
