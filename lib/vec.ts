// Track 5, Phase 1 — the sqlite-vec (vec0) table helpers (server-only; never imported by
// Edge routes). All four vec tables share the same INSERT/DELETE/KNN shape; this module is
// the single place that knows the sqlite-vec bind quirks so no caller has to.

import type Database from 'better-sqlite3';
import { getLoadablePath } from 'sqlite-vec';
import { embed, embeddingEnabled } from './embedding';

type DB = Database.Database;

// Module-level availability flag. Starts true; loadVecExtension flips it false if the
// extension can't load (dev/test degrade path). Callers gate on vecAvailable() before
// touching a vec table.
let _vecAvailable = true;
export function vecAvailable(): boolean {
  return _vecAvailable;
}

// Each vec table's INTEGER/TEXT primary-key column. INTEGER-PK: conversation_vec.turn_id,
// memory_items_vec.item_id. TEXT-PK: entity_vec.entity_id, session_digest_vec.session_id.
const ID_COLS: Record<string, string> = {
  conversation_vec: 'turn_id',
  memory_items_vec: 'item_id',
  entity_vec: 'entity_id',
  session_digest_vec: 'session_id',
};

function idColForTable(table: string): string {
  const col = ID_COLS[table];
  if (col === undefined) throw new Error(`[MOT/vec] unknown vec table: ${table}`);
  return col;
}

export function loadVecExtension(db: DB): void {
  try {
    // getLoadablePath() THROWS on an unsupported platform (never returns null), so it must
    // sit inside the try — the SQLITE_VEC_PATH override lets prod pin an explicit path.
    const p = process.env.SQLITE_VEC_PATH ?? getLoadablePath();
    db.loadExtension(p);
  } catch (err) {
    console.error('[MOT/vec] failed to load sqlite-vec extension:', (err as Error).message);
    _vecAvailable = false;
    // FR 1: dev/test log + degrade; prod fails fast.
    if (process.env.NODE_ENV === 'production') throw err;
  }
}

export function f32ToBlob(f32: Float32Array): Buffer {
  // vec0 accepts a raw float32 BLOB of exactly dim*4 bytes; Buffer binds as BLOB in
  // better-sqlite3. Slice to the view's own window in case of a subarray.
  return Buffer.from(f32.buffer, f32.byteOffset, f32.byteLength);
}

export function vecInsert(db: DB, table: string, id: number | string, f32: Float32Array): void {
  // vec0 INTEGER-PK bind trap: a plain JS number fails with "Only integers are allows for
  // primary key values". Coerce numbers to BigInt; TEXT-PK strings bind fine as-is.
  const key = typeof id === 'number' ? BigInt(id) : id;
  db.prepare(`INSERT INTO ${table}(${idColForTable(table)}, embedding) VALUES (?, ?)`).run(
    key,
    f32ToBlob(f32),
  );
}

export function vecReplace(db: DB, table: string, id: number | string, f32: Float32Array): void {
  // DELETE-then-INSERT (portable across sqlite-vec versions; handles the re-digest EC 5 /
  // FR 8 case). DELETE-by-id accepts a plain number, so no coercion here.
  db.prepare(`DELETE FROM ${table} WHERE ${idColForTable(table)} = ?`).run(id);
  vecInsert(db, table, id, f32);
}

export function vecDelete(db: DB, table: string, id: number | string): void {
  db.prepare(`DELETE FROM ${table} WHERE ${idColForTable(table)} = ?`).run(id);
}

export function vecKnn(
  db: DB,
  table: string,
  queryF32: Float32Array,
  k: number,
): { id: number | string; distance: number }[] {
  // The `AS id` alias is LOAD-BEARING: without it the row property is named per the table's
  // id column and h.id would be undefined at runtime while typecheck stays green. k binds as
  // a plain number. vec0 KNN on an empty table returns [] without error (EC 3).
  return db
    .prepare(
      `SELECT ${idColForTable(table)} AS id, distance FROM ${table} WHERE embedding MATCH ? AND k = ?`,
    )
    .all(f32ToBlob(queryF32), k) as { id: number | string; distance: number }[];
}

export function indexAsync(db: DB, table: string, id: number | string, text: string): void {
  // Fire-and-forget: start a Promise, never await it. The embeddingEnabled() gate is the
  // single choke point that disables all four write paths during testing (W1).
  if (!embeddingEnabled()) return;
  embed(text)
    .then((f32) => vecInsert(db, table, id, f32))
    .catch((err) => console.error('[MOT/vec] indexAsync error:', err));
}
