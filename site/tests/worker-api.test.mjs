// Tests for the Worker API through its entry point (worker/index.mjs): routing, /api/me, /api/logout,
// /api/progress, sign-in with Google (fake token endpoint), same-origin checks, security headers and the
// cron clean-up. D1 is the node:sqlite stand-in.
import assert from 'node:assert/strict';
import { beforeEach, describe, test } from 'node:test';
import {
  ACCOUNT_PROGRESS_MAX_BYTES, AUTH_API_PREFIX, AUTH_PROVIDERS, LOGIN_ERROR_PARAM, LOGOUT_API_PATH, ME_API_PATH,
  OAUTH_COOKIE, OAUTH_PROVIDERS, PROGRESS_API_PATH, PROGRESS_REV_HEADER, RETURN_TO_PARAM, SECURITY_HEADERS,
  SESSION_COOKIE, SESSION_RENEW_AFTER_SECONDS, SESSION_TTL_SECONDS,
} from '../src/config/app.mjs';
import worker from '../worker/index.mjs';
import { handleApi } from '../worker/lib/api.mjs';
import { createSession, getSession, newToken } from '../worker/lib/session.mjs';
import { findOrCreateUser } from '../worker/lib/users.mjs';
import { createD1 } from './helpers/d1.mjs';
import { googleTokenResponse, ORIGIN } from './helpers/oauth.mjs';

const NOW = 1_800_000_000;
const [FIRST, SECOND] = AUTH_PROVIDERS;
const ENV = { GOOGLE_CLIENT_ID: 'cid', GOOGLE_CLIENT_SECRET: 'csecret' };

let db, userId, token;
beforeEach(async () => {
  db = createD1();
  userId = await findOrCreateUser(db, FIRST, 'subject-1', NOW);
  token = await createSession(db, userId, NOW);
});

function request(path, { method = 'GET', cookie, origin, headers = {}, body } = {}) {
  const all = { ...headers };
  if (cookie !== undefined) all.Cookie = cookie;
  if (origin !== undefined) all.Origin = origin;
  return new Request(ORIGIN + path, { method, headers: all, body });
}

/** The token endpoint of a test: answers with `tokenResponse` and records the calls. */
let tokenResponse, tokenCalls;
beforeEach(() => {
  tokenResponse = null;
  tokenCalls = 0;
});
const fakeFetch = async (url) => {
  tokenCalls++;
  assert.equal(url, OAUTH_PROVIDERS.google.tokenUrl);
  return new Response(JSON.stringify(tokenResponse), { status: tokenResponse ? 200 : 400, headers: { 'Content-Type': 'application/json' } });
};

const call = (req, now = NOW, env = ENV) => handleApi(req, { db, now, env, fetch: fakeFetch });
const withSession = (t = token) => `other=1; ${SESSION_COOKIE}=${t}`;

describe('routing', () => {
  test('unknown API paths get a JSON 404', async () => {
    const res = await call(request('/api/nope'));
    assert.equal(res.status, 404);
    assert.deepEqual(await res.json(), { error: 'not found' });
  });

  test('signed out, the progress path is not OK, so pages keep the browser copy', async () => {
    const res = await call(request(PROGRESS_API_PATH));
    assert.equal(res.status, 401);
    assert.equal(res.headers.get(PROGRESS_REV_HEADER), null);
  });

  test('sign-in routes exist only for providers with credentials', async () => {
    assert.equal((await call(request(`${AUTH_API_PREFIX}google`), NOW, {})).status, 404);
    assert.equal((await call(request(`${AUTH_API_PREFIX}github`))).status, 404);
    assert.equal((await call(request(`${AUTH_API_PREFIX}google/nope`))).status, 404);
    assert.equal((await call(request(`${AUTH_API_PREFIX}google`))).status, 302);
  });

  test('a wrong method gets 405 with Allow', async () => {
    const res = await call(request(ME_API_PATH, { method: 'POST', origin: ORIGIN }));
    assert.equal(res.status, 405);
    assert.equal(res.headers.get('Allow'), 'GET');
  });

  test('responses are not cached and carry the security headers', async () => {
    const res = await call(request(ME_API_PATH));
    assert.equal(res.headers.get('Cache-Control'), 'no-store');
    assert.match(res.headers.get('Content-Type'), /^application\/json/);
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) assert.equal(res.headers.get(name), value, name);
  });

  test('an unexpected error becomes a JSON 500 without details', async (t) => {
    t.mock.method(console, 'error', () => {});
    const broken = { prepare: () => { throw new Error('db down'); } };
    const res = await handleApi(request(ME_API_PATH, { cookie: withSession() }), { db: broken, now: NOW, env: ENV });
    assert.equal(res.status, 500);
    assert.deepEqual(await res.json(), { error: 'internal error' });
  });
});

