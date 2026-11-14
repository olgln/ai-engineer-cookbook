// Checks of src/styles/custom.css that keep the site readable: text contrast (WCAG AA), reduced
// motion, and the quiz toolbar on phones.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { describe, test } from 'node:test';

const css = fs.readFileSync(new URL('../src/styles/custom.css', import.meta.url), 'utf8');
const starlight = fs.readFileSync(new URL('../node_modules/@astrojs/starlight/dist/style/props.css', import.meta.url), 'utf8');

/** First `--name: hsl(h, s%, l%)` in a stylesheet (Starlight lists the dark theme first). */
function hslVar(text, name) {
  const m = text.match(new RegExp(`${name}:\\s*hsl\\((\\d+),\\s*(\\d+)%,\\s*(\\d+)%\\)`));
  assert.ok(m, `${name} is an hsl() value`);
  return m.slice(1).map(Number);
}

function rgb([h, s, l]) {
  s /= 100;
  l /= 100;
  const a = s * Math.min(l, 1 - l);
  const f = (n) => {
    const k = (n + h / 30) % 12;
    return l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
  };
  return [f(0), f(8), f(4)];
}

const luminance = (c) => {
  const [r, g, b] = rgb(c).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const contrast = (a, b) => {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
};

describe('muted text', () => {
  test('meets WCAG AA (4.5:1) on the darkest card and sidebar background of the dark theme', () => {
    const muted = hslVar(css, '--site-color-muted');
    for (const bg of ['--sl-color-gray-6', '--sl-color-black']) {
      assert.ok(contrast(muted, hslVar(starlight, bg)) >= 4.5, `on ${bg}`);
    }
  });

  test('the light theme keeps a readable gray', () => {
    assert.match(css, /:root\[data-theme='light'\] \{\s*--site-color-muted: var\(--sl-color-gray-3\);/);
  });

  test('no text uses the dark grays directly', () => {
    assert.doesNotMatch(css, /(?<![-\w])color: var\(--sl-color-gray-[3-6]\)/);
  });
});

test('the answer reveal animation is off for readers who reduce motion', () => {
  assert.match(css, /@media \(prefers-reduced-motion: reduce\) \{\s*\.quiz-q\.revealed \.quiz-answer \{ animation: none; \}/);
});

test('the quiz toolbar does not stick to the top on narrow screens', () => {
  assert.match(css, /@media \(max-width: 50rem\) \{\s*\.quiz-toolbar \{ position: static; \}/);
});

test('on narrow screens a linked question keeps no room for the toolbar, which does not stick there', () => {
  assert.match(css, /@media \(max-width: 50rem\) \{\s*\.quiz-q \{ scroll-margin-top: 0; \}/);
});
