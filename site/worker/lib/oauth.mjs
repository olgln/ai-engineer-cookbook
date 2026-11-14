// Sign-in with an OAuth 2.0 / OpenID Connect provider: authorization code flow with PKCE (S256), `state`
// against login CSRF and `nonce` against ID-token replay. The flow state waits in a short-lived __Host-
// cookie between the redirect and the callback. Provider tokens are used once and never stored.
import {
  AUTH_API_PREFIX, AUTH_CALLBACK_SUFFIX, AUTH_PROVIDERS, OAUTH_COOKIE, OAUTH_COOKIE_TTL_SECONDS, OAUTH_PROVIDERS,
} from '../../src/config/app.mjs';
import { readCookie } from './session.mjs';

const base64url = (bytes) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const fromBase64url = (text) => {
  const b64 = text.replace(/-/g, '+').replace(/_/g, '/');
  return Uint8Array.from(atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4)), (c) => c.charCodeAt(0));
};
const encodeJson = (value) => base64url(new TextEncoder().encode(JSON.stringify(value)));
const decodeJson = (text) => JSON.parse(new TextDecoder().decode(fromBase64url(text)));

/** 32 random bytes, base64url: state, nonce and PKCE verifier (43 characters, as RFC 7636 asks). */
export const randomString = () => base64url(crypto.getRandomValues(new Uint8Array(32)));

/** PKCE S256 challenge of a verifier. */
export async function pkceChallenge(verifier) {
  return base64url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))));
}

/** Longest page path we return to. */
const MAX_RETURN_TO_LENGTH = 512;

/**
 * The page to return to after sign-in: a path on this site only (no other host, no `//host`, no
 * backslashes or control characters that browsers might read as another host), never the API itself.
 */
export function safeReturnTo(value) {
  if (typeof value !== 'string' || value.length > MAX_RETURN_TO_LENGTH) return '/';
  if (!value.startsWith('/') || value.startsWith('//') || /[\\\u0000-\u001f\u007f]/.test(value)) return '/';
  if (value.startsWith('/api/')) return '/';
  return value;
}

/** Credentials of the providers that have them, in AUTH_PROVIDERS order. */
export function enabledProviders(env = {}) {
  return AUTH_PROVIDERS.filter((p) => OAUTH_PROVIDERS[p] && env[`${p.toUpperCase()}_CLIENT_ID`] && env[`${p.toUpperCase()}_CLIENT_SECRET`]);
}

export const credentials = (env, provider) => ({
  clientId: env[`${provider.toUpperCase()}_CLIENT_ID`],
  clientSecret: env[`${provider.toUpperCase()}_CLIENT_SECRET`],
});

/** The redirect URI of a provider on this origin; it must be registered at the provider exactly. */
export const callbackUrl = (origin, provider) => `${origin}${AUTH_API_PREFIX}${provider}${AUTH_CALLBACK_SUFFIX}`;

/** Set-Cookie value holding the state of a sign-in in progress. */
export function oauthCookie(flow, maxAge = OAUTH_COOKIE_TTL_SECONDS) {
  const value = flow ? encodeJson(flow) : '';
  return `${OAUTH_COOKIE}=${value}; Path=/; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Lax`;
}

export const clearOauthCookie = () => oauthCookie(null, 0);

/** The sign-in in progress from the request cookie, or null when missing, malformed or expired. */
export function readOauthCookie(request, now) {
  const raw = readCookie(request.headers.get('Cookie'), OAUTH_COOKIE);
  if (!raw) return null;
  try {
    const flow = decodeJson(raw);
    const fields = ['provider', 'state', 'verifier', 'nonce', 'returnTo'];
    if (!fields.every((f) => typeof flow[f] === 'string') || typeof flow.expires !== 'number') return null;
    return flow.expires > now ? flow : null;
  } catch {
    return null;
  }
}

/** Starts a sign-in: the flow to remember and the provider URL to send the browser to. */
export async function startSignIn({ provider, clientId, origin, returnTo, now }) {
  const config = OAUTH_PROVIDERS[provider];
  const flow = {
    provider,
    state: randomString(),
    verifier: randomString(),
    nonce: randomString(),
    returnTo: safeReturnTo(returnTo),
    expires: now + OAUTH_COOKIE_TTL_SECONDS,
  };
  const url = new URL(config.authorizeUrl);
  url.search = new URLSearchParams({
    client_id: clientId,
    redirect_uri: callbackUrl(origin, provider),
    response_type: 'code',
    scope: config.scope,
    state: flow.state,
    nonce: flow.nonce,
    code_challenge: await pkceChallenge(flow.verifier),
    code_challenge_method: 'S256',
    prompt: 'select_account',
  }).toString();
  return { flow, location: url.href };
}

/** Clock difference we tolerate on the ID token's expiry, in seconds. */
const CLOCK_SKEW_SECONDS = 60;

/**
 * The user id from a Google token response. The ID token came straight from Google's token endpoint over
 * TLS, so its signature need not be checked (OpenID Connect Core 3.1.3.7, item 6); its claims still are.
 */
export function googleSubject(tokenResponse, { clientId, nonce, now }) {
  const idToken = tokenResponse?.id_token;
  if (typeof idToken !== 'string') throw new Error('no id_token in the token response');
  const parts = idToken.split('.');
  if (parts.length !== 3) throw new Error('malformed id_token');
  let claims;
  try {
    claims = decodeJson(parts[1]);
  } catch {
    throw new Error('malformed id_token payload');
  }
  if (!OAUTH_PROVIDERS.google.issuers.includes(claims.iss)) throw new Error('id_token from another issuer');
  const audience = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!audience.includes(clientId)) throw new Error('id_token for another client');
  if (typeof claims.exp !== 'number' || claims.exp + CLOCK_SKEW_SECONDS <= now) throw new Error('id_token expired');
  if (claims.nonce !== nonce) throw new Error('id_token nonce mismatch');
  if (typeof claims.sub !== 'string' || !claims.sub) throw new Error('id_token without sub');
  return claims.sub;
}

/** How each provider turns a token response into its user id. */
const SUBJECT_OF = { google: googleSubject };

/**
 * Finishes a sign-in: checks `state`, exchanges the code (with the PKCE verifier) and returns the
 * provider's user id. Throws on anything unexpected; the caller turns that into a failed sign-in.
 */
export async function finishSignIn({ provider, query, flow, clientId, clientSecret, origin, now, fetch }) {
  if (!flow || flow.provider !== provider) throw new Error('no sign-in in progress');
  if (query.get('error')) throw new Error(`provider refused: ${query.get('error')}`);
  if (!query.get('state') || query.get('state') !== flow.state) throw new Error('state mismatch');
  const code = query.get('code');
  if (!code) throw new Error('no code');
  const res = await fetch(OAUTH_PROVIDERS[provider].tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: callbackUrl(origin, provider),
      client_id: clientId,
      client_secret: clientSecret,
      code_verifier: flow.verifier,
    }),
  });
  if (!res.ok) throw new Error(`token endpoint answered ${res.status}`);
  return SUBJECT_OF[provider](await res.json(), { clientId, nonce: flow.nonce, now });
}
