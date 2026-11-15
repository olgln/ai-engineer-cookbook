// Tests for the static file handler used by `npm start`: path checks, 404, methods, headers, reload hook.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { IMMUTABLE_CACHE_CONTROL, SECURITY_HEADERS } from '../../src/config/app.mjs';
import { resolveFile, staticHandler } from '../../scripts/serve/static-server.mjs';

const RELOAD = '/__test-reload.js';
let root, outside, plain, watched;

function write(rel, text) {
  const file = path.join(root, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

async function listen(handler) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, port: server.address().port };
}

/** Raw request, so the path is sent exactly as written (no client-side normalization). */
function request({ port }, rawPath, method = 'GET') {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: rawPath }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

before(async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'static-test-'));
  root = path.join(base, 'dist');
  outside = path.join(base, 'secret.txt');
  fs.writeFileSync(outside, 'secret');
  write('index.html', '<html><body>home</body></html>');
  write('404.html', '<html><body>not found</body></html>');
  write('week-01/1-1/index.html', '<html><body>chapter</body></html>');
  write('_astro/app.abc123.js', 'console.log(1)');
  plain = await listen(staticHandler({ root }));
  watched = await listen(staticHandler({ root, reloadScript: RELOAD }));
});

after(() => {
  plain.server.close();
  watched.server.close();
  fs.rmSync(path.dirname(root), { recursive: true, force: true });
});

describe('resolveFile', () => {
  test('a directory resolves to its index.html', () => {
    assert.deepEqual(resolveFile(root, '/week-01/1-1/'), { status: 200, file: path.join(root, 'week-01/1-1/index.html') });
  });

  test('a missing file resolves to the 404 page', () => {
    assert.deepEqual(resolveFile(root, '/nope/'), { status: 404, file: path.join(root, '404.html') });
  });

  test('an encoded path that leaves the folder is refused', () => {
    assert.equal(resolveFile(root, '/%2e%2e/secret.txt').status, 403);
    assert.equal(resolveFile(root, '/..%2fsecret.txt').status, 403);
  });

  test('a malformed or NUL-containing path is a bad request', () => {
    assert.equal(resolveFile(root, '/%E0%A4%A').status, 400);
    assert.equal(resolveFile(root, '/index.html%00.js').status, 400);
  });
});

describe('static handler', () => {
  test('serves a page with security headers and an HTML content type', async () => {
    const res = await request(plain, '/week-01/1-1/');
    assert.equal(res.status, 200);
    assert.equal(res.body, '<html><body>chapter</body></html>');
    assert.equal(res.headers['content-type'], 'text/html; charset=utf-8');
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) assert.equal(res.headers[name.toLowerCase()], value);
  });

  test('a missing page gets status 404 and the 404 page', async () => {
    const res = await request(plain, '/missing');
    assert.equal(res.status, 404);
    assert.match(res.body, /not found/);
  });

  test('a path traversal never reaches files outside the folder', async () => {
    const res = await request(plain, '/..%2fsecret.txt');
    assert.equal(res.status, 403);
    assert.ok(!res.body.includes('secret'));
  });

  test('hashed build assets are cached as immutable, pages are not', async () => {
    assert.equal((await request(plain, '/_astro/app.abc123.js')).headers['cache-control'], IMMUTABLE_CACHE_CONTROL);
    assert.equal((await request(plain, '/')).headers['cache-control'], undefined);
  });

  test('HEAD answers without a body, other methods get 405', async () => {
    const head = await request(plain, '/', 'HEAD');
    assert.equal(head.status, 200);
    assert.equal(head.body, '');
    const post = await request(plain, '/', 'POST');
    assert.equal(post.status, 405);
    assert.equal(post.headers.allow, 'GET, HEAD');
  });

  test('without a reload script pages are served unchanged', async () => {
    assert.equal((await request(plain, '/')).body, '<html><body>home</body></html>');
  });

  test('with a reload script every page loads it as an external script before </body>', async () => {
    const res = await request(watched, '/');
    assert.equal(res.body, `<html><body>home<script src="${RELOAD}"></script></body></html>`);
    assert.equal((await request(watched, '/_astro/app.abc123.js')).body, 'console.log(1)');
  });
});
