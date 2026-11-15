// Tests for the progress API handler: host/origin checks, GET/PUT, validation, content type, size limit.
// Each test gets its own temporary progress file and a server on a random local port.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, before, beforeEach, describe, test } from 'node:test';
import { PROGRESS_FILE_HEADER } from '../../src/config/app.mjs';
import { progressHandler } from '../../scripts/serve/progress-handler.mjs';

const MAX_BYTES = 1024;
const ALLOWED = new Set(['localhost', '127.0.0.1']);

let dir, file, server, port;

before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'progress-test-'));
  file = path.join(dir, 'nested', 'progress.json');
  server = http.createServer((req, res) => progressHandler(file, MAX_BYTES, ALLOWED)(req, res));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = server.address().port;
});

after(() => {
  server.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => fs.rmSync(path.join(dir, 'nested'), { recursive: true, force: true }));

/** Raw request, so the Host and Origin headers can be set freely. */
function request(method, { host = `127.0.0.1:${port}`, origin, body, type = 'application/json' } = {}) {
  return new Promise((resolve, reject) => {
    const headers = { host };
    if (origin) headers.origin = origin;
    if (body !== undefined && type) headers['content-type'] = type;
    const req = http.request({ host: '127.0.0.1', port, method, path: '/api/progress', headers }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
    });
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

describe('progress handler', () => {
  test('GET without a file returns an empty object and no-store headers', async () => {
    const res = await request('GET');
    assert.equal(res.status, 200);
    assert.equal(res.body, '{}');
    assert.equal(res.headers['cache-control'], 'no-store');
    assert.equal(decodeURIComponent(res.headers[PROGRESS_FILE_HEADER.toLowerCase()]), file);
  });

  test('PUT stores the progress and GET returns it', async () => {
    const data = { chapters: { '1-1': { done: true } } };
    const put = await request('PUT', { body: JSON.stringify(data), origin: `http://127.0.0.1:${port}` });
    assert.equal(put.status, 200);
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), data);
    assert.ok(!fs.existsSync(file + '.tmp'), 'temporary file is renamed away');
    const get = await request('GET');
    assert.deepEqual(JSON.parse(get.body), data);
  });

  test('a localhost host name with any port is trusted', async () => {
    const res = await request('GET', { host: 'LOCALHOST:9999' });
    assert.equal(res.status, 200);
  });

  test('an unknown Host is refused (DNS rebinding)', async () => {
    const res = await request('GET', { host: `evil.example:${port}` });
    assert.equal(res.status, 403);
  });

  test('a cross-origin request is refused', async () => {
    const res = await request('PUT', { origin: 'http://evil.example', body: '{"chapters":{}}' });
    assert.equal(res.status, 403);
    assert.ok(!fs.existsSync(file));
  });

  test('a malformed Origin is refused', async () => {
    const res = await request('GET', { origin: 'not a url' });
    assert.equal(res.status, 403);
  });

  test('other methods get 405', async () => {
    const res = await request('DELETE');
    assert.equal(res.status, 405);
  });

  for (const [name, body] of [
    ['invalid JSON', '{'],
    ['an array', '[]'],
    ['no chapters object', '{"chapters":[]}'],
    ['null', 'null'],
  ]) {
    test(`PUT with ${name} gets 400 and writes nothing`, async () => {
      const res = await request('PUT', { body });
      assert.equal(res.status, 400);
      assert.ok(!fs.existsSync(file));
    });
  }

  test('PUT over the size limit gets 413 and writes nothing', async () => {
    const body = JSON.stringify({ chapters: { big: 'x'.repeat(MAX_BYTES * 2) } });
    const res = await request('PUT', { body });
    assert.equal(res.status, 413);
    assert.ok(!fs.existsSync(file));
  });

  for (const type of [null, 'text/plain', 'application/x-www-form-urlencoded']) {
    test(`PUT with content type ${type} gets 415 and writes nothing`, async () => {
      const res = await request('PUT', { body: '{"chapters":{}}', type });
      assert.equal(res.status, 415);
      assert.ok(!fs.existsSync(file));
    });
  }
});
