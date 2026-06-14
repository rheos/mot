import { defineConfig, devices } from '@playwright/test';
import path from 'node:path';
import {
  e2eDbPath,
  E2E_API_KEY,
  E2E_USERNAME,
  E2E_PASSWORD,
  E2E_SESSION_SECRET,
} from './tests/e2e/seed';

// E2E config. Boots a real `next dev` against a seeded temp SQLite DB and drives it with a real
// browser. The DB path is resolved once here and shared with the dev server via MOT_E2E_DB, so
// the seed step (global-setup) and the server point at the same file. Tests start authenticated
// via the storageState global-setup writes (a sealed session cookie).

const PORT = 3100;
const DB_PATH = e2eDbPath();

// Make the resolved DB path visible to global-setup (same process) and the webServer (child).
process.env.MOT_E2E_DB = DB_PATH;
process.env.MOT_E2E_PORT = String(PORT);

export default defineConfig({
  testDir: './tests/e2e',
  testMatch: '**/*.spec.ts',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  globalSetup: require.resolve('./tests/e2e/global-setup.ts'),
  use: {
    baseURL: `http://localhost:${PORT}`,
    storageState: path.join(process.cwd(), 'tests/e2e/.auth-state.json'),
    trace: 'on-first-retry',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: `next dev -p ${PORT}`,
    url: `http://localhost:${PORT}/api/status`,
    reuseExistingServer: false,
    timeout: 120_000,
    env: {
      DATABASE_URL: DB_PATH,
      MOT_API_KEY: E2E_API_KEY,
      MOT_UI_USERNAME: E2E_USERNAME,
      MOT_UI_PASSWORD: E2E_PASSWORD,
      MOT_SESSION_SECRET: E2E_SESSION_SECRET,
      BACKUP_PATH: path.join(process.cwd(), 'tests/e2e/.backups'),
      NODE_ENV: 'development',
    },
  },
});
