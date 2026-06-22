// Recallatron Phase 3 — topic threads (FR 1–5, FR 12–15, EC-2, EC-7, AC-2, AC-11, A-4, A-5).
//
// A topic thread is a human-readable grouping of sessions under a slug. topic_thread_session
// is the many-to-many join to session_digest (keyed on session_digest.session_id — the UNIQUE
// column, not the autoincrement PK). All queries use the synchronous better-sqlite3 API.
// Every error return is a typed object — these functions never throw; the MCP layer (Prompt 5)
// branches on the shape.

import { getDb } from '../db/client';
import { nowIso } from './time';

const SLUG_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

export interface TopicThread {
  slug: string;
  title: string;
  notes: string | null;
  created_at: string;
  last_active_at: string;
}

export interface TopicThreadWithCount extends TopicThread {
  session_count: number;
}

export interface ThreadDetail extends TopicThread {
  sessions: { session_id: string; summary: string; ts: string }[];
}

// Create a thread. Returns the new row, or a typed error for an invalid slug (EC bad-input)
// or a slug collision (EC-2 — carries the existing row so the caller can show it).
export function createThread(
  slug: string,
  title: string,
  notes?: string,
):
  | TopicThread
  | { error: 'slug_exists'; existing: TopicThread }
  | { error: 'invalid_slug'; slug: string } {
  if (!SLUG_RE.test(slug)) {
    return { error: 'invalid_slug', slug };
  }

  const db = getDb();

  const existing = db
    .prepare(`SELECT * FROM topic_thread WHERE slug = ?`)
    .get(slug) as TopicThread | undefined;
  if (existing) {
    return { error: 'slug_exists', existing };
  }

  const now = nowIso();
  db.prepare(
    `INSERT INTO topic_thread (slug, title, notes, created_at, last_active_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(slug, title, notes ?? null, now, now);

  return db
    .prepare(`SELECT * FROM topic_thread WHERE slug = ?`)
    .get(slug) as TopicThread;
}

// Link a session to a thread. Idempotent (AC-11): the join row is INSERT OR IGNORE, so
// re-linking the same pair is a no-op and never inserts a duplicate. Validates both ends
// first (thread must exist; session_id must exist in session_digest — EC-7). Bumps the
// thread's last_active_at on every successful call.
export function linkThreadSession(
  slug: string,
  session_id: string,
): { ok: true } | { error: string; [k: string]: unknown } {
  const db = getDb();

  const thread = db
    .prepare(`SELECT slug FROM topic_thread WHERE slug = ?`)
    .get(slug) as { slug: string } | undefined;
  if (!thread) {
    return { error: 'thread_not_found', slug };
  }

  const session = db
    .prepare(`SELECT session_id FROM session_digest WHERE session_id = ?`)
    .get(session_id) as { session_id: string } | undefined;
  if (!session) {
    return { error: 'session_not_found', session_id };
  }

  const now = nowIso();
  return db.transaction((): { ok: true } => {
    db.prepare(
      `INSERT OR IGNORE INTO topic_thread_session (slug, session_id, added_at)
       VALUES (?, ?, ?)`,
    ).run(slug, session_id, now);
    db.prepare(`UPDATE topic_thread SET last_active_at = ? WHERE slug = ?`).run(now, slug);
    return { ok: true };
  })();
}

// All threads with their linked-session count, most-recently-active first. The count is a
// correlated subquery so a thread with zero sessions still appears (count 0).
export function listThreads(): TopicThreadWithCount[] {
  return getDb()
    .prepare(
      `SELECT t.*,
              (SELECT count(*) FROM topic_thread_session s WHERE s.slug = t.slug) AS session_count
       FROM topic_thread t
       ORDER BY t.last_active_at DESC`,
    )
    .all() as TopicThreadWithCount[];
}

// One thread plus all its linked sessions, newest session first. The session list JOINs the
// join table to session_digest and selects its real columns (summary, ts), ordered by
// session_digest.ts DESC.
export function getThread(
  slug: string,
): ThreadDetail | { error: 'thread_not_found'; slug: string } {
  const db = getDb();

  const thread = db
    .prepare(`SELECT * FROM topic_thread WHERE slug = ?`)
    .get(slug) as TopicThread | undefined;
  if (!thread) {
    return { error: 'thread_not_found', slug };
  }

  // session_digest's summary column is named `summary` and its timestamp is `ts` (db/schema.ts).
  const sessions = db
    .prepare(
      `SELECT d.session_id AS session_id, d.summary AS summary, d.ts AS ts
       FROM topic_thread_session s
       JOIN session_digest d ON d.session_id = s.session_id
       WHERE s.slug = ?
       ORDER BY d.ts DESC`,
    )
    .all(slug) as { session_id: string; summary: string; ts: string }[];

  return { ...thread, sessions };
}
