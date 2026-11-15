// Which language to offer a reader. The browser's language list decides (Accept-Language on the server,
// navigator.languages in the page), never the country: readers behind a VPN or abroad keep their language.
// A choice the reader made themselves (LANGUAGE_COOKIE) wins over the browser. Shared by the Worker (the
// home page redirect, worker/lib/pages.mjs) and the language note (./language-ui.ts); tested in
// tests/browser/language.test.mjs.
import {
  CRAWLER_USER_AGENT, DEFAULT_LOCALE, FALLBACK_LANG, LANGUAGE_COOKIE, LANGUAGE_COOKIE_MAX_AGE_SECONDS, LOCALES,
} from '../../config/app.mjs';
import { localizePath } from '../../locales/locales.mjs';

/** @param {string | undefined} lang */
const isSiteLang = (lang) => LOCALES.some((l) => l.lang === lang);

/** The primary subtag of a language tag, lower-case: `en-US` → `en`. */
const primary = (/** @type {string} */ tag) => tag.trim().split('-')[0].toLowerCase();

/**
 * Language tags of an Accept-Language header, most wanted first (by q, then by position). Tags with q=0
 * ("not this one") and the `*` wildcard are dropped.
 * @param {string | null | undefined} header
 * @returns {string[]}
 */
export function acceptedLanguages(header) {
  return (header ?? '').split(',')
    .map((part, index) => {
      const [tag, ...params] = part.split(';');
      const q = params.map((p) => p.trim()).find((p) => p.startsWith('q='));
      const weight = q === undefined ? 1 : Number(q.slice(2));
      return { tag: tag.trim(), weight: Number.isFinite(weight) ? weight : 0, index };
    })
    .filter(({ tag, weight }) => tag !== '' && tag !== '*' && weight > 0)
    .sort((a, b) => b.weight - a.weight || a.index - b.index)
    .map(({ tag }) => tag);
}

/**
 * The site language for the reader's languages (most wanted first): the first one the site has; FALLBACK_LANG
 * when the site has none of them; null when the list is empty (nothing to go by).
 * @param {readonly string[]} tags
 * @returns {string | null}
 */
export function preferredLang(tags) {
  if (tags.length === 0) return null;
  return tags.map(primary).find(isSiteLang) ?? FALLBACK_LANG;
}

/**
 * The language the reader chose themselves, from a Cookie header or `document.cookie`; undefined when there
 * is none or it is not a site language.
 * @param {string | null | undefined} cookies
 * @returns {string | undefined}
 */
export function chosenLang(cookies) {
  for (const part of (cookies ?? '').split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1 || part.slice(0, eq).trim() !== LANGUAGE_COOKIE) continue;
    const lang = part.slice(eq + 1).trim();
    return isSiteLang(lang) ? lang : undefined;
  }
  return undefined;
}

/**
 * The cookie that remembers the reader's choice, for `document.cookie`. Secure on HTTPS only, so it also works
 * on the local http:// server.
 * @param {string} lang
 * @param {boolean} secure
 */
export const languageCookie = (lang, secure) =>
  `${LANGUAGE_COOKIE}=${lang}; Path=/; Max-Age=${LANGUAGE_COOKIE_MAX_AGE_SECONDS}; SameSite=Lax${secure ? '; Secure' : ''}`;

/**
 * Where the home page sends a reader: the home page of their language, or null to show the original. The
 * reader's own choice wins; crawlers and requests without Accept-Language are never redirected.
 * @param {{ cookie?: string | null, acceptLanguage?: string | null, userAgent?: string | null }} request
 * @returns {string | null}
 */
export function homeRedirect({ cookie, acceptLanguage, userAgent }) {
  const crawler = CRAWLER_USER_AGENT.test(userAgent ?? '');
  const lang = chosenLang(cookie) ?? (crawler ? null : preferredLang(acceptedLanguages(acceptLanguage)));
  return lang && lang !== DEFAULT_LOCALE.lang ? localizePath('/', lang) : null;
}

/**
 * The language to suggest in the note on a page: the browser's language when it differs from the page's.
 * Nothing once the reader has chosen a language themselves, so a reader who reads both is not asked again.
 * @param {{ pageLang: string, cookie: string, browserLangs: readonly string[] }} facts
 * @returns {string | null}
 */
export function suggestedLang({ pageLang, cookie, browserLangs }) {
  if (chosenLang(cookie)) return null;
  const lang = preferredLang(browserLangs);
  return lang && lang !== pageLang ? lang : null;
}
