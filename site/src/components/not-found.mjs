// Props of the custom 404 page (src/pages/404.astro). Pure, so it can be tested without rendering
// Astro components (tests/site/not-found.test.mjs). The wording (ru.json `notFound`) is in English on purpose.

/**
 * @param {import('../locales/strings.mjs').Strings} strings
 * @returns {{ lang: string, frontmatter: Record<string, unknown> }} props for Starlight's <StarlightPage>
 */
export function notFoundPage(strings) {
  const { lang, title, tagline, homeLink } = strings.notFound;
  return {
    lang,
    frontmatter: {
      title,
      template: 'splash',
      pagefind: false,
      prev: false,
      next: false,
      head: [{ tag: 'meta', attrs: { name: 'robots', content: 'noindex' } }],
      hero: { tagline, actions: [{ text: homeLink, link: '/', icon: 'right-arrow' }] },
    },
  };
}
