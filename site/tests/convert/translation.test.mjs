// Translations in the converter: a translated table of contents and chapters, placeholders of untranslated
// chapters, and the checks that keep a translation's quiz and checklist in step with the original
// (reading progress is shared between the languages). Headings come from ru.json / en.json.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { LOCALES, SOURCE_HASH_LENGTH, SOURCE_HASH_MARKER } from '../../src/config/app.mjs';
import en from '../../src/locales/en.json' with { type: 'json' };
import ru from '../../src/locales/ru.json' with { type: 'json' };
import { sitemapExcluded } from '../../scripts/convert/lastmod.mjs';
import { createRenderer } from '../../scripts/convert/renderer.mjs';
import { chapterList, pagedChapters, parseToc, tocMismatches } from '../../scripts/convert/toc.mjs';
import {
  mergedQuizIndex, outdatedTranslations, sourceHash, structureMismatches,
} from '../../scripts/convert/translation.mjs';

const EN = LOCALES.find((l) => l.lang === 'en');

const toc = (s, titles) => [
  `# Book`,
  '',
  `## ${s.book.weekHeading} 1 · ${titles[0]}`,
  '',
  `- [1.1 · ${titles[1]}](AIL-1.md)`,
  `- [1.2 · ${titles[2]}](AIL-56.md)`,
  `- 1.3 · ${titles[3]} _(${s.book.noChapterNote})_`,
].join('\n');
const ruWeeks = () => parseToc(toc(ru, ['Основы', 'Питон', 'Репозиторий', 'Повтор']));
const enWeeks = () => parseToc(toc(en, ['Basics', 'Python', 'Repository', 'Review']), EN);

const chapter = (s, { hash = 'abc123def456', quizKey = 'b', checks = 2 } = {}) => [
  '# 1.1 · Python  (AIL-1)',
  '',
  `> **${s.book.weekHeading} 1** · x`,
  '',
  '<!-- description: About Python. -->',
  hash === null ? '' : `<!-- ${SOURCE_HASH_MARKER} ${hash} -->`,
  '',
  '## Theory',
  '',
  'See [the repo](AIL-56.md) and the [plan](README.md).',
  '',
  `## ${s.book.doneHeading}`,
  '',
  ...Array.from({ length: checks }, (_, i) => `- item ${i + 1}`),
  '',
  `## ${s.book.testHeading}`,
  '',
  '1. Pick: a) x b) y',
  '2. Explain.',
  '',
  `## ${s.book.answersHeading}`,
  '',
  `1. **${quizKey}.** because`,
  '2. Because.',
].join('\n');

describe('a translated table of contents', () => {
  test('keeps the ids and slugs of the original; links carry the language prefix', () => {
    const [c1] = pagedChapters(enWeeks());
    assert.equal(c1.id, '1-1');
    assert.equal(c1.slug, 'week-01/1-1');
    assert.equal(c1.href, '/en/week-01/1-1/');
    assert.equal(c1.title, 'Python');
  });

  test('tocMismatches is empty when only the titles differ and names every structural difference', () => {
    assert.deepEqual(tocMismatches(ruWeeks(), enWeeks()), []);
    const other = parseToc(toc(en, ['Basics', 'Python', 'Repository', 'Review']).replace('AIL-56', 'AIL-57'), EN);
    assert.deepEqual(tocMismatches(ruWeeks(), other), ['1.2 AIL-56.md in the original, 1.2 AIL-57.md in the translation']);
    const shorter = parseToc(toc(en, ['Basics', 'Python', 'Repository', 'Review']).split('\n').slice(0, -1).join('\n'), EN);
    assert.deepEqual(tocMismatches(ruWeeks(), shorter), ['1.3 (no page) in the original, (nothing) in the translation']);
  });

  test('the sidebar keeps the original\'s labels and links and adds the translated labels', () => {
    const sb = createRenderer(ruWeeks()).sidebar({ en: enWeeks() });
    assert.deepEqual(sb[0], { label: ru.site.tocLabel, translations: { en: en.site.tocLabel }, link: '/' });
    assert.deepEqual(sb[3].translations, { en: 'Week 1 · Basics' });
    assert.deepEqual(sb[3].items[0], {
      label: '1.1 · Питон', translations: { en: '1.1 · Python' }, link: '/week-01/1-1/', attrs: { 'data-chapter': '1-1' },
    });
  });

  test('the chapter list of a translation points untranslated chapters to the original for reading', () => {
    const list = chapterList(enWeeks(), new Map([['1-2', '/week-01/1-2/']]));
    assert.deepEqual(list.map((c) => [c.id, c.href, c.readHref]), [
      ['1-1', '/en/week-01/1-1/', '/en/week-01/1-1/'],
      ['1-2', '/en/week-01/1-2/', '/week-01/1-2/'],
    ]);
  });

  test('pageSources of a translation name its own files', () => {
    assert.deepEqual(createRenderer(enWeeks(), EN).pageSources(), [
      { href: '/en/', source: 'book/en/README.md' },
      { href: '/en/plan/', source: EN.planFile },
      { href: '/en/week-01/1-1/', source: 'book/en/AIL-1.md' },
      { href: '/en/week-01/1-2/', source: 'book/en/AIL-56.md' },
    ]);
  });
});

