import type { MermaidConfig } from 'mermaid';
import { $$ } from './dom';

const mermaidConfig = (dark: boolean): MermaidConfig => ({
  startOnLoad: false,
  theme: dark ? 'dark' : 'neutral',
  securityLevel: 'strict',
  themeVariables: { fontSize: '15px' },
  flowchart: { useMaxWidth: false, padding: 12 },
});

export async function initMermaid() {
  const nodes = $$<HTMLElement>('pre.mermaid');
  if (!nodes.length) return;
  const { default: mermaid } = await import('mermaid');
  const dark = document.documentElement.dataset.theme === 'dark';
  mermaid.initialize(mermaidConfig(dark));
  nodes.forEach((n) => (n.dataset.src ??= n.textContent ?? ''));
  await mermaid.run({ nodes });
  // re-render on theme switch
  new MutationObserver(async () => {
    const isDark = document.documentElement.dataset.theme === 'dark';
    mermaid.initialize(mermaidConfig(isDark));
    nodes.forEach((n) => { n.removeAttribute('data-processed'); n.textContent = n.dataset.src!; });
    await mermaid.run({ nodes });
  }).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
}
