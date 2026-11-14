// Fakes for the sign-in tests: a token response like Google's, with an unsigned ID token (the Worker does
// not check the signature of a token it got straight from the token endpoint, see worker/lib/oauth.mjs).

export const ORIGIN = 'https://site.test';

const encode = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');

/** An unsigned JWT with the given claims. */
export const unsignedJwt = (claims) => `${encode({ alg: 'none' })}.${encode(claims)}.`;

/** A token endpoint response carrying an ID token with these claims. */
export const googleTokenResponse = (claims) => ({ access_token: 'at', token_type: 'Bearer', id_token: unsignedJwt(claims) });
