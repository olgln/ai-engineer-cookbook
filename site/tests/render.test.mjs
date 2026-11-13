// Unit tests for scripts/lib/render.mjs: table of contents, links, quizzes, checklists.
// Book headings come from ru.json, so the fixtures follow the same wording as the real book.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { PLAN_PATH, REPO_ONLY_END, REPO_ONLY_START } from '../src/config/app.mjs';
import { format } from '../src/locales/format.mjs';
import strings from '../src/locales/ru.json' with { type: 'json' };
import { answerKey, createRenderer, extractOptions, parseToc, splitNumbered, splitSections, tagLines } from '../scripts/lib/render.mjs';

const { book, site } = strings;

const TOC = [
  '# Book',
  '',
  `## ${book.weekHeading} 1 · Basics`,
  '',
  '- [1.1 · Python](AIL-1.md)',
  '- [1.2 · Repo (git)](AIL-56.md)',
  `- 1.3 · Review _(${book.noChapterNote})_`,
  '',
  `## ${book.weekHeading} 2 · Spare`,
  '',
  `- 2.1 · Buffer _(${book.noChapterNote})_`,
].join('\n');

const weeks = () => parseToc(TOC);
const renderer = () => createRenderer(weeks());

describe('parseToc', () => {
  test('reads weeks, chapters and items without a page', () => {
    const [w1, w2] = weeks();
    assert.equal(w1.n, 1);
    assert.equal(w1.title, 'Basics');
    assert.deepEqual(
      w1.items.map((i) => [i.num, i.ail ?? null, !!i.noPage]),
      [
        ['1.1', 1, false],
        ['1.2', 56, false],
        ['1.3', null, true],
      ],
    );
    assert.equal(w2.items.length, 1);
  });

  test('gives each page an id, slug and href', () => {
    const it = weeks()[0].items[1];
    assert.equal(it.id, '1-2');
    assert.equal(it.slug, 'week-01/1-2');
    assert.equal(it.href, '/week-01/1-2/');
    assert.equal(it.week, 1);
  });
});

describe('tagLines', () => {
  test('marks fenced code and handles nested longer fences', () => {
    const t = tagLines(['text', '````md', '```python', 'x', '```', '````', 'after'].join('\n'));
    assert.deepEqual(
      t.map((l) => l.code),
      [false, true, true, true, true, true, false],
    );
    assert.equal(t[1].info, 'md');
  });
});

describe('splitSections', () => {
  test('ignores "## " inside code', () => {
    const s = splitSections(['intro', '## A', '```', '## not a heading', '```', '## B', 'b'].join('\n'));
    assert.deepEqual(
      s.map((x) => x.heading),
      [null, 'A', 'B'],
    );
  });
});

describe('splitNumbered', () => {
  test('splits top-level items and dedents continuation lines', () => {
    const { pre, items } = splitNumbered(['lead', '1. First', '   more', '', '2. Second', '```', '3. code, not an item', '```']);
    assert.deepEqual(pre, ['lead']);
    assert.deepEqual(
      items.map((i) => i.n),
      [1, 2],
    );
    assert.deepEqual(items[0].lines, ['First', 'more']);
    assert.ok(items[1].lines.includes('3. code, not an item'));
  });
});

describe('extractOptions', () => {
  test('inline options on the question line', () => {
    const r = extractOptions(['What is it? a) one b) two; c) three d) four']);
    assert.deepEqual(r.question, ['What is it?']);
    assert.deepEqual(
      r.options.map((o) => [o.key, o.text]),
      [
        ['a', 'one'],
        ['b', 'two'],
        ['c', 'three'],
        ['d', 'four'],
      ],
    );
  });

  test('one option per line, with or without a dash', () => {
    const r = extractOptions(['Pick one:', 'a) one', '- b) two', 'c) three', 'tail']);
    assert.deepEqual(r.question, ['Pick one:', 'tail']);
    assert.deepEqual(
      r.options.map((o) => o.key),
      ['a', 'b', 'c'],
    );
  });

  test('ignores option-like text inside inline code', () => {
    const r = extractOptions(['Which? a) `f(a) b) c` b) plain']);
    assert.deepEqual(
      r.options.map((o) => o.text),
      ['`f(a) b) c`', 'plain'],
    );
  });

  test('returns null for an open question', () => {
    assert.equal(extractOptions(['Explain why a) is not an option here.']), null);
    assert.equal(extractOptions(['Plain question?']), null);
  });
});

