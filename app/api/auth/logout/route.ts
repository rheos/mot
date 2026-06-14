import { cookies } from 'next/headers';
import { getIronSession } from 'iron-session';
import { sessionOptions, type SessionData } from '../../../../lib/auth';

// POST /api/auth/logout — destroy the session cookie and redirect to /login.
//
// Logout is CLIENT-SIDE cookie destruction only: there is no server-side revocation list,
// so a still-valid copy of the cookie remains replayable until its TTL lapses. This is
// acceptable for the single-user Phase 1 surface (spec: Auth Wiring, logout semantics).
// Do NOT add a session revocation table.
export async function POST(req: Request): Promise<Response> {
  const session = await getIronSession<SessionData>(cookies(), sessionOptions);
  session.destroy();
  return Response.redirect(new URL('/login', req.url), 303);
}
