import { CHAPTER_PREFIX } from '../../../src/config/app.mjs';
import { transformBody } from '../links.mjs';
import { yamlStr } from '../markdown.mjs';
import { RE } from '../patterns.mjs';


/** Render a root plan file (README.ru.md, README.md for English) into the plan page. */
export function renderPlan(ctx, src) {
  const { re: RE, strings: { site } } = ctx;
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
