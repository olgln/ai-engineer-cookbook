import * as P from './progress';
import chapters from '../chapters.json';

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

const plural = (n: number, one: string, few: string, many: string) => {
  const m10 = n % 10, m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
  return many;
};

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
  const showAll = el('button', { class: 'quiz-btn ghost', type: 'button', textContent: 'Показать все ответы' });
  const reset = el('button', { class: 'quiz-btn ghost', type: 'button', textContent: 'Начать тест заново' });
  const bar = el('div', { class: 'quiz-toolbar' }, summary, el('div', { class: 'quiz-toolbar-actions' }, showAll, reset));
  quiz.prepend(bar);

  const renders: (() => void)[] = [];
  for (const q of $$<HTMLElement>('.quiz-q', quiz)) renders.push(initQuestion(q, id));

  const renderSummary = () => {
    const s = quizStats(quiz, id);
    summary.textContent = s.answered
      ? `Отвечено ${s.answered} из ${s.total} · верно ${s.correct}`
      : `${s.total} ${plural(s.total, 'вопрос', 'вопроса', 'вопросов')}. Сначала ответь сам, потом проверяй.`;
    summary.classList.toggle('complete', s.answered === s.total && s.total > 0);
  };
  renderSummary();
  P.onChange(renderSummary);

  showAll.addEventListener('click', () => {
    if (!confirm('Открыть ответы на все вопросы? Неотвеченные вопросы засчитаются как открытые без ответа.')) return;
    const st = (P.chapter(id).quiz ??= {});
    for (const q of $$<HTMLElement>('.quiz-q', quiz)) (st[q.dataset.n!] ??= {}).revealed = true;
    P.save();
    renders.forEach((r) => r());
  });
  reset.addEventListener('click', () => {
    if (!confirm('Сбросить все ответы этого теста?')) return;
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
  answerBox.prepend(el('p', { class: 'quiz-answer-label', textContent: 'Ответ' }));

  const st = () => ((P.chapter(id).quiz ??= {})[n] ??= {});
  let picked: string[] = [...(P.chapter(id).quiz?.[n]?.picked ?? [])];

  const check = el('button', { class: 'quiz-btn primary', type: 'button', textContent: 'Проверить' });
  const show = el('button', { class: 'quiz-btn', type: 'button', textContent: 'Показать ответ' });
  const knew = el('button', { class: 'quiz-btn good', type: 'button', textContent: '✓ Знал' });
  const didnt = el('button', { class: 'quiz-btn bad', type: 'button', textContent: '✗ Не знал' });
  const again = el('button', { class: 'quiz-btn ghost', type: 'button', textContent: 'Ещё раз' });
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
        actions.append(check, el('span', { class: 'quiz-hint', textContent: key.length > 1 ? 'Несколько правильных вариантов' : '' }));
      } else {
        const ok = sameSet(s.picked ?? [], key);
        verdict.textContent = !s.picked?.length ? 'Ответ открыт без попытки' : ok ? 'Верно' : 'Неверно';
        verdict.className = `quiz-verdict ${s.picked?.length ? (ok ? 'good' : 'bad') : ''}`;
        q.classList.add(ok ? 'is-correct' : 'is-wrong');
        actions.append(verdict, again);
      }
    } else if (!revealed) {
      actions.append(show, el('span', { class: 'quiz-hint', textContent: 'Сначала ответь сам: вслух или в заметках' }));
    } else {
      if (s.self) {
        verdict.textContent = s.self === 'yes' ? 'Знал' : 'Не знал — вернись к теории';
        verdict.className = `quiz-verdict ${s.self === 'yes' ? 'good' : 'bad'}`;
        q.classList.add(s.self === 'yes' ? 'is-correct' : 'is-wrong');
        actions.append(verdict, again);
      } else {
        actions.append(el('span', { class: 'quiz-hint', textContent: 'Сравни со своим ответом:' }), knew, didnt);
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
    counter.textContent = `Выполнено ${done} из ${inputs.length}`;
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
      const t = e.target as HTMLElement;
      if (t === inp || t.closest('a, code, button')) return;
      inp.click();
    });
  });
  render();
  P.onChange(render);
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
      el('li', {}, `«Готово, когда»: ${checks} из ${inputs.length}`),
      el('li', {}, `Тест: ${quiz.answered} из ${quiz.total} отвечено, верно ${quiz.correct}`),
    );
    const btn = el('button', { type: 'button', class: `quiz-btn ${ch.done ? 'ghost' : 'primary'}` });
    btn.textContent = ch.done ? 'Снять отметку' : 'Отметить главу пройденной';
    btn.addEventListener('click', () => {
      if (ch.done) delete ch.done;
      else ch.done = new Date().toISOString();
      P.save();
    });
    const title = ch.done
      ? `✓ Глава пройдена ${new Date(ch.done).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' })}`
      : 'Закончил главу?';
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

