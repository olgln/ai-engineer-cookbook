// Sessions: a random token in an HttpOnly cookie, its SHA-256 in D1. Pure helpers plus small D1 queries;
// `db` is a D1 binding (or the node:sqlite stand-in in tests), `now` is Unix seconds.
import {
  SESSION_COOKIE, SESSION_RENEW_AFTER_SECONDS, SESSION_TOKEN_BYTES, SESSION_TTL_SECONDS,
} from '../../src/config/app.mjs';

/** Base64url of SESSION_TOKEN_BYTES random bytes, without padding. */
const TOKEN_PATTERN = new RegExp(`^[A-Za-z0-9_-]{${Math.ceil((SESSION_TOKEN_BYTES * 4) / 3)}}$`);

const base64url = (bytes) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const hex = (buffer) => [...new Uint8Array(buffer)].map((b) => b.toString(16).padStart(2, '0')).join('');

/** A new session token: SESSION_TOKEN_BYTES from the CSPRNG, base64url. */
export function newToken() {
  return base64url(crypto.getRandomValues(new Uint8Array(SESSION_TOKEN_BYTES)));
}

/** Whether a value has the shape of a token we issue; anything else is not looked up. */
export const isToken = (value) => typeof value === 'string' && TOKEN_PATTERN.test(value);

/** Hex SHA-256 of a token: what the database stores, so a leaked table does not hold usable cookies. */
export async function hashToken(token) {
  return hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token)));
}

/** Value of one cookie from a Cookie header, or undefined. */
export function readCookie(header, name) {
  for (const part of (header ?? '').split(';')) {
    const eq = part.indexOf('=');
    if (eq !== -1 && part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return undefined;
}

/** The session token from a request, if it is well-formed. */
export function sessionToken(request) {
  const token = readCookie(request.headers.get('Cookie'), SESSION_COOKIE);
  return isToken(token) ? token : undefined;
}

/** Set-Cookie value for a session token that lives maxAge seconds. */
export function sessionCookie(token, maxAge = SESSION_TTL_SECONDS) {
  return `${SESSION_COOKIE}=${token}; Path=/; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Lax`;
}

/** Set-Cookie value that removes the session cookie. */
export const clearSessionCookie = () => sessionCookie('', 0);

/** Starts a session for a user; returns the token to put into the cookie. */
export async function createSession(db, userId, now) {
  const token = newToken();
  await db
    .prepare('INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)')
    .bind(await hashToken(token), userId, now, now + SESSION_TTL_SECONDS)
    .run();
  return token;
}

/**
 * The live session of a token, or null. A session last renewed more than SESSION_RENEW_AFTER_SECONDS
 * ago is extended to a full SESSION_TTL_SECONDS again (`renewed: true`: send the cookie again).
 */
export async function getSession(db, token, now) {
  if (!isToken(token)) return null;
  const hash = await hashToken(token);
  const row = await db.prepare('SELECT user_id, expires_at FROM sessions WHERE token_hash = ?').bind(hash).first();
  if (!row) return null;
  if (row.expires_at <= now) {
    await db.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(hash).run();
    return null;
  }
  const lastRenewal = row.expires_at - SESSION_TTL_SECONDS;
  if (now - lastRenewal < SESSION_RENEW_AFTER_SECONDS) {
    return { userId: row.user_id, expiresAt: row.expires_at, renewed: false };
  }
  const expiresAt = now + SESSION_TTL_SECONDS;
  await db.prepare('UPDATE sessions SET expires_at = ? WHERE token_hash = ?').bind(expiresAt, hash).run();
  return { userId: row.user_id, expiresAt, renewed: true };
}

/** Ends the session of a token (no-op for an unknown one). */
export async function deleteSession(db, token) {
  if (!isToken(token)) return;
  await db.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(await hashToken(token)).run();
}

/** Removes expired sessions (the daily cron); returns how many were removed. */
export async function purgeExpiredSessions(db, now) {
  const result = await db.prepare('DELETE FROM sessions WHERE expires_at <= ?').bind(now).run();
  return result.meta.changes;
}
