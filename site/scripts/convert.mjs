// Converts ../book/*.md and ../README.md into Starlight pages.
// Source of truth stays in book/; everything under src/content/docs is generated.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SITE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ROOT = path.resolve(SITE, '..');
const BOOK = path.join(ROOT, 'book');
const OUT = path.join(SITE, 'src/content/docs');

const warnings = [];
const stats = { chapters: 0, questions: 0, choice: 0, choiceWithKey: 0, checks: 0, mermaid: 0 };

// ---------- table of contents ----------
function parseToc() {
  const weeks = [];
  for (const line of fs.readFileSync(path.join(BOOK, 'README.md'), 'utf8').split('\n')) {
    let m;
    if ((m = line.match(/^## Неделя (\d+) · (.+)$/))) {
      weeks.push({ n: +m[1], title: m[2].trim(), items: [] });
    } else if ((m = line.match(/^- \[(\d+)\.(\d+) · (.+?)\]\(AIL-(\d+)\.md\)/))) {
      weeks.at(-1).items.push({ num: `${m[1]}.${m[2]}`, title: m[3], ail: +m[4] });
    } else if ((m = line.match(/^- (\d+)\.(\d+) · (.+?) _\(без отдельной главы\)_/))) {
      weeks.at(-1).items.push({ num: `${m[1]}.${m[2]}`, title: m[3], noPage: true });
    }
  }
  return weeks;
}

const weeks = parseToc();
const byAil = new Map();
for (const w of weeks) {
  for (const it of w.items) {
    if (it.noPage) continue;
    it.week = w.n;
    it.id = it.num.replace('.', '-');
    it.slug = `week-${String(w.n).padStart(2, '0')}/${it.id}`;
    it.href = `/${it.slug}/`;
    byAil.set(it.ail, it);
  }
}

// ---------- helpers ----------
const FENCE = /^(\s*)(`{3,}|~{3,})(.*)$/;

/** Split text into lines tagged with whether they are inside a fenced code block. */
function tagLines(text) {
  const out = [];
  let open = null;
  for (const line of text.split('\n')) {
    const m = line.match(FENCE);
    if (!open && m) {
      open = m[2];
      out.push({ line, code: true, fenceStart: true, info: m[3].trim(), indent: m[1] });
    } else if (open && m && m[2][0] === open[0] && m[2].length >= open.length && !m[3].trim()) {
      open = null;
      out.push({ line, code: true, fenceEnd: true });
    } else {
      out.push({ line, code: !!open });
    }
  }
  return out;
}

/** Apply fn to text segments outside inline code spans. */
function outsideInlineCode(line, fn) {
  return line
    .split(/(`+[^`]*`+)/)
    .map((part, i) => (i % 2 ? part : fn(part)))
    .join('');
}

function chapterLink(ail) {
  const it = byAil.get(+ail);
  if (!it) warnings.push(`unknown chapter reference AIL-${ail}`);
  return it;
}

function rewriteLinks(line) {
  return outsideInlineCode(line, (s) =>
    s
      // [text](AIL-N.md#anchor)
      .replace(/\]\(AIL-(\d+)\.md(#[^)]*)?\)/g, (all, n, hash = '') => {
        const it = chapterLink(n);
        return it ? `](${it.href}${hash})` : all;
      })
      .replace(/\]\((?:\.\/)?book\/README\.md\)/g, '](/)')
      .replace(/\]\((?:\.\/)?README\.md\)/g, '](/plan/)')
      // "1.2 · Title (AIL-56)" -> link on the title
      .replace(/(\d+\.\d+ · [^()\[\]]+?)\s+\(AIL-(\d+)\)(?!\])/g, (all, label, n) => {
        const it = chapterLink(n);
        return it ? `[${label.trim()}](${it.href})` : all;
      })
      // link text starting with AIL-N: "[AIL-19 · Chunking](...)" -> "[4.3 · Chunking](...)"
      .replace(/\[AIL-(\d+)(?=[^\]]*\]\()/g, (all, n) => {
        const it = chapterLink(n);
        return it ? `[${it.num}` : all;
      })
      // bare AIL-N not already inside a link target
      .replace(/(?<![\[/\w-])AIL-(\d+)(?!\d|\.md)/g, (all, n) => {
        const it = chapterLink(n);
        return it ? `[гл. ${it.num}](${it.href})` : all;
      }),
  );
}

