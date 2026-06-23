import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Track 4, Phase 5 (Prompt 9) — the summarizeThread helper.
//   AC-4: an unknown slug returns getThread's typed { error: 'thread_not_found', slug } and
//         NEVER throws (the structured, model-free path — OQ-1 = (b)).
//   AC-5 + EC-1: a thread with > 50 linked sessions is truncated to <= 50 sessions, truncated is
//         true, truncation_note contains 'truncated', and session_count is the ORIGINAL count.
//
// Harness mirrors memory-routes.test.ts: set DATABASE_URL BEFORE the first dynamic import (the
// lazy-env ordering the data layer relies on), run migrate_db() for the full schema (a bare
// getDb() does NOT apply the hand-written migrations), then seed threads + sessions via the real
// data-layer helpers (createThread / session_digest inserts / linkThreadSession).

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mot-topic-summarize-'));
const tmpDbPath = path.join(tmpDir, 'topic-summarize.db');
process.env.DATABASE_URL = tmpDbPath;

const { migrate_db, getDb } = await import('../../db/client');
const { createThread, linkThreadSession, summarizeThread } = await import('../../lib/topics');

const BIG_SLUG = 'big-thread';
const ORIGINAL_SESSION_COUNT = 51; // > 50 → must truncate (AC-5, EC-1).

beforeAll(() => {
  migrate_db();

  // Seed a thread with 51 linked sessions, each with a short summary (well under the 40k-char
  // budget, so the 50-session cap is the binding constraint).
  const created = createThread(BIG_SLUG, 'Big thread');
  expect('error' in created).toBe(false);

  const db = getDb();
  const insertDigest = db.prepare(
    `INSERT INTO session_digest (session_id, chat_id, summary, ts, turn_count)
     VALUES (?, 'c1', ?, ?, 1)`,
  );
  for (let i = 0; i < ORIGINAL_SESSION_COUNT; i++) {
    const sessionId = `s-big-${i}`;
    // ts increasing with i so getThread's ts DESC ordering is deterministic.
    const ts = `2026-06-${String((i % 28) + 1).padStart(2, '0')}T${String(i % 24).padStart(2, '0')}:00:00.000Z`;
    insertDigest.run(sessionId, `Session ${i} summary`, ts);
    const linked = linkThreadSession(BIG_SLUG, sessionId);
    expect(linked).toEqual({ ok: true });
  }
});

afterAll(() => {
  getDb().close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('summarizeThread — model-free structured summary (Prompt 9)', () => {
  it('AC-4: unknown slug → { error: "thread_not_found", slug }, does NOT throw', () => {
    let result: ReturnType<typeof summarizeThread>;
    expect(() => {
      result = summarizeThread('nonexistent-slug');
    }).not.toThrow();
    expect(result!).toEqual({ error: 'thread_not_found', slug: 'nonexistent-slug' });
  });

  it('AC-5 + EC-1: 51 linked sessions → truncated, <= 50 sessions, original session_count', () => {
    const result = summarizeThread(BIG_SLUG);
    // Narrow off the error arm.
    expect('error' in result).toBe(false);
    if ('error' in result) return;

    expect(result.truncated).toBe(true);
    expect(result.sessions.length).toBeLessThanOrEqual(50);
    expect(result.session_count).toBe(ORIGINAL_SESSION_COUNT); // ORIGINAL count, not the kept count.
    expect(result.truncation_note).toBeDefined();
    expect(result.truncation_note).toContain('truncated');
    // Sanity: the kept sessions carry the real shape from getThread.
    expect(result.sessions[0]).toMatchObject({
      session_id: expect.any(String),
      summary: expect.any(String),
      ts: expect.any(String),
    });
  });

  it('a thread under both caps is NOT truncated, no truncation_note', () => {
    const small = createThread('small-thread', 'Small thread');
    expect('error' in small).toBe(false);
    getDb()
      .prepare(
        `INSERT INTO session_digest (session_id, chat_id, summary, ts, turn_count)
         VALUES ('s-small-1', 'c1', 'Only session', '2026-06-01T00:00:00.000Z', 1)`,
      )
      .run();
    linkThreadSession('small-thread', 's-small-1');

    const result = summarizeThread('small-thread');
    expect('error' in result).toBe(false);
    if ('error' in result) return;
    expect(result.truncated).toBe(false);
    expect(result.truncation_note).toBeUndefined();
    expect(result.sessions.length).toBe(1);
    expect(result.session_count).toBe(1);
  });
});
