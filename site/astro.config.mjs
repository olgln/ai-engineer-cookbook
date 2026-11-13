// @ts-check
import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';
import sidebar from './src/sidebar.json' with { type: 'json' };
import progressApi from './src/integrations/progress-api.mjs';

export default defineConfig({
  devToolbar: { enabled: false },
  vite: { build: { chunkSizeWarningLimit: 2500 } },
  integrations: [
    starlight({
      title: 'AI-инженер: учебник',
      defaultLocale: 'root',
      locales: { root: { label: 'Русский', lang: 'ru' } },
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
