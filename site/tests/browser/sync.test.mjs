// Tests for syncing the browser copy of the progress with the account (src/scripts/progress/sync.mjs): merging two
// copies without losing work, and what to show / upload after loading the account copy.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { mergeProgress, parseMarker, planLoad, sameProgress } from '../../src/scripts/progress/sync.mjs';

const doc = (updatedAt, chapters) => ({ version: 1, updatedAt, chapters });
const EARLY = '2026-11-01T10:00:00.000Z';
const LATE = '2026-11-10T10:00:00.000Z';

describe('mergeProgress', () => {
  test('keeps chapters, finished marks and ticked checks of both copies', () => {
    const a = doc(EARLY, { c1: { done: '2026-11-01', checks: { 0: true, 1: false } }, c2: { checks: { 0: true } } });
    const b = doc(LATE, { c1: { done: '2026-11-05', checks: { 1: true, 2: false } }, c3: { done: '2026-11-09' } });
    assert.deepEqual(mergeProgress(a, b), doc(LATE, {
      c1: { done: '2026-11-01', checks: { 0: true, 1: true, 2: false } },
      c2: { checks: { 0: true } },
      c3: { done: '2026-11-09' },
    }));
  });

  test('an answer given in both copies comes from the copy changed last, either argument order', () => {
    const older = doc(EARLY, { c1: { quiz: { 1: { picked: ['a'], revealed: true }, 2: { self: 'no', revealed: true } } } });
    const newer = doc(LATE, { c1: { quiz: { 1: { picked: ['b'], revealed: true } } } });
    const want = doc(LATE, { c1: { quiz: { 1: { picked: ['b'], revealed: true }, 2: { self: 'no', revealed: true } } } });
    assert.deepEqual(mergeProgress(older, newer), want);
    assert.deepEqual(mergeProgress(newer, older), want);
  });

  test('a copy without a date counts as the older one', () => {
    const undated = { version: 1, chapters: { c1: { quiz: { 1: { picked: ['a'] } } } } };
    const dated = doc(EARLY, { c1: { quiz: { 1: { picked: ['b'] } } } });
    assert.deepEqual(mergeProgress(undated, dated).chapters.c1.quiz[1], { picked: ['b'] });
  });

  test('merging with an empty copy changes nothing', () => {
    const a = doc(EARLY, { c1: { done: '2026-11-01', checks: { 0: true }, quiz: { 1: { self: 'yes' } } } });
    assert.ok(sameProgress(mergeProgress(a, doc(undefined, {})), a));
  });
});

describe('sameProgress', () => {
  test('ignores key order and the date', () => {
    assert.ok(sameProgress(doc(EARLY, { a: { checks: { 0: true, 1: false } } }), doc(LATE, { a: { checks: { 1: false, 0: true } } })));
    assert.ok(!sameProgress(doc(EARLY, { a: {} }), doc(EARLY, { b: {} })));
  });
});

describe('planLoad', () => {
  const server = doc(EARLY, { c1: { done: '2026-11-01' } });
  const local = doc(LATE, { c2: { done: '2026-11-10' } });

  test('nothing in the browser: show the account copy', () => {
    assert.deepEqual(planLoad({ local: null, server, rev: 3, marker: null }), { state: server, push: false });
  });

  test('first sync in this browser: merge both and upload', () => {
    const { state, push } = planLoad({ local, server, rev: 3, marker: null });
    assert.deepEqual(Object.keys(state.chapters).sort(), ['c1', 'c2']);
    assert.equal(push, true);
  });

  test('first sync with nothing new in the browser: no upload', () => {
    const { push } = planLoad({ local: doc(EARLY, { c1: { done: '2026-11-01' } }), server, rev: 3, marker: null });
    assert.equal(push, false);
  });

  test('in step with the account: the account copy wins, even over stale ticks in the browser', () => {
    const stale = doc(LATE, { c1: { done: '2026-11-01', checks: { 0: true } } });
    assert.deepEqual(planLoad({ local: stale, server, rev: 3, marker: { rev: 2, dirty: false } }), { state: server, push: false });
  });

  test('unsent browser changes on the current revision: keep and upload them', () => {
    assert.deepEqual(planLoad({ local, server, rev: 3, marker: { rev: 3, dirty: true } }), { state: local, push: true });
  });

  test('unsent browser changes but another device wrote meanwhile: merge and upload', () => {
    const { state, push } = planLoad({ local, server, rev: 4, marker: { rev: 3, dirty: true } });
    assert.deepEqual(Object.keys(state.chapters).sort(), ['c1', 'c2']);
    assert.equal(push, true);
  });
});

describe('parseMarker', () => {
  test('reads a valid marker and rejects anything else', () => {
    assert.deepEqual(parseMarker('{"rev":3,"dirty":true}'), { rev: 3, dirty: true });
    for (const text of [null, '', 'x', '{"rev":-1,"dirty":true}', '{"rev":1.5,"dirty":false}', '{"rev":1}', '[]']) {
      assert.equal(parseMarker(text), null, String(text));
    }
  });
});
