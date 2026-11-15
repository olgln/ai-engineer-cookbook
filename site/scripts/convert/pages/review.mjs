import strings from '../../../src/locales/ru.json' with { type: 'json' };
import { yamlStr } from '../markdown.mjs';

const { site } = strings;

/** Render the review page: a shell that the browser fills from the reader's progress (src/scripts/quiz/review-ui.ts). */
export function renderReview() {
  return [
    '---',
    `title: ${yamlStr(site.reviewTitle)}`,
    `description: ${yamlStr(site.reviewDescription)}`,
    'editUrl: false',
    'tableOfContents: false',
    // personal and empty without the reader's progress: nothing for search engines or the site search
    'pagefind: false',
    'head:',
    '  - { tag: meta, attrs: { name: robots, content: noindex } }',
    'prev: false',
    'next: false',
    '---',
    '',
    site.reviewIntro,
    '',
    '<div class="quiz-review" aria-live="polite"></div>',
    '',
  ].join('\n');
}
