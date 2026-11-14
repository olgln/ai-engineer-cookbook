// Tests for the Cloudflare Web Analytics beacon and the CSP origins it needs.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { CSP, WEB_ANALYTICS } from '../src/config/app.mjs';
import { publicToken } from '../src/config/server.mjs';
import { webAnalyticsHead, withWebAnalytics } from '../src/components/web-analytics.mjs';

const TOKEN = 'd84a843ffcb545ad8f23258d4b544428';
const connectSrc = (csp) => csp.directives.find((d) => d.startsWith('connect-src'));

describe('webAnalyticsHead', () => {
  test('without a token the pages get no beacon', () => {
    assert.deepEqual(webAnalyticsHead(undefined), []);
    assert.deepEqual(webAnalyticsHead(''), []);
  });

  test('with a token the pages load the beacon as a module and pass it the token', () => {
    const [entry, ...rest] = webAnalyticsHead(TOKEN);
    assert.deepEqual(rest, []);
    assert.equal(entry.tag, 'script');
    assert.equal(entry.attrs.type, 'module');
    assert.equal(entry.attrs.src, WEB_ANALYTICS.scriptUrl);
    assert.deepEqual(JSON.parse(entry.attrs['data-cf-beacon']), { token: TOKEN });
  });

  test('the beacon is served from the origin the CSP allows', () => {
    assert.equal(new URL(WEB_ANALYTICS.scriptUrl).origin, WEB_ANALYTICS.scriptOrigin);
  });
});

describe('withWebAnalytics', () => {
  test('without a token the CSP stays same-origin only', () => {
    assert.equal(withWebAnalytics(CSP, undefined), CSP);
    const all = [...CSP.scriptSources, ...CSP.directives].join(' ');
    assert.doesNotMatch(all, /cloudflareinsights/);
  });

  test('with a token the beacon script and its reports are allowed, nothing else changes', () => {
    const csp = withWebAnalytics(CSP, TOKEN);
    assert.deepEqual(csp.scriptSources, [...CSP.scriptSources, WEB_ANALYTICS.scriptOrigin]);
    assert.equal(connectSrc(csp), `${connectSrc(CSP)} ${WEB_ANALYTICS.reportOrigin}`);
    assert.deepEqual(
      csp.directives.filter((d) => !d.startsWith('connect-src')),
      CSP.directives.filter((d) => !d.startsWith('connect-src')),
    );
    assert.deepEqual(csp.styleSources, CSP.styleSources);
  });

  test('the shared CSP constant is not modified', () => {
    const before = structuredClone(CSP);
    withWebAnalytics(CSP, TOKEN);
    assert.deepEqual(CSP, before);
  });
});

describe('CLOUDFLARE_WEB_ANALYTICS_TOKEN', () => {
  test('a Cloudflare site token is accepted as is', () => {
    assert.equal(publicToken('CLOUDFLARE_WEB_ANALYTICS_TOKEN', TOKEN), TOKEN);
  });

  test('a value that could break out of the JSON attribute is refused', () => {
    assert.throws(
      () => publicToken('CLOUDFLARE_WEB_ANALYTICS_TOKEN', `${TOKEN}"}'><script>`),
      /CLOUDFLARE_WEB_ANALYTICS_TOKEN/,
    );
  });
});
