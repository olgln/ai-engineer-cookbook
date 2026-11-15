// The account menus of the page (src/components/account-menu.mjs): shows them where the account API
// answers, fills in the sign-in links or the signed-in state, opens the panel next to its button, and runs
// sign-out and account deletion through the progress store. Also the one-time "progress only in this
// browser" hint. Decisions live in ./account.mjs and ./save-hint.mjs.
import * as P from './progress';
import strings from '../locales/ru.json';
import { format } from '../locales/format.mjs';
import { LOGIN_ERROR_PARAM, ME_API_PATH, SAVE_HINT_STORAGE_KEY } from '../config/app.mjs';
import { accountState, panelPosition, signInHref } from './account.mjs';
import { shouldShowSaveHint } from './save-hint.mjs';

const ui = strings.ui;
const providerName = (p: string) => (ui.providerNames as Record<string, string>)[p] ?? p;

export type State = ReturnType<typeof accountState>;

/** Removes the "sign-in failed" mark from the address, so a reload does not show the message again. */
function takeLoginError(): boolean {
  const params = new URLSearchParams(location.search);
  if (!params.has(LOGIN_ERROR_PARAM)) return false;
  params.delete(LOGIN_ERROR_PARAM);
  const query = params.toString();
  history.replaceState(null, '', location.pathname + (query ? `?${query}` : '') + location.hash);
  return true;
}

async function fetchState(): Promise<State> {
  try {
    const res = await fetch(ME_API_PATH, { cache: 'no-store' });
    const type = res.headers.get('content-type');
    const body = [200, 401].includes(res.status) && (type ?? '').includes('json') ? await res.json() : null;
    return accountState(res.status, type, body);
  } catch {
    return { state: 'hidden' };
  }
}

let statePromise: Promise<State> | undefined;
/** The account state of this page, asked once: the menus, the index note and the save hint share it. */
export const getAccountState = () => (statePromise ??= fetchState());

const isOnScreen = (node: HTMLElement) => node.getClientRects().length > 0;

/** Shows the sign-in buttons of the available providers in `root`, each returning to this page. */
function showProviderButtons(root: ParentNode, available: string[]) {
  for (const link of root.querySelectorAll<HTMLAnchorElement>('.account-provider')) {
    const p = link.dataset.provider!;
    link.hidden = !available.includes(p);
    link.href = signInHref(p, location.pathname);
  }
}

function setUp(menu: HTMLElement, state: Exclude<State, { state: 'hidden' }>) {
  const q = <T extends HTMLElement = HTMLElement>(sel: string) => menu.querySelector<T>(sel)!;
  const trigger = q<HTMLButtonElement>('[data-account-trigger]');
  const panel = q('.account-panel');
  trigger.popoverTargetElement = panel;

  // The panel is placed after it opens (its size is known only then) and stays invisible until placed.
  const place = () => {
    const { width, height } = panel.getBoundingClientRect();
    const { top, left } = panelPosition(trigger.getBoundingClientRect(), { width, height },
      { width: document.documentElement.clientWidth, height: window.innerHeight });
    panel.style.top = `${top}px`;
    panel.style.left = `${left}px`;
  };
  panel.addEventListener('toggle', (e) => {
    const open = (e as ToggleEvent).newState === 'open';
    if (open) place();
    panel.classList.toggle('is-placed', open);
    if (!open) closeConfirm();
  });
  window.addEventListener('resize', () => {
    if (panel.matches(':popover-open')) place();
  });

  // Signed out: one link per provider that has credentials, each returning to this page.
  if (state.state === 'out') showProviderButtons(menu, state.available);

  // Signed in: the provider in the avatar and in the panel, sign-out, deletion with an inline confirmation.
  const confirm = q('[data-account-confirm]');
  const footer = q('.account-footer');
  const deleteButton = q<HTMLButtonElement>('[data-account-delete]');
  const deleteError = q('[data-account-delete-error]');
  // The confirmation takes the place of the footer (delete + privacy link) while it is open.
  function closeConfirm() {
    confirm.hidden = true;
    footer.hidden = false;
  }
  if (state.state === 'in') {
    const names = state.providers.map(providerName).join(', ');
    menu.dataset.state = 'in';
    trigger.setAttribute('aria-label', names ? format(ui.accountMenuSignedIn, { provider: names }) : ui.accountMenu);
    panel.setAttribute('aria-label', ui.accountMenu);
    q('[data-account-who]').textContent = names ? format(ui.signedInWith, { provider: names }) : ui.accountMenu;
    for (const badge of menu.querySelectorAll<HTMLElement>('.account-badge')) {
      badge.hidden = badge.dataset.provider !== state.providers[0];
    }

    const signOut = q<HTMLButtonElement>('[data-account-signout]');
    signOut.addEventListener('click', async () => {
      signOut.disabled = true;
      await P.signOut();
      location.reload();
    });

    const cancel = q<HTMLButtonElement>('[data-account-delete-cancel]');
    const confirmDelete = q<HTMLButtonElement>('[data-account-delete-confirm]');
    deleteButton.addEventListener('click', () => {
      deleteError.hidden = true;
      footer.hidden = true;
      confirm.hidden = false;
      cancel.focus();
    });
    cancel.addEventListener('click', () => {
      closeConfirm();
      deleteButton.focus();
    });
    confirmDelete.addEventListener('click', async () => {
      signOut.disabled = confirmDelete.disabled = cancel.disabled = true;
      if (await P.deleteAccount()) {
        location.reload();
        return;
      }
      signOut.disabled = confirmDelete.disabled = cancel.disabled = false;
      closeConfirm();
      deleteError.hidden = false;
    });
  }
  menu.hidden = false;
}

