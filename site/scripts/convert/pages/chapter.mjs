import { DESCRIPTION_MAX_LENGTH } from '../../../src/config/app.mjs';
import { format } from '../../../src/locales/format.mjs';
import { transformBody } from '../links.mjs';
import { splitSections, tagLines, yamlStr } from '../markdown.mjs';
import { buildQuiz } from '../quiz.mjs';
import { chapterFile, weekLabel } from '../toc.mjs';

export function buildChecklist(ctx, chapterId, lines) {
  ctx.checklists[chapterId] = 0;
  const conv = tagLines(lines.join('\n')).map((t) => {
    if (!t.code && /^[-*] (?!\[[ x]\])/.test(t.line)) {
      ctx.stats.checks++;
      ctx.checklists[chapterId]++;
      return t.line.replace(/^([-*]) /, `$1 [ ] `);
    }
    return t.line;
  });
  return [`<div class="done-list" data-chapter="${chapterId}">`, '', conv.join('\n').trim(), '', '</div>'].join('\n');
}

/** Take the description comment out of a chapter body; exactly one, non-empty and short enough. */
function chapterDescription(ctx, it, text) {
  const { warnings, re: RE } = ctx;
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

/**
 * Take the source-hash comment out of a translated chapter and remember it (ctx.sourceHashes); a
 * translation without exactly one is a warning. The original has none.
 */
function takeSourceHash(ctx, it, text) {
  const found = [...text.matchAll(ctx.re.sourceHash)].map((m) => m[1]);
  const body = text.replace(ctx.re.sourceHash, '');
  if (!ctx.translation) {
    if (found.length) ctx.warnings.push(`${it.id}: a source hash comment belongs in translations only`);
    return body;
  }
  if (found.length !== 1 || !found[0]) ctx.warnings.push(`${ctx.locale.lang} ${it.id}: ${found.length > 1 ? 'more than one' : 'missing'} source hash comment`);
  else ctx.sourceHashes[it.id] = found[0];
  return body;
}

/** Previous/next page links of the front matter. */
const pagination = (prev, next) => [
  prev ? `prev: { link: ${yamlStr(prev.href)}, label: ${yamlStr(`${prev.num} · ${prev.title}`)} }` : 'prev: false',
  next ? `next: { link: ${yamlStr(next.href)}, label: ${yamlStr(`${next.num} · ${next.title}`)} }` : 'next: false',
];

/** Render one chapter's source into a Starlight page. */
export function renderChapter(ctx, src, it, prev, next) {
  const { re: RE, strings: { book }, strings } = ctx;
  const h1 = src.match(/^# (.+)$/m);
  const title = h1 ? h1[1].replace(RE.titleSuffix, '').trim() : `${it.num} · ${it.title}`;
  const { description, body } = chapterDescription(ctx, it, takeSourceHash(ctx, it, h1 ? src.replace(h1[0], '') : src));
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
    `description: ${yamlStr(description ?? weekLabel(it.week, it.title, strings))}`,
    `editUrl: false`,
    ...pagination(prev, next),
    '---',
    '',
    `<!-- Generated from ${ctx.locale.bookDir}/${chapterFile(it.ail)} by scripts/convert.mjs. Edit the source, not this file. -->`,
    '',
  ].join('\n');
  ctx.stats.chapters++;
  return fm + transformBody(ctx, parts.join('\n')).replace(/\n{3,}/g, '\n\n');
}

/**
 * The page of a chapter (or the plan) a translation does not have yet: its translated title and a link to
 * the original, hidden from search engines and the site search.
 * @param {{ title: string, originalHref: string, prev?: any, next?: any }} page
 */
export function renderUntranslated(ctx, page) {
  const { title, originalHref, prev, next } = page;
  const { site } = ctx.strings;
  ctx.stats.untranslated++;
  return [
    '---',
    `title: ${yamlStr(title)}`,
    `description: ${yamlStr(format(site.untranslatedDescription, { title }))}`,
    'editUrl: false',
    'tableOfContents: false',
    'pagefind: false',
    'head:',
    '  - { tag: meta, attrs: { name: robots, content: noindex } }',
    ...pagination(prev, next),
    '---',
    '',
    format(site.untranslatedNote, { href: originalHref }),
    '',
  ].join('\n');
}
