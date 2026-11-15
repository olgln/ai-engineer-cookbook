// Tests for the site footer text.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import strings from '../../src/locales/ru.json' with { type: 'json' };
import { PRIVACY_PATH } from '../../src/config/app.mjs';
import { copyrightLine, footerLinks } from '../../src/components/footer.mjs';

test('the footer shows the copyright sign, the given year and the site title', () => {
  const line = copyrightLine(strings, 2031);
  assert.ok(line.startsWith('©'));
  assert.ok(line.includes('2031'));
  assert.ok(line.includes(strings.site.title));
  assert.ok(!/\{\w+\}/.test(line), 'no unfilled placeholders');
});

test('the footer links to the privacy policy', () => {
  assert.deepEqual(footerLinks(strings), [{ href: PRIVACY_PATH, label: strings.footer.privacy }]);
  assert.ok(strings.footer.privacy.trim());
});

test('every page frame renders the footer links', () => {
  const frame = fs.readFileSync(new URL('../../src/components/PageFrame.astro', import.meta.url), 'utf8');
  assert.match(frame, /const links = footerLinks\(strings\);/);
  assert.match(frame, /<footer class="site-footer[^"]*">[\s\S]*links\.map\(\(\{ href, label \}\) => \([\s\S]*<a href=\{href\}/);
});
