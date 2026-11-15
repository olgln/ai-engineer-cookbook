// Constants shared by the browser code, the dev server and the build scripts.
// Nothing here is environment-specific; machine-level settings live in ./server.mjs (.env).

/** Route of the progress API (served by `astro dev` and by scripts/serve.mjs). */
export const PROGRESS_API_PATH = '/api/progress';

/** Paths the Cloudflare Worker (worker/index.mjs) answers before the static assets (wrangler.jsonc `run_worker_first`). */
export const API_PREFIX = '/api/';

/** Account API, served by the Worker only (the local server has no accounts). */
export const ME_API_PATH = '/api/me';
export const LOGOUT_API_PATH = '/api/logout';
/** `DELETE` removes the signed-in reader's account with its sign-in identities, sessions and progress. */
export const ACCOUNT_API_PATH = '/api/account';

/** Sign-in providers, in the order of the sign-in buttons. */
export const AUTH_PROVIDERS = ['google', 'github'];

/**
 * Session cookie. The __Host- prefix makes the browser require Secure, Path=/ and no Domain, so a
 * subdomain cannot set or read it. The value is a random token; the database keeps only its SHA-256.
 */
export const SESSION_COOKIE = '__Host-session';
export const SESSION_TOKEN_BYTES = 32;
/** A session lives this long after its last renewal, in seconds (30 days). */
export const SESSION_TTL_SECONDS = 30 * 24 * 60 * 60;
/** A used session is renewed at most this often, so most requests do not write to the database (1 day). */
export const SESSION_RENEW_AFTER_SECONDS = 24 * 60 * 60;

/**
 * Sign-in routes: `${AUTH_API_PREFIX}<provider>?return_to=/page/` starts it,
 * `${AUTH_API_PREFIX}<provider>/callback` is the redirect URI registered at the provider.
 */
export const AUTH_API_PREFIX = '/api/auth/';
export const AUTH_CALLBACK_SUFFIX = '/callback';
export const RETURN_TO_PARAM = 'return_to';
/** Added to the page the reader returns to when sign-in did not succeed (cancelled, expired, refused). */
export const LOGIN_ERROR_PARAM = 'login_error';

/**
 * State of a sign-in in progress (state, PKCE verifier, OpenID nonce, page to return to), kept in the browser
 * between the redirect to the provider and the callback. Ten minutes to finish signing in.
 */
export const OAUTH_COOKIE = '__Host-oauth';
export const OAUTH_COOKIE_TTL_SECONDS = 10 * 60;

/**
 * OAuth 2.0 / OpenID Connect endpoints of the providers. Credentials come from Worker secrets
 * `<PROVIDER>_CLIENT_ID` / `<PROVIDER>_CLIENT_SECRET` (.dev.vars locally); a provider without them is off.
 * Every provider gets `state` and PKCE (S256). `scope` is left out of the request when empty; `nonce: true`
 * sends an OpenID Connect nonce (checked in the ID token); `authorizeParams` are added to the provider URL.
 */
export const OAUTH_PROVIDERS = {
  google: {
    authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: 'https://oauth2.googleapis.com/token',
    /** Only the stable user id (`sub` of the ID token): no e-mail, no profile. */
    scope: 'openid',
    nonce: true,
    authorizeParams: { prompt: 'select_account' },
    issuers: ['https://accounts.google.com', 'accounts.google.com'],
  },
  /** A GitHub OAuth App (not a GitHub App). Plain OAuth 2.0: no ID token, so no nonce. */
  github: {
    authorizeUrl: 'https://github.com/login/oauth/authorize',
    tokenUrl: 'https://github.com/login/oauth/access_token',
    /** No scope: the token reads only the public profile, of which we keep the numeric `id`. */
    scope: '',
    nonce: false,
    authorizeParams: { prompt: 'select_account' },
    /** The signed-in user (REST API); GitHub refuses requests without a User-Agent. */
    userUrl: 'https://api.github.com/user',
    apiVersion: '2022-11-28',
    userAgent: 'ai-engineer-cookbook',
  },
};

