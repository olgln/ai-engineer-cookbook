import * as P from './progress';
import chapters from '../chapters.json';
import strings from '../locales/ru.json';
import { format, plural as pluralForm } from '../locales/format.mjs';
import { checkboxLabel, clickTogglesItem } from './checklist.mjs';
import { reviewItems } from './review.mjs';
import {
  AUTH_API_PREFIX, LOGIN_ERROR_PARAM, ME_API_PATH, PRIVACY_PATH, QUESTION_ANCHOR_PREFIX, RETURN_TO_PARAM,
} from '../config/app.mjs';
import type { MermaidConfig } from 'mermaid';

const ui = strings.ui;

const $$ = <T extends Element = HTMLElement>(sel: string, root: ParentNode = document) =>
  Array.from(root.querySelectorAll<T & Element>(sel)) as unknown as T[];

function el<K extends keyof HTMLElementTagNameMap>(tag: K, props: Partial<HTMLElementTagNameMap[K]> & { class?: string } = {}, ...children: (Node | string)[]) {
  const node = document.createElement(tag);
  const { class: cls, ...rest } = props;
  if (cls) node.className = cls;
  Object.assign(node, rest);
  node.append(...children);
  return node;
}

const plural = (n: number, forms: Record<string, string>) => pluralForm(strings.lang, n, forms);

// ---------------- stats ----------------
interface QuizStats { total: number; answered: number; correct: number }

