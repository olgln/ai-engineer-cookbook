// Response helpers for the Worker API. Static pages get their headers from dist/_headers, which does not
// apply to Worker responses, so every API response carries the same security headers itself.
import { HTTPS_ONLY_HEADERS, SECURITY_HEADERS } from '../../src/config/app.mjs';

/** Headers of every API response: never cached, never sniffed or framed. */
function baseHeaders(extra) {
  const headers = new Headers({ ...SECURITY_HEADERS, ...HTTPS_ONLY_HEADERS, 'Cache-Control': 'no-store' });
  for (const [name, value] of extra) headers.append(name, value);
  return headers;
}

/** JSON response; `extra` is a list of [name, value] pairs, so Set-Cookie can repeat. */
export function json(status, body, extra = []) {
  const headers = baseHeaders(extra);
  headers.set('Content-Type', 'application/json; charset=utf-8');
  return new Response(JSON.stringify(body), { status, headers });
}

/** Empty 204 response. */
export const noContent = (extra = []) => new Response(null, { status: 204, headers: baseHeaders(extra) });

/**
 * A state-changing request must come from a page of this site: the browser's Origin header has to match
 * the request's own origin. A missing Origin is refused too (browsers always send it with POST/PUT/DELETE).
 */
export function isSameOrigin(request) {
  const origin = request.headers.get('Origin');
  return origin !== null && origin === new URL(request.url).origin;
}
