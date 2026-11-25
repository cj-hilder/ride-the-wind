// The Worker entry. Only /api/* reaches it (`run_worker_first` in
// wrangler.jsonc). Every other path is served straight from dist/ by
// Cloudflare's static-assets layer, exactly as before this file existed, so
// the app itself never waits on Worker code. The logic is in
// src/lib/googleToken.js, which is tested in Node (testtoken.mjs).
import { handleTokenRequest } from "../src/lib/googleToken.js";

export default {
  async fetch(request, env) {
    const { pathname } = new URL(request.url);
    if (pathname === "/api/google-token") {
      // GOOGLE_CLIENT_SECRET is a Worker secret, set in the Cloudflare
      // dashboard. If it's missing, the handler answers not_configured rather
      // than throwing.
      return handleTokenRequest(request, { clientSecret: env.GOOGLE_CLIENT_SECRET, fetch });
    }
    // Any other /api/* path is an error. It must never fall through to the
    // SPA fallback, which would answer it with index.html and a 200, and the
    // app would mistake that for success.
    return new Response(JSON.stringify({ error: "not_found" }), {
      status: 404,
      headers: { "content-type": "application/json", "cache-control": "no-store" },
    });
  },
};
