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
// or session check), /health and /status (read-only health, spec: no auth), the app icon
// (favicons must load on the login page too), and Next.js internals. The matcher below already
// excludes static assets; PUBLIC_PATHS covers the rest.
const PUBLIC_PATHS = ['/login', '/api/', '/health', '/status', '/_next/', '/favicon', '/icon.svg'];

export async function middleware(req: NextRequest): Promise<NextResponse> {
  if (PUBLIC_PATHS.some((p) => req.nextUrl.pathname.startsWith(p))) {
    return NextResponse.next();
  }

  const res = NextResponse.next();
  const session = await getIronSession<SessionData>(req, res, sessionOptions);
  if (!session.user) {
    // Middleware redirects MUST emit an ABSOLUTE URL: Next.js runs a middleware response's Location
    // through `new URL(...)`, which THROWS on a relative path (ERR_INVALID_URL) — so a path-only
    // Location 500s every gated page in the Edge runtime. Build the origin from the EXTERNAL host
    // (the Host / x-forwarded-host header Apache preserves as example.com via ProxyPreserveHost), NOT
    // from req.nextUrl — behind the proxy nextUrl carries the INTERNAL origin (localhost:3100), a
    // dead host. withBasePath already yields '/mot/login' in prod ('/login' at root); `new URL(path,
    // absoluteOrigin)` does NOT re-add basePath, so the result is exactly https://example.com/mot/login.
    const host = req.headers.get('x-forwarded-host') ?? req.headers.get('host') ?? req.nextUrl.host;
    const proto = req.headers.get('x-forwarded-proto') ?? req.nextUrl.protocol.replace(/:$/, '') ?? 'https';
    const loginUrl = new URL(withBasePath('/login'), `${proto}://${host}`);
    return NextResponse.redirect(loginUrl);
  }
  return res;
}

export const config = {
  // The index route '/' must be listed EXPLICITLY: the catch-all below does not match the bare
  // root, so without this an unauthenticated request to '/' (the triage page) skipped the gate
  // and rendered, then 401'd on its client fetch. The catch-all still gates every other page;
  // PUBLIC_PATHS keeps /login, /api/, /health, /status, /_next/, /favicon, /icon.svg open.
  matcher: ['/', '/((?!_next/static|_next/image|favicon.ico|icon.svg).*)'],
};
