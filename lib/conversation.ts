import { getDb } from '../db/client';
import { ftsPhrase } from './fts';
import { indexAsync, vecKnn, vecAvailable } from './vec';
import { embed, embeddingEnabled } from './embedding';
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
): { sessionId: string; closedSessionId: string | null; prevContent: string | null } {
  const db = getDb();
  // `content` rides along on a query this function already makes, so adjacency enrichment adds
  // NO read to the logTurn hot path (the inline-embed p95 budget is ~300ms before EMBED_INLINE
  // is worth flipping — see CLAUDE.local.md).
  const last = db
    .prepare(
      `SELECT ts, session_id, content FROM conversation WHERE chat_id = ? ORDER BY id DESC LIMIT 1`,
    )
    .get(chatId) as { ts: string; session_id: string; content: string } | undefined;

  if (!last) {
    // First turn ever for this chat: nothing precedes it.
    return { sessionId: now.toISOString().slice(0, 10), closedSessionId: null, prevContent: null };
  }
  const gap = now.getTime() - new Date(last.ts).getTime();
  if (gap > SESSION_GAP_MS) {
    return {
      sessionId: now.toISOString().slice(0, 16).replace('T', '-'), // new session: "YYYY-MM-DD-HH:MM"
      closedSessionId: last.session_id, // load-bearing for bot.py auto-trigger
      // Session boundary: the previous turn is >2h old and about a different thing. Enriching
      // across it would pull unrelated context into this turn's vector, which is worse than
      // leaving a short turn bare.
      prevContent: null,
    };
  }
  return { sessionId: last.session_id, closedSessionId: null, prevContent: last.content };
}

// LogTurnResult extends Turn with the boundary signal. The bot reads
// boundary_closed_session_id to fire the digest daemon thread (FR-3).
export interface LogTurnResult extends Turn {
  boundary_closed_session_id: string | null;
}

export function logTurn(chatId: string, role: 'user' | 'rheo', content: string): LogTurnResult {
  const db = getDb();
  const now = new Date();
  const { sessionId, closedSessionId, prevContent } = resolveSessionId(chatId, now);
  const ts = now.toISOString();

  const stmt = db.prepare(
    `INSERT INTO conversation (chat_id, session_id, role, content, ts) VALUES (?, ?, ?, ?, ?)`,
  );
  const result = stmt.run(chatId, sessionId, role, content, ts);

  // Fire-and-forget vec indexing AFTER the durable write (FR 4/5) — a failed embed never
  // fails the turn write. EMBED_INLINE=false defers embedding to the digest close
  // (deferred sweep in upsertDigest) — FR 4 / EC 7.
  if (process.env.EMBED_INLINE !== 'false') {
    indexAsync(getDb(), 'conversation_vec', result.lastInsertRowid as number, content, {
      prevText: prevContent,
    });
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

  // Async vector/hybrid path. Each arm carries its OWN guard, so this promise NEVER
  // rejects (the 45f16fe never-reject guarantee, split per arm for the ratified
  // FTS-fallback contract):
  //   - vector arm → [] on ANY degrade: empty/whitespace q (no embed call), extension or
  //     embedder unavailable (silent), embed/KNN/hydration throw (logged).
  //   - hybrid → the plain fts-arm list whenever the vector arm degrades or has no hits
  //     (FTS-fallback, NOT []); [] with a log line only if the fts arm ITSELF throws.
  return (async (): Promise<Turn[]> => {
    // ── Vector arm ──
    let vectorRows: Turn[] = [];
    if (q.trim() !== '' && vecAvailable() && embeddingEnabled()) {
      try {
        // Uniform over-fetch rule (W3): fetch k = min(limit * 4, 256), filter down to limit.
        const k = Math.min(limit * 4, 256);
        const f32 = await embed(q); // EC 1: embedder init failure → caught below
        const hits = vecKnn(getDb(), 'conversation_vec', f32, k);
        if (hits.length > 0) {
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
          vectorRows = rows.slice(0, limit);
        }
      } catch (err) {
        console.error('[MOT/conversation] searchTurns vector arm degraded to []:', err);
        vectorRows = [];
      }
    }

    if (mode === 'vector') return vectorRows;

    // ── Hybrid: fts arm under its own guard ──
    let ftsRows: Turn[];
    try {
      ftsRows = searchTurns(q, chatId, limit); // binds to sync overload — no await
    } catch (err) {
      console.error('[MOT/conversation] searchTurns hybrid fts arm degraded to []:', err);
      return [];
    }

    // FTS-fallback: a degraded/empty vector arm yields exactly the mode:'fts' result
    // (already truncated to `limit` by the sync arm's SQL LIMIT).
    if (vectorRows.length === 0) return ftsRows;

    // Both arms live: merge via RRF (FR 14).
    return rrfMerge<Turn>([ftsRows, vectorRows], { limit });
  })();
}