const escapeHtml = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Generic body transform: links outside code, mermaid fences to <pre class="mermaid">. */
function transformBody(text) {
  const tagged = tagLines(text);
  const out = [];
  for (let i = 0; i < tagged.length; i++) {
    const t = tagged[i];
    if (t.fenceStart && t.info === 'mermaid') {
      const body = [];
      i++;
      while (i < tagged.length && !tagged[i].fenceEnd) body.push(tagged[i++].line);
      stats.mermaid++;
      out.push(`<pre class="mermaid">${escapeHtml(body.join('\n'))}</pre>`);
      continue;
    }
    out.push(t.code ? t.line : rewriteLinks(t.line));
  }
  return out.join('\n');
}

/** Split markdown into top-level "## " sections (fence-aware). */
function splitSections(text) {
  const sections = [{ heading: null, lines: [] }];
  for (const t of tagLines(text)) {
    const m = !t.code && t.line.match(/^## (.+)$/);
    if (m) sections.push({ heading: m[1].trim(), lines: [] });
    else sections.at(-1).lines.push(t.line);
  }
  return sections;
}

/** Split a numbered list section into items {n, lines} (fence-aware, top-level numbers only). */
function splitNumbered(lines) {
  const items = [];
  const pre = [];
  for (const t of tagLines(lines.join('\n'))) {
    const m = !t.code && t.line.match(/^(\d+)\.\s+(.*)$/);
    if (m) items.push({ n: +m[1], lines: [m[2]] });
    else if (items.length) items.at(-1).lines.push(t.line);
    else pre.push(t.line);
  }
  for (const it of items) {
    const rest = it.lines.slice(1);
    const indents = rest.filter((l) => l.trim()).map((l) => l.match(/^ */)[0].length);
    const cut = indents.length ? Math.min(...indents) : 0;
    it.lines = [it.lines[0], ...rest.map((l) => l.slice(Math.min(cut, l.match(/^ */)[0].length)))];
    while (it.lines.length && !it.lines.at(-1).trim()) it.lines.pop();
  }
  return { pre, items };
}

const OPT_INLINE = /(?:^|[;,]?\s+)([a-d])\)\s+/g;

/** Extract a) b) c) d) options from question lines. */
function extractOptions(lines) {
  const tagged = tagLines(lines.join('\n'));
  // multi-line form: consecutive lines "a) ..." / "- a) ..."
  const idx = tagged.findIndex((t) => !t.code && /^\s*(?:- )?a\)\s/.test(t.line));
  if (idx === -1) {
    // inline on the question line: "Question? a) x b) y c) z"
    const first = lines[0];
    const m = first.match(/\s(a\)\s.*\sb\)\s.*)$/);
    if (!m) return null;
    const options = splitInline(m[1]);
    if (!options) return null;
    return { question: [first.slice(0, m.index).trim(), ...lines.slice(1)], options };
  }
  const line = tagged[idx].line;
  if (/\sb\)\s/.test(line)) {
    const options = splitInline(line.trim());
    if (!options) return null;
    const q = lines.filter((_, i) => i !== idx);
    return { question: q, options };
  }
  const options = [];
  let j = idx;
  while (j < tagged.length) {
    const m = tagged[j].line.match(/^\s*(?:- )?([a-d])\)\s+(.*)$/);
    if (!m) break;
    options.push({ key: m[1], text: m[2].trim() });
    j++;
  }
  if (options.length < 2) return null;
  return { question: lines.filter((_, i) => i < idx || i >= j), options };
}

