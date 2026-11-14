// Tests for Worker sessions and users: tokens, cookies, storage of hashes only, expiry, renewal, clean-up,
// and user creation on first sign-in. D1 is the node:sqlite stand-in with the real migrations.
import assert from 'node:assert/strict';
import { beforeEach, describe, test } from 'node:test';
import {
  AUTH_PROVIDERS, SESSION_COOKIE, SESSION_RENEW_AFTER_SECONDS, SESSION_TTL_SECONDS,
} from '../src/config/app.mjs';
import {
  clearSessionCookie, createSession, deleteSession, getSession, hashToken, isToken, newToken,
  purgeExpiredSessions, readCookie, sessionCookie, sessionToken,
} from '../worker/lib/session.mjs';
import { findOrCreateUser, listProviders } from '../worker/lib/users.mjs';
import { createD1 } from './helpers/d1.mjs';

const NOW = 1_800_000_000;
const [FIRST, SECOND] = AUTH_PROVIDERS;

let db;
beforeEach(() => {
  db = createD1();
});

const count = (table) => db.sqlite.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;

describe('tokens', () => {
  test('are random base64url strings of the expected shape', () => {
    const a = newToken();
    const b = newToken();
    assert.notEqual(a, b);
    assert.ok(isToken(a));
    assert.match(a, /^[A-Za-z0-9_-]+$/);
  });

  test('anything else is not a token', () => {
    for (const value of [undefined, '', 'short', `${newToken()}x`, newToken().slice(1) + '=', 42]) {
      assert.equal(isToken(value), false, String(value));
    }
  });

  test('are stored as a hex SHA-256', async () => {
    assert.equal(await hashToken('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });
});

describe('cookies', () => {
  test('readCookie finds one cookie among several', () => {
    assert.equal(readCookie('a=1; b=2;c=3', 'b'), '2');
    assert.equal(readCookie('a=1', 'b'), undefined);
    assert.equal(readCookie(null, 'b'), undefined);
    assert.equal(readCookie('ab=1', 'b'), undefined);
  });

  test('the session cookie is host-only, HttpOnly, Secure and Lax', () => {
    const value = sessionCookie('tok');
    assert.ok(value.startsWith(`${SESSION_COOKIE}=tok;`));
    assert.ok(SESSION_COOKIE.startsWith('__Host-'));
    for (const flag of ['Path=/', `Max-Age=${SESSION_TTL_SECONDS}`, 'HttpOnly', 'Secure', 'SameSite=Lax']) {
      assert.ok(value.includes(`; ${flag}`), flag);
    }
    assert.ok(!/Domain=/i.test(value), '__Host- cookies must not set Domain');
  });

  test('clearing sets an empty value that expires now', () => {
    assert.ok(clearSessionCookie().startsWith(`${SESSION_COOKIE}=;`));
    assert.ok(clearSessionCookie().includes('; Max-Age=0'));
  });

  test('sessionToken ignores malformed values', () => {
    const token = newToken();
    const req = (cookie) => new Request('https://site.test/api/me', { headers: { Cookie: cookie } });
    assert.equal(sessionToken(req(`${SESSION_COOKIE}=${token}`)), token);
    assert.equal(sessionToken(req(`${SESSION_COOKIE}=nope`)), undefined);
    assert.equal(sessionToken(new Request('https://site.test/')), undefined);
  });
});

describe('sessions', () => {
  let userId;
  beforeEach(async () => {
    userId = await findOrCreateUser(db, FIRST, 'subject-1', NOW);
  });

  test('a new session is found by its token, and only the hash is stored', async () => {
    const token = await createSession(db, userId, NOW);
    const session = await getSession(db, token, NOW + 1);
    assert.deepEqual(session, { userId, expiresAt: NOW + SESSION_TTL_SECONDS, renewed: false });
    const stored = db.sqlite.prepare('SELECT token_hash FROM sessions').get().token_hash;
    assert.equal(stored, await hashToken(token));
    assert.notEqual(stored, token);
  });

  test('an unknown or malformed token has no session', async () => {
    await createSession(db, userId, NOW);
    assert.equal(await getSession(db, newToken(), NOW), null);
    assert.equal(await getSession(db, 'garbage', NOW), null);
  });

  test('an expired session is refused and deleted', async () => {
    const token = await createSession(db, userId, NOW);
    assert.equal(await getSession(db, token, NOW + SESSION_TTL_SECONDS), null);
    assert.equal(count('sessions'), 0);
  });

  test('a session is renewed once the renewal interval has passed', async () => {
    const token = await createSession(db, userId, NOW);
    const early = await getSession(db, token, NOW + SESSION_RENEW_AFTER_SECONDS - 1);
    assert.equal(early.renewed, false);
    const later = NOW + SESSION_RENEW_AFTER_SECONDS;
    const renewed = await getSession(db, token, later);
    assert.deepEqual(renewed, { userId, expiresAt: later + SESSION_TTL_SECONDS, renewed: true });
    assert.equal((await getSession(db, token, later + 1)).renewed, false, 'not renewed again right away');
    assert.ok(await getSession(db, token, NOW + SESSION_TTL_SECONDS), 'alive past the original expiry');
  });

  test('deleteSession ends only that session', async () => {
    const a = await createSession(db, userId, NOW);
    const b = await createSession(db, userId, NOW);
    await deleteSession(db, a);
    await deleteSession(db, 'garbage');
    assert.equal(await getSession(db, a, NOW), null);
    assert.ok(await getSession(db, b, NOW));
  });

  test('purgeExpiredSessions removes only expired sessions', async () => {
    await createSession(db, userId, NOW - SESSION_TTL_SECONDS);
    const live = await createSession(db, userId, NOW);
    assert.equal(await purgeExpiredSessions(db, NOW), 1);
    assert.ok(await getSession(db, live, NOW));
  });
});

describe('users', () => {
  test('the first sign-in creates a user, the next ones find it', async () => {
    const id = await findOrCreateUser(db, FIRST, 'subject-1', NOW);
    assert.equal(await findOrCreateUser(db, FIRST, 'subject-1', NOW + 10), id);
    assert.equal(count('users'), 1);
    assert.equal(db.sqlite.prepare('SELECT last_login_at AS t FROM users').get().t, NOW + 10);
  });

  test('the same id at another provider is another user', async () => {
    const a = await findOrCreateUser(db, FIRST, 'same', NOW);
    const b = await findOrCreateUser(db, SECOND, 'same', NOW);
    assert.notEqual(a, b);
    assert.deepEqual(await listProviders(db, a), [FIRST]);
  });

  test('unknown providers and bad ids are refused', async () => {
    await assert.rejects(findOrCreateUser(db, 'yandex', 'x', NOW), /unknown provider/);
    await assert.rejects(findOrCreateUser(db, FIRST, '', NOW), /non-empty/);
    await assert.rejects(findOrCreateUser(db, FIRST, 'x'.repeat(256), NOW), /non-empty/);
    assert.equal(count('users'), 0);
  });

  test('a concurrent first sign-in returns the user that won', async () => {
    const winner = await findOrCreateUser(db, FIRST, 'race', NOW);
    // Make the lookup miss once, as if the other request had not committed yet.
    const prepare = db.prepare;
    let missed = false;
    db.prepare = (sql) => {
      const stmt = prepare(sql);
      if (!missed && sql.startsWith('SELECT user_id FROM identities')) {
        missed = true;
        return { bind: () => ({ first: async () => null }) };
      }
      return stmt;
    };
    assert.equal(await findOrCreateUser(db, FIRST, 'race', NOW), winner);
    assert.equal(count('users'), 1, 'the losing batch was rolled back');
  });

  test('deleting a user removes its identities and sessions', async () => {
    const id = await findOrCreateUser(db, FIRST, 'gone', NOW);
    await createSession(db, id, NOW);
    db.sqlite.prepare('DELETE FROM users WHERE id = ?').run(id);
    assert.equal(count('identities'), 0);
    assert.equal(count('sessions'), 0);
  });
});
