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
  `site/src/chapters.json` come from `site/scripts/convert.mjs`.
- No hardcoded settings: machine-level values go through `.env` (`site/.env.example`,
  `site/src/config/server.mjs`), shared constants into `site/src/config/app.mjs`.
- Verify a change with `cd site && npm run build`. The `convert:` line must report no warnings;
  as of now it shows 58 chapters and 787 questions (109 multiple-choice, all with an answer key).
- Dependencies are pinned and install scripts are disabled (`site/.npmrc`). Do not add or update a
  dependency without reviewing it first.

## Git

- Git Flow: `feature/*` and `fix/*` branches off `develop`; no direct commits to `main` or `develop`.
- Commit, merge or push only when the user asks.
- Commit messages: one short English line.
