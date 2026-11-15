// Tests for when the one-time "progress only in this browser" hint shows (src/scripts/account/save-hint.mjs).
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { hasProgress, shouldShowSaveHint } from '../../src/scripts/account/save-hint.mjs';

const done = { version: 1, chapters: { c1: { done: '2026-11-15' } } };

describe('hasProgress', () => {
  test('nothing, or only chapters that were opened, is no progress', () => {
    assert.equal(hasProgress(null), false);
    assert.equal(hasProgress({ version: 1, chapters: {} }), false);
    assert.equal(hasProgress({ version: 1, chapters: { c1: {}, c2: { checks: {}, quiz: {} } } }), false);
  });

  test('an unticked checklist item is no progress', () => {
    assert.equal(hasProgress({ chapters: { c1: { checks: { 0: false } } } }), false);
  });

  test('a finished chapter, a ticked item or a quiz answer is', () => {
    assert.equal(hasProgress(done), true);
    assert.equal(hasProgress({ chapters: { c1: { checks: { 2: true } } } }), true);
    assert.equal(hasProgress({ chapters: { c1: { quiz: { 1: { picked: ['a'] } } } } }), true);
  });
});

describe('shouldShowSaveHint', () => {
  const base = { storage: 'browser', account: { state: 'out' }, startedWithProgress: false, progress: done, shown: false };

  test('a new signed-out reader at their first progress sees it', () => {
    assert.equal(shouldShowSaveHint(base), true);
  });

  test('only once', () => {
    assert.equal(shouldShowSaveHint({ ...base, shown: true }), false);
  });

  test('not for a reader who already had progress when the page loaded', () => {
    assert.equal(shouldShowSaveHint({ ...base, startedWithProgress: true }), false);
  });

  test('not for a signed-in reader, nor where there are no accounts or the local file keeps the progress', () => {
    assert.equal(shouldShowSaveHint({ ...base, storage: 'account', account: { state: 'in' } }), false);
    assert.equal(shouldShowSaveHint({ ...base, account: { state: 'hidden' } }), false);
    assert.equal(shouldShowSaveHint({ ...base, storage: 'file' }), false);
  });

  test('not while there is still nothing to lose (an item ticked and unticked)', () => {
    assert.equal(shouldShowSaveHint({ ...base, progress: { chapters: { c1: { checks: { 0: false } } } } }), false);
  });
});