function bar(done: number, total: number) {
  const pct = total ? Math.round((done / total) * 100) : 0;
  const fill = el('span', { class: 'progress-fill' });
  fill.style.width = `${pct}%`;
  return el('span', { class: 'progress-bar', role: 'progressbar', ariaValueNow: String(pct), ariaValueMin: '0', ariaValueMax: '100' }, fill);
}

function initIndex() {
  const overall = document.querySelector<HTMLElement>('.course-progress');
  if (!overall) return;
  const render = () => {
    const done = (id: string) => !!P.get().chapters[id]?.done;
    const total = chapters.length;
    const n = chapters.filter((c) => done(c.id)).length;
    const next = chapters.find((c) => !done(c.id));
    const exp = el('button', { type: 'button', class: 'quiz-btn ghost', textContent: 'Экспорт прогресса' });
    const imp = el('button', { type: 'button', class: 'quiz-btn ghost', textContent: 'Импорт' });
    exp.addEventListener('click', exportProgress);
    imp.addEventListener('click', importProgress);
    overall.replaceChildren(
      el('div', { class: 'course-progress-head' },
        el('strong', {}, `Пройдено ${n} из ${total} ${plural(total, 'главы', 'глав', 'глав')}`),
        el('span', { class: 'storage-note', textContent: P.storage === 'file' ? `Сохраняется в ${P.storagePath || 'файл прогресса'}` : 'Сохраняется только в этом браузере' }),
      ),
      bar(n, total),
      el('div', { class: 'course-progress-actions' },
        ...(next ? [el('a', { class: 'quiz-btn primary', href: next.href, textContent: n ? `Продолжить: ${next.num} · ${next.title}` : `Начать: ${next.num} · ${next.title}` })] : [el('span', {}, 'Все главы пройдены 🎉')]),
        exp, imp,
      ),
    );
    for (const card of $$<HTMLElement>('.week-card')) {
      const week = +card.dataset.week!;
      const list = chapters.filter((c) => c.week === week);
      const d = list.filter((c) => done(c.id)).length;
      const slot = card.querySelector<HTMLElement>('.week-progress');
      if (list.length) slot?.replaceChildren(bar(d, list.length), el('span', { class: 'week-progress-label', textContent: `${d}/${list.length}` }));
      card.classList.toggle('complete', list.length > 0 && d === list.length);
    }
  };
  render();
  P.onChange(render);
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
      if (!data?.chapters) throw new Error('нет поля chapters');
      if (!confirm('Заменить текущий прогресс данными из файла?')) return;
      P.replaceAll(data);
      location.reload();
    } catch (e) {
      alert(`Не получилось прочитать файл: ${(e as Error).message}`);
    }
  });
  input.click();
}

// ---------------- mermaid ----------------
const mermaidConfig = (dark: boolean) => ({
  startOnLoad: false,
  theme: dark ? 'dark' : 'neutral',
  securityLevel: 'strict' as const,
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

// ---------------- boot ----------------
async function boot() {
  void initMermaid();
  await P.load();
  $$<HTMLElement>('.quiz').forEach(initQuiz);
  $$<HTMLElement>('.done-list').forEach(initChecklist);
  $$<HTMLElement>('.chapter-done').forEach(initChapterDone);
  initIndex();
  markLinks();
  P.onChange(markLinks);
  document.documentElement.classList.add('progress-ready');
}

void boot();
