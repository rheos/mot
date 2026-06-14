import { hash, verify } from '@node-rs/argon2';
import { unsealData } from 'iron-session';
import { randomBytes } from 'node:crypto';
import { getDb } from '../db/client';
import { nowIso } from './time';
import { sessionOptions, type SessionData } from './session';

// ── Auth layer (FR-AUTH-1, FR-AUTH-2) ────────────────────────────────────────
// Two independent credentials:
//   • API key  — argon2 hash in the single-row `app_secret` table (durable, in the DB).
//   • UI login — env-var username/password, password argon2-hashed into module memory
//                (no session/credential table; iron-session encrypts the cookie itself).
// The private-flag READ gate lives here too: `isSessionRequest()` answers "does this
// request carry a valid session cookie?", which P6's listTickets/getTicket turn into
// `includePrivate`.
//
// The session cookie config + payload type live in lib/session.ts (no native deps) so the Edge
// middleware can import them without dragging in @node-rs/argon2. We re-export both here so every
// existing `from '../lib/auth'` import of sessionOptions / SessionData keeps resolving unchanged.
export { sessionOptions, type SessionData };

// ── API-key bootstrap (FR-AUTH-1, Auth Wiring) ────────────────────────────────
// Runs ONCE at server boot (from instrumentation.ts), never per-request.
//
//   • Empty app_secret (first boot): seed it. MOT_API_KEY if set, else a generated key
//     whose plaintext is printed once to stdout for the operator to record.
//   • Non-empty app_secret (later boot): the stored hash is AUTHORITATIVE. Boot NEVER
//     overwrites or rotates it. A present MOT_API_KEY is VERIFIED against the stored hash;
//     a mismatch is a LOUD startup error (fail boot), never a silent re-seed.
export async function bootstrapApiKey(): Promise<void> {
  const db = getDb();
  const row = db.prepare('SELECT key_hash FROM app_secret WHERE id = 1').get() as
    | { key_hash: string }
    | undefined;

  if (!row) {
    // First boot — seed the single row.
    const envKey = process.env.MOT_API_KEY?.trim() || undefined;
    const plainKey = envKey ?? generateRandomKey();
    if (!envKey) {
      // Printed once. The operator must record it — there is no way to recover the
      // plaintext later (only the hash is stored).
      // eslint-disable-next-line no-console
      console.log('[MOT] Generated API key (store this — printed once):', plainKey);
    }
    const keyHash = await hash(plainKey);
    db.prepare(
      'INSERT INTO app_secret (id, key_hash, created_at) VALUES (1, ?, ?)',
    ).run(keyHash, nowIso());
    return;
  }

  // Later boot — stored hash is authoritative.
  const envKey = process.env.MOT_API_KEY?.trim() || undefined;
  if (envKey) {
    const matches = await verify(row.key_hash, envKey);
    if (!matches) {
      throw new Error(
        '[MOT] FATAL: MOT_API_KEY does not match the stored app_secret hash. ' +
          'Remove MOT_API_KEY from the environment to use the stored key, or reset the ' +
          'app_secret row manually if you intentionally rotated the key. Boot never ' +
          'overwrites the stored hash.',
      );
    }
  }
  // envKey absent → the stored hash still validates all requests. No action.
}

function generateRandomKey(): string {
  return randomBytes(32).toString('hex');
}

// ── API-key guard (FR-AUTH-1) ─────────────────────────────────────────────────
// Pull the Bearer token, argon2-verify against the stored hash. Used by write/API routes.
export async function apiKeyGuard(req: Request): Promise<boolean> {
  const header = req.headers.get('authorization') ?? '';
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : null;
  if (!token) return false;

  const row = getDb()
    .prepare('SELECT key_hash FROM app_secret WHERE id = 1')
    .get() as { key_hash: string } | undefined;
  if (!row) return false;

  return verify(row.key_hash, token);
}

// 401 body, FR-AUTH-1 exact shape.
export function unauthorized(): Response {
  return Response.json({ error: 'unauthorized' }, { status: 401 });
}

// ── UI password bootstrap (FR-AUTH-2) ─────────────────────────────────────────
// The password is env-only: argon2-hashed at boot into module memory (never the DB,
// never compared plaintext). verifyPassword() compares a login candidate against it.
let _uiUsername: string | null = null;
let _uiPasswordHash: string | null = null;

export async function bootstrapUiCredentials(): Promise<void> {
  _uiUsername = process.env.MOT_UI_USERNAME?.trim() || null;
  const pw = process.env.MOT_UI_PASSWORD;
  // Phase 1 password policy: any non-empty value (OQ-P3). Empty/absent → login disabled.
  _uiPasswordHash = pw ? await hash(pw) : null;
}

// Verify a login attempt. Same boolean answer regardless of which field was wrong —
// the caller renders one "Invalid credentials" message (no account enumeration, FR-AUTH-2).
export async function verifyCredentials(
  username: string,
  password: string,
): Promise<boolean> {
  if (!_uiUsername || !_uiPasswordHash) return false;
  if (username !== _uiUsername) {
    // Still run a verify against the stored hash to keep timing roughly constant, then fail.
    await verify(_uiPasswordHash, password).catch(() => false);
    return false;
  }
  return verify(_uiPasswordHash, password);
}

// ── Session helpers (FR-AUTH-2, AC-PRIVATE) ───────────────────────────────────
// Read the session from a bare Request (no response object available — this is the path
// the data layer uses). Returns the user, or null if the cookie is absent/invalid/expired.
export async function requireSession(req: Request): Promise<string | null> {
  const sealed = readCookie(req, sessionOptions.cookieName);
  if (!sealed) return null;
  try {
    const data = await unsealData<SessionData>(sealed, {
      password: sessionOptions.password as string,
      ttl: sessionOptions.ttl,
    });
    return data.user ?? null;
  } catch {
    // Tampered, wrong key, or expired seal — treat as no session.
    return null;
  }
}

// The private gate the data layer (P6) consumes: true ⇒ a valid session ⇒ includePrivate.
// API-key-only requests carry no session cookie → false → the SQL adds `AND private = 0`.
export async function isSessionRequest(req: Request): Promise<boolean> {
  return (await requireSession(req)) !== null;
}

// Minimal Cookie-header parser — pulls one named cookie from a bare Request.
function readCookie(req: Request, name: string): string | null {
  const header = req.headers.get('cookie');
  if (!header) return null;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) {
      return decodeURIComponent(part.slice(eq + 1).trim());
    }
  }
  return null;
}
