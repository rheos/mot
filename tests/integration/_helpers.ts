import Database from 'better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Shared test harness for the data-layer integration tests (dedup, derived-effects, etc.).
// The data layer reads DATABASE_URL lazily via getDb(), so a test must set DATABASE_URL and
// migrate the temp DB BEFORE the first dynamic import of lib/tickets. Vitest runs each test
// file in its own forked process (vitest.config: pool 'forks', fileParallelism false), so a
// per-file temp DB is isolated.

const migrationsFolder = path.join(process.cwd(), 'db/migrations');

// Create a fresh temp DB, apply both migrations (0000 base + 0001 FTS), point DATABASE_URL at
// it. Returns the path so the caller can clean it up. Call this at module top level, before
// importing lib/tickets.
export function setupTempDb(label: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `mot-${label}-`));
  const dbPath = path.join(dir, `${label}.db`);

  const seed = new Database(dbPath);
  seed.pragma('journal_mode = WAL');
  seed.pragma('foreign_keys = ON');
  // Step 1: drizzle-generated base schema (0000_init.sql).
  migrate(drizzle(seed), { migrationsFolder });
  // Step 2: hand-written FTS migration (0001_fts.sql).
  seed.exec(fs.readFileSync(path.join(migrationsFolder, '0001_fts.sql'), 'utf8'));
  seed.close();

  process.env.DATABASE_URL = dbPath;
  return dbPath;
}

export function cleanupTempDb(dbPath: string): void {
  const dir = path.dirname(dbPath);
  fs.rmSync(dir, { recursive: true, force: true });
}

// A minimal valid POST payload, overridable per test. Mirrors createTicketSchema's shape
// AFTER Zod defaulting (private/needs_review/event_count present). The data layer is the unit
// under test here, not Zod — callers pass already-validated input.
export function createInput(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    title: 'Test ticket',
    ministry: 'works',
    severity: 'normal',
    ticket_type: 'infra-alert',
    provenance: 'manual',
    source_ref: null,
    body: 'A test ticket body.',
    private: false,
    needs_review: false,
    event_count: 1,
    ...overrides,
  };
}