function splitInline(s) {
  const parts = [];
  let m;
  const re = new RegExp(OPT_INLINE.source, 'g');
  const marks = [];
  // only split outside inline code
  const masked = s.replace(/`[^`]*`/g, (c) => 'x'.repeat(c.length));
  while ((m = re.exec(masked))) marks.push({ key: m[1], start: m.index, textStart: m.index + m[0].length });
  if (marks.length < 2 || marks[0].key !== 'a') return null;
  for (let i = 0; i < marks.length; i++) {
    const end = i + 1 < marks.length ? marks[i + 1].start : s.length;
    parts.push({ key: marks[i].key, text: s.slice(marks[i].textStart, end).trim().replace(/[;,]$/, '') });
  }
  return parts;
}

/** Find the correct option letter(s) at the start of an answer. */
function answerKey(answerLines) {
  const first = answerLines[0] ?? '';
  const m = first.match(/^\**\s*([a-d](?:\s*(?:,|и)\s*[a-d])*)\s*[.):]?\**\s*[.):]?/);
  if (!m || !/^\**\s*[a-d]\s*(?:[,и]\s*[a-d](?![A-Za-z])\s*)*[.):*,]/.test(first)) return null;
  return [...m[1].matchAll(/[a-d]/g)].map((x) => x[0]);
}

function buildQuiz(chapterId, testLines, answerLines) {
  const tests = splitNumbered(testLines);
  const answers = splitNumbered(answerLines);
  const answerMap = new Map(answers.items.map((a) => [a.n, a.lines]));
  if (tests.items.length !== answers.items.length) {
    warnings.push(`${chapterId}: ${tests.items.length} questions vs ${answers.items.length} answers`);
  }
  const out = [];
  if (tests.pre.join('').trim()) out.push(tests.pre.join('\n').trim(), '');
  out.push(`<div class="quiz" data-chapter="${chapterId}">`, '');
  for (const q of tests.items) {
    stats.questions++;
    const ans = answerMap.get(q.n);
    if (!ans) warnings.push(`${chapterId}: no answer for question ${q.n}`);
    const opts = extractOptions(q.lines);
    const key = opts && ans ? answerKey(ans) : null;
    if (opts) stats.choice++;
    if (key) stats.choiceWithKey++;
    if (opts && !key) warnings.push(`${chapterId} q${q.n}: options but no answer letter: "${(ans?.[0] ?? '').slice(0, 40)}"`);
    const attrs = [`data-n="${q.n}"`, key ? `data-correct="${key.join(',')}"` : ''].filter(Boolean).join(' ');
    out.push(`<section class="quiz-q" ${attrs}>`, '', `<p class="quiz-q-num">Вопрос ${q.n}</p>`, '');
    out.push(...(opts ? opts.question : q.lines), '');
    if (opts) {
      out.push('<div class="quiz-options">', '');
      for (const o of opts.options) out.push(`- **${o.key})** ${o.text}`);
      out.push('', '</div>', '');
    }
    out.push('<div class="quiz-answer" data-pagefind-ignore>', '');
    out.push(...(ans ?? ['_Ответа нет в исходнике._']), '');
    out.push('</div>', '', '</section>', '');
  }
  out.push('</div>');
  return out.join('\n');
}

function buildChecklist(chapterId, lines) {
  let i = 0;
  const conv = tagLines(lines.join('\n')).map((t) => {
    if (!t.code && /^[-*] (?!\[[ x]\])/.test(t.line)) {
      stats.checks++;
      return t.line.replace(/^([-*]) /, `$1 [ ] `);
    }
    return t.line;
  });
  return [`<div class="done-list" data-chapter="${chapterId}">`, '', conv.join('\n').trim(), '', '</div>'].join('\n');
}

const yamlStr = (s) => JSON.stringify(s);

function convertChapter(it, prev, next) {
  const src = fs.readFileSync(path.join(BOOK, `AIL-${it.ail}.md`), 'utf8');
  const h1 = src.match(/^# (.+)$/m);
  const title = h1 ? h1[1].replace(/\s*\(AIL-\d+\)\s*$/, '').trim() : `${it.num} · ${it.title}`;
  const body = h1 ? src.replace(h1[0], '') : src;
  const sections = splitSections(body);
  const test = sections.find((s) => s.heading === 'Тест для самопроверки');
  const answers = sections.find((s) => s.heading === 'Ответы');
  const parts = [];
  for (const s of sections) {
    if (s === answers && test) continue;
    if (s.heading) parts.push(`## ${s.heading}`);
    if (s === test && answers) parts.push(buildQuiz(it.id, s.lines, answers.lines));
    else if (s.heading === 'Готово, когда') parts.push(buildChecklist(it.id, s.lines));
    else parts.push(s.lines.join('\n').trim());
    parts.push('');
  }
  if (!test || !answers) warnings.push(`${it.id}: missing test or answers section`);
  parts.push(`<div class="chapter-done" data-chapter="${it.id}"></div>`);
  const fm = [
    '---',
    `title: ${yamlStr(title)}`,
    `description: ${yamlStr(`Неделя ${it.week} · ${it.title}`)}`,
    `editUrl: false`,
    prev ? `prev: { link: ${yamlStr(prev.href)}, label: ${yamlStr(`${prev.num} · ${prev.title}`)} }` : 'prev: false',
    next ? `next: { link: ${yamlStr(next.href)}, label: ${yamlStr(`${next.num} · ${next.title}`)} }` : 'next: false',
    '---',
    '',
    `<!-- Generated from book/AIL-${it.ail}.md by scripts/convert.mjs. Edit the source, not this file. -->`,
    '',
  ].join('\n');
  const file = path.join(OUT, `${it.slug}.md`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, fm + transformBody(parts.join('\n')).replace(/\n{3,}/g, '\n\n'));
  stats.chapters++;
}

