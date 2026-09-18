// Issue #37 — ftsQuery replaces whole-query phrase matching.
//
// The bug being fixed: ftsPhrase wrapped the ENTIRE user query in quotes, so any multi-word
// natural-language question required an exact phrase match and returned nothing, while its
// content sat in the index. These tests assert both the builder's shape and real retrieval.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { setupTempDb, cleanupTempDb } from './_helpers';

const dbPath = setupTempDb('fts-query');
{
  const seed = new Database(dbPath);
  seed.exec(fs.readFileSync(path.join(process.cwd(), 'db/migrations/0003_conversation_fts.sql'), 'utf8'));
  seed.close();
}

let ftsQuery: typeof import('../../lib/fts').ftsQuery;
let tokenize: typeof import('../../lib/fts').tokenize;
let fts5Stem: typeof import('../../lib/fts').fts5Stem;
let docFrequency: typeof import('../../lib/fts').docFrequency;
let logTurn: typeof import('../../lib/conversation').logTurn;
let searchTurns: typeof import('../../lib/conversation').searchTurns;

beforeAll(async () => {
  ({ ftsQuery, tokenize, fts5Stem, docFrequency } = await import('../../lib/fts'));
  ({ logTurn, searchTurns } = await import('../../lib/conversation'));
});
afterAll(() => cleanupTempDb(dbPath));

describe('tokenize', () => {
  it('normalizes hyphens and underscores so they cannot become the NOT operator', () => {
    // FTS5 query syntax reads a leading `-` as NOT, so `mot-intake` would mean
    // "mot WITHOUT intake" — the exact inverse of the intent.
    expect(tokenize('mot-intake').tokens).toEqual(['mot', 'intake']);
    expect(tokenize('better_sqlite3 rheo-bot').tokens).toEqual(['better', 'sqlite3', 'rheo', 'bot']);
  });

  it('drops FTS5 operator punctuation entirely rather than escaping it', () => {
    expect(tokenize('foo* NEAR(bar) baz:qux ^x').tokens).toEqual(
      ['foo', 'NEAR', 'bar', 'baz', 'qux', 'x'],
    );
  });

  it('preserves an explicitly quoted run as one phrase', () => {
    const { tokens, userPhrases } = tokenize('"provider seam" outage');
    expect(userPhrases).toEqual(['provider seam']);
    expect(tokens).toEqual(['outage']);
  });
});

describe('ftsQuery shape', () => {
  it('ORs the terms of a short query without filtering', () => {
    expect(ftsQuery('lightsail box', 'conversation_fts')).toBe('"lightsail" OR "box"');
  });

  it('quotes every token, so operators in user input are inert', () => {
    const out = ftsQuery('drop table OR 1=1', 'conversation_fts', { skipIdf: true });
    expect(out.split(' OR ').every((p) => /^"[^"]*"$/.test(p))).toBe(true);
  });

  it('returns empty when nothing survives tokenization', () => {
    expect(ftsQuery('!!! ???', 'conversation_fts')).toBe('');
    expect(ftsQuery('   ', 'conversation_fts')).toBe('');
  });

  it('honours an explicit phrase and never IDF-filters it', () => {
    const out = ftsQuery('"the it you that a" thing', 'conversation_fts');
    expect(out).toContain('"the it you that a"');
  });
});

describe('fts5Stem uses the index tokenizer', () => {
  it('returns the stem SQLite itself would store', () => {
    // A JS Porter implementation may render this differently; the point is that it cannot
    // disagree with the index, because the index does the stemming.
    expect(fts5Stem('deployed')).toBe('deploi');
    expect(fts5Stem('moving')).toBe('move');
  });
});

describe('IDF filtering against a real corpus', () => {
  beforeAll(() => {
    // 30 rows of filler establish "the" as corpus-common; one row carries the rare term.
    for (let i = 0; i < 30; i++) logTurn('c1', 'user', `the quick brown fox number ${i}`);
    logTurn('c1', 'user', 'the lightsail migration decision');
  });

  it('drops a term appearing in most rows and keeps a rare one', () => {
    expect(docFrequency('the', 'conversation_fts')).toBeGreaterThan(0.5);
    expect(docFrequency('lightsail', 'conversation_fts')).toBeLessThan(0.15);
    const out = ftsQuery('why did we move off the lightsail box', 'conversation_fts');
    expect(out).toContain('"lightsail"');
    expect(out).not.toContain('"the"');
  });

  it('keeps the rarest terms rather than producing an empty match', () => {
    const out = ftsQuery('the the the quick brown', 'conversation_fts');
    expect(out).not.toBe('');
  });

  it('skipIdf keeps common terms', () => {
    expect(ftsQuery('the quick brown', 'conversation_fts', { skipIdf: true })).toContain('"the"');
  });
});

describe('structural stopwords', () => {
  it('drops function words the small-corpus DF filter cannot reach', () => {
    // Measured 2026-09-17: "why"/"did"/"we"/"off" all sit UNDER the 15% threshold on a
    // 1,034-document corpus, so the adaptive filter alone leaves them in.
    const out = ftsQuery('why did we move off the lightsail box', 'conversation_fts');
    expect(out).toBe('"move" OR "lightsail" OR "box"');
  });

  it('does not touch a domain term that merely looks common', () => {
    // "mcp" (11.1%) and "tool" (11.3%) sit right beside "we" (10.6%), which is exactly why the
    // threshold is not simply lowered.
    const out = ftsQuery('what does the mcp tool do', 'conversation_fts');
    expect(out).toContain('"mcp"');
    expect(out).toContain('"tool"');
  });

  it('falls back to stopwords only when the query is nothing else', () => {
    const out = ftsQuery('what is it', 'conversation_fts');
    expect(out).not.toBe('');
  });

  it('leaves short queries alone even when they are stopwords', () => {
    expect(ftsQuery('the box', 'conversation_fts')).toBe('"the" OR "box"');
  });
});

describe('the regression this fixes, end to end', () => {
  it('finds a turn by a natural-language question that is not an exact phrase', () => {
    logTurn('c2', 'rheo', 'We moved off the Lightsail box because the datacenter IP was blocked.');
    // The exact-phrase form this replaces matched nothing for a query like this.
    const hits = searchTurns('why did we move off the lightsail box', 'c2', 10) as { content: string }[];
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].content).toContain('Lightsail');
  });

  it('finds a kebab-case identifier instead of inverting the query', () => {
    logTurn('c3', 'user', 'the mot-intake routine files tickets hourly');
    const hits = searchTurns('mot-intake routine', 'c3', 10) as { content: string }[];
    expect(hits.length).toBeGreaterThan(0);
  });
});
