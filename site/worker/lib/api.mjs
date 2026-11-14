// Routes of the Worker API (everything under API_PREFIX). The Worker sees only these paths; pages and
// assets are served by Cloudflare straight from dist/. The context holds the D1 binding `db`, `now`
// (Unix seconds), the Worker `env` (provider credentials) and `fetch` (calls to the providers).
import {
  ACCOUNT_PROGRESS_MAX_BYTES, AUTH_API_PREFIX, AUTH_CALLBACK_SUFFIX, LOGIN_ERROR_PARAM, LOGOUT_API_PATH, ME_API_PATH,
  PROGRESS_API_PATH, PROGRESS_REV_HEADER, RETURN_TO_PARAM, SESSION_COOKIE,
} from '../../src/config/app.mjs';
import { isSameOrigin, json, noContent, redirect } from './http.mjs';
import {
  clearOauthCookie, credentials, enabledProviders, finishSignIn, oauthCookie, readOauthCookie, safeReturnTo,
  startSignIn,
} from './oauth.mjs';
import { isProgress, readProgress, writeProgress } from './progress.mjs';
import {
  clearSessionCookie, createSession, deleteSession, getSession, readCookie, sessionCookie, sessionToken,
} from './session.mjs';
import { findOrCreateUser, listProviders } from './users.mjs';

const SET_COOKIE = 'Set-Cookie';

/**
 * The signed-in session of a request, or a ready 401 response. A stale cookie is removed in the 401;
 * a session due for renewal comes with the Set-Cookie to send back (`renew`).
 */
async function authenticate(request, { db, now, env }) {
  const token = sessionToken(request);
  const session = token && (await getSession(db, token, now));
  if (session) return { session, renew: session.renewed ? [[SET_COOKIE, sessionCookie(token)]] : [] };
  const hadCookie = readCookie(request.headers.get('Cookie'), SESSION_COOKIE) !== undefined;
  const clear = hadCookie ? [[SET_COOKIE, clearSessionCookie()]] : [];
  return { denied: json(401, { error: 'unauthorized', available: enabledProviders(env) }, clear) };
}

/** GET /api/me: the providers of the signed-in reader; 401 lists the providers one can sign in with. */
async function me(request, context) {
  const { session, renew, denied } = await authenticate(request, context);
  if (denied) return denied;
  return json(200, { providers: await listProviders(context.db, session.userId) }, renew);
}

/** POST /api/logout: ends the session and removes the cookie; fine to call when signed out. */
async function logout(request, { db }) {
  const token = sessionToken(request);
  if (token) await deleteSession(db, token);
  return noContent([[SET_COOKIE, clearSessionCookie()]]);
}

/** GET /api/progress: the reader's progress, with its revision in PROGRESS_REV_HEADER. */
async function getProgress(request, context) {
  const { session, renew, denied } = await authenticate(request, context);
  if (denied) return denied;
  const { data, rev } = await readProgress(context.db, session.userId);
  return json(200, data, [...renew, [PROGRESS_REV_HEADER, String(rev)]]);
}

/** PUT /api/progress: stores progress based on the revision in PROGRESS_REV_HEADER; 409 when it is stale. */
async function putProgress(request, context) {
  const { session, renew, denied } = await authenticate(request, context);
  if (denied) return denied;
  if (!(request.headers.get('Content-Type') ?? '').startsWith('application/json')) {
    return json(415, { error: 'expected application/json' });
  }
  const baseRev = request.headers.get(PROGRESS_REV_HEADER) ?? '';
  if (!/^\d{1,15}$/.test(baseRev)) return json(400, { error: `missing ${PROGRESS_REV_HEADER}` });
  if (Number(request.headers.get('Content-Length') ?? 0) > ACCOUNT_PROGRESS_MAX_BYTES) {
    return json(413, { error: 'payload too large' });
  }
  const body = await request.arrayBuffer();
  if (body.byteLength > ACCOUNT_PROGRESS_MAX_BYTES) return json(413, { error: 'payload too large' });
  let data;
  try {
    data = JSON.parse(new TextDecoder().decode(body));
  } catch {
    return json(400, { error: 'invalid JSON' });
  }
  if (!isProgress(data)) return json(400, { error: 'expected { chapters: {…} }' });
  const result = await writeProgress(context.db, session.userId, data, Number(baseRev), context.now);
  const headers = [...renew, [PROGRESS_REV_HEADER, String(result.rev)]];
  return result.ok ? json(200, { rev: result.rev }, headers) : json(409, { error: 'conflict', rev: result.rev }, headers);
}

