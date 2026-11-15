// Progress of signed-in readers in D1: one JSON document per user with a revision number. A write must
// name the revision it was based on; a stale one is refused, so two devices never overwrite each other
// silently (the browser then merges and retries, src/scripts/sync.mjs).

const EMPTY = { version: 1, chapters: {} };

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** Whether a parsed body looks like a progress document (the same check as the local progress API). */
export const isProgress = (data) => isObject(data) && isObject(data.chapters);

/** The stored progress and its revision; an empty document at revision 0 for a new reader. */
export async function readProgress(db, userId) {
  const row = await db.prepare('SELECT data, rev FROM progress WHERE user_id = ?').bind(userId).first();
  return row ? { data: JSON.parse(row.data), rev: row.rev } : { data: EMPTY, rev: 0 };
}

/**
 * Stores progress written on top of revision `baseRev`. Returns { ok: true, rev } with the new revision,
 * or { ok: false, rev } with the current one when somebody wrote in between.
 */
export async function writeProgress(db, userId, data, baseRev, now) {
  const text = JSON.stringify(data);
  const result = baseRev === 0
    ? await db
      .prepare('INSERT INTO progress (user_id, data, rev, updated_at) VALUES (?, ?, 1, ?) ON CONFLICT (user_id) DO NOTHING')
      .bind(userId, text, now)
      .run()
    : await db
      .prepare('UPDATE progress SET data = ?, rev = rev + 1, updated_at = ? WHERE user_id = ? AND rev = ?')
      .bind(text, now, userId, baseRev)
      .run();
  if (result.meta.changes === 1) return { ok: true, rev: baseRev + 1 };
  return { ok: false, rev: (await readProgress(db, userId)).rev };
}
