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
| `SITE_URL` | — | public address of the deployed site (`https://…`); enables canonical links, the sitemap, the `Sitemap:` line in `robots.txt` and the link preview image. Leave empty for local use |
| `GOOGLE_SITE_VERIFICATION` | — | ownership token from Google Search Console (HTML tag method, the `content` value); adds `<meta name="google-site-verification">` to every page |
| `YANDEX_VERIFICATION` | — | ownership token from Yandex Webmaster (meta tag method, the `content` value); adds `<meta name="yandex-verification">` to every page |
| `CLOUDFLARE_WEB_ANALYTICS_TOKEN` | — | site token from Cloudflare Web Analytics (manual JS snippet, the `token` value); adds the beacon script to every page and allows `static.cloudflareinsights.com` / `cloudflareinsights.com` in the CSP of that build only. Leave empty for local use |

Example: `PROGRESS_FILE=~/path/progress.json npm start`.

The progress API answers only to local host names (`localhost`, `127.0.0.1`, `[::1]` and the `HOST` value) and refuses requests from other pages open in the browser. Keep `HOST` on `127.0.0.1`: the server has no authentication, so `0.0.0.0` would let anyone on the network read the site. `scripts/serve.mjs` is a study tool, not a production web server — for the public site use a static hosting (see below). Progress uploads must be `application/json` (415 otherwise) and fit `PROGRESS_MAX_BYTES` (413 otherwise).

## Deploying to a hosting

The site is fully static: `npm run build` produces `dist/`, which any static hosting can serve. Nothing on the server side is needed.

```bash
cd site
npm ci
SITE_URL=https://your-domain.example npm run build   # → dist/
```

- **Progress on the hosting** lives only in the reader's browser (localStorage) plus export / import on the index page. The progress API (`/api/progress`) exists only in the local server; on a static hosting the request gets a 404 and the site falls back to the browser copy by design.
- **Security headers.** Every page carries a Content Security Policy `<meta>` tag (Astro `security.csp`: scripts only from the site itself plus hashes of the inline scripts, no plugins, no foreign forms or `<base>`). The build also writes `dist/_headers` with the headers a `<meta>` cannot set: `frame-ancestors 'none'` (plus `X-Frame-Options: DENY` for old browsers), `nosniff`, `Referrer-Policy`, `Permissions-Policy`, `Cross-Origin-Opener-Policy`, `Cross-Origin-Resource-Policy: same-origin`, HSTS, and long caching for the hashed files in `/_astro/`. Netlify and Cloudflare Pages read `_headers` as is; on other hostings (Vercel, nginx, S3 + CloudFront) set the same headers in their config. GitHub Pages cannot set headers at all — prefer a hosting that can.
- **`robots.txt`** is written next to the pages; with `SITE_URL` set it points to `sitemap-index.xml`.
- **Search engines.** Every page has a title, a description (chapters: the `<!-- description: … -->` line under the meta line of `book/AIL-*.md`, at most 160 characters, required — the build fails without it; the index and the plan: `indexDescription` / `planDescription` in `ru.json`), a canonical link and Open Graph tags; with `SITE_URL` set, also the preview image `public/og-image.png`. To get the site indexed, add it to Google Search Console (URL-prefix property) and Yandex Webmaster, choose the meta tag method, put the tokens into the `GOOGLE_SITE_VERIFICATION` / `YANDEX_VERIFICATION` build variables, redeploy, confirm, then submit `sitemap-index.xml` in both.
- **CI** (`.github/workflows/ci.yml`) runs `npm ci`, `npm audit`, `npm test` and `npm run build` on every push and pull request and keeps `dist/` as a build artifact. Set the repository variable `SITE_URL` for production builds. Publishing is left to the hosting (connect the repository there, build command `npm run build`, base directory `site`, output `dist`) or to a deploy step added to the workflow.

### Cloudflare Workers

The public site runs on Cloudflare Workers as static assets, configured in `wrangler.jsonc` (no Worker script). `*.pages.dev` is blocked by some providers, `*.workers.dev` is not, so Pages is not used. In the Cloudflare dashboard: **Workers & Pages → Create → Import a repository**, then

| Setting | Value |
|---|---|
| Root directory | `site` |
| Build command | `npm run build` |
| Deploy command | `npx wrangler deploy` (runs the pinned `wrangler` from `devDependencies`) |
| Preview builds | off |
| Build variables | `NODE_VERSION` = the version in `.nvmrc`; `SITE_URL` = `https://<name>.<account>.workers.dev` or the custom domain; optionally `GOOGLE_SITE_VERIFICATION`, `YANDEX_VERIFICATION`, `CLOUDFLARE_WEB_ANALYTICS_TOKEN` |