describe(`GET ${ME_API_PATH}`, () => {
  test('without a cookie: 401 with the providers one can sign in with, and no Set-Cookie', async () => {
    const res = await call(request(ME_API_PATH, { cookie: 'other=1' }));
    assert.equal(res.status, 401);
    assert.deepEqual(await res.json(), { error: 'unauthorized', available: ['google'] });
    assert.equal(res.headers.get('Set-Cookie'), null);
    const none = await call(request(ME_API_PATH), NOW, {});
    assert.deepEqual((await none.json()).available, []);
  });

  test('a stale or forged cookie gets 401 and is removed', async () => {
    for (const value of [newToken(), 'forged']) {
      const res = await call(request(ME_API_PATH, { cookie: withSession(value) }));
      assert.equal(res.status, 401);
      assert.match(res.headers.get('Set-Cookie'), new RegExp(`^${SESSION_COOKIE}=;.*Max-Age=0`));
    }
  });

  test('signed in: the linked providers, no cookie while the session is fresh', async () => {
    const res = await call(request(ME_API_PATH, { cookie: withSession() }));
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { providers: [FIRST] });
    assert.equal(res.headers.get('Set-Cookie'), null);
  });

  test('every linked provider is listed', async () => {
    db.sqlite.prepare('INSERT INTO identities (provider, subject, user_id, created_at) VALUES (?, ?, ?, ?)')
      .run(SECOND, 'other', userId, NOW + 1);
    const res = await call(request(ME_API_PATH, { cookie: withSession() }));
    assert.deepEqual(await res.json(), { providers: [FIRST, SECOND] });
  });

  test('a session due for renewal is extended and the cookie is sent again', async () => {
    const res = await call(request(ME_API_PATH, { cookie: withSession() }), NOW + SESSION_RENEW_AFTER_SECONDS);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('Set-Cookie'), new RegExp(`^${SESSION_COOKIE}=${token};.*Max-Age=${SESSION_TTL_SECONDS}`));
  });
});

describe(`POST ${LOGOUT_API_PATH}`, () => {
  test('ends the session and removes the cookie', async () => {
    const res = await call(request(LOGOUT_API_PATH, { method: 'POST', cookie: withSession(), origin: ORIGIN }));
    assert.equal(res.status, 204);
    assert.match(res.headers.get('Set-Cookie'), /Max-Age=0/);
    assert.equal(await getSession(db, token, NOW), null);
  });

  test('is fine when signed out', async () => {
    const res = await call(request(LOGOUT_API_PATH, { method: 'POST', origin: ORIGIN }));
    assert.equal(res.status, 204);
  });

  test('refuses other origins and requests without Origin, and keeps the session', async () => {
    for (const origin of ['https://evil.test', 'null', undefined]) {
      const res = await call(request(LOGOUT_API_PATH, { method: 'POST', cookie: withSession(), origin }));
      assert.equal(res.status, 403, String(origin));
    }
    assert.ok(await getSession(db, token, NOW));
  });
});

