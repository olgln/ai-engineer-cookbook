// Tests for the Worker API through its entry point (worker/index.mjs): routing, /api/me, /api/logout,
// same-origin checks, security headers, and the cron clean-up. D1 is the node:sqlite stand-in.
import assert from 'node:assert/strict';
import { beforeEach, describe, test } from 'node:test';
import {
  AUTH_PROVIDERS, LOGOUT_API_PATH, ME_API_PATH, PROGRESS_API_PATH, SECURITY_HEADERS, SESSION_COOKIE,
  SESSION_RENEW_AFTER_SECONDS, SESSION_TTL_SECONDS,
} from '../src/config/app.mjs';
import worker from '../worker/index.mjs';
import { handleApi } from '../worker/lib/api.mjs';
import { createSession, getSession, newToken } from '../worker/lib/session.mjs';
import { findOrCreateUser } from '../worker/lib/users.mjs';
import { createD1 } from './helpers/d1.mjs';

const ORIGIN = 'https://site.test';
const NOW = 1_800_000_000;
const [FIRST, SECOND] = AUTH_PROVIDERS;

let db, userId, token;
beforeEach(async () => {
  db = createD1();
  userId = await findOrCreateUser(db, FIRST, 'subject-1', NOW);
  token = await createSession(db, userId, NOW);
});

function request(path, { method = 'GET', cookie, origin } = {}) {
  const headers = {};
  if (cookie !== undefined) headers.Cookie = cookie;
  if (origin !== undefined) headers.Origin = origin;
  return new Request(ORIGIN + path, { method, headers });
}

const call = (req, now = NOW) => handleApi(req, { db, now });
const withSession = (t = token) => `other=1; ${SESSION_COOKIE}=${t}`;

describe('routing', () => {
  test('unknown API paths get a JSON 404', async () => {
    const res = await call(request('/api/nope'));
    assert.equal(res.status, 404);
    assert.deepEqual(await res.json(), { error: 'not found' });
  });

  test('the progress path stays a 404 on the hosting, so pages keep the browser copy', async () => {
    assert.equal((await call(request(PROGRESS_API_PATH))).status, 404);
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
    const res = await handleApi(request(ME_API_PATH, { cookie: withSession() }), { db: broken, now: NOW });
    assert.equal(res.status, 500);
    assert.deepEqual(await res.json(), { error: 'internal error' });
  });
});

describe(`GET ${ME_API_PATH}`, () => {
  test('without a cookie: 401 and no Set-Cookie', async () => {
    const res = await call(request(ME_API_PATH, { cookie: 'other=1' }));
    assert.equal(res.status, 401);
    assert.equal(res.headers.get('Set-Cookie'), null);
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

describe('worker entry', () => {
  test('fetch passes the D1 binding through', async () => {
    const res = await worker.fetch(request(ME_API_PATH, { cookie: withSession() }), { DB: db });
    assert.equal(res.status, 200);
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
