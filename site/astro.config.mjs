// @ts-check
import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';
import sidebar from './src/sidebar.json' with { type: 'json' };
import strings from './src/locales/ru.json' with { type: 'json' };
import progressApi from './src/integrations/progress-api.mjs';
import deployFiles from './src/integrations/deploy-files.mjs';
import cspInlineHashes from './src/integrations/csp-inline-hashes.mjs';
import { seoHead } from './src/components/seo-head.mjs';
import { CSP } from './src/config/app.mjs';
import { config } from './src/config/server.mjs';

export default defineConfig({
  // Public address (SITE_URL): enables canonical links and the sitemap; unset for local builds.
  site: config.siteUrl,
  security: {
    csp: {
      directives: CSP.directives,
      scriptDirective: { resources: CSP.scriptSources },
      styleDirective: { resources: CSP.styleSources },
    },
  },
  server: { host: config.host, port: config.port },
  devToolbar: { enabled: false },
  vite: { build: { chunkSizeWarningLimit: 2500 } },
  integrations: [
    starlight({
      title: strings.site.title,
      defaultLocale: 'root',
      locales: { root: { label: strings.languageLabel, lang: strings.lang } },
      sidebar,
      head: seoHead({
        site: config.siteUrl,
        imageAlt: strings.site.ogImageAlt,
        googleSiteVerification: config.googleSiteVerification,
        yandexVerification: config.yandexVerification,
      }),
      tableOfContents: { minHeadingLevel: 2, maxHeadingLevel: 3 },
      lastUpdated: false,
      // src/pages/404.astro replaces Starlight's built-in 404 page
      disable404Route: true,
      pagination: true,
      customCss: ['./src/styles/custom.css'],
      components: {
        Footer: './src/components/Footer.astro',
        PageFrame: './src/components/PageFrame.astro',
      },
    }),
    progressApi(),
    cspInlineHashes(),
    deployFiles(),
  ],
});