function quizStats(quiz: HTMLElement | null, id: string): QuizStats {
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

// ---------------- quiz ----------------
function initQuiz(quiz: HTMLElement) {
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
      : format(ui.quizIntro, { total: s.total, questions: plural(s.total, ui.questions) });
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

// ---------------- checklist ----------------
function initChecklist(box: HTMLElement) {
  const id = box.dataset.chapter!;
  const inputs = $$<HTMLInputElement>('input[type="checkbox"]', box);
  const counter = el('div', { class: 'done-counter' });
  box.prepend(counter);
  const render = () => {
    const checks = P.chapter(id).checks ?? {};
    let done = 0;
    inputs.forEach((inp, i) => {
      inp.checked = !!checks[i];
      inp.closest('li')?.classList.toggle('checked', inp.checked);
      if (inp.checked) done++;
    });
    counter.textContent = format(ui.checklistCount, { done, total: inputs.length });
    counter.classList.toggle('complete', done === inputs.length);
  };
  inputs.forEach((inp, i) => {
    inp.disabled = false;
    inp.removeAttribute('disabled');
    inp.addEventListener('change', () => {
      (P.chapter(id).checks ??= {})[i] = inp.checked;
      P.save();
    });
    // whole line toggles the box
    inp.closest('li')?.addEventListener('click', (e) => {
      if (clickTogglesItem(e.target as HTMLElement, window.getSelection()?.toString() ?? '')) inp.click();
    });
  });
  render();
  P.onChange(render);
}

/** Name every task-list checkbox (the "done when" checklists, the tracker on the plan page) by its item text. */
function labelCheckboxes() {
  for (const inp of $$<HTMLInputElement>('.sl-markdown-content li input[type="checkbox"]')) {
    const li = inp.closest('li');
    if (li && !inp.hasAttribute('aria-label')) inp.setAttribute('aria-label', checkboxLabel(li.textContent ?? ''));
  }
}

// ---------------- chapter done card ----------------
function initChapterDone(box: HTMLElement) {
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

// ---------------- sidebar & index ----------------
function markLinks() {
  const done = (id: string) => !!P.get().chapters[id]?.done;
  for (const a of $$<HTMLAnchorElement>('a[data-chapter]')) a.classList.toggle('is-done', done(a.dataset.chapter!));
  const byHref = new Map(chapters.map((c) => [c.href, c.id]));
  for (const a of $$<HTMLAnchorElement>('.sl-markdown-content .week-card a, .sl-markdown-content a')) {
    const id = byHref.get(new URL(a.href, location.href).pathname);
    if (id) a.closest('li')?.classList.toggle('chapter-is-done', done(id));
  }
  // group headings in sidebar: "3/5"
  for (const details of $$<HTMLDetailsElement>('nav.sidebar details, #starlight__sidebar details')) {
    const links = $$<HTMLAnchorElement>('a[data-chapter]', details);
    if (!links.length) continue;
    const n = links.filter((a) => done(a.dataset.chapter!)).length;
    const summary = details.querySelector('summary .group-label, summary');
    if (!summary) continue;
    let badge = summary.querySelector<HTMLElement>('.group-progress');
    if (!badge) {
      badge = el('span', { class: 'group-progress' });
      summary.querySelector('.group-label')?.append(badge) ?? summary.append(badge);
    }
    badge.textContent = `${n}/${links.length}`;
    badge.classList.toggle('complete', n === links.length);
  }
}

function setBar(bar: HTMLElement | null, done: number, total: number) {
  if (!bar) return;
  const pct = total ? Math.round((done / total) * 100) : 0;
  bar.setAttribute('aria-valuenow', String(pct));
  bar.querySelector<HTMLElement>('.progress-fill')?.style.setProperty('width', `${pct}%`);
}

// The progress blocks come pre-rendered in the "nothing done yet" state (scripts/lib/render.mjs,
// courseProgressHtml / weekProgressHtml); here they are updated in place, so the page does not shift.
function initIndex() {
  const overall = document.querySelector<HTMLElement>('.course-progress');
  if (!overall) return;
  const count = overall.querySelector<HTMLElement>('.course-progress-count');
  const note = overall.querySelector<HTMLElement>('.storage-note');
  const nextLink = overall.querySelector<HTMLAnchorElement>('.course-progress-next');
  const allDone = el('span', {}, ui.allDone);
  overall.querySelector('.course-progress-export')?.addEventListener('click', exportProgress);
  overall.querySelector('.course-progress-import')?.addEventListener('click', importProgress);
  const render = () => {
    const done = (id: string) => !!P.get().chapters[id]?.done;
    const total = chapters.length;
    const n = chapters.filter((c) => done(c.id)).length;
    const next = chapters.find((c) => !done(c.id));
    if (count) count.textContent = format(ui.courseProgress, { done: n, total, chapters: plural(total, ui.chaptersOf) });
    if (note) {
      note.textContent = P.storage === 'file'
        ? format(ui.savedTo, { path: P.storagePath || ui.progressFileFallback })
        : P.storage === 'account' ? ui.savedInAccount : ui.savedInBrowser;
    }
    setBar(overall.querySelector<HTMLElement>(':scope > .progress-bar'), n, total);
    if (nextLink && next) {
      nextLink.href = next.href;
      nextLink.textContent = format(n ? ui.continueFrom : ui.startFrom, { chapter: `${next.num} · ${next.title}` });
      if (!nextLink.isConnected) allDone.replaceWith(nextLink);
    } else if (nextLink?.isConnected) nextLink.replaceWith(allDone);
    for (const card of $$<HTMLElement>('.week-card')) {
      const week = +card.dataset.week!;
      const list = chapters.filter((c) => c.week === week);
      const d = list.filter((c) => done(c.id)).length;
      const slot = card.querySelector<HTMLElement>('.week-progress');
      setBar(slot?.querySelector<HTMLElement>('.progress-bar') ?? null, d, list.length);
      const label = slot?.querySelector<HTMLElement>('.week-progress-label');
      if (label) label.textContent = `${d}/${list.length}`;
      card.classList.toggle('complete', list.length > 0 && d === list.length);
    }
  };
  render();
  P.onChange(render);
  void initAccount(overall);
}

// ---------------- account ----------------
interface Me { providers?: string[]; available?: string[] }

const providerName = (p: string) => (ui.providerNames as Record<string, string>)[p] ?? p;

/** Removes the "sign-in failed" mark from the address, so a reload does not show the message again. */
function takeLoginError(): boolean {
  const params = new URLSearchParams(location.search);
  if (!params.has(LOGIN_ERROR_PARAM)) return false;
  params.delete(LOGIN_ERROR_PARAM);
  const query = params.toString();
  history.replaceState(null, '', location.pathname + (query ? `?${query}` : '') + location.hash);
  return true;
}

// Sign-in / sign-out under the course progress. Shown only where the account API answers (the hosting
// with a sign-in provider set up); the local server has no /api/me, so the box stays hidden there.
async function initAccount(overall: HTMLElement) {
  const box = overall.querySelector<HTMLElement>('.account-box');
  if (!box) return;
  const failed = takeLoginError();
  let me: Me;
  try {
    const res = await fetch(ME_API_PATH, { cache: 'no-store' });
    if (![200, 401].includes(res.status) || !(res.headers.get('content-type') ?? '').includes('json')) return;
    me = await res.json();
  } catch {
    return;
  }
  if (me.providers?.length) {
    const signOut = el('button', { class: 'quiz-btn ghost', type: 'button', textContent: ui.signOut });
    signOut.addEventListener('click', async () => {
      signOut.disabled = true;
      await P.signOut();
      location.reload();
    });
    const who = format(ui.signedInWith, { provider: me.providers.map(providerName).join(', ') });
    const status = el('span', { class: 'account-status' }, who);
    const remove = el('button', { class: 'quiz-btn ghost account-delete', type: 'button', textContent: ui.deleteAccount });
    remove.addEventListener('click', async () => {
      if (!confirm(ui.confirmDeleteAccount)) return;
      signOut.disabled = remove.disabled = true;
      if (await P.deleteAccount()) {
        location.reload();
        return;
      }
      signOut.disabled = remove.disabled = false;
      status.className = 'account-status error';
      status.setAttribute('role', 'alert');
      status.textContent = ui.deleteAccountFailed;
    });
    box.replaceChildren(status, signOut, remove);
  } else if (me.available?.length) {
    const back = `${RETURN_TO_PARAM}=${encodeURIComponent(location.pathname)}`;
    const links = me.available.map((p) =>
      el('a', { class: 'quiz-btn', href: `${AUTH_API_PREFIX}${p}?${back}`, textContent: format(ui.signInWith, { provider: providerName(p) }) }));
    const text = el('span', { class: failed ? 'account-status error' : 'account-status' }, failed ? ui.signInFailed : ui.signInPrompt);
    if (failed) text.setAttribute('role', 'alert');
    const privacy = el('a', { class: 'account-privacy', href: PRIVACY_PATH, textContent: ui.privacyLink });
    box.replaceChildren(text, ...links, privacy);
  } else return;
  box.hidden = false;
}

function exportProgress() {
  const blob = new Blob([JSON.stringify(P.get(), null, 2)], { type: 'application/json' });
  const a = el('a', { href: URL.createObjectURL(blob), download: `progress-${new Date().toISOString().slice(0, 10)}.json` });
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

function importProgress() {
  const input = el('input', { type: 'file', accept: 'application/json,.json' });
  input.addEventListener('change', async () => {
    const f = input.files?.[0];
    if (!f) return;
    try {
      const data = JSON.parse(await f.text());
      if (!data?.chapters) throw new Error(ui.importMissingChapters);
      if (!confirm(ui.confirmImport)) return;
      P.replaceAll(data);
      location.reload();
    } catch (e) {
      alert(format(ui.importFailed, { error: (e as Error).message }));
    }
  });
  input.click();
}

// ---------------- review page ----------------
const REASON_TEXT = { wrong: ui.reviewReasonWrong, revealed: ui.reviewReasonRevealed, didntKnow: ui.reviewReasonDidntKnow };

// The question index is loaded only here, so chapter pages do not carry every question of the book.
async function initReview() {
  const box = document.querySelector<HTMLElement>('.quiz-review');
  if (!box) return;
  const { default: quizIndex } = await import('../quiz-index.json');
  const render = () => {
    const groups = reviewItems(P.get(), chapters, quizIndex);
    if (!groups.length) {
      box.replaceChildren(el('p', { class: 'quiz-review-empty' }, ui.reviewEmpty));
      return;
    }
    const count = groups.reduce((sum, g) => sum + g.questions.length, 0);
    const summary = el('p', { class: 'quiz-review-count' }, format(ui.reviewCount, {
      count, questions: plural(count, ui.questions), chapterCount: groups.length, chapters: plural(groups.length, ui.chaptersOf),
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

// A link to a question (chapter#q-N, from the review page) lands on it only after the quiz has its final
// height (opened answers above it push it down); --quiz-toolbar-height keeps it below the sticky toolbar.
function scrollToLinkedQuestion() {
  const q = location.hash ? document.getElementById(decodeURIComponent(location.hash.slice(1))) : null;
  if (!q?.classList.contains('quiz-q')) return;
  q.scrollIntoView();
}

// ---------------- mermaid ----------------
const mermaidConfig = (dark: boolean): MermaidConfig => ({
  startOnLoad: false,
  theme: dark ? 'dark' : 'neutral',
  securityLevel: 'strict',
  themeVariables: { fontSize: '15px' },
  flowchart: { useMaxWidth: false, padding: 12 },
});
async function initMermaid() {
  const nodes = $$<HTMLElement>('pre.mermaid');
  if (!nodes.length) return;
  const { default: mermaid } = await import('mermaid');
  const dark = document.documentElement.dataset.theme === 'dark';
  mermaid.initialize(mermaidConfig(dark));
  nodes.forEach((n) => (n.dataset.src ??= n.textContent ?? ''));
  await mermaid.run({ nodes });
  // re-render on theme switch
  new MutationObserver(async () => {
    const isDark = document.documentElement.dataset.theme === 'dark';
    mermaid.initialize(mermaidConfig(isDark));
    nodes.forEach((n) => { n.removeAttribute('data-processed'); n.textContent = n.dataset.src!; });
    await mermaid.run({ nodes });
  }).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
}

// ---------------- external links ----------------
/** Links to other sites open in a new tab; links inside the study site stay in the same tab. */
function openExternalLinksInNewTab() {
  for (const a of $$<HTMLAnchorElement>('a[href]')) {
    if (!/^https?:$/.test(a.protocol) || a.origin === location.origin) continue;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
  }
}

// ---------------- boot ----------------
async function boot() {
  openExternalLinksInNewTab();
  labelCheckboxes();
  void initMermaid();
  await P.load();
  $$<HTMLElement>('.quiz').forEach(initQuiz);
  $$<HTMLElement>('.done-list').forEach(initChecklist);
  $$<HTMLElement>('.chapter-done').forEach(initChapterDone);
  initIndex();
  void initReview();
  markLinks();
  P.onChange(markLinks);
  document.documentElement.classList.add('progress-ready');
  scrollToLinkedQuestion();
}

void boot();
