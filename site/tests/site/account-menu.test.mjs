// Tests for the account menu in the header: its markup (src/components/account-menu.mjs), how it is put
// into every page (ThemeSelect override, ahead of the language and theme switches), its states in CSS, and the wiring of src/scripts/account/,
// which is DOM code without a test DOM (checked as text, like the other DOM wiring).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { describe, test } from 'node:test';
import strings from '../../src/locales/ru.json' with { type: 'json' };
import { format } from '../../src/locales/format.mjs';
import { AUTH_PROVIDERS, OAUTH_PROVIDERS, PRIVACY_PATH } from '../../src/config/app.mjs';
import { accountMenuHtml, PROVIDER_ICONS, saveHintHtml } from '../../src/components/account-menu.mjs';

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
  test('comes first, then the language and theme switches: the ThemeSelect override renders all three', () => {
    const astro = read('../../src/components/ThemeSelect.astro');
    assert.match(astro, /import DefaultLanguageSelect from '@astrojs\/starlight\/components\/LanguageSelect\.astro';/);
    assert.match(astro, /import DefaultThemeSelect from '@astrojs\/starlight\/components\/ThemeSelect\.astro';/);
    assert.match(astro, /<Fragment set:html=\{accountMenu\} \/>\s*<DefaultLanguageSelect \/>\s*<DefaultThemeSelect \/>/);
    const config = read('../../astro.config.mjs');
    assert.match(config, /ThemeSelect: '\.\/src\/components\/ThemeSelect\.astro'/);
    assert.match(config, /LanguageSelect: '\.\/src\/components\/LanguageSelect\.astro'/);
  });

  test('the LanguageSelect override renders nothing, so the language switch is not shown twice', () => {
    const astro = read('../../src/components/LanguageSelect.astro');
    assert.equal(astro.replace(/^---\n(\/\/.*\n)*---\n?$/, ''), '');
  });

  test('CSS shows only the part of the current state and hides what the markup hides', () => {
    const css = read('../../src/styles/account.css');
    assert.match(css, /\.account-menu\[data-state='in'\] \[data-when='out'\],\s*\.account-menu:not\(\[data-state='in'\]\) \[data-when='in'\] \{ display: none; \}/);
    for (const cls of ['account-menu', 'account-provider', 'account-badge', 'account-confirm', 'account-error', 'account-footer']) {
      assert.match(css, new RegExp(`\\.${cls}\\[hidden\\] \\{ display: none; \\}`), cls);
    }
  });

  test('the panel stays invisible until placed, and its animation respects reduced motion', () => {
    const css = read('../../src/styles/account.css');
    assert.match(css, /\.account-panel:not\(\.is-placed\) \{ visibility: hidden; \}/);
    assert.match(css, /@media \(prefers-reduced-motion: reduce\) \{\s*\.account-panel\.is-placed \{ animation: none; \}/);
  });

  test('the index page no longer starts a sign-in box of its own', () => {
    assert.doesNotMatch(read('../../src/scripts/course/index-page-ui.ts'), /initAccount\(overall\)|account-box/);
    assert.match(read('../../src/scripts/main.ts'), /async function boot\(\) \{\s*void initAccountMenus\(\);/);
  });
});

