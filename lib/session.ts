import type { SessionOptions } from 'iron-session';

// ── Session config (Edge-safe) ────────────────────────────────────────────────
// The iron-session cookie config and payload type, isolated from lib/auth.ts so the Edge
// middleware can import them WITHOUT pulling in @node-rs/argon2 (a native module that cannot
// load in the Edge runtime middleware bundles into). lib/auth.ts re-exports both, so existing
// imports from '../lib/auth' keep working unchanged.

// The only thing we store in the encrypted cookie. There is NO session table —
// the sealed cookie IS the session (FR-AUTH-2, OQ-P3).
export interface SessionData {
  user?: string;
}

export const sessionOptions: SessionOptions = {
  cookieName: 'mot_session',
  // MOT_SESSION_SECRET is the cookie encryption key. The dev fallback is intentionally
  // obvious so a missing secret surfaces as "change this in production", not silent weak crypto.
  password:
    process.env.MOT_SESSION_SECRET ?? 'dev-secret-change-this-in-production-please',
  ttl: 24 * 60 * 60, // 24h (FR-AUTH-2 default)
  cookieOptions: {
    secure: process.env.NODE_ENV === 'production',
    httpOnly: true,
    sameSite: 'lax',
  },
};

// ── Set-Cookie serialization (Edge-safe, no native deps) ──────────────────────
// The login/logout route handlers return a hand-built 303 Response so the redirect Location
// stays a relative path (proxy-safe). A hand-built Response does NOT reliably carry the cookie
// that getIronSession(cookies(), …).save() writes into Next's request store under `next start`,
// so the routes ship the cookie explicitly via these serializers. Every attribute derives from
// sessionOptions above — no literals, one source of truth. The sealed value iron-session
// produces is URL-safe (no chars needing escaping), so it goes into the header verbatim, which
// matches how requireSession()/readCookie() and the Edge middleware read it back.
function baseAttributes(): string {
  const opts = sessionOptions.cookieOptions ?? {};
  const attrs = ['Path=/'];
  if (opts.httpOnly) attrs.push('HttpOnly');
  if (opts.secure) attrs.push('Secure');
  if (opts.sameSite) {
    // 'lax' → 'Lax', 'strict' → 'Strict', 'none' → 'None'.
    const v = String(opts.sameSite);
    attrs.push(`SameSite=${v.charAt(0).toUpperCase()}${v.slice(1)}`);
  }
  return attrs.join('; ');
}

// Set-Cookie value for a logged-in session. Max-Age mirrors iron-session's own rule
// (ttl - 60s so the cookie always expires before the seal does); ttl=0 ⇒ a session cookie.
export function serializeSessionCookie(sealed: string): string {
  const ttl = sessionOptions.ttl ?? 0;
  const maxAge = ttl === 0 ? '' : `; Max-Age=${ttl - 60}`;
  return `${sessionOptions.cookieName}=${sealed}; ${baseAttributes()}${maxAge}`;
}

// Set-Cookie value that clears the session (logout): empty value, immediate expiry.
export function clearSessionCookie(): string {
  return `${sessionOptions.cookieName}=; ${baseAttributes()}; Max-Age=0`;
}
