// Pure logic of the review page: which quiz questions need another look. Kept apart from the DOM
// wiring in ./review-ui.ts so it is tested without a browser (tests/browser/review.test.mjs).

/**
 * @typedef {{ picked?: string[], revealed?: boolean, self?: 'yes' | 'no' }} QuizAnswer
 * @typedef {{ n: number, text: string, correct?: string[] }} IndexedQuestion
 * @typedef {{ id: string, num: string, title: string, href: string }} Chapter
 * @typedef {'wrong' | 'revealed' | 'didntKnow'} ReviewReason
 */

const sameSet = (a, b) => a.length === b.length && a.every((x) => b.includes(x));

/**
 * Why a question needs another look, or null when it does not (not answered yet, or answered right).
 * Multiple choice: a wrong pick, or the answer opened without a pick. Open question: marked "didn't know".
 * @param {QuizAnswer | undefined} answer the reader's answer from the progress
 * @param {string[] | undefined} correct answer key; absent for open questions
 * @returns {ReviewReason | null}
 */
export function reviewReason(answer, correct) {
  if (!answer?.revealed) return null;
  if (correct) {
    if (!answer.picked?.length) return 'revealed';
    return sameSet(answer.picked, correct) ? null : 'wrong';
  }
  return answer.self === 'no' ? 'didntKnow' : null;
}

/**
 * Questions to review, grouped by chapter in reading order; chapters with nothing to review are left out.
 * Answers to questions the book no longer has are ignored.
 * @param {{ chapters: Record<string, { quiz?: Record<string, QuizAnswer> }> }} progress
 * @param {Chapter[]} chapters
 * @param {Record<string, IndexedQuestion[]>} quizIndex
 * @returns {{ chapter: Chapter, questions: (IndexedQuestion & { reason: ReviewReason })[] }[]}
 */
export function reviewItems(progress, chapters, quizIndex) {
  const groups = [];
  for (const chapter of chapters) {
    const answers = progress.chapters[chapter.id]?.quiz ?? {};
    const questions = (quizIndex[chapter.id] ?? [])
      .map((q) => ({ ...q, reason: reviewReason(answers[q.n], q.correct) }))
      .filter((q) => q.reason !== null);
    if (questions.length) groups.push({ chapter, questions });
  }
  return groups;
}
