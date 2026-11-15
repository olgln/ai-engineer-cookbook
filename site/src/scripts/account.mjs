// Decisions of the account menu in the header, without the DOM (src/scripts/account-ui.ts does the DOM):
// what the account API answer means, where the sign-in links point, where the menu panel opens and what
// the note under the course progress says.
// Tested in tests/account.test.mjs.
import { AUTH_API_PREFIX, AUTH_PROVIDERS, RETURN_TO_PARAM } from '../config/app.mjs';

const known = (list) => (Array.isArray(list) ? AUTH_PROVIDERS.filter((p) => list.includes(p)) : []);

/**
 * What the menu shows for an answer of `GET /api/me`:
 * - `{ state: 'in', providers }` signed in (200), with the providers of the reader's sign-in identities;
 * - `{ state: 'out', available }` signed out (401), with the providers that can be used to sign in;
 * - `{ state: 'hidden' }` no account API here (the local server, a static hosting: 404 or HTML), or no
 *   provider is set up, so there is nothing to offer.
 * Provider names the site does not know are dropped; the order is AUTH_PROVIDERS.
 * @param {number} status
 * @param {string | null} contentType
 * @param {unknown} body
 */
export function accountState(status, contentType, body) {
  if (![200, 401].includes(status) || !(contentType ?? '').includes('json') || !body || typeof body !== 'object') {
    return { state: 'hidden' };
  }
  if (status === 200) return { state: 'in', providers: known(body.providers) };
  const available = known(body.available);
  return available.length ? { state: 'out', available } : { state: 'hidden' };
}

/**
 * Link that starts a sign-in with a provider and brings the reader back to the page they are on.
 * @param {string} provider
 * @param {string} pathname
 */
export const signInHref = (provider, pathname) =>
  `${AUTH_API_PREFIX}${provider}?${new URLSearchParams({ [RETURN_TO_PARAM]: pathname })}`;

/** Space between the menu button and its panel, and the smallest distance from the window edge, in px. */
export const PANEL_GAP = 8;
export const PANEL_MARGIN = 8;

const clamp = (value, min, max) => Math.max(min, Math.min(value, max));

/**
 * Top-left corner of the menu panel (position: fixed), in px. The panel opens under its button with the
 * right edges aligned, as menus at the right end of a header do; it opens above the button when it does
 * not fit below but fits above (the button at the bottom of the mobile menu), and always stays inside the
 * window. A button that is not on screen (a zero-size box: the mobile menu is closed) gets the panel in
 * the middle of the window, like a dialog.
 * @param {{ top: number, bottom: number, right: number, width: number, height: number }} button
 * @param {{ width: number, height: number }} panel
 * @param {{ width: number, height: number }} viewport
 */
export function panelPosition(button, panel, viewport) {
  const maxLeft = Math.max(PANEL_MARGIN, viewport.width - panel.width - PANEL_MARGIN);
  const maxTop = Math.max(PANEL_MARGIN, viewport.height - panel.height - PANEL_MARGIN);
  if (!button.width && !button.height) {
    return {
      top: Math.round(clamp((viewport.height - panel.height) / 2, PANEL_MARGIN, maxTop)),
      left: Math.round(clamp((viewport.width - panel.width) / 2, PANEL_MARGIN, maxLeft)),
    };
  }
  const left = clamp(button.right - panel.width, PANEL_MARGIN, maxLeft);
  const below = button.bottom + PANEL_GAP;
  const above = button.top - PANEL_GAP - panel.height;
  const fitsBelow = below + panel.height <= viewport.height - PANEL_MARGIN;
  const top = !fitsBelow && above >= PANEL_MARGIN ? above : clamp(below, PANEL_MARGIN, maxTop);
  return { top: Math.round(top), left: Math.round(left) };
}

/**
 * What the note next to the course progress on the index page says:
 * - `'file'` where the local server writes the progress file (`npm start`);
 * - `'account'` that the progress is kept in the account (signed in);
 * - `'signIn'` an invitation to sign in (signed out on the hosting);
 * - `'none'` nothing (no accounts here, or the account copy could not be loaded).
 * @param {'file' | 'account' | 'browser'} storage
 * @param {{ state: string }} account
 */
export function progressNote(storage, account) {
  if (storage === 'file' || storage === 'account') return storage;
  return account.state === 'out' ? 'signIn' : 'none';
}
