// Converts the book chapters and the course plan (README.ru.md) into Starlight pages, then every translation
// (LOCALES in src/config/app.mjs) into pages under its language prefix.
// Source of truth stays in the book directory; everything under the docs directory is generated.
// This file only reads and writes files; the rendering itself lives in ./convert/.
// Exits with code 1 when there are warnings, so `npm run build` fails on a broken chapter.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  BOOK_DIR, CHAPTERS_FILE, DEFAULT_LOCALE, DOCS_DIR, I18N_FILE, LASTMOD_FILE, LOCALES, PLAN_PATH, PRIVACY_PATH, QUIZ_INDEX_FILE,
  REVIEW_PATH, SIDEBAR_FILE,
} from '../src/config/app.mjs';
import { config } from '../src/config/server.mjs';
import { localizePath } from '../src/locales/locales.mjs';
import { GIT_LOG_ARGS, pageDates, parseGitLog } from './convert/lastmod.mjs';
import { createRenderer } from './convert/renderer.mjs';
import { chapterFile, pagedChapters, parseToc, tocMismatches } from './convert/toc.mjs';
import { mergedQuizIndex, outdatedTranslations, sourceHash, structureMismatches } from './convert/translation.mjs';

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
/** Output file of a page path in a language's docs folder: `week-01/1-1` → docs/en/week-01/1-1.md. */
const docFile = (locale, name) => path.join(OUT, locale.prefix.slice(1), `${name}.md`);
const pageName = (p) => p.replaceAll('/', '');

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

// The original language: every page from its own sources.
const weeks = parseToc(read(path.join(BOOK, 'README.md')));
const r = createRenderer(weeks);
const flat = pagedChapters(weeks);
flat.forEach((it, i) => write(docFile(DEFAULT_LOCALE, it.slug), r.renderChapter(read(path.join(BOOK, chapterFile(it.ail))), it, flat[i - 1], flat[i + 1])));
const missing = r.unlisted(fs.readdirSync(BOOK));
if (missing.length) r.warnings.push(`files not in ${BOOK_DIR}/README.md: ${missing.join(', ')}`);
write(docFile(DEFAULT_LOCALE, pageName(PLAN_PATH)), r.renderPlan(read(path.join(ROOT, DEFAULT_LOCALE.planFile))));
write(docFile(DEFAULT_LOCALE, pageName(REVIEW_PATH)), r.renderReview());
// the analytics paragraph only in builds that load the beacon (CLOUDFLARE_WEB_ANALYTICS_TOKEN)
const privacyOptions = { analytics: Boolean(config.webAnalyticsToken) };
write(docFile(DEFAULT_LOCALE, pageName(PRIVACY_PATH)), r.renderPrivacy(privacyOptions));
write(docFile(DEFAULT_LOCALE, 'index'), r.renderIndex());

const warnings = [...r.warnings];
const chapters = { [DEFAULT_LOCALE.lang]: r.chapters() };
const quizIndex = { [DEFAULT_LOCALE.lang]: r.quizIndex() };
const sources = [...r.pageSources()];
/** @type {Record<string, import('./convert/toc.mjs').Week[]>} */
const translatedTocs = {};
/** Page paths (without the language prefix) that every language has, and the placeholder pages. */
let shared = new Set(['/', PRIVACY_PATH, PLAN_PATH, ...flat.map((it) => `/${it.slug}/`)]);
const placeholders = [];
const report = [];

