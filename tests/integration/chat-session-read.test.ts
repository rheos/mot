// Issue #50 — read a session, optionally centered on a matched turn.
//
// The "read the match" half of search-returns-pointers. Without it a chat_search hit is a dead
// end: the caller sees the matching line and nothing said around it.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { setupTempDb, cleanupTempDb } from './_helpers';

const dbPath = setupTempDb('chat-session');
{
  const seed = new Database(dbPath);
  seed.exec(fs.readFileSync(path.join(process.cwd(), 'db/migrations/0003_conversation_fts.sql'), 'utf8'));
  seed.exec(fs.readFileSync(path.join(process.cwd(), 'db/migrations/0011_tool_call_log.sql'), 'utf8'));
  seed.close();
}

let readSession: typeof import('../../lib/conversation').readSession;
let callMcpTool: typeof import('../../lib/mcp-tools').callMcpTool;
let getDb: typeof import('../../db/client').getDb;
const SID = 'sess-A';
let ids: number[] = [];

beforeAll(async () => {
  ({ readSession } = await import('../../lib/conversation'));
  ({ callMcpTool } = await import('../../lib/mcp-tools'));
  ({ getDb } = await import('../../db/client'));
  // 30 turns in one session, plus a decoy turn in a different session.
  const ins = getDb().prepare(
    'INSERT INTO conversation (chat_id, session_id, role, content, ts) VALUES (?, ?, ?, ?, ?)',
  );
  for (let i = 0; i < 30; i++) {
    ids.push(ins.run('c', SID, i % 2 ? 'rheo' : 'user', `turn ${i}`, `2026-09-18T00:${String(i).padStart(2, '0')}:00Z`)
      .lastInsertRowid as number);
  }
  ins.run('c', 'sess-B', 'user', 'different session', '2026-09-18T01:00:00Z');
});
afterAll(() => cleanupTempDb(dbPath));

describe('centering on a matched turn', () => {
  it('opens ON the turn with context either side, and says which one it is', () => {
    const p = readSession(SID, { aroundTurnId: ids[15], context: 2 });
    expect(p.turns).toHaveLength(5);
    expect(p.turns[2].id).toBe(ids[15]);
    expect(p.target_position).toBe(16); // 1-indexed within the session
    expect(p.showing).toEqual([14, 18]);
    expect(p.total).toBe(30);
  });

  it('clamps at the start of a session without padding or erroring', () => {
    const p = readSession(SID, { aroundTurnId: ids[0], context: 5 });
    expect(p.turns[0].id).toBe(ids[0]);
    expect(p.showing[0]).toBe(1);
    expect(p.target_position).toBe(1);
  });

  it('clamps at the end and reports no more', () => {
    const p = readSession(SID, { aroundTurnId: ids[29], context: 5 });
    expect(p.turns.at(-1)!.id).toBe(ids[29]);
    expect(p.has_more).toBe(false);
  });

  it('caps context, so one call cannot swallow a context window', () => {
    const p = readSession(SID, { aroundTurnId: ids[15], context: 9999 });
    expect(p.turns.length).toBeLessThanOrEqual(21); // 10 either side + the target
  });
});

describe('paging', () => {
  it('reports total, range and has_more so a caller need not guess', () => {
    const p = readSession(SID, { offset: 0, limit: 10 });
    expect(p.turns).toHaveLength(10);
    expect(p.showing).toEqual([1, 10]);
    expect(p.has_more).toBe(true);
    expect(p.total).toBe(30);
  });

  it('ends cleanly on the last page', () => {
    const p = readSession(SID, { offset: 25, limit: 10 });
    expect(p.turns).toHaveLength(5);
    expect(p.has_more).toBe(false);
  });

  it('caps the page size', () => {
    expect(readSession(SID, { limit: 9999 }).turns.length).toBeLessThanOrEqual(50);
  });

  it('returns an empty page past the end rather than erroring', () => {
    const p = readSession(SID, { offset: 500 });
    expect(p.turns).toEqual([]);
    expect(p.total).toBe(30);
  });
});

describe('wrong references are surfaced, not smoothed over', () => {
  it('returns an empty page for an unknown session — "no such conversation" is an answer', () => {
    const p = readSession('nope', {});
    expect(p.turns).toEqual([]);
    expect(p.total).toBe(0);
  });

  it('rejects a turn that belongs to a DIFFERENT session', async () => {
    // Silently returning the head of the session would hand back plausible-looking content for
    // a wrong reference — exactly the failure this layer exists to prevent.
    const other = getDb().prepare('SELECT id FROM conversation WHERE session_id = ?').get('sess-B') as { id: number };
    expect(() => readSession(SID, { aroundTurnId: other.id })).toThrow();

    const res = await callMcpTool('chat_session', { session_id: SID, around_turn_id: other.id });
    const payload = JSON.parse((res as { text: string }[])[0].text) as { error?: string };
    expect(payload.error).toBe('turn_not_in_session');
  });
});

describe('the end-to-end pattern', () => {
  it('a search hit can be followed into its surrounding conversation', async () => {
    const hit = { session_id: SID, id: ids[20] };
    const res = await callMcpTool('chat_session', {
      session_id: hit.session_id,
      around_turn_id: hit.id,
      context: 1,
    });
    const page = JSON.parse((res as { text: string }[])[0].text) as {
      turns: { id: number; content: string }[];
      target_position: number;
    };
    expect(page.turns.map((t) => t.content)).toEqual(['turn 19', 'turn 20', 'turn 21']);
    expect(page.target_position).toBe(21);
  });
});
