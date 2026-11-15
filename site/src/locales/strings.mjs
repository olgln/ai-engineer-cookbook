// UI strings of every site language: one JSON file per language with the same keys as ru.json (the type
// below makes `npm run typecheck` fail when a translation misses a key; tests/site/locales.test.mjs also
// catches extra keys). All reader-facing text of the site lives in these files.
import en from './en.json' with { type: 'json' };
import ru from './ru.json' with { type: 'json' };

/** @typedef {Record<string, string>} PluralForms forms keyed by Intl.PluralRules categories; each language has its own */
/**
 * @typedef {Omit<typeof ru, 'ui'> & { ui: Omit<typeof ru.ui, 'questions' | 'chaptersOf'> & { questions: PluralForms, chaptersOf: PluralForms } }} Strings
 */

/** @type {Record<string, Strings>} */
export const STRINGS = { ru, en };

/**
 * The strings of a language; an unknown language gets the original's.
 * @param {string | undefined} lang
 * @returns {Strings}
 */
export const stringsFor = (lang) => (lang && STRINGS[lang]) || ru;
