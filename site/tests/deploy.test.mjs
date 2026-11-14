// Tests for the hosting files written next to the build (_headers, robots.txt) and the SITE_URL setting.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  HTTPS_ONLY_HEADERS, IMMUTABLE_ASSETS_GLOB, IMMUTABLE_CACHE_CONTROL, SECURITY_HEADERS, SITEMAP_FILE,
} from '../src/config/app.mjs';
import { siteUrl } from '../src/config/server.mjs';
import { headersFile, robotsTxt } from '../src/integrations/deploy-files.mjs';

describe('_headers', () => {
  const text = headersFile();
  const [all, assets] = text.trimEnd().split('\n\n');

  test('every path gets the security headers and HSTS', () => {
    assert.match(all, /^\/\*\n/);
    for (const [name, value] of Object.entries({ ...SECURITY_HEADERS, ...HTTPS_ONLY_HEADERS })) {
      assert.ok(all.includes(`\n  ${name}: ${value}`), `${name} is set`);
    }
  });

  test('hashed assets are cached as immutable', () => {
    assert.equal(assets, `${IMMUTABLE_ASSETS_GLOB}\n  Cache-Control: ${IMMUTABLE_CACHE_CONTROL}`);
  });

  test('the page CSP forbids framing the site', () => {
    assert.match(SECURITY_HEADERS['Content-Security-Policy'], /frame-ancestors 'none'/);
  });

  test('old browsers are kept from framing the site too', () => {
    assert.equal(SECURITY_HEADERS['X-Frame-Options'], 'DENY');
    assert.ok(all.includes('\n  X-Frame-Options: DENY'));
  });

  test('other sites cannot embed our files', () => {
    assert.equal(SECURITY_HEADERS['Cross-Origin-Resource-Policy'], 'same-origin');
    assert.ok(all.includes('\n  Cross-Origin-Resource-Policy: same-origin'));
  });
});

describe('robots.txt', () => {
  test('without a public address it has no sitemap line', () => {
    assert.equal(robotsTxt(undefined), 'User-agent: *\nAllow: /\n');
  });

  test('with a public address it points to the sitemap', () => {
    assert.match(robotsTxt('https://cookbook.example.com/'), new RegExp(`\nSitemap: https://cookbook\\.example\\.com/${SITEMAP_FILE}\n$`));
  });
});

describe('SITE_URL', () => {
  test('empty means a local build', () => {
    assert.equal(siteUrl(''), undefined);
    assert.equal(siteUrl(undefined), undefined);
  });

  test('an absolute http(s) address is normalized', () => {
    assert.equal(siteUrl('https://cookbook.example.com'), 'https://cookbook.example.com/');
  });

  test('a relative or non-http address is rejected', () => {
    assert.throws(() => siteUrl('cookbook.example.com'), /SITE_URL/);
    assert.throws(() => siteUrl('ftp://cookbook.example.com'), /SITE_URL/);
  });
});
