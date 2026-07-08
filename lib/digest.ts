import { getDb } from '../db/client';
import { nowIso } from './time';
import { getTurnsForSession } from './conversation';
import { vecReplace, vecInsert, vecAvailable } from './vec';
import { embed, embeddingEnabled } from './embedding';

export interface DigestPayload {
  session_id: string;
  chat_id: string;
  summary: string;
  turn_count: number;
  topics?: string | null;        // comma-separated; reserved/unpopulated at Track 1
  entity_draft?: string | null;  // JSON text; null on structural or parse-error path
  procedural_raw?: string | null; // JSON text; null on structural or parse-error path
  relation_draft?: string | null; // JSON text; null on structural or parse-error path
  parse_error?: boolean;
}

export interface DigestRow {
  id: number;
  session_id: string;
  chat_id: string;
  summary: string;
  ts: string;
  topics: string | null;
  entity_draft: string | null;
  procedural_raw: string | null;
  relation_draft: string | null;
  parse_error: number; // 0/1 — better-sqlite3 raw integer, not Drizzle-coerced boolean
  turn_count: number;
}

// Upsert a session digest. One row per session_id — ON CONFLICT updates in place.
// Sets ts = nowIso() on every write so re-runs of the digest update the timestamp.
export function upsertDigest(payload: DigestPayload): DigestRow {
  const db = getDb();
  const ts = nowIso();

  db.prepare(
    `INSERT INTO session_digest
       (session_id, chat_id, summary, ts, topics, entity_draft, procedural_raw, relation_draft, parse_error, turn_count)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(session_id) DO UPDATE SET
       summary        = excluded.summary,
       ts             = excluded.ts,
       topics         = excluded.topics,
       entity_draft   = excluded.entity_draft,
       procedural_raw = excluded.procedural_raw,
       relation_draft = excluded.relation_draft,
       parse_error    = excluded.parse_error,
       turn_count     = excluded.turn_count`,
  ).run(
    payload.session_id,
    payload.chat_id,
    payload.summary,
    ts,
    payload.topics ?? null,
    payload.entity_draft ?? null,
    payload.procedural_raw ?? null,
    payload.relation_draft ?? null,
    payload.parse_error ? 1 : 0,
    payload.turn_count,
  );

  // a. Fire-and-forget re-index of the digest summary (vecReplace: idempotent on re-digest, FR 8).
  //    Gate on embeddingEnabled() AND vecAvailable() — the same double gate indexAsync applies.
  //    Without the embeddingEnabled() gate, every digest in the embed-off test suite would fire
  //    a caught-but-noisy embed() throw and break the single-choke-point invariant (W1).
  if (embeddingEnabled() && vecAvailable()) {
    embed(payload.summary)
      .then((f32) => vecReplace(getDb(), 'session_digest_vec', payload.session_id, f32))
      .catch((err) => console.error('[MOT/vec] digest vec-replace error:', err));
  }

  // b. Deferred conversation sweep (AC 13, W2): when EMBED_INLINE is disabled, back-fill
  //    conversation_vec for every turn of this session that was not embedded inline.
  //    upsertDigest is the shared session-close choke point — it is called by BOTH the
  //    bot's POST /api/conversation/digest route AND structuralDigest (MCP summarize_and_archive
  //    dispatched at lib/mcp-tools.ts), so both paths get the sweep here.
  //    Same double gate as (a): embeddingEnabled() AND vecAvailable().
  if (process.env.EMBED_INLINE === 'false' && embeddingEnabled() && vecAvailable()) {
    const sessionTurns = getTurnsForSession(payload.session_id);
    if (sessionTurns.length > 0) {
      // Find which turn IDs are not yet in conversation_vec.
      const placeholders = sessionTurns.map(() => '?').join(',');
      const embeddedIds = new Set(
        (db.prepare(`SELECT turn_id FROM conversation_vec WHERE turn_id IN (${placeholders})`)
          .all(...sessionTurns.map((t) => t.id)) as { turn_id: number }[])
          .map((r) => r.turn_id)
      );
      const unembedded = sessionTurns.filter((t) => !embeddedIds.has(t.id));
      // Fire-and-forget embed for each unembedded turn.
      void Promise.allSettled(
        unembedded.map((t) =>
          embed(t.content)
            .then((f32) => vecInsert(db, 'conversation_vec', t.id, f32))
            .catch((err) => console.error('[MOT/vec] deferred sweep error:', err))
        )
      );
    }
  }

  return db
    .prepare(`SELECT * FROM session_digest WHERE session_id = ?`)
    .get(payload.session_id) as DigestRow;
}

// Return up to n digests for a chat, newest first. Returns [] when none.
export function getDigests(chatId: string, n: number): DigestRow[] {
  const db = getDb();
  return db
    .prepare(
      `SELECT * FROM session_digest WHERE chat_id = ? ORDER BY ts DESC LIMIT ?`,
    )
    .all(chatId, n) as DigestRow[];
}

function formatTimeSpan(ms: number): string {
  if (ms < 60_000) return 'under 1m';
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remaining = minutes % 60;
  return remaining > 0 ? `${hours}h ${remaining}m` : `${hours}h`;
}

// Produce a deterministic, non-LLM structural digest for a session (FR-2b).
// Does NOT call claude -p — MCP tools cannot nest a subprocess.
// Returns the stored DigestRow, or an error object if the session has no turns.
export function structuralDigest(
  sessionId: string,
): DigestRow | { error: string; session_id: string } {
  const turns = getTurnsForSession(sessionId);

  if (turns.length === 0) {
    return { error: 'no turns found for session', session_id: sessionId };
  }

  const chatId = turns[0].chat_id;
  const turnCount = turns.length;

  const firstTs = new Date(turns[0].ts).getTime();
  const lastTs  = new Date(turns[turns.length - 1].ts).getTime();
  const spanStr = lastTs > firstTs ? formatTimeSpan(lastTs - firstTs) : 'single turn';

  const firstSnippet = turns[0].content.slice(0, 80);
  const lastSnippet  = turns[turns.length - 1].content.slice(0, 80);

  const userCount = turns.filter((t) => t.role === 'user').length;
  const rheoCount = turns.filter((t) => t.role === 'rheo').length;

  const summary =
    `${turnCount} turns over ${spanStr}. ` +
    `First: "${firstSnippet}…" Last: "${lastSnippet}…" (${userCount}u/${rheoCount}r)`;

  return upsertDigest({
    session_id:     sessionId,
    chat_id:        chatId,
    summary,
    turn_count:     turnCount,
    entity_draft:   null,
    procedural_raw: null,
    parse_error:    false,
  });
}
