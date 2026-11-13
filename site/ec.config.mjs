// @ts-check
import { defineEcConfig } from '@astrojs/starlight/expressive-code';
import { pluginLineNumbers } from '@expressive-code/plugin-line-numbers';
import { pluginCollapsibleSections } from '@expressive-code/plugin-collapsible-sections';

export default defineEcConfig({
  themes: ['github-dark', 'github-light'],
  shiki: { langAlias: { gitignore: 'ini', env: 'dotenv' } },
  plugins: [pluginLineNumbers(), pluginCollapsibleSections()],
  defaultProps: {
    showLineNumbers: false,
    wrap: true,
    overridesByLang: {
      'python,py,ts,js,typescript,javascript,sql,dockerfile,yaml,toml': { showLineNumbers: true },
    },
  },
  styleOverrides: {
    borderRadius: '0.5rem',
    codeFontSize: '0.875rem',
  },
});
