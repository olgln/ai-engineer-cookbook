import { PRIVACY_CONTACT, PRIVACY_POLICY_DATE } from '../../../src/config/app.mjs';
import { format } from '../../../src/locales/format.mjs';
import strings from '../../../src/locales/ru.json' with { type: 'json' };
import { escapeHtml, yamlStr } from '../markdown.mjs';

const { ui } = strings;

/** Sections of the privacy page in order (keys of `privacy.sections` in ru.json); `analytics` only with the beacon. */
export const PRIVACY_SECTIONS = ['withoutAccount', 'signIn', 'cookies', 'analytics', 'rights', 'contact'];

/**
 * The privacy contact as Markdown: an e-mail becomes a mailto: link, an https:// address a link, anything
 * else plain text; empty (not filled in yet) gives the placeholder from ru.json.
 * @param {string} contact
 */
export function contactMarkdown(contact) {
  const value = contact.trim();
  if (!value) return `_${strings.privacy.contactPlaceholder}_`;
  if (/^[^\s@<>()[\]]+@[^\s@<>()[\]]+\.[^\s@<>()[\]]+$/.test(value)) return `[${value}](mailto:${value})`;
  if (/^https:\/\/[^\s<>()[\]]+$/.test(value)) return `[${value}](${value})`;
  return escapeHtml(value).replace(/[\\`*_[\]]/g, '\\$&');
}

/** A YYYY-MM-DD date in words in the site language (day, month name, year), or null when it is not a real date. */
export function longDate(isoDate) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(isoDate)) return null;
  const date = new Date(`${isoDate}T00:00:00Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== isoDate) return null;
  return new Intl.DateTimeFormat(strings.dateLocale, { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' }).format(date);
}

/** Markdown of one section block from ru.json: a string is a paragraph, an array a bulleted list. */
const privacyBlock = (block, vars) =>
  Array.isArray(block) ? block.map((item) => `- ${format(item, vars)}`).join('\n') : format(block, vars);

/**
 * Render the privacy policy page from `privacy` in ru.json. Names, lifetimes and storage keys come from
 * src/config/app.mjs, so the text follows the code. The analytics section appears only in builds with the
 * Cloudflare Web Analytics beacon; an empty contact shows a placeholder (fill it in before going live).
 * @param {{ analytics?: boolean, contact?: string, date?: string }} [options]
 */
export function renderPrivacy(ctx, { analytics = false, contact = PRIVACY_CONTACT, date = PRIVACY_POLICY_DATE } = {}) {
  const { privacy } = strings;
  const updated = longDate(date);
  if (!updated) ctx.warnings.push(`privacy policy date "${date}" is not a YYYY-MM-DD date`);
  const vars = {
    deleteLabel: ui.deleteAccount,
    contact: contactMarkdown(contact),
  };
  const sections = PRIVACY_SECTIONS
    .filter((key) => analytics || key !== 'analytics')
    .flatMap((key) => {
      const section = privacy.sections[key];
      return [`## ${section.heading}`, '', ...section.blocks.flatMap((b) => [privacyBlock(b, vars), '']), ''];
    });
  return [
    '---',
    `title: ${yamlStr(privacy.title)}`,
    `description: ${yamlStr(privacy.description)}`,
    'editUrl: false',
    'prev: false',
    'next: false',
    '---',
    '',
    `_${format(privacy.updated, { date: updated ?? date })}_`,
    '',
    privacy.intro,
    '',
    ...sections,
  ].join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n';
}
