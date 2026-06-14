import { cookies } from 'next/headers';
import { getIronSession } from 'iron-session';
import { sessionOptions, type SessionData } from '../../../../lib/auth';
import { withBasePath } from '../../../../lib/client/base-path';

// POST /api/auth/logout — destroy the session cookie and redirect to /login.
//
// Logout is CLIENT-SIDE cookie destruction only: there is no server-side revocation list,
// so a still-valid copy of the cookie remains replayable until its TTL lapses. This is
// acceptable for the single-user Phase 1 surface (spec: Auth Wiring, logout semantics).
// Do NOT add a session revocation table.
export async function POST(req: Request): Promise<Response> {
  const session = await getIronSession<SessionData>(cookies(), sessionOptions);
  session.destroy();
  // withBasePath keeps the 303 inside the sub-path (e.g. /mot) behind the reverse proxy; no-op at
  // root. See the login route for why req.url alone drops the basePath.
  return Response.redirect(new URL(withBasePath('/login'), req.url), 303);
}
