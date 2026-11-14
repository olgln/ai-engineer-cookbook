// Routes of the Worker API (everything under API_PREFIX). The Worker sees only these paths; pages and
// assets are served by Cloudflare straight from dist/. `db` is the D1 binding, `now` is Unix seconds.
import { LOGOUT_API_PATH, ME_API_PATH, SESSION_COOKIE } from '../../src/config/app.mjs';
import { isSameOrigin, json, noContent } from './http.mjs';
import {
  clearSessionCookie, deleteSession, getSession, readCookie, sessionCookie, sessionToken,
} from './session.mjs';
import { listProviders } from './users.mjs';

const SET_COOKIE = 'Set-Cookie';

/** GET /api/me: who is signed in. 401 when nobody is (a stale cookie is removed). */
async function me(request, { db, now }) {
  const token = sessionToken(request);
  const session = token && (await getSession(db, token, now));
  if (!session) {
    const hadCookie = readCookie(request.headers.get('Cookie'), SESSION_COOKIE) !== undefined;
    const clear = hadCookie ? [[SET_COOKIE, clearSessionCookie()]] : [];
    return json(401, { error: 'unauthorized' }, clear);
  }
  const renew = session.renewed ? [[SET_COOKIE, sessionCookie(token)]] : [];
  return json(200, { providers: await listProviders(db, session.userId) }, renew);
}

/** POST /api/logout: ends the session and removes the cookie; fine to call when signed out. */
async function logout(request, { db }) {
  const token = sessionToken(request);
  if (token) await deleteSession(db, token);
  return noContent([[SET_COOKIE, clearSessionCookie()]]);
}

/** Path → method → handler. `unsafe` handlers change state and need a same-origin request. */
const ROUTES = {
  [ME_API_PATH]: { GET: { handler: me } },
  [LOGOUT_API_PATH]: { POST: { handler: logout, unsafe: true } },
};

/** Answers one API request. */
export async function handleApi(request, context) {
  const { pathname } = new URL(request.url);
  const route = ROUTES[pathname];
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
