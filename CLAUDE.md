# AI Engineer Cookbook

A Russian-language course for developers who want to become AI engineers, plus a local study site.

- `book/AIL-*.md` — chapters (source of truth); `book/README.md` — table of contents by week.
- `README.md` — the course plan; it is also rendered as the site's plan page.
- `site/` — Astro/Starlight site generated from the book; see `site/README.md`.

## Language

- Code, comments, logs, error messages, commit messages and developer docs are in English.
- Russian is used only for reader-facing content: `book/`, the root `README.md` and the UI strings in
  `site/src/locales/ru.json`. Never put Russian literals in code — add them to `ru.json`.

## Site and code

- Generated files are never edited: `site/src/content/docs/`, `site/src/sidebar.json`,
  `site/src/chapters.json`, `site/src/lastmod.json`, `site/src/quiz-index.json` come from `site/scripts/convert.mjs`.
- No hardcoded settings: machine-level values go through `.env` (`site/.env.example`,
  `site/src/config/server.mjs`), shared constants into `site/src/config/app.mjs`.
- Verify a change with `cd site && npm test` and `cd site && npm run build`. The build fails on any
  converter warning; the `convert:` line must report 51 chapters, and the question count changes
  only when a quiz does.
- Pages run under a Content Security Policy (`CSP` and `SECURITY_HEADERS` in `site/src/config/app.mjs`):
  no inline event handlers, `eval` or third-party origins (CDNs, analytics, fonts). A new origin goes into
  `CSP` deliberately; check a change in a browser on `npm run build && npm run serve`, not `npm run dev`
  (the dev server has no CSP).
- Dependencies are pinned and install scripts are disabled (`site/.npmrc`). Do not add or update a
  dependency without reviewing it first.

## Tests

- Every new or changed piece of code in `site/` comes with tests in the same change: new
  behaviour gets a test, a fixed bug gets a test that fails without the fix. Tests live in
  `site/tests/*.test.mjs` and use the built-in `node:test` (no test dependencies).
- Keep logic testable: pure functions in modules (e.g. `site/scripts/lib/render.mjs`), file and
  network access in thin entry scripts (`site/scripts/convert.mjs`).
- `site/tests/book.test.mjs` checks the book itself (conversion warnings, quiz keys, chapter
  titles, Python syntax of the examples), so `npm test` is also run after content changes.
- Test fixtures take Russian headings from `site/src/locales/ru.json`, not from literals.
- A git pre-commit hook (`.githooks/pre-commit`) runs `npm test` and blocks a failing commit.
  Enable it once per clone: `git config core.hooksPath .githooks`. Never bypass it with
  `--no-verify`; fix the failure instead.

## Git

- Git Flow: `feature/*` and `fix/*` branches off `develop`; no direct commits to `main` or `develop`.
- Commit, merge or push only when the user asks.
- Commit messages: one short English line.
