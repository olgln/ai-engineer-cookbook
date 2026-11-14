// Constants shared by the browser code, the dev server and the build scripts.
// Nothing here is environment-specific; machine-level settings live in ./server.mjs (.env).

/** Route of the progress API (served by `astro dev` and by scripts/serve.mjs). */
export const PROGRESS_API_PATH = '/api/progress';

/** Response header that tells the browser where the progress file is stored. */
export const PROGRESS_FILE_HEADER = 'X-Progress-File';

/** localStorage key of the browser copy of the progress. */
export const STORAGE_KEY = 'ai-cookbook-progress';

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
 * Search snippet of a chapter (<meta name="description">): one hidden line
 * `<!-- description: … -->` under the meta line of book/AIL-*.md. Search engines cut longer text.
 */
export const DESCRIPTION_MARKER = 'description:';
export const DESCRIPTION_MAX_LENGTH = 160;

/** Route of the course plan page (generated from the root README.md). */
export const PLAN_PATH = '/plan/';

/** Source chapters: <BOOK_DIR>/<CHAPTER_PREFIX><number>.md, relative to the repo root. */
export const BOOK_DIR = 'book';
export const CHAPTER_PREFIX = 'AIL-';

/** Generated output, relative to site/. */
export const DOCS_DIR = 'src/content/docs';
export const SIDEBAR_FILE = 'src/sidebar.json';
export const CHAPTERS_FILE = 'src/chapters.json';

/** Blocks of the root README.md between these markers are not shown on the site. */
export const REPO_ONLY_START = '<!-- repo-only:start -->';
export const REPO_ONLY_END = '<!-- repo-only:end -->';
