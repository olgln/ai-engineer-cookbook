// Tests for adding inline-script hashes to the CSP <meta> tag after the build.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { describe, test } from 'node:test';
import { addInlineScriptHashes, inlineScriptHashes } from '../src/integrations/csp-inline-hashes.mjs';

const hash = (code) => `'sha256-${crypto.createHash('sha256').update(code).digest('base64')}'`;
const meta = (content) => `<meta http-equiv="content-security-policy" content="${content}">`;
const page = (csp, body) => `<html><head>${meta(csp)}</head><body>${body}</body></html>`;
const cspOf = (html) => html.match(/content="([^"]*)"/)[1];

describe('inlineScriptHashes', () => {
  test('hashes executable inline scripts once each, skips external and data scripts', () => {
    const html = [
      '<script>a()</script>',
      '<script type="module">b()</script>',
      '<script aria-hidden="true">a()</script>',
      '<script src="/x.js"></script>',
      '<script type="application/ld+json">{"a":1}</script>',
      '<script></script>',
    ].join('');
    assert.deepEqual(inlineScriptHashes(html), [hash('a()'), hash('b()')]);
  });
});

describe('addInlineScriptHashes', () => {
  test('appends the missing hashes to script-src and keeps the other directives', () => {
    const csp = `default-src 'self'; script-src 'self' ${hash('known()')}; style-src 'self' 'unsafe-inline' ;`;
    const out = addInlineScriptHashes(page(csp, '<script>known()</script><script>theme()</script>'));
    assert.equal(cspOf(out), `default-src 'self'; script-src 'self' ${hash('known()')} ${hash('theme()')}; style-src 'self' 'unsafe-inline' ;`);
  });

  test('a page whose inline scripts are all listed is unchanged', () => {
    const html = page(`script-src 'self' ${hash('a()')}`, '<script>a()</script>');
    assert.equal(addInlineScriptHashes(html), html);
  });

  test('a page without a CSP meta or without script-src is unchanged', () => {
    const plain = '<html><body><script>a()</script></body></html>';
    assert.equal(addInlineScriptHashes(plain), plain);
    const noScriptSrc = page("default-src 'self'", '<script>a()</script>');
    assert.equal(addInlineScriptHashes(noScriptSrc), noScriptSrc);
  });
});
