// Remembers the reader's choice of language and shows the language note (src/components/language-note.mjs).
// Decisions live in ./language.mjs.
import { splitLocale } from '../../locales/locales.mjs';
import { $$ } from '../dom';
import { lang } from '../page-locale';
import { languageCookie, suggestedLang } from './language.mjs';

function remember(choice: string) {
  document.cookie = languageCookie(choice, location.protocol === 'https:');
}

/**
 * The language switch (Starlight's, rendered in the header and in the mobile menu) navigates on `change`;
 * a capturing listener on its wrapper stores the choice before that.
 */
function watchLanguageSwitch() {
  for (const wrapper of $$('starlight-lang-select')) {
    wrapper.addEventListener('change', (e) => {
      if (e.target instanceof HTMLSelectElement) remember(splitLocale(e.target.value).lang);
    }, true);
  }
}

/** Shows the note for the browser's language when the page is in another one and the reader has not chosen. */
function showLanguageNote() {
  const target = suggestedLang({ pageLang: lang, cookie: document.cookie, browserLangs: navigator.languages ?? [] });
  const note = $$('[data-language-note]').find((n) => n.dataset.languageNote === target);
  if (!target || !note) return;
  note.querySelector('[data-language-note-link]')?.addEventListener('click', () => remember(target));
  note.querySelector('[data-language-note-close]')?.addEventListener('click', () => {
    remember(lang); // closing the note means "this language is fine": no note and no home page redirect next time
    note.hidden = true;
  });
  note.hidden = false;
}

export function initLanguageChoice() {
  watchLanguageSwitch();
  showLanguageNote();
}
