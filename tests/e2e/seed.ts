import Database from 'better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { sealData } from 'iron-session';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// ── Playwright seed harness ───────────────────────────────────────────────────
// The UI e2e tests drive a real `next dev` against a seeded SQLite DB. This module owns the
// shared knobs: a stable temp DB path, the dev-server credentials, and the helpers global-setup
// uses to (a) build + seed the DB and (b) seal a session cookie so tests start authenticated.
//
// The path is derived once per `playwright test` invocation (keyed on the runner PID) and shared
// with the dev server via the MOT_E2E_DB env var in playwright.config.ts, so both the seeding
// step and the booted server point at the same file.

export const E2E_API_KEY = 'e2e-api-key-0123456789abcdef';
export const E2E_USERNAME = 'robin';
export const E2E_PASSWORD = 'e2e-password';
export const E2E_SESSION_SECRET =
  'e2e-session-secret-at-least-32-characters-long-ok';
export const E2E_COOKIE_NAME = 'mot_session';

// One temp DB per runner process. playwright.config.ts sets MOT_E2E_DB before the webServer
// boots; global-setup reads the same value. Falls back to a PID-keyed temp path if unset.
export function e2eDbPath(): string {
  const fromEnv = process.env.MOT_E2E_DB;
  if (fromEnv) return fromEnv;
  return path.join(os.tmpdir(), `mot-e2e-${process.pid}.db`);
}

const migrationsFolder = path.join(process.cwd(), 'db/migrations');

// Build a fresh DB at the given path: drizzle base migration + the hand-written FTS migration.
// Removes any stale file (and its WAL/SHM siblings) first so every run starts clean.
export function buildFreshDb(dbPath: string): void {
  for (const suffix of ['', '-wal', '-shm']) {
    fs.rmSync(`${dbPath}${suffix}`, { force: true });
  }
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });

  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  migrate(drizzle(db), { migrationsFolder });
  db.exec(fs.readFileSync(path.join(migrationsFolder, '0001_fts.sql'), 'utf8'));
  db.close();
}

export interface SeedTicket {
  id: string;
  title: string;
  ministry?: string;
  status?: string;
  severity?: string;
  ticket_type?: string;
  provenance?: string;
  body?: string;
  event_count?: number;
  needs_review?: boolean;
  snoozed_until?: string | null;
}

// Insert tickets straight into the base table (the FTS triggers fire automatically, keeping
// ticket_fts in sync). Used by tests that need a known starting state.
export function seedTickets(dbPath: string, tickets: SeedTicket[]): void {
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  const now = new Date().toISOString();
  const insert = db.prepare(
    `INSERT INTO ticket (
        id, title, ministry, status, severity, ticket_type, provenance,
        source_ref, dedup_key, body, private, needs_review, event_count,
        snoozed_until, blocked_note, linked_ticket_id, created_at, updated_at, closed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, 0, ?, ?, ?, NULL, NULL, ?, ?, NULL)`,
  );
  const tx = db.transaction((rows: SeedTicket[]) => {
    for (const t of rows) {
      insert.run(
        t.id,
        t.title,
        t.ministry ?? 'works',
        t.status ?? 'open',
        t.severity ?? 'normal',
        t.ticket_type ?? 'infra-alert',
        t.provenance ?? 'manual',
        t.body ?? `${t.title} body`,
        t.needs_review ? 1 : 0,
        t.event_count ?? 1,
        t.snoozed_until ?? null,
        now,
        now,
      );
    }
  });
  tx(tickets);
  db.close();
}

// Wipe all tickets (and comments) between tests so each spec controls its own state. The FTS
// delete triggers retract terms as rows go.
export function resetTickets(dbPath: string): void {
  const db = new Database(dbPath);
  db.pragma('foreign_keys = ON');
  db.exec('DELETE FROM comment; DELETE FROM ticket;');
  db.close();
}

// Seal a session cookie the same way the login route does, so storageState lands tests on an
// authenticated page without driving the login form each time.
export async function sealSessionCookie(): Promise<string> {
  return sealData(
    { user: E2E_USERNAME },
    { password: E2E_SESSION_SECRET, ttl: 24 * 60 * 60 },
  );
}