/**
 * Opens the account menu the reader can see. On a phone it sits in Starlight's closed mobile menu, where
 * nothing can open, so that opens first. Returns the menu, or null when there is none on the page.
 */
export function openAccountMenu(): HTMLElement | null {
  const menus = Array.from(document.querySelectorAll<HTMLElement>('.account-menu:not([hidden])'));
  if (!menus.length) return null;
  const onScreen = () => menus.find((m) => isOnScreen(m.querySelector<HTMLElement>('[data-account-trigger]')!));
  if (!onScreen()) document.querySelector<HTMLButtonElement>('.sl-menu-button')?.click();
  const menu = onScreen() ?? menus[0];
  const panel = menu.querySelector<HTMLElement>('.account-panel')!;
  if (!panel.matches(':popover-open')) panel.showPopover();
  return menu;
}

/** Shows the account menus where accounts exist; after a failed sign-in, opens the visible one with the message. */
export async function initAccountMenus() {
  const menus = Array.from(document.querySelectorAll<HTMLElement>('.account-menu'));
  if (!menus.length) return;
  const failed = takeLoginError();
  const state = await getAccountState();
  if (state.state === 'hidden') return;
  for (const menu of menus) setUp(menu, state);
  if (failed && state.state === 'out') {
    const menu = openAccountMenu();
    const message = menu?.querySelector<HTMLElement>('[data-account-login-error]');
    if (message) message.hidden = false;
  }
}

// ---- the one-time hint: "your progress is only in this browser" ----
function hintShown(): boolean {
  try {
    return localStorage.getItem(SAVE_HINT_STORAGE_KEY) !== null;
  } catch {
    return true; // storage blocked: the flag could not be kept, so do not risk showing the hint every time
  }
}

function markHintShown() {
  try {
    localStorage.setItem(SAVE_HINT_STORAGE_KEY, new Date().toISOString());
  } catch {
    /* storage may be blocked */
  }
}

/**
 * Watches the progress for a new signed-out reader's first piece of progress and then shows the hint once
 * (./save-hint.mjs decides). `startedWithProgress`: the progress had something in it when the page loaded.
 */
export function initSaveHint(startedWithProgress: boolean) {
  const hint = document.querySelector<HTMLElement>('.save-hint');
  if (!hint || startedWithProgress || hintShown()) return;
  let done = false;
  P.onChange(async () => {
    if (done) return;
    const facts = { storage: P.storage, startedWithProgress, progress: P.get(), shown: hintShown() };
    if (!shouldShowSaveHint({ ...facts, account: { state: 'out' } })) return; // cheap checks before asking the API
    done = true;
    const account = await getAccountState();
    if (!shouldShowSaveHint({ ...facts, account }) || account.state !== 'out') return;
    markHintShown();
    showProviderButtons(hint, account.available);
    const close = () => hint.hidePopover();
    for (const button of hint.querySelectorAll<HTMLButtonElement>('[data-save-hint-close]')) {
      button.addEventListener('click', close);
    }
    hint.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') close();
    });
    hint.showPopover();
    // Not modal and focus stays where the reader is working, so screen readers hear it from a live region.
    const announce = document.querySelector<HTMLElement>('[data-save-hint-announce]');
    if (announce) announce.textContent = `${ui.saveHintTitle}. ${ui.saveHintText}`;
  });
}
