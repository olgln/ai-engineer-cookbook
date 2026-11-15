// Tests for the pages the Worker sees (worker/lib/pages.mjs through worker/index.mjs): the home page sends a
// new reader to their browser's language, otherwise it is the static page from the ASSETS binding with the
// security headers; caches are told the answer depends on the language headers.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  DEFAULT_LOCALE, HTTPS_ONLY_HEADERS, LANGUAGE_COOKIE, LANGUAGE_REDIRECT_PATHS, LOCALES, ME_API_PATH, SECURITY_HEADERS,
} from '../../src/config/app.mjs';
import { localizePath } from '../../src/locales/locales.mjs';
import worker from '../../worker/index.mjs';
import { LANGUAGE_VARY } from '../../worker/lib/pages.mjs';
import { createD1 } from '../helpers/d1.mjs';
import { ORIGIN } from '../helpers/oauth.mjs';

const OTHER = LOCALES.find((l) => l.lang !== DEFAULT_LOCALE.lang).lang;
const [HOME] = LANGUAGE_REDIRECT_PATHS;
const BROWSER = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36';
const PAGE = '<!doctype html><title>home</title>';

/** A stand-in for the ASSETS binding: answers every request with PAGE and records the requested paths. */
function fakeAssets() {
  const seen = [];
  return {
    seen,
    fetch: async (request) => {
      seen.push(new URL(request.url).pathname);
      return new Response(request.method === 'HEAD' ? null : PAGE, {
        headers: { 'Content-Type': 'text/html', 'Cache-Control': 'public, max-age=0, must-revalidate', Vary: 'Accept-Encoding' },
      });
    },
  };
}

function visit(path, { headers = {}, method = 'GET', assets = fakeAssets() } = {}) {
  const request = new Request(ORIGIN + path, { method, headers: { 'User-Agent': BROWSER, ...headers } });
  return worker.fetch(request, { ASSETS: assets, DB: createD1() });
}

describe('home page language', () => {
  test('a browser in another site language is sent to its home page, without caching', async () => {
    const res = await visit(HOME, { headers: { 'Accept-Language': `${OTHER}-US,${OTHER};q=0.9` } });
    assert.equal(res.status, 302);
    assert.equal(res.headers.get('Location'), localizePath('/', OTHER));
    assert.equal(res.headers.get('Vary'), LANGUAGE_VARY);
    assert.equal(res.headers.get('Cache-Control'), 'no-store');
  });

  test('the query string goes along (e.g. a failed sign-in landing)', async () => {
    const res = await visit(`${HOME}?login_error=1`, { headers: { 'Accept-Language': OTHER } });
    assert.equal(res.headers.get('Location'), `${localizePath('/', OTHER)}?login_error=1`);
  });

  test('HEAD is redirected like GET', async () => {
    const res = await visit(HOME, { method: 'HEAD', headers: { 'Accept-Language': OTHER } });
    assert.equal(res.status, 302);
  });

  test('a reader who chose the original gets the page itself, marked as language-dependent', async () => {
    const assets = fakeAssets();
    const res = await visit(HOME, {
      assets, headers: { 'Accept-Language': OTHER, Cookie: `${LANGUAGE_COOKIE}=${DEFAULT_LOCALE.lang}` },
    });
    assert.equal(res.status, 200);
    assert.equal(await res.text(), PAGE);
    assert.deepEqual(assets.seen, [HOME]);
    assert.equal(res.headers.get('Vary'), `Accept-Encoding, ${LANGUAGE_VARY}`);
    assert.equal(res.headers.get('Cache-Control'), 'public, max-age=0, must-revalidate');
  });

  test('the page passing through the Worker keeps the security headers of dist/_headers', async () => {
    const res = await visit(HOME, { headers: { 'Accept-Language': DEFAULT_LOCALE.lang } });
    assert.equal(res.status, 200);
    for (const [name, value] of Object.entries({ ...SECURITY_HEADERS, ...HTTPS_ONLY_HEADERS })) {
      assert.equal(res.headers.get(name), value, name);
    }
  });

  test('crawlers and requests without Accept-Language see the original', async () => {
    assert.equal((await visit(HOME)).status, 200);
    const bot = await visit(HOME, { headers: { 'Accept-Language': OTHER, 'User-Agent': 'Mozilla/5.0 (compatible; bingbot/2.0)' } });
    assert.equal(bot.status, 200);
  });

  test('other methods are never redirected', async () => {
    const res = await visit(HOME, { method: 'POST', headers: { 'Accept-Language': OTHER } });
    assert.equal(res.status, 200);
  });

  test('another page reaching the Worker is served as is, without the language Vary', async () => {
    const assets = fakeAssets();
    const res = await visit('/plan/', { assets, headers: { 'Accept-Language': OTHER } });
    assert.equal(res.status, 200);
    assert.deepEqual(assets.seen, ['/plan/']);
    assert.equal(res.headers.get('Vary'), 'Accept-Encoding');
  });

  test('API paths still go to the API, never to the assets', async () => {
    const assets = fakeAssets();
    const res = await visit(ME_API_PATH, { assets, headers: { 'Accept-Language': OTHER } });
    assert.equal(res.status, 401);
    assert.deepEqual(assets.seen, []);
  });
});
