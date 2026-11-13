# Study site

The chapters from `book/` are built into a local site: a table of contents by week, search, code highlighting, quizzes with hidden answers, checklists and learning progress.

```bash
cd site
npm start        # build + http://127.0.0.1:4321 — for studying (with search), rebuilds on save
npm run serve    # serve the last build as is, without watching
npm run dev      # layout editing mode: live reload, but no search
```

- **`book/*.md` is the source of truth.** The site pages are generated from it on every build (`scripts/convert.mjs`); generated files are not stored in git.
- **`npm start` follows your edits.** It watches `book/`, the root `README.md`, `src/` and the Astro configs; a few seconds after a save it rebuilds into `dist-next/`, swaps it in for `dist/` and reloads the open pages. If the build fails, the previous version keeps being served — fix the error and save again. No restart needed.
- **Progress** (finished chapters, checklist ticks, quiz answers) is personal and never goes to git: it is stored outside the project, in `~/.ai-engineer-cookbook/progress.json`, with a copy in the browser's localStorage. The index page shows where the progress is written and has export / import.
- **Stop the server:** `Ctrl+C` in the terminal where `npm start` is running.

## Settings

Nothing has to be configured. To change a default, copy `.env.example` to `.env` (ignored by git) or set the variable in the shell — the shell wins over `.env`.

| Variable | Default | Purpose |
|---|---|---|
| `HOST` | `127.0.0.1` | address the local server listens on |
| `PORT` | `4321` | port of the local server |
| `PROGRESS_FILE` | `~/.ai-engineer-cookbook/progress.json` | where the progress is stored, e.g. a folder in iCloud Drive for a backup |
| `PROGRESS_MAX_BYTES` | `2097152` | upper limit for a progress upload |

Example: `PROGRESS_FILE=~/path/progress.json npm start`.

The progress API answers only to local host names (`localhost`, `127.0.0.1`, `[::1]` and the `HOST` value) and refuses requests from other pages open in the browser. Keep `HOST` on `127.0.0.1`: the server has no authentication, so `0.0.0.0` would let anyone on the network read the site.

## Language

Code, comments, logs and docs are in English. Russian is used only for what the reader sees on the site: the book (`book/*.md`), the course plan (root `README.md`) and the interface strings in `src/locales/ru.json`.

## Files

| File | Purpose |
|---|---|
| `.env.example` | the environment variables and their defaults |
| `src/config/server.mjs` | reads the environment (`.env`) into the server settings |
| `src/config/app.mjs` | constants shared by the browser, the server and the build: API route, storage key, paths |
| `src/locales/ru.json` | every Russian string: site title, interface texts, the book headings the converter looks for |
| `scripts/convert.mjs` | `book/*.md` → pages: table of contents, `AIL-N` references → chapter links, quizzes, checklists, mermaid diagrams |
| `scripts/serve.mjs` | local server for `npm start` |
| `src/scripts/main.ts`, `progress.ts` | quizzes, checklists, chapter marks, progress storage |
| `src/integrations/progress-handler.mjs` | `GET/PUT /api/progress` → the progress file |
| `src/styles/custom.css`, `ec.config.mjs` | styling and code highlighting |

## Dependencies

Astro 7.4.2, Starlight 0.42.7, mermaid 12.2.0 and the expressive-code plugins 0.44.3 were reviewed before installation: versions are exact (`save-exact`), the whole tree is frozen at 2026-10-30 (`before=` in `.npmrc`), install scripts are disabled (`ignore-scripts=true`), Astro telemetry is off. Update only deliberately, with the same review.
