import { describe, it, expect, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Recallatron Track 3 Phase 2 — the curation MCP tools entity_confirm + entity_supersede,
// driven through callMcpTool() directly (NOT the HTTP route).
//
// These two tools are graph-only: they read/append the JSONL store via lib/graph and never
// touch the SQLite DB. So this file uses the graph-only harness (the same lazy-env ordering
// graph.test.ts / the entity_* block of mcp-tools.test.ts rely on): point MOT_GRAPH_PATH at a
// fresh temp .jsonl BEFORE the first dynamic import of lib/graph or lib/mcp-tools.
//
// AC-12 is the load-bearing assertion: each dispatch case returns text(errorObject) on every
// error condition — it NEVER throws. So a documented-error call resolves (not rejects), and the
// returned content parses to a typed { error } object. expectNoThrow asserts exactly that.

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mot-entity-curation-'));
const graphFile = path.join(tmpDir, 'graph.jsonl');
process.env.MOT_GRAPH_PATH = graphFile;

const { callMcpTool } = await import('../../lib/mcp-tools');
const { appendEntity, searchEntities } = await import('../../lib/graph');

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  delete process.env.MOT_GRAPH_PATH;
});

// callMcpTool returns ToolContent = [{ type:'text', text: JSON.stringify(data) }]. Parse the
// single text block back into the typed payload the tool produced.
async function call(name: string, args: Record<string, unknown> = {}): Promise<unknown> {
  const content = await callMcpTool(name, args);
  expect(content).toHaveLength(1);
  expect(content[0].type).toBe('text');
  return JSON.parse(content[0].text);
}

// AC-12 guard: asserts the dispatch case did NOT throw (the call resolves), then parses the
// result. If a case ever throws instead of returning text() of the error, this rejects and the
// test fails — exactly the regression AC-12 guards against. A throw here would surface as
// isError:true at the route; returning text() keeps isError:false.
async function expectNoThrow(name: string, args: Record<string, unknown>): Promise<unknown> {
  const content = await callMcpTool(name, args); // must not reject
  expect(content).toHaveLength(1);
  expect(content[0].type).toBe('text');
  return JSON.parse(content[0].text);
}

// A minimal valid entity record (everything but the generated id), overridable per test.
function entityInput(
  overrides: Partial<Parameters<typeof appendEntity>[0]> = {},
): Parameters<typeof appendEntity>[0] {
  return {
    type: 'Fact',
    label: 'Test entity',
    properties: {},
    valid_from: '2026-06-22T00:00:00.000Z',
    valid_until: null,
    confidence: 0.9,
    source: 'manual',
    superseded_by: null,
    confirmed: true,
    ...overrides,
  };
}

// ── entity_confirm ────────────────────────────────────────────────────────────

describe('entity_confirm', () => {
  it('AC-1: confirms a confirmed:false entity → it leaves the unconfirmed set', async () => {
    const e = appendEntity(entityInput({ label: 'AC1 pending', confirmed: false }));

    // Pre-condition: it shows up under unconfirmedOnly search.
    const before = searchEntities('AC1 pending', undefined, true).map((r) => r.id);
    expect(before).toContain(e.id);

    const updated = await call('entity_confirm', { id: e.id });
    expect((updated as { id: string }).id).toBe(e.id);
    expect((updated as { confirmed: boolean }).confirmed).toBe(true);

    // After confirm it no longer appears in the unconfirmed-only set (AC-1). Use the lib fn
    // directly (NOT entity_search with empty q — Phase 4 will reject empty q at the dispatch layer).
    const after = searchEntities('AC1 pending', undefined, true).map((r) => r.id);
    expect(after).not.toContain(e.id);
  });

  it('AC-2: unknown id → { error: not_found }, does not throw', async () => {
    const result = await expectNoThrow('entity_confirm', { id: 'nonexistent' });
    expect((result as { error: string }).error).toBe('not_found');
  });

  it('AC-3: already-confirmed entity → { error: already_confirmed }, does not throw', async () => {
    const e = appendEntity(entityInput({ label: 'AC3 settled', confirmed: true }));
    const result = await expectNoThrow('entity_confirm', { id: e.id });
    expect((result as { error: string }).error).toBe('already_confirmed');
  });

  it('EC-1: superseded entity → { error: not_found }, does not throw', async () => {
    const old = appendEntity(entityInput({ label: 'EC1 old', confirmed: false }));
    const fresh = appendEntity(entityInput({ label: 'EC1 fresh', confirmed: false }));
    // Supersede via the tool itself.
    await call('entity_supersede', { id: old.id, superseded_by_id: fresh.id });

    const result = await expectNoThrow('entity_confirm', { id: old.id });
    expect((result as { error: string }).error).toBe('not_found');
  });
});

// ── entity_supersede ──────────────────────────────────────────────────────────

describe('entity_supersede', () => {
  it('AC-4: supersede(id, targetId) → entity_search drops id, target still active', async () => {
    const old = appendEntity(entityInput({ label: 'AC4 replaced', confirmed: true }));
    const fresh = appendEntity(entityInput({ label: 'AC4 replacement', confirmed: true }));

    const ok = await call('entity_supersede', { id: old.id, superseded_by_id: fresh.id });
    expect(ok).toEqual({ ok: true, id: old.id, superseded_by_id: fresh.id });

    // entity_search returns active records only by default → old drops out, target remains.
    const replaced = (await call('entity_search', { q: 'AC4 replaced' })) as { id: string }[];
    expect(replaced.map((e) => e.id)).not.toContain(old.id);

    const replacement = (await call('entity_search', { q: 'AC4 replacement' })) as { id: string }[];
    expect(replacement.map((e) => e.id)).toContain(fresh.id);
  });

  it('AC-5: unknown id → { error: not_found, id }, does not throw', async () => {
    const target = appendEntity(entityInput({ label: 'AC5 target a', confirmed: true }));
    const result = await expectNoThrow('entity_supersede', {
      id: 'no-such-id',
      superseded_by_id: target.id,
    });
    expect(result).toEqual({ error: 'not_found', id: 'no-such-id' });
  });

  it('AC-5: unknown target → { error: target_not_found, superseded_by_id }, does not throw', async () => {
    const src = appendEntity(entityInput({ label: 'AC5 src', confirmed: true }));
    const result = await expectNoThrow('entity_supersede', {
      id: src.id,
      superseded_by_id: 'no-such-target',
    });
    expect(result).toEqual({ error: 'target_not_found', superseded_by_id: 'no-such-target' });
  });

  it('AC-5: equal ids → { error: self_supersede }, does not throw', async () => {
    const e = appendEntity(entityInput({ label: 'AC5 self', confirmed: true }));
    const result = await expectNoThrow('entity_supersede', {
      id: e.id,
      superseded_by_id: e.id,
    });
    expect((result as { error: string }).error).toBe('self_supersede');
  });
});
