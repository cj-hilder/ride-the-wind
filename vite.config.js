import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";

// Version shown in the app: the deliberate semver from package.json (bumped by
// hand when you choose), plus a build identifier captured automatically at
// build time — short git commit hash + build date. No manual step, no state
// to maintain, and the hash lets you pin down exactly which code is running.
const pkg = JSON.parse(readFileSync("./package.json", "utf8"));
function gitShortHash() {
  try {
    return execSync("git rev-parse --short HEAD").toString().trim();
  } catch {
    return "dev"; // no git available (e.g. a from-scratch checkout) — non-fatal
  }
}
const buildDate = new Date().toISOString().slice(0, 10); // YYYY-MM-DD, UTC

// Custom domain — served from the root.
export default defineConfig({
  plugins: [react()],
  base: "/",
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
    __BUILD_HASH__: JSON.stringify(gitShortHash()),
    __BUILD_DATE__: JSON.stringify(buildDate),
  },
});
