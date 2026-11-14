// Pure Markdown → Starlight rendering used by scripts/convert.mjs: strings in, strings out, no file access.
// Kept separate from convert.mjs so it can be unit-tested (tests/render.test.mjs).
// All Russian text (site wording and the headings used to parse the book) lives in src/locales/ru.json.
import {
  BOOK_DIR, CHAPTER_PREFIX, DESCRIPTION_MARKER, DESCRIPTION_MAX_LENGTH, OAUTH_COOKIE, OAUTH_COOKIE_TTL_SECONDS, PLAN_PATH,
  PRIVACY_CONTACT, PRIVACY_POLICY_DATE, QUESTION_ANCHOR_PREFIX, QUESTION_PREVIEW_MAX_LENGTH, REPO_ONLY_END,
  REPO_ONLY_START, REVIEW_PATH, SESSION_COOKIE, SESSION_TTL_SECONDS, STORAGE_KEY, SYNC_STORAGE_KEY, THEME_STORAGE_KEY,
} from '../../src/config/app.mjs';
import { escapeRegExp, format, plural } from '../../src/locales/format.mjs';
import strings from '../../src/locales/ru.json' with { type: 'json' };

const { site, book, ui } = strings;
export const weekLabel = (n, title) => format(site.week, { n, title });
export const chapterFile = (n) => `${CHAPTER_PREFIX}${n}.md`;

// Patterns built from the configurable chapter prefix and the book's own headings.
const PREFIX = escapeRegExp(CHAPTER_PREFIX);
export const RE = {
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
  // <!-- description: … --> line of a chapter, with its line break
  description: new RegExp(`^<!--\\s*${escapeRegExp(DESCRIPTION_MARKER)}\\s*(.*?)\\s*-->[ \\t]*\\n?`, 'gm'),
  repoOnly: new RegExp(`${escapeRegExp(REPO_ONLY_START)}[\\s\\S]*?${escapeRegExp(REPO_ONLY_END)}\\n*`, 'g'),
  // option letters at the start of an answer: "b)", "a, c.", "a <and> c:"
  answerLetters: new RegExp(`^\\**\\s*([a-d](?:\\s*(?:,|${escapeRegExp(book.and)})\\s*[a-d])*)\\s*[.):]?\\**\\s*[.):]?`),
  answerStart: new RegExp(`^\\**\\s*[a-d]\\s*(?:(?:,|${escapeRegExp(book.and)})\\s*[a-d](?![A-Za-z])\\s*)*[.):*,]`),
};

// ---------- table of contents ----------

/** Parse book/README.md into weeks; chapters with a page get id, slug and href. */
export function parseToc(text) {
  const weeks = [];
  for (const line of text.split('\n')) {
    let m;
    if ((m = line.match(RE.tocWeek))) {
      weeks.push({ n: +m[1], title: m[2].trim(), items: [] });
    } else if ((m = line.match(RE.tocChapter))) {
      weeks.at(-1).items.push({ num: `${m[1]}.${m[2]}`, title: m[3], ail: +m[4] });
    } else if ((m = line.match(RE.tocNoPage))) {
      weeks.at(-1).items.push({ num: `${m[1]}.${m[2]}`, title: m[3], noPage: true });
    }
  }
  for (const w of weeks) {
    for (const it of w.items) {
      if (it.noPage) continue;
      it.week = w.n;
      it.id = it.num.replace('.', '-');
      it.slug = `week-${String(w.n).padStart(2, '0')}/${it.id}`;
      it.href = `/${it.slug}/`;
    }
  }
  return weeks;
}

/** Chapters that have a page, in reading order. */
export const pagedChapters = (weeks) => weeks.flatMap((w) => w.items.filter((i) => !i.noPage));

// ---------- Markdown helpers ----------
const FENCE = /^(\s*)(`{3,}|~{3,})(.*)$/;

/** Split text into lines tagged with whether they are inside a fenced code block. */
export function tagLines(text) {
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
export function outsideInlineCode(line, fn) {
  return line
    .split(/(`+[^`]*`+)/)
    .map((part, i) => (i % 2 ? part : fn(part)))
    .join('');
}