// Translations: a chapter (or the plan) without a translated file gets a placeholder pointing to the original.
for (const locale of LOCALES.filter((l) => l.lang !== DEFAULT_LOCALE.lang)) {
  const { lang } = locale;
  const dir = path.join(ROOT, locale.bookDir);
  const tocFile = path.join(dir, 'README.md');
  if (!fs.existsSync(tocFile)) {
    warnings.push(`${lang}: ${locale.bookDir}/README.md (the table of contents) is missing`);
    continue;
  }
  const tw = parseToc(read(tocFile), locale);
  translatedTocs[lang] = tw;
  const t = createRenderer(tw, locale);
  for (const m of tocMismatches(weeks, tw)) t.warnings.push(`${locale.bookDir}/README.md: ${m}`);
  const tflat = pagedChapters(tw);
  const originalHref = new Map(flat.map((it) => [it.id, it.href]));
  const untranslated = new Map();
  tflat.forEach((it, i) => {
    const file = path.join(dir, chapterFile(it.ail));
    const [prev, next] = [tflat[i - 1], tflat[i + 1]];
    if (fs.existsSync(file)) {
      write(docFile(locale, it.slug), t.renderChapter(read(file), it, prev, next));
    } else {
      untranslated.set(it.id, originalHref.get(it.id));
      write(docFile(locale, it.slug), t.renderUntranslated({ title: `${it.num} · ${it.title}`, originalHref: originalHref.get(it.id), prev, next }));
    }
  });
  const extra = t.unlisted(fs.readdirSync(dir));
  if (extra.length) t.warnings.push(`files not in ${locale.bookDir}/README.md: ${extra.join(', ')}`);
  const planFile = path.join(ROOT, locale.planFile);
  const planTranslated = fs.existsSync(planFile);
  write(docFile(locale, pageName(PLAN_PATH)), planTranslated
    ? t.renderPlan(read(planFile))
    : t.renderUntranslated({ title: t.strings.site.planLabel, originalHref: PLAN_PATH }));
  write(docFile(locale, pageName(REVIEW_PATH)), t.renderReview());
  write(docFile(locale, pageName(PRIVACY_PATH)), t.renderPrivacy(privacyOptions));
  write(docFile(locale, 'index'), t.renderIndex());

  // progress is shared: a translated chapter keeps the original's quiz and checklist
  const translatedIds = tflat.filter((it) => !untranslated.has(it.id)).map((it) => it.id);
  const original = { quizzes: r.quizIndex(), checklists: r.checklists() };
  const translation = { quizzes: t.quizIndex(), checklists: t.checklists() };
  for (const id of translatedIds) t.warnings.push(...structureMismatches(id, original, translation));
  const currentHashes = Object.fromEntries(flat.filter((it) => translatedIds.includes(it.id))
    .map((it) => [it.id, sourceHash(read(path.join(BOOK, chapterFile(it.ail))))]));
  const outdated = outdatedTranslations(t.sourceHashes(), currentHashes);

  warnings.push(...t.warnings.map((w) => `${lang}: ${w}`));
  chapters[lang] = t.chapters(untranslated);
  quizIndex[lang] = mergedQuizIndex(r.quizIndex(), t.quizIndex());
  const stubs = new Set([...untranslated.keys()].map((id) => tflat.find((it) => it.id === id).href));
  if (!planTranslated) stubs.add(localizePath(PLAN_PATH, lang));
  sources.push(...t.pageSources().filter((p) => !stubs.has(p.href)));
  placeholders.push(...stubs);
  shared = new Set([...shared].filter((p) => !stubs.has(localizePath(p, lang))));
  report.push(`convert: ${lang}: ${translatedIds.length} of ${tflat.length} chapters translated, plan ${planTranslated ? 'translated' : 'not translated'}, `
    + `outdated (original changed since): ${outdated.length ? outdated.join(', ') : 'none'}`);
}

write(path.join(SITE, SIDEBAR_FILE), JSON.stringify(r.sidebar(translatedTocs), null, 2));
write(path.join(SITE, CHAPTERS_FILE), JSON.stringify(chapters, null, 2));
write(path.join(SITE, QUIZ_INDEX_FILE), JSON.stringify(quizIndex));
write(path.join(SITE, I18N_FILE), JSON.stringify({ shared: [...shared], placeholders }, null, 2));
write(path.join(SITE, LASTMOD_FILE), JSON.stringify(pageDates(sources, sourceDates()), null, 2));

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
    return parseGitLog(git(...GIT_LOG_ARGS, BOOK_DIR, ...LOCALES.map((l) => l.planFile)));
  } catch {
    console.log('convert: no git history, the sitemap gets no lastmod');
    return new Map();
  }
}

const { stats } = r;
console.log(`convert: ${stats.chapters} chapters, ${stats.questions} questions (${stats.choice} multiple-choice, ${stats.choiceWithKey} with answer key), ${stats.checks} checklist items, ${stats.mermaid} diagrams`);
for (const line of report) console.log(line);
if (warnings.length) {
  console.log(`convert: ${warnings.length} warnings\n  ` + [...new Set(warnings)].join('\n  '));
  process.exitCode = 1;
}