/** GET /api/auth/<provider>?return_to=/page/: remembers the flow in a cookie and redirects to the provider. */
async function signIn(request, { now, env }, provider) {
  const url = new URL(request.url);
  const { flow, location } = await startSignIn({
    provider,
    clientId: credentials(env, provider).clientId,
    origin: url.origin,
    returnTo: url.searchParams.get(RETURN_TO_PARAM),
    now,
  });
  return redirect(location, [[SET_COOKIE, oauthCookie(flow)]]);
}

/** The page to land on after a failed sign-in, marked with LOGIN_ERROR_PARAM so it can say so. */
function failedLanding(returnTo, origin) {
  const url = new URL(safeReturnTo(returnTo), origin);
  url.searchParams.set(LOGIN_ERROR_PARAM, '1');
  return url.pathname + url.search + url.hash;
}

/** GET /api/auth/<provider>/callback: finishes the sign-in, starts a session, returns to the page. */
async function signInCallback(request, { db, now, env, fetch }, provider) {
  const url = new URL(request.url);
  const flow = readOauthCookie(request, now);
  const cookies = [[SET_COOKIE, clearOauthCookie()]];
  let subject;
  try {
    subject = await finishSignIn({
      provider, query: url.searchParams, flow, ...credentials(env, provider), origin: url.origin, now, fetch,
    });
  } catch (error) {
    console.warn(`sign-in with ${provider} failed: ${error.message}`);
    return redirect(failedLanding(flow?.returnTo, url.origin), cookies);
  }
  const userId = await findOrCreateUser(db, provider, subject, now);
  const token = await createSession(db, userId, now);
  return redirect(safeReturnTo(flow.returnTo), [...cookies, [SET_COOKIE, sessionCookie(token)]]);
}

/** Path → method → handler. `unsafe` handlers change state and need a same-origin request. */
const ROUTES = {
  [ME_API_PATH]: { GET: { handler: me } },
  [LOGOUT_API_PATH]: { POST: { handler: logout, unsafe: true } },
  [PROGRESS_API_PATH]: { GET: { handler: getProgress }, PUT: { handler: putProgress, unsafe: true } },
};

/** Routes of the enabled sign-in providers: /api/auth/<p> and /api/auth/<p>/callback. */
function authRoute(pathname, env) {
  if (!pathname.startsWith(AUTH_API_PREFIX)) return undefined;
  const rest = pathname.slice(AUTH_API_PREFIX.length);
  const callback = rest.endsWith(AUTH_CALLBACK_SUFFIX);
  const provider = callback ? rest.slice(0, -AUTH_CALLBACK_SUFFIX.length) : rest;
  if (!enabledProviders(env).includes(provider)) return undefined;
  const handler = callback ? signInCallback : signIn;
  return { GET: { handler: (request, context) => handler(request, context, provider) } };
}

/** Answers one API request. */
export async function handleApi(request, context) {
  const { pathname } = new URL(request.url);
  const route = ROUTES[pathname] ?? authRoute(pathname, context.env);
  if (!route) return json(404, { error: 'not found' });
  const method = route[request.method];
  if (!method) return json(405, { error: 'method not allowed' }, [['Allow', Object.keys(route).join(', ')]]);
  if (method.unsafe && !isSameOrigin(request)) return json(403, { error: 'forbidden' });
  try {
    return await method.handler(request, context);
  } catch (error) {
    console.error(`${request.method} ${pathname} failed:`, error);
    return json(500, { error: 'internal error' });
  }
}
