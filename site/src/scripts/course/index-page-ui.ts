import * as P from '../progress/store';
import chapters from '../../generated/chapters.json';
import strings from '../../locales/ru.json';
import { format, plural } from '../../locales/format.mjs';
import { getAccountState, openAccountMenu, type State as AccountState } from '../account/account-ui';
import { progressNote } from '../account/account.mjs';
import { $$, el } from '../dom';

const ui = strings.ui;

function setBar(bar: HTMLElement | null, done: number, total: number) {
  if (!bar) return;
  const pct = total ? Math.round((done / total) * 100) : 0;
  bar.setAttribute('aria-valuenow', String(pct));
  bar.querySelector<HTMLElement>('.progress-fill')?.style.setProperty('width', `${pct}%`);
}

// The progress blocks come pre-rendered in the "nothing done yet" state (scripts/convert/pages/index-page.mjs,
// courseProgressHtml / weekProgressHtml); here they are updated in place, so the page does not shift.
export function initIndex() {
  const overall = document.querySelector<HTMLElement>('.course-progress');
  if (!overall) return;
  const count = overall.querySelector<HTMLElement>('.course-progress-count');
  const note = overall.querySelector<HTMLElement>('.storage-note');
  const nextLink = overall.querySelector<HTMLAnchorElement>('.course-progress-next');
  const allDone = el('span', {}, ui.allDone);
  // Signed out on the hosting the note invites to sign in and opens the account menu; the browser copy
  // is not announced (the one-time save hint tells a new reader about it).
  const signIn = el('button', { type: 'button', class: 'storage-note-signin', textContent: ui.signInToSave });
  signIn.addEventListener('click', () => openAccountMenu());
  let account: AccountState = { state: 'hidden' };
  const render = () => {
    const done = (id: string) => !!P.get().chapters[id]?.done;
    const total = chapters.length;
    const n = chapters.filter((c) => done(c.id)).length;
    const next = chapters.find((c) => !done(c.id));
    if (count) count.textContent = format(ui.courseProgress, { done: n, total, chapters: plural(strings.lang, total, ui.chaptersOf) });
    if (note) {
      const kind = progressNote(P.storage, account);
      if (kind === 'signIn') note.replaceChildren(signIn);
      else if (kind === 'file') note.textContent = format(ui.savedTo, { path: P.storagePath || ui.progressFileFallback });
      else note.textContent = kind === 'account' ? ui.savedInAccount : '';
    }
    setBar(overall.querySelector<HTMLElement>(':scope > .progress-bar'), n, total);
    if (nextLink && next) {
      nextLink.href = next.href;
      nextLink.textContent = format(n ? ui.continueFrom : ui.startFrom, { chapter: `${next.num} · ${next.title}` });
      if (!nextLink.isConnected) allDone.replaceWith(nextLink);
    } else if (nextLink?.isConnected) nextLink.replaceWith(allDone);
    for (const card of $$<HTMLElement>('.week-card')) {
      const week = +card.dataset.week!;
      const list = chapters.filter((c) => c.week === week);
      const d = list.filter((c) => done(c.id)).length;
      const slot = card.querySelector<HTMLElement>('.week-progress');
      setBar(slot?.querySelector<HTMLElement>('.progress-bar') ?? null, d, list.length);
      const label = slot?.querySelector<HTMLElement>('.week-progress-label');
      if (label) label.textContent = `${d}/${list.length}`;
      card.classList.toggle('complete', list.length > 0 && d === list.length);
    }
  };
  render();
  P.onChange(render);
  void getAccountState().then((state) => {
    account = state;
    render();
  });
}