describe('account menu script', () => {
  const script = read('../../src/scripts/account/account-ui.ts');

  test('shows the menus only for a known account state', () => {
    assert.match(script, /if \(state\.state === 'hidden'\) return;\s*for \(const menu of menus\) setUp\(menu, state\);/);
    assert.match(script, /menu\.hidden = false;\s*\}/);
  });

  test('links each button to its own panel', () => {
    assert.match(script, /trigger\.popoverTargetElement = panel;/);
  });

  test('signed out: shows only the available providers, returning to this page', () => {
    assert.match(script, /link\.hidden = !available\.includes\(p\);\s*link\.href = signInHref\(p, location\.pathname\);/);
    assert.match(script, /if \(state\.state === 'out'\) showProviderButtons\(menu, state\.available\);/);
  });

  test('asks the account API once per page', () => {
    assert.match(script, /export const getAccountState = \(\) => \(statePromise \?\?= fetchState\(\)\);/);
    assert.equal(script.match(/(?<!function )fetchState\(\)/g).length, 1, 'only through getAccountState');
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

  test('opening the menu opens the mobile menu first when the header one is not on screen', () => {
    const open = between(script, 'export function openAccountMenu', 'export async function initAccountMenus');
    assert.match(open, /if \(!onScreen\(\)\) document\.querySelector<HTMLButtonElement>\('\.sl-menu-button'\)\?\.click\(\);/);
    assert.match(open, /panel\.showPopover\(\);/);
  });

  test('a failed sign-in opens the menu with the message', () => {
    const failed = between(script, 'if (failed && ');
    assert.match(failed, /const menu = openAccountMenu\(\);/);
    assert.match(failed, /\[data-account-login-error\]'\);\s*if \(message\) message\.hidden = false;/);
  });
});

describe('save hint', () => {
  const hint = saveHintHtml(strings);
  const script = read('../../src/scripts/account/save-hint-ui.ts');
  const initHint = between(script, 'export function initSaveHint');

  test('a hidden, non-modal card with a title, the explanation, the sign-in buttons, "not now" and a close button', () => {
    assert.match(hint, /<section class="save-hint" popover="manual" role="dialog" aria-labelledby="save-hint-title" aria-describedby="save-hint-text">/);
    assert.ok(hint.includes(`id="save-hint-title">${escaped(ui.saveHintTitle)}</p>`));
    assert.ok(hint.includes(`id="save-hint-text">${escaped(ui.saveHintText)}</p>`));
    for (const p of AUTH_PROVIDERS) assert.match(hint, new RegExp(`<a class="account-provider" data-provider="${p}" href="[^"]+" hidden>`));
    assert.ok(hint.includes(`data-save-hint-close>${escaped(ui.notNow)}</button>`));
    assert.ok(hint.includes(`data-save-hint-close aria-label="${escaped(ui.close)}">`));
    assert.doesNotMatch(hint, /\son[a-z]+=|\sstyle=/i);
  });

  test('is on every page once, from the page frame', () => {
    const frame = read('../../src/components/PageFrame.astro');
    assert.match(frame, /const saveHint = saveHintHtml\(strings\);/);
    assert.equal(frame.match(/<Fragment set:html=\{saveHint\} \/>/g).length, 1);
  });

  test('starts watching only for a reader who loaded the page with no progress and has not seen it', () => {
    assert.match(initHint, /if \(!hint \|\| startedWithProgress \|\| hintShown\(\)\) return;/);
    assert.match(read('../../src/scripts/main.ts'), /await P\.load\(\);\s*initSaveHint\(hasProgress\(P\.get\(\)\)\);/);
  });

  test('decides with the account state, remembers it before showing, and shows only available providers', () => {
    assert.match(initHint, /const account = await getAccountState\(\);\s*if \(!shouldShowSaveHint\(\{ \.\.\.facts, account \}\) \|\| account\.state !== 'out'\) return;\s*markHintShown\(\);\s*showProviderButtons\(hint, account\.available\);/);
  });

  test('closes with its buttons and Escape, and is announced without taking the focus', () => {
    assert.match(initHint, /\[data-save-hint-close\]/);
    assert.match(initHint, /e\.key === 'Escape'/);
    assert.match(initHint, /hint\.showPopover\(\);/);
    assert.doesNotMatch(initHint, /\.focus\(\)/);
    assert.match(initHint, /announce\.textContent = /);
  });

  test('its animation respects reduced motion and it fits a phone', () => {
    const css = read('../../src/styles/save-hint.css');
    assert.match(css, /@media \(prefers-reduced-motion: reduce\) \{\s*\.save-hint:popover-open \{ animation: none; \}/);
    assert.match(css, /@media \(max-width: 50rem\) \{\s*\.save-hint \{ inset: auto 0\.75rem 0\.75rem; width: auto; \}/);
  });
});

describe('index note under the course progress', () => {
  const main = read('../../src/scripts/course/index-page-ui.ts');

  test('signed out it invites to sign in and opens the account menu; the browser copy is not announced', () => {
    assert.match(main, /el\('button', \{ type: 'button', class: 'storage-note-signin', textContent: ui\.signInToSave \}\)/);
    assert.match(main, /signIn\.addEventListener\('click', \(\) => openAccountMenu\(\)\);/);
    assert.match(main, /if \(kind === 'signIn'\) note\.replaceChildren\(signIn\);/);
    assert.ok(!('savedInBrowser' in ui));
  });

  test('export and import are gone', () => {
    assert.doesNotMatch(main, /exportProgress|importProgress/);
    for (const key of ['exportProgress', 'importProgress', 'importMissingChapters', 'confirmImport', 'importFailed']) {
      assert.ok(!(key in ui), key);
    }
  });
});