/** Revision of the reader's progress on the server: sent with GET, required with PUT (optimistic locking). */
export const PROGRESS_REV_HEADER = 'X-Progress-Rev';
/** Largest progress document the Worker stores, in bytes. A full course of answers is well under 100 KB. */
export const ACCOUNT_PROGRESS_MAX_BYTES = 512 * 1024;
/** localStorage key that ties the browser copy to the account copy: { rev, dirty } (src/scripts/sync.mjs). */
export const SYNC_STORAGE_KEY = 'ai-cookbook-progress-sync';

/** Response header that tells the browser where the progress file is stored. */
export const PROGRESS_FILE_HEADER = 'X-Progress-File';

/** localStorage key of the browser copy of the progress. */
export const STORAGE_KEY = 'ai-cookbook-progress';

/**
 * localStorage key set once the "your progress is only in this browser" hint has been shown, so a reader
 * sees it once (src/scripts/save-hint.mjs).
 */
export const SAVE_HINT_STORAGE_KEY = 'ai-cookbook-save-hint-shown';

/** Delay before changed progress is written to the file, in ms. */
export const SAVE_DEBOUNCE_MS = 250;

/** Server-sent events route that tells open pages to reload after a rebuild (`npm start` only). */
export const RELOAD_EVENTS_PATH = '/__reload';

/** Script that subscribes a page to RELOAD_EVENTS_PATH; external, so the page CSP needs no inline exception. */
export const RELOAD_SCRIPT_PATH = '/__reload.js';

/**
 * Astro's type of `security.csp.directives`: each entry must start with a known directive name.
 * @typedef {NonNullable<Exclude<NonNullable<import('astro').AstroUserConfig['security']>['csp'], boolean | undefined>['directives']>} CspDirectives
 */

/**
 * Content Security Policy emitted by Astro as a <meta> tag on every page (astro.config.mjs `security.csp`).
 * Astro adds hashes of its own inline scripts to script-src. Styles stay 'unsafe-inline': mermaid and
 * expressive-code inject inline styles at runtime. 'wasm-unsafe-eval' is for the Pagefind search index.
 */
export const CSP = {
  scriptSources: ["'self'", "'wasm-unsafe-eval'"],
  styleSources: ["'self'", "'unsafe-inline'"],
  /** @type {CspDirectives} typed for `security.csp.directives`, which accepts only known directive names */
  directives: [
    "default-src 'self'",
    "img-src 'self' data:",
    "font-src 'self' data:",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
  ],
};

/**
 * Cloudflare Web Analytics (cookieless page views, referrers, countries), on only when the build has
 * CLOUDFLARE_WEB_ANALYTICS_TOKEN. The beacon script loads from `scriptOrigin` and reports to
 * `reportOrigin`; both are added to the CSP of that build only (src/components/web-analytics.mjs).
 */
export const WEB_ANALYTICS = {
  scriptUrl: 'https://static.cloudflareinsights.com/beacon.min.js',
  scriptOrigin: 'https://static.cloudflareinsights.com',
  reportOrigin: 'https://cloudflareinsights.com',
};

/**
 * Response headers for every page, sent by the local server and written to dist/_headers for the hosting.
 * frame-ancestors only works as a header, not in the <meta> CSP; X-Frame-Options repeats it for old browsers.
 * Cross-Origin-Resource-Policy stops other sites from embedding our files (everything is same-origin).
 */
export const SECURITY_HEADERS = {
  'Content-Security-Policy': "frame-ancestors 'none'",
  'X-Frame-Options': 'DENY',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Resource-Policy': 'same-origin',
};

/** Added only on the hosting (HTTPS); browsers ignore it over plain HTTP. */
export const HTTPS_ONLY_HEADERS = {
  'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
};

/** Build assets with a content hash in the name: cached forever. */
export const IMMUTABLE_ASSETS_GLOB = '/_astro/*';
export const IMMUTABLE_CACHE_CONTROL = 'public, max-age=31536000, immutable';

/** Files written next to the built site for the hosting (Netlify / Cloudflare Pages format). */
export const HEADERS_FILE = '_headers';
export const ROBOTS_FILE = 'robots.txt';
export const SITEMAP_FILE = 'sitemap-index.xml';

