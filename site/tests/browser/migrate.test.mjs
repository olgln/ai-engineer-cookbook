// Progress format versions (src/scripts/progress/migrate.mjs): an older document gets the chapter ids of the
// current book, so a reader's progress follows chapters that were renumbered.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { CHAPTER_ID_RENAMES, PROGRESS_VERSION } from '../../src/config/app.mjs';
import { migrateProgress, renameChapters } from '../../src/scripts/progress/migrate.mjs';

describe('migrateProgress', () => {
  test('version 1 → 2: weeks 8–11 move to 7–10 without colliding; earlier chapters keep their ids', () => {
    const v1 = {
      version: 1,
      updatedAt: '2026-11-15T10:00:00Z',
      chapters: { '6-5': { done: 'a' }, '8-1': { done: 'b' }, '9-1': { done: 'c' }, '10-4': { quiz: { 1: { picked: ['b'] } } }, '11-5': { checks: { 0: true } } },
    };
    assert.deepEqual(migrateProgress(v1), {
      version: PROGRESS_VERSION,
      updatedAt: '2026-11-15T10:00:00Z',
      chapters: { '6-5': { done: 'a' }, '7-1': { done: 'b' }, '8-1': { done: 'c' }, '9-4': { quiz: { 1: { picked: ['b'] } } }, '10-5': { checks: { 0: true } } },
    });
  });

  test('a document without a version is version 1', () => {
    assert.deepEqual(migrateProgress({ chapters: { '8-2': {} } }).chapters, { '7-2': {} });
  });

  test('a current or newer document is left as is', () => {
    const current = { version: PROGRESS_VERSION, chapters: { '8-1': { done: 'x' } } };
    assert.deepEqual(migrateProgress(current), current);
    const newer = { version: PROGRESS_VERSION + 1, chapters: { '8-1': {} } };
    assert.deepEqual(migrateProgress(newer), newer);
  });

  test('the version 2 renames cover every chapter of the old weeks 8–11, each to a distinct id', () => {
    const renames = CHAPTER_ID_RENAMES[2];
    assert.equal(Object.keys(renames).length, 19);
    assert.equal(new Set(Object.values(renames)).size, 19);
    assert.equal(renames['8-1'], '7-1');
    assert.equal(renames['11-5'], '10-5');
    assert.deepEqual(renameChapters({ x: 1 }, renames), { x: 1 });
  });
});
