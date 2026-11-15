// Last change of each page's source, from `git log`, for <lastmod> in the sitemap: search engines
// re-crawl a page sooner when its date moves. Pure, so it is tested without git (tests/convert/lastmod.test.mjs);
// scripts/convert.mjs runs git and writes the result to LASTMOD_FILE.

/** `git log` arguments: one record per commit (NUL, committer date), then the files it changed; paths follow. */
export const GIT_LOG_ARGS = ['log', '--format=%x00%cI', '--name-only', '--'];

/** Newest commit date of each file in GIT_LOG_ARGS output (git lists commits newest first). */
export function parseGitLog(text) {
  const dates = new Map();
  for (const record of text.split('\0').slice(1)) {
    const [date, ...files] = record.trim().split('\n');
    for (const file of files) if (file && !dates.has(file)) dates.set(file, date);
  }
  return dates;
}

/**
 * Date of each page's source, keyed by the page path; pages whose source has no commit are left out.
 * @param {{ href: string, source: string }[]} pages
 * @param {Map<string, string>} fileDates
 */
export function pageDates(pages, fileDates) {
  return Object.fromEntries(pages.filter((p) => fileDates.has(p.source)).map((p) => [p.href, fileDates.get(p.source)]));
}

/**
 * `filter` option of @astrojs/sitemap: whether a page belongs in the sitemap.
 * @param {string} page absolute URL of the page
 * @param {string[]} excluded page paths to leave out
 */
export const inSitemap = (page, excluded) => !excluded.includes(new URL(page).pathname);

/**
 * `serialize` option of @astrojs/sitemap: adds the date of the page, when known, to its sitemap entry.
 * @template {{ url: string }} T
 * @param {T} item
 * @param {Record<string, string>} dates
 */
export function withLastmod(item, dates) {
  const date = dates[new URL(item.url).pathname];
  return date ? { ...item, lastmod: date } : item;
}
