// handleTokenRequest — the /api/google-token endpoint (spec, Storage → Google
// Drive backup; build-plan §2 and §4 item 11). Google is a fake fetch: these
// tests check exactly what is sent to Google and what comes back to the app.
import { handleTokenRequest } from './src/lib/googleToken.js';
import { GOOGLE_CLIENT_ID, GOOGLE_TOKEN_URL } from './src/lib/googleClient.js';

let pass = 0, fail = 0;
const ok = (n, c, d = '') => { c ? (pass++, console.log('  PASS ' + n)) : (fail++, console.log('  FAIL ' + n + '  ' + d)); };

const APP = 'https://temperatura.hilderbuild.com';
const SECRET = 'test-secret';

const req = (body, { origin = APP, method = 'POST', url = APP + '/api/google-token', raw } = {}) =>
  new Request(url, {
    method,
    headers: { 'content-type': 'application/json', ...(origin ? { origin } : {}) },
    body: method === 'GET' ? undefined : raw ?? JSON.stringify(body),
  });

// A fake Google: records each call, answers with the given status and JSON.
function fakeGoogle(status = 200, payload = { access_token: 'at', expires_in: 3599 }) {
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({ url, init, form: new URLSearchParams(init.body) });
    return new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } });
  };
  return { calls, fetch };
}

console.log('\nexchange — Connect\'s authorisation code:');
{
  const g = fakeGoogle(200, { access_token: 'at', refresh_token: 'rt', expires_in: 3599 });
  const res = await handleTokenRequest(req({ code: 'c1', codeVerifier: 'v1' }), { clientSecret: SECRET, fetch: g.fetch });
  const f = g.calls[0]?.form;
  ok('one call, to Google\'s token endpoint', g.calls.length === 1 && g.calls[0].url === GOOGLE_TOKEN_URL);
  ok('form-encoded POST', g.calls[0].init.method === 'POST' && g.calls[0].init.headers['content-type'] === 'application/x-www-form-urlencoded');
  ok('grant_type authorization_code', f.get('grant_type') === 'authorization_code');
  ok('carries the code and the PKCE verifier', f.get('code') === 'c1' && f.get('code_verifier') === 'v1');
  ok('adds the client id and the secret', f.get('client_id') === GOOGLE_CLIENT_ID && f.get('client_secret') === SECRET);
  ok('redirect URI is derived from the app\'s own origin', f.get('redirect_uri') === APP + '/oauth-callback.html', f.get('redirect_uri'));
  ok('passes Google\'s answer through', res.status === 200 && (await res.json()).refresh_token === 'rt');
  ok('never cacheable', res.headers.get('cache-control') === 'no-store');
}

console.log('\nexchange — a redirect URI in the body is ignored, not trusted:');
{
  const g = fakeGoogle();
  await handleTokenRequest(req({ code: 'c', codeVerifier: 'v', redirectUri: 'https://evil.example/cb' }), { clientSecret: SECRET, fetch: g.fetch });
  ok('still the app\'s own callback', g.calls[0].form.get('redirect_uri') === APP + '/oauth-callback.html');
}

console.log('\nexchange — dev server origin gets the dev redirect URI:');
{
  const g = fakeGoogle();
  const dev = 'http://localhost:5173';
  await handleTokenRequest(req({ code: 'c', codeVerifier: 'v' }, { origin: dev, url: dev + '/api/google-token' }), { clientSecret: SECRET, fetch: g.fetch });
  ok('http://localhost:5173/oauth-callback.html', g.calls[0].form.get('redirect_uri') === dev + '/oauth-callback.html');
}

