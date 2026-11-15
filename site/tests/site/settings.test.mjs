// .env.example documents every setting the code reads, with its default value.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import { DEFAULTS } from '../../src/config/server.mjs';

/** NAME=value lines of the example file, comments and blank lines skipped. */
function exampleSettings() {
  const text = fs.readFileSync(new URL('../../.env.example', import.meta.url), 'utf8');
  const settings = new Map();
  for (const line of text.split('\n')) {
    const m = line.match(/^([A-Z][A-Z0-9_]*)=(.*)$/);
    if (m) settings.set(m[1], m[2].trim());
  }
  return settings;
}

test('.env.example lists every setting and nothing else', () => {
  assert.deepEqual([...exampleSettings().keys()].sort(), Object.keys(DEFAULTS).sort());
});

test('.env.example shows the default value of each setting', () => {
  for (const [name, value] of exampleSettings()) {
    assert.equal(value, DEFAULTS[name], `${name} in .env.example differs from the default`);
  }
});
