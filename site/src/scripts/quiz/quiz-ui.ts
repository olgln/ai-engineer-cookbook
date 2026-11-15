import * as P from '../progress/store';
import strings from '../../locales/ru.json';
import { format, plural } from '../../locales/format.mjs';
import { $$, el } from '../dom';

const ui = strings.ui;

interface QuizStats { total: number; answered: number; correct: number }

export function quizStats(quiz: HTMLElement | null, id: string): QuizStats {
  const st = P.chapter(id).quiz ?? {};
  const qs = quiz ? $$<HTMLElement>('.quiz-q', quiz) : [];
  let answered = 0, correct = 0;
  for (const q of qs) {
    const a = st[q.dataset.n!];
    if (!a?.revealed) continue;
    answered++;
    const key = q.dataset.correct;
    if (key ? sameSet(a.picked ?? [], key.split(',')) : a.self === 'yes') correct++;
  }
  return { total: qs.length, answered, correct };
}

const sameSet = (a: string[], b: string[]) => a.length === b.length && a.every((x) => b.includes(x));

export function initQuiz(quiz: HTMLElement) {
  const id = quiz.dataset.chapter!;
  const summary = el('div', { class: 'quiz-summary' });
  const showAll = el('button', { class: 'quiz-btn ghost', type: 'button', textContent: ui.showAllAnswers });
  const reset = el('button', { class: 'quiz-btn ghost', type: 'button', textContent: ui.restartQuiz });
  const bar = el('div', { class: 'quiz-toolbar' }, summary, el('div', { class: 'quiz-toolbar-actions' }, showAll, reset));
  quiz.prepend(bar);
  const keepBelowToolbar = () => quiz.style.setProperty('--quiz-toolbar-height', `${bar.offsetHeight}px`);
  keepBelowToolbar();
  window.addEventListener('resize', keepBelowToolbar);

  const renders: (() => void)[] = [];
  for (const q of $$<HTMLElement>('.quiz-q', quiz)) renders.push(initQuestion(q, id));

  const renderSummary = () => {
    const s = quizStats(quiz, id);
    summary.textContent = s.answered
      ? format(ui.quizSummary, { ...s })
      : format(ui.quizIntro, { total: s.total, questions: plural(strings.lang, s.total, ui.questions) });
    summary.classList.toggle('complete', s.answered === s.total && s.total > 0);
  };
  renderSummary();
  P.onChange(renderSummary);

  showAll.addEventListener('click', () => {
    if (!confirm(ui.confirmShowAll)) return;
    const st = (P.chapter(id).quiz ??= {});
    for (const q of $$<HTMLElement>('.quiz-q', quiz)) (st[q.dataset.n!] ??= {}).revealed = true;
    P.save();
    renders.forEach((r) => r());
  });
  reset.addEventListener('click', () => {
    if (!confirm(ui.confirmResetQuiz)) return;
    P.chapter(id).quiz = {};
    P.save();
    renders.forEach((r) => r());
  });
}

