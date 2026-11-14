// Converts the book chapters and the root README.md into Starlight pages.
// Source of truth stays in the book directory; everything under the docs directory is generated.
// This file only reads and writes files; the rendering itself lives in ./lib/render.mjs.
// Exits with code 1 when there are warnings, so `npm run build` fails on a broken chapter.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BOOK_DIR, CHAPTERS_FILE, DOCS_DIR, LASTMOD_FILE, PLAN_PATH, SIDEBAR_FILE } from '../src/config/app.mjs';
import { GIT_LOG_ARGS, pageDates, parseGitLog } from './lib/lastmod.mjs';
import { chapterFile, createRenderer, pagedChapters, parseToc } from './lib/render.mjs';

const SITE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ROOT = path.resolve(SITE, '..');
const BOOK = path.join(ROOT, BOOK_DIR);
const OUT = path.join(SITE, DOCS_DIR);

const read = (file) => fs.readFileSync(file, 'utf8');
const git = (...args) => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
function write(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

const weeks = parseToc(read(path.join(BOOK, 'README.md')));
const r = createRenderer(weeks);

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });
const flat = pagedChapters(weeks);
flat.forEach((it, i) => write(path.join(OUT, `${it.slug}.md`), r.renderChapter(read(path.join(BOOK, chapterFile(it.ail))), it, flat[i - 1], flat[i + 1])));
const missing = r.unlisted(fs.readdirSync(BOOK));
if (missing.length) r.warnings.push(`files not in ${BOOK_DIR}/README.md: ${missing.join(', ')}`);
write(path.join(OUT, `${PLAN_PATH.replaceAll('/', '')}.md`), r.renderPlan(read(path.join(ROOT, 'README.md'))));
write(path.join(OUT, 'index.md'), r.renderIndex());
write(path.join(SITE, SIDEBAR_FILE), JSON.stringify(r.sidebar(), null, 2));
write(path.join(SITE, CHAPTERS_FILE), JSON.stringify(r.chapters(), null, 2));
write(path.join(SITE, LASTMOD_FILE), JSON.stringify(pageDates(r.pageSources(), sourceDates()), null, 2));

/**
 * Newest commit date of each source file. Empty without git history: outside a repository, or in a
 * shallow clone, where every file would get the date of the last commit.
 */
function sourceDates() {
  try {
    if (git('rev-parse', '--is-shallow-repository').trim() === 'true') {
      console.log('convert: shallow git clone, the sitemap gets no lastmod (run `git fetch --unshallow` first)');
      return new Map();
    }
    return parseGitLog(git(...GIT_LOG_ARGS, BOOK_DIR, 'README.md'));
  } catch {
    console.log('convert: no git history, the sitemap gets no lastmod');
    return new Map();
  }
}

const { stats } = r;
console.log(`convert: ${stats.chapters} chapters, ${stats.questions} questions (${stats.choice} multiple-choice, ${stats.choiceWithKey} with answer key), ${stats.checks} checklist items, ${stats.mermaid} diagrams`);
if (r.warnings.length) {
  console.log(`convert: ${r.warnings.length} warnings\n  ` + [...new Set(r.warnings)].join('\n  '));
  process.exitCode = 1;
}
