// Converts the book chapters and the root README.md into Starlight pages.
// Source of truth stays in the book directory; everything under the docs directory is generated.
// All Russian text (site wording and the headings used to parse the book) lives in src/locales/ru.json.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BOOK_DIR, CHAPTER_PREFIX, CHAPTERS_FILE, DOCS_DIR, PLAN_PATH, REPO_ONLY_END, REPO_ONLY_START, SIDEBAR_FILE } from '../src/config/app.mjs';
import { escapeRegExp, format } from '../src/locales/format.mjs';
import strings from '../src/locales/ru.json' with { type: 'json' };

const SITE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ROOT = path.resolve(SITE, '..');
const BOOK = path.join(ROOT, BOOK_DIR);
const OUT = path.join(SITE, DOCS_DIR);

const { site, book } = strings;
const weekLabel = (n, title) => format(site.week, { n, title });
const chapterFile = (n) => `${CHAPTER_PREFIX}${n}.md`;

// Patterns built from the configurable chapter prefix and the book's own headings.
const PREFIX = escapeRegExp(CHAPTER_PREFIX);
const RE = {
  tocWeek: new RegExp(`^## ${escapeRegExp(book.weekHeading)} (\\d+) · (.+)$`),
  tocChapter: new RegExp(`^- \\[(\\d+)\\.(\\d+) · (.+?)\\]\\(${PREFIX}(\\d+)\\.md\\)`),
  tocNoPage: new RegExp(`^- (\\d+)\\.(\\d+) · (.+?) _\\(${escapeRegExp(book.noChapterNote)}\\)_`),
  // [text](AIL-N.md#anchor)
  fileLink: new RegExp(`\\]\\(${PREFIX}(\\d+)\\.md(#[^)]*)?\\)`, 'g'),
  // "1.2 · Title (AIL-56)"
  // the title may hold one level of parentheses: "9.5 · MCP-сервер (только чтение) (AIL-39)"
  titledRef: new RegExp(`(\\d+\\.\\d+ · (?:[^()\\[\\]]|\\([^()\\[\\]]*\\))+?)\\s+\\(${PREFIX}(\\d+)\\)(?!\\])`, 'g'),
  // link text starting with the chapter code: "[AIL-19 · Chunking](...)"
  linkText: new RegExp(`\\[${PREFIX}(\\d+)(?=[^\\]]*\\]\\()`, 'g'),
  // bare AIL-N not already inside a link target
  bareRef: new RegExp(`(?<![\\[/\\w-])${PREFIX}(\\d+)(?!\\d|\\.md)`, 'g'),
  titleSuffix: new RegExp(`\\s*\\(${PREFIX}\\d+\\)\\s*$`),
  chapterFile: new RegExp(`^${PREFIX}(\\d+)\\.md$`),
  planBookLink: new RegExp(`\\]\\(${escapeRegExp(BOOK_DIR)}/${PREFIX}(\\d+)\\.md`, 'g'),
  bookReadmeLink: new RegExp(`\\]\\((?:\\./)?${escapeRegExp(BOOK_DIR)}/README\\.md\\)`, 'g'),
  repoOnly: new RegExp(`${escapeRegExp(REPO_ONLY_START)}[\\s\\S]*?${escapeRegExp(REPO_ONLY_END)}\\n*`, 'g'),
  // option letters at the start of an answer: "b)", "a, c.", "a <and> c:"
  answerLetters: new RegExp(`^\\**\\s*([a-d](?:\\s*(?:,|${escapeRegExp(book.and)})\\s*[a-d])*)\\s*[.):]?\\**\\s*[.):]?`),
  answerStart: new RegExp(`^\\**\\s*[a-d]\\s*(?:(?:,|${escapeRegExp(book.and)})\\s*[a-d](?![A-Za-z])\\s*)*[.):*,]`),
};

const warnings = [];
const stats = { chapters: 0, questions: 0, choice: 0, choiceWithKey: 0, checks: 0, mermaid: 0 };

