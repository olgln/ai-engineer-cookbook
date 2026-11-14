# Study site

The chapters from `book/` are built into a local site: a table of contents by week, search, code highlighting, quizzes with hidden answers, checklists, learning progress and a review page that collects the quiz questions answered wrong or marked «Не знал» across all chapters.

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

The pages are fully static: `npm run build` produces `dist/`, which any static hosting can serve. The only server code is the account API in `worker/` (see "Accounts" below); it runs on Cloudflare Workers, and without it the site works as before, with progress in the browser.

```bash
cd site
npm ci
SITE_URL=https://your-domain.example npm run build   # → dist/
```

- **Progress on the hosting** lives in the reader's browser (localStorage) plus export / import on the index page, and, for a signed-in reader, in their account (see "Accounts" below). On a static hosting without the Worker, `/api/progress` gets a 404 and the site falls back to the browser copy by design.
- **Security headers.** Every page carries a Content Security Policy `<meta>` tag (Astro `security.csp`: scripts only from the site itself plus hashes of the inline scripts, no plugins, no foreign forms or `<base>`). The build also writes `dist/_headers` with the headers a `<meta>` cannot set: `frame-ancestors 'none'` (plus `X-Frame-Options: DENY` for old browsers), `nosniff`, `Referrer-Policy`, `Permissions-Policy`, `Cross-Origin-Opener-Policy`, `Cross-Origin-Resource-Policy: same-origin`, HSTS, and long caching for the hashed files in `/_astro/`. Netlify and Cloudflare Pages read `_headers` as is; on other hostings (Vercel, nginx, S3 + CloudFront) set the same headers in their config. GitHub Pages cannot set headers at all — prefer a hosting that can.
- **`robots.txt`** is written next to the pages; with `SITE_URL` set it points to `sitemap-index.xml`.
- **Sitemap contents.** Every page, including the privacy page `/privacy/`, except the personal review page `/review/` (it is `noindex`; `SITEMAP_EXCLUDED_PATHS` in `src/config/app.mjs`).
- **Sitemap dates.** Every page in the sitemap gets a `<lastmod>`: the date of the last commit that changed its source (`book/AIL-*.md`, `book/README.md` for the index, the root `README.md` for the plan), so search engines re-crawl edited chapters sooner. The converter reads them from `git log` into `src/lastmod.json`. A shallow clone has no history to read: the build then logs `shallow git clone` and the sitemap goes without dates; run `git fetch --unshallow` before the build (see the Cloudflare build command below).
- **Search engines.** Every page has a title, a description (chapters: the `<!-- description: … -->` line under the meta line of `book/AIL-*.md`, at most 160 characters, required — the build fails without it; the index and the plan: `indexDescription` / `planDescription` in `ru.json`), a canonical link and Open Graph tags; with `SITE_URL` set, also the preview image `public/og-image.png`. To get the site indexed, add it to Google Search Console (URL-prefix property) and Yandex Webmaster, choose the meta tag method, put the tokens into the `GOOGLE_SITE_VERIFICATION` / `YANDEX_VERIFICATION` build variables, redeploy, confirm, then submit `sitemap-index.xml` in both.
- **CI** (`.github/workflows/ci.yml`) runs `npm ci`, `npm audit`, `npm test` and `npm run build` on every push and pull request and keeps `dist/` as a build artifact. Set the repository variable `SITE_URL` for production builds. Publishing is left to the hosting (connect the repository there, build command `npm run build`, base directory `site`, output `dist`) or to a deploy step added to the workflow.

### Cloudflare Workers

The public site runs on Cloudflare Workers as static assets plus a Worker script for `/api/*` only, configured in `wrangler.jsonc`. `*.pages.dev` is blocked by some providers, `*.workers.dev` is not, so Pages is not used. In the Cloudflare dashboard: **Workers & Pages → Create → Import a repository**, then

| Setting | Value |
|---|---|
| Root directory | `site` |
| Build command | `(git fetch --unshallow --quiet \|\| true) && npm run build` — the full history gives the sitemap its dates; without it the build still works, just without `<lastmod>` |
| Deploy command | `npm run deploy`: applies new D1 migrations, then `wrangler deploy` (the pinned `wrangler` from `devDependencies`) |
| Preview builds | off |
| Build variables | `NODE_VERSION` = the version in `.nvmrc`; `SITE_URL` = `https://<name>.<account>.workers.dev` or the custom domain; optionally `GOOGLE_SITE_VERIFICATION`, `YANDEX_VERIFICATION`, `CLOUDFLARE_WEB_ANALYTICS_TOKEN` |

