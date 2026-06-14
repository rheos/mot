import { NextResponse, type NextRequest } from 'next/server';
import { getIronSession } from 'iron-session';
// Import session config from lib/session (no native deps) — NOT lib/auth, which pulls in
// @node-rs/argon2 and cannot load in the Edge runtime the middleware bundles into.
import { sessionOptions, type SessionData } from './lib/session';

// Gate every UI route behind a valid session (FR-AUTH-2). A request without a valid
// session cookie is redirected to /login.
//
// Public (no session required): /login, the API surface (/api/* carries its own API-key
// or session check), /health and /status (read-only health, spec: no auth), and Next.js
// internals. The matcher below already excludes static assets; PUBLIC_PATHS covers the rest.
const PUBLIC_PATHS = ['/login', '/api/', '/health', '/status', '/_next/', '/favicon'];

export async function middleware(req: NextRequest): Promise<NextResponse> {
  if (PUBLIC_PATHS.some((p) => req.nextUrl.pathname.startsWith(p))) {
    return NextResponse.next();
  }

  const res = NextResponse.next();
  const session = await getIronSession<SessionData>(req, res, sessionOptions);
  if (!session.user) {
    // Redirect via a clone of req.nextUrl (not new URL(..., req.url)): NextURL re-adds the
    // configured basePath when it serializes, so behind the example.com/mot proxy this lands at
    // /mot/login, while at root it stays /login. A plain URL would drop the sub-path prefix.
    const loginUrl = req.nextUrl.clone();
    loginUrl.pathname = '/login';
    loginUrl.search = '';
    return NextResponse.redirect(loginUrl);
  }
  return res;
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
