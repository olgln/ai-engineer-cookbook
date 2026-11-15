import { $$ } from './dom';

/** Links to other sites open in a new tab; links inside the study site stay in the same tab. */
export function openExternalLinksInNewTab() {
  for (const a of $$<HTMLAnchorElement>('a[href]')) {
    if (!/^https?:$/.test(a.protocol) || a.origin === location.origin) continue;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
  }
}