describe('a translated chapter', () => {
  const render = (src) => {
    const weeks = enWeeks();
    const [c1, c2] = pagedChapters(weeks);
    const t = createRenderer(weeks, EN);
    return { t, page: t.renderChapter(src, c1, undefined, c2) };
  };

  test('is parsed with the translation\'s headings and links within its language', () => {
    const { t, page } = render(chapter(en));
    assert.deepEqual(t.warnings, []);
    assert.match(page, /<div class="quiz" data-chapter="1-1">/);
    assert.match(page, /data-correct="b"/);
    assert.match(page, /<div class="done-list" data-chapter="1-1">/);
    assert.match(page, /\[the repo\]\(\/en\/week-01\/1-2\/\)/);
    assert.match(page, /\[plan\]\(\/en\/plan\/\)/);
    assert.match(page, /next: \{ link: "\/en\/week-01\/1-2\/", label: "1\.2 · Repository" \}/);
    assert.match(page, /Generated from book\/en\/AIL-1\.md/);
    assert.doesNotMatch(page, new RegExp(SOURCE_HASH_MARKER), 'the hash comment is not on the page');
    assert.deepEqual(t.sourceHashes(), { '1-1': 'abc123def456' });
    assert.deepEqual(t.checklists(), { '1-1': 2 });
  });

  test('without a source hash is a warning; the original must not have one', () => {
    assert.deepEqual(render(chapter(en, { hash: null })).t.warnings, ['en 1-1: missing source hash comment']);
    const r = createRenderer(ruWeeks());
    r.renderChapter(chapter(ru), pagedChapters(ruWeeks())[0]);
    assert.deepEqual(r.warnings, ['1-1: a source hash comment belongs in translations only']);
  });

  test('the placeholder of an untranslated chapter links the original and stays out of search', () => {
    const t = createRenderer(enWeeks(), EN);
    const page = t.renderUntranslated({ title: '1.2 · Repository', originalHref: '/week-01/1-2/' });
    assert.match(page, /title: "1\.2 · Repository"/);
    assert.match(page, /\npagefind: false\n/);
    assert.match(page, /\n {2}- \{ tag: meta, attrs: \{ name: robots, content: noindex \} \}\n/);
    assert.ok(page.includes('](/week-01/1-2/)'));
    assert.equal(t.stats.untranslated, 1);
  });

  test('the index, review and privacy pages of a translation are in its language', () => {
    const t = createRenderer(enWeeks(), EN);
    assert.ok(t.renderIndex().includes(`title: ${JSON.stringify(en.site.indexTitle)}`));
    assert.ok(t.renderIndex().includes('](/en/plan/)'));
    assert.ok(t.renderReview().includes(en.site.reviewIntro));
    assert.ok(t.renderPrivacy().includes(`title: ${JSON.stringify(en.privacy.title)}`));
  });
});

describe('translation checks', () => {
  const shapes = (src, s, locale) => {
    const weeks = locale ? enWeeks() : ruWeeks();
    const r = createRenderer(weeks, locale);
    r.renderChapter(src, pagedChapters(weeks)[0]);
    return { quizzes: r.quizIndex(), checklists: r.checklists() };
  };
  const original = () => shapes(chapter(ru, { hash: null }), ru);

  test('a translation with the same quiz and checklist passes', () => {
    assert.deepEqual(structureMismatches('1-1', original(), shapes(chapter(en), en, EN)), []);
  });

  test('another answer key or checklist length is reported', () => {
    assert.deepEqual(structureMismatches('1-1', original(), shapes(chapter(en, { quizKey: 'a', checks: 3 }), en, EN)), [
      '1-1: quiz differs from the original (questions[:key] "1:a 2" vs "1:b 2")',
      '1-1: 3 checklist items vs 2 in the original',
    ]);
  });

  test('sourceHash is a short SHA-256 prefix; changed originals are outdated', () => {
    assert.equal(sourceHash('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'.slice(0, SOURCE_HASH_LENGTH));
    assert.deepEqual(outdatedTranslations({ '1-1': 'aaa', '1-2': 'bbb' }, { '1-1': 'aaa', '1-2': 'ccc' }), ['1-2']);
  });

  test('a translation\'s review index uses its own questions and the original\'s for untranslated chapters', () => {
    const merged = mergedQuizIndex({ '1-1': [{ n: 1, text: 'ру' }], '1-2': [{ n: 1, text: 'ру2' }] }, { '1-1': [{ n: 1, text: 'en' }] });
    assert.deepEqual(merged, { '1-1': [{ n: 1, text: 'en' }], '1-2': [{ n: 1, text: 'ру2' }] });
  });

  test('the sitemap leaves out excluded paths in every language and the placeholders', () => {
    assert.deepEqual(sitemapExcluded(['/review/'], ['/en/week-01/1-2/']), ['/review/', '/en/review/', '/en/week-01/1-2/']);
  });
});
