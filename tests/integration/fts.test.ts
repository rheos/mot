import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// EC-ARCH-2 — FTS5 index drift. The external-content index keeps no copy of the source,
// so the UPDATE trigger MUST retract OLD terms (the 'delete' command with old.rowid) before
// indexing NEW ones. This test proves: after a body UPDATE, the OLD term stops matching AND
// the NEW term matches. A passing step that still matches the OLD term means the 'delete'
// trigger is broken.

const migrationsFolder = path.join(process.cwd(), 'db/migrations');
let dbPath: string;
let db: Database.Database;

function applyAllMigrations(d: Database.Database): void {
  // Step 1: drizzle-generated base schema (0000_init.sql).
  migrate(drizzle(d), { migrationsFolder });
  // Step 2: hand-written FTS migration (0001_fts.sql) — what migrate_db() applies at boot.
  d.exec(fs.readFileSync(path.join(migrationsFolder, '0001_fts.sql'), 'utf8'));
}

function insertTicket(id: string, title: string, body: string): void {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO ticket
       (id, title, ministry, status, severity, ticket_type, provenance, body,
        private, needs_review, event_count, created_at, updated_at)
     VALUES (?, ?, 'works', 'open', 'normal', 'infra-alert', 'manual', ?, 0, 0, 1, ?, ?)`,
  ).run(id, title, body, now, now);
}

function matchCount(term: string): number {
  // Wrap the term as an FTS5 phrase ("..."). A bare hyphenated token like "root-cause" is
  // otherwise parsed as a column filter / NOT expression by the FTS5 query grammar.
  const row = db
    .prepare('SELECT count(*) AS c FROM ticket_fts WHERE ticket_fts MATCH ?')
    .get(`"${term}"`) as { c: number };
  return row.c;
}

beforeEach(() => {
  dbPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mot-fts-')), 'fts.db');
  db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  applyAllMigrations(db);
});

afterEach(() => {
  db.close();
  for (const suffix of ['', '-wal', '-shm']) {
    const f = dbPath + suffix;
    if (fs.existsSync(f)) fs.rmSync(f);
  }
});

describe('FTS5 sync (EC-ARCH-2)', () => {
  it('retracts OLD body terms on update and indexes NEW ones', () => {
    insertTicket('t1', 'Invoice problem', 'overdue-invoice from a customer');

    // (3) OLD term matches the freshly inserted row.
    expect(matchCount('overdue-invoice')).toBe(1);

    // (4) Update the body, removing the OLD term.
    db.prepare("UPDATE ticket SET body = 'payment-confirmed and cleared' WHERE id = 't1'").run();

    // (5) OLD term must NO LONGER match — the UPDATE trigger retracted it.
    expect(matchCount('overdue-invoice')).toBe(0);

    // (6) NEW term must match — the UPDATE trigger re-indexed.
    expect(matchCount('payment-confirmed')).toBe(1);
  });

  it('indexes title and finds the parent via a comment body', () => {
    insertTicket('t2', 'cert-expiry warning', 'TLS certificate expires soon');
    expect(matchCount('cert-expiry')).toBe(1); // title term

    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO comment (id, ticket_id, author, body, created_at)
       VALUES ('c1', 't2', 'robin', 'remediation-scheduled for tonight', ?)`,
    ).run(now);

    // The comment trigger re-indexed the PARENT ticket row with comment_body.
    expect(matchCount('remediation-scheduled')).toBe(1);
    // Title/body terms still match after the comment re-index (no orphaning the other way).
    expect(matchCount('cert-expiry')).toBe(1);
  });

  it('retracts terms on ticket delete', () => {
    insertTicket('t3', 'transient blip', 'flaky-heartbeat noise');
    expect(matchCount('flaky-heartbeat')).toBe(1);

    db.prepare("DELETE FROM ticket WHERE id = 't3'").run();
    expect(matchCount('flaky-heartbeat')).toBe(0);
  });

  it('indexes new comment terms onto the parent when a comment body is updated', () => {
    insertTicket('t4', 'db latency', 'queries slow at peak');
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO comment (id, ticket_id, author, body, created_at)
       VALUES ('c2', 't4', 'tuttle', 'initial-diagnosis pending', ?)`,
    ).run(now);
    expect(matchCount('initial-diagnosis')).toBe(1);

    db.prepare("UPDATE comment SET body = 'root-cause identified' WHERE id = 'c2'").run();

    // The NEW comment term is searchable on the parent.
    expect(matchCount('root-cause')).toBe(1);
    // KNOWN LIMITATION of the frozen comment_fts_au trigger: it issues the 'delete' command
    // with comment_body='' rather than the OLD comment body, so FTS5 cannot retract the OLD
    // comment terms (external-content delete only retracts the exact column values supplied).
    // The OLD comment term therefore remains matchable. This is surfaced to the writers'
    // room, not fixed here — fixing it means changing the frozen 0001_fts.sql trigger
    // contract, which is outside this prompt's scope. The ticket-body EC-ARCH-2 path (the
    // chunk's named acceptance test, above) is unaffected and correct.
    expect(matchCount('initial-diagnosis')).toBe(1);
  });
});
