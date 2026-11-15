import { CHAPTER_PREFIX } from '../../../src/config/app.mjs';
import strings from '../../../src/locales/ru.json' with { type: 'json' };
import { transformBody } from '../links.mjs';
import { yamlStr } from '../markdown.mjs';
import { RE } from '../patterns.mjs';

const { site } = strings;

/** Render the root README.md into the plan page. */
export function renderPlan(ctx, src) {
  const h1 = src.match(/^# (.+)$/m);
  const body = src
    .replace(h1[0], '')
    // repo-only blocks (e.g. the pointer to site/README.md) are not part of the plan page
    .replace(RE.repoOnly, '')
    .replace(RE.planBookLink, `](${CHAPTER_PREFIX}$1.md`);
  const fm = [
    '---',
    `title: ${yamlStr(h1[1].trim())}`,
    `description: ${yamlStr(site.planDescription)}`,
    'editUrl: false',
    '---',
    '',
  ].join('\n');
  return fm + transformBody(ctx, body);
}
