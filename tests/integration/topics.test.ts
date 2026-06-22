import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Recallatron Phase 3 — topic threads (lib/topics.ts). Same harness as migrations.test.ts: set
// DATABASE_URL to a fresh temp DB BEFORE the first dynamic import, then drive the real boot
// migration entrypoint (migrate_db) so the full hand-written stack — including 0004_topic_threads
// — lands. linkThreadSession/getThread need session_digest rows (the FK target on the join
// table), so we seed them directly via the same DB handle.

const tmpDbPath = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), 'mot-topics-')),
  'topics.db',
);
process.env.DATABASE_URL = tmpDbPath;

const { migrate_db, getDb } = await import('../../db/client');
const { createThread, linkThreadSession, listThreads, getThread } = await import(
  '../../lib/topics'
);

// Seed a session_digest row directly (the FK target of topic_thread_session.session_id).
function seedSession(sessionId: string, summary: string, ts: string): void {
  getDb()
    .prepare(
      `INSERT INTO session_digest (session_id, chat_id, summary, ts, turn_count)
       VALUES (?, 'c1', ?, ?, 1)`,
    )
    .run(sessionId, summary, ts);
}

describe('lib/topics — topic threads', () => {
  beforeAll(() => {
    migrate_db();
    seedSession('s-alpha', 'Alpha session summary', '2026-06-01T10:00:00.000Z');
    seedSession('s-beta', 'Beta session summary', '2026-06-02T10:00:00.000Z');
  });

  afterAll(() => {
    getDb().close();
    for (const suffix of ['', '-wal', '-shm']) {
      const f = tmpDbPath + suffix;
      if (fs.existsSync(f)) fs.rmSync(f);
    }
  });

  it('createThread happy path returns the new row', () => {
    const t = createThread('billing-setup', 'Billing setup', 'how invoices work');
    if ('error' in t) throw new Error(`expected a thread, got ${t.error}`);
    expect(t.slug).toBe('billing-setup');
    expect(t.title).toBe('Billing setup');
    expect(t.notes).toBe('how invoices work');
    expect(t.created_at).toBeTruthy();
    expect(t.last_active_at).toBe(t.created_at);
  });

  it('createThread with notes omitted stores null', () => {
    const t = createThread('no-notes', 'No notes');
    if ('error' in t) throw new Error(`expected a thread, got ${t.error}`);
    expect(t.notes).toBeNull();
  });

  it('createThread with an invalid slug returns invalid_slug', () => {
    const r = createThread('Not A Slug!', 'Bad');
    expect(r).toEqual({ error: 'invalid_slug', slug: 'Not A Slug!' });
  });

  it('createThread collision returns slug_exists with the existing record', () => {
    createThread('dup-slug', 'First');
    const r = createThread('dup-slug', 'Second');
    if (!('error' in r) || r.error !== 'slug_exists') {
      throw new Error('expected slug_exists');
    }
    expect(r.existing.slug).toBe('dup-slug');
    expect(r.existing.title).toBe('First'); // existing row, not the colliding input
  });

  it('linkThreadSession happy path returns ok and bumps last_active_at', () => {
    createThread('link-happy', 'Link happy');
    const before = (
      getDb()
        .prepare(`SELECT last_active_at FROM topic_thread WHERE slug = 'link-happy'`)
        .get() as { last_active_at: string }
    ).last_active_at;

    const r = linkThreadSession('link-happy', 's-alpha');
    expect(r).toEqual({ ok: true });

    const after = (
      getDb()
        .prepare(`SELECT last_active_at FROM topic_thread WHERE slug = 'link-happy'`)
        .get() as { last_active_at: string }
    ).last_active_at;
    // last_active_at moved forward (or at least did not regress).
    expect(after >= before).toBe(true);

    const count = (
      getDb()
        .prepare(
          `SELECT count(*) AS c FROM topic_thread_session WHERE slug = 'link-happy'`,
        )
        .get() as { c: number }
    ).c;
    expect(count).toBe(1);
  });

  it('linkThreadSession with a nonexistent slug returns thread_not_found', () => {
    const r = linkThreadSession('ghost-thread', 's-alpha');
    expect(r).toEqual({ error: 'thread_not_found', slug: 'ghost-thread' });
  });

  it('linkThreadSession with a nonexistent session_id returns session_not_found', () => {
    createThread('link-badsession', 'Link bad session');
    const r = linkThreadSession('link-badsession', 's-missing');
    expect(r).toEqual({ error: 'session_not_found', session_id: 's-missing' });
  });

  it('linkThreadSession is idempotent — re-linking the same pair leaves exactly one row', () => {
    createThread('link-idem', 'Link idem');
    expect(linkThreadSession('link-idem', 's-alpha')).toEqual({ ok: true });
    expect(linkThreadSession('link-idem', 's-alpha')).toEqual({ ok: true });

    const count = (
      getDb()
        .prepare(`SELECT count(*) AS c FROM topic_thread_session WHERE slug = 'link-idem'`)
        .get() as { c: number }
    ).c;
    expect(count).toBe(1);
  });

  it('listThreads returns the correct session_count per thread', () => {
    createThread('count-zero', 'Count zero');
    createThread('count-two', 'Count two');
    linkThreadSession('count-two', 's-alpha');
    linkThreadSession('count-two', 's-beta');

    const all = listThreads();
    const zero = all.find((t) => t.slug === 'count-zero');
    const two = all.find((t) => t.slug === 'count-two');
    expect(zero?.session_count).toBe(0);
    expect(two?.session_count).toBe(2);

    // Ordered by last_active_at DESC — count-two was linked after count-zero was created.
    const zeroIdx = all.findIndex((t) => t.slug === 'count-zero');
    const twoIdx = all.findIndex((t) => t.slug === 'count-two');
    expect(twoIdx).toBeLessThan(zeroIdx);
  });

  it('getThread happy path returns the thread plus its linked sessions, newest first', () => {
    createThread('detail', 'Detail');
    linkThreadSession('detail', 's-alpha'); // ts 2026-06-01
    linkThreadSession('detail', 's-beta'); // ts 2026-06-02

    const d = getThread('detail');
    if ('error' in d) throw new Error(`expected a thread, got ${d.error}`);
    expect(d.slug).toBe('detail');
    expect(d.sessions).toHaveLength(2);
    // Newest (s-beta, 06-02) first.
    expect(d.sessions[0].session_id).toBe('s-beta');
    expect(d.sessions[0].summary).toBe('Beta session summary');
    expect(d.sessions[0].ts).toBe('2026-06-02T10:00:00.000Z');
    expect(d.sessions[1].session_id).toBe('s-alpha');
  });

  it('getThread with a nonexistent slug returns thread_not_found', () => {
    const r = getThread('does-not-exist');
    expect(r).toEqual({ error: 'thread_not_found', slug: 'does-not-exist' });
  });
});
