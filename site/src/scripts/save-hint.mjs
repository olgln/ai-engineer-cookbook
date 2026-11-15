// When to show the one-time hint "your progress is kept only in this browser, sign in to keep it": to a
// new reader (no progress when the page loaded) who is signed out on the hosting, at their first piece of
// progress, once per browser. Tested in tests/save-hint.test.mjs; the DOM is in ./account-ui.ts.

/**
 * Whether a progress document holds anything the reader did: a finished chapter, a ticked checklist item or
 * a quiz answer. Opening a chapter leaves an empty entry for it, which does not count.
 * @param {{ chapters?: Record<string, { done?: string, checks?: Record<string, boolean>, quiz?: Record<string, object> }> } | null} progress
 */
export function hasProgress(progress) {
  return Object.values(progress?.chapters ?? {}).some((c) =>
    Boolean(c?.done)
    || Object.values(c?.checks ?? {}).some(Boolean)
    || Object.keys(c?.quiz ?? {}).length > 0);
}

/**
 * @param {{
 *   storage: 'file' | 'account' | 'browser',
 *   account: { state: string },
 *   startedWithProgress: boolean,
 *   progress: unknown,
 *   shown: boolean,
 * }} facts storage and account state now, whether the page loaded with progress, the progress now, and
 *   whether the hint was shown before in this browser
 */
export function shouldShowSaveHint({ storage, account, startedWithProgress, progress, shown }) {
  return storage === 'browser' && account.state === 'out' && !startedWithProgress && !shown && hasProgress(progress);
}
