// Tests for the checklist click logic: which clicks inside an item toggle its checkbox.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { clickTogglesItem } from '../src/scripts/checklist.mjs';

/** A stand-in for a clicked element: `ancestors` are the tag names from the element up to the item. */
const target = (...ancestors) => ({
  closest: (selector) =>
    ancestors.find((tag) => selector.split(',').map((s) => s.trim()).includes(tag)) ?? null,
});

describe('clickTogglesItem', () => {
  test('a click on plain text toggles', () => {
    assert.equal(clickTogglesItem(target('li'), ''), true);
  });

  test('a click on inline code toggles', () => {
    assert.equal(clickTogglesItem(target('code', 'li'), ''), true);
  });

  test('a click on the checkbox itself does not toggle again', () => {
    assert.equal(clickTogglesItem(target('input', 'li'), ''), false);
  });

  test('clicks on links and buttons keep their own behaviour', () => {
    assert.equal(clickTogglesItem(target('a', 'li'), ''), false);
    assert.equal(clickTogglesItem(target('code', 'a', 'li'), ''), false);
    assert.equal(clickTogglesItem(target('button', 'li'), ''), false);
  });

  test('finishing a text selection does not toggle', () => {
    assert.equal(clickTogglesItem(target('code', 'li'), 'search.py'), false);
    assert.equal(clickTogglesItem(target('li'), '  '), true);
  });
});
