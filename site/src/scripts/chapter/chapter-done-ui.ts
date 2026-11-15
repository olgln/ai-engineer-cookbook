import * as P from '../progress/store';
import strings from '../../locales/ru.json';
import { format } from '../../locales/format.mjs';
import { $$, el } from '../dom';
import { quizStats } from '../quiz/quiz-ui';

const ui = strings.ui;

export function initChapterDone(box: HTMLElement) {
  const id = box.dataset.chapter!;
  const render = () => {
    const ch = P.chapter(id);
    const quiz = quizStats(document.querySelector<HTMLElement>(`.quiz[data-chapter="${id}"]`), id);
    const inputs = $$('.done-list input[type="checkbox"]');
    const checks = Object.values(ch.checks ?? {}).filter(Boolean).length;
    const facts = el('ul', { class: 'chapter-done-facts' },
      el('li', {}, format(ui.doneFactChecklist, { heading: strings.book.doneHeading, done: checks, total: inputs.length })),
      el('li', {}, format(ui.doneFactQuiz, { ...quiz })),
    );
    const btn = el('button', { type: 'button', class: `quiz-btn ${ch.done ? 'ghost' : 'primary'}` });
    btn.textContent = ch.done ? ui.unmarkChapter : ui.markChapterDone;
    btn.addEventListener('click', () => {
      if (ch.done) delete ch.done;
      else ch.done = new Date().toISOString();
      P.save();
    });
    const title = ch.done
      ? format(ui.chapterDoneOn, { date: new Date(ch.done).toLocaleDateString(strings.dateLocale, { day: 'numeric', month: 'long' }) })
      : ui.chapterDonePrompt;
    box.classList.toggle('is-done', !!ch.done);
    box.replaceChildren(el('p', { class: 'chapter-done-title', textContent: title }), facts, btn);
  };
  render();
  P.onChange(render);
}
