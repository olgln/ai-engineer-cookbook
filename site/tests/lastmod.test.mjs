// Tests for the page dates in the sitemap (scripts/lib/lastmod.mjs).
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { GIT_LOG_ARGS, pageDates, parseGitLog, withLastmod } from '../scripts/lib/lastmod.mjs';

// What `git log --format=%x00%cI --name-only` prints: newest commit first, a blank line before the files.
const LOG = [
  '\0' + '2026-11-14T20:00:00+03:00', '', 'book/AIL-1.md', 'README.md', '',
  '\0' + '2026-11-10T09:00:00+03:00', '', 'book/AIL-1.md', 'book/AIL-56.md', '',
  // a merge commit lists no files
  '\0' + '2026-11-09T09:00:00+03:00', '',
  '\0' + '2026-11-01T09:00:00+03:00', '', 'book/README.md', '',
].join('\n');

describe('parseGitLog', () => {
  test('each file gets the date of its newest commit', () => {
    assert.deepEqual(Object.fromEntries(parseGitLog(LOG)), {
      'book/AIL-1.md': '2026-11-14T20:00:00+03:00',
      'README.md': '2026-11-14T20:00:00+03:00',
      'book/AIL-56.md': '2026-11-10T09:00:00+03:00',
      'book/README.md': '2026-11-01T09:00:00+03:00',
    });
  });

  test('empty output gives no dates', () => {
    assert.equal(parseGitLog('').size, 0);
  });

  test('the arguments ask for the record format the parser reads', () => {
    assert.deepEqual(GIT_LOG_ARGS, ['log', '--format=%x00%cI', '--name-only', '--']);
  });
});

describe('pageDates', () => {
  test('pages get the date of their source; pages without a commit are left out', () => {
    const pages = [
      { href: '/', source: 'book/README.md' },
      { href: '/week-01/1-1/', source: 'book/AIL-1.md' },
      { href: '/week-09/9-9/', source: 'book/AIL-99.md' },
    ];
    assert.deepEqual(pageDates(pages, parseGitLog(LOG)), {
      '/': '2026-11-01T09:00:00+03:00',
      '/week-01/1-1/': '2026-11-14T20:00:00+03:00',
    });
  });
});

describe('withLastmod', () => {
  const dates = { '/week-01/1-1/': '2026-11-14T20:00:00+03:00' };

  test('a known page gets its date by path, whatever the host', () => {
    assert.deepEqual(withLastmod({ url: 'https://cookbook.example.com/week-01/1-1/' }, dates), {
      url: 'https://cookbook.example.com/week-01/1-1/',
      lastmod: '2026-11-14T20:00:00+03:00',
    });
  });

  test('an unknown page is kept as is', () => {
    const item = { url: 'https://cookbook.example.com/plan/' };
    assert.equal(withLastmod(item, dates), item);
  });
});
