// Checks of a translation against the original, used by scripts/convert.mjs. Reading progress is shared
// between the languages (a chapter keeps its id, a quiz answer is stored by question number and a checklist
// tick by item position), so a translated chapter must keep the original's quiz and checklist structure.
// Pure, so it is tested without the real book (tests/convert/translation.test.mjs).
import { createHash } from 'node:crypto';
import { SOURCE_HASH_LENGTH } from '../../src/config/app.mjs';

/**
 * The hash a translation records of its original (SOURCE_HASH_MARKER).
 * @param {string} text the original chapter file
 */
export const sourceHash = (text) => createHash('sha256').update(text).digest('hex').slice(0, SOURCE_HASH_LENGTH);

/** @typedef {Record<string, { n: number, text: string, correct?: string[] }[]>} QuizIndex */

/**
 * Where a translated chapter's quiz or checklist differs from the original's: other question numbers,
 * other answer keys, another number of checklist items. Empty when they match.
 * @param {string} id chapter id
 * @param {{ quizzes: QuizIndex, checklists: Record<string, number> }} original
 * @param {{ quizzes: QuizIndex, checklists: Record<string, number> }} translated
 * @returns {string[]}
 */
export function structureMismatches(id, original, translated) {
  const out = [];
  const questions = (index) => (index[id] ?? []).map((q) => `${q.n}${q.correct ? `:${q.correct.join(',')}` : ''}`).join(' ');
  const a = questions(original.quizzes);
  const b = questions(translated.quizzes);
  if (a !== b) out.push(`${id}: quiz differs from the original (questions[:key] "${b}" vs "${a}")`);
  const ca = original.checklists[id] ?? 0;
  const cb = translated.checklists[id] ?? 0;
  if (ca !== cb) out.push(`${id}: ${cb} checklist items vs ${ca} in the original`);
  return out;
}

/**
 * Translated chapters whose original changed after the translation (the recorded hash differs).
 * @param {Record<string, string>} recorded source hash of each translated chapter, by id
 * @param {Record<string, string>} current hash of each original chapter file, by id
 * @returns {string[]} chapter ids
 */
export const outdatedTranslations = (recorded, current) =>
  Object.keys(recorded).filter((id) => recorded[id] !== current[id]);

/**
 * The questions of every chapter for a translation's review page: translated chapters bring their own,
 * untranslated ones the original's (the reader answered them on the original's page).
 * @param {QuizIndex} original
 * @param {QuizIndex} translated
 * @returns {QuizIndex}
 */
export const mergedQuizIndex = (original, translated) => ({ ...original, ...translated });
