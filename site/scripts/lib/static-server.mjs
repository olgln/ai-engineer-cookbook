// Request handler that serves a built site folder: path checks, content types, security headers,
// 404 page, and (optionally) the live-reload script added to every HTML page.
import fs from 'node:fs';
import path from 'node:path';
import { IMMUTABLE_ASSETS_GLOB, IMMUTABLE_CACHE_CONTROL, SECURITY_HEADERS } from '../../src/config/app.mjs';

export const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.ico': 'image/x-icon',
  '.woff2': 'font/woff2', '.wasm': 'application/wasm', '.txt': 'text/plain; charset=utf-8', '.xml': 'application/xml',
  '.pf_meta': 'application/octet-stream', '.pf_index': 'application/octet-stream', '.pf_fragment': 'application/octet-stream', '.pagefind': 'application/octet-stream',
};

const IMMUTABLE_PREFIX = IMMUTABLE_ASSETS_GLOB.replace(/\*$/, '');

/**
 * Maps a URL path to a file inside `root`, or returns an HTTP status when it cannot:
 * 400 for a malformed path, 403 for a path that leaves the folder.
 */
export function resolveFile(root, urlPath) {
  let decoded;
  try {
    decoded = decodeURIComponent(urlPath);
  } catch {
    return { status: 400 };
  }
  if (decoded.includes('\0')) return { status: 400 };
  let file = path.normalize(path.join(root, decoded));
  if (file !== root && !file.startsWith(root + path.sep)) return { status: 403 };
  if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, 'index.html');
  if (!fs.existsSync(file)) return { status: 404, file: path.join(root, '404.html') };
  return { status: 200, file };
}

/**
 * @param {{ root: string, reloadScript?: string }} options
 *   root — the built site folder; reloadScript — URL of a script to add before </body> of every page.
 */
export function staticHandler({ root, reloadScript }) {
  const reloadTag = reloadScript ? `<script src=${JSON.stringify(reloadScript)}></script>` : '';
  const fail = (res, status) => {
    if (!res.headersSent) res.statusCode = status;
    res.end();
  };

  return (req, res) => {
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) res.setHeader(name, value);
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.setHeader('Allow', 'GET, HEAD');
      return fail(res, 405);
    }
    const { pathname } = new URL(req.url, 'http://localhost');
    const { status, file } = resolveFile(root, pathname);
    if (!file) return fail(res, status);
    res.statusCode = status;
    const ext = path.extname(file);
    res.setHeader('Content-Type', CONTENT_TYPES[ext] ?? 'application/octet-stream');
    if (pathname.startsWith(IMMUTABLE_PREFIX)) res.setHeader('Cache-Control', IMMUTABLE_CACHE_CONTROL);
    if (req.method === 'HEAD') return res.end();
    if (reloadTag && ext === '.html') {
      // Small pages: read whole, add the reload hook before </body>.
      return fs.readFile(file, 'utf8', (err, html) => {
        if (err) return fail(res, 503);
        res.end(html.includes('</body>') ? html.replace('</body>', `${reloadTag}</body>`) : html + reloadTag);
      });
    }
    // The file can disappear between the check and the read (a rebuild is swapping dist/): answer, never crash.
    fs.createReadStream(file).on('error', () => fail(res, 503)).pipe(res);
  };
}
