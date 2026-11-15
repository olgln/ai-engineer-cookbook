// Content checks over the real book and its translations: every chapter converts without warnings,
// quizzes have answer keys, titles match the table of contents, translated chapters keep the original's
// quiz and checklist, and every Python example is valid syntax.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, test } from 'node:test';
import { BOOK_DIR, CHAPTER_PREFIX, DEFAULT_LOCALE, LOCALES } from '../src/config/app.mjs';
import strings from '../src/locales/ru.json' with { type: 'json' };
import { stringsFor } from '../src/locales/strings.mjs';
import { escapeRegExp } from '../src/locales/format.mjs';
import { tagLines } from '../scripts/convert/markdown.mjs';
import { createRenderer } from '../scripts/convert/renderer.mjs';
import { chapterFile, pagedChapters, parseToc, tocMismatches } from '../scripts/convert/toc.mjs';
import { structureMismatches } from '../scripts/convert/translation.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const BOOK = path.join(ROOT, BOOK_DIR);
const read = (file) => fs.readFileSync(path.join(BOOK, file), 'utf8');

const weeks = parseToc(read('README.md'));
const chapters = pagedChapters(weeks);

describe('book', () => {
  test('the table of contents lists every chapter file and every listed file exists', () => {
    assert.ok(chapters.length > 0);
    assert.deepEqual(createRenderer(weeks).unlisted(fs.readdirSync(BOOK)), []);
    for (const it of chapters) assert.ok(fs.existsSync(path.join(BOOK, chapterFile(it.ail))), `${chapterFile(it.ail)} is missing`);
  });

  test('every chapter converts without warnings and every multiple-choice question has a key', () => {
    const r = createRenderer(weeks);
    chapters.forEach((it, i) => r.renderChapter(read(chapterFile(it.ail)), it, chapters[i - 1], chapters[i + 1]));
    r.renderPlan(fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8'));
    assert.deepEqual(r.warnings, []);
    assert.equal(r.stats.chapters, chapters.length);
    assert.equal(r.stats.choice, r.stats.choiceWithKey);
  });

  test('the chapter and week badges of the plan in every language match the table of contents', () => {
    for (const locale of LOCALES) {
      const file = path.join(ROOT, locale.planFile);
      if (locale !== DEFAULT_LOCALE && !fs.existsSync(file)) continue;
      const readme = fs.readFileSync(file, 'utf8');
      const { book } = stringsFor(locale.lang);
      const badge = (label) => {
        const m = readme.match(new RegExp(`!\\[${escapeRegExp(label)}: (\\d+)\\]\\(https://img\\.shields\\.io/badge/[^-]+-(\\d+)-`));
        assert.ok(m, `${locale.planFile}: badge "${label}" is missing`);
        assert.equal(m[1], m[2], `${locale.planFile}: badge "${label}": alt text and image disagree`);
        return Number(m[1]);
      };
      assert.equal(badge(book.readmeChaptersBadge), chapters.length, locale.planFile);
      assert.equal(badge(book.readmeWeeksBadge), weeks.length, locale.planFile);
    }
  });

  test('each chapter starts with "# N.N · Title  (AIL-N)" matching the table of contents', () => {
    for (const it of chapters) {
      const first = read(chapterFile(it.ail)).split('\n')[0];
      const want = new RegExp(`^# ${escapeRegExp(it.num)} · .+ {2}\\(${escapeRegExp(CHAPTER_PREFIX)}${it.ail}\\)$`);
      assert.match(first, want, chapterFile(it.ail));
    }
  });
});

/** Translated chapter files that exist, per translation, with the translation's table of contents. */
const translations = LOCALES.filter((l) => l !== DEFAULT_LOCALE && fs.existsSync(path.join(ROOT, l.bookDir, 'README.md'))).map((locale) => {
  const dir = path.join(ROOT, locale.bookDir);
  const tweeks = parseToc(fs.readFileSync(path.join(dir, 'README.md'), 'utf8'), locale);
  const files = pagedChapters(tweeks).filter((it) => fs.existsSync(path.join(dir, chapterFile(it.ail))));
  return { locale, dir, weeks: tweeks, chapters: files, read: (file) => fs.readFileSync(path.join(dir, file), 'utf8') };
});

describe('translations', () => {
  for (const tr of translations) {
    const { locale } = tr;
    test(`${locale.lang}: the table of contents has the original's weeks, numbers and files`, () => {
      assert.deepEqual(tocMismatches(weeks, tr.weeks), []);
      assert.deepEqual(createRenderer(tr.weeks, locale).unlisted(fs.readdirSync(tr.dir)), []);
    });

    test(`${locale.lang}: translated chapters convert without warnings and keep the original's quiz and checklist`, () => {
      const r = createRenderer(weeks);
      chapters.forEach((it, i) => r.renderChapter(read(chapterFile(it.ail)), it, chapters[i - 1], chapters[i + 1]));
      const t = createRenderer(tr.weeks, locale);
      for (const it of tr.chapters) t.renderChapter(tr.read(chapterFile(it.ail)), it);
      const original = { quizzes: r.quizIndex(), checklists: r.checklists() };
      const translated = { quizzes: t.quizIndex(), checklists: t.checklists() };
      assert.deepEqual([...t.warnings, ...tr.chapters.flatMap((it) => structureMismatches(it.id, original, translated))], []);
    });

    test(`${locale.lang}: each translated chapter starts with "# N.N · Title  (AIL-N)" matching its table of contents`, () => {
      for (const it of tr.chapters) {
        const first = tr.read(chapterFile(it.ail)).split('\n')[0];
        assert.equal(first, `# ${it.num} · ${it.title}  (${CHAPTER_PREFIX}${it.ail})`, `${locale.bookDir}/${chapterFile(it.ail)}`);
      }
    });
  }
});

/** Python code blocks of all chapters and translations, dedented, with IPython magics (%, !) stripped. */
function pythonBlocks() {
  const blocks = [];
  const sources = [
    ...chapters.map((it) => ({ dir: BOOK_DIR, text: read(chapterFile(it.ail)), file: chapterFile(it.ail) })),
    ...translations.flatMap((tr) => tr.chapters.map((it) => ({ dir: tr.locale.bookDir, text: tr.read(chapterFile(it.ail)), file: chapterFile(it.ail) }))),
  ];
  for (const { dir, text, file } of sources) {
    const tagged = tagLines(text);
    for (let i = 0; i < tagged.length; i++) {
      if (!tagged[i].fenceStart || tagged[i].info !== 'python') continue;
      const { indent } = tagged[i];
      const start = i + 1;
      const lines = [];
      while (++i < tagged.length && !tagged[i].fenceEnd) lines.push(tagged[i].line.startsWith(indent) ? tagged[i].line.slice(indent.length) : tagged[i].line);
      blocks.push({ where: `${dir}/${file}:${start}`, code: lines.map((l) => (/^\s*[%!]/.test(l) ? '' : l)).join('\n') });
    }
  }
  return blocks;
}

// Parses each block with Python's own ast module; prints one error per bad block.
const PY_CHECK = `
import ast, json, sys
for b in json.load(sys.stdin):
    try:
        ast.parse(b["code"])
    except SyntaxError as e:
        print(f'{b["where"]}+{e.lineno}: {e.msg}')
`;

test('every Python example in the book is valid syntax', (t) => {
  const python = ['python3', 'python'].find((cmd) => spawnSync(cmd, ['--version']).status === 0);
  if (!python) return t.skip('python3 is not installed');
  const blocks = pythonBlocks();
  assert.ok(blocks.length > 0);
  const res = spawnSync(python, ['-I', '-c', PY_CHECK], { input: JSON.stringify(blocks), encoding: 'utf8' });
  assert.equal(res.status, 0, res.stderr);
  assert.equal(res.stdout, '', `Python syntax errors:\n${res.stdout}`);
});
