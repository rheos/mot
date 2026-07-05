// Track 1 limitation: conflict detection uses normalized label match only
// (label_norm = lower(trim(label))). No semantic/token similarity.
// Two facts about the same entity with different label wording (e.g. "Alex" vs
// "Alex Goodwin") are stored as independent facts. Track 2 concern.

import { getDb } from '../db/client';
import { nowIso } from './time';
import { ftsPhrase } from './fts';
import { indexAsync, vecDelete } from './vec';

export type MemoryType = 'fact' | 'preference' | 'deadline' | 'person';

export interface WriteMemoryInput {
  type: MemoryType;
  content: { label: string; properties: Record<string, unknown> };
  source_turn_id: number;
  source_session_id: string;
  confidence: number;
  reason: string;
  // chat_id is deliberately absent — it is derived server-side from source_turn_id (FR-8, FR-10).
}

export interface MemoryRow {
  id: number;
  type: MemoryType;
  label: string;
  label_norm: string;
  properties: string; // JSON text — better-sqlite3 does not auto-parse
  chat_id: string;
  source_turn_id: number;
  source_session_id: string;
  confidence: number;
  reason: string;
  ts: string;
  superseded_by: number | null;
  conflict_flag: number; // 0/1 — raw SQLite integer
  version: number;
}

export type WriteMemoryResult =
  | MemoryRow
  | {
      conflict: true;
      new: MemoryRow;
      superseded: { id: number; label: string; properties: string };
    }
  | { error: string; source_turn_id?: number; confidence?: number };

// ── Pure helpers ──────────────────────────────────────────────────────────────

// Pure recursive deep equality on plain objects/arrays/scalars.
// Even when equal, writeMemory still inserts a new row — the table is append-only.
export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null || typeof a !== typeof b) return false;
  if (typeof a !== 'object') return false;

  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    return a.every((v, i) => deepEqual(v, (b as unknown[])[i]));
  }

  const aObj = a as Record<string, unknown>;
  const bObj = b as Record<string, unknown>;
  const aKeys = Object.keys(aObj);
  const bKeys = Object.keys(bObj);
  if (aKeys.length !== bKeys.length) return false;
  return aKeys.every((k) => Object.prototype.hasOwnProperty.call(bObj, k) && deepEqual(aObj[k], bObj[k]));
}

