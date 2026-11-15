// Tests for the extra <head> tags (preview image, search-console tokens) and their settings.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { describe, test } from 'node:test';
import { APPLE_TOUCH_ICON, FAVICON_ICO, OG_IMAGE } from '../../src/config/app.mjs';
import { publicToken } from '../../src/config/server.mjs';
import strings from '../../src/locales/ru.json' with { type: 'json' };
import { iconHead, seoHead } from '../../src/head/seo-head.mjs';

const SITE = 'https://cookbook.example.com/';
const imageAlt = strings.site.ogImageAlt;
const content = (head, key, value) => head.find((e) => e.attrs[key] === value)?.attrs.content;

describe('seoHead', () => {
  test('with the public address, the preview image is an absolute URL with its size and alt text', () => {
    const head = seoHead({ site: SITE, imageAlt });
    assert.equal(content(head, 'property', 'og:image'), `https://cookbook.example.com${OG_IMAGE.path}`);
    assert.equal(content(head, 'name', 'twitter:image'), `https://cookbook.example.com${OG_IMAGE.path}`);
    assert.equal(content(head, 'property', 'og:image:width'), String(OG_IMAGE.width));
    assert.equal(content(head, 'property', 'og:image:height'), String(OG_IMAGE.height));
    assert.equal(content(head, 'property', 'og:image:alt'), imageAlt);
    assert.ok(head.every((e) => e.tag === 'meta'));
  });

  test('a local build (no public address) gets no image tags', () => {
    assert.deepEqual(seoHead({ imageAlt }), []);
  });

  test('ownership tokens appear only when set', () => {
    const head = seoHead({ imageAlt, googleSiteVerification: 'g-token_1', yandexVerification: 'abc123' });
    assert.equal(content(head, 'name', 'google-site-verification'), 'g-token_1');
    assert.equal(content(head, 'name', 'yandex-verification'), 'abc123');
    assert.equal(seoHead({ site: SITE, imageAlt }).some((e) => /verification/.test(e.attrs.name ?? '')), false);
  });

  test('the preview image exists in public/ with the declared size', () => {
    const png = fs.readFileSync(new URL(`../../public${OG_IMAGE.path}`, import.meta.url));
    assert.equal(png.toString('ascii', 1, 4), 'PNG');
    // IHDR: width and height are the first two 32-bit fields after the 16-byte header
    assert.equal(png.readUInt32BE(16), OG_IMAGE.width);
    assert.equal(png.readUInt32BE(20), OG_IMAGE.height);
  });
});

describe('icons', () => {
  const file = (p) => fs.readFileSync(new URL(`../../public${p}`, import.meta.url));

  test('the iOS home-screen icon is linked from every page', () => {
    assert.deepEqual(iconHead(), [{ tag: 'link', attrs: { rel: 'apple-touch-icon', href: APPLE_TOUCH_ICON.path } }]);
  });

  test('the iOS icon is an opaque square PNG of the declared size', () => {
    const png = file(APPLE_TOUCH_ICON.path);
    assert.equal(png.toString('ascii', 1, 4), 'PNG');
    assert.equal(png.readUInt32BE(16), APPLE_TOUCH_ICON.size);
    assert.equal(png.readUInt32BE(20), APPLE_TOUCH_ICON.size);
    // IHDR colour type 2 = RGB without alpha: iOS paints transparent corners black
    assert.equal(png[25], 2);
  });

  test('favicon.ico is an icon file of the declared size', () => {
    const ico = file(FAVICON_ICO.path);
    // ICONDIR: reserved 0, type 1 (icon), at least one image; the first entry holds width and height
    assert.equal(ico.readUInt16LE(0), 0);
    assert.equal(ico.readUInt16LE(2), 1);
    assert.ok(ico.readUInt16LE(4) >= 1);
    assert.equal(ico[6], FAVICON_ICO.size);
    assert.equal(ico[7], FAVICON_ICO.size);
  });
});

describe('publicToken', () => {
  test('empty means not set', () => {
    assert.equal(publicToken('X', ''), undefined);
    assert.equal(publicToken('X', undefined), undefined);
  });

  test('a token is kept as is', () => {
    assert.equal(publicToken('X', 'AbC-12_x'), 'AbC-12_x');
  });

  test('anything that could break out of the attribute is refused', () => {
    assert.throws(() => publicToken('YANDEX_VERIFICATION', 'a"><script>'), /YANDEX_VERIFICATION/);
    assert.throws(() => publicToken('X', '<meta name="x">'), /X must/);
  });
});
