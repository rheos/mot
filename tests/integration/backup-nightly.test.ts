import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Recallatron Track 4 — Prompt 4: the three nightly maintenance steps appended to
// scheduleNightly()'s 02:00 cron callback (lib/backup.ts).
//
// Test reach: the three steps live inside the anonymous callback passed to
// schedule('0 2 * * *', ...) — never exported, and the Reviewability boundary forbids adding a
// new export to lib/backup.ts. So we vi.mock('node-cron') to capture the callback argument
// scheduleNightly() passes to schedule(...), then invoke that captured callback directly.
//
// The three step dependencies (prunePendingProcedural, prunePendingEntities, compactGraph) and
// the DB/graph backup helpers are mocked so the callback is exercised in isolation — no real DB
// or filesystem writes. These module mocks are hoisted, so this file is kept separate from the
// real-DB backup.test.ts (which exercises vacuumInto/backupGraph for real).

// Capture every callback scheduleNightly hands to node-cron's schedule().
const scheduledCallbacks: Array<() => unknown> = [];
vi.mock('node-cron', () => ({
  schedule: vi.fn((_expr: string, cb: () => unknown) => {
    scheduledCallbacks.push(cb);
    return { stop: vi.fn() };
  }),
}));

// Stub the DB so getDb()/vacuumInto don't open a real database.
vi.mock('../../db/client', () => ({
  getDb: vi.fn(() => ({ exec: vi.fn() })),
}));

// Stub the two prune sources and the compactor. Each is a spy so we can assert call order and
// make compactGraph throw for AC-9. prunePendingEntities logs its OWN [MOT/nightly] line, so the
// mock reproduces that log (the callback does not log on its behalf).
const prunePendingProcedural = vi.fn((_n?: number): number => 0);
const prunePendingEntities = vi.fn((_n?: number): void => {
  // eslint-disable-next-line no-console
  console.log('[MOT/nightly] entity prune: 0 candidates marked as pruned');
});
const compactGraph = vi.fn(async (_p: string): Promise<void> => {});
vi.mock('../../lib/procedural', () => ({
  prunePendingProcedural: (n?: number) => prunePendingProcedural(n),
}));
vi.mock('../../lib/graph-compact', () => ({
  prunePendingEntities: (n?: number) => prunePendingEntities(n),
  compactGraph: (p: string) => compactGraph(p),
}));

const { scheduleNightly } = await import('../../lib/backup');

// Resolve and run the single captured nightly callback.
async function runNightly(): Promise<void> {
  scheduledCallbacks.length = 0;
  scheduleNightly();
  expect(scheduledCallbacks).toHaveLength(1);
  await scheduledCallbacks[0]();
}

// Inferred from the initializer — avoids fighting vitest 1.x's spyOn generic constraint.
let logSpy = vi.spyOn(console, 'log');
let errSpy = vi.spyOn(console, 'error');

beforeEach(() => {
  prunePendingProcedural.mockClear();
  prunePendingEntities.mockClear();
  compactGraph.mockClear();
  prunePendingProcedural.mockReturnValue(0);
  compactGraph.mockImplementation(async () => {});
  delete process.env.MOT_GRAPH_PATH;
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  logSpy.mockRestore();
  errSpy.mockRestore();
  delete process.env.MOT_GRAPH_PATH;
});

function loggedLines(): string[] {
  return logSpy.mock.calls.map((c) => String(c[0]));
}

describe('scheduleNightly — Track 4 nightly maintenance steps', () => {
  it('AC-6: logs a [MOT/nightly] line for each of the three steps', async () => {
    // Point MOT_GRAPH_PATH at a definitely-absent file so the compact step takes the skip branch
    // (no real graph file needed) and still emits its [MOT/nightly] line.
    process.env.MOT_GRAPH_PATH = '/nonexistent/mot-nightly-test/graph.jsonl';

    await runNightly();

    const lines = loggedLines();
    // (a) procedural prune
    expect(lines.some((l) => l.includes('[MOT/nightly] procedural prune:'))).toBe(true);
    // (b) entity prune (logged by prunePendingEntities itself)
    expect(lines.some((l) => l.includes('[MOT/nightly] entity prune:'))).toBe(true);
    // (c) compact (skipped here, but still a [MOT/nightly] graph compact line)
    expect(lines.some((l) => l.includes('[MOT/nightly] graph compact:'))).toBe(true);

    expect(prunePendingProcedural).toHaveBeenCalledTimes(1);
    expect(prunePendingEntities).toHaveBeenCalledTimes(1);
  });

  it('AC-9: a compact failure does not abort the two prune steps', async () => {
    // Force the compact path to run AND throw: point at a real >=5MB file, then make
    // compactGraph reject. The per-step try/catch must isolate the failure.
    const os = await import('node:os');
    const fs = await import('node:fs');
    const path = await import('node:path');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mot-nightly-big-'));
    const big = path.join(dir, 'graph.jsonl');
    fs.writeFileSync(big, Buffer.alloc(5 * 1024 * 1024 + 1)); // >= 5MB → compact branch taken
    process.env.MOT_GRAPH_PATH = big;
    compactGraph.mockRejectedValueOnce(new Error('boom'));

    try {
      await runNightly();

      // Both prune steps still ran despite the compact throw.
      expect(prunePendingProcedural).toHaveBeenCalledTimes(1);
      expect(prunePendingEntities).toHaveBeenCalledTimes(1);
      const lines = loggedLines();
      expect(lines.some((l) => l.includes('[MOT/nightly] procedural prune:'))).toBe(true);
      expect(lines.some((l) => l.includes('[MOT/nightly] entity prune:'))).toBe(true);
      // The compact failure was caught and logged to console.error, not rethrown.
      expect(compactGraph).toHaveBeenCalledTimes(1);
      expect(
        errSpy.mock.calls.some((c) => String(c[0]).includes('[MOT/nightly] graph compact failed')),
      ).toBe(true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('EC-3: graph under 5MB → logs the skip line and does NOT call compactGraph', async () => {
    const os = await import('node:os');
    const fs = await import('node:fs');
    const path = await import('node:path');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mot-nightly-small-'));
    const small = path.join(dir, 'graph.jsonl');
    fs.writeFileSync(small, '{"id":"e1"}\n'); // well under 5MB
    process.env.MOT_GRAPH_PATH = small;

    try {
      await runNightly();

      const lines = loggedLines();
      expect(
        lines.some((l) => l.includes('[MOT/nightly] graph compact: skipped (under 5MB threshold)')),
      ).toBe(true);
      expect(compactGraph).not.toHaveBeenCalled();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('EC-3 (absent file): no graph file → skip line and no compactGraph call', async () => {
    process.env.MOT_GRAPH_PATH = '/nonexistent/mot-nightly-absent/graph.jsonl';

    await runNightly();

    const lines = loggedLines();
    expect(
      lines.some((l) => l.includes('[MOT/nightly] graph compact: skipped (under 5MB threshold)')),
    ).toBe(true);
    expect(compactGraph).not.toHaveBeenCalled();
  });
});
