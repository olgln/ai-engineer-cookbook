// @ts-check
import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';
import sitemap from '@astrojs/sitemap';
import sidebar from './src/generated/sidebar.json' with { type: 'json' };
import lastmod from './src/generated/lastmod.json' with { type: 'json' };
import i18n from './src/generated/i18n.json' with { type: 'json' };
import { starlightLocales } from './src/locales/locales.mjs';
import { stringsFor } from './src/locales/strings.mjs';
import progressApi from './src/integrations/progress-api.mjs';
import deployFiles from './src/integrations/deploy-files.mjs';
import cspInlineHashes from './src/integrations/csp-inline-hashes.mjs';
import { iconHead, seoHead } from './src/head/seo-head.mjs';
import { inSitemap, sitemapExcluded, withLastmod } from './scripts/convert/lastmod.mjs';
import { webAnalyticsHead, withWebAnalytics } from './src/head/web-analytics.mjs';
import { CSP, SITEMAP_EXCLUDED_PATHS } from './src/config/app.mjs';
import { config } from './src/config/server.mjs';

const strings = stringsFor(undefined);

// Cloudflare Web Analytics only in builds with CLOUDFLARE_WEB_ANALYTICS_TOKEN; its origins join the CSP there.
const csp = withWebAnalytics(CSP, config.webAnalyticsToken);

export default defineConfig({
  // Public address (SITE_URL): enables canonical links and the sitemap; unset for local builds.
  site: config.siteUrl,
  security: {
    csp: {
      directives: csp.directives,
      scriptDirective: { resources: csp.scriptSources },
      styleDirective: { resources: csp.styleSources },
    },
  },
  server: { host: config.host, port: config.port },
  devToolbar: { enabled: false },
  vite: { build: { chunkSizeWarningLimit: 2500 } },
  integrations: [
    starlight({
      title: strings.site.title,
      defaultLocale: 'root',
      locales: starlightLocales((lang) => stringsFor(lang).languageLabel),
      // per-page language fixes of the head: hreflang links and the preview image text (src/route-data.ts)
      routeMiddleware: './src/route-data.ts',
      sidebar,
      head: [
        ...iconHead(),
        ...seoHead({
          site: config.siteUrl,
          imageAlt: strings.site.ogImageAlt,
          googleSiteVerification: config.googleSiteVerification,
          yandexVerification: config.yandexVerification,
        }),
        ...webAnalyticsHead(config.webAnalyticsToken),
      ],
      tableOfContents: { minHeadingLevel: 2, maxHeadingLevel: 3 },
      lastUpdated: false,
      // src/pages/404.astro replaces Starlight's built-in 404 page
      disable404Route: true,
      pagination: true,
      customCss: [
        './src/styles/base.css',
        './src/styles/quiz.css',
        './src/styles/chapter.css',
        './src/styles/sidebar.css',
        './src/styles/index-page.css',
        './src/styles/mermaid.css',
        './src/styles/footer.css',
        './src/styles/review.css',
        './src/styles/account.css',
        './src/styles/save-hint.css',
        './src/styles/language-note.css',
      ],
      components: {
        Footer: './src/components/Footer.astro',
        PageFrame: './src/components/PageFrame.astro',
        LanguageSelect: './src/components/LanguageSelect.astro',
        ThemeSelect: './src/components/ThemeSelect.astro',
      },
    }),
    // Starlight adds this integration itself unless it is listed; listed here to give pages a <lastmod>.
    sitemap({
      filter: (page) => inSitemap(page, sitemapExcluded(SITEMAP_EXCLUDED_PATHS, i18n.placeholders)),
      serialize: (item) => withLastmod(item, lastmod),
    }),
    progressApi(),
    cspInlineHashes(),
    deployFiles(),
  ],
});
