// Tests for the review page logic (src/scripts/quiz/review.mjs): which answered questions need another look.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { reviewItems, reviewReason } from '../../src/scripts/quiz/review.mjs';

describe('reviewReason', () => {
  const key = ['b'];

  test('unanswered questions are not reviewed', () => {
    assert.equal(reviewReason(undefined, key), null);
    assert.equal(reviewReason({ picked: ['a'] }, key), null, 'picked but not checked yet');
    assert.equal(reviewReason(undefined, undefined), null);
  });

  test('multiple choice: a wrong pick or an answer opened without a pick', () => {
    assert.equal(reviewReason({ picked: ['a'], revealed: true }, key), 'wrong');
    assert.equal(reviewReason({ revealed: true }, key), 'revealed');
    assert.equal(reviewReason({ picked: [], revealed: true }, key), 'revealed');
    assert.equal(reviewReason({ picked: ['b'], revealed: true }, key), null);
  });

  test('several correct options must all be picked, in any order', () => {
    assert.equal(reviewReason({ picked: ['c', 'a'], revealed: true }, ['a', 'c']), null);
    assert.equal(reviewReason({ picked: ['a'], revealed: true }, ['a', 'c']), 'wrong');
  });

  test('open question: only "didn\'t know" is reviewed', () => {
    assert.equal(reviewReason({ revealed: true, self: 'no' }, undefined), 'didntKnow');
    assert.equal(reviewReason({ revealed: true, self: 'yes' }, undefined), null);
    assert.equal(reviewReason({ revealed: true }, undefined), null, 'answer opened, no verdict yet');
  });
});

describe('reviewItems', () => {
  const chapters = [
    { id: '1-1', num: '1.1', title: 'Python', href: '/week-01/1-1/' },
    { id: '1-2', num: '1.2', title: 'Repo', href: '/week-01/1-2/' },
    { id: '2-1', num: '2.1', title: 'API', href: '/week-02/2-1/' },
  ];
  const quizIndex = {
    '1-1': [{ n: 1, text: 'Pick', correct: ['b'] }, { n: 2, text: 'Explain' }],
    '1-2': [{ n: 1, text: 'Why?' }],
    '2-1': [{ n: 1, text: 'Pick', correct: ['a'] }, { n: 2, text: 'Pick again', correct: ['c'] }],
  };

  test('groups questions to review by chapter in reading order, skipping clean chapters', () => {
    const progress = {
      chapters: {
        '2-1': { quiz: { 2: { picked: ['a'], revealed: true }, 1: { picked: ['a'], revealed: true } } },
        '1-2': { quiz: { 1: { revealed: true, self: 'yes' } } },
        '1-1': { done: '2026-11-14', quiz: { 2: { revealed: true, self: 'no' }, 1: { revealed: true } } },
      },
    };
    assert.deepEqual(reviewItems(progress, chapters, quizIndex), [
      {
        chapter: chapters[0],
        questions: [
          { n: 1, text: 'Pick', correct: ['b'], reason: 'revealed' },
          { n: 2, text: 'Explain', reason: 'didntKnow' },
        ],
      },
      { chapter: chapters[2], questions: [{ n: 2, text: 'Pick again', correct: ['c'], reason: 'wrong' }] },
    ]);
  });

  test('empty progress gives nothing to review', () => {
    assert.deepEqual(reviewItems({ chapters: {} }, chapters, quizIndex), []);
  });

  test('answers to questions the book no longer has are ignored', () => {
    const progress = { chapters: { '1-2': { quiz: { 7: { revealed: true, self: 'no' } } }, '9-9': { quiz: { 1: { revealed: true } } } } };
    assert.deepEqual(reviewItems(progress, chapters, quizIndex), []);
  });
});
