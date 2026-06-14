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
