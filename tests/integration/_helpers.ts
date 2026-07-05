import Database from 'better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { getLoadablePath } from 'sqlite-vec';
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

/**
 * Like setupTempDb, but also loads the sqlite-vec extension into the seed connection and applies
 * every hand-written migration through 0007_vec.sql — so the four vec0 tables exist in the temp
 * DB. Used by vec-backfill.test.ts (vec-write/vec-retrieval predate it and carry their own inline
 * setups); prefer this helper for any NEW vec-specific integration test.
 *
 * Returns { dbPath, vecAvail }. When the extension can't load on this platform, vecAvail is false
 * and 0007_vec.sql is skipped (the CREATE VIRTUAL TABLE would throw); callers MUST guard with
 * `describe.skipIf(!vecAvail)` so an extension-missing box skips cleanly instead of failing.
 */
export function setupVecDb(label: string): { dbPath: string; vecAvail: boolean } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `mot-${label}-vec-`));
  const dbPath = path.join(dir, `${label}.db`);

  const seed = new Database(dbPath);
  seed.pragma('journal_mode = WAL');
  seed.pragma('foreign_keys = ON');

  // Load the vec extension FIRST (same resolution as lib/vec.ts: SQLITE_VEC_PATH override, else
  // sqlite-vec's own getLoadablePath). If it throws on this platform, DON'T create the vec tables
  // and let the caller's skipIf(!vecAvail) skip the whole block — never abort setup.
  let vecAvail = true;
  try {
    const vecPath = process.env.SQLITE_VEC_PATH ?? getLoadablePath();
    seed.loadExtension(vecPath);
  } catch (err) {
    console.warn('[test] sqlite-vec extension not available:', (err as Error).message);
    vecAvail = false;
  }

  // drizzle-tracked base schema, then the hand-written migrations in db/client.ts's order.
  migrate(drizzle(seed), { migrationsFolder });
  seed.exec(fs.readFileSync(path.join(migrationsFolder, '0001_fts.sql'), 'utf8'));
  seed.exec(fs.readFileSync(path.join(migrationsFolder, '0003_conversation_fts.sql'), 'utf8'));
  seed.exec(fs.readFileSync(path.join(migrationsFolder, '0004_topic_threads.sql'), 'utf8'));
  seed.exec(fs.readFileSync(path.join(migrationsFolder, '0005_procedural_notes.sql'), 'utf8'));
  seed.exec(fs.readFileSync(path.join(migrationsFolder, '0006_memory_fts.sql'), 'utf8'));
  if (vecAvail) {
    // 0007_vec.sql's CREATE VIRTUAL TABLE ... USING vec0 needs the extension loaded (above).
    seed.exec(fs.readFileSync(path.join(migrationsFolder, '0007_vec.sql'), 'utf8'));
  }
  seed.close();

  process.env.DATABASE_URL = dbPath;
  return { dbPath, vecAvail };
}

export function cleanupTempDb(dbPath: string): void {
  const dir = path.dirname(dbPath);
  fs.rmSync(dir, { recursive: true, force: true });
}

// ── Route-handler test rig (Prompt 8) ─────────────────────────────────────────
// The route tests exercise the HTTP handlers end-to-end against a temp DB. Two things the
// data-layer tests don't need: a seeded API key (so apiKeyGuard accepts a Bearer token) and a
// sealed session cookie (so isSessionRequest sees a session → includePrivate). setupRouteDb()
// builds the temp DB, seeds app_secret with a known key, and returns the headers for both.

const ROUTE_API_KEY = 'route-test-key-0123456789';

export interface RouteAuth {
  dbPath: string;
  apiKey: string;
  // Authorization header that apiKeyGuard accepts (API-key-only ⇒ includePrivate=false).
  authHeader: { Authorization: string };
  // A sealed mot_session cookie for user 'robin' ⇒ isSessionRequest true ⇒ includePrivate.
  sessionCookie: string;
}

// Set up the temp DB, seed the API key, and seal a session cookie. Call at module top level,
// before importing the route handlers (same ordering constraint as setupTempDb).
export async function setupRouteDb(label: string): Promise<RouteAuth> {
  const dbPath = setupTempDb(label);

  // Seed app_secret with a known key via the real bootstrap path (hashes ROUTE_API_KEY).
  process.env.MOT_API_KEY = ROUTE_API_KEY;
  const { bootstrapApiKey } = await import('../../lib/auth');
  await bootstrapApiKey();

  // Seal a session cookie the same way the login route does (sessionOptions password + ttl).
  const { sealData } = await import('iron-session');
  const { sessionOptions } = await import('../../lib/auth');
  const sealed = await sealData(
    { user: 'robin' },
    { password: sessionOptions.password as string, ttl: sessionOptions.ttl },
  );

  return {
    dbPath,
    apiKey: ROUTE_API_KEY,
    authHeader: { Authorization: `Bearer ${ROUTE_API_KEY}` },
    sessionCookie: `${sessionOptions.cookieName}=${sealed}`,
  };
}

// A minimal valid POST /tickets JSON body (provenance/source carry through the dedup path).
// Overridable per test. Distinct from createInput(): this is the pre-Zod HTTP body, so it omits
// the defaulted fields Zod fills in (private/needs_review/event_count).
export function postBody(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    title: 'Route test ticket',
    ministry: 'works',
    severity: 'normal',
    ticket_type: 'infra-alert',
    provenance: 'manual',
    body: 'A route test ticket body.',
    ...overrides,
  };
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
