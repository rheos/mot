import { describe, it, expect, afterAll, beforeEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Track 9/10 — the Maintainer MCP tools (maintainer_status, maintainer_run) + the
// status-file helpers (readStatus/writeStatus). Harness: temp MOT_GRAPH_PATH so the status file
// (ontology/maintainer-status.json, derived from the graph dir) lands in an isolated temp dir;
// MOT_EMBED_DISABLE=1 is set suite-wide by vitest.config.
//
// The workers are STUBBED via vi.mock so no test spawns a real `claude -p`, but the real
// readStatus/writeStatus/statusFilePath logic is preserved (importActual) — the status-file
// behaviour under test (zero-state fallback, corrupt-file degrade) is the real implementation.

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mot-maint-mcp-'));
const graphFile = path.join(tmpDir, 'graph.jsonl');
const statusFile = path.join(tmpDir, 'maintainer-status.json');
process.env.MOT_GRAPH_PATH = graphFile;

// Stub only the workers; keep readStatus/writeStatus (and the private statusFilePath they
// use) REAL so the status-file tests exercise the shipped code. Each worker spy returns a valid
// status sub-object and records the {dryRun} it was called with (AC-9).
const resolutionWorker = vi.fn(async (_opts: { dryRun: boolean }) => ({
  last_run: new Date().toISOString(),
  ok: true,
  named_nodes_minted: 3,
  edges_linked: 5,
  batches_failed: 0,
  error: null,
}));
const dedupWorker = vi.fn(async (_opts: { dryRun: boolean }) => ({
  last_run: new Date().toISOString(),
  ok: true,
  entities_merged: 2,
  backup_path: null,
  batches_failed: 0,
  error: null,
}));
const profileWorker = vi.fn((_opts: { dryRun: boolean }) => ({
  last_run: new Date().toISOString(),
  ok: true,
  input_entities: 4,
  items_written: 2,
  output_path: null,
  batches_failed: 0,
  error: null,
  preview_markdown: null,
}));
vi.mock('../../lib/maintainer', async (importActual) => {
  const actual = await importActual<typeof import('../../lib/maintainer')>();
  return {
    ...actual,
    resolutionWorker: (opts: { dryRun: boolean }) => resolutionWorker(opts),
    dedupWorker: (opts: { dryRun: boolean }) => dedupWorker(opts),
  };
});
vi.mock('../../lib/profile', async (importActual) => {
  const actual = await importActual<typeof import('../../lib/profile')>();
  return {
    ...actual,
    profileWorker: (opts: { dryRun: boolean }) => profileWorker(opts),
  };
});

const { callMcpTool } = await import('../../lib/mcp-tools');
const { readStatus } = await import('../../lib/maintainer');

async function call(name: string, args: Record<string, unknown> = {}): Promise<unknown> {
  const content = await callMcpTool(name, args);
  expect(content).toHaveLength(1);
  expect(content[0].type).toBe('text');
  return JSON.parse(content[0].text);
}

beforeEach(() => {
  resolutionWorker.mockClear();
  dedupWorker.mockClear();
  profileWorker.mockClear();
  // Start each test with no status file (a fresh, never-run state).
  fs.rmSync(statusFile, { force: true });
});

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  delete process.env.MOT_GRAPH_PATH;
});

describe('Track 9 — maintainer_status / readStatus (zero-state + corrupt-file degrade)', () => {
  it('AC-8: maintainer_status with no prior run returns a zero-state object (null timestamps), no throw', async () => {
    const res = (await call('maintainer_status')) as {
      resolution: { last_run: string | null; ok: boolean; named_nodes_minted: number };
      dedup: { last_run: string | null; ok: boolean; entities_merged: number };
      profile: { last_run: string | null; ok: boolean; items_written: number };
    };
    expect(res.resolution.last_run).toBeNull();
    expect(res.dedup.last_run).toBeNull();
    expect(res.profile.last_run).toBeNull();
    expect(res.resolution.ok).toBe(false);
    expect(res.dedup.ok).toBe(false);
    expect(res.profile.ok).toBe(false);
    expect(res.resolution.named_nodes_minted).toBe(0);
    expect(res.dedup.entities_merged).toBe(0);
    expect(res.profile.items_written).toBe(0);
  });

  it('W4: readStatus on a corrupt/truncated status file returns zero-state, never throws', () => {
    // Write invalid JSON to the exact status path readStatus resolves.
    fs.writeFileSync(statusFile, '{ "resolution": { "last_run": "2026-');
    const res = readStatus();
    expect(res.resolution.last_run).toBeNull();
    expect(res.dedup.last_run).toBeNull();
    expect(res.profile.last_run).toBeNull();
    expect(res.resolution.named_nodes_minted).toBe(0);
    expect(res.dedup.entities_merged).toBe(0);
    expect(res.profile.items_written).toBe(0);
  });
});

describe('Track 9 — maintainer_run', () => {
  it('AC-9: dry_run:true runs all workers with { dryRun: true }', async () => {
    const res = (await call('maintainer_run', { worker: 'all', dry_run: true })) as {
      resolution: { named_nodes_minted: number };
      dedup: { entities_merged: number };
      profile: { items_written: number };
    };
    expect(resolutionWorker).toHaveBeenCalledWith({ dryRun: true });
    expect(dedupWorker).toHaveBeenCalledWith({ dryRun: true });
    expect(profileWorker).toHaveBeenCalledWith({ dryRun: true });
    // The returned payload carries every worker's summary.
    expect(res.resolution.named_nodes_minted).toBe(3);
    expect(res.dedup.entities_merged).toBe(2);
    expect(res.profile.items_written).toBe(2);
  });

  it('worker:"resolution" runs only the resolution worker', async () => {
    await call('maintainer_run', { worker: 'resolution' });
    expect(resolutionWorker).toHaveBeenCalledTimes(1);
    expect(dedupWorker).not.toHaveBeenCalled();
    expect(profileWorker).not.toHaveBeenCalled();
    // Default dry_run is false → live run.
    expect(resolutionWorker).toHaveBeenCalledWith({ dryRun: false });
  });

  it('worker:"dedup" runs only the dedup worker', async () => {
    await call('maintainer_run', { worker: 'dedup' });
    expect(dedupWorker).toHaveBeenCalledTimes(1);
    expect(resolutionWorker).not.toHaveBeenCalled();
    expect(profileWorker).not.toHaveBeenCalled();
  });

  it('worker:"profile" runs only the profile worker', async () => {
    await call('maintainer_run', { worker: 'profile' });
    expect(profileWorker).toHaveBeenCalledTimes(1);
    expect(profileWorker).toHaveBeenCalledWith({ dryRun: false });
    expect(resolutionWorker).not.toHaveBeenCalled();
    expect(dedupWorker).not.toHaveBeenCalled();
  });

  it('defaults worker to "all" when omitted', async () => {
    await call('maintainer_run', {});
    expect(resolutionWorker).toHaveBeenCalledTimes(1);
    expect(dedupWorker).toHaveBeenCalledTimes(1);
    expect(profileWorker).toHaveBeenCalledTimes(1);
  });
});
