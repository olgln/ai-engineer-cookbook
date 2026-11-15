// Per-page language fixes of the <head> that Starlight's global `head` option cannot make, applied by the
// route middleware (src/route-data.ts). Pure, so it is tested without a build (tests/site/localized-head.test.mjs).
import { splitLocale } from '../locales/locales.mjs';

/** @typedef {{ tag: string, attrs?: Record<string, string | boolean | undefined>, content?: string }} HeadEntry */

const isAlternate = (/** @type {HeadEntry} */ e) => e.tag === 'link' && e.attrs?.rel === 'alternate' && Boolean(e.attrs?.hreflang);
const isImageAlt = (/** @type {HeadEntry} */ e) =>
  e.tag === 'meta' && (e.attrs?.property === 'og:image:alt' || e.attrs?.name === 'twitter:image:alt');

/**
 * Starlight links every page to its counterpart in each language (hreflang). Those links stay only on pages
 * that every language really has: an untranslated chapter's placeholder is noindex, and a link to it would
 * be an hreflang error in search consoles. The preview image text follows the page's language.
 * @template {HeadEntry} T
 * @param {T[]} head the page's head entries
 * @param {string} pathname the page path, with or without the language prefix and the trailing slash
 * @param {string[]} shared page paths (without a language prefix) that every language has
 * @param {string} imageAlt the preview image text in the page's language
 * @returns {T[]}
 */
export function localizedHead(head, pathname, shared, imageAlt) {
  const { path } = splitLocale(pathname.endsWith('/') ? pathname : `${pathname}/`);
  const keepAlternates = shared.includes(path);
  return head
    .filter((e) => keepAlternates || !isAlternate(e))
    .map((e) => (isImageAlt(e) ? { ...e, attrs: { ...e.attrs, content: imageAlt } } : e));
}
