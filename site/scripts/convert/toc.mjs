import { CHAPTER_PREFIX, DEFAULT_LOCALE, PLAN_PATH, REVIEW_PATH } from '../../src/config/app.mjs';
import { format } from '../../src/locales/format.mjs';
import { localizePath } from '../../src/locales/locales.mjs';
import { stringsFor } from '../../src/locales/strings.mjs';
import { patterns } from './patterns.mjs';

/** @typedef {import('../../src/config/app.mjs').Locale} Locale */

/**
 * "Week 1 · Title" in the language of `strings` (the original by default).
 * @param {number} n
 * @param {string} title
 * @param {import('../../src/locales/strings.mjs').Strings} [strings]
 */
export const weekLabel = (n, title, strings = stringsFor(DEFAULT_LOCALE.lang)) => format(strings.site.week, { n, title });
export const chapterFile = (n) => `${CHAPTER_PREFIX}${n}.md`;

/**
 * @typedef {{ num: string, title: string, ail?: number, noPage?: boolean, week?: number, id?: string, slug?: string, href?: string }} TocItem
 * @typedef {{ n: number, title: string, items: TocItem[] }} Week
 */

/**
 * Parse a book's README.md into weeks; chapters with a page get id, slug and href. The id and slug are
 * the same in every language (progress is shared); the href carries the language prefix.
 * @param {string} text
 * @param {Locale} [locale]
 */
export function parseToc(text, locale = DEFAULT_LOCALE) {
  const RE = patterns(stringsFor(locale.lang), locale.bookDir);
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
      it.href = localizePath(`/${it.slug}/`, locale.lang);
    }
  }
  return weeks;
}

/** Chapters that have a page, in reading order. */
export const pagedChapters = (weeks) => weeks.flatMap((w) => w.items.filter((i) => !i.noPage));

/**
 * Differences between the structure of a translated table of contents and the original's: weeks, numbers,
 * chapter files and pages must match one to one, only the titles differ. Empty when they match.
 * @param {Week[]} original
 * @param {Week[]} translated
 * @returns {string[]}
 */
export function tocMismatches(original, translated) {
  const shape = (weeks) => weeks.flatMap((w) => [`week ${w.n}`, ...w.items.map((it) => `${it.num} ${it.noPage ? '(no page)' : chapterFile(it.ail)}`)]);
  const a = shape(original);
  const b = shape(translated);
  const out = [];
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if (a[i] !== b[i]) out.push(`${a[i] ?? '(nothing)'} in the original, ${b[i] ?? '(nothing)'} in the translation`);
  }
  return out;
}

/**
 * Starlight sidebar: index, plan, then the weeks that have chapter pages. Labels are in the original's
 * language; `translations` gives each label in the other languages (Starlight picks the label of the page's
 * language and adds the language prefix to the links itself).
 * @param {Week[]} weeks the original's table of contents
 * @param {Record<string, Week[]>} [translated] tables of contents of the translations, by language
 */
export function sidebar(weeks, translated = {}) {
  const ui = (key) => stringsFor(DEFAULT_LOCALE.lang).site[key];
  const labels = (pick) => {
    const translations = Object.fromEntries(Object.entries(translated).flatMap(([lang, tw]) => {
      const label = pick(stringsFor(lang), tw);
      return label ? [[lang, label]] : [];
    }));
    return Object.keys(translations).length ? { translations } : {};
  };
  const weekOf = (tw, n) => tw.find((w) => w.n === n);
  const itemOf = (tw, id) => pagedChapters(tw).find((it) => it.id === id);
  return [
    { label: ui('tocLabel'), ...labels((s) => s.site.tocLabel), link: '/' },
    { label: ui('planLabel'), ...labels((s) => s.site.planLabel), link: PLAN_PATH },
    { label: ui('reviewLabel'), ...labels((s) => s.site.reviewLabel), link: REVIEW_PATH },
    // weeks without chapter pages (e.g. the spare week) appear only on the index page
    ...weeks
      .filter((w) => w.items.some((it) => !it.noPage))
      .map((w) => ({
        label: weekLabel(w.n, w.title),
        ...labels((s, tw) => {
          const t = weekOf(tw, w.n);
          return t && weekLabel(t.n, t.title, s);
        }),
        collapsed: true,
        items: w.items
          .filter((it) => !it.noPage)
          .map((it) => ({
            label: `${it.num} · ${it.title}`,
            ...labels((s, tw) => {
              const t = itemOf(tw, it.id);
              return t && `${t.num} · ${t.title}`;
            }),
            // the original's path: Starlight adds the language prefix
            link: `/${it.slug}/`,
            attrs: { 'data-chapter': it.id },
          })),
      })),
  ];
}

/**
 * Flat chapter list for the browser code. `readHref` is where the chapter text is: the page itself, or for
 * a chapter not translated yet, the original's page (`originals`, by id).
 * @param {Week[]} weeks
 * @param {Map<string, string>} [originals]
 */
export const chapterList = (weeks, originals = new Map()) =>
  pagedChapters(weeks).map((i) => ({
    id: i.id, week: i.week, num: i.num, title: i.title, href: i.href, readHref: originals.get(i.id) ?? i.href,
  }));

/**
 * Every generated page with the source file it is rendered from, relative to the repo root.
 * @param {Week[]} weeks
 * @param {Locale} [locale]
 */
export const pageSources = (weeks, locale = DEFAULT_LOCALE) => [
  { href: localizePath('/', locale.lang), source: `${locale.bookDir}/README.md` },
  { href: localizePath(PLAN_PATH, locale.lang), source: locale.planFile },
  ...pagedChapters(weeks).map((it) => ({ href: it.href, source: `${locale.bookDir}/${chapterFile(it.ail)}` })),
];
