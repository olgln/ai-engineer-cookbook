// Text and links of the site footer shown under every page. Pure, so it can be tested without rendering
// Astro components (tests/site/footer.test.mjs).
import { PRIVACY_PATH } from '../config/app.mjs';
import { format } from '../locales/format.mjs';
import { localizePath } from '../locales/locales.mjs';

/**
 * @param {import('../locales/strings.mjs').Strings} strings
 * @param {number} year
 */
export const copyrightLine = (strings, year) => format(strings.footer.copyright, { year, title: strings.site.title });

/**
 * Links in the footer, in order: the privacy policy, in the language of `strings`.
 * @param {import('../locales/strings.mjs').Strings} strings
 * @returns {{ href: string, label: string }[]}
 */
export const footerLinks = (strings) => [{ href: localizePath(PRIVACY_PATH, strings.lang), label: strings.footer.privacy }];
