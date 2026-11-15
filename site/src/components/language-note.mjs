// The language note at the top of every page: "this site is also available in <language>", with a link to
// the same page in that language and a close button. One note per other site language, written in that
// language and rendered hidden; src/scripts/language/language-ui.ts shows the one for the reader's browser
// language, if any. Pure, so it can be tested without rendering Astro components
// (tests/site/language-note.test.mjs).
import { LOCALES } from '../config/app.mjs';
import { localizePath, splitLocale } from '../locales/locales.mjs';
import { stringsFor } from '../locales/strings.mjs';

const escape = (s) => String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/**
 * The page in another language: the same page where that language has it, otherwise that language's home page
 * (a page without a counterpart, or one whose translation is still a placeholder).
 * @param {string} pathname the current page path, with its language prefix
 * @param {string} lang the other language
 * @param {readonly string[]} shared page paths (without a prefix) that every language has
 */
export function counterpartPath(pathname, lang, shared) {
  const { path } = splitLocale(pathname);
  return localizePath(shared.includes(path) ? path : '/', lang);
}

/**
 * Markup of the notes for a page: one hidden note per language other than the page's.
 * @param {{ pageLang: string, pathname: string, shared: readonly string[] }} page
 */
export function languageNotesHtml({ pageLang, pathname, shared }) {
  return LOCALES.filter(({ lang }) => lang !== pageLang).map(({ lang }) => {
    const { ui } = stringsFor(lang);
    return [
      `<aside class="language-note" lang="${lang}" data-language-note="${lang}" data-pagefind-ignore hidden>`,
      `<p>${escape(ui.languageNoteText)} `,
      `<a href="${escape(counterpartPath(pathname, lang, shared))}" hreflang="${lang}" data-language-note-link>${escape(ui.languageNoteLink)}</a></p>`,
      `<button type="button" class="language-note-close" data-language-note-close aria-label="${escape(ui.close)}">`,
      '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>',
      '</button>',
      '</aside>',
    ].join('');
  }).join('');
}
