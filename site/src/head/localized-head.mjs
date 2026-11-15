// Per-page language fixes of the <head> that Starlight's global `head` option cannot make, applied by the
// route middleware (src/route-data.ts). Pure, so it is tested without a build (tests/site/localized-head.test.mjs).
import { splitLocale } from '../locales/locales.mjs';

/** @typedef {{ tag: string, attrs?: Record<string, string | boolean | undefined>, content?: string }} HeadEntry */
/**
 * The page language's values for the head.
 * @typedef {{ imageAlt: string, image: string, ogLocale: string }} HeadLocale
 *   imageAlt: the preview image text; image: the preview image path (`/og-image.en.png`); ogLocale: `en_US`
 */

const isAlternate = (/** @type {HeadEntry} */ e) => e.tag === 'link' && e.attrs?.rel === 'alternate' && Boolean(e.attrs?.hreflang);
const isMeta = (/** @type {HeadEntry} */ e, /** @type {string} */ key) =>
  e.tag === 'meta' && (e.attrs?.property === key || e.attrs?.name === key);
const isImageAlt = (/** @type {HeadEntry} */ e) => isMeta(e, 'og:image:alt') || isMeta(e, 'twitter:image:alt');
const isImage = (/** @type {HeadEntry} */ e) => isMeta(e, 'og:image') || isMeta(e, 'twitter:image');

/**
 * The value a head entry takes in the page's language, or undefined to keep it.
 * @param {HeadEntry} e
 * @param {HeadLocale} locale
 */
function localizedContent(e, locale) {
  if (isImageAlt(e)) return locale.imageAlt;
  // the absolute image URL keeps its origin: only the file changes
  if (isImage(e) && typeof e.attrs?.content === 'string') return new URL(locale.image, e.attrs.content).href;
  if (isMeta(e, 'og:locale')) return locale.ogLocale;
  return undefined;
}

/**
 * Starlight links every page to its counterpart in each language (hreflang). Those links stay only on pages
 * that every language really has: an untranslated chapter's placeholder is noindex, and a link to it would
 * be an hreflang error in search consoles. The preview image, its text and og:locale follow the page's language
 * (Starlight writes og:locale as the bare language code, Open Graph expects language_TERRITORY).
 * @template {HeadEntry} T
 * @param {T[]} head the page's head entries
 * @param {string} pathname the page path, with or without the language prefix and the trailing slash
 * @param {string[]} shared page paths (without a language prefix) that every language has
 * @param {HeadLocale} locale the page language's values
 * @returns {T[]}
 */
export function localizedHead(head, pathname, shared, locale) {
  const { path } = splitLocale(pathname.endsWith('/') ? pathname : `${pathname}/`);
  const keepAlternates = shared.includes(path);
  return head
    .filter((e) => keepAlternates || !isAlternate(e))
    .map((e) => {
      const content = localizedContent(e, locale);
      return content === undefined ? e : { ...e, attrs: { ...e.attrs, content } };
    });
}
