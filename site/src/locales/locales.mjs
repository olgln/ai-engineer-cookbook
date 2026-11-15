// Site languages and their URL prefixes (LOCALES in src/config/app.mjs). Pure: shared by the build, the
// Astro components and the browser code, and tested without either (tests/site/locales.test.mjs).
import { DEFAULT_LOCALE, LOCALES } from '../config/app.mjs';

/**
 * The locale of a language; an unknown language falls back to the original one.
 * @param {string | undefined} lang
 */
export const localeOf = (lang) => LOCALES.find((l) => l.lang === lang) ?? DEFAULT_LOCALE;

/**
 * A site path (`/plan/`) in the given language (`/en/plan/`).
 * @param {string} path
 * @param {string | undefined} lang
 */
export const localizePath = (path, lang) => `${localeOf(lang).prefix}${path}`;

/**
 * The language of a page path and the path without its language prefix: `/en/plan/` → en, `/plan/`.
 * @param {string} pathname
 * @returns {{ lang: string, path: string }}
 */
export function splitLocale(pathname) {
  for (const { lang, prefix } of LOCALES) {
    if (!prefix) continue;
    if (pathname === prefix || pathname === `${prefix}/`) return { lang, path: '/' };
    if (pathname.startsWith(`${prefix}/`)) return { lang, path: pathname.slice(prefix.length) };
  }
  return { lang: DEFAULT_LOCALE.lang, path: pathname };
}

/**
 * Starlight's `locales` option: the original language is the root locale, every other one is keyed by its
 * prefix (`en` → pages under /en/).
 * @param {(lang: string) => string} label the name of a language in the language switch
 */
export const starlightLocales = (label) => Object.fromEntries(
  LOCALES.map(({ lang, prefix }) => [prefix ? prefix.slice(1) : 'root', { label: label(lang), lang }]),
);