describe('answerKey', () => {
  const cases = [
    ['**b.** because', ['b']],
    ['b) because', ['b']],
    ['**a, c.** both', ['a', 'c']],
    [`a ${book.and} d: both`, ['a', 'd']],
    ['**c**. bold letter only', ['c']],
  ];
  for (const [line, want] of cases) {
    test(`"${line}" → ${want}`, () => assert.deepEqual(answerKey([line]), want));
  }

  test('a word starting with a-d is not an answer letter', () => {
    assert.equal(answerKey(['because it is']), null);
    assert.equal(answerKey(['a list is mutable']), null);
    assert.equal(answerKey([]), null);
  });
});

describe('rewriteLinks', () => {
  test('file links keep the anchor', () => {
    const r = renderer();
    assert.equal(r.rewriteLinks('see [here](AIL-56.md#setup)'), 'see [here](/week-01/1-2/#setup)');
    assert.deepEqual(r.warnings, []);
  });

  test('titled reference, even with parentheses in the title, becomes a link', () => {
    const r = renderer();
    assert.equal(r.rewriteLinks('see 1.2 · Repo (git) (AIL-56).'), 'see [1.2 · Repo (git)](/week-01/1-2/).');
  });

  test('link text starting with the chapter code gets the chapter number', () => {
    assert.equal(renderer().rewriteLinks('[AIL-1 · Python](AIL-1.md)'), '[1.1 · Python](/week-01/1-1/)');
  });

  test('bare reference becomes a short chapter link', () => {
    assert.equal(renderer().rewriteLinks('as in AIL-1, we'), `as in [${format(site.chapterRef, { num: '1.1' })}](/week-01/1-1/), we`);
  });

  test('README links point to the index and the plan', () => {
    const r = renderer();
    assert.equal(r.rewriteLinks('[toc](book/README.md)'), '[toc](/)');
    assert.equal(r.rewriteLinks('[plan](README.md)'), `[plan](${PLAN_PATH})`);
  });

  test('inline code is left alone', () => {
    const r = renderer();
    assert.equal(r.rewriteLinks('`AIL-1` and `AIL-1.md`'), '`AIL-1` and `AIL-1.md`');
    assert.deepEqual(r.warnings, []);
  });

  test('unknown chapter stays as is and is reported', () => {
    const r = renderer();
    assert.equal(r.rewriteLinks('see AIL-999'), 'see AIL-999');
    assert.deepEqual(r.warnings, ['unknown chapter reference AIL-999']);
  });
});

describe('transformBody', () => {
  test('code blocks are not rewritten and mermaid becomes escaped <pre>', () => {
    const r = renderer();
    const out = r.transformBody(['```python', 'x = "AIL-1"', '```', '```mermaid', 'A --> B<br>', '```'].join('\n'));
    assert.match(out, /x = "AIL-1"/);
    assert.match(out, /<pre class="mermaid">A --&gt; B&lt;br&gt;<\/pre>/);
    assert.equal(r.stats.mermaid, 1);
  });
});

