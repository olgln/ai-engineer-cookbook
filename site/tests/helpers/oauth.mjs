// Fakes for the sign-in tests: token responses like Google's (with an unsigned ID token: the Worker does not
// check the signature of a token it got straight from the token endpoint, see worker/lib/oauth.mjs) and
// GitHub's, and a JSON response for fake provider endpoints.

export const ORIGIN = 'https://site.test';

const encode = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');

/** An unsigned JWT with the given claims. */
export const unsignedJwt = (claims) => `${encode({ alg: 'none' })}.${encode(claims)}.`;

/** A token endpoint response carrying an ID token with these claims. */
export const googleTokenResponse = (claims) => ({ access_token: 'at', token_type: 'Bearer', id_token: unsignedJwt(claims) });

/** A successful GitHub token response (JSON, as asked with `Accept: application/json`). */
export const githubTokenResponse = (accessToken) => ({ access_token: accessToken, token_type: 'bearer', scope: '' });

/** A JSON response of a fake provider endpoint. */
export const jsonResponse = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
