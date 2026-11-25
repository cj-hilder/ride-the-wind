// The token endpoint, POST /api/google-token: the app's only server code (see
// build-plan §2). It is pure (the request, the secret and fetch come in as
// parameters), so the same function runs in the Cloudflare Worker
// (worker/index.js), in the Vite dev server (vite.config.js) and in
// testtoken.mjs.
//
// Why a server is involved at all: automatic backup has to work with no user
// gesture, hours or days after Connect, so it needs a refresh token. Google
// gives one to a web client only through the authorisation-code exchange, and
// that exchange (and every refresh after it) needs the client secret, which
// can't ship in a browser bundle. So this endpoint adds the secret and
// relays the request to Google. It stores nothing and never logs a request
// body or response. The refresh token itself lives on the user's phone.
import { GOOGLE_CLIENT_ID, GOOGLE_TOKEN_URL, OAUTH_CALLBACK_PATH } from "./googleClient.js";

const json = (status, body) =>
  new Response(JSON.stringify(body), {
    status,
    // no-store: a token must never sit in any cache between here and the app.
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });

/**
 * Body is one of:
 *   { code, codeVerifier }  → exchange an authorisation code (Connect)
 *   { refreshToken }        → get a fresh access token (every backup)
 * The response is Google's own JSON and status, passed through unchanged, so
 * the client sees Google's real error (e.g. `invalid_grant` when the user
 * has revoked access) and can tell "reconnect" from "try again later".
 */
export async function handleTokenRequest(request, { clientSecret, fetch }) {
  if (request.method !== "POST") return json(405, { error: "method_not_allowed" });

  // Same-origin only. This doesn't make the endpoint secret, because a
  // non-browser client can forge any header. What it does is stop another
  // website from using a visitor's browser to make calls through it. The
  // redirect URI below is derived from this same origin, so a code issued to
  // some other site's redirect could not be exchanged here anyway.
  const origin = new URL(request.url).origin;
  if (request.headers.get("origin") !== origin) return json(403, { error: "forbidden_origin" });

  // Checked before reading the body, so a deploy that is missing its secret
  // says so plainly instead of surfacing as a confusing Google error.
  if (!clientSecret) return json(500, { error: "not_configured" });

  let body;
  try {
    body = await request.json();
  } catch {
    return json(400, { error: "bad_request" });
  }
  if (!body || typeof body !== "object") return json(400, { error: "bad_request" });

  const form = new URLSearchParams({ client_id: GOOGLE_CLIENT_ID, client_secret: clientSecret });
  if (typeof body.code === "string" && typeof body.codeVerifier === "string") {
    form.set("grant_type", "authorization_code");
    form.set("code", body.code);
    form.set("code_verifier", body.codeVerifier);
    // Derived here rather than taken from the body: it must equal the one the
    // popup was opened with, and the server is the one place that already
    // knows the app's own origin.
    form.set("redirect_uri", origin + OAUTH_CALLBACK_PATH);
  } else if (typeof body.refreshToken === "string") {
    form.set("grant_type", "refresh_token");
    form.set("refresh_token", body.refreshToken);
  } else {
    return json(400, { error: "bad_request" });
  }

  let res;
  try {
    res = await fetch(GOOGLE_TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: form.toString(),
    });
  } catch {
    // Google unreachable from here. 502 tells the client that it's worth a
    // retry later, and that it does not need to reconnect.
    return json(502, { error: "upstream_unreachable" });
  }
  let payload;
  try {
    payload = await res.json();
  } catch {
    return json(502, { error: "upstream_bad_response" });
  }
  return json(res.status, payload);
}
