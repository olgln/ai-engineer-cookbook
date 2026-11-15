import { CHAPTER_PREFIX, PLAN_PATH } from '../../src/config/app.mjs';
import { format } from '../../src/locales/format.mjs';
import { escapeHtml, outsideInlineCode, tagLines } from './markdown.mjs';

function chapterLink(ctx, ail) {
  const it = ctx.byAil.get(+ail);
  if (!it) ctx.warnings.push(`unknown chapter reference ${CHAPTER_PREFIX}${ail}`);
  return it;
}

/** Rewrite chapter references and README links in one line, outside inline code. */
export function rewriteLinks(ctx, line) {
  const { re: RE, strings: { site } } = ctx;
  return outsideInlineCode(line, (s) =>
    s
      .replace(RE.fileLink, (all, n, hash = '') => {
        const it = chapterLink(ctx, n);
        return it ? `](${it.href}${hash})` : all;
      })
      .replace(RE.bookReadmeLink, `](${ctx.path('/')})`)
      .replace(/\]\((?:\.\/)?README\.md\)/g, `](${ctx.path(PLAN_PATH)})`)
      // "1.2 · Title (AIL-56)" -> link on the title
      .replace(RE.titledRef, (all, label, n) => {
        const it = chapterLink(ctx, n);
        return it ? `[${label.trim()}](${it.href})` : all;
      })
      // "[AIL-19 · Chunking](...)" -> "[4.3 · Chunking](...)"
      .replace(RE.linkText, (all, n) => {
        const it = chapterLink(ctx, n);
        return it ? `[${it.num}` : all;
      })
      .replace(RE.bareRef, (all, n) => {
        const it = chapterLink(ctx, n);
        return it ? `[${format(site.chapterRef, { num: it.num })}](${it.href})` : all;
      }),
  );
}

/** Generic body transform: links outside code, mermaid fences to <pre class="mermaid">. */
export function transformBody(ctx, text) {
  const tagged = tagLines(text);
  const out = [];
  for (let i = 0; i < tagged.length; i++) {
    const t = tagged[i];
    if (t.fenceStart && t.info === 'mermaid') {
      const body = [];
      i++;
      while (i < tagged.length && !tagged[i].fenceEnd) body.push(tagged[i++].line);
      ctx.stats.mermaid++;
      out.push(`<pre class="mermaid">${escapeHtml(body.join('\n'))}</pre>`);
      continue;
    }
    out.push(t.code ? t.line : rewriteLinks(ctx, t.line));
  }
  return out.join('\n');
}