describe(PROGRESS_API_PATH, () => {
  const doc = (chapters = { '1-1': { done: '2026-11-14' } }) => ({ version: 1, chapters });
  const put = (body, { rev = '0', cookie = withSession(), origin = ORIGIN, type = 'application/json' } = {}) => {
    const headers = {};
    if (type) headers['Content-Type'] = type;
    if (rev !== null) headers[PROGRESS_REV_HEADER] = rev;
    return call(request(PROGRESS_API_PATH, { method: 'PUT', cookie, origin, headers, body: typeof body === 'string' ? body : JSON.stringify(body) }));
  };
  const get = async () => {
    const res = await call(request(PROGRESS_API_PATH, { cookie: withSession() }));
    return { status: res.status, rev: res.headers.get(PROGRESS_REV_HEADER), body: await res.json() };
  };

  test('a new reader has empty progress at revision 0', async () => {
    assert.deepEqual(await get(), { status: 200, rev: '0', body: { version: 1, chapters: {} } });
  });

  test('writes go on top of the current revision, stale ones get 409 with the current revision', async () => {
    const first = await put(doc());
    assert.equal(first.status, 200);
    assert.deepEqual(await first.json(), { rev: 1 });
    assert.equal(first.headers.get(PROGRESS_REV_HEADER), '1');
    assert.deepEqual(await get(), { status: 200, rev: '1', body: doc() });

    const stale = await put(doc({}), { rev: '0' });
    assert.equal(stale.status, 409);
    assert.deepEqual(await stale.json(), { error: 'conflict', rev: 1 });
    assert.equal((await put(doc({}), { rev: '5' })).status, 409);

    assert.equal((await put(doc({ x: {} }), { rev: '1' })).status, 200);
    assert.deepEqual(await get(), { status: 200, rev: '2', body: doc({ x: {} }) });
  });

  test('each reader has their own progress', async () => {
    await put(doc());
    const other = await findOrCreateUser(db, SECOND, 'someone', NOW);
    const otherToken = await createSession(db, other, NOW);
    const res = await call(request(PROGRESS_API_PATH, { cookie: withSession(otherToken) }));
    assert.deepEqual(await res.json(), { version: 1, chapters: {} });
  });

  test('refuses bad writes', async () => {
    assert.equal((await put(doc(), { cookie: 'x=1' })).status, 401);
    assert.equal((await put(doc(), { origin: 'https://evil.test' })).status, 403);
    assert.equal((await put(doc(), { type: 'text/plain' })).status, 415);
    assert.equal((await put(doc(), { rev: null })).status, 400);
    assert.equal((await put(doc(), { rev: '-1' })).status, 400);
    assert.equal((await put('{not json')).status, 400);
    assert.equal((await put({ chapters: [] })).status, 400);
    assert.equal((await put(doc({ big: { note: 'x'.repeat(ACCOUNT_PROGRESS_MAX_BYTES) } }))).status, 413);
    assert.equal((await get()).rev, '0', 'nothing was stored');
  });
});

