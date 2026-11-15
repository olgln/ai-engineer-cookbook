import { BOOK_DIR, DESCRIPTION_MAX_LENGTH } from '../../../src/config/app.mjs';
import strings from '../../../src/locales/ru.json' with { type: 'json' };
import { transformBody } from '../links.mjs';
import { splitSections, tagLines, yamlStr } from '../markdown.mjs';
import { RE } from '../patterns.mjs';
import { buildQuiz } from '../quiz.mjs';
import { chapterFile, weekLabel } from '../toc.mjs';

const { book } = strings;

export function buildChecklist(ctx, chapterId, lines) {
  const conv = tagLines(lines.join('\n')).map((t) => {
    if (!t.code && /^[-*] (?!\[[ x]\])/.test(t.line)) {
      ctx.stats.checks++;
      return t.line.replace(/^([-*]) /, `$1 [ ] `);
    }
    return t.line;
  });
  return [`<div class="done-list" data-chapter="${chapterId}">`, '', conv.join('\n').trim(), '', '</div>'].join('\n');
}

/** Take the description comment out of a chapter body; exactly one, non-empty and short enough. */
function chapterDescription(ctx, it, text) {
  const { warnings } = ctx;
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
export function renderChapter(ctx, src, it, prev, next) {
  const h1 = src.match(/^# (.+)$/m);
  const title = h1 ? h1[1].replace(RE.titleSuffix, '').trim() : `${it.num} · ${it.title}`;
  const { description, body } = chapterDescription(ctx, it, h1 ? src.replace(h1[0], '') : src);
  const sections = splitSections(body);
  const test = sections.find((s) => s.heading === book.testHeading);
  const answers = sections.find((s) => s.heading === book.answersHeading);
  const parts = [];
  for (const s of sections) {
    if (s === answers && test) continue;
    if (s.heading) parts.push(`## ${s.heading}`);
    if (s === test && answers) parts.push(buildQuiz(ctx, it.id, s.lines, answers.lines));
    else if (s.heading === book.doneHeading) parts.push(buildChecklist(ctx, it.id, s.lines));
    else parts.push(s.lines.join('\n').trim());
    parts.push('');
  }
  if (!test || !answers) ctx.warnings.push(`${it.id}: missing test or answers section`);
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
  ctx.stats.chapters++;
  return fm + transformBody(ctx, parts.join('\n')).replace(/\n{3,}/g, '\n\n');
}
