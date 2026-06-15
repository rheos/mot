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
//   BUG B — the redirect did NOT build its origin from the EXTERNAL host. The first attempt cloned
//           req.nextUrl and called NextResponse.redirect, serializing an ABSOLUTE URL from the
//           INTERNAL origin: behind the example.com/mot proxy req.nextUrl is localhost:3100, so the
//           browser was 307'd to https://localhost:3100/mot/login — a dead host. The follow-up fix
//           over-corrected to a RELATIVE, path-only Location — but Next.js runs a middleware
//           response's Location through `new URL(...)`, which THROWS on a relative path
//           (ERR_INVALID_URL), so every gated page 500'd instead of redirecting. The correct fix
//           emits an ABSOLUTE URL whose origin comes from the EXTERNAL Host / x-forwarded-host
//           header (example.com, preserved by Apache ProxyPreserveHost) — not from req.nextUrl.
//
// The matcher itself is config Next.js applies before invoking the middleware, so it can't be
// unit-tested by calling the function. We assert it at the source-of-truth level (the exported
// config object lists '/'), then drive the middleware function directly for the redirect/pass
// behaviour with a mock NextRequest — exactly how the route tests construct Requests.

const { middleware, config } = await import('../../middleware');

// Build a NextRequest at an internal app path (no basePath — that's how Next hands paths to the
// middleware; nextUrl.pathname is the internal route). The underlying URL host is the INTERNAL
// origin (localhost) — exactly the proxy situation. We attach an x-forwarded-host of example.com (the
// EXTERNAL host Apache preserves) so we can prove the redirect origin comes from the forwarded
// header, not from nextUrl. Optionally attach a session cookie.
const EXTERNAL_HOST = 'example.com';
function reqFor(pathname: string, cookie?: string): NextRequest {
  const headers = new Headers({
    'x-forwarded-host': EXTERNAL_HOST,
    'x-forwarded-proto': 'https',
  });
  if (cookie) headers.set('Cookie', cookie);
  // Internal origin in the URL (localhost) — the redirect must NOT use this.
  return new NextRequest(`http://localhost:3100${pathname}`, { headers });
}

// The corrected, proxy-correct login Location: an ABSOLUTE URL whose origin is the EXTERNAL host
// (example.com, from the forwarded header) — NOT the internal origin — ending in /login. This is the
// real regression guard: the redirect host must come from the Host header, not req.nextUrl.
function expectAbsoluteExternalLoginRedirect(res: Response): void {
  expect([307, 308]).toContain(res.status);
  const location = res.headers.get('Location') ?? '';
  expect(location).toMatch(/^https?:\/\//); // ABSOLUTE — middleware must not emit a relative Location
  const url = new URL(location);
  expect(url.host).toBe(EXTERNAL_HOST); // origin from the Host header, NOT localhost / internal host
  expect(url.host).not.toContain('localhost');
  expect(url.pathname.endsWith('/login')).toBe(true); // /login (or /mot/login under a base path)
}

describe('middleware matcher gates the index route (BUG A)', () => {
  it("lists '/' explicitly so the bare root is intercepted", () => {
    // The catch-all alone does not match '/'; the root must be its own entry.
    expect(config.matcher).toContain('/');
  });
});

describe('middleware redirects unauthenticated PAGE requests to an absolute external /login (BUG B)', () => {
  it('ROOT path with no session → absolute /login redirect on the external host', async () => {
    const res = await middleware(reqFor('/'));
    expectAbsoluteExternalLoginRedirect(res);
  });

  it('gated sub-path with no session → absolute /login redirect on the external host', async () => {
    const res = await middleware(reqFor('/tickets/new'));
    expectAbsoluteExternalLoginRedirect(res);
  });
});

describe('middleware lets PUBLIC paths through (no redirect)', () => {
  it.each(['/login', '/api/tickets', '/health'])('passes through %s', async (pathname) => {
    const res = await middleware(reqFor(pathname));
    expect(res.status).toBe(200); // NextResponse.next()
    expect(res.headers.get('Location')).toBeNull();
  });
});
