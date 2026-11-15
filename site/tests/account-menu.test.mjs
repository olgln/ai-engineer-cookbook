// Tests for the account menu in the header: its markup (src/components/account-menu.mjs), how it is put
// into every page (ThemeSelect override), its states in CSS, and the wiring of src/scripts/account-ui.ts,
// which is DOM code without a test DOM (checked as text, like the other DOM wiring).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { describe, test } from 'node:test';
import strings from '../src/locales/ru.json' with { type: 'json' };
import { format } from '../src/locales/format.mjs';
import { AUTH_PROVIDERS, OAUTH_PROVIDERS, PRIVACY_PATH } from '../src/config/app.mjs';
import { accountMenuHtml, PROVIDER_ICONS } from '../src/components/account-menu.mjs';

const { ui } = strings;
const html = accountMenuHtml(strings);
const read = (rel) => fs.readFileSync(new URL(rel, import.meta.url), 'utf8');
const between = (text, from, to) => text.slice(text.indexOf(from), to ? text.indexOf(to, text.indexOf(from)) : undefined);
const escaped = (s) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

describe('account menu markup', () => {
  test('is hidden until the script finds the account API, and starts signed out', () => {
    assert.ok(html.startsWith('<div class="account-menu" data-state="out" hidden>'));
  });

  test('has no ids: Starlight renders it twice per page (header and mobile menu)', () => {
    assert.doesNotMatch(html, /\sid="/);
  });

  test('the button reads "sign in" signed out and shows the avatar signed in', () => {
    const trigger = between(html, '<button type="button" class="account-trigger"', '</button>');
    assert.ok(trigger.includes(`<span data-when="out">${ui.signIn}</span>`));
    assert.ok(trigger.includes('<span data-when="in"><span class="account-avatar account-avatar-small" aria-hidden="true">'));
  });

  test('the panel is a popover dialog with an accessible name', () => {
    assert.ok(html.includes(`<div class="account-panel" popover role="dialog" aria-label="${escaped(ui.signInTitle)}">`));
  });

  test('signed out: why to sign in, a hidden button per provider with its logo, what we get, the privacy link', () => {
    const out = between(html, '<div class="account-section" data-when="out">', '<div class="account-section" data-when="in">');
    assert.ok(out.includes(escaped(ui.signInTitle)));
    assert.ok(out.includes(escaped(ui.signInText)));
    for (const p of AUTH_PROVIDERS) {
      const link = between(out, `<a class="account-provider" data-provider="${p}"`, '</a>');
      assert.ok(link.includes(' hidden>'), `${p} stays hidden until the API lists it`);
      assert.ok(link.includes(PROVIDER_ICONS[p]), `${p} logo`);
      assert.ok(link.includes(escaped(format(ui.signInWith, { provider: ui.providerNames[p] }))));
    }
    assert.ok(out.indexOf('data-provider="google"') < out.indexOf('data-provider="github"'), 'Google first');
    assert.ok(out.includes(escaped(ui.signInFinePrint)));
    assert.ok(out.includes(`<a class="account-privacy" href="${PRIVACY_PATH}">${escaped(ui.privacyLink)}</a>`));
    assert.ok(out.includes(`role="alert" data-account-login-error hidden>${escaped(ui.signInFailed)}</p>`));
  });

  test('signed in: sign-out, deletion that asks first, the privacy link', () => {
    const signedIn = between(html, '<div class="account-section" data-when="in">');
    assert.ok(signedIn.includes(`data-account-signout>${escaped(ui.signOut)}</button>`));
    assert.ok(signedIn.includes(`data-account-delete>${escaped(ui.deleteAccount)}</button>`));
    const confirm = between(signedIn, 'data-account-confirm hidden>', '</div></div>');
    assert.ok(confirm.includes(escaped(ui.confirmDeleteAccount)));
    assert.ok(confirm.includes(`data-account-delete-confirm>${escaped(ui.deleteAccountForever)}</button>`));
    assert.ok(confirm.includes(`data-account-delete-cancel>${escaped(ui.cancel)}</button>`));
    assert.ok(signedIn.includes(`role="alert" data-account-delete-error hidden>${escaped(ui.deleteAccountFailed)}</p>`));
    assert.ok(signedIn.includes(`href="${PRIVACY_PATH}"`));
  });

  test('every provider has a logo and a name; logos are decorative', () => {
    for (const p of AUTH_PROVIDERS) {
      assert.ok(OAUTH_PROVIDERS[p], p);
      assert.ok(ui.providerNames[p], p);
      assert.match(PROVIDER_ICONS[p], /^<svg class="account-logo" viewBox="[\d ]+" aria-hidden="true" focusable="false">/);
    }
  });

  test('the Google logo keeps its four brand colours', () => {
    for (const colour of ['#EA4335', '#4285F4', '#FBBC05', '#34A853']) assert.ok(PROVIDER_ICONS.google.includes(`fill="${colour}"`));
  });

  test('UI strings are escaped', () => {
    const tricky = structuredClone(strings);
    tricky.ui.signInTitle = '"><script>x</script>';
    const out = accountMenuHtml(tricky);
    assert.ok(!out.includes('<script>'));
    assert.ok(out.includes('aria-label="&quot;&gt;&lt;script&gt;x&lt;/script&gt;"'));
  });

  test('no inline event handlers or styles (CSP)', () => {
    assert.doesNotMatch(html, /\son[a-z]+=|\sstyle=/i);
  });
});

describe('account menu on the page', () => {
  test('sits next to the theme switch: the ThemeSelect override renders both', () => {
    const astro = read('../src/components/ThemeSelect.astro');
    assert.match(astro, /import Default from '@astrojs\/starlight\/components\/ThemeSelect\.astro';/);
    assert.match(astro, /<Default \/>\s*<Fragment set:html=\{accountMenu\} \/>/);
    assert.match(read('../astro.config.mjs'), /ThemeSelect: '\.\/src\/components\/ThemeSelect\.astro'/);
  });

  test('CSS shows only the part of the current state and hides what the markup hides', () => {
    const css = read('../src/styles/custom.css');
    assert.match(css, /\.account-menu\[data-state='in'\] \[data-when='out'\],\s*\.account-menu:not\(\[data-state='in'\]\) \[data-when='in'\] \{ display: none; \}/);
    for (const cls of ['account-menu', 'account-provider', 'account-badge', 'account-confirm', 'account-error', 'account-footer']) {
      assert.match(css, new RegExp(`\\.${cls}\\[hidden\\] \\{ display: none; \\}`), cls);
    }
  });

  test('the panel stays invisible until placed, and its animation respects reduced motion', () => {
    const css = read('../src/styles/custom.css');
    assert.match(css, /\.account-panel:not\(\.is-placed\) \{ visibility: hidden; \}/);
    assert.match(css, /@media \(prefers-reduced-motion: reduce\) \{\s*\.account-panel\.is-placed \{ animation: none; \}/);
  });

  test('the index page no longer starts a sign-in box of its own', () => {
    const main = read('../src/scripts/main.ts');
    assert.doesNotMatch(main, /initAccount\(overall\)|account-box/);
    assert.match(main, /async function boot\(\) \{\s*void initAccountMenus\(\);/);
  });
});

describe('account menu script', () => {
  const script = read('../src/scripts/account-ui.ts');

  test('shows the menus only for a known account state', () => {
    assert.match(script, /if \(state\.state === 'hidden'\) return;\s*for \(const menu of menus\) setUp\(menu, state\);/);
    assert.match(script, /menu\.hidden = false;\s*\}/);
  });

  test('links each button to its own panel', () => {
    assert.match(script, /trigger\.popoverTargetElement = panel;/);
  });

  test('signed out: shows only the available providers, returning to this page', () => {
    assert.match(script, /link\.hidden = !state\.available\.includes\(p\);\s*link\.href = signInHref\(p, location\.pathname\);/);
  });

  test('deleting asks inline first, then calls the store and reloads only on success', () => {
    const del = between(script, "deleteButton.addEventListener('click'", 'menu.hidden = false;');
    assert.match(del, /footer\.hidden = true;\s*confirm\.hidden = false;\s*cancel\.focus\(\);/);
    assert.match(del, /if \(await P\.deleteAccount\(\)\) \{\s*location\.reload\(\);\s*return;\s*\}/);
    assert.match(del, /deleteError\.hidden = false;/);
  });

  test('signing out goes through the store, which uploads unsent changes first', () => {
    assert.match(script, /await P\.signOut\(\);\s*location\.reload\(\);/);
  });

  test('a failed sign-in opens the menu with the message, opening the mobile menu if needed', () => {
    const failed = between(script, 'if (failed && ');
    assert.match(failed, /\.sl-menu-button/);
    assert.match(failed, /\[data-account-login-error\]'\)!\.hidden = false;/);
    assert.match(failed, /\.showPopover\(\);/);
  });
});
