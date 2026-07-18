import { describe, it, expect, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Track 8 Phase 1 — the entity_ingest MCP tool, driven through callMcpTool() directly (NOT
// the HTTP route). Same graph-only harness as entity-curation.test.ts: point MOT_GRAPH_PATH at
// a fresh temp .jsonl BEFORE the first dynamic import of lib/graph or lib/mcp-tools, so the
// tool's idempotency read AND its appendEntity write both resolve to the temp file.
//
// The whole suite runs under MOT_EMBED_DISABLE=1 (already set globally in vitest.config.ts),
// so no vec row is written and no model is downloaded. Do NOT set it again here.
//
// entity_ingest is a Track-2/3 "never throws" tool (AC-12): every sad path returns
// text({ error | skipped }) — a documented error resolves (not rejects) and parses to a typed
// object.

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mot-entity-ingest-'));
const graphFile = path.join(tmpDir, 'graph.jsonl');
process.env.MOT_GRAPH_PATH = graphFile;

const { callMcpTool } = await import('../../lib/mcp-tools');
const { appendEntity } = await import('../../lib/graph');

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  delete process.env.MOT_GRAPH_PATH;
});

// callMcpTool returns ToolContent = [{ type:'text', text: JSON.stringify(data) }]. Parse the
// single text block back into the typed payload the tool produced.
async function call(name: string, args: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  const content = await callMcpTool(name, args);
  expect(content).toHaveLength(1);
  expect(content[0].type).toBe('text');
  return JSON.parse(content[0].text) as Record<string, unknown>;
}

// Count entity-record lines in the temp graph file whose `source` equals the given value.
// Reads the raw JSONL (absent file → 0), mirroring graphEntitySources' per-line read.
function entityLinesWithSource(source: string): number {
  if (!fs.existsSync(graphFile)) return 0;
  return fs
    .readFileSync(graphFile, 'utf8')
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l) => JSON.parse(l) as Record<string, unknown>)
    .filter((rec) => rec.source === source).length;
}

// Total non-empty lines in the graph file (absent file → 0).
function totalLines(): number {
  if (!fs.existsSync(graphFile)) return 0;
  return fs.readFileSync(graphFile, 'utf8').split('\n').filter((l) => l.trim() !== '').length;
}

describe('entity_ingest', () => {
  // Case 1 — confidence boundary (AC-2, EC-7).
  it('rejects confidence 0.84 (no append) and admits the 0.85 boundary', async () => {
    const before = totalLines();
    const rejected = await call('entity_ingest', {
      type: 'Person',
      label: 'Conf Boundary Low',
      confidence: 0.84,
      source: 'gmail:test_conf_low',
    });
    expect(rejected.error).toBe('confidence_below_threshold');
    // The rejected call appended nothing.
    expect(totalLines()).toBe(before);
    expect(entityLinesWithSource('gmail:test_conf_low')).toBe(0);

    const admitted = await call('entity_ingest', {
      type: 'Person',
      label: 'Conf Boundary At',
      confidence: 0.85,
      source: 'gmail:test_conf_boundary',
    });
    expect(admitted.error).toBeUndefined();
    expect(entityLinesWithSource('gmail:test_conf_boundary')).toBe(1);
  });

  // Case 2 — unknown type (AC-3, EC-6).
  it('rejects an unrecognized type with no append', async () => {
    const before = totalLines();
    const result = await call('entity_ingest', {
      type: 'organisation',
      label: 'Unknown Type Co',
      confidence: 0.95,
      source: 'gmail:test_bad_type',
    });
    expect(result.error).toBe('unknown_entity_type');
    // No line appended.
    expect(totalLines()).toBe(before);
    expect(entityLinesWithSource('gmail:test_bad_type')).toBe(0);
  });

  // Case 3 — clean append (AC-4, AC-15).
  it('appends a clean candidate with confirmed:false and the given source', async () => {
    const record = await call('entity_ingest', {
      type: 'Person',
      label: 'ACME Corp',
      confidence: 0.9,
      source: 'gmail:test_msg_clean',
    });
    expect(record.error).toBeUndefined();
    expect(record.confirmed).toBe(false);
    expect(record.source).toBe('gmail:test_msg_clean');
    expect(entityLinesWithSource('gmail:test_msg_clean')).toBe(1);
  });

  // Case 4 — idempotency (AC-5, AC-12 mandated test, EC-1).
  it('is idempotent on source — a repeat call is skipped, not re-appended', async () => {
    const first = await call('entity_ingest', {
      type: 'Person',
      label: 'Idempotent One',
      confidence: 0.9,
      source: 'gmail:test_msg_001',
    });
    expect(first.error).toBeUndefined();

    const second = await call('entity_ingest', {
      type: 'Person',
      label: 'Idempotent One',
      confidence: 0.9,
      source: 'gmail:test_msg_001',
    });
    expect(second.skipped).toBe(true);
    expect(second.reason).toBe('source_already_ingested');

    // Exactly ONE entity for that source.
    expect(entityLinesWithSource('gmail:test_msg_001')).toBe(1);
  });

  // Case 5 — dedup flagging (AC-6, AC-13 mandated test, EC-5).
  it('flags a near-duplicate label via properties.probable_duplicate_of', async () => {
    const seed = appendEntity({
      type: 'Person',
      label: 'Acme Corp',
      properties: {},
      confidence: 0.9,
      source: 'seed:1',
      confirmed: false,
      valid_from: '2026-07-17T00:00:00.000Z',
      valid_until: null,
      superseded_by: null,
    });

    const record = await call('entity_ingest', {
      type: 'Person',
      label: 'Acme Corp', // Levenshtein distance 0 — exact match, well within ≤2.
      confidence: 0.9,
      source: 'gmail:test_msg_dup',
    });
    const props = record.properties as Record<string, unknown>;
    const dupIds = props.probable_duplicate_of as string[];
    expect(Array.isArray(dupIds)).toBe(true);
    expect(dupIds.length).toBeGreaterThan(0);
    expect(dupIds).toContain(seed.id);
  });

  // Case 6 — reason storage (W-4).
  it('persists a provided reason to properties.reason', async () => {
    const record = await call('entity_ingest', {
      type: 'Fact',
      label: 'Invoice Fact',
      confidence: 0.9,
      source: 'gmail:test_msg_reason',
      reason: 'From invoice email',
    });
    const props = record.properties as Record<string, unknown>;
    expect(props.reason).toBe('From invoice email');
  });
});
