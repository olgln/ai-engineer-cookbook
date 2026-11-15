// Syncing the browser copy of the progress with the reader's account (pure, tested in tests/browser/sync.test.mjs).
// The browser keeps a marker next to its copy, { rev, dirty }: the server revision the copy was last in
// step with, and whether it has changes the server has not got yet. No marker means the copy has never
// been synced with this account (first sign-in, or after signing out): then the two are merged.
import { PROGRESS_VERSION } from '../../config/app.mjs';

/** @typedef {{ picked?: string[], revealed?: boolean, self?: 'yes' | 'no' }} QuizAnswer */
/** @typedef {{ done?: string, checks?: Record<string, boolean>, quiz?: Record<string, QuizAnswer> }} ChapterProgress */
/** @typedef {{ version: number, updatedAt?: string, chapters: Record<string, ChapterProgress> }} Progress */
/** @typedef {{ rev: number, dirty: boolean }} SyncMarker */

const time = (p) => Date.parse(p?.updatedAt ?? '') || 0;
const earliest = (a, b) => (!a ? b : !b ? a : a <= b ? a : b);

/** Union of two chapters: done keeps the earlier date, a ticked check stays ticked, answers come from `newer`. */
function mergeChapter(older = {}, newer = {}) {
  /** @type {ChapterProgress} */
  const out = {};
  const done = earliest(older.done, newer.done);
  if (done) out.done = done;
  if (older.checks || newer.checks) {
    const checks = { ...older.checks };
    for (const [k, v] of Object.entries(newer.checks ?? {})) checks[k] = checks[k] || v;
    out.checks = checks;
  }
  if (older.quiz || newer.quiz) out.quiz = { ...older.quiz, ...newer.quiz };
  return out;
}

/**
 * Merges two progress documents without losing work from either: every chapter of both, finished
 * chapters and ticked checks from both, and for a question answered in both, the answer of the copy
 * changed last. (An unticked check comes back if the other copy still has it: losing a tick is worse.)
 * @param {Progress} a
 * @param {Progress} b
 * @returns {Progress}
 */
export function mergeProgress(a, b) {
  const [older, newer] = time(a) <= time(b) ? [a, b] : [b, a];
  /** @type {Progress} */
  const out = { version: PROGRESS_VERSION, chapters: {} };
  const updatedAt = newer.updatedAt ?? older.updatedAt;
  if (updatedAt) out.updatedAt = updatedAt;
  for (const id of new Set([...Object.keys(older.chapters), ...Object.keys(newer.chapters)])) {
    out.chapters[id] = mergeChapter(older.chapters[id], newer.chapters[id]);
  }
  return out;
}

/** Same content, ignoring key order. */
export function sameProgress(a, b) {
  const canon = (v) => (v && typeof v === 'object' && !Array.isArray(v)
    ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canon(v[k])]))
    : v);
  return JSON.stringify(canon(a.chapters)) === JSON.stringify(canon(b.chapters));
}

/**
 * What to show and whether to upload after loading the account copy.
 * @param {{ local: Progress | null, server: Progress, rev: number, marker: SyncMarker | null }} input
 * @returns {{ state: Progress, push: boolean }}
 */
export function planLoad({ local, server, rev, marker }) {
  if (!local) return { state: server, push: false };
  // Unsent local changes on top of the revision the server still has: they are simply newer.
  if (marker?.dirty && marker.rev === rev) return { state: local, push: !sameProgress(local, server) };
  // In step with the account: the server copy is the truth (it may hold another device's changes).
  if (marker && !marker.dirty) return { state: server, push: false };
  // First sync in this browser, or both sides changed: keep the work of both.
  const state = mergeProgress(local, server);
  return { state, push: !sameProgress(state, server) };
}

/** Parses the stored marker; anything malformed counts as "never synced". */
export function parseMarker(text) {
  try {
    const m = JSON.parse(text ?? '');
    return Number.isInteger(m?.rev) && m.rev >= 0 && typeof m.dirty === 'boolean' ? { rev: m.rev, dirty: m.dirty } : null;
  } catch {
    return null;
  }
}