Every push to `main` deploys. Check a deploy locally without uploading anything: `npm run build && npx wrangler deploy --dry-run`. `wrangler` is a deploy tool only, so `npm audit --omit=dev` skips it; update it deliberately, keeping `compatibility_date` in `wrangler.jsonc` no newer than its bundled runtime.
- **Node** version is in `.nvmrc` (CI uses it); `package.json` `engines` + `engine-strict` stop installs on an older Node.

To check the production headers and CSP locally: `npm run build && npm run serve` serves `dist/` with the same headers (except HSTS).

### Accounts (Worker + D1)

Readers can sign in with Google or GitHub and keep their progress in their account, so it follows them across devices. Signing in is optional: without it everything works as before, in the browser.

- **What runs where.** `wrangler.jsonc` sends only `/api/*` to the Worker (`run_worker_first`); pages and assets never reach it. The Worker (`worker/index.mjs`, logic in `worker/lib/`) answers:
  - `GET /api/auth/<provider>?return_to=/page/` → redirect to the provider; `GET /api/auth/<provider>/callback` → back from it, starts a session and returns to the page (or to the page with `?login_error=1` if sign-in failed);
  - `GET /api/me` → `{ providers }` when signed in, otherwise 401 with `{ available }`: the providers that have credentials (the index page shows a sign-in button for each);
  - `POST /api/logout`;
  - `DELETE /api/account` → deletes the signed-in reader: the user row, and with it (`ON DELETE CASCADE`) every sign-in identity, every session on every device and the stored progress; removes the cookie. The sign-in box on the index page has a delete button for it (with a confirmation); the browser copy of the progress stays;
  - `GET /api/progress` / `PUT /api/progress` for the signed-in reader (401 otherwise, so the page keeps the browser copy).
