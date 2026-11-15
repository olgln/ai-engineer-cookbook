// The account menus of the page (src/components/account-menu.mjs): shows them where the account API
// answers, fills in the sign-in links or the signed-in state, opens the panel next to its button, and runs
// sign-out and account deletion through the progress store. Decisions live in ./account.mjs.
import * as P from './progress';
import strings from '../locales/ru.json';
import { format } from '../locales/format.mjs';
import { LOGIN_ERROR_PARAM, ME_API_PATH } from '../config/app.mjs';
import { accountState, panelPosition, signInHref } from './account.mjs';

const ui = strings.ui;
const providerName = (p: string) => (ui.providerNames as Record<string, string>)[p] ?? p;

type State = ReturnType<typeof accountState>;

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

const isOnScreen = (node: HTMLElement) => node.getClientRects().length > 0;

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
  if (state.state === 'out') {
    for (const link of menu.querySelectorAll<HTMLAnchorElement>('.account-provider')) {
      const p = link.dataset.provider!;
      link.hidden = !state.available.includes(p);
      link.href = signInHref(p, location.pathname);
    }
  }

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

/** Shows the account menus where accounts exist; after a failed sign-in, opens the visible one with the message. */
export async function initAccountMenus() {
  const menus = Array.from(document.querySelectorAll<HTMLElement>('.account-menu'));
  if (!menus.length) return;
  const failed = takeLoginError();
  const state = await fetchState();
  if (state.state === 'hidden') return;
  for (const menu of menus) setUp(menu, state);
  if (failed && state.state === 'out') {
    const onScreen = () => menus.find((m) => isOnScreen(m.querySelector<HTMLElement>('[data-account-trigger]')!));
    // On a phone the menu sits in Starlight's closed mobile menu, where nothing can open: open that first.
    if (!onScreen()) document.querySelector<HTMLButtonElement>('.sl-menu-button')?.click();
    const menu = onScreen() ?? menus[0];
    menu.querySelector<HTMLElement>('[data-account-login-error]')!.hidden = false;
    menu.querySelector<HTMLElement>('.account-panel')!.showPopover();
  }
}
