// Track 5, Phase 1 — the sqlite-vec (vec0) table helpers (server-only; never imported by
// Edge routes). All four vec tables share the same INSERT/DELETE/KNN shape; this module is
// the single place that knows the sqlite-vec bind quirks so no caller has to.

import type Database from 'better-sqlite3';
import { getLoadablePath } from 'sqlite-vec';
import { embed, embeddingEnabled } from './embedding';
import { EMBED_VERSION, IMPLICIT_EMBED_VERSION, buildEmbedText } from './embed-input';

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

export function vecInsert(
  db: DB,
  table: string,
  id: number | string,
  f32: Float32Array,
  embedVersion: number = EMBED_VERSION,
): void {
  // vec0 INTEGER-PK bind trap: a plain JS number fails with "Only integers are allows for
  // primary key values". Coerce numbers to BigInt; TEXT-PK strings bind fine as-is.
  const key = typeof id === 'number' ? BigInt(id) : id;
  // One transaction: a vector without its version stamp reads as representation 1 and would be
  // re-embedded forever; a stamp without its vector is a phantom the coverage query counts.
  db.transaction(() => {
    db.prepare(`INSERT INTO ${table}(${idColForTable(table)}, embedding) VALUES (?, ?)`).run(
      key,
      f32ToBlob(f32),
    );
    vecMetaSet(db, table, id, embedVersion);
  })();
}

// row_id is TEXT so one table serves both the INTEGER-PK and TEXT-PK vec stores. Always go
// through String(id) on read AND write — a number key written as 7 and read back as '7' would
// silently miss.
export function vecMetaSet(
  db: DB,
  table: string,
  id: number | string,
  embedVersion: number,
): void {
  db.prepare(
    `INSERT INTO vec_meta(table_name, row_id, embed_version) VALUES (?, ?, ?)
     ON CONFLICT(table_name, row_id) DO UPDATE SET embed_version = excluded.embed_version`,
  ).run(table, String(id), embedVersion);
}

/**
 * Row ids in `table` whose stored representation is not the current EMBED_VERSION, including
 * every row with no vec_meta entry at all (those predate the stamp — see 0010).
 */
export function vecStaleIds(db: DB, table: string): Set<string> {
  const rows = db
    .prepare(
      `SELECT CAST(v.${idColForTable(table)} AS TEXT) AS id
         FROM ${table} v
         LEFT JOIN vec_meta m ON m.table_name = ? AND m.row_id = CAST(v.${idColForTable(table)} AS TEXT)
        WHERE COALESCE(m.embed_version, ?) != ?`,
    )
    .all(table, IMPLICIT_EMBED_VERSION, EMBED_VERSION) as { id: string }[];
  return new Set(rows.map((r) => r.id));
}

/**
 * Fraction of `table`'s vectors already at the current EMBED_VERSION, 0..1. An empty table is 1
 * (nothing to migrate), so a fresh install never looks like it is mid-migration.
 */
export function embedCoverage(db: DB, table: string): number {
  const total = (db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get() as { c: number }).c;
  if (total === 0) return 1;
  return (total - vecStaleIds(db, table).size) / total;
}

export function vecReplace(
  db: DB,
  table: string,
  id: number | string,
  f32: Float32Array,
  embedVersion: number = EMBED_VERSION,
): void {
  // DELETE-then-INSERT (portable across sqlite-vec versions; handles the re-digest EC 5 /
  // FR 8 case). DELETE-by-id accepts a plain number, so no coercion here. vecInsert stamps
  // vec_meta via upsert, so the old row's stale version cannot survive the replace.
  db.prepare(`DELETE FROM ${table} WHERE ${idColForTable(table)} = ?`).run(id);
  vecInsert(db, table, id, f32, embedVersion);
}

export function vecDelete(db: DB, table: string, id: number | string): void {
  db.transaction(() => {
    db.prepare(`DELETE FROM ${table} WHERE ${idColForTable(table)} = ?`).run(id);
    db.prepare(`DELETE FROM vec_meta WHERE table_name = ? AND row_id = ?`).run(table, String(id));
  })();
}

/**
 * Maximum vec0 L2 distance a hit may have and still count as relevant (issue #43).
 *
 * KNN returns its k nearest neighbours whether or not anything is NEAR. With no floor, a query
 * about something the corpus has never discussed comes back with k plausible-looking rows, and a
 * caller cannot tell that from a real answer.
 *
 * Measured 2026-09-18 against the live corpus, using the turn that followed each user question as
 * ground truth (long answers only, so adjacency enrichment could not smuggle the question into the
 * answer's vector):
 *
 *     RELEVANT (known answer)  n=37  min=0.383  p50=0.543  p90=0.723  max=0.733
 *     IRRELEVANT (nonsense q)  n=60  min=0.599  p50=0.816  max=0.849
 *
 * 0.74-0.78 is a plateau keeping 100% of measured real answers while blocking ~83% of nonsense.
 * 0.76 is its middle. The distributions OVERLAP, so no threshold separates them perfectly; this
 * one deliberately protects recall, which is the side you cannot recover from, and accepts the
 * nonsense that happens to land close.
 *
 * THIS NUMBER IS SPECIFIC TO THE CURRENT MODEL AND METRIC (MiniLM unit-normalized vectors, vec0
 * L2, where L2 ranking == cosine ranking). Any change to the embedding representation invalidates
 * it and requires re-measuring — that is exactly what EMBED_VERSION tracks. Raise the env var
 * above the metric's maximum to disable the floor without a deploy.
 */
const DEFAULT_DISTANCE_FLOOR = 0.76;

export function distanceFloor(): number {
  const n = Number(process.env.VECTOR_DISTANCE_FLOOR);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_DISTANCE_FLOOR;
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
  const hits = db
    .prepare(
      `SELECT ${idColForTable(table)} AS id, distance FROM ${table} WHERE embedding MATCH ? AND k = ?`,
    )
    .all(f32ToBlob(queryF32), k) as { id: number | string; distance: number }[];
  // Relevance floor (issue #43). Applied HERE, at the one place every vector arm goes through,
  // so no call site can forget it. Hits come back sorted by distance, so this is a prefix.
  const floor = distanceFloor();
  return hits.filter((h) => h.distance <= floor);
}

export function indexAsync(
  db: DB,
  table: string,
  id: number | string,
  text: string,
  opts?: { prevText?: string | null },
): void {
  // Fire-and-forget: start a Promise, never await it. The embeddingEnabled() gate is the
  // single choke point that disables all four write paths during testing (W1).
  if (!embeddingEnabled()) return;
  // buildEmbedText is applied HERE, at the one choke point every write path funnels through,
  // so the stored/FTS text and the embedded text can never drift apart per-caller. Callers with
  // no adjacency context (entities, digests, memory items) pass nothing and embed bare.
  embed(buildEmbedText(text, opts?.prevText ?? null))
    .then((f32) => vecInsert(db, table, id, f32))
    .catch((err) => console.error('[MOT/vec] indexAsync error:', err));
}
