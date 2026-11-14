// Tests for the props of the custom 404 page.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import strings from '../src/locales/ru.json' with { type: 'json' };
import { notFoundPage } from '../src/components/not-found.mjs';

test('the 404 page uses the notFound wording and language', () => {
  const { lang, frontmatter } = notFoundPage(strings);
  assert.equal(lang, strings.notFound.lang);
  assert.equal(frontmatter.title, strings.notFound.title);
  assert.equal(frontmatter.hero.tagline, strings.notFound.tagline);
  assert.deepEqual(frontmatter.hero.actions.map((a) => [a.text, a.link]), [[strings.notFound.homeLink, '/']]);
});

test('the 404 page is a splash page kept out of the site search and search engines', () => {
  const { frontmatter } = notFoundPage(strings);
  assert.equal(frontmatter.template, 'splash');
  assert.equal(frontmatter.pagefind, false);
  assert.deepEqual(frontmatter.head, [{ tag: 'meta', attrs: { name: 'robots', content: 'noindex' } }]);
});
