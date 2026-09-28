import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { setupRouteDb, cleanupTempDb, postBody } from './_helpers';
import { MemoryDisabledError, memoryDisabled } from '../../lib/memory-control';

const auth = await setupRouteDb('memory-disable');
const graphFile = path.join(path.dirname(auth.dbPath), 'graph.jsonl');
process.env.MOT_GRAPH_PATH = graphFile;
const db = await import('../../db/client');
const conversation = await import('../../lib/conversation');
const digest = await import('../../lib/digest');
const memory = await import('../../lib/memory');
const graph = await import('../../lib/graph');
const compact = await import('../../lib/graph-compact');
const procedural = await import('../../lib/procedural');
const topics = await import('../../lib/topics');
const maintainer = await import('../../lib/maintainer');
const profile = await import('../../lib/profile');
const surfacing = await import('../../lib/surfacing');
const extraction = await import('../../lib/extraction');
const vec = await import('../../lib/vec');
const embedding = await import('../../lib/embedding');
const mcp = await import('../../lib/mcp-tools');
const mcpRoute = await import('../../app/api/mcp/route');
const ticketsRoute = await import('../../app/api/tickets/route');
const ticketRoute = await import('../../app/api/tickets/[id]/route');
const statusRoute = await import('../../app/api/status/route');
const backfill = await import('../../scripts/backfill-extraction');
const backfillEmbeddings = await import('../../scripts/backfill-embeddings');

const retained = [
  'mot_list_tickets', 'mot_get_ticket', 'mot_create_ticket', 'mot_update_ticket',
  'mot_get_status', 'mot_get_ministry_config', 'notify_robin', 'deploy_drift_check',
];
const memoryTools = mcp.listMcpTools().map(t => t.name).filter(n => !retained.includes(n));
const tables = ['conversation', 'session_digest', 'memory_items', 'procedural_notes',
  'topic_thread', 'topic_thread_session', 'surfaced_ledger', 'vec_meta',
  'conversation_vec', 'session_digest_vec', 'memory_items_vec', 'entity_vec'];
function snapshot(): unknown {
  return {
    tables: tables.map(t => db.getDb().prepare(`SELECT * FROM ${t}`).all()
      .sort((a, b) => (JSON.stringify(a) ?? '').localeCompare(JSON.stringify(b) ?? ''))),
    graph: fs.readFileSync(graphFile, 'utf8'),
    profile: fs.readFileSync(path.join(path.dirname(auth.dbPath), 'profile.synth.md'), 'utf8'),
    // No new maintainer/profile files should appear in the fixture directory.
    files: fs.readdirSync(path.dirname(auth.dbPath)).sort(),
  };
}
let baseline: unknown;
let entity: import('../../lib/graph').EntityRecord;
let turn: import('../../lib/conversation').LogTurnResult;
let noteId: number;