// Returns true if `a` and `b` share at least one key whose values are both
// non-null scalars (string/number/boolean) that differ — a direct contradiction
// on the same attribute. Used only when both confidences are ≥ 0.8.
export function sharedKeyScalarContradiction(
  a: Record<string, unknown>,
  b: Record<string, unknown>,
): boolean {
  const isScalar = (v: unknown): v is string | number | boolean =>
    v !== null && v !== undefined && (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean');

  for (const key of Object.keys(a)) {
    if (!Object.prototype.hasOwnProperty.call(b, key)) continue;
    const av = a[key];
    const bv = b[key];
    if (isScalar(av) && isScalar(bv) && av !== bv) return true;
  }
  return false;
}

// ── Write path ────────────────────────────────────────────────────────────────

export function writeMemory(input: WriteMemoryInput): WriteMemoryResult {
  // 1. Confidence range (belt-and-suspenders with the Zod schema at the API boundary).
  if (input.confidence < 0 || input.confidence > 1) {
    return { error: 'confidence must be between 0 and 1', confidence: input.confidence };
  }

  const db = getDb();

  // 2. FK check + server-side chat_id derivation (FR-8, FR-10, EC-2).
  //    The FK lookup validates source_turn_id AND yields chat_id in one query.
  const sourceRow = db
    .prepare(`SELECT id, chat_id FROM conversation WHERE id = ?`)
    .get(input.source_turn_id) as { id: number; chat_id: string } | undefined;

  if (!sourceRow) {
    return { error: 'source_turn_id not found', source_turn_id: input.source_turn_id };
  }

  // chat_id is never taken from caller input.
  const chatId = sourceRow.chat_id;

  // Closure slots the transaction callback fills; read AFTER the transaction commits so the
  // fire-and-forget vec ops reflect committed state only (better-sqlite3 transactions are
  // synchronous, so a throw inside rolls back AND skips the vec block below).
  let newItemId: number | null = null;
  let supersededItemId: number | null = null;

  // Steps 3–7 run inside a transaction so insert + superseded_by back-fill are atomic.
  const result = db.transaction((): WriteMemoryResult => {
    // 3. Normalize label.
    const labelNorm = input.content.label.trim().toLowerCase();
    const propertiesJson = JSON.stringify(input.content.properties);
    const ts = nowIso();

    // 4. Look up the current (active) row for this (type, label_norm, chat_id).
    //    Uses idx_memory_lookup on (type, label_norm, superseded_by).
    const current = db
      .prepare(
        `SELECT * FROM memory_items
         WHERE type = ? AND label_norm = ? AND chat_id = ? AND superseded_by IS NULL`,
      )
      .get(input.type, labelNorm, chatId) as MemoryRow | undefined;

    if (!current) {
      // 5. No prior row — plain insert at version 1.
      const ins = db
        .prepare(
          `INSERT INTO memory_items
             (type, label, label_norm, properties, chat_id, source_turn_id, source_session_id,
              confidence, reason, ts, superseded_by, conflict_flag, version)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 0, 1)`,
        )
        .run(
          input.type,
          input.content.label,
          labelNorm,
          propertiesJson,
          chatId,
          input.source_turn_id,
          input.source_session_id,
          input.confidence,
          input.reason,
          ts,
        );
      newItemId = ins.lastInsertRowid as number;
      return db
        .prepare(`SELECT * FROM memory_items WHERE id = ?`)
        .get(ins.lastInsertRowid) as MemoryRow;
    }

    // 6. Current row exists — two-case append-only logic (FR-11).
    //    Neither case mutates the old row's properties.
    const oldProps = JSON.parse(current.properties) as Record<string, unknown>;
    const newProps = input.content.properties;

    const isContradiction =
      input.confidence >= 0.8 &&
      current.confidence >= 0.8 &&
      !deepEqual(oldProps, newProps) &&
      sharedKeyScalarContradiction(oldProps, newProps);

    const conflictFlag = isContradiction ? 1 : 0;
    const newVersion = current.version + 1;

    // Insert the new row (always; no in-place update).
    const ins = db
      .prepare(
        `INSERT INTO memory_items
           (type, label, label_norm, properties, chat_id, source_turn_id, source_session_id,
            confidence, reason, ts, superseded_by, conflict_flag, version)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
      )
      .run(
        input.type,
        input.content.label,
        labelNorm,
        propertiesJson,
        chatId,
        input.source_turn_id,
        input.source_session_id,
        input.confidence,
        input.reason,
        ts,
        conflictFlag,
        newVersion,
      );

    const newId = ins.lastInsertRowid as number;
    newItemId = newId;

    // Set old row's superseded_by — the only mutation allowed on an existing row.
    db.prepare(`UPDATE memory_items SET superseded_by = ? WHERE id = ?`).run(newId, current.id);
    supersededItemId = current.id;

    const newRow = db
      .prepare(`SELECT * FROM memory_items WHERE id = ?`)
      .get(newId) as MemoryRow;

    if (isContradiction) {
      return {
        conflict: true as const,
        new: newRow,
        superseded: {
          id: current.id,
          label: current.label,
          properties: current.properties,
        },
      };
    }

    return newRow;
  })();

  // Fire-and-forget vec ops for this write (FR 4–6, W3).
  if (newItemId !== null) {
    indexAsync(getDb(), 'memory_items_vec', newItemId, input.content.label + ' ' + input.reason);
  }
  if (supersededItemId !== null) {
    // Delete the superseded row's vec entry (W3 — prevents unbounded orphan accumulation).
    // `!` is safe: the guard above narrows, but TS drops the narrowing inside the closure.
    void Promise.resolve()
      .then(() => vecDelete(getDb(), 'memory_items_vec', supersededItemId!))
      .catch((err) => console.error('[MOT/vec] memory supersede vec-delete error:', err));
  }

  return result;
}

// ── Read path ─────────────────────────────────────────────────────────────────

// Return active memory items — rows where superseded_by IS NULL AND conflict_flag = 0.
// Conflicted items (conflict_flag = 1) are intentionally excluded; they are not settled
// truth for boot injection and remain queryable on demand via memory_recent.
//
// chatId is optional: when provided, scopes to that chat (uses idx_memory_chat_active);
// when omitted, returns all active items across chats (A-7 single-user fallback for
// the memory_recent MCP tool's no-chat_id invocation).
export function getActiveMemory(chatId?: string, limit = 20): MemoryRow[] {
  const db = getDb();

  if (chatId !== undefined) {
    return db
      .prepare(
        `SELECT * FROM memory_items
         WHERE conflict_flag = 0 AND superseded_by IS NULL AND chat_id = ?
         ORDER BY ts DESC LIMIT ?`,
      )
      .all(chatId, limit) as MemoryRow[];
  }

  // No chatId predicate — all active items.
  return db
    .prepare(
      `SELECT * FROM memory_items
       WHERE conflict_flag = 0 AND superseded_by IS NULL
       ORDER BY ts DESC LIMIT ?`,
    )
    .all(limit) as MemoryRow[];
}

// FTS5 keyword search over active memory items (Track-2 — the `q` arm of memory_recent).
// Same active-only filter as getActiveMemory (conflict_flag = 0 AND superseded_by IS NULL),
// but ranked by FTS5 relevance instead of recency. Empty/whitespace q returns [] — an empty
// MATCH string is not a useful query and FTS5 rejects it, so the caller's no-q path
// (getActiveMemory) owns the "return everything" behavior.
//
// memory_items_fts is the external-content index (rowid = memory_items.id, db/memory_fts.sql);
// JOIN it back to memory_items to read the full row. ftsPhrase wraps q as a quoted phrase so
// hyphens/apostrophes don't trip the FTS5 query grammar (same as searchTurns in conversation.ts).
export function searchActiveMemory(q: string, chatId?: string, limit = 20): MemoryRow[] {
  if (q.trim() === '') return [];

  const db = getDb();
  const phrase = ftsPhrase(q);

  if (chatId !== undefined) {
    return db
      .prepare(
        `SELECT memory_items.* FROM memory_items
         JOIN memory_items_fts ON memory_items_fts.rowid = memory_items.id
         WHERE memory_items_fts MATCH ?
           AND conflict_flag = 0 AND superseded_by IS NULL
           AND memory_items.chat_id = ?
         ORDER BY rank LIMIT ?`,
      )
      .all(phrase, chatId, limit) as MemoryRow[];
  }

  return db
    .prepare(
      `SELECT memory_items.* FROM memory_items
       JOIN memory_items_fts ON memory_items_fts.rowid = memory_items.id
       WHERE memory_items_fts MATCH ?
         AND conflict_flag = 0 AND superseded_by IS NULL
       ORDER BY rank LIMIT ?`,
    )
    .all(phrase, limit) as MemoryRow[];
}