function initQuestion(q: HTMLElement, id: string): () => void {
  const n = q.dataset.n!;
  const key = q.dataset.correct?.split(',');
  const answerBox = q.querySelector<HTMLElement>('.quiz-answer')!;
  const options = $$<HTMLLIElement>('.quiz-options li', q);
  const actions = el('div', { class: 'quiz-actions' });
  answerBox.before(actions);
  answerBox.prepend(el('p', { class: 'quiz-answer-label', textContent: ui.answerLabel }));

  const st = () => ((P.chapter(id).quiz ??= {})[n] ??= {});
  let picked: string[] = [...(P.chapter(id).quiz?.[n]?.picked ?? [])];

  const check = el('button', { class: 'quiz-btn primary', type: 'button', textContent: ui.check });
  const show = el('button', { class: 'quiz-btn', type: 'button', textContent: ui.showAnswer });
  const knew = el('button', { class: 'quiz-btn good', type: 'button', textContent: ui.knew });
  const didnt = el('button', { class: 'quiz-btn bad', type: 'button', textContent: ui.didntKnow });
  const again = el('button', { class: 'quiz-btn ghost', type: 'button', textContent: ui.again });
  const verdict = el('span', { class: 'quiz-verdict' });

  const letterOf = (li: HTMLLIElement) => (li.querySelector('strong')?.textContent ?? '').replace(/[^a-d]/g, '');

  options.forEach((li) => {
    li.tabIndex = 0;
    li.setAttribute('role', key && key.length > 1 ? 'checkbox' : 'radio');
    const toggle = () => {
      if (st().revealed) return;
      const k = letterOf(li);
      if (key && key.length > 1) picked = picked.includes(k) ? picked.filter((x) => x !== k) : [...picked, k];
      else picked = [k];
      render();
    };
    li.addEventListener('click', toggle);
    li.addEventListener('keydown', (e) => {
      if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); toggle(); }
    });
  });

  check.addEventListener('click', () => {
    if (!picked.length) return;
    Object.assign(st(), { picked, revealed: true });
    P.save();
    render();
  });
  show.addEventListener('click', () => {
    st().revealed = true;
    P.save();
    render();
  });
  knew.addEventListener('click', () => { st().self = 'yes'; P.save(); render(); });
  didnt.addEventListener('click', () => { st().self = 'no'; P.save(); render(); });
  again.addEventListener('click', () => {
    delete P.chapter(id).quiz![n];
    picked = [];
    P.save();
    render();
  });

  function render() {
    const s = (P.chapter(id).quiz ?? {})[n] ?? {};
    if (!s.revealed && s.picked) picked = s.picked;
    if (!s.revealed && !s.picked && !picked.length) picked = [];
    const revealed = !!s.revealed;
    q.classList.toggle('revealed', revealed);
    options.forEach((li) => {
      const k = letterOf(li);
      li.setAttribute('aria-checked', String(picked.includes(k)));
      li.classList.toggle('picked', picked.includes(k));
      li.classList.toggle('correct', revealed && !!key?.includes(k));
      li.classList.toggle('wrong', revealed && picked.includes(k) && !key?.includes(k));
    });
    actions.replaceChildren();
    q.classList.remove('is-correct', 'is-wrong');
    if (key) {
      if (!revealed) {
        check.disabled = !picked.length;
        actions.append(check, el('span', { class: 'quiz-hint', textContent: key.length > 1 ? ui.multipleCorrect : '' }));
      } else {
        const ok = sameSet(s.picked ?? [], key);
        verdict.textContent = !s.picked?.length ? ui.revealedWithoutAttempt : ok ? ui.correct : ui.wrong;
        verdict.className = `quiz-verdict ${s.picked?.length ? (ok ? 'good' : 'bad') : ''}`;
        q.classList.add(ok ? 'is-correct' : 'is-wrong');
        actions.append(verdict, again);
      }
    } else if (!revealed) {
      actions.append(show, el('span', { class: 'quiz-hint', textContent: ui.answerYourselfFirst }));
    } else {
      if (s.self) {
        verdict.textContent = s.self === 'yes' ? ui.verdictKnew : ui.verdictDidntKnow;
        verdict.className = `quiz-verdict ${s.self === 'yes' ? 'good' : 'bad'}`;
        q.classList.add(s.self === 'yes' ? 'is-correct' : 'is-wrong');
        actions.append(verdict, again);
      } else {
        actions.append(el('span', { class: 'quiz-hint', textContent: ui.compareWithYours }), knew, didnt);
      }
    }
  }
  render();
  return render;
}

// A link to a question (chapter#q-N, from the review page) lands on it only after the quiz has its final
// height (opened answers above it push it down); --quiz-toolbar-height keeps it below the sticky toolbar.
export function scrollToLinkedQuestion() {
  const q = location.hash ? document.getElementById(decodeURIComponent(location.hash.slice(1))) : null;
  if (!q?.classList.contains('quiz-q')) return;
  q.scrollIntoView();
}
