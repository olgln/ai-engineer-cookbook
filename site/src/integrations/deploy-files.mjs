// Writes the files a static hosting reads from the build output: _headers (security and cache
// headers, Netlify / Cloudflare Pages format) and robots.txt (points crawlers to the sitemap).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  HEADERS_FILE, HTTPS_ONLY_HEADERS, IMMUTABLE_ASSETS_GLOB, IMMUTABLE_CACHE_CONTROL, ROBOTS_FILE,
  SECURITY_HEADERS, SITEMAP_FILE,
} from '../config/app.mjs';

const block = (pattern, headers) =>
  [pattern, ...Object.entries(headers).map(([name, value]) => `  ${name}: ${value}`)].join('\n');

/** Contents of _headers: security headers on every path, long caching for hashed assets. */
export function headersFile() {
  return [
    block('/*', { ...SECURITY_HEADERS, ...HTTPS_ONLY_HEADERS }),
    block(IMMUTABLE_ASSETS_GLOB, { 'Cache-Control': IMMUTABLE_CACHE_CONTROL }),
  ].join('\n\n') + '\n';
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
        fs.writeFileSync(path.join(out, ROBOTS_FILE), robotsTxt(site));
      },
    },
  };
}