export const escapeHtml = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// Progress blocks of the index page, rendered in the "nothing done yet" state. src/scripts/main.ts
// (initIndex) fills in the reader's progress in place, so the page does not shift when it loads
// (Cumulative Layout Shift). Class names are the contract between the two.

/** A progress bar at 0%; main.ts sets the fill width and aria-valuenow. */
const progressBarHtml = () =>
  '<span class="progress-bar" role="progressbar" aria-valuenow="0" aria-valuemin="0" aria-valuemax="100"><span class="progress-fill"></span></span>';

/**
 * Course progress block: count, storage note, bar, the first chapter to start from, export and import.
 * One line: a blank line would end the raw HTML block in Markdown.
 * @param {{ num: string, title: string, href: string }[]} chapters chapters that have a page
 */
export function courseProgressHtml(chapters) {
  const total = chapters.length;
  const count = format(ui.courseProgress, { done: 0, total, chapters: plural(strings.lang, total, ui.chaptersOf) });
  const [first] = chapters;
  const start = format(ui.startFrom, { chapter: `${first.num} · ${first.title}` });
  return [
    '<div class="course-progress">',
    '<div class="course-progress-head">',
    `<strong class="course-progress-count">${escapeHtml(count)}</strong>`,
    `<span class="storage-note">${escapeHtml(ui.savedInBrowser)}</span>`,
    '</div>',
    progressBarHtml(),
    '<div class="course-progress-actions">',
    `<a class="quiz-btn primary course-progress-next" href="${first.href}">${escapeHtml(start)}</a>`,
    `<button type="button" class="quiz-btn ghost course-progress-export">${escapeHtml(ui.exportProgress)}</button>`,
    `<button type="button" class="quiz-btn ghost course-progress-import">${escapeHtml(ui.importProgress)}</button>`,
    '</div>',
    // filled by the browser where accounts are available (src/scripts/main.ts, initAccount)
    '<div class="account-box" hidden></div>',
    '</div>',
  ].join('');
}

/**
 * Progress row of a week card: bar and "0/N".
 * @param {number} pages chapters of the week that have a page
 */
export const weekProgressHtml = (pages) =>
  `<div class="week-progress">${progressBarHtml()}<span class="week-progress-label">0/${pages}</span></div>`;

/** Split markdown into top-level "## " sections (fence-aware). */
export function splitSections(text) {
  const sections = [{ heading: null, lines: [] }];
  for (const t of tagLines(text)) {
    const m = !t.code && t.line.match(/^## (.+)$/);
    if (m) sections.push({ heading: m[1].trim(), lines: [] });
    else sections.at(-1).lines.push(t.line);
  }
  return sections;
}

/** Split a numbered list section into items {n, lines} (fence-aware, top-level numbers only). */
export function splitNumbered(lines) {
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

// ---------- quizzes ----------
/** Plain text of a question's first line for the review page: no Markdown, at most QUESTION_PREVIEW_MAX_LENGTH. */
export function questionPreview(line) {
  // odd parts are inline code: kept as is, only the backticks go
  const text = line
    .split('`')
    .map((part, i) => (i % 2 ? part : part
      .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/\*\*|__/g, '')
      .replace(/(^|\W)[*_](\S(?:.*?\S)?)[*_](?=\W|$)/g, '$1$2')))
    .join('')
    .replace(/\s+/g, ' ')
    .trim();
  if (text.length <= QUESTION_PREVIEW_MAX_LENGTH) return text;
  // cut at the last whole word that fits, leaving room for the ellipsis
  const cut = text.slice(0, QUESTION_PREVIEW_MAX_LENGTH);
  return `${cut.slice(0, cut.lastIndexOf(' ')).trimEnd() || cut.slice(0, -1)}…`;
}

const OPT_INLINE = /(?:^|[;,]?\s+)([a-d])\)\s+/g;

