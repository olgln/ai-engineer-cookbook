// The route middleware's head fixes (src/head/localized-head.mjs): hreflang only between real counterparts,
// and the preview image, its text and og:locale in the page's language.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { localizedHead } from '../../src/head/localized-head.mjs';

const head = () => [
  { tag: 'link', attrs: { rel: 'canonical', href: 'https://x.example/en/week-01/1-1/' } },
  { tag: 'link', attrs: { rel: 'alternate', hreflang: 'ru', href: 'https://x.example/week-01/1-1/' } },
  { tag: 'link', attrs: { rel: 'alternate', hreflang: 'en', href: 'https://x.example/en/week-01/1-1/' } },
  { tag: 'link', attrs: { rel: 'alternate', hreflang: 'x-default', href: 'https://x.example/week-01/1-1/' } },
  { tag: 'link', attrs: { rel: 'alternate', type: 'application/rss+xml', href: '/rss.xml' } },
  { tag: 'meta', attrs: { property: 'og:locale', content: 'en' } },
  { tag: 'meta', attrs: { property: 'og:image', content: 'https://x.example/og-image.png' } },
  { tag: 'meta', attrs: { name: 'twitter:image', content: 'https://x.example/og-image.png' } },
  { tag: 'meta', attrs: { property: 'og:image:alt', content: 'Учебник' } },
  { tag: 'meta', attrs: { name: 'twitter:image:alt', content: 'Учебник' } },
  { tag: 'meta', attrs: { name: 'description', content: 'Учебник' } },
];
const EN = { imageAlt: 'Cookbook', image: '/og-image.en.png', ogLocale: 'en_US' };
const hreflangs = (h) => h.filter((e) => e.attrs?.hreflang).map((e) => e.attrs.hreflang);

describe('localizedHead', () => {
  test('a page every language has keeps its hreflang links, in either language', () => {
    assert.deepEqual(hreflangs(localizedHead(head(), '/en/week-01/1-1/', ['/week-01/1-1/'], EN)), ['ru', 'en', 'x-default']);
    assert.deepEqual(hreflangs(localizedHead(head(), '/week-01/1-1/', ['/week-01/1-1/'], EN)), ['ru', 'en', 'x-default']);
    assert.deepEqual(hreflangs(localizedHead(head(), '/en/week-01/1-1', ['/week-01/1-1/'], EN)), ['ru', 'en', 'x-default'], 'no trailing slash');
  });

  test('an untranslated chapter loses them on both sides; other alternate links stay', () => {
    for (const p of ['/en/week-01/1-4/', '/week-01/1-4/']) {
      const out = localizedHead(head(), p, ['/week-01/1-1/'], EN);
      assert.deepEqual(hreflangs(out), [], p);
      assert.ok(out.some((e) => e.attrs?.type === 'application/rss+xml'));
      assert.ok(out.some((e) => e.attrs?.rel === 'canonical'));
    }
  });

  test('the preview image, its text and og:locale follow the page language; other tags are untouched', () => {
    const out = localizedHead(head(), '/en/', ['/'], EN);
    const meta = (key) => out.find((e) => e.attrs?.property === key || e.attrs?.name === key)?.attrs?.content;
    assert.equal(meta('og:image'), 'https://x.example/og-image.en.png');
    assert.equal(meta('twitter:image'), 'https://x.example/og-image.en.png');
    assert.equal(meta('og:image:alt'), 'Cookbook');
    assert.equal(meta('twitter:image:alt'), 'Cookbook');
    assert.equal(meta('og:locale'), 'en_US');
    assert.equal(meta('description'), 'Учебник');
  });

  test('a local build without the preview image gets none added', () => {
    const isImage = (e) => /^(og|twitter):image$/.test(String(e.attrs?.property ?? e.attrs?.name));
    const local = head().filter((e) => !isImage(e));
    const out = localizedHead(local, '/en/', ['/'], EN);
    assert.equal(out.some(isImage), false);
    assert.equal(out.length, local.length);
  });

  test('the input is not changed', () => {
    const h = head();
    localizedHead(h, '/en/week-01/1-4/', [], EN);
    assert.deepEqual(h, head());
  });
});
