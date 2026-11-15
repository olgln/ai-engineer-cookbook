// Cloudflare Worker: answers API_PREFIX paths and picks the language on the home page (LANGUAGE_REDIRECT_PATHS;
// both in wrangler.jsonc `run_worker_first`); every other path is a static asset from dist/ and never
// reaches this script. Bindings: DB (D1), ASSETS (the static pages); secrets: provider credentials
// (<PROVIDER>_CLIENT_ID / _SECRET). Logic lives in ./lib.
import { API_PREFIX } from '../src/config/app.mjs';
import { handleApi } from './lib/api.mjs';
import { handlePage } from './lib/pages.mjs';
import { purgeExpiredSessions } from './lib/session.mjs';

const nowSeconds = () => Math.floor(Date.now() / 1000);

export default {
  fetch(request, env) {
    if (!new URL(request.url).pathname.startsWith(API_PREFIX)) return handlePage(request, env.ASSETS);
    return handleApi(request, { db: env.DB, now: nowSeconds(), env, fetch: (input, init) => fetch(input, init) });
  },

  /** Daily cron (wrangler.jsonc `triggers`): drop expired sessions. */
  async scheduled(_controller, env) {
    const removed = await purgeExpiredSessions(env.DB, nowSeconds());
    console.log(`purged ${removed} expired sessions`);
  },
};
