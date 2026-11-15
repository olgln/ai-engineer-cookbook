import { BOOK_DIR, CHAPTER_PREFIX, PLAN_PATH, REVIEW_PATH } from '../../src/config/app.mjs';
import { format } from '../../src/locales/format.mjs';
import strings from '../../src/locales/ru.json' with { type: 'json' };
import { RE } from './patterns.mjs';

const { site } = strings;
export const weekLabel = (n, title) => format(site.week, { n, title });
export const chapterFile = (n) => `${CHAPTER_PREFIX}${n}.md`;

/**
 * @typedef {{ num: string, title: string, ail?: number, noPage?: boolean, week?: number, id?: string, slug?: string, href?: string }} TocItem
 * @typedef {{ n: number, title: string, items: TocItem[] }} Week
 */

/** Parse book/README.md into weeks; chapters with a page get id, slug and href. */
export function parseToc(text) {
  /** @type {Week[]} */
  const weeks = [];
  for (const line of text.split('\n')) {
    let m;
    if ((m = line.match(RE.tocWeek))) {
      weeks.push({ n: +m[1], title: m[2].trim(), items: [] });
    } else if ((m = line.match(RE.tocChapter))) {
      weeks.at(-1)?.items.push({ num: `${m[1]}.${m[2]}`, title: m[3], ail: +m[4] });
    } else if ((m = line.match(RE.tocNoPage))) {
      weeks.at(-1)?.items.push({ num: `${m[1]}.${m[2]}`, title: m[3], noPage: true });
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

/** Starlight sidebar: index, plan, then the weeks that have chapter pages. */
export function sidebar(weeks) {
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
export const chapterList = (weeks) =>
  pagedChapters(weeks).map((i) => ({ id: i.id, week: i.week, num: i.num, title: i.title, href: i.href }));

/** Every generated page with the source file it is rendered from, relative to the repo root. */
export const pageSources = (weeks) => [
  { href: '/', source: `${BOOK_DIR}/README.md` },
  { href: PLAN_PATH, source: 'README.md' },
  ...pagedChapters(weeks).map((it) => ({ href: it.href, source: `${BOOK_DIR}/${chapterFile(it.ail)}` })),
];
