// Recallatron Phase 3 — procedural notes (FR 1–5, FR 12–15, EC-8, AC-8, AC-14, OQ-5).
//
// Append-only "how Taylor works" notes with a supersede chain (superseded_by self-FK), mirroring
// memory_items. A candidate is always inserted unconfirmed (confirmed = 0); confirmation is a
// separate, explicit step. note_norm is the normalized form used for dedup/lookup. All queries
// use the synchronous better-sqlite3 API; every error return is a typed object, never a throw.

import { getDb } from '../db/client';
import { nowIso } from './time';

export interface ProceduralNote {
  id: number;
  category: string;
  note: string;
  note_norm: string;
  source_session_id: string;
  confirmed: number; // 0/1 — raw SQLite integer
  confirmed_at: string | null;
  superseded_by: number | null;
  mention_count: number;
  chat_id: string | null;
  created_at: string;
  ts: string;
}

// Insert a candidate note. Always unconfirmed (confirmed = 0, confirmed_at = NULL,
// mention_count = 1) — AC-8: this path never confirms. On a note_norm collision it skips
// (OQ-5 resolution: skip; do NOT bump mention_count in v1) and logs a dedup warning.
export function insertCandidate(
  category: string,
  note: string,
  sourceSessionId: string,
  chatId?: string,
): ProceduralNote | { error: 'duplicate_skipped'; note_norm: string } {
  const db = getDb();
  const noteNorm = note.trim().toLowerCase();

  // note_norm dedup is intentionally cross-category — the same note text in different categories
  // is treated as a duplicate (OQ-5). This is by design; do not add category to the key.
  const dup = db
    .prepare(`SELECT id FROM procedural_notes WHERE note_norm = ?`)
    .get(noteNorm) as { id: number } | undefined;
  if (dup) {
    console.warn(`[MOT/procedural] dedup-skip: note_norm already exists (id=${dup.id})`);
    return { error: 'duplicate_skipped', note_norm: noteNorm };
  }

  const ts = nowIso();
  const ins = db
    .prepare(
      `INSERT INTO procedural_notes
         (category, note, note_norm, source_session_id, confirmed, confirmed_at,
          superseded_by, mention_count, chat_id, created_at, ts)
       VALUES (?, ?, ?, ?, 0, NULL, NULL, 1, ?, ?, ?)`,
    )
    .run(category, note, noteNorm, sourceSessionId, chatId ?? null, ts, ts);

  return db
    .prepare(`SELECT * FROM procedural_notes WHERE id = ?`)
    .get(ins.lastInsertRowid) as ProceduralNote;
}

// List notes, excluding superseded rows. pending=true ⇒ unconfirmed, returned as a flat array.
// pending=false (default) ⇒ confirmed, grouped by category as Record<category, notes[]>. An
// optional category filter applies to both modes.
export function listNotes(
  category?: string,
  pending = false,
): ProceduralNote[] | Record<string, ProceduralNote[]> {
  const db = getDb();
  const confirmed = pending ? 0 : 1;

  const params: (string | number)[] = [confirmed];
  let sql = `SELECT * FROM procedural_notes WHERE confirmed = ? AND superseded_by IS NULL`;
  if (category !== undefined) {
    sql += ` AND category = ?`;
    params.push(category);
  }
  sql += ` ORDER BY ts DESC`;

  const rows = db.prepare(sql).all(...params) as ProceduralNote[];

  if (pending) {
    return rows;
  }

  // Group confirmed rows by category.
  const grouped: Record<string, ProceduralNote[]> = {};
  for (const row of rows) {
    (grouped[row.category] ??= []).push(row);
  }
  return grouped;
}

// Confirm a candidate note: sets confirmed = 1 and confirmed_at = now. Refuses if the row is
// missing, already confirmed, or superseded (EC-8, AC-14 — a superseded note can't be confirmed;
// the caller is pointed at the current row via current_id).
export function confirmNote(
  id: number,
): ProceduralNote | { error: string; [k: string]: unknown } {
  const db = getDb();

  const row = db
    .prepare(`SELECT * FROM procedural_notes WHERE id = ?`)
    .get(id) as ProceduralNote | undefined;
  if (!row) {
    return { error: 'not_found' };
  }
  if (row.confirmed === 1) {
    return { error: 'already_confirmed' };
  }
  if (row.superseded_by !== null) {
    return { error: 'superseded', current_id: row.superseded_by };
  }

  db.prepare(
    `UPDATE procedural_notes SET confirmed = 1, confirmed_at = ? WHERE id = ?`,
  ).run(nowIso(), id);

  return db
    .prepare(`SELECT * FROM procedural_notes WHERE id = ?`)
    .get(id) as ProceduralNote;
}
