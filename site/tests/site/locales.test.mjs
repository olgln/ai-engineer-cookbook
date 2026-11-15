// Site languages: URL prefixes, Starlight's locale option, and the UI strings of every language.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { DEFAULT_LOCALE, LOCALES, PRIVACY_PATH } from '../../src/config/app.mjs';
import { footerLinks } from '../../src/components/footer.mjs';
import { accountMenuHtml } from '../../src/components/account-menu.mjs';
import { localeOf, localizePath, splitLocale, starlightLocales } from '../../src/locales/locales.mjs';
import { STRINGS, stringsFor } from '../../src/locales/strings.mjs';

describe('locales', () => {
  test('the original is served at the root, every translation under its own prefix', () => {
    assert.equal(DEFAULT_LOCALE.prefix, '');
    for (const l of LOCALES.slice(1)) assert.match(l.prefix, /^\/[a-z]{2}$/);
    assert.equal(new Set(LOCALES.map((l) => l.lang)).size, LOCALES.length);
  });

  test('localizePath adds the prefix of a translation and leaves the original as is', () => {
    assert.equal(localizePath('/plan/', 'ru'), '/plan/');
    assert.equal(localizePath('/plan/', 'en'), '/en/plan/');
    assert.equal(localizePath('/', 'en'), '/en/');
    assert.equal(localizePath('/plan/', 'xx'), '/plan/', 'an unknown language is the original');
    assert.equal(localeOf(undefined), DEFAULT_LOCALE);
  });

  test('splitLocale reads the language from a path and strips its prefix', () => {
    assert.deepEqual(splitLocale('/en/week-01/1-1/'), { lang: 'en', path: '/week-01/1-1/' });
    assert.deepEqual(splitLocale('/en/'), { lang: 'en', path: '/' });
    assert.deepEqual(splitLocale('/en'), { lang: 'en', path: '/' });
    assert.deepEqual(splitLocale('/week-01/1-1/'), { lang: 'ru', path: '/week-01/1-1/' });
    assert.deepEqual(splitLocale('/english-notes/'), { lang: 'ru', path: '/english-notes/' }, 'a prefix is a whole path segment');
  });

  test('Starlight gets the original as the root locale and a key per prefix', () => {
    assert.deepEqual(starlightLocales((lang) => stringsFor(lang).languageLabel), {
      root: { label: 'Русский', lang: 'ru' },
      en: { label: 'English', lang: 'en' },
    });
  });
});

/** Paths of every leaf string, with plural forms (keyed by Intl.PluralRules categories) as one leaf. */
function leaves(obj, prefix = '') {
  return Object.entries(obj).flatMap(([k, v]) => {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === 'object' && !Array.isArray(v) && !('other' in v)) return leaves(v, key);
    return [[key, v]];
  });
}
const placeholders = (v) => [...JSON.stringify(v).matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join();

describe('UI strings', () => {
  const original = new Map(leaves(stringsFor(DEFAULT_LOCALE.lang)));

  test('there are strings for every language, with the language code of the file', () => {
    for (const { lang } of LOCALES) assert.equal(STRINGS[lang]?.lang, lang);
    assert.equal(stringsFor('xx'), stringsFor(DEFAULT_LOCALE.lang));
  });

  test('every translation has exactly the original\'s keys and the same {placeholders}', () => {
    for (const { lang } of LOCALES.slice(1)) {
      const translated = new Map(leaves(STRINGS[lang]));
      assert.deepEqual([...translated.keys()].sort(), [...original.keys()].sort(), lang);
      for (const [key, value] of original) assert.equal(placeholders(translated.get(key)), placeholders(value), `${lang}: ${key}`);
    }
  });

  test('plural forms cover the categories of the language', () => {
    for (const { lang } of LOCALES) {
      const categories = new Intl.PluralRules(lang).resolvedOptions().pluralCategories;
      for (const forms of [STRINGS[lang].ui.questions, STRINGS[lang].ui.chaptersOf]) {
        for (const c of categories) assert.ok(c in forms || 'other' in forms, `${lang}: ${c}`);
        assert.ok('other' in forms);
      }
    }
  });

  test('the footer and the account menu link the privacy page of their language', () => {
    assert.equal(footerLinks(stringsFor('en'))[0].href, `/en${PRIVACY_PATH}`);
    assert.equal(footerLinks(stringsFor('ru'))[0].href, PRIVACY_PATH);
    assert.ok(accountMenuHtml(stringsFor('en')).includes(`class="account-privacy" href="/en${PRIVACY_PATH}"`));
    assert.ok(accountMenuHtml(stringsFor('ru')).includes(`class="account-privacy" href="${PRIVACY_PATH}"`));
  });
});