console.log('\nrefresh — every automatic backup:');
{
  const g = fakeGoogle(200, { access_token: 'at2', expires_in: 3599 });
  const res = await handleTokenRequest(req({ refreshToken: 'rt' }), { clientSecret: SECRET, fetch: g.fetch });
  const f = g.calls[0].form;
  ok('grant_type refresh_token', f.get('grant_type') === 'refresh_token');
  ok('carries the refresh token, id and secret', f.get('refresh_token') === 'rt' && f.get('client_id') === GOOGLE_CLIENT_ID && f.get('client_secret') === SECRET);
  ok('no code or redirect URI on a refresh', !f.has('code') && !f.has('redirect_uri'));
  ok('new access token comes back', (await res.json()).access_token === 'at2');
}

console.log('\nGoogle\'s errors pass through unchanged (the app tells "reconnect" from "retry" by them):');
{
  const g = fakeGoogle(400, { error: 'invalid_grant', error_description: 'Token has been expired or revoked.' });
  const res = await handleTokenRequest(req({ refreshToken: 'revoked' }), { clientSecret: SECRET, fetch: g.fetch });
  const body = await res.json();
  ok('status 400', res.status === 400);
  ok('error invalid_grant', body.error === 'invalid_grant');
}
{
  const fetch = async () => { throw new TypeError('network down'); };
  const res = await handleTokenRequest(req({ refreshToken: 'rt' }), { clientSecret: SECRET, fetch });
  ok('Google unreachable → 502 upstream_unreachable', res.status === 502 && (await res.json()).error === 'upstream_unreachable');
}
{
  const fetch = async () => new Response('<html>oops</html>', { status: 503 });
  const res = await handleTokenRequest(req({ refreshToken: 'rt' }), { clientSecret: SECRET, fetch });
  ok('non-JSON from Google → 502 upstream_bad_response', res.status === 502 && (await res.json()).error === 'upstream_bad_response');
}

console.log('\nrefused before Google is ever called:');
{
  const cases = [
    ['GET → 405', req(null, { method: 'GET' }), 405, 'method_not_allowed'],
    ['another site\'s origin → 403', req({ refreshToken: 'rt' }, { origin: 'https://evil.example' }), 403, 'forbidden_origin'],
    ['no Origin header → 403', req({ refreshToken: 'rt' }, { origin: null }), 403, 'forbidden_origin'],
    ['malformed JSON → 400', req(null, { raw: '{not json' }), 400, 'bad_request'],
    ['JSON null → 400', req(null, { raw: 'null' }), 400, 'bad_request'],
    ['neither code nor refresh token → 400', req({ hello: 1 }), 400, 'bad_request'],
    ['code without its verifier → 400', req({ code: 'c' }), 400, 'bad_request'],
    ['refresh token that isn\'t a string → 400', req({ refreshToken: 42 }), 400, 'bad_request'],
  ];
  for (const [name, request, status, error] of cases) {
    const g = fakeGoogle();
    const res = await handleTokenRequest(request, { clientSecret: SECRET, fetch: g.fetch });
    const body = await res.json();
    ok(name, res.status === status && body.error === error && g.calls.length === 0, `${res.status} ${body.error} calls=${g.calls.length}`);
  }
}

console.log('\na deploy missing its secret says so plainly:');
{
  const g = fakeGoogle();
  const res = await handleTokenRequest(req({ refreshToken: 'rt' }), { clientSecret: undefined, fetch: g.fetch });
  ok('500 not_configured, Google not called', res.status === 500 && (await res.json()).error === 'not_configured' && g.calls.length === 0);
}

console.log('\nworker/index.js — routing (no network: neither case reaches Google):');
{
  const worker = (await import('./worker/index.js')).default;
  const other = await worker.fetch(new Request(APP + '/api/other', { method: 'POST' }), {});
  ok('any other /api path → JSON 404, never the SPA\'s index.html', other.status === 404 && (await other.json()).error === 'not_found');
  const unset = await worker.fetch(req({ refreshToken: 'rt' }), {});
  ok('the token path reaches the handler, and a missing secret is reported as not_configured', unset.status === 500 && (await unset.json()).error === 'not_configured');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
