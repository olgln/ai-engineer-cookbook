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
- **Progress** (finished chapters, checklist ticks, quiz answers) is personal and never goes to git: it is stored outside the project, in `~/.ai-engineer-cookbook/progress.json`, with a copy in the browser's localStorage. The index page shows where the progress is written.
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

- **Progress on the hosting** lives in the reader's browser (localStorage) and, for a signed-in reader, in their account (see "Accounts" below). On a static hosting without the Worker, `/api/progress` gets a 404 and the site falls back to the browser copy by design.
- **Security headers.** Every page carries a Content Security Policy `<meta>` tag (Astro `security.csp`: scripts only from the site itself plus hashes of the inline scripts, no plugins, no foreign forms or `<base>`). The build also writes `dist/_headers` with the headers a `<meta>` cannot set: `frame-ancestors 'none'` (plus `X-Frame-Options: DENY` for old browsers), `nosniff`, `Referrer-Policy`, `Permissions-Policy`, `Cross-Origin-Opener-Policy`, `Cross-Origin-Resource-Policy: same-origin`, HSTS, and long caching for the hashed files in `/_astro/`. Netlify and Cloudflare Pages read `_headers` as is; on other hostings (Vercel, nginx, S3 + CloudFront) set the same headers in their config. GitHub Pages cannot set headers at all — prefer a hosting that can.
- **Renumbered chapters.** A chapter's id and page path come from its number (`7-1`, `/week-07/7-1/`), so renumbering moves pages and renames the ids the reader's progress is stored under. List the renames under a new `PROGRESS_VERSION` in `CHAPTER_ID_RENAMES` (`src/config/app.mjs`): the browser migrates older progress (file, browser and account copies) on load, and the build writes `dist/_redirects` with a permanent redirect for every old page path that no longer exists. (Version 2: the empty buffer week 7 was removed, weeks 8–11 became 7–10.) An old path now used by another chapter shows that chapter.
- **`robots.txt`** is written next to the pages; with `SITE_URL` set it points to `sitemap-index.xml`.
- **Sitemap contents.** Every page, including the privacy page `/privacy/`, except the personal review page `/review/` (it is `noindex`; `SITEMAP_EXCLUDED_PATHS` in `src/config/app.mjs`).
- **Sitemap dates.** Every page in the sitemap gets a `<lastmod>`: the date of the last commit that changed its source (`book/AIL-*.md`, `book/README.md` for the index, the root `README.md` for the plan), so search engines re-crawl edited chapters sooner. The converter reads them from `git log` into `src/generated/lastmod.json`. A shallow clone has no history to read: the build then logs `shallow git clone` and the sitemap goes without dates; run `git fetch --unshallow` before the build (see the Cloudflare build command below).
- **Search engines.** Every page has a title, a description (chapters: the `<!-- description: … -->` line under the meta line of `book/AIL-*.md` and `book/en/AIL-*.md`, at most 160 characters, required — the build fails without it; the index and the plan: `indexDescription` / `planDescription` in `ru.json` / `en.json`), a canonical link and Open Graph tags; with `SITE_URL` set, also the preview image of the page's language (see "Preview image"). To get the site indexed, add it to Google Search Console (URL-prefix property) and Yandex Webmaster, choose the meta tag method, put the tokens into the `GOOGLE_SITE_VERIFICATION` / `YANDEX_VERIFICATION` build variables, redeploy, confirm, then submit `sitemap-index.xml` in both.
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
  - `GET /api/me` → `{ providers }` when signed in, otherwise 401 with `{ available }`: the providers that have credentials (the account menu shows a sign-in button for each);
  - `POST /api/logout`;
  - `DELETE /api/account` → deletes the signed-in reader: the user row, and with it (`ON DELETE CASCADE`) every sign-in identity, every session on every device and the stored progress; removes the cookie. The account menu has a delete button for it (with an inline confirmation); the browser copy of the progress stays;
  - `GET /api/progress` / `PUT /api/progress` for the signed-in reader (401 otherwise, so the page keeps the browser copy).
