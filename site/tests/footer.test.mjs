// Tests for the site footer text.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import strings from '../src/locales/ru.json' with { type: 'json' };
import { copyrightLine } from '../src/components/footer.mjs';

test('the footer shows the copyright sign, the given year and the site title', () => {
  const line = copyrightLine(strings, 2031);
  assert.ok(line.startsWith('©'));
  assert.ok(line.includes('2031'));
  assert.ok(line.includes(strings.site.title));
  assert.ok(!/\{\w+\}/.test(line), 'no unfilled placeholders');
});
