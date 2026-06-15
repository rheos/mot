import { describe, it, expect } from 'vitest';
import { NextRequest } from 'next/server';

// Regression test for the prod auth-gating outage (society/20260614-mot-phase1):
//
//   BUG A — config.matcher did NOT list the index route '/', and the catch-all pattern
//           '/((?!_next/static|...).*)' does not match the bare root (a Next.js matcher gotcha).
//           So an UNAUTHENTICATED request to '/' (the triage page) skipped the gate, rendered,
//           then 401'd on its client fetch to /api/tickets ("Could not load tickets"). The fix
//           lists '/' explicitly in the matcher so the root is gated like every other page.
//
//   BUG B — the redirect cloned req.nextUrl and called NextResponse.redirect, which serialized
//           an ABSOLUTE URL from the INTERNAL origin. Behind the example.com/mot proxy req.nextUrl
//           is localhost:3100, so the browser was 307'd to https://localhost:3100/mot/login —
//           a dead host. The fix emits a RELATIVE, path-only Location (withBasePath('/login')),
//           which the browser resolves against the EXTERNAL host. Mirrors the login/logout routes.
//
// The matcher itself is config Next.js applies before invoking the middleware, so it can't be
// unit-tested by calling the function. We assert it at the source-of-truth level (the exported
// config object lists '/'), then drive the middleware function directly for the redirect/pass
// behaviour with a mock NextRequest — exactly how the route tests construct Requests.

const { middleware, config } = await import('../../middleware');

// Build a NextRequest at an internal app path (no basePath — that's how Next hands paths to the
// middleware; nextUrl.pathname is the internal route). Optionally attach a session cookie.
function reqFor(pathname: string, cookie?: string): NextRequest {
  const headers = cookie ? { Cookie: cookie } : undefined;
  return new NextRequest(`http://localhost${pathname}`, headers ? { headers } : undefined);
}

// A relative login Location: starts with '/', is NOT absolute (no scheme/host), targets /login.
function expectRelativeLoginRedirect(res: Response): void {
  expect([307, 308]).toContain(res.status);
  const location = res.headers.get('Location') ?? '';
  expect(location.startsWith('/')).toBe(true); // path-only, resolves against the external host
  expect(location).not.toMatch(/^https?:\/\//); // never an absolute URL
  expect(location).not.toContain('localhost'); // never the internal origin
  expect(location.endsWith('/login')).toBe(true);
}

describe('middleware matcher gates the index route (BUG A)', () => {
  it("lists '/' explicitly so the bare root is intercepted", () => {
    // The catch-all alone does not match '/'; the root must be its own entry.
    expect(config.matcher).toContain('/');
  });
});

describe('middleware redirects unauthenticated PAGE requests to a relative /login (BUG B)', () => {
  it('ROOT path with no session → relative /login redirect', async () => {
    const res = await middleware(reqFor('/'));
    expectRelativeLoginRedirect(res);
  });

  it('gated sub-path with no session → relative /login redirect', async () => {
    const res = await middleware(reqFor('/tickets/new'));
    expectRelativeLoginRedirect(res);
  });
});

describe('middleware lets PUBLIC paths through (no redirect)', () => {
  it.each(['/login', '/api/tickets', '/health'])('passes through %s', async (pathname) => {
    const res = await middleware(reqFor(pathname));
    expect(res.status).toBe(200); // NextResponse.next()
    expect(res.headers.get('Location')).toBeNull();
  });
});
