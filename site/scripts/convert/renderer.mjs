// Pure Markdown → Starlight rendering used by scripts/convert.mjs: strings in, strings out, no file access.
// Kept separate from convert.mjs so it can be unit-tested (tests/convert/render.test.mjs).
// All Russian text (site wording and the headings used to parse the book) lives in src/locales/ru.json.
import { rewriteLinks, transformBody } from './links.mjs';
import { RE } from './patterns.mjs';
import { buildChecklist, renderChapter } from './pages/chapter.mjs';
import { renderIndex } from './pages/index-page.mjs';
import { renderPlan } from './pages/plan.mjs';
import { renderPrivacy } from './pages/privacy.mjs';
import { renderReview } from './pages/review.mjs';
import { buildQuiz } from './quiz.mjs';
import { chapterList, pagedChapters, pageSources, sidebar } from './toc.mjs';

/**
 * Renderer bound to one table of contents. Collects warnings and stats across all calls,
 * so one renderer is used for one whole build.
 */
export function createRenderer(weeks) {
  const ctx = {
    weeks,
    byAil: new Map(pagedChapters(weeks).map((it) => [it.ail, it])),
    /** @type {Record<string, { n: number, text: string, correct?: string[] }[]>} */
    quizzes: {},
    /** @type {string[]} */
    warnings: [],
    stats: { chapters: 0, questions: 0, choice: 0, choiceWithKey: 0, checks: 0, mermaid: 0 },
  };

  return {
    warnings: ctx.warnings,
    stats: ctx.stats,
    rewriteLinks: (line) => rewriteLinks(ctx, line),
    transformBody: (text) => transformBody(ctx, text),
    buildQuiz: (chapterId, testLines, answerLines) => buildQuiz(ctx, chapterId, testLines, answerLines),
    buildChecklist: (chapterId, lines) => buildChecklist(ctx, chapterId, lines),
    renderChapter: (src, it, prev, next) => renderChapter(ctx, src, it, prev, next),
    renderPlan: (src) => renderPlan(ctx, src),
    renderIndex: () => renderIndex(ctx),
    renderReview,
    renderPrivacy: (options) => renderPrivacy(ctx, options),
    sidebar: () => sidebar(weeks),
    chapters: () => chapterList(weeks),
    pageSources: () => pageSources(weeks),
    /** Questions of every quiz rendered so far, by chapter id (call after renderChapter). */
    quizIndex: () => ctx.quizzes,
    /** Chapter files in the book directory that the table of contents does not list. */
    unlisted: (fileNames) => fileNames.filter((f) => RE.chapterFile.test(f) && !ctx.byAil.has(+f.match(RE.chapterFile)[1])),
  };
}