/** Quiet period after the last source change before `npm start` rebuilds the site, in ms. */
export const REBUILD_DEBOUNCE_MS = 400;

/** Build output served by scripts/serve.mjs, and the folder a rebuild writes to before the swap; relative to site/. */
export const DIST_DIR = 'dist';
export const NEXT_DIST_DIR = 'dist-next';
export const OLD_DIST_DIR = 'dist-old';

/**
 * Preview image for links shared in messengers and social networks (og:image), in public/.
 * Rendered from assets/og-image.svg; 1200×630 is the size Telegram, VK, X and Facebook expect.
 */
export const OG_IMAGE = { path: '/og-image.png', type: 'image/png', width: 1200, height: 630 };

/**
 * Icons in public/ besides favicon.svg (Starlight's favicon). The home-screen icon for iOS is rendered from
 * assets/apple-touch-icon.svg; favicon.ico is for clients that ask for /favicon.ico without reading the page.
 */
export const APPLE_TOUCH_ICON = { path: '/apple-touch-icon.png', size: 180 };
export const FAVICON_ICO = { path: '/favicon.ico', size: 32 };

/**
 * Search snippet of a chapter (<meta name="description">): one hidden line
 * `<!-- description: … -->` under the meta line of book/AIL-*.md. Search engines cut longer text.
 */
export const DESCRIPTION_MARKER = 'description:';
export const DESCRIPTION_MAX_LENGTH = 160;

/** Route of the course plan page (generated from the root README.md). */
export const PLAN_PATH = '/plan/';

/** Route of the review page: quiz questions answered wrong or marked "didn't know", across all chapters. */
export const REVIEW_PATH = '/review/';

/** Route of the privacy policy page: what the site stores, where, and how to delete it. Public, in the sitemap. */
export const PRIVACY_PATH = '/privacy/';

/**
 * Where readers write about their data, shown on the privacy page: an e-mail address or an https:// link.
 * MUST be filled in before sign-in goes live (site/README.md, "Accounts"); while empty the page shows
 * `privacy.contactPlaceholder` from ru.json.
 */
export const PRIVACY_CONTACT = 'https://t.me/oool_g';

/** Date of the current privacy policy text (YYYY-MM-DD), shown on the page. Change it with the text. */
export const PRIVACY_POLICY_DATE = '2026-11-15';

/** Pages left out of the sitemap: personal pages marked noindex (a noindex page in the sitemap is a Search Console error). */
export const SITEMAP_EXCLUDED_PATHS = [REVIEW_PATH];

/** Each quiz question is a link target: <chapter>#<QUESTION_ANCHOR_PREFIX><n>. */
export const QUESTION_ANCHOR_PREFIX = 'q-';

/** Longest question text shown on the review page; longer questions are cut with "…". */
export const QUESTION_PREVIEW_MAX_LENGTH = 160;

/** Source chapters: <BOOK_DIR>/<CHAPTER_PREFIX><number>.md, relative to the repo root. */
export const BOOK_DIR = 'book';
export const CHAPTER_PREFIX = 'AIL-';

/** Generated output, relative to site/. */
export const DOCS_DIR = 'src/content/docs';
export const SIDEBAR_FILE = 'src/sidebar.json';
export const CHAPTERS_FILE = 'src/chapters.json';
/** Last change of each page's source, from git ({ "/week-01/1-1/": "2026-11-14T…" }); feeds <lastmod> in the sitemap. */
export const LASTMOD_FILE = 'src/lastmod.json';
/** Every quiz question by chapter (number, short text, answer key); loaded by the review page only. */
export const QUIZ_INDEX_FILE = 'src/quiz-index.json';
/** Everything scripts/convert.mjs writes under site/: ignored by git and by the `npm start` watcher (no rebuild loop). */
export const GENERATED_PATHS = [DOCS_DIR, SIDEBAR_FILE, CHAPTERS_FILE, LASTMOD_FILE, QUIZ_INDEX_FILE];

/** Blocks of the root README.md between these markers are not shown on the site. */
export const REPO_ONLY_START = '<!-- repo-only:start -->';
export const REPO_ONLY_END = '<!-- repo-only:end -->';
