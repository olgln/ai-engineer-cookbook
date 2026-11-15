import { BOOK_DIR, CHAPTER_PREFIX, DESCRIPTION_MARKER, REPO_ONLY_END, REPO_ONLY_START } from '../../src/config/app.mjs';
import { escapeRegExp } from '../../src/locales/format.mjs';
import strings from '../../src/locales/ru.json' with { type: 'json' };

const { book } = strings;

// Patterns built from the configurable chapter prefix and the book's own headings.
const PREFIX = escapeRegExp(CHAPTER_PREFIX);
export const RE = {
  tocWeek: new RegExp(`^## ${escapeRegExp(book.weekHeading)} (\\d+) · (.+)$`),
  tocChapter: new RegExp(`^- \\[(\\d+)\\.(\\d+) · (.+?)\\]\\(${PREFIX}(\\d+)\\.md\\)`),
  tocNoPage: new RegExp(`^- (\\d+)\\.(\\d+) · (.+?) _\\(${escapeRegExp(book.noChapterNote)}\\)_`),
  // [text](AIL-N.md#anchor)
  fileLink: new RegExp(`\\]\\(${PREFIX}(\\d+)\\.md(#[^)]*)?\\)`, 'g'),
  // "1.2 · Title (AIL-56)"
  // the title may hold one level of parentheses: "9.5 · MCP-сервер (только чтение) (AIL-39)"
  titledRef: new RegExp(`(\\d+\\.\\d+ · (?:[^()\\[\\]]|\\([^()\\[\\]]*\\))+?)\\s+\\(${PREFIX}(\\d+)\\)(?!\\])`, 'g'),
  // link text starting with the chapter code: "[AIL-19 · Chunking](...)"
  linkText: new RegExp(`\\[${PREFIX}(\\d+)(?=[^\\]]*\\]\\()`, 'g'),
  // bare AIL-N not already inside a link target
  bareRef: new RegExp(`(?<![\\[/\\w-])${PREFIX}(\\d+)(?!\\d|\\.md)`, 'g'),
  titleSuffix: new RegExp(`\\s*\\(${PREFIX}\\d+\\)\\s*$`),
  chapterFile: new RegExp(`^${PREFIX}(\\d+)\\.md$`),
  planBookLink: new RegExp(`\\]\\(${escapeRegExp(BOOK_DIR)}/${PREFIX}(\\d+)\\.md`, 'g'),
  bookReadmeLink: new RegExp(`\\]\\((?:\\./)?${escapeRegExp(BOOK_DIR)}/README\\.md\\)`, 'g'),
  // <!-- description: … --> line of a chapter, with its line break
  description: new RegExp(`^<!--\\s*${escapeRegExp(DESCRIPTION_MARKER)}\\s*(.*?)\\s*-->[ \\t]*\\n?`, 'gm'),
  repoOnly: new RegExp(`${escapeRegExp(REPO_ONLY_START)}[\\s\\S]*?${escapeRegExp(REPO_ONLY_END)}\\n*`, 'g'),
  // option letters at the start of an answer: "b)", "a, c.", "a <and> c:"
  answerLetters: new RegExp(`^\\**\\s*([a-d](?:\\s*(?:,|${escapeRegExp(book.and)})\\s*[a-d])*)\\s*[.):]?\\**\\s*[.):]?`),
  answerStart: new RegExp(`^\\**\\s*[a-d]\\s*(?:(?:,|${escapeRegExp(book.and)})\\s*[a-d](?![A-Za-z])\\s*)*[.):*,]`),
};
