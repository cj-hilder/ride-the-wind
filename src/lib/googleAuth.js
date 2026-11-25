// Connect to Google Drive: the authorisation-code popup, with PKCE, done by
// hand. Google Identity Services isn't loaded: it's one more third-party
// script, and the flow is a page of code. The pure parts (PKCE, the auth URL,
// reading the callback, checking the exchange result) are exported and tested
// in testdrive.mjs. `connectViaPopup` is the thin browser part.
//
// Why the popup's answer comes back three ways:
// accounts.google.com is served with Cross-Origin-Opener-Policy, so once the
// popup has been on Google's page the browser severs it from this window. When
// it returns to oauth-callback.html, `window.opener` may be null, and this
// side's `popup.closed` may already read true even though the popup is open.
// On Android an installed PWA may open the popup as a separate Chrome tab
// altogether. So the callback page posts the result by `postMessage` (when
// the opener survives), on a `BroadcastChannel`, and into localStorage. This
// side listens for all three, and re-checks localStorage whenever the app
// becomes visible again, which is what happens when the user comes back from
// that Chrome tab. There is no "popup closed" detection, because it can't be
// trusted. The Drive section on the Routes screen offers Cancel instead.
import { GOOGLE_CLIENT_ID, DRIVE_SCOPE, OAUTH_CALLBACK_PATH } from "./googleClient.js";
import { DriveError } from "./driveBackup.js";

export const RESULT_KEY = "ridethewind-oauth-result";
export const CHANNEL = "ridethewind-oauth";

const b64url = (bytes) =>
  btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

