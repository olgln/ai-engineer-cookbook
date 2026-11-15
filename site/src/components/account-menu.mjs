// The account menu at the right end of the header (and in the mobile menu, next to the theme switch): a
// "sign in" button, or the reader's avatar once signed in, opening a panel with the sign-in buttons or the
// account actions. It is rendered hidden on every page; src/scripts/account/account-ui.ts shows it only where the
// account API answers (the Worker), so the local server and a static hosting never show it. Both states
// are in the markup and the root's data-state picks one (src/styles/account.css). Pure, so it can be
// tested without rendering Astro components (tests/site/account-menu.test.mjs).
import { AUTH_API_PREFIX, AUTH_PROVIDERS, PRIVACY_PATH } from '../config/app.mjs';
import { format } from '../locales/format.mjs';

const escape = (s) => String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/**
 * Provider logos, as each brand asks: Google's four-colour "G" unchanged, GitHub's mark in one colour
 * (currentColor, so it follows the theme). Decorative: the text next to them names the provider.
 */
export const PROVIDER_ICONS = {
  google:
    '<svg class="account-logo" viewBox="0 0 48 48" aria-hidden="true" focusable="false">'
    + '<path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"/>'
    + '<path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"/>'
    + '<path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"/>'
    + '<path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"/>'
    + '</svg>',
  github:
    '<svg class="account-logo" viewBox="0 0 16 16" aria-hidden="true" focusable="false">'
    + '<path fill="currentColor" d="M8 0c4.42 0 8 3.58 8 8a8.013 8.013 0 0 1-5.45 7.59c-.4.08-.55-.17-.55-.38 0-.27.01-1.13.01-2.2 0-.75-.25-1.23-.54-1.48 1.78-.2 3.65-.88 3.65-3.95 0-.88-.31-1.59-.82-2.15.08-.2.36-1.02-.08-2.12 0 0-.67-.22-2.2.82-.64-.18-1.32-.27-2-.27-.68 0-1.36.09-2 .27-1.53-1.03-2.2-.82-2.2-.82-.44 1.1-.16 1.92-.08 2.12-.51.56-.82 1.28-.82 2.15 0 3.06 1.86 3.75 3.64 3.95-.23.2-.44.55-.51 1.07-.46.21-1.61.55-2.33-.66-.15-.24-.6-.83-1.23-.82-.67.01-.27.38.01.53.34.19.73.9.82 1.13.16.45.68 1.31 2.69.94 0 .67.01 1.3.01 1.49 0 .21-.15.45-.55.38A7.995 7.995 0 0 1 0 8c0-4.42 3.58-8 8-8Z"/>'
    + '</svg>',
};

/** A generic person: we know no name or photo of the reader, only that they are signed in. */
const PERSON_ICON =
  '<svg class="account-person" viewBox="0 0 24 24" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round">'
  + '<circle cx="12" cy="8.75" r="3.75"/><path d="M5 19.25c1.25-3.3 3.9-5 7-5s5.75 1.7 7 5"/></svg>';

/**
 * The avatar of a signed-in reader: the person icon with the logo of the provider they signed in with in
 * the corner (all logos are rendered, the script unhides one).
 */
const avatar = (cls) => [
  `<span class="account-avatar ${cls}" aria-hidden="true">`,
  PERSON_ICON,
  ...AUTH_PROVIDERS.map((p) => `<span class="account-badge" data-provider="${p}" hidden>${PROVIDER_ICONS[p]}</span>`),
  '</span>',
].join('');

/**
 * Sign-in buttons, one per provider, hidden: the script shows those the account API lists and points them
 * back to the current page.
 * @param {typeof import('../locales/ru.json')} strings
 */
export function providerButtonsHtml(strings) {
  const { ui } = strings;
  return [
    '<div class="account-providers">',
    ...AUTH_PROVIDERS.map((p) => [
      `<a class="account-provider" data-provider="${p}" href="${AUTH_API_PREFIX}${p}" hidden>`,
      PROVIDER_ICONS[p],
      `<span>${escape(format(ui.signInWith, { provider: ui.providerNames[p] ?? p }))}</span>`,
      '</a>',
    ].join('')),
    '</div>',
  ].join('');
}

