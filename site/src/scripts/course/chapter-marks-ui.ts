import * as P from '../progress/store';
import { $$, el } from '../dom';
import { chapters } from '../page-locale';

export function markLinks() {
  const done = (id: string) => !!P.get().chapters[id]?.done;
  for (const a of $$<HTMLAnchorElement>('a[data-chapter]')) a.classList.toggle('is-done', done(a.dataset.chapter!));
  const byHref = new Map(chapters.map((c) => [c.href, c.id]));
  for (const a of $$<HTMLAnchorElement>('.sl-markdown-content .week-card a, .sl-markdown-content a')) {
    const id = byHref.get(new URL(a.href, location.href).pathname);
    if (id) a.closest('li')?.classList.toggle('chapter-is-done', done(id));
  }
  // group headings in sidebar: "3/5"
  for (const details of $$<HTMLDetailsElement>('nav.sidebar details, #starlight__sidebar details')) {
    const links = $$<HTMLAnchorElement>('a[data-chapter]', details);
    if (!links.length) continue;
    const n = links.filter((a) => done(a.dataset.chapter!)).length;
    const summary = details.querySelector('summary .group-label, summary');
    if (!summary) continue;
    let badge = summary.querySelector<HTMLElement>('.group-progress');
    if (!badge) {
      badge = el('span', { class: 'group-progress' });
      summary.querySelector('.group-label')?.append(badge) ?? summary.append(badge);
    }
    badge.textContent = `${n}/${links.length}`;
    badge.classList.toggle('complete', n === links.length);
  }
}
