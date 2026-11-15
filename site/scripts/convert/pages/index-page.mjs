import { PLAN_PATH } from '../../../src/config/app.mjs';
import { format, plural } from '../../../src/locales/format.mjs';
import { stringsFor } from '../../../src/locales/strings.mjs';
import { escapeHtml, yamlStr } from '../markdown.mjs';
import { pagedChapters, weekLabel } from '../toc.mjs';

const ORIGINAL = stringsFor(undefined);

// Progress blocks of the index page, rendered in the "nothing done yet" state. src/scripts/course/index-page-ui.ts
// (initIndex) fills in the reader's progress in place, so the page does not shift when it loads
// (Cumulative Layout Shift). Class names are the contract between the two.

/** A progress bar at 0%; index-page-ui.ts sets the fill width and aria-valuenow. */
const progressBarHtml = () =>
  '<span class="progress-bar" role="progressbar" aria-valuenow="0" aria-valuemin="0" aria-valuemax="100"><span class="progress-fill"></span></span>';

/**
 * Course progress block: count, storage note, bar, the first chapter to start from.
 * One line: a blank line would end the raw HTML block in Markdown.
 * @param {{ num: string, title: string, href: string }[]} chapters chapters that have a page
 * @param {import('../../../src/locales/strings.mjs').Strings} [strings] the page's language
 */
export function courseProgressHtml(chapters, strings = ORIGINAL) {
  const { ui } = strings;
  const total = chapters.length;
  const count = format(ui.courseProgress, { done: 0, total, chapters: plural(strings.lang, total, ui.chaptersOf) });
  const [first] = chapters;
  const start = format(ui.startFrom, { chapter: `${first.num} · ${first.title}` });
  return [
    '<div class="course-progress">',
    '<div class="course-progress-head">',
    `<strong class="course-progress-count">${escapeHtml(count)}</strong>`,
    // filled by the browser: where the progress is kept, or an invitation to sign in (src/scripts/course/index-page-ui.ts)
    '<span class="storage-note"></span>',
    '</div>',
    progressBarHtml(),
    '<div class="course-progress-actions">',
    `<a class="quiz-btn primary course-progress-next" href="${first.href}">${escapeHtml(start)}</a>`,
    '</div>',
    '</div>',
  ].join('');
}

/**
 * Progress row of a week card: bar and "0/N".
 * @param {number} pages chapters of the week that have a page
 */
export const weekProgressHtml = (pages) =>
  `<div class="week-progress">${progressBarHtml()}<span class="week-progress-label">0/${pages}</span></div>`;

/** Render the index page: course progress and one card per week. */
export function renderIndex({ weeks, strings, path }) {
  const { site } = strings;
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
    format(site.indexIntro, { planLabel: site.planLabel, planPath: path(PLAN_PATH) }),
    '',
    courseProgressHtml(pagedChapters(weeks), strings),
    '',
  ];
  for (const w of weeks) {
    lines.push(`<section class="week-card" data-week="${w.n}">`, '', `### ${weekLabel(w.n, w.title, strings)}`, '');
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