function convertPlan() {
  const src = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
  const h1 = src.match(/^# (.+)$/m);
  const body = src
    .replace(h1[0], '')
    // the "Сайт учебника" section is for the repo README only
    .replace(/^## Сайт учебника\n[\s\S]*?(?=^## )/m, '')
    .replace(/ · сайт учебника — см\. раздел «Сайт учебника» ниже/, '')
    .replace(/\]\(book\/AIL-(\d+)\.md/g, '](AIL-$1.md');
  const fm = ['---', `title: ${yamlStr(h1[1].trim())}`, 'editUrl: false', '---', ''].join('\n');
  fs.writeFileSync(path.join(OUT, 'plan.md'), fm + transformBody(body));
}

function convertIndex() {
  const lines = [
    '---',
    'title: Учебник AI-инженера',
    'description: Главы по неделям, теория, практика и тесты для самопроверки.',
    'editUrl: false',
    'tableOfContents: false',
    'prev: false',
    `next: { link: ${yamlStr(weeks[0].items[0].href)}, label: ${yamlStr(`${weeks[0].items[0].num} · ${weeks[0].items[0].title}`)} }`,
    '---',
    '',
    'Главы по порядку прохождения: номер = неделя.порядок. Общий план и график — на странице [План курса](/plan/).',
    '',
    '<div class="course-progress"></div>',
    '',
  ];
  for (const w of weeks) {
    lines.push(`<section class="week-card" data-week="${w.n}">`, '', `### Неделя ${w.n} · ${w.title}`, '');
    lines.push('<div class="week-progress"></div>', '');
    for (const it of w.items) {
      if (it.noPage) lines.push(`- ${it.num} · ${it.title}`);
      else lines.push(`- [${it.num} · ${it.title}](${it.href})`);
    }
    lines.push('', '</section>', '');
  }
  fs.writeFileSync(path.join(OUT, 'index.md'), lines.join('\n'));
}

function writeSidebar() {
  const sidebar = [
    { label: 'Оглавление', link: '/' },
    { label: 'План курса', link: '/plan/' },
    // weeks without chapter pages (e.g. the spare week) appear only on the index page
    ...weeks
      .filter((w) => w.items.some((it) => !it.noPage))
      .map((w) => ({
        label: `Неделя ${w.n} · ${w.title}`,
        collapsed: true,
        items: w.items
          .filter((it) => !it.noPage)
          .map((it) => ({ label: `${it.num} · ${it.title}`, link: it.href, attrs: { 'data-chapter': it.id } })),
      })),
  ];
  fs.writeFileSync(path.join(SITE, 'src/sidebar.json'), JSON.stringify(sidebar, null, 2));
  const chapters = weeks.flatMap((w) => w.items.filter((i) => !i.noPage).map((i) => ({ id: i.id, week: w.n, num: i.num, title: i.title, href: i.href })));
  fs.writeFileSync(path.join(SITE, 'src/chapters.json'), JSON.stringify(chapters, null, 2));
}

// ---------- run ----------
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });
const flat = weeks.flatMap((w) => w.items.filter((i) => !i.noPage));
flat.forEach((it, i) => convertChapter(it, flat[i - 1], flat[i + 1]));
const missing = fs.readdirSync(BOOK).filter((f) => /^AIL-\d+\.md$/.test(f) && !byAil.has(+f.match(/\d+/)[0]));
if (missing.length) warnings.push(`files not in book/README.md: ${missing.join(', ')}`);
convertPlan();
convertIndex();
writeSidebar();
console.log(`convert: ${stats.chapters} chapters, ${stats.questions} questions (${stats.choice} multiple-choice, ${stats.choiceWithKey} with answer key), ${stats.checks} checklist items, ${stats.mermaid} diagrams`);
if (warnings.length) console.log(`convert: ${warnings.length} warnings\n  ` + [...new Set(warnings)].join('\n  '));
