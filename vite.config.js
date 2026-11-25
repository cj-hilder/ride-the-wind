import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import { handleTokenRequest } from "./src/lib/googleToken.js";

// Serves /api/google-token on the dev server with the same handler the
// Cloudflare Worker uses (worker/index.js), so Drive sign-in works under
// `npm run dev` with no wrangler and no new dependency. The secret comes from
// the uncommitted .env.development. It has no VITE_ prefix, so Vite never
// exposes it to the client bundle.
function devTokenEndpoint(secret) {
  return {
    name: "ridethewind-dev-token-endpoint",
    configureServer(server) {
      server.middlewares.use("/api/google-token", async (req, res) => {
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        const body = Buffer.concat(chunks);
        const request = new Request(`http://${req.headers.host}${req.originalUrl}`, {
          method: req.method,
          headers: req.headers,
          body: req.method === "GET" || req.method === "HEAD" ? undefined : body,
        });
        const response = await handleTokenRequest(request, { clientSecret: secret, fetch });
        res.statusCode = response.status;
        response.headers.forEach((value, key) => res.setHeader(key, value));
        res.end(await response.text());
      });
    },
  };
}

// Custom domain — served from the root.
export default defineConfig(({ mode }) => {
  // "" prefix: load every key, not just VITE_*. This reads the secret for
  // the dev endpoint only. It does not put it in import.meta.env.
  const env = loadEnv(mode, process.cwd(), "");
  return {
    plugins: [react(), devTokenEndpoint(env.GOOGLE_CLIENT_SECRET)],
    base: "/",
  };
});
