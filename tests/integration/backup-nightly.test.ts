import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// The nightly maintenance step appended to scheduleNightly()'s 02:00 cron callback (lib/backup.ts).
//
// As of 2026-07-08 the nightly job NO LONGER disuse-prunes memories. Persistence is a hard product
// requirement: a fact Taylor states once must survive indefinitely, even if never referenced again.
// The old prunePendingProcedural / prunePendingEntities steps deleted unconfirmed, lower-confidence
// candidates after 30 days of NON-USE — exactly the use-or-lose decay the system must not do. Only
// graph compaction runs now, and compaction is safe for persistence: it drops ONLY records that
// were explicitly superseded/corrected (superseded_by !== null), never merely-unused ones.
//
// Test reach: the step lives inside the anonymous callback passed to schedule('0 2 * * *', ...) —
// never exported. So we vi.mock('node-cron') to capture the callback and invoke it directly.

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

// Only compactGraph is still wired into the nightly job. The prune functions are intentionally NOT
// imported by lib/backup.ts anymore (persistence — see the header comment in that file).
const compactGraph = vi.fn(async (_p: string): Promise<void> => {});
vi.mock('../../lib/graph-compact', () => ({
  compactGraph: (p: string) => compactGraph(p),
}));

const { scheduleNightly } = await import('../../lib/backup');

async function runNightly(): Promise<void> {
  scheduledCallbacks.length = 0;
  scheduleNightly();
  expect(scheduledCallbacks).toHaveLength(1);
  await scheduledCallbacks[0]();
}

let logSpy = vi.spyOn(console, 'log');
let errSpy = vi.spyOn(console, 'error');

beforeEach(() => {
  compactGraph.mockClear();
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

describe('scheduleNightly — nightly maintenance (persistence: no disuse prune)', () => {
  it('does NOT disuse-prune — no procedural/entity prune lines are emitted; compaction still runs', async () => {
    // Absent file → compact takes the skip branch (no real graph needed) but still emits its line.
    process.env.MOT_GRAPH_PATH = '/nonexistent/mot-nightly-test/graph.jsonl';

    await runNightly();

    const lines = loggedLines();
    // The old disuse-prune steps are gone: memories are never deleted for going unused.
    expect(lines.some((l) => l.includes('[MOT/nightly] procedural prune'))).toBe(false);
    expect(lines.some((l) => l.includes('[MOT/nightly] entity prune'))).toBe(false);
    // Compaction (the only remaining step) still runs.
    expect(lines.some((l) => l.includes('[MOT/nightly] graph compact:'))).toBe(true);
  });

  it('a compact failure is caught and logged, not rethrown', async () => {
    const os = await import('node:os');
    const fs = await import('node:fs');
    const path = await import('node:path');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mot-nightly-big-'));
    const big = path.join(dir, 'graph.jsonl');
    fs.writeFileSync(big, Buffer.alloc(5 * 1024 * 1024 + 1)); // >= 5MB → compact branch taken
    process.env.MOT_GRAPH_PATH = big;
    compactGraph.mockRejectedValueOnce(new Error('boom'));

    try {
      await runNightly(); // the per-step try/catch must isolate the failure (no throw)

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