Every push to `main` deploys. Check a deploy locally without uploading anything: `npm run build && npx wrangler deploy --dry-run`. `wrangler` is a deploy tool only, so `npm audit --omit=dev` skips it; update it deliberately, keeping `compatibility_date` in `wrangler.jsonc` no newer than its bundled runtime.
- **Node** version is in `.nvmrc` (CI uses it); `package.json` `engines` + `engine-strict` stop installs on an older Node.

To check the production headers and CSP locally: `npm run build && npm run serve` serves `dist/` with the same headers (except HSTS).

### Preview image

`public/og-image.png` is rendered from `assets/og-image.svg` (no build dependency, the PNG is committed). After editing the SVG, re-render it with Chrome and check the result:

```bash
cd site
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless --hide-scrollbars \
  --window-size=1200,630 --screenshot="$PWD/public/og-image.png" "file://$PWD/assets/og-image.svg"
```

## Tests

```bash
cd site
npm test         # unit tests of the converter and the progress API + checks of the book itself
```

Tests use the built-in `node:test`, no extra dependencies; the Python syntax check of the book's examples needs `python3` and is skipped without it. `npm run build` also fails when the converter reports a warning.

A git pre-commit hook runs `npm test` before every commit. Enable it once per clone, from the repository root: `git config core.hooksPath .githooks`.

## Language

Code, comments, logs and docs are in English. Russian is used only for what the reader sees on the site: the book (`book/*.md`), the course plan (root `README.md`) and the interface strings in `src/locales/ru.json`.

## Files

| File | Purpose |
|---|---|
| `.env.example` | the environment variables and their defaults |
| `src/config/server.mjs` | reads the environment (`.env`) into the server settings |
| `src/config/app.mjs` | constants shared by the browser, the server and the build: API route, storage key, paths, CSP and security headers |
| `src/locales/ru.json` | every reader-facing string: site title, interface texts, the book headings the converter looks for; the 404 page (`notFound`) is in English on purpose |
| `scripts/convert.mjs` | `book/*.md` → pages: reads the book, writes the generated files, fails on warnings |
| `scripts/lib/render.mjs` | the conversion itself, without file access: table of contents, `AIL-N` references → chapter links, quizzes, checklists, mermaid diagrams |
| `tests/*.test.mjs` | `npm test`: converter, progress API, checks of the book (`book.test.mjs`) |
| `../.githooks/pre-commit` | runs `npm test` before every commit |
| `scripts/serve.mjs` | local server for `npm start`: routes, watching, rebuilds |
| `scripts/lib/static-server.mjs` | serving `dist/`: path checks, content types, security headers, 404 |
| `src/integrations/csp-inline-hashes.mjs` | after the build, adds the hashes of inline scripts (Starlight's theme and sidebar) to each page's CSP |
| `src/integrations/deploy-files.mjs` | after the build, writes `dist/_headers` and `dist/robots.txt` |
| `public/favicon.svg` | site icon |
| `public/og-image.png`, `assets/og-image.svg` | link preview image (1200×630) and its source |
| `src/components/seo-head.mjs` | extra `<head>` tags: preview image, search-console tokens |
| `src/components/web-analytics.mjs` | Cloudflare Web Analytics beacon and the CSP origins it needs (only with a token) |
| `../.github/workflows/ci.yml` | CI: audit, tests, build |
| `wrangler.jsonc` | Cloudflare Workers deployment: serves `dist/` with the 404 page, no preview URLs, no telemetry |
| `src/scripts/main.ts`, `progress.ts` | quizzes, checklists, chapter marks, progress storage |
| `src/integrations/progress-handler.mjs` | `GET/PUT /api/progress` → the progress file |
| `src/styles/custom.css`, `ec.config.mjs` | styling and code highlighting |
| `src/pages/404.astro`, `src/components/not-found.mjs` | the custom 404 page (in English), in place of Starlight's built-in one |

## Dependencies

Astro 7.4.7, Starlight 0.42.7, mermaid 12.2.0, the expressive-code plugins 0.44.3 and the deploy tool wrangler 4.158.0 (dev only) were reviewed before installation: versions are exact (`save-exact`), the whole tree is frozen at 2026-11-07 (`before=` in `.npmrc`), install scripts are disabled (`ignore-scripts=true`), Astro telemetry is off. Update only deliberately, with the same review.
