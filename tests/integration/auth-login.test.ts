import { describe, it, expect, afterAll } from 'vitest';
import { setupTempDb, cleanupTempDb } from './_helpers';

// Regression test for the prod login outage (society/20260614-mot-phase1):
//
//   BUG 1 — verifyCredentials read the UI password hash from MODULE-LEVEL state that only
//           bootstrapUiCredentials() (run once at boot from instrumentation.ts) populated. In
//           `next start`, instrumentation bundles SEPARATELY from the route handlers, so the
//           lib/auth instance the login route imported had _uiPasswordHash === null and rejected
//           EVERY login. The fix makes verifyCredentials lazily self-init from process.env.
//
//   BUG 2 — the login/logout routes redirected with `new URL(withBasePath(...), req.url)`. Behind
//           the proxy a route handler's req.url is the INTERNAL origin (localhost:3100), so the
//           browser was 303'd to https://localhost:3100/mot/... (a dead host). The fix emits a
//           RELATIVE, path-only Location and ships the iron-session Set-Cookie on the same 303.
//
// (a) drives verifyCredentials directly in a fresh module instance WITHOUT calling
//     bootstrapUiCredentials first (vitest forks each file → fresh module → _uiInitialized=false,
//     exactly the prod case). (b) drives the POST /api/auth/login handler like the other route
//     tests and asserts a relative Location + a mot_session Set-Cookie on success.

// Configure the UI credentials and a temp DB BEFORE the first import of lib/auth (which pulls in
// getDb() + argon2). We intentionally do NOT call bootstrapUiCredentials() — that is the point.
const UI_USERNAME = 'robin';
const UI_PASSWORD = 'correct-horse-battery-staple';
process.env.MOT_UI_USERNAME = UI_USERNAME;
process.env.MOT_UI_PASSWORD = UI_PASSWORD;

const dbPath = setupTempDb('auth-login');

const { verifyCredentials } = await import('../../lib/auth');
const loginRoute = await import('../../app/api/auth/login/route');

afterAll(() => cleanupTempDb(dbPath));

function loginPost(username: string, password: string): Request {
  return new Request('http://localhost/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
}

describe('verifyCredentials self-initializes without a prior boot call (BUG 1)', () => {
  it('returns TRUE for the configured env creds with NO bootstrapUiCredentials() call', async () => {
    // Fresh module instance, boot never ran — this is the prod fresh-bundle case. The lazy
    // ensure-init inside verifyCredentials must make it work anyway.
    expect(await verifyCredentials(UI_USERNAME, UI_PASSWORD)).toBe(true);
  });

  it('returns FALSE for a wrong password', async () => {
    expect(await verifyCredentials(UI_USERNAME, 'wrong-password')).toBe(false);
  });

  it('returns FALSE for a wrong username', async () => {
    expect(await verifyCredentials('not-robin', UI_PASSWORD)).toBe(false);
  });
});

describe('POST /api/auth/login — proxy-safe relative redirect + session cookie (BUG 2)', () => {
  it('correct creds → 303 to a RELATIVE Location carrying a mot_session Set-Cookie', async () => {
    const res = await loginRoute.POST(loginPost(UI_USERNAME, UI_PASSWORD));
    expect(res.status).toBe(303);

    const location = res.headers.get('Location') ?? '';
    // Relative, path-only — must resolve against the EXTERNAL host, never the internal origin.
    expect(location.startsWith('/')).toBe(true);
    expect(location).not.toMatch(/^https?:\/\//);
    expect(location).not.toContain('localhost');

    // The session cookie must ship on the SAME response as the redirect.
    const setCookie = res.headers.get('Set-Cookie') ?? '';
    expect(setCookie).toMatch(/^mot_session=/);
    expect(setCookie).not.toMatch(/^mot_session=;/); // a real sealed value, not a cleared cookie
    expect(setCookie).toContain('HttpOnly');
  });

  it('wrong password → 303 to a RELATIVE /login?error=1 with no session cookie', async () => {
    const res = await loginRoute.POST(loginPost(UI_USERNAME, 'nope'));
    expect(res.status).toBe(303);

    const location = res.headers.get('Location') ?? '';
    expect(location.startsWith('/')).toBe(true);
    expect(location).not.toMatch(/^https?:\/\//);
    expect(location).not.toContain('localhost');
    expect(location).toContain('/login?error=1');

    expect(res.headers.get('Set-Cookie')).toBeNull();
  });
});