beforeAll(() => {
  db.migrate_db();
  turn = conversation.logTurn('synthetic-chat', 'user', 'Synthetic fixture only');
  digest.upsertDigest({ session_id: turn.session_id, chat_id: turn.chat_id, summary: 'Synthetic digest', turn_count: 1 });
  const fact = memory.writeMemory({ type: 'fact', content: { label: 'Fixture fact', properties: {} },
    source_turn_id: turn.id, source_session_id: turn.session_id, confidence: 0.9, reason: 'stated' });
  if ('error' in fact || 'conflict' in fact) throw new Error('fixture failed');
  entity = graph.appendEntity({ type: 'Fact', label: 'Fixture entity', properties: {},
    valid_from: new Date().toISOString(), valid_until: null, confidence: 0.9,
    source: 'manual', superseded_by: null, confirmed: false });
  const note = procedural.insertCandidate('workflow', 'Fixture instruction', turn.session_id);
  if ('error' in note) throw new Error('fixture failed');
  noteId = note.id;
  topics.createThread('fixture', 'Fixture thread');
  topics.linkThreadSession('fixture', turn.session_id);
  const vector = new Float32Array(384).fill(0.05);
  for (const [table, id] of [['conversation_vec', turn.id], ['session_digest_vec', turn.session_id],
    ['memory_items_vec', fact.id], ['entity_vec', entity.id]] as const) {
    vec.vecInsert(db.getDb(), table, id, vector);
  }
  fs.writeFileSync(path.join(path.dirname(auth.dbPath), 'profile.synth.md'), 'Synthetic profile fixture\n');
  baseline = snapshot();
});
beforeEach(() => { process.env.MOT_MEMORY_DISABLE = '1'; });
afterEach(() => {
  expect(snapshot()).toEqual(baseline);
  delete process.env.MOT_MEMORY_DISABLE;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
afterAll(() => {
  db.getDb().close();
  cleanupTempDb(auth.dbPath);
  delete process.env.MOT_GRAPH_PATH;
  delete process.env.DATABASE_URL;
});

describe('memory-only mode', () => {
  it('is exact-value, runtime-read, and off by default', () => {
    delete process.env.MOT_MEMORY_DISABLE;
    expect(memoryDisabled()).toBe(false);
    expect(mcp.listMcpTools().map(t => t.name)).toContain('write_memory');
    process.env.MOT_MEMORY_DISABLE = '0';
    expect(memoryDisabled()).toBe(false);
    process.env.MOT_MEMORY_DISABLE = 'true';
    expect(memoryDisabled()).toBe(false);
    process.env.MOT_MEMORY_DISABLE = '1';
    expect(memoryDisabled()).toBe(true);
  });

  it('MCP retains only non-memory tools and refuses all cached names before logging', async () => {
    expect(mcp.listMcpTools().map(t => t.name).sort()).toEqual([...retained].sort());
    const count = () => db.getDb().prepare('SELECT COUNT(*) AS n FROM tool_call_log').get();
    const before = count();
    for (const name of [...memoryTools, 'future_memory_tool']) {
      await expect(mcp.callMcpTool(name, { q: 'Synthetic denied input' })).rejects.toBeInstanceOf(MemoryDisabledError);
    }
    expect(count()).toEqual(before);
  });

  it('HTTP MCP cached calls produce a fixed error without echoing or logging input', async () => {
    const log = vi.spyOn(console, 'log');
    const error = vi.spyOn(console, 'error');
    const res = await mcpRoute.POST(new Request('http://localhost/api/mcp', {
      method: 'POST', headers: auth.authHeader,
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call',
        params: { name: 'Synthetic denied tool name', arguments: { content: 'Synthetic denied input' } } }),
    }));
    expect(await res.json()).toEqual({ jsonrpc: '2.0', id: 1,
      result: { isError: true, content: [{ type: 'text', text: 'M.O.T. memory is disabled' }] } });
    expect(log).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
  });

  it('ticket REST create/update/read and health keep the existing trusted-key privacy contract', async () => {
    const created = await ticketsRoute.POST(new Request('http://localhost/api/tickets', {
      method: 'POST', headers: auth.authHeader, body: JSON.stringify(postBody()),
    }));
    expect(created.status).toBe(201);
    const { id } = await created.json();
    const ctx = { params: Promise.resolve({ id }) };
    const updated = await ticketRoute.PATCH(new Request('http://localhost/api/tickets/' + id, {
      method: 'PATCH', headers: auth.authHeader, body: JSON.stringify({ status: 'watching' }),
    }), ctx);
    expect(updated.status).toBe(200);
    expect((await updated.json()).ticket.status).toBe('watching');
    expect((await ticketRoute.GET(new Request('http://localhost/api/tickets/' + id, { headers: auth.authHeader }), ctx)).status).toBe(200);
    const hidden = await ticketsRoute.POST(new Request('http://localhost/api/tickets', {
      method: 'POST', headers: auth.authHeader, body: JSON.stringify(postBody({ title: 'Private fixture', private: true })),
    }));
    const hiddenId = (await hidden.json()).id;
    expect((await ticketRoute.GET(new Request('http://localhost/api/tickets/' + hiddenId, { headers: auth.authHeader }),
      { params: Promise.resolve({ id: hiddenId }) })).status).toBe(200);
    const { getTicket } = await import('../../lib/tickets');
    expect(getTicket(hiddenId, false)).toBeNull();
    expect((await ticketRoute.GET(new Request('http://localhost/api/tickets/' + hiddenId),
      { params: Promise.resolve({ id: hiddenId }) })).status).toBe(401);
    expect((await statusRoute.GET()).status).toBe(200);
  });

  it('ticket MCP create/update/read and operational status/config still work', async () => {
    const result = JSON.parse((await mcp.callMcpTool('mot_create_ticket', postBody({ title: 'MCP fixture' })))[0].text);
    const id = result.ticket.id;
    const updated = JSON.parse((await mcp.callMcpTool('mot_update_ticket', { id, status: 'watching' }))[0].text);
    expect(updated.ticket.status).toBe('watching');
    expect(JSON.parse((await mcp.callMcpTool('mot_get_ticket', { id }))[0].text).id).toBe(id);
    expect(JSON.parse((await mcp.callMcpTool('mot_get_status', {}))[0].text).db_ok).toBe(true);
    expect((await mcp.callMcpTool('mot_list_tickets', {})).length).toBe(1);
    expect((await mcp.callMcpTool('mot_get_ministry_config', {})).length).toBe(1);
  });

  const routes: Array<[string, () => Promise<{ GET?: (req: Request, ctx: never) => Promise<Response>; POST?: (req: Request, ctx: never) => Promise<Response> }>, 'GET' | 'POST']> = [
    ['conversation', () => import('../../app/api/conversation/route'), 'GET'],
    ['conversation', () => import('../../app/api/conversation/route'), 'POST'],
    ['conversation/digest', () => import('../../app/api/conversation/digest/route'), 'POST'],
    ['conversation/digests', () => import('../../app/api/conversation/digests/route'), 'GET'],
    ['memory', () => import('../../app/api/memory/route'), 'GET'],
    ['memory/entities', () => import('../../app/api/memory/entities/route'), 'GET'],
    ['memory/entities/confirm', () => import('../../app/api/memory/entities/confirm/route'), 'POST'],
    ['memory/procedural/confirm', () => import('../../app/api/memory/procedural/confirm/route'), 'POST'],
    ['memory/relations', () => import('../../app/api/memory/relations/route'), 'POST'],
    ['memory/topics/fixture/summarize', () => import('../../app/api/memory/topics/[slug]/summarize/route'), 'GET'],
    ['bot-log', () => import('../../app/api/bot-log/route'), 'GET'],
  ];
  it.each(routes.map(([name, load, method]) => ({ name, load, method })))('$method /api/$name: auth first; no request parsing before refusal', async ({ name, load, method }) => {
    const handler = (await load())[method]!;
    const ctx = { params: Promise.resolve({ slug: 'fixture' }) } as never;
    const unauth = new Request('http://localhost/api/' + name, { method });
    expect((await handler(unauth, ctx)).status).toBe(401);
    const req = new Request('http://localhost/api/' + name, {
      method, headers: auth.authHeader, ...(method === 'POST' ? { body: 'invalid JSON' } : {}),
    });
    const parse = vi.spyOn(req, 'json');
    const res = await handler(req, ctx);
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'memory_disabled' });
    expect(parse).not.toHaveBeenCalled();
  });

  it('direct writes, workers, pruning, and backfills cannot bypass the switch', async () => {
    const denied: Array<() => unknown> = [
      () => conversation.logTurn('synthetic-chat', 'user', 'Denied fixture'),
      () => digest.upsertDigest({ session_id: turn.session_id, chat_id: turn.chat_id, summary: 'Denied fixture', turn_count: 1 }),
      () => digest.structuralDigest(turn.session_id),
      () => memory.writeMemory(undefined as never),
      () => graph.appendEntity(entity), () => graph.appendEntityRecord(entity),
      () => graph.appendSupersede(entity.id, 'replacement'), () => graph.appendEntityConfirm(entity.id),
      () => graph.appendRelate(entity.id, 'depends_on', entity.id, 0.9, 'manual', false),
      () => graph.appendConfirmRelate(entity.id, 'depends_on', entity.id),
      () => graph.appendUnrelate(entity.id, 'depends_on', entity.id),
      () => graph.appendResolvedRelate(undefined as never),
      () => graph.confirmEntity(entity.id), () => graph.confirmRelate(entity.id, 'depends_on', entity.id),
      () => graph.rejectRelate(entity.id, 'depends_on', entity.id),
      () => compact.compactGraph(graphFile), () => compact.prunePendingEntities(),
      () => procedural.insertCandidate('workflow', 'Denied fixture', turn.session_id),
      () => procedural.confirmNote(noteId), () => procedural.prunePendingProcedural(),
      () => topics.createThread('denied', 'Denied fixture'),
      () => topics.linkThreadSession('fixture', turn.session_id), () => topics.summarizeThread('fixture'),
      () => maintainer.identifyViaClaude('Denied fixture'),
      () => maintainer.writeStatus(undefined as never),
      () => maintainer.resolutionWorker({ dryRun: false }), () => maintainer.dedupWorker({ dryRun: false }),
      () => maintainer.autoconfirmWorker({ dryRun: false }),
      () => maintainer.repointEdges(new Map(), graphFile),
      () => profile.profileWorker({ dryRun: false }), () => profile.profileWorker({ dryRun: true }),
      () => surfacing.runSurfacing({ dryRun: false }), () => surfacing.runSurfacing({ dryRun: true }),
      () => extraction.runExtraction(undefined as never),
      () => vec.vecInsert(db.getDb(), 'conversation_vec', turn.id, new Float32Array(384)),
      () => vec.vecReplace(db.getDb(), 'conversation_vec', turn.id, new Float32Array(384)),
      () => vec.vecDelete(db.getDb(), 'conversation_vec', turn.id),
      () => vec.vecMetaSet(db.getDb(), 'conversation_vec', turn.id, 1),
      () => backfill.runBackfill([], new Set()), () => backfill.main(['--dry-run']),
      () => backfillEmbeddings.runBackfillEmbeddings({ dryRun: true, concurrency: 1 }),
      () => backfillEmbeddings.main(['--dry-run']),
    ];
    for (const run of denied) {
      await expect(Promise.resolve().then(run)).rejects.toBeInstanceOf(MemoryDisabledError);
    }
    delete process.env.MOT_EMBED_DISABLE;
    expect(embedding.embeddingEnabled()).toBe(false);
    expect(await embedding.embedderAvailable()).toBe(false);
    vec.indexAsync(db.getDb(), 'conversation_vec', turn.id, 'Denied fixture');
    await expect(embedding.embed('Denied fixture')).rejects.toThrow('embedding disabled');
    process.env.MOT_EMBED_DISABLE = '1';
  });

  it.each(['backfill-extraction', 'backfill-embeddings', 'backfill-relations', 'cleanup-entities'])('operator command %s refuses before opening a database', (script) => {
    const unopenedDb = path.join(path.dirname(auth.dbPath), 'must-not-be-created.db');
    const result = spawnSync(process.execPath, ['--import', 'tsx', `scripts/${script}.ts`, '--dry-run'], {
      cwd: process.cwd(), encoding: 'utf8', timeout: 15_000,
      env: { ...process.env, DATABASE_URL: unopenedDb, MOT_MEMORY_DISABLE: '1' },
    });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('M.O.T. memory is disabled');
    expect(fs.existsSync(unopenedDb)).toBe(false);
  });

  it('memory browser pages refuse before loading their stores', async () => {
    // Vitest uses the classic JSX transform; Next supplies its automatic JSX runtime.
    vi.stubGlobal('React', await import('react'));
    const entities = vi.spyOn(graph, 'searchEntities');
    const notes = vi.spyOn(procedural, 'listNotes');
    const threads = vi.spyOn(topics, 'listThreads');
    for (const load of [() => import('../../app/memory/entities/page'),
      () => import('../../app/memory/procedural/page'), () => import('../../app/memory/topics/page')]) {
      const page = (await load()).default();
      expect(page.props.children).toContain('M.O.T. memory is disabled.');
    }
    expect(entities).not.toHaveBeenCalled();
    expect(notes).not.toHaveBeenCalled();
    expect(threads).not.toHaveBeenCalled();
  });
});
