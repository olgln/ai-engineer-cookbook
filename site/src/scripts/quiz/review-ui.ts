import * as P from '../progress/store';
import { format, plural } from '../../locales/format.mjs';
import { DEFAULT_LOCALE, QUESTION_ANCHOR_PREFIX } from '../../config/app.mjs';
import { $$, el } from '../dom';
import { reviewItems } from './review.mjs';

type IndexedQuestion = { n: number; text: string; correct?: string[] };
import { chapters, lang, strings } from '../page-locale';

const ui = strings.ui;

const REASON_TEXT = { wrong: ui.reviewReasonWrong, revealed: ui.reviewReasonRevealed, didntKnow: ui.reviewReasonDidntKnow };

// The question index is loaded only here, so chapter pages do not carry every question of the book.
export async function initReview() {
  const box = document.querySelector<HTMLElement>('.quiz-review');
  if (!box) return;
  const { default: byLang } = await import('../../generated/quiz-index.json');
  // a translation's index holds the original's questions of the chapters it has not translated yet
  const quizIndex = (byLang as Record<string, Record<string, IndexedQuestion[]>>)[lang] ?? byLang[DEFAULT_LOCALE.lang as keyof typeof byLang];
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
        // the quiz is on the page with the chapter text: the original's, while the chapter is not translated
        el('a', { href: `${chapter.readHref ?? chapter.href}#${QUESTION_ANCHOR_PREFIX}${q.n}` },
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
