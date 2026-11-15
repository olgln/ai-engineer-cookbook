// Tests for choosing the reader's language (src/scripts/language/language.mjs): Accept-Language parsing, the
// browser language → site language, the remembered choice, the home page redirect and the language note.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  DEFAULT_LOCALE, FALLBACK_LANG, LANGUAGE_COOKIE, LANGUAGE_COOKIE_MAX_AGE_SECONDS, LOCALES,
} from '../../src/config/app.mjs';
import { localizePath } from '../../src/locales/locales.mjs';
import {
  acceptedLanguages, chosenLang, homeRedirect, languageCookie, preferredLang, suggestedLang,
} from '../../src/scripts/language/language.mjs';

const ORIGINAL = DEFAULT_LOCALE.lang;
const OTHER = LOCALES.find((l) => l.lang !== ORIGINAL).lang;
const otherHome = localizePath('/', OTHER);
const chose = (lang) => `theme=dark; ${LANGUAGE_COOKIE}=${lang}`;
const BROWSER = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 15_0) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/19.0 Safari/605.1.15';

describe('acceptedLanguages', () => {
  test('orders by q, then by position, and keeps the full tags', () => {
    assert.deepEqual(acceptedLanguages('en-US,en;q=0.9,ru;q=0.8'), ['en-US', 'en', 'ru']);
    assert.deepEqual(acceptedLanguages('de;q=0.5, ru-RU , en;q=0.7'), ['ru-RU', 'en', 'de']);
  });

  test('drops q=0, the wildcard and empty or broken entries', () => {
    assert.deepEqual(acceptedLanguages('ru;q=0, en, *;q=0.1, ,fr;q=abc'), ['en']);
  });

  test('a missing or empty header is an empty list', () => {
    assert.deepEqual(acceptedLanguages(null), []);
    assert.deepEqual(acceptedLanguages(undefined), []);
    assert.deepEqual(acceptedLanguages(''), []);
  });
});

describe('preferredLang', () => {
  test('the first language the site has, by the primary subtag', () => {
    assert.equal(preferredLang(['ru-RU', 'en-US']), 'ru');
    assert.equal(preferredLang(['EN-gb', 'ru']), 'en');
  });

  test('languages the site does not have are skipped', () => {
    assert.equal(preferredLang(['uk', 'ru', 'en']), 'ru');
    assert.equal(preferredLang(['uk', 'en', 'ru']), 'en');
  });

  test('none of the site languages: the fallback language', () => {
    assert.equal(preferredLang(['de-DE', 'fr']), FALLBACK_LANG);
  });

  test('nothing to go by: null', () => {
    assert.equal(preferredLang([]), null);
  });

  test('the fallback is a site language', () => {
    assert.ok(LOCALES.some((l) => l.lang === FALLBACK_LANG));
  });
});

describe('chosenLang', () => {
  test('reads the language cookie among others', () => {
    assert.equal(chosenLang(chose(OTHER)), OTHER);
    assert.equal(chosenLang(`${LANGUAGE_COOKIE}=${ORIGINAL}`), ORIGINAL);
  });

  test('no cookie, another cookie with a similar name, or an unknown language: undefined', () => {
    assert.equal(chosenLang(null), undefined);
    assert.equal(chosenLang('theme=dark'), undefined);
    assert.equal(chosenLang(`x-${LANGUAGE_COOKIE}=${OTHER}`), undefined);
    assert.equal(chosenLang(chose('de')), undefined);
  });
});

describe('languageCookie', () => {
  test('site-wide, for a year, Secure only on HTTPS', () => {
    const base = `${LANGUAGE_COOKIE}=${OTHER}; Path=/; Max-Age=${LANGUAGE_COOKIE_MAX_AGE_SECONDS}; SameSite=Lax`;
    assert.equal(languageCookie(OTHER, true), `${base}; Secure`);
    assert.equal(languageCookie(OTHER, false), base);
  });

  test('is read back by chosenLang', () => {
    assert.equal(chosenLang(languageCookie(OTHER, true)), OTHER);
  });
});

describe('homeRedirect', () => {
  test('a browser in another site language goes to that language', () => {
    assert.equal(homeRedirect({ acceptLanguage: `${OTHER}-US,${OTHER};q=0.9`, userAgent: BROWSER }), otherHome);
  });

  test('a browser in the original language stays', () => {
    assert.equal(homeRedirect({ acceptLanguage: `${ORIGINAL}-RU,${OTHER};q=0.5`, userAgent: BROWSER }), null);
  });

  test('a browser in none of the site languages gets the fallback', () => {
    const expected = FALLBACK_LANG === ORIGINAL ? null : localizePath('/', FALLBACK_LANG);
    assert.equal(homeRedirect({ acceptLanguage: 'de-DE,fr;q=0.8', userAgent: BROWSER }), expected);
  });

  test('the reader\'s own choice wins over the browser, both ways', () => {
    assert.equal(homeRedirect({ cookie: chose(ORIGINAL), acceptLanguage: OTHER, userAgent: BROWSER }), null);
    assert.equal(homeRedirect({ cookie: chose(OTHER), acceptLanguage: ORIGINAL, userAgent: BROWSER }), otherHome);
  });

  test('no Accept-Language (Googlebot) or a crawler: the original stays', () => {
    assert.equal(homeRedirect({ userAgent: 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)' }), null);
    assert.equal(homeRedirect({ acceptLanguage: OTHER, userAgent: 'Mozilla/5.0 (compatible; bingbot/2.0)' }), null);
    assert.equal(homeRedirect({ acceptLanguage: OTHER, userAgent: 'TelegramBot (like TwitterBot)' }), null);
    assert.equal(homeRedirect({ acceptLanguage: OTHER, userAgent: 'facebookexternalhit/1.1' }), null);
  });
});

describe('suggestedLang', () => {
  test('suggests the browser language when the page is in another one', () => {
    assert.equal(suggestedLang({ pageLang: ORIGINAL, cookie: '', browserLangs: [`${OTHER}-US`] }), OTHER);
    assert.equal(suggestedLang({ pageLang: OTHER, cookie: '', browserLangs: [`${ORIGINAL}-RU`, OTHER] }), ORIGINAL);
  });

  test('nothing when the page is already in the browser language', () => {
    assert.equal(suggestedLang({ pageLang: OTHER, cookie: '', browserLangs: [OTHER] }), null);
  });

  test('nothing once the reader has chosen a language, even another one', () => {
    assert.equal(suggestedLang({ pageLang: ORIGINAL, cookie: chose(ORIGINAL), browserLangs: [OTHER] }), null);
    assert.equal(suggestedLang({ pageLang: ORIGINAL, cookie: chose(OTHER), browserLangs: [OTHER] }), null);
  });

  test('nothing when the browser lists no languages', () => {
    assert.equal(suggestedLang({ pageLang: ORIGINAL, cookie: '', browserLangs: [] }), null);
  });
});