// ---------- table of contents ----------
function parseToc() {
  const weeks = [];
  for (const line of fs.readFileSync(path.join(BOOK, 'README.md'), 'utf8').split('\n')) {
    let m;
    if ((m = line.match(RE.tocWeek))) {
      weeks.push({ n: +m[1], title: m[2].trim(), items: [] });
    } else if ((m = line.match(RE.tocChapter))) {
      weeks.at(-1).items.push({ num: `${m[1]}.${m[2]}`, title: m[3], ail: +m[4] });
    } else if ((m = line.match(RE.tocNoPage))) {
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
  if (!it) warnings.push(`unknown chapter reference ${CHAPTER_PREFIX}${ail}`);
  return it;
}

function rewriteLinks(line) {
  return outsideInlineCode(line, (s) =>
    s
      .replace(RE.fileLink, (all, n, hash = '') => {
        const it = chapterLink(n);
        return it ? `](${it.href}${hash})` : all;
      })
      .replace(RE.bookReadmeLink, '](/)')
      .replace(/\]\((?:\.\/)?README\.md\)/g, `](${PLAN_PATH})`)
      // "1.2 · Title (AIL-56)" -> link on the title
      .replace(RE.titledRef, (all, label, n) => {
        const it = chapterLink(n);
        return it ? `[${label.trim()}](${it.href})` : all;
      })
      // "[AIL-19 · Chunking](...)" -> "[4.3 · Chunking](...)"
      .replace(RE.linkText, (all, n) => {
        const it = chapterLink(n);
        return it ? `[${it.num}` : all;
      })
      .replace(RE.bareRef, (all, n) => {
        const it = chapterLink(n);
        return it ? `[${format(site.chapterRef, { num: it.num })}](${it.href})` : all;
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
  const m = first.match(RE.answerLetters);
  if (!m || !RE.answerStart.test(first)) return null;
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
    out.push(`<section class="quiz-q" ${attrs}>`, '', `<p class="quiz-q-num">${format(site.questionLabel, { n: q.n })}</p>`, '');
    out.push(...(opts ? opts.question : q.lines), '');
    if (opts) {
      out.push('<div class="quiz-options">', '');
      for (const o of opts.options) out.push(`- **${o.key})** ${o.text}`);
      out.push('', '</div>', '');
    }
    out.push('<div class="quiz-answer" data-pagefind-ignore>', '');
    out.push(...(ans ?? [site.noAnswer]), '');
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
  const src = fs.readFileSync(path.join(BOOK, chapterFile(it.ail)), 'utf8');
  const h1 = src.match(/^# (.+)$/m);
  const title = h1 ? h1[1].replace(RE.titleSuffix, '').trim() : `${it.num} · ${it.title}`;
  const body = h1 ? src.replace(h1[0], '') : src;
  const sections = splitSections(body);
  const test = sections.find((s) => s.heading === book.testHeading);
  const answers = sections.find((s) => s.heading === book.answersHeading);
  const parts = [];
  for (const s of sections) {
    if (s === answers && test) continue;
    if (s.heading) parts.push(`## ${s.heading}`);
    if (s === test && answers) parts.push(buildQuiz(it.id, s.lines, answers.lines));
    else if (s.heading === book.doneHeading) parts.push(buildChecklist(it.id, s.lines));
    else parts.push(s.lines.join('\n').trim());
    parts.push('');
  }
  if (!test || !answers) warnings.push(`${it.id}: missing test or answers section`);
  parts.push(`<div class="chapter-done" data-chapter="${it.id}"></div>`);
  const fm = [
    '---',
    `title: ${yamlStr(title)}`,
    `description: ${yamlStr(weekLabel(it.week, it.title))}`,
    `editUrl: false`,
    prev ? `prev: { link: ${yamlStr(prev.href)}, label: ${yamlStr(`${prev.num} · ${prev.title}`)} }` : 'prev: false',
    next ? `next: { link: ${yamlStr(next.href)}, label: ${yamlStr(`${next.num} · ${next.title}`)} }` : 'next: false',
    '---',
    '',
    `<!-- Generated from ${BOOK_DIR}/${chapterFile(it.ail)} by scripts/convert.mjs. Edit the source, not this file. -->`,
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
    // repo-only blocks (e.g. the pointer to site/README.md) are not part of the plan page
    .replace(RE.repoOnly, '')
    .replace(RE.planBookLink, `](${CHAPTER_PREFIX}$1.md`);
  const fm = ['---', `title: ${yamlStr(h1[1].trim())}`, 'editUrl: false', '---', ''].join('\n');
  fs.writeFileSync(path.join(OUT, `${PLAN_PATH.replaceAll('/', '')}.md`), fm + transformBody(body));
}

function convertIndex() {
  const lines = [
    '---',
    `title: ${yamlStr(site.indexTitle)}`,
    `description: ${yamlStr(site.indexDescription)}`,
    'editUrl: false',
    'tableOfContents: false',
    'prev: false',
    `next: { link: ${yamlStr(weeks[0].items[0].href)}, label: ${yamlStr(`${weeks[0].items[0].num} · ${weeks[0].items[0].title}`)} }`,
    '---',
    '',
    format(site.indexIntro, { planLabel: site.planLabel, planPath: PLAN_PATH }),
    '',
    '<div class="course-progress"></div>',
    '',
  ];
  for (const w of weeks) {
    lines.push(`<section class="week-card" data-week="${w.n}">`, '', `### ${weekLabel(w.n, w.title)}`, '');
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
    { label: site.tocLabel, link: '/' },
    { label: site.planLabel, link: PLAN_PATH },
    // weeks without chapter pages (e.g. the spare week) appear only on the index page
    ...weeks
      .filter((w) => w.items.some((it) => !it.noPage))
      .map((w) => ({
        label: weekLabel(w.n, w.title),
        collapsed: true,
        items: w.items
          .filter((it) => !it.noPage)
          .map((it) => ({ label: `${it.num} · ${it.title}`, link: it.href, attrs: { 'data-chapter': it.id } })),
      })),
  ];
  fs.writeFileSync(path.join(SITE, SIDEBAR_FILE), JSON.stringify(sidebar, null, 2));
  const chapters = weeks.flatMap((w) => w.items.filter((i) => !i.noPage).map((i) => ({ id: i.id, week: w.n, num: i.num, title: i.title, href: i.href })));
  fs.writeFileSync(path.join(SITE, CHAPTERS_FILE), JSON.stringify(chapters, null, 2));
}

// ---------- run ----------
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });
const flat = weeks.flatMap((w) => w.items.filter((i) => !i.noPage));
flat.forEach((it, i) => convertChapter(it, flat[i - 1], flat[i + 1]));
const missing = fs.readdirSync(BOOK).filter((f) => RE.chapterFile.test(f) && !byAil.has(+f.match(RE.chapterFile)[1]));
if (missing.length) warnings.push(`files not in ${BOOK_DIR}/README.md: ${missing.join(', ')}`);
convertPlan();
convertIndex();
writeSidebar();
console.log(`convert: ${stats.chapters} chapters, ${stats.questions} questions (${stats.choice} multiple-choice, ${stats.choiceWithKey} with answer key), ${stats.checks} checklist items, ${stats.mermaid} diagrams`);
if (warnings.length) console.log(`convert: ${warnings.length} warnings\n  ` + [...new Set(warnings)].join('\n  '));
