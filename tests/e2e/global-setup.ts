import fs from 'node:fs';
import path from 'node:path';
import {
  buildFreshDb,
  e2eDbPath,
  sealSessionCookie,
  E2E_COOKIE_NAME,
} from './seed';

// Playwright global setup. Runs once before the suite: builds a fresh seeded DB at the path the
// dev server will use, and writes an authenticated storageState (a sealed session cookie) so
// every test starts logged in — the middleware (Prompt 4) would otherwise bounce them to /login.
export default async function globalSetup(): Promise<void> {
  const dbPath = e2eDbPath();
  buildFreshDb(dbPath);

  const port = process.env.MOT_E2E_PORT ?? '3100';
  const sealed = await sealSessionCookie();

  const storageState = {
    cookies: [
      {
        name: E2E_COOKIE_NAME,
        value: sealed,
        domain: 'localhost',
        path: '/',
        expires: Math.floor(Date.now() / 1000) + 24 * 60 * 60,
        httpOnly: true,
        secure: false,
        sameSite: 'Lax' as const,
      },
    ],
    origins: [],
  };

  const statePath = path.join(process.cwd(), 'tests/e2e/.auth-state.json');
  fs.writeFileSync(statePath, JSON.stringify(storageState, null, 2));
  // port is referenced via baseURL in the config; surface it here for parity/debugging.
  void port;
}