describe('sign-in with Google', () => {
  const start = (returnTo = '/week-01/1-1/') =>
    call(request(`${AUTH_API_PREFIX}google?${RETURN_TO_PARAM}=${encodeURIComponent(returnTo)}`));
  const flowCookie = (res) => res.headers.getSetCookie().find((c) => c.startsWith(`${OAUTH_COOKIE}=`)).split(';')[0];
  const callback = (params, cookie) =>
    call(request(`${AUTH_API_PREFIX}google/callback?${new URLSearchParams(params)}`, { cookie }));
  const claims = (state, over = {}) => ({ iss: 'https://accounts.google.com', aud: 'cid', sub: 'g-new', nonce: state.nonce, exp: NOW + 600, ...over });

  /** Starts a sign-in and returns the flow cookie and the state and nonce sent to Google. */
  async function begin(returnTo) {
    const res = await start(returnTo);
    assert.equal(res.status, 302);
    const q = new URL(res.headers.get('Location')).searchParams;
    return { cookie: flowCookie(res), state: q.get('state'), nonce: q.get('nonce') };
  }

  test('a full sign-in creates the user, starts a session and returns to the page', async () => {
    const flow = await begin('/week-01/1-1/');
    tokenResponse = googleTokenResponse(claims(flow));
    const res = await callback({ state: flow.state, code: 'abc' }, flow.cookie);
    assert.equal(res.status, 302);
    assert.equal(res.headers.get('Location'), '/week-01/1-1/');
    const cookies = res.headers.getSetCookie();
    assert.ok(cookies.some((c) => c.startsWith(`${OAUTH_COOKIE}=;`)), 'the flow cookie is removed');
    const session = cookies.find((c) => c.startsWith(`${SESSION_COOKIE}=`)).split(';')[0];
    const me = await call(request(ME_API_PATH, { cookie: session }));
    assert.deepEqual(await me.json(), { providers: ['google'] });
    // signing in again finds the same user
    const again = await begin('/');
    tokenResponse = googleTokenResponse(claims(again));
    await callback({ state: again.state, code: 'def' }, again.cookie);
    assert.equal(db.sqlite.prepare("SELECT COUNT(*) AS n FROM identities WHERE subject = 'g-new'").get().n, 1);
  });

  test('a wrong state, a missing flow, a refusal or a bad token land back with the error mark', async (t) => {
    const warnings = t.mock.method(console, 'warn', () => {});
    const flow = await begin('/week-01/1-1/');
    tokenResponse = googleTokenResponse(claims(flow));
    const cases = [
      [{ state: 'forged', code: 'abc' }, flow.cookie],
      [{ state: flow.state, code: 'abc' }, undefined],
      [{ state: flow.state, error: 'access_denied' }, flow.cookie],
    ];
    for (const [params, cookie] of cases) {
      const res = await callback(params, cookie);
      assert.equal(res.status, 302);
      const landing = new URL(res.headers.get('Location'), ORIGIN);
      assert.equal(landing.searchParams.get(LOGIN_ERROR_PARAM), '1');
      assert.equal(landing.pathname, cookie ? '/week-01/1-1/' : '/');
      assert.ok(!res.headers.getSetCookie().some((c) => c.startsWith(`${SESSION_COOKIE}=`)), 'no session');
    }
    assert.equal(tokenCalls, 0, 'Google is not called before state is checked');
    tokenResponse = googleTokenResponse(claims(flow, { nonce: 'replayed' }));
    const replay = await callback({ state: flow.state, code: 'abc' }, flow.cookie);
    assert.match(replay.headers.get('Location'), new RegExp(`${LOGIN_ERROR_PARAM}=1`));
    assert.equal(db.sqlite.prepare("SELECT COUNT(*) AS n FROM identities WHERE subject = 'g-new'").get().n, 0);
    assert.equal(warnings.mock.callCount(), 4, 'each failure is logged');
  });

  test('an outside return address is not followed', async () => {
    const flow = await begin('https://evil.test/');
    tokenResponse = googleTokenResponse(claims(flow));
    const res = await callback({ state: flow.state, code: 'abc' }, flow.cookie);
    assert.equal(res.headers.get('Location'), '/');
  });
});

describe('worker entry', () => {
  test('fetch passes the D1 binding and the env through', async () => {
    const res = await worker.fetch(request(ME_API_PATH, { cookie: withSession() }), { DB: db });
    assert.equal(res.status, 200);
    const out = await worker.fetch(request(ME_API_PATH), { DB: db, ...ENV });
    assert.deepEqual((await out.json()).available, ['google']);
  });

  test('the cron drops expired sessions only', async (t) => {
    t.mock.method(console, 'log', () => {});
    await createSession(db, userId, Math.floor(Date.now() / 1000) - SESSION_TTL_SECONDS - 1);
    const live = await createSession(db, userId, Math.floor(Date.now() / 1000));
    await worker.scheduled({}, { DB: db });
    const left = db.sqlite.prepare('SELECT COUNT(*) AS n FROM sessions').get().n;
    // `token` from beforeEach was created at NOW (2027) and is still live too.
    assert.equal(left, 2);
    assert.ok(await getSession(db, live, Math.floor(Date.now() / 1000)));
  });
});
