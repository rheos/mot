// Issue #47 — record what the AGENT asks the tool surface for.
//
// Not the same thing as "log the queries". The human side is already durable: Robin's messages
// live in `conversation`. What is nowhere is the TRANSLATION step — what Rheo turns a request
// into when it calls chat_search, which mode it picks, and how much comes back. That is the layer
// four retrieval changes were tuned against, blind.

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { setupTempDb, cleanupTempDb } from './_helpers';

const dbPath = setupTempDb('tool-log');
{
  const seed = new Database(dbPath);
  seed.exec(fs.readFileSync(path.join(process.cwd(), 'db/migrations/0003_conversation_fts.sql'), 'utf8'));
  seed.close();
}

let callMcpTool: typeof import('../../lib/mcp-tools').callMcpTool;
let logToolCall: typeof import('../../lib/tool-log').logToolCall;
let getDb: typeof import('../../db/client').getDb;

const rows = () =>
  getDb().prepare('SELECT * FROM tool_call_log ORDER BY id').all() as Record<string, unknown>[];

beforeAll(async () => {
  ({ callMcpTool } = await import('../../lib/mcp-tools'));
  ({ logToolCall } = await import('../../lib/tool-log'));
  ({ getDb } = await import('../../db/client'));
});
afterAll(() => cleanupTempDb(dbPath));
// Braces matter: a bodiless arrow returns RunResult, which vitest types as a hook cleanup
// callback and tsc rejects. vitest run does not typecheck, so this only surfaces under tsc.
beforeEach(() => {
  getDb().prepare('DELETE FROM tool_call_log').run();
});

describe('what gets recorded', () => {
  it('captures the query text, its word count, and the mode for a search', async () => {
    await callMcpTool('chat_search', { q: 'contabo migration lightsail', mode: 'fts', limit: 5 });
    const [r] = rows();
    expect(r.tool).toBe('chat_search');
    expect(r.query).toBe('contabo migration lightsail');
    expect(r.query_len).toBe(3); // the shape question: keywords or a sentence?
    expect(r.mode).toBe('fts');
    expect(typeof r.duration_ms).toBe('number');
    expect(r.ok).toBe(1);
  });

  it('records how many rows came back, so empty results are visible', async () => {
    await callMcpTool('chat_search', { q: 'nothing whatsoever matches this', mode: 'fts' });
    expect(rows()[0].result_count).toBe(0);
  });

  it('records a failed call rather than losing it', async () => {
    // An unknown tool: the dispatcher's own error path. ok=0, and the call is still counted.
    await callMcpTool('no_such_tool', { q: 'x' }).catch(() => undefined);
    const [r] = rows();
    expect(r.tool).toBe('no_such_tool');
  });
});

describe('what does NOT get recorded', () => {
  it('never copies content from a write tool into the log', async () => {
    await callMcpTool('mot_create_ticket', {
      title: 'Renew the domain',
      ministry: 'interior',
      ticket_type: 'admin',
      severity: 'low',
      provenance: 'manual',
      source_ref: 'tool-log-test-1',
      body: 'SENSITIVE BODY CONTENT THAT MUST NOT BE DUPLICATED',
    }).catch(() => undefined);
    const all = JSON.stringify(rows());
    expect(all).not.toContain('SENSITIVE BODY CONTENT');
    expect(all).not.toContain('Renew the domain');
    // Argument NAMES are kept — enough to see which tools are used and how, without the values.
    expect(rows()[0].arg_keys).toContain('title');
    expect(rows()[0].query).toBeNull();
  });
});

describe('failure discipline', () => {
  afterEach(() => {
    delete process.env.MOT_TOOL_LOG_DISABLE;
    try {
      getDb().exec(fs.readFileSync(path.join(process.cwd(), 'db/migrations/0011_tool_call_log.sql'), 'utf8'));
    } catch { /* already present */ }
  });

  it('a broken log table never breaks the tool call', async () => {
    getDb().exec('DROP TABLE tool_call_log');
    // The whole point: losing a log row is nothing, failing Rheo's reply is unacceptable.
    await expect(callMcpTool('chat_search', { q: 'still works', mode: 'fts' })).resolves.toBeDefined();
  });

  it('logToolCall itself never throws', () => {
    getDb().exec('DROP TABLE tool_call_log');
    expect(() => logToolCall({ tool: 't', args: {}, durationMs: 1, ok: true })).not.toThrow();
  });

  it('can be switched off at call time without a deploy', async () => {
    process.env.MOT_TOOL_LOG_DISABLE = '1';
    await callMcpTool('chat_search', { q: 'not recorded', mode: 'fts' });
    expect(rows()).toHaveLength(0);
  });
});
