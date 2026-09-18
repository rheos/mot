// Issue #30 — the embed-input representation: adjacency enrichment + the version stamp.
//
// These assert the PURE function and the invariant that matters most: enrichment changes the
// embedded text and NOTHING else. Stored content and the FTS index must be byte-identical.

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { setupTempDb, cleanupTempDb } from './_helpers';

const dbPath = setupTempDb('embed-input');
// setupTempDb stops at 0001; the FTS-contamination assertion below needs conversation_fts.
// Applied here rather than in the shared helper so no other test's fixture shifts underneath it.
{
  const seed = new Database(dbPath);
  seed.exec(
    fs.readFileSync(path.join(process.cwd(), 'db/migrations/0003_conversation_fts.sql'), 'utf8'),
  );
  seed.close();
}

let buildEmbedText: typeof import('../../lib/embed-input').buildEmbedText;
let EMBED_VERSION: number;
let ENRICH_SEP: string;
let logTurn: typeof import('../../lib/conversation').logTurn;
let searchTurns: typeof import('../../lib/conversation').searchTurns;
let getDb: typeof import('../../db/client').getDb;

beforeAll(async () => {
  const mod = await import('../../lib/embed-input');
  buildEmbedText = mod.buildEmbedText;
  EMBED_VERSION = mod.EMBED_VERSION;
  ENRICH_SEP = mod.ENRICH_SEP;
  ({ logTurn, searchTurns } = await import('../../lib/conversation'));
  ({ getDb } = await import('../../db/client'));
});

afterAll(() => cleanupTempDb(dbPath));

describe('buildEmbedText', () => {
  it('leaves a long turn untouched', () => {
    const long = 'x'.repeat(250);
    expect(buildEmbedText(long, 'some earlier turn')).toBe(long);
  });

  it('prepends the preceding turn to a short one', () => {
    expect(buildEmbedText('ok ship it', 'the fix is the provider seam plus the alert ticket')).toBe(
      'the fix is the provider seam plus the alert ticket' + ENRICH_SEP + 'ok ship it',
    );
  });

  it('embeds bare when there is no predecessor (session boundary / first turn)', () => {
    expect(buildEmbedText('ok ship it', null)).toBe('ok ship it');
    expect(buildEmbedText('ok ship it', '')).toBe('ok ship it');
  });

  it('bounds how much context it pulls in', () => {
    const huge = 'y'.repeat(5000);
    const out = buildEmbedText('yes', huge);
    // Tail of the predecessor, not the head: the nearest context is the most relevant.
    expect(out.length).toBeLessThan(700);
    expect(out.endsWith(ENRICH_SEP + 'yes')).toBe(true);
    expect(out.startsWith('y')).toBe(true);
  });

  it('strips NULs from both halves (they would truncate the embed input)', () => {
    expect(buildEmbedText('a\0b', 'c\0d')).toBe('cd' + ENRICH_SEP + 'ab');
  });

  describe('threshold is read at call time', () => {
    const saved = process.env.EMBED_ENRICH_MAX_CHARS;
    afterEach(() => {
      if (saved === undefined) delete process.env.EMBED_ENRICH_MAX_CHARS;
      else process.env.EMBED_ENRICH_MAX_CHARS = saved;
    });

    it('honours a retuned threshold with no reimport', () => {
      process.env.EMBED_ENRICH_MAX_CHARS = '5';
      expect(buildEmbedText('ok ship it', 'prev')).toBe('ok ship it'); // now "long"
      process.env.EMBED_ENRICH_MAX_CHARS = '500';
      expect(buildEmbedText('ok ship it', 'prev')).toBe('prev' + ENRICH_SEP + 'ok ship it');
    });

    it('falls back to the default on a junk value rather than disabling enrichment', () => {
      for (const junk of ['0', '-1', 'abc', '']) {
        process.env.EMBED_ENRICH_MAX_CHARS = junk;
        expect(buildEmbedText('short', 'prev')).toBe('prev' + ENRICH_SEP + 'short');
      }
    });
  });
});

describe('enrichment does not leak into stored text or FTS', () => {
  beforeEach(() => {
    getDb().prepare('DELETE FROM conversation').run();
  });

  it('stores the turn verbatim', () => {
    logTurn('chat-a', 'user', 'the maintainer provider seam is the fix');
    const turn = logTurn('chat-a', 'user', 'ok ship it');
    const stored = getDb()
      .prepare('SELECT content FROM conversation WHERE id = ?')
      .get(turn.id) as { content: string };
    expect(stored.content).toBe('ok ship it');
    expect(stored.content).not.toContain('provider seam');
  });

  it('does not make a turn findable by its predecessor\'s words', () => {
    logTurn('chat-b', 'user', 'the maintainer provider seam is the fix');
    logTurn('chat-b', 'rheo', 'ok ship it');
    // If enrichment had contaminated the FTS index, the short turn would match "provider".
    const hits = searchTurns('provider', 'chat-b', 10);
    expect(hits).toHaveLength(1);
    expect(hits[0].content).toContain('provider seam');
  });
});

describe('EMBED_VERSION', () => {
  it('is an integer above the implicit pre-stamp representation', async () => {
    const { IMPLICIT_EMBED_VERSION } = await import('../../lib/embed-input');
    expect(Number.isInteger(EMBED_VERSION)).toBe(true);
    expect(EMBED_VERSION).toBeGreaterThan(IMPLICIT_EMBED_VERSION);
  });
});
