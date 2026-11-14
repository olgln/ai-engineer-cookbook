// Astro's CSP (`security.csp`) hashes the scripts it bundles, but not `is:inline` scripts that come
// from components such as Starlight's theme switcher and sidebar. Without their hashes the browser
// blocks them. After the build this integration adds the hash of every inline script on a page to
// that page's CSP <meta> tag.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_RE = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
const CSP_META_RE = /(<meta\s+http-equiv="content-security-policy"\s+content=")([^"]*)(")/i;
/** Script types the browser does not execute, so the CSP does not apply to them. */
const DATA_TYPE_RE = /\btype\s*=\s*["']?(application\/(ld\+)?json|importmap)/i;

const hashOf = (code) => `'sha256-${crypto.createHash('sha256').update(code, 'utf8').digest('base64')}'`;

/** Hashes of the executable inline scripts of a page, in page order, without duplicates. */
export function inlineScriptHashes(html) {
  const hashes = new Set();
  for (const [, attrs, code] of html.matchAll(SCRIPT_RE)) {
    if (/\bsrc\s*=/i.test(attrs) || DATA_TYPE_RE.test(attrs) || !code) continue;
    hashes.add(hashOf(code));
  }
  return [...hashes];
}

/**
 * Adds the missing inline-script hashes to the script-src directive of the page's CSP <meta>.
 * Pages without that meta tag (or without script-src) are returned unchanged.
 */
export function addInlineScriptHashes(html) {
  const meta = html.match(CSP_META_RE);
  if (!meta) return html;
  const directives = meta[2].split(';');
  const i = directives.findIndex((d) => d.trim().startsWith('script-src'));
  if (i === -1) return html;
  const present = new Set(directives[i].trim().split(/\s+/));
  const missing = inlineScriptHashes(html).filter((h) => !present.has(h));
  if (!missing.length) return html;
  directives[i] = `${directives[i].trimEnd()} ${missing.join(' ')}`;
  return html.replace(CSP_META_RE, (_m, start, _content, end) => start + directives.join(';') + end);
}

function* htmlFiles(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* htmlFiles(full);
    else if (entry.name.endsWith('.html')) yield full;
  }
}

export default function cspInlineHashes() {
  return {
    name: 'csp-inline-hashes',
    hooks: {
      'astro:build:done': ({ dir, logger }) => {
        let changed = 0;
        for (const file of htmlFiles(fileURLToPath(dir))) {
          const html = fs.readFileSync(file, 'utf8');
          const next = addInlineScriptHashes(html);
          if (next !== html) {
            fs.writeFileSync(file, next);
            changed++;
          }
        }
        logger.info(`added inline-script hashes to the CSP of ${changed} pages`);
      },
    },
  };
}
