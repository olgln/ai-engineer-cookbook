// Tests for the language note (src/components/language-note.mjs): its markup in the other language, the link
// to the same page or that language's home page, how it is put into every page (PageFrame override, styles),
// and the wiring of src/scripts/language/language-ui.ts, which is DOM code without a test DOM (checked as text).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { describe, test } from 'node:test';
import { DEFAULT_LOCALE, LOCALES } from '../../src/config/app.mjs';
import { localizePath } from '../../src/locales/locales.mjs';
import { stringsFor } from '../../src/locales/strings.mjs';
import { counterpartPath, languageNotesHtml } from '../../src/components/language-note.mjs';

const ORIGINAL = DEFAULT_LOCALE.lang;
const OTHER = LOCALES.find((l) => l.lang !== ORIGINAL).lang;
const SHARED = ['/', '/plan/', '/week-01/1-1/'];
const read = (rel) => fs.readFileSync(new URL(rel, import.meta.url), 'utf8');

describe('counterpartPath', () => {
  test('the same page in the other language when it has one', () => {
    assert.equal(counterpartPath('/week-01/1-1/', OTHER, SHARED), localizePath('/week-01/1-1/', OTHER));
    assert.equal(counterpartPath(localizePath('/plan/', OTHER), ORIGINAL, SHARED), '/plan/');
    assert.equal(counterpartPath('/', OTHER, SHARED), localizePath('/', OTHER));
  });

  test('otherwise the home page of the other language', () => {
    assert.equal(counterpartPath('/week-02/2-1/', OTHER, SHARED), localizePath('/', OTHER));
    assert.equal(counterpartPath(localizePath('/review/', OTHER), ORIGINAL, SHARED), '/');
  });
});

describe('language note markup', () => {
  const html = languageNotesHtml({ pageLang: ORIGINAL, pathname: '/week-01/1-1/', shared: SHARED });
  const { ui } = stringsFor(OTHER);

  test('one note per other language, hidden until the script picks it, and not indexed by the search', () => {
    assert.equal(html.match(/<aside /g)?.length, LOCALES.length - 1);
    assert.ok(html.startsWith(`<aside class="language-note" lang="${OTHER}" data-language-note="${OTHER}" data-pagefind-ignore hidden>`));
    assert.ok(!html.includes(`data-language-note="${ORIGINAL}"`));
  });

  test('is written in the other language and links to the same page there', () => {
    assert.ok(html.includes(ui.languageNoteText));
    assert.ok(html.includes(`<a href="${localizePath('/week-01/1-1/', OTHER)}" hreflang="${OTHER}" data-language-note-link>${ui.languageNoteLink}</a>`));
    assert.ok(html.includes(`data-language-note-close aria-label="${ui.close}"`));
  });

  test('a page in the translation gets a note in the original', () => {
    const back = languageNotesHtml({ pageLang: OTHER, pathname: localizePath('/plan/', OTHER), shared: SHARED });
    assert.ok(back.includes(`data-language-note="${ORIGINAL}"`));
    assert.ok(back.includes(stringsFor(ORIGINAL).ui.languageNoteText));
    assert.ok(back.includes('<a href="/plan/"'));
  });

  test('has no ids and no inline handlers (CSP)', () => {
    assert.doesNotMatch(html, /\sid="|\son\w+=/);
  });
});

describe('language note on the page', () => {
  test('PageFrame renders the notes above the page content with the shared page list', () => {
    const frame = read('../../src/components/PageFrame.astro');
    assert.match(frame, /languageNotesHtml\(\{ pageLang: strings\.lang, pathname: current, shared: i18n\.shared \}\)/);
    assert.ok(frame.indexOf('{languageNotes}') < frame.indexOf('<slot />\n</Default>'));
  });

  test('its stylesheet is loaded and keeps the hidden note hidden', () => {
    assert.match(read('../../astro.config.mjs'), /'\.\/src\/styles\/language-note\.css'/);
    assert.match(read('../../src/styles/language-note.css'), /\.language-note\[hidden\] \{ display: none; \}/);
  });

  test('the page script starts it before waiting for the progress', () => {
    const main = read('../../src/scripts/main.ts');
    assert.ok(main.indexOf('initLanguageChoice();') < main.indexOf('await P.load();'));
  });

  test('the switch, the link and the close button remember the choice', () => {
    const ui = read('../../src/scripts/language/language-ui.ts');
    assert.match(ui, /starlight-lang-select/);
    assert.match(ui, /addEventListener\('change', [\s\S]*?remember\(splitLocale\(e\.target\.value\)\.lang\)[\s\S]*?\}, true\)/);
    assert.match(ui, /\[data-language-note-link\][\s\S]*?remember\(target\)/);
    assert.match(ui, /\[data-language-note-close\][\s\S]*?remember\(lang\)/);
  });
});
