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

/** Quiet period after the last source change before `npm start` rebuilds the site, in ms. */
export const REBUILD_DEBOUNCE_MS = 400;

/** Build output served by scripts/serve.mjs, and the folder a rebuild writes to before the swap; relative to site/. */
export const DIST_DIR = 'dist';
export const NEXT_DIST_DIR = 'dist-next';
export const OLD_DIST_DIR = 'dist-old';

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
