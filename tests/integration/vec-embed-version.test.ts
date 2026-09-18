// Issue #30 — the embed-version sidecar (0010_embed_version.sql).
//
// Vectors are FABRICATED here, never produced by embed(): these assertions are about the
// bookkeeping, not the model, so the suite stays offline and MOT_EMBED_DISABLE stays set.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { setupVecDb, cleanupTempDb } from './_helpers';

const { dbPath, vecAvail } = setupVecDb('embed-version');

let vecInsert: typeof import('../../lib/vec').vecInsert;
let vecReplace: typeof import('../../lib/vec').vecReplace;
let vecDelete: typeof import('../../lib/vec').vecDelete;
let vecStaleIds: typeof import('../../lib/vec').vecStaleIds;
let embedCoverage: typeof import('../../lib/vec').embedCoverage;
let loadVecExtension: typeof import('../../lib/vec').loadVecExtension;
let EMBED_VERSION: number;
let getDb: typeof import('../../db/client').getDb;

const vec = (seed: number) => Float32Array.from({ length: 384 }, (_, i) => Math.sin(seed + i) / 20);

beforeAll(async () => {
  ({ vecInsert, vecReplace, vecDelete, vecStaleIds, embedCoverage, loadVecExtension } =
    await import('../../lib/vec'));
  ({ EMBED_VERSION } = await import('../../lib/embed-input'));
  ({ getDb } = await import('../../db/client'));
  loadVecExtension(getDb());
});

afterAll(() => cleanupTempDb(dbPath));

describe.skipIf(!vecAvail)('embed version stamping', () => {
  beforeEach(() => {
    const db = getDb();
    db.prepare('DELETE FROM conversation_vec').run();
    db.prepare('DELETE FROM vec_meta').run();
    db.prepare('DELETE FROM conversation').run();
  });

  const stamp = (id: number) =>
    getDb()
      .prepare('SELECT embed_version FROM vec_meta WHERE table_name = ? AND row_id = ?')
      .get('conversation_vec', String(id)) as { embed_version: number } | undefined;

  it('records the current version on insert', () => {
    vecInsert(getDb(), 'conversation_vec', 1, vec(1));
    expect(stamp(1)?.embed_version).toBe(EMBED_VERSION);
  });

  it('treats a vector with no sidecar row as stale (a pre-0010 row)', () => {
    vecInsert(getDb(), 'conversation_vec', 7, vec(7));
    // Simulate a row written before the stamp existed.
    getDb().prepare('DELETE FROM vec_meta WHERE row_id = ?').run('7');
    expect(vecStaleIds(getDb(), 'conversation_vec').has('7')).toBe(true);
  });

  it('treats an explicitly older version as stale, and the current one as fresh', () => {
    vecInsert(getDb(), 'conversation_vec', 10, vec(10), EMBED_VERSION - 1);
    vecInsert(getDb(), 'conversation_vec', 11, vec(11));
    const stale = vecStaleIds(getDb(), 'conversation_vec');
    expect(stale.has('10')).toBe(true);
    expect(stale.has('11')).toBe(false);
  });

  it('re-stamps on replace, so a re-embed clears staleness', () => {
    vecInsert(getDb(), 'conversation_vec', 20, vec(20), EMBED_VERSION - 1);
    expect(vecStaleIds(getDb(), 'conversation_vec').has('20')).toBe(true);
    vecReplace(getDb(), 'conversation_vec', 20, vec(21));
    expect(stamp(20)?.embed_version).toBe(EMBED_VERSION);
    expect(vecStaleIds(getDb(), 'conversation_vec').has('20')).toBe(false);
  });

  it('drops the sidecar row on delete, leaving no orphan', () => {
    vecInsert(getDb(), 'conversation_vec', 30, vec(30));
    vecDelete(getDb(), 'conversation_vec', 30);
    expect(stamp(30)).toBeUndefined();
    const orphans = getDb()
      .prepare('SELECT COUNT(*) AS c FROM vec_meta WHERE table_name = ?')
      .get('conversation_vec') as { c: number };
    expect(orphans.c).toBe(0);
  });

  it('round-trips a TEXT-PK store as well as an INTEGER-PK one', () => {
    vecInsert(getDb(), 'session_digest_vec', '2026-09-18-10:00', vec(40));
    const row = getDb()
      .prepare('SELECT embed_version FROM vec_meta WHERE table_name = ? AND row_id = ?')
      .get('session_digest_vec', '2026-09-18-10:00') as { embed_version: number } | undefined;
    expect(row?.embed_version).toBe(EMBED_VERSION);
    expect(vecStaleIds(getDb(), 'session_digest_vec').size).toBe(0);
  });
});

describe.skipIf(!vecAvail)('embedCoverage', () => {
  beforeEach(() => {
    getDb().prepare('DELETE FROM conversation_vec').run();
    getDb().prepare('DELETE FROM vec_meta').run();
  });

  it('is 1 for an empty table, so a fresh install never looks mid-migration', () => {
    expect(embedCoverage(getDb(), 'conversation_vec')).toBe(1);
  });

  it('reports the fraction already at the current version', () => {
    for (const id of [1, 2, 3]) vecInsert(getDb(), 'conversation_vec', id, vec(id));
    vecInsert(getDb(), 'conversation_vec', 4, vec(4), EMBED_VERSION - 1);
    expect(embedCoverage(getDb(), 'conversation_vec')).toBeCloseTo(0.75, 5);
  });

  it('is 0 when every row predates the stamp', () => {
    for (const id of [1, 2]) vecInsert(getDb(), 'conversation_vec', id, vec(id));
    getDb().prepare('DELETE FROM vec_meta').run();
    expect(embedCoverage(getDb(), 'conversation_vec')).toBe(0);
  });
});
