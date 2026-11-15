// Checks the Cloudflare Workers config (wrangler.jsonc) against the build: it must deploy what Astro
// builds, run the Worker only for the API, answer unknown paths with our 404 page, bind the accounts
// database with its migrations, and keep drafts and telemetry off.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, test } from 'node:test';
import { API_PREFIX, DIST_DIR } from '../../src/config/app.mjs';

const SITE_DIR = fileURLToPath(new URL('../..', import.meta.url));

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
  });

  test('the Worker script exists and runs only for API paths', () => {
    assert.ok(fs.existsSync(path.join(SITE_DIR, config.main)), config.main);
    assert.deepEqual(config.assets.run_worker_first, [`${API_PREFIX}*`]);
    assert.equal(config.assets.binding, undefined, 'the Worker never serves pages, so it needs no assets binding');
  });

  test('binds the accounts database by name, with the migrations folder', () => {
    assert.equal(config.d1_databases.length, 1);
    const [d1] = config.d1_databases;
    assert.equal(d1.binding, 'DB');
    assert.equal(d1.database_name, config.name);
    assert.ok(fs.readdirSync(path.join(SITE_DIR, d1.migrations_dir)).some((f) => /^\d{4}_.+\.sql$/.test(f)));
  });

  test('cleans up sessions on a daily cron', () => {
    assert.equal(config.triggers.crons.length, 1);
    assert.match(config.triggers.crons[0], /^\d+ \d+ \* \* \*$/);
  });

  test('npm run deploy migrates the database before deploying the Worker', () => {
    const { scripts } = JSON.parse(fs.readFileSync(path.join(SITE_DIR, 'package.json'), 'utf8'));
    assert.equal(scripts.deploy, 'wrangler d1 migrations apply DB --remote && wrangler deploy');
    assert.match(scripts['dev:worker'], /migrations apply DB --local && wrangler dev$/);
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
