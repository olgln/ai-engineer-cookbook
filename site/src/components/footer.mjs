// Text of the site footer shown under every page. Pure, so it can be tested without rendering
// Astro components (tests/footer.test.mjs).
import { format } from '../locales/format.mjs';

/**
 * @param {typeof import('../locales/ru.json')} strings
 * @param {number} year
 */
export const copyrightLine = (strings, year) => format(strings.footer.copyright, { year, title: strings.site.title });
