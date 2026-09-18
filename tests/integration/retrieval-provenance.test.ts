// Issue #45 — the caller can tell a healthy hybrid answer from a degraded one.
//
// The never-reject degrade contract (ratified 2026-07-06) is deliberately silent: a dead vector
// arm yields the FTS list rather than an error. Silent is right; INVISIBLE is not. Without this,
// an agent cannot say "semantic search was unavailable, this may be incomplete".

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { setupTempDb, cleanupTempDb } from './_helpers';

const dbPath = setupTempDb('provenance');
{
  const seed = new Database(dbPath);
  seed.exec(fs.readFileSync(path.join(process.cwd(), 'db/migrations/0003_conversation_fts.sql'), 'utf8'));
  seed.close();
}

let searchTurns: typeof import('../../lib/conversation').searchTurns;
let logTurn: typeof import('../../lib/conversation').logTurn;
type Stats = import('../../lib/rrf').RetrievalStats;

beforeAll(async () => {
  ({ searchTurns, logTurn } = await import('../../lib/conversation'));
});
afterAll(() => cleanupTempDb(dbPath));

describe('retrieval provenance', () => {
  beforeEach(() => {
    logTurn('p1', 'user', 'the contabo migration moved everything off lightsail');
  });

  it('reports the fts arm count on a keyword search', () => {
    const stats = { mode: 'fts' } as Stats;
    const rows = searchTurns('contabo migration', 'p1', 10, undefined, stats) as { id: number }[];
    expect(stats.mode).toBe('fts');
    expect(stats.fts_count).toBe(rows.length);
    expect(stats.fts_count).toBeGreaterThan(0);
  });

  it('reports zero rather than undefined when the query tokenizes to nothing', () => {
    const stats = { mode: 'fts' } as Stats;
    expect(searchTurns('!!! ???', 'p1', 10, undefined, stats)).toEqual([]);
    expect(stats.fts_count).toBe(0);
  });

  it('marks the semantic arm unavailable when embedding is off', async () => {
    // The whole suite runs with MOT_EMBED_DISABLE=1, so this is the real degraded path: the
    // hybrid call still returns the FTS list (never-reject), and now SAYS the arm did not run.
    const stats = { mode: 'hybrid' } as Stats;
    const rows = await searchTurns('contabo migration', 'p1', 10, 'hybrid', stats);
    expect(stats.mode).toBe('hybrid');
    expect(stats.semantic_available).toBe(false);
    expect(stats.vector_count).toBe(0);
    // Degrade contract intact: results still came back, from the keyword arm.
    expect(rows.length).toBeGreaterThan(0);
    expect(stats.fts_count).toBeGreaterThan(0);
  });

  it('does not require a stats object — every existing caller is unaffected', () => {
    expect(() => searchTurns('contabo', 'p1', 10)).not.toThrow();
  });

  it('gives each caller its own object, so concurrent requests cannot cross-read', async () => {
    const a = { mode: 'hybrid' } as Stats;
    const b = { mode: 'fts' } as Stats;
    await Promise.all([
      searchTurns('contabo', 'p1', 10, 'hybrid', a),
      Promise.resolve(searchTurns('lightsail', 'p1', 10, undefined, b)),
    ]);
    expect(a.mode).toBe('hybrid');
    expect(b.mode).toBe('fts');
  });
});
