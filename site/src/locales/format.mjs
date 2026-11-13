// Tiny helpers for the UI strings in ./ru.json.

/**
 * Replace {name} placeholders in a template.
 * @param {string} template
 * @param {Record<string, string | number>} [vars]
 */
export const format = (template, vars = {}) => template.replace(/\{(\w+)\}/g, (all, name) => (name in vars ? String(vars[name]) : all));

/**
 * Pick the plural form of a word for a number: forms are keyed by Intl.PluralRules categories.
 * @param {string} lang
 * @param {number} n
 * @param {Record<string, string>} forms
 */
export function plural(lang, n, forms) {
  return forms[new Intl.PluralRules(lang).select(n)] ?? forms.other;
}

/**
 * Escape a string for use inside a RegExp.
 * @param {string} s
 */
export const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
