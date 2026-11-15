// Tests for the decisions of the header account menu (src/scripts/account/account.mjs): what an answer of
// GET /api/me shows, the sign-in links, and where the menu panel opens.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { AUTH_API_PREFIX, AUTH_PROVIDERS, RETURN_TO_PARAM } from '../../src/config/app.mjs';
import { safeReturnTo } from '../../worker/lib/oauth.mjs';
import { accountState, PANEL_GAP, PANEL_MARGIN, panelPosition, progressNote, signInHref } from '../../src/scripts/account/account.mjs';

const JSON_TYPE = 'application/json; charset=utf-8';

describe('accountState', () => {
  test('signed in: the providers of the reader, in the site order', () => {
    assert.deepEqual(accountState(200, JSON_TYPE, { providers: ['github', 'google'] }),
      { state: 'in', providers: ['google', 'github'] });
  });

  test('signed out with providers set up: the sign-in buttons to show', () => {
    assert.deepEqual(accountState(401, JSON_TYPE, { error: 'unauthorized', available: ['google'] }),
      { state: 'out', available: ['google'] });
  });

  test('signed out with no provider set up: nothing to offer, the menu stays hidden', () => {
    assert.deepEqual(accountState(401, JSON_TYPE, { available: [] }), { state: 'hidden' });
    assert.deepEqual(accountState(401, JSON_TYPE, {}), { state: 'hidden' });
  });

  test('no account API (local server, static hosting, error): hidden', () => {
    assert.deepEqual(accountState(404, 'text/html', null), { state: 'hidden' });
    assert.deepEqual(accountState(200, 'text/html', null), { state: 'hidden' }, 'an HTML page served for /api/me');
    assert.deepEqual(accountState(500, JSON_TYPE, { error: 'x' }), { state: 'hidden' });
    assert.deepEqual(accountState(200, null, { providers: ['google'] }), { state: 'hidden' });
    assert.deepEqual(accountState(200, JSON_TYPE, null), { state: 'hidden' });
  });

  test('provider names the site does not know are dropped', () => {
    assert.deepEqual(accountState(401, JSON_TYPE, { available: ['google', 'evil<script>'] }), { state: 'out', available: ['google'] });
    assert.deepEqual(accountState(200, JSON_TYPE, { providers: 'google' }), { state: 'in', providers: [] });
  });
});

describe('signInHref', () => {
  test('starts the sign-in at the provider route and returns to the current page', () => {
    const href = signInHref('google', '/week-01/1-1/');
    const url = new URL(href, 'https://site.example');
    assert.equal(url.pathname, `${AUTH_API_PREFIX}google`);
    assert.equal(url.searchParams.get(RETURN_TO_PARAM), '/week-01/1-1/');
  });

  test('the page path survives the round trip and is accepted by the Worker', () => {
    for (const path of ['/', '/privacy/', '/week-01/1-1/', '/путь с пробелом/']) {
      const back = new URL(signInHref('github', path), 'https://site.example').searchParams.get(RETURN_TO_PARAM);
      assert.equal(back, path);
      assert.equal(safeReturnTo(back), path);
    }
  });

  test('there is a route for every provider of the site', () => {
    for (const p of AUTH_PROVIDERS) assert.ok(signInHref(p, '/').startsWith(`${AUTH_API_PREFIX}${p}?`));
  });
});

describe('panelPosition', () => {
  const viewport = { width: 1280, height: 800 };
  const panel = { width: 336, height: 300 };
  const box = (top, right, size = 32) => ({ top, bottom: top + size, right, width: size, height: size });

  test('opens under the header button with the right edges aligned', () => {
    assert.deepEqual(panelPosition(box(16, 1250), panel, viewport), { top: 16 + 32 + PANEL_GAP, left: 1250 - 336 });
  });

  test('never leaves the window on the left (narrow screen, button near the left edge)', () => {
    assert.equal(panelPosition(box(16, 100), panel, { width: 360, height: 700 }).left, PANEL_MARGIN);
  });

  test('never leaves the window on the right', () => {
    const { left } = panelPosition(box(16, 1300), panel, viewport);
    assert.equal(left, 1280 - 336 - PANEL_MARGIN);
  });

  test('opens above a button at the bottom of the screen (the mobile menu)', () => {
    const { top } = panelPosition(box(740, 340), panel, { width: 360, height: 800 });
    assert.equal(top, 740 - PANEL_GAP - 300);
  });

  test('a panel that fits neither below nor above stays below, pushed inside the window', () => {
    const { top } = panelPosition(box(200, 340), { width: 336, height: 700 }, { width: 360, height: 800 });
    assert.equal(top, 800 - 700 - PANEL_MARGIN);
  });

  test('a button that is not on screen gets the panel in the middle of the window', () => {
    const hidden = { top: 0, bottom: 0, right: 0, width: 0, height: 0 };
    assert.deepEqual(panelPosition(hidden, panel, { width: 400, height: 800 }), { top: 250, left: 32 });
  });

  test('a panel wider than the window starts at the margin', () => {
    const { left } = panelPosition(box(16, 300), { width: 500, height: 100 }, { width: 320, height: 600 });
    assert.equal(left, PANEL_MARGIN);
  });
});

describe('progressNote', () => {
  test('the local file and the account say where the progress is', () => {
    assert.equal(progressNote('file', { state: 'hidden' }), 'file');
    assert.equal(progressNote('account', { state: 'in' }), 'account');
  });

  test('signed out on the hosting: an invitation to sign in, not "only in this browser"', () => {
    assert.equal(progressNote('browser', { state: 'out' }), 'signIn');
  });

  test('no accounts here, or the account copy did not load: nothing', () => {
    assert.equal(progressNote('browser', { state: 'hidden' }), 'none');
    assert.equal(progressNote('browser', { state: 'in' }), 'none');
  });
});
