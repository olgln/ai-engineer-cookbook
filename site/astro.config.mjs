// @ts-check
import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';
import sidebar from './src/sidebar.json' with { type: 'json' };
import strings from './src/locales/ru.json' with { type: 'json' };
import progressApi from './src/integrations/progress-api.mjs';
import { config } from './src/config/server.mjs';

export default defineConfig({
  server: { host: config.host, port: config.port },
  devToolbar: { enabled: false },
  vite: { build: { chunkSizeWarningLimit: 2500 } },
  integrations: [
    starlight({
      title: strings.site.title,
      defaultLocale: 'root',
      locales: { root: { label: strings.languageLabel, lang: strings.lang } },
      sidebar,
      tableOfContents: { minHeadingLevel: 2, maxHeadingLevel: 3 },
      lastUpdated: false,
      pagination: true,
      customCss: ['./src/styles/custom.css'],
      components: {
        Footer: './src/components/Footer.astro',
      },
    }),
    progressApi(),
  ],
});
