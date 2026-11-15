// Brings a progress document of an older format version up to PROGRESS_VERSION by renaming the chapter ids
// of every renumbering since (CHAPTER_ID_RENAMES in src/config/app.mjs). Pure, tested in tests/browser/migrate.test.mjs.
import { CHAPTER_ID_RENAMES, PROGRESS_VERSION } from '../../config/app.mjs';

/**
 * Chapter progress keyed by the new ids. Renames apply all at once (8-1 → 7-1 and 9-1 → 8-1 do not collide);
 * ids not in the map keep their key.
 * @template T
 * @param {Record<string, T>} chapters
 * @param {Record<string, string>} renames
 * @returns {Record<string, T>}
 */
export const renameChapters = (chapters, renames) =>
  Object.fromEntries(Object.entries(chapters).map(([id, value]) => [renames[id] ?? id, value]));

/**
 * The document at PROGRESS_VERSION. A document without a version counts as version 1; a newer one (written by a
 * newer build) is left as is.
 * @template {{ version?: number, chapters: Record<string, unknown> }} P
 * @param {P} progress
 * @returns {P & { version: number }}
 */
export function migrateProgress(progress) {
  const from = Number.isInteger(progress.version) ? /** @type {number} */ (progress.version) : 1;
  let chapters = progress.chapters;
  for (let v = from + 1; v <= PROGRESS_VERSION; v++) chapters = renameChapters(chapters, CHAPTER_ID_RENAMES[v] ?? {});
  return { ...progress, version: Math.max(from, PROGRESS_VERSION), chapters };
}
