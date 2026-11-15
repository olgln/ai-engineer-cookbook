// The route middleware's head fixes (src/head/localized-head.mjs): hreflang only between real counterparts,
// and the preview image text in the page's language.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { localizedHead } from '../../src/head/localized-head.mjs';

const head = () => [
  { tag: 'link', attrs: { rel: 'canonical', href: 'https://x.example/en/week-01/1-1/' } },
  { tag: 'link', attrs: { rel: 'alternate', hreflang: 'ru', href: 'https://x.example/week-01/1-1/' } },
  { tag: 'link', attrs: { rel: 'alternate', hreflang: 'en', href: 'https://x.example/en/week-01/1-1/' } },
  { tag: 'link', attrs: { rel: 'alternate', hreflang: 'x-default', href: 'https://x.example/week-01/1-1/' } },
  { tag: 'link', attrs: { rel: 'alternate', type: 'application/rss+xml', href: '/rss.xml' } },
  { tag: 'meta', attrs: { property: 'og:image:alt', content: 'Учебник' } },
  { tag: 'meta', attrs: { name: 'twitter:image:alt', content: 'Учебник' } },
  { tag: 'meta', attrs: { name: 'description', content: 'Учебник' } },
];
const hreflangs = (h) => h.filter((e) => e.attrs?.hreflang).map((e) => e.attrs.hreflang);

describe('localizedHead', () => {
  test('a page every language has keeps its hreflang links, in either language', () => {
    assert.deepEqual(hreflangs(localizedHead(head(), '/en/week-01/1-1/', ['/week-01/1-1/'], 'Cookbook')), ['ru', 'en', 'x-default']);
    assert.deepEqual(hreflangs(localizedHead(head(), '/week-01/1-1/', ['/week-01/1-1/'], 'Cookbook')), ['ru', 'en', 'x-default']);
    assert.deepEqual(hreflangs(localizedHead(head(), '/en/week-01/1-1', ['/week-01/1-1/'], 'Cookbook')), ['ru', 'en', 'x-default'], 'no trailing slash');
  });

  test('an untranslated chapter loses them on both sides; other alternate links stay', () => {
    for (const p of ['/en/week-01/1-4/', '/week-01/1-4/']) {
      const out = localizedHead(head(), p, ['/week-01/1-1/'], 'Cookbook');
      assert.deepEqual(hreflangs(out), [], p);
      assert.ok(out.some((e) => e.attrs?.type === 'application/rss+xml'));
      assert.ok(out.some((e) => e.attrs?.rel === 'canonical'));
    }
  });

  test('the preview image text follows the page language; other tags are untouched', () => {
    const out = localizedHead(head(), '/en/', ['/'], 'Cookbook');
    assert.equal(out.find((e) => e.attrs?.property === 'og:image:alt')?.attrs?.content, 'Cookbook');
    assert.equal(out.find((e) => e.attrs?.name === 'twitter:image:alt')?.attrs?.content, 'Cookbook');
    assert.equal(out.find((e) => e.attrs?.name === 'description')?.attrs?.content, 'Учебник');
  });

  test('the input is not changed', () => {
    const h = head();
    localizedHead(h, '/en/week-01/1-4/', [], 'Cookbook');
    assert.deepEqual(h, head());
  });
});
