import { withBasePath } from '../../../../lib/client/base-path';
import { clearSessionCookie } from '../../../../lib/session';

// POST /api/auth/logout — destroy the session cookie and redirect to /login.
//
// Logout is CLIENT-SIDE cookie destruction only: there is no server-side revocation list,
// so a still-valid copy of the cookie remains replayable until its TTL lapses. This is
// acceptable for the single-user Phase 1 surface (spec: Auth Wiring, logout semantics).
// Do NOT add a session revocation table.
export async function POST(): Promise<Response> {
  // Relative, path-only Location (see login route): the browser resolves it against the
  // external host, not the internal origin req.url reports behind the proxy. The expired
  // Set-Cookie clears mot_session on the same response that redirects.
  return new Response(null, {
    status: 303,
    headers: {
      Location: withBasePath('/login'),
      'Set-Cookie': clearSessionCookie(),
    },
  });
}
