import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import Database from 'better-sqlite3';
import { setupRouteDb, cleanupTempDb } from './_helpers';

// Self-service change-password (POST /api/account/password) + the DB-backed UI credential.
// The UI password moved from env-only module memory to app_secret.ui_password_hash so the
// user can change it from the app with no restart. These tests drive the route handler and
// verifyCredentials directly against a real migrated DB (no mocks):
//   - seed a known UI password in app_secret → verifyCredentials TRUE for it.
//   - POST with NO session → 401.
//   - valid session + correct current + valid new → 200; new password works, old doesn't;
//     the API key hash in the SAME row is untouched.
//   - wrong current_password → 4xx, password unchanged.
//   - too-short / empty new_password → 422, password unchanged.

// Seed the UI credential into app_secret BEFORE importing the route, via bootstrapUiPassword
// (the real boot path). setupRouteDb seeds the API key; we set the env creds it reads.
const UI_USERNAME = 'robin';
const UI_PASSWORD = 'Tuttle1984'; // mirrors the carry-over prod password
process.env.MOT_UI_USERNAME = UI_USERNAME;
process.env.MOT_UI_PASSWORD = UI_PASSWORD;

const auth = await setupRouteDb('change-password');
const { bootstrapUiPassword, verifyCredentials } = await import('../../lib/auth');
const passwordRoute = await import('../../app/api/account/password/route');

await bootstrapUiPassword(); // seed ui_username / ui_password_hash from the env creds above

afterAll(() => cleanupTempDb(auth.dbPath));

function dbConn(): Database.Database {
  return new Database(auth.dbPath);
}

function readRow(): { key_hash: string; ui_username: string | null; ui_password_hash: string | null } {
  const conn = dbConn();
  try {
    return conn
      .prepare('SELECT key_hash, ui_username, ui_password_hash FROM app_secret WHERE id = 1')
      .get() as { key_hash: string; ui_username: string | null; ui_password_hash: string | null };
  } finally {
    conn.close();
  }
}

// POST with the session cookie (the logged-in user).
function postWithSession(bodyObj: Record<string, unknown>): Request {
  return new Request('http://localhost/api/account/password', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: auth.sessionCookie },
    body: JSON.stringify(bodyObj),
  });
}

// POST with NO session and NO key.
function postNoAuth(bodyObj: Record<string, unknown>): Request {
  return new Request('http://localhost/api/account/password', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(bodyObj),
  });
}

describe('DB-backed UI credential seeds from env', () => {
  it('verifyCredentials is TRUE for the seeded password and FALSE for a wrong one', async () => {
    expect(await verifyCredentials(UI_USERNAME, UI_PASSWORD)).toBe(true);
    expect(await verifyCredentials(UI_USERNAME, 'wrong')).toBe(false);
  });

  it('seeded the app_secret row (ui_username + ui_password_hash) alongside the API key', () => {
    const row = readRow();
    expect(row.ui_username).toBe(UI_USERNAME);
    expect(row.ui_password_hash).toBeTruthy();
    expect(row.key_hash).toBeTruthy(); // API key present
  });
});

describe('POST /api/account/password — auth gate', () => {
  it('NO session → 401 unauthorized', async () => {
    const res = await passwordRoute.POST(
      postNoAuth({ current_password: UI_PASSWORD, new_password: 'brand-new-pass-99' }),
    );
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('unauthorized');

    // Password unchanged — old still works.
    expect(await verifyCredentials(UI_USERNAME, UI_PASSWORD)).toBe(true);
  });
});

describe('POST /api/account/password — validation (password unchanged on reject)', () => {
  it('too-short new_password → 422, password unchanged', async () => {
    const before = readRow();
    const res = await passwordRoute.POST(
      postWithSession({ current_password: UI_PASSWORD, new_password: 'short' }),
    );
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: string; fields: { field: string }[] };
    expect(body.error).toBe('validation_failed');
    expect(body.fields.some((f) => f.field === 'new_password')).toBe(true);

    expect(readRow().ui_password_hash).toBe(before.ui_password_hash); // untouched
    expect(await verifyCredentials(UI_USERNAME, UI_PASSWORD)).toBe(true);
  });

  it('empty new_password → 422, password unchanged', async () => {
    const before = readRow();
    const res = await passwordRoute.POST(
      postWithSession({ current_password: UI_PASSWORD, new_password: '' }),
    );
    expect(res.status).toBe(422);
    expect(readRow().ui_password_hash).toBe(before.ui_password_hash);
    expect(await verifyCredentials(UI_USERNAME, UI_PASSWORD)).toBe(true);
  });

  it('wrong current_password → 422, password unchanged', async () => {
    const before = readRow();
    const res = await passwordRoute.POST(
      postWithSession({ current_password: 'not-the-password', new_password: 'a-fine-new-password' }),
    );
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('invalid_current_password');

    expect(readRow().ui_password_hash).toBe(before.ui_password_hash);
    expect(await verifyCredentials(UI_USERNAME, UI_PASSWORD)).toBe(true);
  });
});

describe('POST /api/account/password — happy path (DB-backed, takes effect immediately)', () => {
  const NEW_PASSWORD = 'a-fresh-strong-password';

  it('valid session + correct current + valid new → 200; new works, old fails; API key untouched', async () => {
    const before = readRow();

    const res = await passwordRoute.POST(
      postWithSession({ current_password: UI_PASSWORD, new_password: NEW_PASSWORD }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(true);

    // New password authoritative immediately; old one rejected. No restart, no re-seed.
    expect(await verifyCredentials(UI_USERNAME, NEW_PASSWORD)).toBe(true);
    expect(await verifyCredentials(UI_USERNAME, UI_PASSWORD)).toBe(false);

    const after = readRow();
    expect(after.ui_password_hash).not.toBe(before.ui_password_hash); // changed
    expect(after.key_hash).toBe(before.key_hash); // API key in the same row UNTOUCHED
    expect(after.ui_username).toBe(UI_USERNAME); // username preserved
  });
});