/**
 * The one-time hint for a new signed-out reader at their first piece of progress (src/scripts/account/save-hint.mjs):
 * a card at the bottom of the window, not modal, with the sign-in buttons. Rendered once per page, hidden.
 * @param {typeof import('../locales/ru.json')} strings
 */
export function saveHintHtml(strings) {
  const { ui } = strings;
  return [
    '<div class="sr-only" aria-live="polite" data-save-hint-announce></div>',
    '<section class="save-hint" popover="manual" role="dialog" aria-labelledby="save-hint-title" aria-describedby="save-hint-text">',
    `<button type="button" class="save-hint-close" data-save-hint-close aria-label="${escape(ui.close)}">`,
    '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>',
    '</button>',
    `<p class="save-hint-title" id="save-hint-title">${escape(ui.saveHintTitle)}</p>`,
    `<p class="save-hint-text" id="save-hint-text">${escape(ui.saveHintText)}</p>`,
    providerButtonsHtml(strings),
    `<button type="button" class="save-hint-later" data-save-hint-close>${escape(ui.notNow)}</button>`,
    '</section>',
  ].join('');
}

/**
 * Markup of one account menu. Starlight renders the theme switch twice (header and mobile menu), so a page
 * has two menus; the markup has no ids, the script links each button to its panel.
 * @param {typeof import('../locales/ru.json')} strings
 */
export function accountMenuHtml(strings) {
  const ui = strings.ui;
  const privacy = `<a class="account-privacy" href="${PRIVACY_PATH}">${escape(ui.privacyLink)}</a>`;
  return [
    '<div class="account-menu" data-state="out" hidden>',
    '<button type="button" class="account-trigger" data-account-trigger>',
    `<span data-when="out">${escape(ui.signIn)}</span>`,
    `<span data-when="in">${avatar('account-avatar-small')}</span>`,
    '</button>',
    `<div class="account-panel" popover role="dialog" aria-label="${escape(ui.signInTitle)}">`,

    // signed out: why to sign in, the providers, what we get from them
    '<div class="account-section" data-when="out">',
    `<p class="account-error" role="alert" data-account-login-error hidden>${escape(ui.signInFailed)}</p>`,
    `<p class="account-title">${escape(ui.signInTitle)}</p>`,
    `<p class="account-text">${escape(ui.signInText)}</p>`,
    providerButtonsHtml(strings),
    `<p class="account-fine">${escape(ui.signInFinePrint)} ${privacy}</p>`,
    '</div>',

    // signed in: who, sign out, delete (asks inline first)
    '<div class="account-section" data-when="in">',
    '<div class="account-who">',
    avatar('account-avatar-large'),
    '<div>',
    '<p class="account-title" data-account-who></p>',
    `<p class="account-text">${escape(ui.savedInAccount)}</p>`,
    '</div>',
    '</div>',
    `<button type="button" class="quiz-btn account-signout" data-account-signout>${escape(ui.signOut)}</button>`,
    '<div class="account-footer">',
    `<button type="button" class="account-delete" data-account-delete>${escape(ui.deleteAccount)}</button>`,
    privacy,
    '</div>',
    '<div class="account-confirm" data-account-confirm hidden>',
    `<p>${escape(ui.confirmDeleteAccount)}</p>`,
    '<div class="account-confirm-actions">',
    `<button type="button" class="quiz-btn danger" data-account-delete-confirm>${escape(ui.deleteAccountForever)}</button>`,
    `<button type="button" class="quiz-btn ghost" data-account-delete-cancel>${escape(ui.cancel)}</button>`,
    '</div>',
    '</div>',
    `<p class="account-error" role="alert" data-account-delete-error hidden>${escape(ui.deleteAccountFailed)}</p>`,
    '</div>',

    '</div>',
    '</div>',
  ].join('');
}