/** PKCE verifier and S256 challenge, plus a `state` that ties the answer to this attempt. */
export async function createPkce(cryptoImpl) {
  const verifier = b64url(cryptoImpl.getRandomValues(new Uint8Array(32)));
  const challenge = b64url(await cryptoImpl.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
  const state = b64url(cryptoImpl.getRandomValues(new Uint8Array(16)));
  return { verifier, challenge, state };
}

export function buildAuthUrl({ origin, challenge, state }) {
  const q = new URLSearchParams({
    client_id: GOOGLE_CLIENT_ID,
    redirect_uri: origin + OAUTH_CALLBACK_PATH,
    response_type: "code",
    scope: DRIVE_SCOPE,
    // offline: issue a refresh token, which is the whole point. Automatic
    // backup has to work days later with no gesture. consent: Google only
    // issues a refresh token on a consent screen, so a Reconnect must show
    // one too, or it would come back without one.
    access_type: "offline",
    prompt: "consent",
    code_challenge: challenge,
    code_challenge_method: "S256",
    state,
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${q}`;
}

/** What oauth-callback.html read from its own URL. */
export function parseCallback(search) {
  const p = new URLSearchParams(search);
  return { code: p.get("code"), state: p.get("state"), error: p.get("error") };
}

/**
 * Exchange the code via our token endpoint and check what Google granted.
 * Google's granular consent lets the user untick the Drive box and still
 * "allow", which gives a token that can't touch Drive. That's caught here,
 * at Connect, with a message saying what to do, rather than as a puzzling
 * backup failure later.
 */
export async function exchangeCode({ fetch, code, verifier, endpoint = "/api/google-token" }) {
  let res;
  try {
    res = await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code, codeVerifier: verifier }),
    });
  } catch (e) {
    throw new DriveError("offline", e?.message || "network error");
  }
  let body = {};
  try { body = await res.json(); } catch { /* status decides below */ }
  if (!res.ok) {
    throw new DriveError(res.status >= 500 ? "server" : "other", body.error_description || body.error || `HTTP ${res.status}`);
  }
  if (!String(body.scope || "").split(/\s+/).includes(DRIVE_SCOPE)) {
    throw new DriveError("auth", "Ride the Wind needs permission to use its own Google Drive folder. Connect again and leave that box ticked.");
  }
  if (!body.refresh_token) {
    throw new DriveError("other", "Google didn't grant lasting access. Try Connect again.");
  }
  return { refreshToken: body.refresh_token, accessToken: body.access_token, expiresIn: body.expires_in };
}

/** The Drive account's email, for "Connected as ...". Best effort: Connect
 *  never fails just because this can't be read. */
export async function fetchAccountEmail({ fetch, accessToken }) {
  try {
    const res = await fetch("https://www.googleapis.com/drive/v3/about?fields=user(emailAddress)", {
      headers: { authorization: `Bearer ${accessToken}` },
    });
    if (!res.ok) return null;
    return (await res.json())?.user?.emailAddress ?? null;
  } catch {
    return null;
  }
}

/** Best effort, too: Disconnect forgets the token locally whatever happens
 *  here. no-cors because only the request matters. Its answer can't be read
 *  and isn't needed. */
export async function revokeToken({ fetch, token }) {
  try {
    await fetch("https://oauth2.googleapis.com/revoke", {
      method: "POST",
      mode: "no-cors",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token }).toString(),
    });
  } catch { /* offline: the token is forgotten here anyway */ }
}

/**
 * The browser part. Must be called synchronously from the tap. The popup is
 * opened blank BEFORE anything is awaited, because the PKCE digest is async
 * and a popup opened after an await can lose the tap's user activation and
 * be blocked. Resolves with the exchange result. `signal` aborts it (Cancel).
 */
export function connectViaPopup({ win = window, signal } = {}) {
  const popup = win.open("", "ridethewind-google", "popup,width=480,height=640");
  if (!popup) return Promise.reject(new DriveError("other", "The sign-in window was blocked. Allow popups for this site and try again."));

  return new Promise((resolve, reject) => {
    let pkce = null;
    let done = false;
    const channel = typeof BroadcastChannel !== "undefined" ? new BroadcastChannel(CHANNEL) : null;

    const cleanup = () => {
      done = true;
      win.removeEventListener("message", onMessage);
      win.removeEventListener("storage", onStorage);
      win.document.removeEventListener("visibilitychange", checkStored);
      channel?.close();
    };

    const handle = async (result) => {
      if (done || !pkce || !result || result.state !== pkce.state) return; // not ours, or a stale attempt
      cleanup();
      try { win.localStorage.removeItem(RESULT_KEY); } catch { /* storage blocked: nothing to clear */ }
      try { popup.close(); } catch { /* severed by COOP: the page closes itself */ }
      if (result.error) {
        reject(new DriveError("other", result.error === "access_denied" ? "Google Drive access wasn't allowed." : result.error));
        return;
      }
      try {
        resolve(await exchangeCode({ fetch: win.fetch.bind(win), code: result.code, verifier: pkce.verifier }));
      } catch (e) {
        reject(e);
      }
    };

    function onMessage(e) { if (e.origin === win.location.origin && e.data?.type === CHANNEL) handle(e.data); }
    function onStorage(e) { if (e.key === RESULT_KEY && e.newValue) { try { handle(JSON.parse(e.newValue)); } catch { /* ignore */ } } }
    function checkStored() {
      if (win.document.visibilityState !== "visible") return;
      try { const v = win.localStorage.getItem(RESULT_KEY); if (v) handle(JSON.parse(v)); } catch { /* ignore */ }
    }

    win.addEventListener("message", onMessage);
    win.addEventListener("storage", onStorage);
    win.document.addEventListener("visibilitychange", checkStored);
    if (channel) channel.onmessage = (e) => handle(e.data);
    signal?.addEventListener("abort", () => {
      if (done) return;
      cleanup();
      try { popup.close(); } catch { /* ignore */ }
      reject(new DriveError("cancelled", "Cancelled."));
    });

    createPkce(win.crypto).then((p) => {
      pkce = p;
      try { win.localStorage.removeItem(RESULT_KEY); } catch { /* ignore */ }
      popup.location.href = buildAuthUrl({ origin: win.location.origin, challenge: p.challenge, state: p.state });
    }, (e) => { cleanup(); try { popup.close(); } catch { /* ignore */ } reject(e); });
  });
}
