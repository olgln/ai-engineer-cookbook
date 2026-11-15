// Pages the Worker sees before the static assets (LANGUAGE_REDIRECT_PATHS, wrangler.jsonc `run_worker_first`):
// the home page, where a new reader is sent to the site in their browser's language
// (src/scripts/language/language.mjs decides). Everything else is the static page from the ASSETS binding.
import { HTTPS_ONLY_HEADERS, LANGUAGE_REDIRECT_PATHS, SECURITY_HEADERS } from '../../src/config/app.mjs';
import { homeRedirect } from '../../src/scripts/language/language.mjs';
import { redirect } from './http.mjs';

/** The answer depends on these request headers, so caches must not hand one reader's answer to another. */
export const LANGUAGE_VARY = 'Accept-Language, Cookie';

/**
 * Answers a page request: a 302 to the reader's language on the home page, otherwise the static page.
 * dist/_headers does not apply to responses that pass through the Worker, so the page gets its headers here.
 * @param {Request} request
 * @param {{ fetch: (request: Request) => Promise<Response> }} assets the ASSETS binding
 */
export async function handlePage(request, assets) {
  const url = new URL(request.url);
  const languagePage = LANGUAGE_REDIRECT_PATHS.includes(url.pathname);
  if (languagePage && (request.method === 'GET' || request.method === 'HEAD')) {
    const location = homeRedirect({
      cookie: request.headers.get('Cookie'),
      acceptLanguage: request.headers.get('Accept-Language'),
      userAgent: request.headers.get('User-Agent'),
    });
    if (location) return redirect(location + url.search, [['Vary', LANGUAGE_VARY]]);
  }
  const page = await assets.fetch(request);
  const response = new Response(page.body, page);
  for (const [name, value] of Object.entries({ ...SECURITY_HEADERS, ...HTTPS_ONLY_HEADERS })) response.headers.set(name, value);
  if (languagePage) response.headers.append('Vary', LANGUAGE_VARY);
  return response;
}
