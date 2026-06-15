import { NextResponse, type NextRequest } from 'next/server';
import { getIronSession } from 'iron-session';
// Import session config from lib/session (no native deps) — NOT lib/auth, which pulls in
// @node-rs/argon2 and cannot load in the Edge runtime the middleware bundles into.
import { sessionOptions, type SessionData } from './lib/session';
// withBasePath is Edge-safe: a pure string concat over the build-time-inlined
// NEXT_PUBLIC_BASE_PATH, no native deps — fine to bundle into the Edge middleware.
import { withBasePath } from './lib/client/base-path';

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
    // Relative, path-only Location (mirrors the login/logout routes): NextResponse.redirect on
    // a cloned req.nextUrl serialized an ABSOLUTE URL built from the INTERNAL origin, so behind
    // the example.com/mot proxy the browser was 307'd to https://localhost:3100/mot/login — a dead
    // host. A relative Location resolves against the EXTERNAL host (example.com). withBasePath yields
    // '/mot/login' in prod, '/login' at root.
    return new NextResponse(null, {
      status: 307,
      headers: { Location: withBasePath('/login') },
    });
  }
  return res;
}

export const config = {
  // The index route '/' must be listed EXPLICITLY: the catch-all below does not match the bare
  // root, so without this an unauthenticated request to '/' (the triage page) skipped the gate
  // and rendered, then 401'd on its client fetch. The catch-all still gates every other page;
  // PUBLIC_PATHS keeps /login, /api/, /health, /status, /_next/, /favicon open.
  matcher: ['/', '/((?!_next/static|_next/image|favicon.ico).*)'],
};
