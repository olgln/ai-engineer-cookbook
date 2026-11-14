// Users and their sign-in identities in D1. A user is created on the first sign-in with a provider;
// only the provider's stable user id is kept (no e-mail, name or token).
import { AUTH_PROVIDERS } from '../../src/config/app.mjs';

/** Longest provider user id we accept (Google `sub` is up to 255 ASCII characters). */
const MAX_SUBJECT_LENGTH = 255;

function checkIdentity(provider, subject) {
  if (!AUTH_PROVIDERS.includes(provider)) throw new Error(`unknown provider "${provider}"`);
  if (typeof subject !== 'string' || subject.length === 0 || subject.length > MAX_SUBJECT_LENGTH) {
    throw new Error('provider user id must be a non-empty string of at most 255 characters');
  }
}

const findUserId = (db, provider, subject) =>
  db.prepare('SELECT user_id FROM identities WHERE provider = ? AND subject = ?').bind(provider, subject).first('user_id');

/** The user signed in as `subject` at `provider`, created on the first sign-in; returns the user id. */
export async function findOrCreateUser(db, provider, subject, now) {
  checkIdentity(provider, subject);
  const existing = await findUserId(db, provider, subject);
  if (existing) {
    await db.prepare('UPDATE users SET last_login_at = ? WHERE id = ?').bind(now, existing).run();
    return existing;
  }
  const id = crypto.randomUUID();
  try {
    await db.batch([
      db.prepare('INSERT INTO users (id, created_at, last_login_at) VALUES (?, ?, ?)').bind(id, now, now),
      db.prepare('INSERT INTO identities (provider, subject, user_id, created_at) VALUES (?, ?, ?, ?)').bind(provider, subject, id, now),
    ]);
    return id;
  } catch (error) {
    // Two first sign-ins at once: the other one created the identity, and this batch was rolled back.
    const winner = await findUserId(db, provider, subject);
    if (winner) return winner;
    throw error;
  }
}

/** Providers a user can sign in with, in the order they were linked. */
export async function listProviders(db, userId) {
  const { results } = await db
    .prepare('SELECT provider FROM identities WHERE user_id = ? ORDER BY created_at, provider')
    .bind(userId)
    .all();
  return results.map((row) => row.provider);
}
