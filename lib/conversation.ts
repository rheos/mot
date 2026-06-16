import { getDb } from '../db/client';
import { ftsPhrase } from './fts';

const SESSION_GAP_MS = 2 * 60 * 60 * 1000; // 2 hours

export interface Turn {
  id: number;
  chat_id: string;
  session_id: string;
  role: 'user' | 'rheo';
  content: string;
  ts: string;
}

function resolveSessionId(chatId: string, now: Date): string {
  const db = getDb();
  const last = db
    .prepare(`SELECT ts, session_id FROM conversation WHERE chat_id = ? ORDER BY id DESC LIMIT 1`)
    .get(chatId) as { ts: string; session_id: string } | undefined;

  if (!last) return now.toISOString().slice(0, 10); // first turn: date as session id
  const gap = now.getTime() - new Date(last.ts).getTime();
  return gap > SESSION_GAP_MS
    ? now.toISOString().slice(0, 16).replace('T', '-') // new session: "YYYY-MM-DD-HH:MM"
    : last.session_id;
}

export function logTurn(chatId: string, role: 'user' | 'rheo', content: string): Turn {
  const db = getDb();
  const now = new Date();
  const sessionId = resolveSessionId(chatId, now);
  const ts = now.toISOString();

  const stmt = db.prepare(
    `INSERT INTO conversation (chat_id, session_id, role, content, ts) VALUES (?, ?, ?, ?, ?)`,
  );
  const result = stmt.run(chatId, sessionId, role, content, ts);

  return { id: result.lastInsertRowid as number, chat_id: chatId, session_id: sessionId, role, content, ts };
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

export function searchTurns(q: string, chatId?: string, limit = 20): Turn[] {
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
