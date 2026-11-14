// Cloudflare Web Analytics: the beacon <script> for Starlight's `head` and the CSP that lets it run.
// Without a token (local builds, forks) the site gets neither, so it loads nothing from third parties.
// Pure, so it is tested without a build (tests/web-analytics.test.mjs).
import { WEB_ANALYTICS } from '../config/app.mjs';

/**
 * Starlight `head` entries: the beacon script with the site token, or nothing without a token.
 * @param {string | undefined} token
 */
export function webAnalyticsHead(token) {
  if (!token) return [];
  return [{
    tag: 'script',
    attrs: { type: 'module', src: WEB_ANALYTICS.scriptUrl, 'data-cf-beacon': JSON.stringify({ token }) },
  }];
}

/**
 * The CSP with the beacon's origins added: the script to script-src, its reports to connect-src.
 * Without a token the CSP is returned as is. The input is never modified.
 * @template {{ scriptSources: string[], directives: string[] }} T
 * @param {T} csp
 * @param {string | undefined} token
 * @returns {T}
 */
export function withWebAnalytics(csp, token) {
  if (!token) return csp;
  return {
    ...csp,
    scriptSources: [...csp.scriptSources, WEB_ANALYTICS.scriptOrigin],
    directives: csp.directives.map((d) => (/^connect-src\s/.test(d) ? `${d} ${WEB_ANALYTICS.reportOrigin}` : d)),
  };
}