- **Account menu.** At the right end of the header, next to the theme switch, on every page (in the mobile menu on narrow screens, where Starlight moves the theme switch): a «Войти» button, or once signed in an avatar with the provider's logo. It opens a panel: signed out, why to sign in, a button per available provider (Google's "Sign in with Google" colours for light and dark, GitHub's mark in the same frame) and what we get from them; signed in, the provider, sign-out and account deletion. After a failed sign-in (`?login_error=1`) the panel opens by itself with the message. Signed out, the note under the course progress on the index page is an invitation to sign in that opens the menu (`progressNote`); the browser copy is not announced there. The menu is rendered hidden and shown only where `/api/me` answers with providers, so `npm start` and a static hosting never show it. Markup: `src/components/account-menu.mjs` (put in by the `ThemeSelect` override, `src/components/ThemeSelect.astro`); decisions (API answer, sign-in links, panel position): `src/scripts/account/account.mjs`; DOM: `src/scripts/account/account-ui.ts`.
- **Save hint.** A new reader who is signed out (no progress when the page loaded) gets, at their first piece of progress (a finished chapter, a ticked item, a quiz answer), a card at the bottom of the window: the progress is only in this browser, sign in to keep it, with the sign-in buttons, «Не сейчас» and a close button. Once per browser (`SAVE_HINT_STORAGE_KEY` in localStorage), never for a signed-in reader or where there are no accounts. Not modal, it does not take the focus and is announced through a live region. Markup: `saveHintHtml` in `src/components/account-menu.mjs` (in `PageFrame.astro`); decision: `src/scripts/account/save-hint.mjs`; DOM: `src/scripts/account/save-hint-ui.ts`.
- **Sign-in.** OAuth 2.0 authorization code flow with PKCE (S256) and `state`, plus a `nonce` for OpenID Connect providers (Google), kept for 10 minutes in the `__Host-oauth` cookie between the redirect and the callback. We ask for nothing beyond the provider's user id: Google gets only the `openid` scope (the id is `sub` of the ID token); GitHub gets no scope at all (public profile only), and the Worker reads the numeric `id` from `GET https://api.github.com/user` — not the `login`, which users can rename. The provider's tokens are used once and neither stored nor logged. A token endpoint answer with an `error` field fails the sign-in even with status 200 (that is how GitHub reports a bad code). A provider is on only when both of its secrets are set (`<PROVIDER>_CLIENT_ID`, `<PROVIDER>_CLIENT_SECRET`); endpoints and per-provider options (scope, nonce, extra authorize parameters) are in `OAUTH_PROVIDERS` in `src/config/app.mjs`. The sign-in buttons follow `AUTH_PROVIDERS` (Google first).
- **Progress sync.** The account copy is the same JSON as the browser copy, with a revision number: every `PUT` names the revision it was based on (`X-Progress-Rev`) and gets 409 if another device wrote in between; the page then merges and retries. The browser keeps its copy too, plus a marker (`ai-cookbook-progress-sync`) saying which revision it matches and whether it has unsent changes. On the first sign-in in a browser the two copies are merged (finished chapters and ticks from both, newer answers win); after that the account copy wins on load. Signing out keeps the browser copy. Logic: `src/scripts/progress/sync.mjs`, wiring: `src/scripts/progress/store.ts`.
- **Data.** Cloudflare D1, binding `DB`, schema in `migrations/`. A user is a random id plus the provider's user id (no e-mail, name or provider token); progress is one row per user. A session is a random token in the `__Host-session` cookie (`HttpOnly; Secure; SameSite=Lax`); the database keeps only its SHA-256. Sessions last 30 days and are extended at most once a day while used; a daily cron (`triggers` in `wrangler.jsonc`) deletes expired ones. Lifetimes, names and limits are in `src/config/app.mjs`.
- **Security.** State-changing requests need an `Origin` equal to the site's own; the page to return to after sign-in must be a path on the site; API responses carry the same security headers as the pages and `Cache-Control: no-store`. The page CSP does not change: sign-in is a plain link (navigation), and the API is same-origin.
- **One-time setup** (needs `npx wrangler login`): `npx wrangler d1 create ai-engineer-cookbook`. The config finds the database by name, so no id goes into the repository. Then set the deploy command to `npm run deploy` (table above). If the build token cannot reach D1, give it the D1 Edit permission.
- **Google client.** Google Cloud Console → Google Auth Platform: *Branding* (app name, home page, privacy policy link, the site's domain under *Authorized domains*), *Audience* → External → *Publish app* (in "Testing" only listed test users can sign in), *Data access* → only `openid`. Then *Clients* → *Create client* → Web application, *Authorized redirect URIs*: `https://<site>/api/auth/google/callback` (and `http://localhost:8787/api/auth/google/callback` for local runs, or a separate client for them). Put the values on the hosting with `npx wrangler secret put GOOGLE_CLIENT_ID` and `... GOOGLE_CLIENT_SECRET` (this deploys the current Worker version with the new secrets).
- **GitHub client.** GitHub → *Settings* → *Developer settings* → *OAuth Apps* → *New OAuth App* (an OAuth App, not a GitHub App): application name, homepage URL `https://<site>/`, *Authorization callback URL* `https://<site>/api/auth/github/callback`; device flow stays off. Generate a client secret, then `npx wrangler secret put GITHUB_CLIENT_ID` and `... GITHUB_CLIENT_SECRET`. For local runs register a second OAuth App with `http://localhost:8787/api/auth/github/callback`, so the site's secret never sits on a dev machine. No permissions or scopes are set: the app can read only public profile data, and we keep only the numeric user id.
- **Locally:** copy `.dev.vars.example` to `.dev.vars` (ignored by git) and fill in the credentials. `npm run dev:worker` applies the migrations to a local database in `.wrangler/` and serves the last build from `dist/` together with the Worker on http://localhost:8787 (keep `npm start` running, or run `npm run build` first). The secure cookies work on `localhost` in Chrome and Firefox; Safari does not keep them over plain HTTP. `npm start` itself has no accounts.
- **Privacy page.** `/privacy/` (`PRIVACY_PATH`) is generated by the converter like the review page (`scripts/convert/pages/privacy.mjs`, text in `privacy` in `ru.json` / `en.json`; `/en/privacy/` in English) and linked from the footer of every page and from the account menu. The text is short on purpose: what is kept (progress, and after sign-in only the provider's account id), no ads, no sharing, cookies only for staying signed in, how to delete the account; no hosting or storage details. The statistics paragraph appears only in builds with `CLOUDFLARE_WEB_ANALYTICS_TOKEN`. The contact is `PRIVACY_CONTACT` (a placeholder is shown while it is empty), the date is `PRIVACY_POLICY_DATE` — update it whenever the text or what the Worker stores changes.
- **Going live.** Before turning sign-in on in production, in this order:
  1. Fill in `PRIVACY_CONTACT` in `src/config/app.mjs` (an e-mail or an `https://` link) and check the text of `/privacy/`.
  2. Make sure the deploy command on Cloudflare is `npm run deploy` (it applies the D1 migrations before `wrangler deploy`).
  3. Google Auth Platform → *Branding*: home page `https://ai-engineer-cookbook.olgln.workers.dev/`, privacy policy `https://ai-engineer-cookbook.olgln.workers.dev/privacy/`, and the authorized domain. `workers.dev` is on the Public Suffix List, so the domain to enter is most likely `olgln.workers.dev`, and Google may ask to verify it in Search Console first — not checked yet. Then *Audience* → External → *Publish app*, and add the production redirect URI `https://ai-engineer-cookbook.olgln.workers.dev/api/auth/google/callback` to the client.
  4. GitHub: an OAuth App for the site with the callback URL `https://ai-engineer-cookbook.olgln.workers.dev/api/auth/github/callback` (see "GitHub client" above).
  5. Merge to `main`: the push deploys the Worker and applies the D1 migrations. Without secrets `/api/me` lists no providers, so the account menu stays hidden and the site looks as before. Check that the deploy succeeded and `/api/me` answers 401 with an empty `available`.
  6. `npx wrangler secret put GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET` with the production clients' values. Each `secret put` deploys the current Worker version with the new secret, so the sign-in button of a provider appears as soon as both of its secrets are set. Secrets go after the merge because before it there is no Worker script in production to attach them to.
  7. Check in production: sign-in with each provider, progress sync between two browsers, sign-out and account deletion.
- **Tests** run the Worker against an in-memory stand-in for D1 on `node:sqlite` with the real migrations (`tests/helpers/d1.mjs`) and fake provider endpoints (token endpoints, GitHub's `/user`; `tests/helpers/oauth.mjs`); the browser side of the sync runs `src/scripts/progress/store.ts` under Node with fake `fetch` and `localStorage` (`tests/browser/progress-sync.test.mjs`).

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

Each language has its own preview image (`ogImage` in `LOCALES`, `src/config/app.mjs`): `public/og-image.png` from `assets/og-image.svg` (Russian) and `public/og-image.en.png` from `assets/og-image.en.svg` (English, same layout). Every page gets the original's image from `head`, and the route middleware (`src/route-data.ts`) switches it, its alt text and `og:locale` (`ru_RU` / `en_US`) to the page's language. There is no build dependency: the PNGs are committed. After editing an SVG, re-render it with Chrome and check the result:

```bash
cd site
CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
for name in og-image og-image.en; do
  "$CHROME" --headless --hide-scrollbars \
    --window-size=1200,630 --screenshot="$PWD/public/$name.png" "file://$PWD/assets/$name.svg"
done
```

## Tests

```bash
cd site
npm test         # type check + unit tests of the converter, the progress API and the account Worker + checks of the book itself
npm run typecheck  # the type check alone
```

`npm test` starts with `npm run typecheck`. It first runs the converter and `astro sync`, so the files the code imports exist on a fresh clone too (`src/generated/*.json`, the `astro:content` types in `.astro/`; both are git-ignored), then runs `tsc` twice: `tsconfig.json` checks the TypeScript files (`src/scripts/**/*.ts`, `content.config.ts`) in strict mode, and `tsconfig.mjs.json` checks the `.mjs` modules outside `tests/` by their JSDoc types, without requiring a type on every parameter (`noImplicitAny: false`). Nothing is emitted; Vite and Node still strip the types themselves. `.astro` files are not type-checked.

Tests use the built-in `node:test`, no extra dependencies; the Python syntax check of the book's examples needs `python3` and is skipped without it. `npm run build` also fails when the converter reports a warning.

A git pre-commit hook runs `npm test` before every commit. Enable it once per clone, from the repository root: `git config core.hooksPath .githooks`.

## Language

Code, comments, logs and docs are in English. Reader-facing text lives only in the book, the plan and the interface strings: Russian in `book/*.md`, the root `README.md` and `src/locales/ru.json`; English in `book/en/*.md`, `README.en.md` and `src/locales/en.json`.

## Translations

The Russian book is the original; the site serves it at `/`. Every other language in `LOCALES` (`src/config/app.mjs`) is served under its prefix, `/en/` for English, built from its own folder: `book/en/README.md` (the table of contents, required) and `book/en/AIL-*.md` (chapters), plus `README.en.md` for the plan.

- **Partial translations work.** A chapter or the plan without a translated file gets a short page in that language that links to the original. These placeholders are `noindex`, left out of the sitemap and of the search, and pages that have one get no `hreflang` links (`src/route-data.ts`). The converter prints the state: `convert: en: 3 of 51 chapters translated, plan translated, outdated …`.
- **Progress is shared** between the languages: a chapter keeps its id, quiz answers are stored by question number and checklist ticks by item. So the translated table of contents must list the same weeks, numbers and files as the original, and a translated chapter must have the same quiz questions with the same answer letters and the same number of «Готово, когда» items. The build fails otherwise.
- **Format of a translated chapter**: like the original (see `book/AIL-1.md`), with the headings from `book` in `en.json` (`## Self-check quiz`, `## Answers`, `## Done when`), the title from `book/en/README.md`, and under the description line one more hidden line: `<!-- source-sha256: <hash> -->`, where the hash is the first 12 hex digits of `shasum -a 256 book/AIL-N.md` of the original it was translated from. When the original changes, the converter lists the chapter as outdated (it does not fail the build); update the translation and the hash.
- **Interface strings**: `src/locales/en.json` has exactly the keys of `ru.json` (`npm run typecheck` and `tests/site/locales.test.mjs` check it). Starlight's own interface (search, theme switch, language switch) is translated by Starlight.
- **Adding a language**: one entry in `LOCALES`, a `src/locales/<lang>.json`, a `book/<lang>/README.md`; then translate chapters one by one.

## Files

```text
site/
├── astro.config.mjs, ec.config.mjs   Astro + Starlight setup, code highlighting
├── tsconfig.json, tsconfig.mjs.json  type check of the .ts files (strict) and of the .mjs modules (`npm run typecheck`)
├── wrangler.jsonc                    Cloudflare Workers deployment (static assets + /api/* Worker, D1, cron)
├── .env.example, .dev.vars.example   settings of the build and the local server; Worker secrets for local runs
├── assets/                           SVG sources of the rendered icons and the preview images
├── public/                           files served as is: favicon, iOS icon, og-image*.png
├── migrations/                       D1 schema, applied in order by `wrangler d1 migrations apply`
├── scripts/                          Node scripts, run by npm
│   ├── convert.mjs                   book/*.md → pages: reads the book, writes the generated files, fails on warnings
│   ├── convert/                      the conversion itself, without file access
│   │   ├── renderer.mjs              createRenderer: one renderer per build, collects warnings and stats
│   │   ├── toc.mjs                   book/README.md → weeks and chapters; sidebar, chapter list, page sources
│   │   ├── patterns.mjs              regular expressions built from the chapter prefix and the book headings
│   │   ├── markdown.mjs              fence-aware line, section and numbered-list helpers
│   │   ├── links.mjs                 `AIL-N` references and README links → site links; mermaid fences
│   │   ├── quiz.mjs                  quiz parsing (options, answer keys, previews) and quiz markup
│   │   ├── translation.mjs           checks of a translation against the original: quiz and checklist structure, source hashes
│   │   ├── lastmod.mjs               page dates for the sitemap from `git log`
│   │   └── pages/                    one module per generated page: chapter, plan, index page, review, privacy
│   ├── serve.mjs                     local server for `npm start`: routes, watching, rebuilds, live reload
│   └── serve/
│       ├── static-server.mjs         serving `dist/`: path checks, content types, security headers, 404
│       └── progress-handler.mjs      `GET/PUT /api/progress` → the progress file (also used by `astro dev`)
├── src/
│   ├── config/app.mjs                constants shared by the browser, the server and the build: routes, storage keys, paths, CSP, headers
│   ├── config/server.mjs             reads the environment (`.env`) into the server settings
│   ├── locales/                      ru.json, en.json: every reader-facing string (the 404 page is in English on purpose);
│   │                                 strings.mjs (strings of a language), locales.mjs (language prefixes), format.mjs
│   ├── route-data.ts                 Starlight route middleware: hreflang only between real counterparts, preview image and og:locale per language
│   ├── components/                   Starlight overrides (Footer, PageFrame, ThemeSelect) and the pure markup they render:
│   │                                 the account menu and save hint, the site footer, the 404 page props
│   ├── pages/404.astro               the custom 404 page, in place of Starlight's built-in one
│   ├── head/                         extra `<head>` tags: SEO and icons, Cloudflare Web Analytics with its CSP origins
│   ├── integrations/                 Astro integrations: inline-script hashes for the CSP, `_headers`, `_redirects` and `robots.txt`, the dev progress API
│   ├── scripts/                      browser code, started by main.ts
│   │   ├── main.ts                   boot: loads the progress and starts every widget of the page
│   │   ├── page-locale.ts            the page's language: its strings and chapter list
│   │   ├── dom.ts                    `$$` and `el` helpers
│   │   ├── progress/                 progress store (file, account or browser), its account sync and format migrations
│   │   ├── account/                  account menu and the one-time save hint
│   │   ├── quiz/                     quizzes and the review page
│   │   ├── chapter/                  "done when" checklist and the chapter done card
│   │   ├── course/                   index page progress and done marks on chapter links
│   │   └── mermaid.ts, external-links.ts
│   ├── styles/                       one stylesheet per part of the site, listed in order in astro.config.mjs `customCss`
│   ├── content/                      Starlight content: docs/ (generated pages), i18n/ (Starlight UI strings)
│   └── generated/                    sidebar, chapter list and quiz index per language, sitemap dates, i18n.json (pages every
│                                     language has, placeholders), written by convert.mjs
├── worker/                           the account API on Cloudflare Workers: index.mjs (entry), lib/ (routes, OAuth, sessions, users, progress, HTTP)
└── tests/                            `npm test`, grouped like the code: convert/, serve/, browser/, site/, worker/, helpers/;
                                      book.test.mjs checks the book itself
```

Conventions:

- Generated files (`src/content/docs/`, `src/generated/`) are not stored in git and are never edited by hand.
- In `src/scripts/`, a `.mjs` module is pure logic tested with `node:test`; the `-ui.ts` module next to it wires that logic to the DOM (`account.mjs` + `account-ui.ts`, `checklist.mjs` + `checklist-ui.ts`).
- Each folder of `tests/` covers the folder of the same name in the code (`tests/browser/` covers `src/scripts/`, `tests/site/` the components, head tags, integrations, settings, styles and deployment config).
- CI (`../.github/workflows/ci.yml`) runs the audit, the tests and the build; `../.githooks/pre-commit` runs `npm test` before every commit.

## Dependencies

Astro 7.4.7, Starlight 0.42.7, @astrojs/sitemap 3.7.4 (Starlight's own sitemap, listed directly to add page dates), mermaid 12.2.0, the expressive-code plugins 0.44.3 the deploy tool wrangler 4.158.0 (dev only) and the type checker typescript 6.0.3 (dev only; the last JavaScript release, one package without dependencies, chosen over the native 7.x builds) were reviewed before installation: versions are exact (`save-exact`), the whole tree is frozen at 2026-11-07 (`before=` in `.npmrc`), install scripts are disabled (`ignore-scripts=true`), Astro telemetry is off. Update only deliberately, with the same review.
