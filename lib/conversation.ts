import { getDb } from '../db/client';
import { ftsPhrase } from './fts';
import { indexAsync, vecKnn, vecAvailable } from './vec';
import { embed } from './embedding';
import { rrfMerge } from './rrf';

const SESSION_GAP_MS = 2 * 60 * 60 * 1000; // 2 hours

export interface Turn {
  id: number;
  chat_id: string;
  session_id: string;
  role: 'user' | 'rheo';
  content: string;
  ts: string;
}

function resolveSessionId(
  chatId: string,
  now: Date,
): { sessionId: string; closedSessionId: string | null } {
  const db = getDb();
  const last = db
    .prepare(`SELECT ts, session_id FROM conversation WHERE chat_id = ? ORDER BY id DESC LIMIT 1`)
    .get(chatId) as { ts: string; session_id: string } | undefined;

  if (!last) {
    return { sessionId: now.toISOString().slice(0, 10), closedSessionId: null }; // first turn
  }
  const gap = now.getTime() - new Date(last.ts).getTime();
  if (gap > SESSION_GAP_MS) {
    return {
      sessionId: now.toISOString().slice(0, 16).replace('T', '-'), // new session: "YYYY-MM-DD-HH:MM"
      closedSessionId: last.session_id, // load-bearing for bot.py auto-trigger
    };
  }
  return { sessionId: last.session_id, closedSessionId: null };
}

// LogTurnResult extends Turn with the boundary signal. The bot reads
// boundary_closed_session_id to fire the digest daemon thread (FR-3).
export interface LogTurnResult extends Turn {
  boundary_closed_session_id: string | null;
}

export function logTurn(chatId: string, role: 'user' | 'rheo', content: string): LogTurnResult {
  const db = getDb();
  const now = new Date();
  const { sessionId, closedSessionId } = resolveSessionId(chatId, now);
  const ts = now.toISOString();

  const stmt = db.prepare(
    `INSERT INTO conversation (chat_id, session_id, role, content, ts) VALUES (?, ?, ?, ?, ?)`,
  );
  const result = stmt.run(chatId, sessionId, role, content, ts);

  // Fire-and-forget vec indexing AFTER the durable write (FR 4/5) — a failed embed never
  // fails the turn write. EMBED_INLINE=false defers embedding to the digest close
  // (deferred sweep in upsertDigest) — FR 4 / EC 7.
  if (process.env.EMBED_INLINE !== 'false') {
    indexAsync(getDb(), 'conversation_vec', result.lastInsertRowid as number, content);
  }

  return {
    id: result.lastInsertRowid as number,
    chat_id: chatId,
    session_id: sessionId,
    role,
    content,
    ts,
    boundary_closed_session_id: closedSessionId,
  };
}

export function getRecentTurns(chatId: string, n = 12): Turn[] {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT id, chat_id, session_id, role, content, ts
       FROM conversation WHERE chat_id = ?
       ORDER BY id DESC LIMIT ?`,
    )
    .all(chatId, n) as Turn[];
  return rows.reverse(); // chronological order for prompt building
}

export function getTurnsForSession(sessionId: string): Turn[] {
  const db = getDb();
  return db
    .prepare(
      `SELECT id, chat_id, session_id, role, content, ts
       FROM conversation WHERE session_id = ? ORDER BY id ASC`,
    )
    .all(sessionId) as Turn[];
}

// Sync overload — existing ≤3-arg call sites bind here, return type is Turn[] (unchanged).
export function searchTurns(q: string, chatId?: string, limit?: number): Turn[];
// Async overload — 4-arg callers with mode:'vector'|'hybrid' bind here.
export function searchTurns(
  q: string,
  chatId: string | undefined,
  limit: number,
  mode: 'vector' | 'hybrid',
): Promise<Turn[]>;
// Implementation.
export function searchTurns(
  q: string,
  chatId?: string,
  limit = 20,
  mode?: 'fts' | 'vector' | 'hybrid',
): Turn[] | Promise<Turn[]> {
  if (!mode || mode === 'fts') {
    // Existing FTS logic verbatim — do not change a character of this arm.
    const db = getDb();
    const phrase = ftsPhrase(q);
    if (chatId) {
      return db
        .prepare(
          `SELECT c.id, c.chat_id, c.session_id, c.role, c.content, c.ts
           FROM conversation_fts f
           JOIN conversation c ON c.rowid = f.rowid
           WHERE conversation_fts MATCH ? AND c.chat_id = ?
           ORDER BY rank LIMIT ?`,
        )
        .all(phrase, chatId, limit) as Turn[];
    }
    return db
      .prepare(
        `SELECT c.id, c.chat_id, c.session_id, c.role, c.content, c.ts
         FROM conversation_fts f
         JOIN conversation c ON c.rowid = f.rowid
         WHERE conversation_fts MATCH ?
         ORDER BY rank LIMIT ?`,
      )
      .all(phrase, limit) as Turn[];
  }

  // Async vector/hybrid path. The ENTIRE body sits in one try/catch — this promise never
  // rejects. ANY failure (embed, KNN, hydration, merge) degrades to [] with a log line,
  // same as the EC 1 embedder-unavailable case; never a 500 to the caller.
  return (async (): Promise<Turn[]> => {
    if (!vecAvailable()) return [];
    try {
      // Uniform over-fetch rule (W3): fetch k = min(limit * 4, 256), filter down to limit.
      const k = Math.min(limit * 4, 256);
      const f32 = await embed(q); // EC 1: embedder unavailable → caught below
      const hits = vecKnn(getDb(), 'conversation_vec', f32, k);
      if (hits.length === 0) return [];

      const ids = hits.map((h) => h.id as number);
      const placeholders = ids.map(() => '?').join(',');
      let rows = getDb()
        .prepare(
          `SELECT id, chat_id, session_id, role, content, ts
           FROM conversation WHERE id IN (${placeholders})`,
        )
        .all(...ids) as Turn[];

      // Apply chat_id filter (post-KNN — W3 uniform over-fetch compensates for filter drop).
      if (chatId) rows = rows.filter((r) => r.chat_id === chatId);

      // Re-sort to match KNN distance order (IN clause returns in arbitrary order).
      const rankMap = new Map(hits.map((h, i) => [h.id as number, i]));
      rows.sort((a, b) => (rankMap.get(a.id) ?? 0) - (rankMap.get(b.id) ?? 0));
      rows = rows.slice(0, limit);

      if (mode === 'vector') return rows;

      // Hybrid: merge fts + vector via RRF (FR 14).
      const ftsRows = searchTurns(q, chatId, limit); // binds to sync overload — no await
      return rrfMerge<Turn>([ftsRows, rows], { limit });
    } catch (err) {
      console.error('[MOT/conversation] searchTurns vector/hybrid degraded to []:', err);
      return [];
    }
  })();
}
