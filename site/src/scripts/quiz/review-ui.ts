import * as P from '../progress/store';
import chapters from '../../generated/chapters.json';
import strings from '../../locales/ru.json';
import { format, plural } from '../../locales/format.mjs';
import { QUESTION_ANCHOR_PREFIX } from '../../config/app.mjs';
import { $$, el } from '../dom';
import { reviewItems } from './review.mjs';

const ui = strings.ui;

const REASON_TEXT = { wrong: ui.reviewReasonWrong, revealed: ui.reviewReasonRevealed, didntKnow: ui.reviewReasonDidntKnow };

// The question index is loaded only here, so chapter pages do not carry every question of the book.
export async function initReview() {
  const box = document.querySelector<HTMLElement>('.quiz-review');
  if (!box) return;
  const { default: quizIndex } = await import('../../generated/quiz-index.json');
  const render = () => {
    const groups = reviewItems(P.get(), chapters, quizIndex);
    if (!groups.length) {
      box.replaceChildren(el('p', { class: 'quiz-review-empty' }, ui.reviewEmpty));
      return;
    }
    const count = groups.reduce((sum, g) => sum + g.questions.length, 0);
    const summary = el('p', { class: 'quiz-review-count' }, format(ui.reviewCount, {
      count,
      questions: plural(strings.lang, count, ui.questions),
      chapterCount: groups.length,
      chapters: plural(strings.lang, groups.length, ui.chaptersOf),
    }));
    const sections = groups.map(({ chapter, questions }) => el('section', { class: 'quiz-review-chapter' },
      el('h2', {}, el('a', { href: chapter.href }, `${chapter.num} · ${chapter.title}`)),
      el('ul', {}, ...questions.map((q) => el('li', {},
        el('a', { href: `${chapter.href}#${QUESTION_ANCHOR_PREFIX}${q.n}` },
          el('span', { class: 'quiz-review-num' }, format(strings.site.questionLabel, { n: q.n })), ' ', q.text),
        ' ',
        el('span', { class: `quiz-verdict ${q.reason === 'revealed' ? '' : 'bad'}` }, REASON_TEXT[q.reason]),
      ))),
    ));
    box.replaceChildren(summary, ...sections);
  };
  render();
  P.onChange(render);
}
