// Checks the Cloudflare Workers config (wrangler.jsonc) against the build: it must deploy what Astro
// builds, answer unknown paths with our 404 page and keep drafts and telemetry off.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, test } from 'node:test';
import { DIST_DIR } from '../src/config/app.mjs';

const SITE_DIR = fileURLToPath(new URL('..', import.meta.url));

/** Parses JSONC whose comments take whole lines (the style used in wrangler.jsonc). */
function parseJsonc(text) {
  return JSON.parse(text.replace(/^\s*\/\/.*$/gm, ''));
}

const config = parseJsonc(fs.readFileSync(path.join(SITE_DIR, 'wrangler.jsonc'), 'utf8'));
const pinnedWrangler = JSON.parse(fs.readFileSync(path.join(SITE_DIR, 'package.json'), 'utf8')).devDependencies.wrangler;

describe('wrangler.jsonc', () => {
  test('parseJsonc drops whole-line comments only', () => {
    assert.deepEqual(parseJsonc('// note\n{\n  // inner\n  "a": "./x"\n}\n'), { a: './x' });
  });

  test('deploys the Astro build output as static assets', () => {
    assert.equal(path.resolve(SITE_DIR, config.assets.directory), path.resolve(SITE_DIR, DIST_DIR));
    assert.equal(config.main, undefined, 'no Worker script: the site is fully static');
  });

  test('unknown paths get the custom 404 page', () => {
    assert.equal(config.assets.not_found_handling, '404-page');
    assert.ok(fs.existsSync(path.join(SITE_DIR, 'src/pages/404.astro')), 'the build emits 404.html');
  });

  test('is served on workers.dev without public preview URLs or telemetry', () => {
    assert.equal(config.workers_dev, true);
    assert.equal(config.preview_urls, false);
    assert.equal(config.send_metrics, false);
  });

  test('has a fixed compatibility date and an exact wrangler version', () => {
    assert.match(config.compatibility_date, /^\d{4}-\d{2}-\d{2}$/);
    assert.match(pinnedWrangler, /^\d+\.\d+\.\d+$/);
  });
});
