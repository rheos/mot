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

// ── UI password: env memory (fallback) + DB (authoritative) ───────────────────
// The login credential used to be env-ONLY: MOT_UI_PASSWORD argon2-hashed into module
// memory, never the DB. That can't be changed at runtime. It now lives in the app_secret
// DB row (ui_username / ui_password_hash), mirroring the API key, so the user can change it
// from the app (POST /api/account/password) with no server restart.
//
// Authority model — same one-time-seed pattern as the API key:
//   • bootstrapUiPassword() seeds the DB row from MOT_UI_USERNAME / MOT_UI_PASSWORD IF
//     ui_password_hash is NULL (first boot of this version → the current prod creds carry
//     over). If it's already set, boot leaves it: the DB value is authoritative and env no
//     longer overrides it.
//   • verifyCredentials() reads the DB. If the DB isn't seeded yet (null — e.g. the brief
//     window before the boot step runs, or a config with no env creds) it falls back to the
//     env-memory check so first boot still works.
//
// The env-memory path below is retained ONLY as that fallback. As before, boot runs once from
// instrumentation.ts but `next start` bundles instrumentation separately from route handlers,
// so this module lazily self-initializes the env memory from process.env on first use.
let _uiUsername: string | null = null;
let _uiPasswordHash: string | null = null;
let _uiInitialized = false;

// Hydrate the env-derived UI credential into module memory (the fallback path, and the source
// bootstrapUiPassword() seeds the DB FROM). Idempotent; safe to call from boot and lazily.
export async function bootstrapUiCredentials(): Promise<void> {
  _uiUsername = process.env.MOT_UI_USERNAME?.trim() || null;
  const pw = process.env.MOT_UI_PASSWORD;
  // Phase 1 password policy: any non-empty value (OQ-P3). Empty/absent → no env fallback.
  _uiPasswordHash = pw ? await hash(pw) : null;
  _uiInitialized = true;
}

// Seed the UI login credential into the app_secret row ONCE, from env, then the DB is
// authoritative (the change-password endpoint is the only thing that rewrites it after).
// Runs at boot (instrumentation.ts), after bootstrapApiKey() — the app_secret row already
// exists by then (seeded by bootstrapApiKey on first boot). If ui_password_hash is already
// set, this is a no-op: env never overwrites a stored credential.
export async function bootstrapUiPassword(): Promise<void> {
  const db = getDb();
  const row = db
    .prepare('SELECT ui_password_hash FROM app_secret WHERE id = 1')
    .get() as { ui_password_hash: string | null } | undefined;

  // No app_secret row at all — bootstrapApiKey() seeds it and must run first. Nothing to do
  // here yet; a later boot (with the row present) will seed the UI credential.
  if (!row) return;

  // Already seeded — the stored hash is authoritative, env does not override it.
  if (row.ui_password_hash) return;

  const username = process.env.MOT_UI_USERNAME?.trim() || null;
  const pw = process.env.MOT_UI_PASSWORD;
  // No env credential to seed from → leave it null; verifyCredentials still has its env
  // fallback (also null here → login disabled, the same Phase-1 "empty ⇒ disabled" behavior).
  if (!username || !pw) return;

  const uiHash = await hash(pw);
  db.prepare(
    'UPDATE app_secret SET ui_username = ?, ui_password_hash = ? WHERE id = 1',
  ).run(username, uiHash);
}

// The stored UI credential, or null if the row/column isn't seeded yet (→ env fallback).
function storedUiCredential(): { username: string; hash: string } | null {
  const row = getDb()
    .prepare('SELECT ui_username, ui_password_hash FROM app_secret WHERE id = 1')
    .get() as
    | { ui_username: string | null; ui_password_hash: string | null }
    | undefined;
  if (!row || !row.ui_username || !row.ui_password_hash) return null;
  return { username: row.ui_username, hash: row.ui_password_hash };
}

// Verify a login attempt. Reads the DB credential (authoritative); falls back to the
// env-memory credential only when the DB isn't seeded yet. Same boolean answer regardless of
// which field was wrong — the caller renders one "Invalid credentials" message (no account
// enumeration, FR-AUTH-2) — and we always run an argon2 verify so timing stays constant
// whether the username or the password was the wrong one.
export async function verifyCredentials(
  username: string,
  password: string,
): Promise<boolean> {
  const stored = storedUiCredential();
  if (stored) return verifyAgainst(stored.username, stored.hash, username, password);

  // DB not seeded yet — env fallback (first boot before bootstrapUiPassword, or no DB creds).
  if (!_uiInitialized) await bootstrapUiCredentials();
  if (!_uiUsername || !_uiPasswordHash) return false;
  return verifyAgainst(_uiUsername, _uiPasswordHash, username, password);
}

// Constant-ish-timing compare: always run one argon2 verify against the stored hash, then
// AND it with the username match, so a wrong username and a wrong password cost the same and
// return the same boolean.
async function verifyAgainst(
  storedUsername: string,
  storedHash: string,
  username: string,
  password: string,
): Promise<boolean> {
  const passwordOk = await verify(storedHash, password).catch(() => false);
  return passwordOk && username === storedUsername;
}

// The username currently bound to the UI login — DB if seeded, else the env fallback. The
// change-password endpoint uses it to verify current_password against the right credential
// (the user doesn't re-type their username, just current + new password).
export async function currentUiUsername(): Promise<string | null> {
  const stored = storedUiCredential();
  if (stored) return stored.username;
  if (!_uiInitialized) await bootstrapUiCredentials();
  return _uiUsername;
}

// ── Change the UI password (POST /api/account/password) ───────────────────────
// Verify current_password against the live credential, then write the new argon2 hash to the
// app_secret row. DB-authoritative: the change takes effect on the next login with no restart.
// Returns false (without writing) when current_password is wrong — the caller maps that to a
// 4xx. Only ui_password_hash is touched; key_hash and ui_username are left intact.
export async function changeUiPassword(
  currentPassword: string,
  newPassword: string,
): Promise<boolean> {
  const username = await currentUiUsername();
  // No credential to verify against (login disabled) → cannot change a password that
  // isn't set through this path. Treat as a failed current-password check.
  if (!username) return false;

  const ok = await verifyCredentials(username, currentPassword);
  if (!ok) return false;

  const newHash = await hash(newPassword);
  // Ensure ui_username is populated too — if we were still on the env fallback (DB unseeded),
  // this write is what makes the DB authoritative from now on.
  getDb()
    .prepare(
      'UPDATE app_secret SET ui_username = ?, ui_password_hash = ? WHERE id = 1',
    )
    .run(username, newHash);
  return true;
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
