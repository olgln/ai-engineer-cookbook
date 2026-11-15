// Tests for `npm run typecheck`: on a fresh clone (CI) the generated JSON and the astro:content types are
// missing, so the type check has to create them before tsc runs.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';

const { scripts } = JSON.parse(fs.readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
const steps = scripts.typecheck.split(' && ');
const firstTsc = steps.findIndex((s) => s.startsWith('tsc '));

test('typecheck generates src/generated/ and the astro:content types before tsc', () => {
  assert.ok(firstTsc > 0, 'runs tsc');
  const before = steps.slice(0, firstTsc);
  assert.ok(before.includes('npm run convert'), 'runs the converter first');
  assert.ok(before.some((s) => /(^|\s)astro sync$/.test(s)), 'runs astro sync first');
  assert.ok(before.indexOf('npm run convert') < before.findIndex((s) => /astro sync$/.test(s)), 'astro.config.mjs imports src/generated/');
});

test('typecheck checks both projects', () => {
  assert.deepEqual(steps.slice(firstTsc), ['tsc -p tsconfig.json', 'tsc -p tsconfig.mjs.json']);
});
