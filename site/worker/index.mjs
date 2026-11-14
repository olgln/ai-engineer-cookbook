// Cloudflare Worker: answers API_PREFIX paths (wrangler.jsonc `run_worker_first`); every other path is a
// static asset from dist/ and never reaches this script. Bindings: DB (D1). Logic lives in ./lib.
import { handleApi } from './lib/api.mjs';
import { purgeExpiredSessions } from './lib/session.mjs';

const nowSeconds = () => Math.floor(Date.now() / 1000);

export default {
  fetch(request, env) {
    return handleApi(request, { db: env.DB, now: nowSeconds() });
  },

  /** Daily cron (wrangler.jsonc `triggers`): drop expired sessions. */
  async scheduled(_controller, env) {
    const removed = await purgeExpiredSessions(env.DB, nowSeconds());
    console.log(`purged ${removed} expired sessions`);
  },
};