/** Extract a) b) c) d) options from question lines; null when the question has none. */
export function extractOptions(lines) {
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

/** Split "a) x b) y c) z" into options, ignoring markers inside inline code. */
export function splitInline(s) {
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

/** Find the correct option letter(s) at the start of an answer; null when there are none. */
export function answerKey(answerLines) {
  const first = answerLines[0] ?? '';
  const m = first.match(RE.answerLetters);
  if (!m || !RE.answerStart.test(first)) return null;
  return [...m[1].matchAll(/[a-d]/g)].map((x) => x[0]);
}

const yamlStr = (s) => JSON.stringify(s);

// ---------- privacy page ----------

/** Sections of the privacy page in order (keys of `privacy.sections` in ru.json); `analytics` only with the beacon. */
export const PRIVACY_SECTIONS = [
  'withoutAccount', 'signIn', 'server', 'cookies', 'hosting', 'analytics', 'sharing', 'retention', 'rights', 'contact',
];

/**
 * The privacy contact as Markdown: an e-mail becomes a mailto: link, an https:// address a link, anything
 * else plain text; empty (not filled in yet) gives the placeholder from ru.json.
 * @param {string} contact
 */
export function contactMarkdown(contact) {
  const value = contact.trim();
  if (!value) return `_${strings.privacy.contactPlaceholder}_`;
  if (/^[^\s@<>()[\]]+@[^\s@<>()[\]]+\.[^\s@<>()[\]]+$/.test(value)) return `[${value}](mailto:${value})`;
  if (/^https:\/\/[^\s<>()[\]]+$/.test(value)) return `[${value}](${value})`;
  return escapeHtml(value).replace(/[\\`*_[\]]/g, '\\$&');
}

/** A YYYY-MM-DD date in words in the site language (day, month name, year), or null when it is not a real date. */
export function longDate(isoDate) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(isoDate)) return null;
  const date = new Date(`${isoDate}T00:00:00Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== isoDate) return null;
  return new Intl.DateTimeFormat(strings.dateLocale, { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' }).format(date);
}

/** Markdown of one section block from ru.json: a string is a paragraph, an array a bulleted list. */
const privacyBlock = (block, vars) =>
  Array.isArray(block) ? block.map((item) => `- ${format(item, vars)}`).join('\n') : format(block, vars);

/**
 * Renderer bound to one table of contents. Collects warnings and stats across all calls,
 * so one renderer is used for one whole build.
 */
export function createRenderer(weeks) {
  const byAil = new Map(pagedChapters(weeks).map((it) => [it.ail, it]));
  /** @type {Record<string, { n: number, text: string, correct?: string[] }[]>} */
  const quizzes = {};
  const warnings = [];
  const stats = { chapters: 0, questions: 0, choice: 0, choiceWithKey: 0, checks: 0, mermaid: 0 };

  function chapterLink(ail) {
    const it = byAil.get(+ail);
    if (!it) warnings.push(`unknown chapter reference ${CHAPTER_PREFIX}${ail}`);
    return it;
  }

  /** Rewrite chapter references and README links in one line, outside inline code. */
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
    const index = (quizzes[chapterId] = []);
    for (const q of tests.items) {
      stats.questions++;
      const ans = answerMap.get(q.n);
      if (!ans) warnings.push(`${chapterId}: no answer for question ${q.n}`);
      const opts = extractOptions(q.lines);
      const key = opts && ans ? answerKey(ans) : null;
      if (opts) stats.choice++;
      if (key) stats.choiceWithKey++;
      if (opts && !key) warnings.push(`${chapterId} q${q.n}: options but no answer letter: "${(ans?.[0] ?? '').slice(0, 40)}"`);
      index.push({ n: q.n, text: questionPreview((opts ? opts.question : q.lines)[0]), ...(key ? { correct: key } : {}) });
      const attrs = [`id="${QUESTION_ANCHOR_PREFIX}${q.n}"`, `data-n="${q.n}"`, key ? `data-correct="${key.join(',')}"` : '']
        .filter(Boolean).join(' ');
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
    const conv = tagLines(lines.join('\n')).map((t) => {
      if (!t.code && /^[-*] (?!\[[ x]\])/.test(t.line)) {
        stats.checks++;
        return t.line.replace(/^([-*]) /, `$1 [ ] `);
      }
      return t.line;
    });
    return [`<div class="done-list" data-chapter="${chapterId}">`, '', conv.join('\n').trim(), '', '</div>'].join('\n');
  }

  /** Take the description comment out of a chapter body; exactly one, non-empty and short enough. */
  function chapterDescription(it, text) {
    const found = [...text.matchAll(RE.description)].map((m) => m[1]);
    const body = text.replace(RE.description, '');
    if (found.length !== 1) {
      warnings.push(`${it.id}: ${found.length ? 'more than one' : 'missing'} description comment`);
      return { body };
    }
    const [description] = found;
    if (!description) warnings.push(`${it.id}: empty description`);
    else if (description.length > DESCRIPTION_MAX_LENGTH) {
      warnings.push(`${it.id}: description is ${description.length} characters, max ${DESCRIPTION_MAX_LENGTH}`);
    }
    return { description: description || undefined, body };
  }

  /** Render one chapter's source into a Starlight page. */
  function renderChapter(src, it, prev, next) {
    const h1 = src.match(/^# (.+)$/m);
    const title = h1 ? h1[1].replace(RE.titleSuffix, '').trim() : `${it.num} · ${it.title}`;
    const { description, body } = chapterDescription(it, h1 ? src.replace(h1[0], '') : src);
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
      `description: ${yamlStr(description ?? weekLabel(it.week, it.title))}`,
      `editUrl: false`,
      prev ? `prev: { link: ${yamlStr(prev.href)}, label: ${yamlStr(`${prev.num} · ${prev.title}`)} }` : 'prev: false',
      next ? `next: { link: ${yamlStr(next.href)}, label: ${yamlStr(`${next.num} · ${next.title}`)} }` : 'next: false',
      '---',
      '',
      `<!-- Generated from ${BOOK_DIR}/${chapterFile(it.ail)} by scripts/convert.mjs. Edit the source, not this file. -->`,
      '',
    ].join('\n');
    stats.chapters++;
    return fm + transformBody(parts.join('\n')).replace(/\n{3,}/g, '\n\n');
  }

  /** Render the root README.md into the plan page. */
  function renderPlan(src) {
    const h1 = src.match(/^# (.+)$/m);
    const body = src
      .replace(h1[0], '')
      // repo-only blocks (e.g. the pointer to site/README.md) are not part of the plan page
      .replace(RE.repoOnly, '')
      .replace(RE.planBookLink, `](${CHAPTER_PREFIX}$1.md`);
    const fm = [
      '---',
      `title: ${yamlStr(h1[1].trim())}`,
      `description: ${yamlStr(site.planDescription)}`,
      'editUrl: false',
      '---',
      '',
    ].join('\n');
    return fm + transformBody(body);
  }

  /** Render the index page: course progress and one card per week. */
  function renderIndex() {
    const first = weeks[0].items[0];
    const lines = [
      '---',
      `title: ${yamlStr(site.indexTitle)}`,
      `description: ${yamlStr(site.indexDescription)}`,
      'editUrl: false',
      'tableOfContents: false',
      // the index is the course itself, not an article (Starlight sets og:type article on every page)
      'head:',
      '  - { tag: meta, attrs: { property: "og:type", content: website } }',
      'prev: false',
      `next: { link: ${yamlStr(first.href)}, label: ${yamlStr(`${first.num} · ${first.title}`)} }`,
      '---',
      '',
      format(site.indexIntro, { planLabel: site.planLabel, planPath: PLAN_PATH }),
      '',
      courseProgressHtml(pagedChapters(weeks)),
      '',
    ];
    for (const w of weeks) {
      lines.push(`<section class="week-card" data-week="${w.n}">`, '', `### ${weekLabel(w.n, w.title)}`, '');
      const pages = w.items.filter((it) => !it.noPage).length;
      if (pages) lines.push(weekProgressHtml(pages), '');
      for (const it of w.items) {
        if (it.noPage) lines.push(`- ${it.num} · ${it.title}`);
        else lines.push(`- [${it.num} · ${it.title}](${it.href})`);
      }
      lines.push('', '</section>', '');
    }
    return lines.join('\n');
  }

  /** Render the review page: a shell that the browser fills from the reader's progress (src/scripts/main.ts). */
  function renderReview() {
    return [
      '---',
      `title: ${yamlStr(site.reviewTitle)}`,
      `description: ${yamlStr(site.reviewDescription)}`,
      'editUrl: false',
      'tableOfContents: false',
      // personal and empty without the reader's progress: nothing for search engines or the site search
      'pagefind: false',
      'head:',
      '  - { tag: meta, attrs: { name: robots, content: noindex } }',
      'prev: false',
      'next: false',
      '---',
      '',
      site.reviewIntro,
      '',
      '<div class="quiz-review" aria-live="polite"></div>',
      '',
    ].join('\n');
  }

  /**
   * Render the privacy policy page from `privacy` in ru.json. Names, lifetimes and storage keys come from
   * src/config/app.mjs, so the text follows the code. The analytics section appears only in builds with the
   * Cloudflare Web Analytics beacon; an empty contact shows a placeholder (fill it in before going live).
   * @param {{ analytics?: boolean, contact?: string, date?: string }} [options]
   */
  function renderPrivacy({ analytics = false, contact = PRIVACY_CONTACT, date = PRIVACY_POLICY_DATE } = {}) {
    const { privacy } = strings;
    const updated = longDate(date);
    if (!updated) warnings.push(`privacy policy date "${date}" is not a YYYY-MM-DD date`);
    const days = SESSION_TTL_SECONDS / (24 * 60 * 60);
    const minutes = OAUTH_COOKIE_TTL_SECONDS / 60;
    const vars = {
      sessionCookie: SESSION_COOKIE,
      oauthCookie: OAUTH_COOKIE,
      sessionTtl: `${days} ${plural(strings.lang, days, privacy.days)}`,
      oauthTtl: `${minutes} ${plural(strings.lang, minutes, privacy.minutes)}`,
      storageKey: STORAGE_KEY,
      syncKey: SYNC_STORAGE_KEY,
      themeKey: THEME_STORAGE_KEY,
      indexPath: '/',
      exportLabel: ui.exportProgress,
      deleteLabel: ui.deleteAccount,
      contact: contactMarkdown(contact),
    };
    const sections = PRIVACY_SECTIONS
      .filter((key) => analytics || key !== 'analytics')
      .flatMap((key) => {
        const section = privacy.sections[key];
        return [`## ${section.heading}`, '', ...section.blocks.flatMap((b) => [privacyBlock(b, vars), '']), ''];
      });
    return [
      '---',
      `title: ${yamlStr(privacy.title)}`,
      `description: ${yamlStr(privacy.description)}`,
      'editUrl: false',
      'prev: false',
      'next: false',
      '---',
      '',
      `_${format(privacy.updated, { date: updated ?? date })}_`,
      '',
      privacy.intro,
      '',
      ...sections,
    ].join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n';
  }

  /** Starlight sidebar: index, plan, then the weeks that have chapter pages. */
  function sidebar() {
    return [
      { label: site.tocLabel, link: '/' },
      { label: site.planLabel, link: PLAN_PATH },
      { label: site.reviewLabel, link: REVIEW_PATH },
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
  }

  /** Flat chapter list for the browser code. */
  const chapters = () => pagedChapters(weeks).map((i) => ({ id: i.id, week: i.week, num: i.num, title: i.title, href: i.href }));

  /** Every generated page with the source file it is rendered from, relative to the repo root. */
  const pageSources = () => [
    { href: '/', source: `${BOOK_DIR}/README.md` },
    { href: PLAN_PATH, source: 'README.md' },
    ...pagedChapters(weeks).map((it) => ({ href: it.href, source: `${BOOK_DIR}/${chapterFile(it.ail)}` })),
  ];

  /** Questions of every quiz rendered so far, by chapter id (call after renderChapter). */
  const quizIndex = () => quizzes;

  /** Chapter files in the book directory that the table of contents does not list. */
  const unlisted = (fileNames) => fileNames.filter((f) => RE.chapterFile.test(f) && !byAil.has(+f.match(RE.chapterFile)[1]));

  return { warnings, stats, rewriteLinks, transformBody, buildQuiz, buildChecklist, renderChapter, renderPlan, renderIndex, renderReview, renderPrivacy, sidebar, chapters, pageSources, quizIndex, unlisted };
}
