// Pure Markdown → Starlight rendering used by scripts/convert.mjs: strings in, strings out, no file access.
// Kept separate from convert.mjs so it can be unit-tested (tests/convert/render.test.mjs).
// All reader-facing text (site wording and the headings used to parse the book) lives in src/locales/<lang>.json.
import { DEFAULT_LOCALE } from '../../src/config/app.mjs';
import { localizePath } from '../../src/locales/locales.mjs';
import { stringsFor } from '../../src/locales/strings.mjs';
import { rewriteLinks, transformBody } from './links.mjs';
import { patterns } from './patterns.mjs';
import { buildChecklist, renderChapter, renderUntranslated } from './pages/chapter.mjs';
import { renderIndex } from './pages/index-page.mjs';
import { renderPlan } from './pages/plan.mjs';
import { renderPrivacy } from './pages/privacy.mjs';
import { renderReview } from './pages/review.mjs';
import { buildQuiz } from './quiz.mjs';
import { chapterList, pagedChapters, pageSources, sidebar } from './toc.mjs';

/**
 * Renderer bound to one table of contents in one language. Collects warnings and stats across all calls,
 * so one renderer is used for one language of a whole build.
 * @param {import('./toc.mjs').Week[]} weeks
 * @param {import('../../src/config/app.mjs').Locale} [locale] the original by default
 */
export function createRenderer(weeks, locale = DEFAULT_LOCALE) {
  const strings = stringsFor(locale.lang);
  const ctx = {
    weeks,
    locale,
    strings,
    re: patterns(strings, locale.bookDir),
    /** whether this is a translation (not the original language) */
    translation: locale.lang !== DEFAULT_LOCALE.lang,
    /** @param {string} p a site path in this language */
    path: (p) => localizePath(p, locale.lang),
    byAil: new Map(pagedChapters(weeks).map((it) => [it.ail, it])),
    /** @type {Record<string, { n: number, text: string, correct?: string[] }[]>} */
    quizzes: {},
    /** @type {Record<string, number>} checklist items of each chapter, by id */
    checklists: {},
    /** @type {Record<string, string>} source hash of each translated chapter, by id */
    sourceHashes: {},
    /** @type {string[]} */
    warnings: [],
    stats: { chapters: 0, untranslated: 0, questions: 0, choice: 0, choiceWithKey: 0, checks: 0, mermaid: 0 },
  };

  return {
    strings,
    warnings: ctx.warnings,
    stats: ctx.stats,
    rewriteLinks: (line) => rewriteLinks(ctx, line),
    transformBody: (text) => transformBody(ctx, text),
    buildQuiz: (chapterId, testLines, answerLines) => buildQuiz(ctx, chapterId, testLines, answerLines),
    buildChecklist: (chapterId, lines) => buildChecklist(ctx, chapterId, lines),
    renderChapter: (src, it, prev, next) => renderChapter(ctx, src, it, prev, next),
    /** @param {{ title: string, originalHref: string, prev?: any, next?: any }} page */
    renderUntranslated: (page) => renderUntranslated(ctx, page),
    renderPlan: (src) => renderPlan(ctx, src),
    renderIndex: () => renderIndex(ctx),
    renderReview: () => renderReview(ctx),
    renderPrivacy: (options) => renderPrivacy(ctx, options),
    /** @param {Record<string, import('./toc.mjs').Week[]>} [translated] tables of contents of the translations */
    sidebar: (translated) => sidebar(weeks, translated),
    /** @param {Map<string, string>} [originals] the original's page of each untranslated chapter, by id */
    chapters: (originals) => chapterList(weeks, originals),
    pageSources: () => pageSources(weeks, locale),
    /** Questions of every quiz rendered so far, by chapter id (call after renderChapter). */
    quizIndex: () => ctx.quizzes,
    /** Checklist items of every chapter rendered so far, by chapter id. */
    checklists: () => ctx.checklists,
    /** Source hash of every translated chapter rendered so far, by chapter id. */
    sourceHashes: () => ctx.sourceHashes,
    /** Chapter files in the book directory that the table of contents does not list. */
    unlisted: (fileNames) => fileNames.filter((f) => ctx.re.chapterFile.test(f) && !ctx.byAil.has(+f.match(ctx.re.chapterFile)[1])),
  };
}
