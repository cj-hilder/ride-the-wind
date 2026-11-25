// The Google OAuth client this app signs in with (Google Drive
// backup). The client ID is public by design: it appears in every sign-in URL
// the browser opens, so it lives in source rather than in an env var. The
// client SECRET is not here and must never be: it is a Worker secret in
// production and a line in the uncommitted .env.development locally.
//
// PLACEHOLDER until Ride the Wind's own OAuth client exists (Google Cloud
// Console → a Web application client with redirect URIs
// https://ridethewind.nz/oauth-callback.html and
// http://localhost:5173/oauth-callback.html). Not Temperatura's client: the
// consent screen would name the wrong app, and the two apps would share one
// hidden appDataFolder. While this is the placeholder, Connect is disabled.
export const GOOGLE_CLIENT_ID = "REPLACE_WITH_RIDE_THE_WIND_CLIENT_ID.apps.googleusercontent.com";
export const GOOGLE_CLIENT_CONFIGURED = !GOOGLE_CLIENT_ID.startsWith("REPLACE_");

// The only scope requested. It reaches the app's own hidden appDataFolder and
// nothing else in the user's Drive, and it is non-sensitive, which is what
// lets the consent screen be published to production without Google review.
export const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive.appdata";

// Where Google sends the authorisation popup back to. A standalone page, not
// an SPA route: the app's own window must never navigate away, since a ride
// may be recording in it. It must match a redirect URI registered on the OAuth client
// exactly, for every origin the app is served from.
export const OAUTH_CALLBACK_PATH = "/oauth-callback.html";

export const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
