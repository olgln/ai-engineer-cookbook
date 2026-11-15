// Writes the files a static hosting reads from the build output: _headers (security and cache
// headers, Netlify / Cloudflare format), _redirects (pages of renumbered chapters) and robots.txt
// (points crawlers to the sitemap).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CHAPTER_ID_RENAMES, HEADERS_FILE, HTTPS_ONLY_HEADERS, IMMUTABLE_ASSETS_GLOB, IMMUTABLE_CACHE_CONTROL, LOCALES,
  REDIRECTS_FILE, ROBOTS_FILE, SECURITY_HEADERS, SITEMAP_FILE,
} from '../config/app.mjs';
import { localizePath } from '../locales/locales.mjs';
import { chapterSlug } from '../../scripts/convert/toc.mjs';

const block = (pattern, headers) =>
  [pattern, ...Object.entries(headers).map(([name, value]) => `  ${name}: ${value}`)].join('\n');

/** Contents of _headers: security headers on every path, long caching for hashed assets. */
export function headersFile() {
  return [
    block('/*', { ...SECURITY_HEADERS, ...HTTPS_ONLY_HEADERS }),
    block(IMMUTABLE_ASSETS_GLOB, { 'Cache-Control': IMMUTABLE_CACHE_CONTROL }),
  ].join('\n\n') + '\n';
}

/**
 * Contents of _redirects: the old page of a renamed chapter goes permanently to its new page, in every language,
 * when the old path no longer exists. An old path that another chapter took over keeps that chapter.
 * @param {Record<number, Record<string, string>>} renames chapter id renames by progress version
 * @param {(path: string) => boolean} exists whether the build has a page at this path
 */
export function redirectsFile(renames, exists) {
  const versions = Object.keys(renames).map(Number).sort((a, b) => a - b);
  /** the id a chapter has now, after this and every later renumbering */
  const latest = (id, from) => versions.filter((v) => v >= from).reduce((cur, v) => renames[v][cur] ?? cur, id);
  const lines = versions.flatMap((v) => Object.keys(renames[v]).flatMap((oldId) =>
    LOCALES.map(({ lang }) => [localizePath(`/${chapterSlug(oldId)}/`, lang), localizePath(`/${chapterSlug(latest(oldId, v))}/`, lang)])))
    .filter(([from, to]) => from !== to && !exists(from) && exists(to))
    .map(([from, to]) => `${from} ${to} 301`);
  return [...new Set(lines)].join('\n') + (lines.length ? '\n' : '');
}

/** Contents of robots.txt; the sitemap line only when the public address is known. */
export function robotsTxt(site) {
  const lines = ['User-agent: *', 'Allow: /'];
  if (site) lines.push('', `Sitemap: ${new URL(SITEMAP_FILE, site).href}`);
  return lines.join('\n') + '\n';
}

export default function deployFiles() {
  let site;
  return {
    name: 'deploy-files',
    hooks: {
      'astro:config:done': ({ config }) => {
        site = config.site;
      },
      'astro:build:done': ({ dir }) => {
        const out = fileURLToPath(dir);
        fs.writeFileSync(path.join(out, HEADERS_FILE), headersFile());
        const exists = (page) => fs.existsSync(path.join(out, page, 'index.html'));
        fs.writeFileSync(path.join(out, REDIRECTS_FILE), redirectsFile(CHAPTER_ID_RENAMES, exists));
        fs.writeFileSync(path.join(out, ROBOTS_FILE), robotsTxt(site));
      },
    },
  };
}