describe('buildQuiz', () => {
  test('marks the correct options and counts questions', () => {
    const r = renderer();
    const html = r.buildQuiz('1-1', ['1. Pick: a) x b) y', '2. Explain.'], ['1. **b.** y it is', '2. Because.']);
    assert.match(html, /<section class="quiz-q" data-n="1" data-correct="b">/);
    assert.match(html, /<section class="quiz-q" data-n="2">/);
    assert.match(html, /- \*\*a\)\*\* x/);
    assert.deepEqual(r.stats, { chapters: 0, questions: 2, choice: 1, choiceWithKey: 1, checks: 0, mermaid: 0 });
    assert.deepEqual(r.warnings, []);
  });

  test('warns about a missing answer and a missing answer letter', () => {
    const r = renderer();
    const html = r.buildQuiz('1-1', ['1. Pick: a) x b) y', '2. Explain.'], ['1. y, obviously']);
    assert.ok(html.includes(site.noAnswer));
    assert.deepEqual(r.warnings, ['1-1: 2 questions vs 1 answers', '1-1 q1: options but no answer letter: "y, obviously"', '1-1: no answer for question 2']);
  });
});

describe('buildChecklist', () => {
  test('turns plain bullets into unchecked boxes, outside code', () => {
    const r = renderer();
    const out = r.buildChecklist('1-1', ['- one', '* two', '- [x] done', '```', '- code', '```']);
    assert.match(out, /- \[ \] one/);
    assert.match(out, /\* \[ \] two/);
    assert.match(out, /- \[x\] done/);
    assert.match(out, /\n- code\n/);
    assert.equal(r.stats.checks, 2);
  });
});

describe('renderChapter', () => {
  const src = (sections) => ['# 1.2 · Repo  (AIL-56)', '', 'Intro, see AIL-1.', '', ...sections].join('\n');
  const full = [`## ${book.doneHeading}`, '', '- works', '', `## ${book.testHeading}`, '', '1. Q? a) x b) y', '', `## ${book.answersHeading}`, '', '1. **a.** x'];

  test('front matter, quiz in place of the answers, checklist, prev/next', () => {
    const r = renderer();
    const [w1] = weeks();
    const page = r.renderChapter(src(full), w1.items[1], w1.items[0], undefined);
    assert.match(page, /^---\ntitle: "1\.2 · Repo"\n/);
    assert.match(page, /prev: \{ link: "\/week-01\/1-1\/", label: "1\.1 · Python" \}/);
    assert.match(page, /next: false/);
    assert.ok(!page.includes(`## ${book.answersHeading}`));
    assert.match(page, /data-correct="a"/);
    assert.match(page, /- \[ \] works/);
    assert.match(page, /<div class="chapter-done" data-chapter="1-2"><\/div>/);
    assert.equal(r.stats.chapters, 1);
    assert.deepEqual(r.warnings, []);
  });

  test('warns when the quiz sections are missing', () => {
    const r = renderer();
    r.renderChapter(src([]), weeks()[0].items[1]);
    assert.deepEqual(r.warnings, ['1-2: missing test or answers section']);
  });
});

describe('renderPlan, renderIndex, sidebar, chapters', () => {
  test('plan drops repo-only blocks and links to chapters', () => {
    const r = renderer();
    const page = r.renderPlan(['# Plan', 'keep', REPO_ONLY_START, 'hidden', REPO_ONLY_END, '', '[ch](book/AIL-1.md)'].join('\n'));
    assert.match(page, /title: "Plan"/);
    assert.ok(!page.includes('hidden'));
    assert.match(page, /\[ch\]\(\/week-01\/1-1\/\)/);
  });

  test('index lists every item; sidebar skips weeks without pages', () => {
    const r = renderer();
    const index = r.renderIndex();
    assert.match(index, /- \[1\.1 · Python\]\(\/week-01\/1-1\/\)/);
    assert.match(index, /- 2\.1 · Buffer\n/);
    const sb = r.sidebar();
    assert.equal(sb.length, 3);
    assert.deepEqual(
      sb[2].items.map((i) => i.attrs['data-chapter']),
      ['1-1', '1-2'],
    );
    assert.deepEqual(
      r.chapters().map((c) => c.id),
      ['1-1', '1-2'],
    );
  });

  test('unlisted finds chapter files missing from the table of contents', () => {
    assert.deepEqual(renderer().unlisted(['AIL-1.md', 'AIL-7.md', 'README.md']), ['AIL-7.md']);
  });
});
