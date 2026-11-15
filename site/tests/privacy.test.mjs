// Tests for the privacy policy page (scripts/lib/render.mjs, renderPrivacy): the sections, the analytics
// section follows the build, the button labels, the contact placeholder, the date, and the page is public
// (in the sitemap, out of the sidebar).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { describe, test } from 'node:test';
import { PRIVACY_CONTACT, PRIVACY_PATH, PRIVACY_POLICY_DATE, SITEMAP_EXCLUDED_PATHS } from '../src/config/app.mjs';
import { format } from '../src/locales/format.mjs';
import strings from '../src/locales/ru.json' with { type: 'json' };
import { contactMarkdown, createRenderer, longDate, parseToc, PRIVACY_SECTIONS } from '../scripts/lib/render.mjs';

const { privacy, ui, book } = strings;
const TOC = [`## ${book.weekHeading} 1 · Basics`, '', '- [1.1 · Python](AIL-1.md)'].join('\n');
const renderer = () => createRenderer(parseToc(TOC));
const page = (options) => renderer().renderPrivacy(options);
const read = (rel) => fs.readFileSync(new URL(rel, import.meta.url), 'utf8');

describe('privacy page', () => {
  test('has the title, the search description and no edit link or pagination', () => {
    const text = page();
    assert.ok(text.startsWith(`---\ntitle: ${JSON.stringify(privacy.title)}\ndescription: ${JSON.stringify(privacy.description)}\n`));
    assert.match(text, /\neditUrl: false\nprev: false\nnext: false\n---\n/);
    assert.ok(privacy.description.length <= 160, 'search engines cut longer descriptions');
    assert.doesNotMatch(text, /noindex|pagefind: false/, 'a public page');
  });

  test('every section of ru.json is rendered, in order, and the analytics one only with the beacon', () => {
    assert.deepEqual([...PRIVACY_SECTIONS].sort(), Object.keys(privacy.sections).sort());
    const headings = (text) => [...text.matchAll(/^## (.+)$/gm)].map((m) => m[1]);
    const all = PRIVACY_SECTIONS.map((key) => privacy.sections[key].heading);
    assert.deepEqual(headings(page({ analytics: true })), all);
    assert.deepEqual(headings(page()), all.filter((h) => h !== privacy.sections.analytics.heading));
    assert.ok(!page().includes(privacy.sections.analytics.blocks[0]));
  });

  test('stays short: no hosting, database or cookie-name details', () => {
    const text = page({ analytics: true });
    assert.doesNotMatch(text, /Cloudflare|D1|__Host-|localStorage|SHA-256/);
    assert.ok(PRIVACY_SECTIONS.length <= 6);
  });

  test('uses the label of the delete button and leaves no placeholder unfilled', () => {
    const text = page({ analytics: true });
    assert.ok(text.includes(`«${ui.deleteAccount}»`));
    assert.doesNotMatch(text, /\{\w+\}/);
  });

  test('a text block is rendered as a paragraph', () => {
    const text = page();
    assert.ok(text.includes(`\n${privacy.sections.withoutAccount.blocks[0]}\n`));
    assert.ok(text.endsWith('\n') && !text.endsWith('\n\n'));
  });

  test('an empty contact shows the placeholder; a filled one is shown instead', () => {
    assert.equal(PRIVACY_CONTACT, PRIVACY_CONTACT.trim());
    const empty = page({ contact: '' });
    assert.ok(empty.includes(`_${privacy.contactPlaceholder}_`));
    const filled = page({ contact: 'privacy@example.com' });
    assert.ok(filled.includes('[privacy@example.com](mailto:privacy@example.com)'));
    assert.ok(!filled.includes(privacy.contactPlaceholder));
  });

  test('shows the policy date in words; a broken date is a build warning', () => {
    const r = renderer();
    assert.ok(r.renderPrivacy({ date: '2026-11-14' }).includes(`_${format(privacy.updated, { date: longDate('2026-11-14') })}_`));
    assert.deepEqual(r.warnings, []);
    assert.ok(longDate(PRIVACY_POLICY_DATE), 'the configured date is valid');
    r.renderPrivacy({ date: '14.11.2026' });
    assert.deepEqual(r.warnings, ['privacy policy date "14.11.2026" is not a YYYY-MM-DD date']);
  });

  test('is in the sitemap and out of the sidebar', () => {
    assert.ok(!SITEMAP_EXCLUDED_PATHS.includes(PRIVACY_PATH));
    assert.ok(!JSON.stringify(renderer().sidebar()).includes(PRIVACY_PATH));
  });

  test('the converter writes the page and turns the analytics section on from the build settings', () => {
    const convert = read('../scripts/convert.mjs');
    assert.match(convert, /PRIVACY_PATH\.replaceAll\('\/', ''\)\}\.md`\), r\.renderPrivacy\(\{ analytics: Boolean\(config\.webAnalyticsToken\) \}\)\)/);
  });
});

describe('contactMarkdown', () => {
  test('e-mail → mailto link, https address → link, other text escaped, empty → placeholder', () => {
    assert.equal(contactMarkdown('a.b@example.com'), '[a.b@example.com](mailto:a.b@example.com)');
    assert.equal(contactMarkdown(' https://t.me/someone '), '[https://t.me/someone](https://t.me/someone)');
    assert.equal(contactMarkdown('<b>*x*</b>'), '&lt;b&gt;\\*x\\*&lt;/b&gt;');
    assert.equal(contactMarkdown('http://plain.example'), 'http://plain.example');
    assert.equal(contactMarkdown('  '), `_${privacy.contactPlaceholder}_`);
  });
});

describe('longDate', () => {
  test('formats real dates only', () => {
    assert.match(longDate('2026-11-14'), /^14 \S+ 2026/);
    for (const bad of ['2026-02-30', '2026-11-4', 'today', '']) assert.equal(longDate(bad), null, bad);
  });
});