- **Sign-in.** OAuth 2.0 authorization code flow with PKCE (S256) and `state`, plus a `nonce` for OpenID Connect providers (Google), kept for 10 minutes in the `__Host-oauth` cookie between the redirect and the callback. We ask for nothing beyond the provider's user id: Google gets only the `openid` scope (the id is `sub` of the ID token); GitHub gets no scope at all (public profile only), and the Worker reads the numeric `id` from `GET https://api.github.com/user` — not the `login`, which users can rename. The provider's tokens are used once and neither stored nor logged. A token endpoint answer with an `error` field fails the sign-in even with status 200 (that is how GitHub reports a bad code). A provider is on only when both of its secrets are set (`<PROVIDER>_CLIENT_ID`, `<PROVIDER>_CLIENT_SECRET`); endpoints and per-provider options (scope, nonce, extra authorize parameters) are in `OAUTH_PROVIDERS` in `src/config/app.mjs`. The sign-in buttons follow `AUTH_PROVIDERS` (Google first).
- **Progress sync.** The account copy is the same JSON as the browser copy and the export, with a revision number: every `PUT` names the revision it was based on (`X-Progress-Rev`) and gets 409 if another device wrote in between; the page then merges and retries. The browser keeps its copy too, plus a marker (`ai-cookbook-progress-sync`) saying which revision it matches and whether it has unsent changes. On the first sign-in in a browser the two copies are merged (finished chapters and ticks from both, newer answers win); after that the account copy wins on load. Signing out keeps the browser copy. Logic: `src/scripts/sync.mjs`, wiring: `src/scripts/progress.ts`.
- **Data.** Cloudflare D1, binding `DB`, schema in `migrations/`. A user is a random id plus the provider's user id (no e-mail, name or provider token); progress is one row per user. A session is a random token in the `__Host-session` cookie (`HttpOnly; Secure; SameSite=Lax`); the database keeps only its SHA-256. Sessions last 30 days and are extended at most once a day while used; a daily cron (`triggers` in `wrangler.jsonc`) deletes expired ones. Lifetimes, names and limits are in `src/config/app.mjs`.
- **Security.** State-changing requests need an `Origin` equal to the site's own; the page to return to after sign-in must be a path on the site; API responses carry the same security headers as the pages and `Cache-Control: no-store`. The page CSP does not change: sign-in is a plain link (navigation), and the API is same-origin.
- **One-time setup** (needs `npx wrangler login`): `npx wrangler d1 create ai-engineer-cookbook`. The config finds the database by name, so no id goes into the repository. Then set the deploy command to `npm run deploy` (table above). If the build token cannot reach D1, give it the D1 Edit permission.
- **Google client.** Google Cloud Console → Google Auth Platform: *Branding* (app name, home page, privacy policy link, the site's domain under *Authorized domains*), *Audience* → External → *Publish app* (in "Testing" only listed test users can sign in), *Data access* → only `openid`. Then *Clients* → *Create client* → Web application, *Authorized redirect URIs*: `https://<site>/api/auth/google/callback` (and `http://localhost:8787/api/auth/google/callback` for local runs, or a separate client for them). Put the values on the hosting with `npx wrangler secret put GOOGLE_CLIENT_ID` and `... GOOGLE_CLIENT_SECRET` (this deploys the current Worker version with the new secrets).
- **GitHub client.** GitHub → *Settings* → *Developer settings* → *OAuth Apps* → *New OAuth App* (an OAuth App, not a GitHub App): application name, homepage URL `https://<site>/`, *Authorization callback URL* `https://<site>/api/auth/github/callback`; device flow stays off. Generate a client secret, then `npx wrangler secret put GITHUB_CLIENT_ID` and `... GITHUB_CLIENT_SECRET`. For local runs register a second OAuth App with `http://localhost:8787/api/auth/github/callback`, so the site's secret never sits on a dev machine. No permissions or scopes are set: the app can read only public profile data, and we keep only the numeric user id.
- **Locally:** copy `.dev.vars.example` to `.dev.vars` (ignored by git) and fill in the credentials. `npm run dev:worker` applies the migrations to a local database in `.wrangler/` and serves the last build from `dist/` together with the Worker on http://localhost:8787 (keep `npm start` running, or run `npm run build` first). The secure cookies work on `localhost` in Chrome and Firefox; Safari does not keep them over plain HTTP. `npm start` itself has no accounts.
- **Privacy page.** `/privacy/` (`PRIVACY_PATH`) is generated by the converter like the review page (`renderPrivacy` in `scripts/lib/render.mjs`, text in `privacy` in `ru.json`) and linked from the footer of every page and from the sign-in box. Cookie names, lifetimes and storage keys are filled in from `src/config/app.mjs`, so the text follows the code; the Cloudflare Web Analytics paragraph appears only in builds with `CLOUDFLARE_WEB_ANALYTICS_TOKEN`. The contact is `PRIVACY_CONTACT` (a placeholder is shown while it is empty), the date is `PRIVACY_POLICY_DATE` — update it whenever the text or what the Worker stores changes.
- **Going live.** Before turning sign-in on in production, in this order:
  1. Fill in `PRIVACY_CONTACT` in `src/config/app.mjs` (an e-mail or an `https://` link) and check the text of `/privacy/`.
  2. Make sure the deploy command on Cloudflare is `npm run deploy` (it applies the D1 migrations before `wrangler deploy`).
  3. Google Auth Platform → *Branding*: home page `https://ai-engineer-cookbook.olgln.workers.dev/`, privacy policy `https://ai-engineer-cookbook.olgln.workers.dev/privacy/`, and the authorized domain. `workers.dev` is on the Public Suffix List, so the domain to enter is most likely `olgln.workers.dev`, and Google may ask to verify it in Search Console first — not checked yet. Then *Audience* → External → *Publish app*, and add the production redirect URI `https://ai-engineer-cookbook.olgln.workers.dev/api/auth/google/callback` to the client.
  4. GitHub: an OAuth App for the site with the callback URL `https://ai-engineer-cookbook.olgln.workers.dev/api/auth/github/callback` (see "GitHub client" above).
  5. `npx wrangler secret put GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`.
  6. Merge to `main`: the push deploys, and the sign-in buttons appear for each provider with both secrets.
- **Tests** run the Worker against an in-memory stand-in for D1 on `node:sqlite` with the real migrations (`tests/helpers/d1.mjs`) and fake provider endpoints (token endpoints, GitHub's `/user`; `tests/helpers/oauth.mjs`); the browser side of the sync runs `src/scripts/progress.ts` under Node with fake `fetch` and `localStorage` (`tests/progress-sync.test.mjs`).

### Icons

Besides `public/favicon.svg` (the tab icon, linked by Starlight) there are two rendered icons, both committed:

- `public/apple-touch-icon.png` (180×180, iOS home screen), from `assets/apple-touch-icon.svg`: the same picture without rounded corners and without transparency, since iOS rounds the icon itself and paints transparent pixels black;
- `public/favicon.ico` (32×32), for clients that request `/favicon.ico` without reading the page.

After changing the icon, re-render both:

```bash
cd site
CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
"$CHROME" --headless --hide-scrollbars --window-size=180,180 \
  --screenshot="$PWD/public/apple-touch-icon.png" "file://$PWD/assets/apple-touch-icon.svg"
"$CHROME" --headless --hide-scrollbars --default-background-color=00000000 --window-size=32,32 \
  --screenshot=/tmp/favicon-32.png "file://$PWD/public/favicon.svg"
sips -s format ico /tmp/favicon-32.png --out public/favicon.ico
```

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
npm test         # unit tests of the converter, the progress API and the account Worker + checks of the book itself
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
| `scripts/lib/render.mjs` | the conversion itself, without file access: table of contents, `AIL-N` references → chapter links, quizzes, checklists, mermaid diagrams, the review and privacy pages |
| `tests/*.test.mjs` | `npm test`: converter, progress API, account Worker, privacy page (`privacy.test.mjs`), checks of the book (`book.test.mjs`) |
| `../.githooks/pre-commit` | runs `npm test` before every commit |
| `scripts/serve.mjs` | local server for `npm start`: routes, watching, rebuilds |
| `scripts/lib/static-server.mjs` | serving `dist/`: path checks, content types, security headers, 404 |
| `src/integrations/csp-inline-hashes.mjs` | after the build, adds the hashes of inline scripts (Starlight's theme and sidebar) to each page's CSP |
| `src/integrations/deploy-files.mjs` | after the build, writes `dist/_headers` and `dist/robots.txt` |
| `public/favicon.svg` | site icon |
| `public/apple-touch-icon.png`, `public/favicon.ico`, `assets/apple-touch-icon.svg` | iOS home-screen icon, the `.ico` fallback, and the source of the first (see "Icons") |
| `scripts/lib/lastmod.mjs` | page dates for the sitemap from `git log` |
| `public/og-image.png`, `assets/og-image.svg` | link preview image (1200×630) and its source |
| `src/components/PageFrame.astro`, `footer.mjs` | the site footer on every page: copyright and the link to the privacy page |
| `src/components/seo-head.mjs` | extra `<head>` tags: preview image, search-console tokens, iOS icon |
| `src/components/web-analytics.mjs` | Cloudflare Web Analytics beacon and the CSP origins it needs (only with a token) |
| `../.github/workflows/ci.yml` | CI: audit, tests, build |
| `wrangler.jsonc` | Cloudflare Workers deployment: serves `dist/` with the 404 page, runs the Worker for `/api/*`, the D1 binding and the session clean-up cron, no preview URLs, no telemetry |
| `worker/index.mjs` | the Worker entry: `fetch` for `/api/*`, `scheduled` for the cron |
| `worker/lib/api.mjs`, `oauth.mjs`, `session.mjs`, `users.mjs`, `progress.mjs`, `http.mjs` | account API routes, sign-in with OAuth providers, sessions and cookies, users and sign-in identities (and account deletion), stored progress, response helpers |
| `src/scripts/sync.mjs` | merging the browser and account copies of the progress, what to do after loading |
| `.dev.vars.example` | the Worker secrets for local runs (`.dev.vars`) |
| `migrations/*.sql` | D1 schema, applied in order by `wrangler d1 migrations apply` |
| `tests/helpers/d1.mjs`, `tests/helpers/oauth.mjs` | in-memory D1 for the tests, on `node:sqlite`; fake Google and GitHub token responses, JSON responses of fake provider endpoints |
| `src/scripts/main.ts`, `progress.ts` | quizzes, checklists, chapter marks, the review page, the sign-in box (sign-out, account deletion, link to the privacy page), progress storage (file, account or browser) |
| `src/scripts/review.mjs` | which answered questions go to the review page (`/review/`); the page loads the question list (`src/quiz-index.json`, generated) only there |
| `src/integrations/progress-handler.mjs` | `GET/PUT /api/progress` → the progress file |
| `src/styles/custom.css`, `ec.config.mjs` | styling and code highlighting |
| `src/pages/404.astro`, `src/components/not-found.mjs` | the custom 404 page (in English), in place of Starlight's built-in one |

## Dependencies

Astro 7.4.7, Starlight 0.42.7, @astrojs/sitemap 3.7.4 (Starlight's own sitemap, listed directly to add page dates), mermaid 12.2.0, the expressive-code plugins 0.44.3 and the deploy tool wrangler 4.158.0 (dev only) were reviewed before installation: versions are exact (`save-exact`), the whole tree is frozen at 2026-11-07 (`before=` in `.npmrc`), install scripts are disabled (`ignore-scripts=true`), Astro telemetry is off. Update only deliberately, with the same review.
