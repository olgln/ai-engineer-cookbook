const FENCE = /^(\s*)(`{3,}|~{3,})(.*)$/;

/** Split text into lines tagged with whether they are inside a fenced code block. */
export function tagLines(text) {
  const out = [];
  let open = null;
  for (const line of text.split('\n')) {
    const m = line.match(FENCE);
    if (!open && m) {
      open = m[2];
      out.push({ line, code: true, fenceStart: true, info: m[3].trim(), indent: m[1] });
    } else if (open && m && m[2][0] === open[0] && m[2].length >= open.length && !m[3].trim()) {
      open = null;
      out.push({ line, code: true, fenceEnd: true });
    } else {
      out.push({ line, code: !!open });
    }
  }
  return out;
}

/** Apply fn to text segments outside inline code spans. */
export function outsideInlineCode(line, fn) {
  return line
    .split(/(`+[^`]*`+)/)
    .map((part, i) => (i % 2 ? part : fn(part)))
    .join('');
}

export const escapeHtml = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export const yamlStr = (s) => JSON.stringify(s);

/** Split markdown into top-level "## " sections (fence-aware). */
export function splitSections(text) {
  const sections = [{ heading: null, lines: [] }];
  for (const t of tagLines(text)) {
    const m = !t.code && t.line.match(/^## (.+)$/);
    if (m) sections.push({ heading: m[1].trim(), lines: [] });
    else sections.at(-1).lines.push(t.line);
  }
  return sections;
}

/** Split a numbered list section into items {n, lines} (fence-aware, top-level numbers only). */
export function splitNumbered(lines) {
  const items = [];
  const pre = [];
  for (const t of tagLines(lines.join('\n'))) {
    const m = !t.code && t.line.match(/^(\d+)\.\s+(.*)$/);
    if (m) items.push({ n: +m[1], lines: [m[2]] });
    else if (items.length) items.at(-1).lines.push(t.line);
    else pre.push(t.line);
  }
  for (const it of items) {
    const rest = it.lines.slice(1);
    const indents = rest.filter((l) => l.trim()).map((l) => l.match(/^ */)[0].length);
    const cut = indents.length ? Math.min(...indents) : 0;
    it.lines = [it.lines[0], ...rest.map((l) => l.slice(Math.min(cut, l.match(/^ */)[0].length)))];
    while (it.lines.length && !it.lines.at(-1).trim()) it.lines.pop();
  }
  return { pre, items };
}
