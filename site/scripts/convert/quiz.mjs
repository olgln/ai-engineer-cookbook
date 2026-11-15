import { QUESTION_ANCHOR_PREFIX, QUESTION_PREVIEW_MAX_LENGTH } from '../../src/config/app.mjs';
import { format } from '../../src/locales/format.mjs';
import { splitNumbered, tagLines } from './markdown.mjs';
import { RE as ORIGINAL_RE } from './patterns.mjs';

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

/**
 * Find the correct option letter(s) at the start of an answer; null when there are none.
 * @param {string[]} answerLines
 * @param {{ answerLetters: RegExp, answerStart: RegExp }} [RE] patterns of the book's language
 */
export function answerKey(answerLines, RE = ORIGINAL_RE) {
  const first = answerLines[0] ?? '';
  const m = first.match(RE.answerLetters);
  if (!m || !RE.answerStart.test(first)) return null;
  return [...m[1].matchAll(/[a-d]/g)].map((x) => x[0]);
}

export function buildQuiz(ctx, chapterId, testLines, answerLines) {
  const { stats, warnings, strings: { site } } = ctx;
  const tests = splitNumbered(testLines);
  const answers = splitNumbered(answerLines);
  const answerMap = new Map(answers.items.map((a) => [a.n, a.lines]));
  if (tests.items.length !== answers.items.length) {
    warnings.push(`${chapterId}: ${tests.items.length} questions vs ${answers.items.length} answers`);
  }
  const out = [];
  if (tests.pre.join('').trim()) out.push(tests.pre.join('\n').trim(), '');
  out.push(`<div class="quiz" data-chapter="${chapterId}">`, '');
  const index = (ctx.quizzes[chapterId] = []);
  for (const q of tests.items) {
    stats.questions++;
    const ans = answerMap.get(q.n);
    if (!ans) warnings.push(`${chapterId}: no answer for question ${q.n}`);
    const opts = extractOptions(q.lines);
    const key = opts && ans ? answerKey(ans, ctx.re) : null;
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
