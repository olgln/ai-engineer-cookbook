// The one-time hint "your progress is only in this browser" (saveHintHtml in src/components/account-menu.mjs).
// Decisions live in ./save-hint.mjs.
import * as P from '../progress/store';
import { SAVE_HINT_STORAGE_KEY } from '../../config/app.mjs';
import { getAccountState, showProviderButtons } from './account-ui';
import { shouldShowSaveHint } from './save-hint.mjs';
import { strings } from '../page-locale';

const ui = strings.ui;

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
