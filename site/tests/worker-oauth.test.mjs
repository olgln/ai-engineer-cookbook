// Tests for the OAuth helpers of the Worker: PKCE, the return-to check, the flow cookie, building the
// provider URL, checking Google's ID token and the code exchange (with a fake token endpoint).
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  AUTH_API_PREFIX, OAUTH_COOKIE, OAUTH_COOKIE_TTL_SECONDS, OAUTH_PROVIDERS,
} from '../src/config/app.mjs';
import {
  callbackUrl, clearOauthCookie, enabledProviders, finishSignIn, googleSubject, oauthCookie, pkceChallenge,
  randomString, readOauthCookie, safeReturnTo, startSignIn,
} from '../worker/lib/oauth.mjs';
import { googleTokenResponse, ORIGIN } from './helpers/oauth.mjs';

const NOW = 1_800_000_000;
const CLIENT_ID = 'client-123.apps.googleusercontent.com';
const ENV = { GOOGLE_CLIENT_ID: CLIENT_ID, GOOGLE_CLIENT_SECRET: 'shh' };

const cookieRequest = (setCookie) => new Request(`${ORIGIN}/`, { headers: { Cookie: setCookie.split(';')[0] } });

describe('PKCE and random values', () => {
  test('the S256 challenge matches the example of RFC 7636', async () => {
    assert.equal(await pkceChallenge('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk'), 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
  });

  test('random strings are 43 base64url characters and differ', () => {
    const a = randomString();
    assert.match(a, /^[A-Za-z0-9_-]{43}$/);
    assert.notEqual(a, randomString());
  });
});

describe('safeReturnTo', () => {
  test('keeps paths on this site', () => {
    for (const path of ['/', '/week-01/1-1/', '/review/?x=1#q-3']) assert.equal(safeReturnTo(path), path);
  });

  test('anything that could leave the site or loop into the API becomes /', () => {
    const bad = [
      undefined, null, '', 'https://evil.test/', '//evil.test/', '/\\evil.test', 'week-01/', '/a\nb', '/a\u0000',
      '/api/auth/google', '/api/me', `/${'a'.repeat(600)}`,
    ];
    for (const value of bad) assert.equal(safeReturnTo(value), '/', JSON.stringify(value));
  });
});

describe('providers', () => {
  test('a provider is on only with both credentials', () => {
    assert.deepEqual(enabledProviders(ENV), ['google']);
    assert.deepEqual(enabledProviders({ GOOGLE_CLIENT_ID: 'x' }), []);
    assert.deepEqual(enabledProviders({}), []);
    assert.deepEqual(enabledProviders(undefined), []);
  });

  test('the callback URL is on the request origin', () => {
    assert.equal(callbackUrl(ORIGIN, 'google'), `${ORIGIN}${AUTH_API_PREFIX}google/callback`);
  });
});

describe('flow cookie', () => {
  const flow = { provider: 'google', state: 's', verifier: 'v', nonce: 'n', returnTo: '/x/', expires: NOW + 10 };

  test('is __Host-, HttpOnly, Secure, Lax and short-lived', () => {
    const value = oauthCookie(flow);
    assert.ok(value.startsWith(`${OAUTH_COOKIE}=`));
    for (const flag of ['Path=/', `Max-Age=${OAUTH_COOKIE_TTL_SECONDS}`, 'HttpOnly', 'Secure', 'SameSite=Lax']) {
      assert.ok(value.includes(`; ${flag}`), flag);
    }
    assert.match(clearOauthCookie(), /^__Host-oauth=; .*Max-Age=0/);
  });

  test('round-trips until it expires', () => {
    assert.deepEqual(readOauthCookie(cookieRequest(oauthCookie(flow)), NOW), flow);
    assert.equal(readOauthCookie(cookieRequest(oauthCookie(flow)), NOW + 10), null);
  });

  test('missing, malformed or incomplete cookies give no flow', () => {
    assert.equal(readOauthCookie(new Request(`${ORIGIN}/`), NOW), null);
    assert.equal(readOauthCookie(cookieRequest(`${OAUTH_COOKIE}=%%%`), NOW), null);
    const { nonce, ...partial } = flow;
    assert.equal(readOauthCookie(cookieRequest(oauthCookie(partial)), NOW), null);
  });
});

describe('startSignIn', () => {
  test('sends the browser to Google with PKCE, state, nonce and only the openid scope', async () => {
    const { flow, location } = await startSignIn({ provider: 'google', clientId: CLIENT_ID, origin: ORIGIN, returnTo: '/week-01/1-1/', now: NOW });
    const url = new URL(location);
    assert.equal(url.origin + url.pathname, OAUTH_PROVIDERS.google.authorizeUrl);
    const q = Object.fromEntries(url.searchParams);
    assert.equal(q.client_id, CLIENT_ID);
    assert.equal(q.redirect_uri, callbackUrl(ORIGIN, 'google'));
    assert.equal(q.response_type, 'code');
    assert.equal(q.scope, 'openid');
    assert.equal(q.state, flow.state);
    assert.equal(q.nonce, flow.nonce);
    assert.equal(q.code_challenge_method, 'S256');
    assert.equal(q.code_challenge, await pkceChallenge(flow.verifier));
    assert.ok(!location.includes(flow.verifier), 'the verifier stays in the cookie');
    assert.equal(flow.returnTo, '/week-01/1-1/');
    assert.equal(flow.expires, NOW + OAUTH_COOKIE_TTL_SECONDS);
  });

  test('an unsafe return address is replaced', async () => {
    const { flow } = await startSignIn({ provider: 'google', clientId: CLIENT_ID, origin: ORIGIN, returnTo: '//evil.test', now: NOW });
    assert.equal(flow.returnTo, '/');
  });
});

describe('googleSubject', () => {
  const ctx = { clientId: CLIENT_ID, nonce: 'n-1', now: NOW };
  const claims = { iss: 'https://accounts.google.com', aud: CLIENT_ID, sub: '1234567890', nonce: 'n-1', exp: NOW + 3600 };
  const subject = (over) => googleSubject(googleTokenResponse({ ...claims, ...over }), ctx);

  test('returns sub of a valid token', () => {
    assert.equal(subject({}), '1234567890');
    assert.equal(subject({ iss: 'accounts.google.com' }), '1234567890');
  });

  test('refuses tokens for someone else, expired, replayed or without sub', () => {
    assert.throws(() => subject({ iss: 'https://evil.test' }), /issuer/);
    assert.throws(() => subject({ aud: 'other-client' }), /another client/);
    assert.throws(() => subject({ exp: NOW - 3600 }), /expired/);
    assert.throws(() => subject({ nonce: 'other' }), /nonce/);
    assert.throws(() => subject({ sub: '' }), /sub/);
  });

  test('refuses responses without a well-formed token', () => {
    assert.throws(() => googleSubject({}, ctx), /no id_token/);
    assert.throws(() => googleSubject({ id_token: 'a.b' }, ctx), /malformed/);
    assert.throws(() => googleSubject({ id_token: 'a.%%%.c' }, ctx), /malformed/);
  });
});

describe('finishSignIn', () => {
  const flow = { provider: 'google', state: 'st', verifier: 'ver', nonce: 'n-1', returnTo: '/', expires: NOW + 60 };
  const query = (params) => new URLSearchParams(params);
  const tokenOk = googleTokenResponse({ iss: 'https://accounts.google.com', aud: CLIENT_ID, sub: 'g-42', nonce: 'n-1', exp: NOW + 60 });

  function fakeFetch(response = tokenOk, status = 200) {
    const calls = [];
    const fetch = async (url, init) => {
      calls.push({ url, init });
      return new Response(JSON.stringify(response), { status, headers: { 'Content-Type': 'application/json' } });
    };
    return { fetch, calls };
  }

  const finish = (over = {}) => finishSignIn({
    provider: 'google', query: query({ state: 'st', code: 'c0de' }), flow, clientId: CLIENT_ID, clientSecret: 'shh',
    origin: ORIGIN, now: NOW, fetch: fakeFetch().fetch, ...over,
  });

  test('exchanges the code with the verifier and returns the user id', async () => {
    const { fetch, calls } = fakeFetch();
    assert.equal(await finish({ fetch }), 'g-42');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, OAUTH_PROVIDERS.google.tokenUrl);
    const body = Object.fromEntries(calls[0].init.body);
    assert.deepEqual(body, {
      grant_type: 'authorization_code', code: 'c0de', redirect_uri: callbackUrl(ORIGIN, 'google'),
      client_id: CLIENT_ID, client_secret: 'shh', code_verifier: 'ver',
    });
  });

  test('fails without a flow, for another provider, on a refusal or a state mismatch, without calling Google', async () => {
    const { fetch, calls } = fakeFetch();
    await assert.rejects(finish({ fetch, flow: null }), /no sign-in/);
    await assert.rejects(finish({ fetch, flow: { ...flow, provider: 'github' } }), /no sign-in/);
    await assert.rejects(finish({ fetch, query: query({ error: 'access_denied', state: 'st' }) }), /refused/);
    await assert.rejects(finish({ fetch, query: query({ state: 'other', code: 'c' }) }), /state/);
    await assert.rejects(finish({ fetch, query: query({ code: 'c' }) }), /state/);
    await assert.rejects(finish({ fetch, query: query({ state: 'st' }) }), /no code/);
    assert.equal(calls.length, 0);
  });

  test('fails when the token endpoint refuses', async () => {
    await assert.rejects(finish({ fetch: fakeFetch({ error: 'invalid_grant' }, 400).fetch }), /answered 400/);
  });
});
