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

// As of Track 7, scheduleNightly() registers TWO schedule() calls (02:00 maintenance + the
// SURFACING_SEND_HOUR daytime surfacing cron). Capture callbacks KEYED BY CRON EXPRESSION so the
// existing tests pin to '0 2 * * *' by name, regardless of registration order.
const scheduledCallbacks: Record<string, () => unknown> = {};
// Track 7 — also CAPTURE the options (third) arg per cron expression. The surfacing schedule() call
// passes { timezone } as its third arg and that arg is LOAD-BEARING (without it the UTC prod box
// fires '0 8 * * *' at 08:00 UTC ≈ 00:00–01:00 Pacific, inside quiet hours → silently inert forever).
// A node-cron mock that DISCARDED the third arg would keep every test green if someone deleted
// { timezone }; capturing it lets the regression-guard test below fail on that drop.
const scheduledOptions: Record<string, unknown> = {};
vi.mock('node-cron', () => ({
  schedule: vi.fn((expr: string, cb: () => unknown, options?: unknown) => {
    scheduledCallbacks[expr] = cb;
    scheduledOptions[expr] = options;
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

// Track 9/10 — mock the maintainer workers so the nightly wiring is tested in isolation (no real
// claude -p, no graph writes). Each is a vi.fn returning a valid worker-status object by default;
// individual tests override with mockRejectedValueOnce to prove the per-step catch-isolation (AC-10).
const resolutionWorker = vi.fn(async (_opts: { dryRun: boolean }) => ({
  last_run: new Date().toISOString(),
  ok: true as boolean,
  named_nodes_minted: 0,
  edges_linked: 0,
  batches_failed: 0,
  error: null as string | null,
}));
const dedupWorker = vi.fn(async (_opts: { dryRun: boolean }) => ({
  last_run: new Date().toISOString(),
  ok: true,
  entities_merged: 0,
  backup_path: null,
  batches_failed: 0,
  error: null,
}));
const autoconfirmWorker = vi.fn((_opts: { dryRun: boolean }) => ({
  last_run: new Date().toISOString(),
  ok: true,
  candidates_scanned: 0,
  entities_confirmed: 0,
  error: null,
}));
vi.mock('../../lib/maintainer', () => ({
  resolutionWorker: (opts: { dryRun: boolean }) => resolutionWorker(opts),
  dedupWorker: (opts: { dryRun: boolean }) => dedupWorker(opts),
  autoconfirmWorker: (opts: { dryRun: boolean }) => autoconfirmWorker(opts),
  readStatus: vi.fn(),
  writeStatus: vi.fn(),
}));

const profileWorker = vi.fn((_opts: { dryRun: boolean }) => ({
  last_run: new Date().toISOString(),
  ok: true,
  input_entities: 0,
  items_written: 0,
  output_path: null,
  batches_failed: 0,
  error: null,
  preview_markdown: null,
}));
vi.mock('../../lib/profile', () => ({
  profileWorker: (opts: { dryRun: boolean }) => profileWorker(opts),
}));

// The nightly failure-monitoring push (lib/maintainer-health.ts) — mocked so this file tests only
// the WIRING (each worker's returned status is forwarded, a thrown error is also reported) without
// touching a real ticket DB; lib/maintainer-health.test.ts covers the ticket create/dedup/close
// behavior itself against a real temp DB.
const reportWorkerHealth = vi.fn();
vi.mock('../../lib/maintainer-health', () => ({
  reportWorkerHealth: (worker: string, status: unknown) => reportWorkerHealth(worker, status),
}));

// The deploy-drift alarm (lib/deploy-drift.ts) — mocked for the same reason: this file tests the
// WIRING (it runs, it runs FIRST, and a throw from it cannot abort the rest of the nightly job).
// deploy-drift.test.ts and deploy-drift-alerting.test.ts cover the check and its tickets.
const runDeployDriftCheck = vi.fn(async () => ({ ok: true, drifted: false }));
vi.mock('../../lib/deploy-drift', () => ({
  runDeployDriftCheck: () => runDeployDriftCheck(),
}));

// Track 7 — mock runSurfacing so the surfacing cron wiring is tested in isolation (no real scan,
// no graph read, no send). Default: a valid zero-state summary; individual tests override.
const runSurfacing = vi.fn(async (_opts?: { dryRun?: boolean; horizonDays?: number }) => ({
  scanned: 0,
  wouldSurface: [],
  sent: 0,
  skipped: 0,
  disabled: false,
}));
vi.mock('../../lib/surfacing', () => ({
  runSurfacing: (opts?: { dryRun?: boolean; horizonDays?: number }) => runSurfacing(opts),
}));

const { scheduleNightly } = await import('../../lib/backup');

async function runNightly(): Promise<void> {
  for (const key of Object.keys(scheduledCallbacks)) {
    delete scheduledCallbacks[key];
  }
  for (const key of Object.keys(scheduledOptions)) {
    delete scheduledOptions[key];
  }
  scheduleNightly();
  // Both crons must register.
  expect(Object.keys(scheduledCallbacks)).toHaveLength(2);
  expect(scheduledCallbacks['0 2 * * *']).toBeDefined();
  // Run the 02:00 maintenance callback (the subject of all existing tests).
  await scheduledCallbacks['0 2 * * *']();
}

let logSpy = vi.spyOn(console, 'log');
let errSpy = vi.spyOn(console, 'error');

beforeEach(() => {
  compactGraph.mockClear();
  compactGraph.mockImplementation(async () => {});
  resolutionWorker.mockClear();
  resolutionWorker.mockImplementation(async () => ({
    last_run: new Date().toISOString(),
    ok: true,
    named_nodes_minted: 0,
    edges_linked: 0,
    batches_failed: 0,
    error: null,
  }));
  dedupWorker.mockClear();
  dedupWorker.mockImplementation(async () => ({
    last_run: new Date().toISOString(),
    ok: true,
    entities_merged: 0,
    backup_path: null,
    batches_failed: 0,
    error: null,
  }));
  autoconfirmWorker.mockClear();
  autoconfirmWorker.mockImplementation((_opts: { dryRun: boolean }) => ({
    last_run: new Date().toISOString(),
    ok: true,
    candidates_scanned: 0,
    entities_confirmed: 0,
    error: null,
  }));
  profileWorker.mockClear();
  profileWorker.mockImplementation((_opts: { dryRun: boolean }) => ({
    last_run: new Date().toISOString(),
    ok: true,
    input_entities: 0,
    items_written: 0,
    output_path: null,
    batches_failed: 0,
    error: null,
    preview_markdown: null,
  }));
  runSurfacing.mockClear();
  runSurfacing.mockImplementation(async () => ({
    scanned: 0,
    wouldSurface: [],
    sent: 0,
    skipped: 0,
    disabled: false,
  }));
  reportWorkerHealth.mockClear();
  runDeployDriftCheck.mockClear();
  runDeployDriftCheck.mockImplementation(async () => ({ ok: true, drifted: false }));
  delete process.env.MOT_GRAPH_PATH;
  delete process.env.MAINTAINER_RESOLUTION_DISABLE;
  delete process.env.MAINTAINER_DEDUP_DISABLE;
  delete process.env.MAINTAINER_AUTOCONFIRM_DISABLE;
  delete process.env.MAINTAINER_PROFILE_DISABLE;
  delete process.env.SURFACING_ENABLE;
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  logSpy.mockRestore();
  errSpy.mockRestore();
  delete process.env.MOT_GRAPH_PATH;
  delete process.env.MAINTAINER_RESOLUTION_DISABLE;
  delete process.env.MAINTAINER_DEDUP_DISABLE;
  delete process.env.MAINTAINER_AUTOCONFIRM_DISABLE;
  delete process.env.MAINTAINER_PROFILE_DISABLE;
  delete process.env.SURFACING_ENABLE;
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

describe('scheduleNightly — Maintainer workers (isolation + disable switches)', () => {
  // All these tests use the absent-file path so compact takes its skip branch (no real graph
  // needed); the maintainer steps run regardless of graph size.
  beforeEach(() => {
    process.env.MOT_GRAPH_PATH = '/nonexistent/mot-nightly-maint/graph.jsonl';
  });

  it('AC-10/FR-12: resolution worker failure does NOT block the dedup worker', async () => {
    resolutionWorker.mockRejectedValueOnce(new Error('resolution boom'));

    await runNightly(); // the per-step catch must isolate it (no throw out of runNightly)

    // dedup still ran despite resolution throwing.
    expect(dedupWorker).toHaveBeenCalledTimes(1);
    expect(dedupWorker).toHaveBeenCalledWith({ dryRun: false });
    expect(profileWorker).toHaveBeenCalledTimes(1);
    expect(
      errSpy.mock.calls.some((c) =>
        String(c[0]).includes('[MOT/nightly] resolution worker failed'),
      ),
    ).toBe(true);
    // The thrown error is still pushed through the health monitor — a worker that crashes outright
    // must page just as loudly as one that returns ok:false from its own per-batch catch.
    expect(reportWorkerHealth).toHaveBeenCalledWith('resolution', {
      ok: false,
      error: expect.stringContaining('resolution boom'),
    });
  });

  it('AC-10/FR-12: dedup worker failure is caught and logged, not rethrown', async () => {
    dedupWorker.mockRejectedValueOnce(new Error('dedup boom'));

    await runNightly(); // completes without throwing

    expect(resolutionWorker).toHaveBeenCalledTimes(1);
    expect(profileWorker).toHaveBeenCalledTimes(1);
    expect(
      errSpy.mock.calls.some((c) => String(c[0]).includes('[MOT/nightly] dedup worker failed')),
    ).toBe(true);
    expect(reportWorkerHealth).toHaveBeenCalledWith('dedup', {
      ok: false,
      error: expect.stringContaining('dedup boom'),
    });
  });

  it('AC-10/FR-12: autoconfirm worker failure is caught and logged; profile still runs', async () => {
    autoconfirmWorker.mockImplementationOnce(() => {
      throw new Error('autoconfirm boom');
    });

    await runNightly();

    // The downstream profile worker is unaffected — the per-step catch isolates autoconfirm.
    expect(profileWorker).toHaveBeenCalledTimes(1);
    expect(
      errSpy.mock.calls.some((c) =>
        String(c[0]).includes('[MOT/nightly] autoconfirm worker failed'),
      ),
    ).toBe(true);
    expect(reportWorkerHealth).toHaveBeenCalledWith('autoconfirm', {
      ok: false,
      error: expect.stringContaining('autoconfirm boom'),
    });
  });

  it('AC-10/FR-12: profile worker failure is caught and logged, not rethrown', async () => {
    profileWorker.mockImplementationOnce(() => {
      throw new Error('profile boom');
    });

    await runNightly();

    expect(resolutionWorker).toHaveBeenCalledTimes(1);
    expect(dedupWorker).toHaveBeenCalledTimes(1);
    expect(autoconfirmWorker).toHaveBeenCalledTimes(1);
    expect(
      errSpy.mock.calls.some((c) => String(c[0]).includes('[MOT/nightly] profile worker failed')),
    ).toBe(true);
    expect(reportWorkerHealth).toHaveBeenCalledWith('profile', {
      ok: false,
      error: expect.stringContaining('profile boom'),
    });
  });

  it('AC-7/FR-14: MAINTAINER_RESOLUTION_DISABLE=1 skips the resolution worker (log line, no call)', async () => {
    process.env.MAINTAINER_RESOLUTION_DISABLE = '1';

    await runNightly();

    expect(resolutionWorker).not.toHaveBeenCalled();
    // The dedup worker is unaffected — still runs.
    expect(dedupWorker).toHaveBeenCalledTimes(1);
    expect(profileWorker).toHaveBeenCalledTimes(1);
    expect(
      loggedLines().some((l) => l.includes('resolution worker disabled — skipping')),
    ).toBe(true);
    // A disabled worker never ran, so there is nothing to report — no phantom health call.
    expect(reportWorkerHealth).not.toHaveBeenCalledWith('resolution', expect.anything());
  });

  it('AC-7/FR-14: MAINTAINER_DEDUP_DISABLE=1 skips the dedup worker (log line, no call)', async () => {
    process.env.MAINTAINER_DEDUP_DISABLE = '1';

    await runNightly();

    expect(dedupWorker).not.toHaveBeenCalled();
    // The resolution worker is unaffected — still runs.
    expect(resolutionWorker).toHaveBeenCalledTimes(1);
    expect(profileWorker).toHaveBeenCalledTimes(1);
    expect(loggedLines().some((l) => l.includes('dedup worker disabled — skipping'))).toBe(true);
  });

  it('AC-7/FR-14: MAINTAINER_AUTOCONFIRM_DISABLE=1 skips the autoconfirm worker (log line, no call)', async () => {
    process.env.MAINTAINER_AUTOCONFIRM_DISABLE = '1';

    await runNightly();

    expect(autoconfirmWorker).not.toHaveBeenCalled();
    // The neighbours are unaffected — both still run.
    expect(dedupWorker).toHaveBeenCalledTimes(1);
    expect(profileWorker).toHaveBeenCalledTimes(1);
    expect(loggedLines().some((l) => l.includes('autoconfirm worker disabled — skipping'))).toBe(
      true,
    );
  });

  it('AC-7/FR-14: MAINTAINER_PROFILE_DISABLE=1 skips the profile worker (log line, no call)', async () => {
    process.env.MAINTAINER_PROFILE_DISABLE = '1';

    await runNightly();

    expect(profileWorker).not.toHaveBeenCalled();
    expect(resolutionWorker).toHaveBeenCalledTimes(1);
    expect(dedupWorker).toHaveBeenCalledTimes(1);
    expect(autoconfirmWorker).toHaveBeenCalledTimes(1);
    expect(loggedLines().some((l) => l.includes('profile worker disabled — skipping'))).toBe(true);
  });

  it('all workers run LIVE (dryRun:false) in the normal nightly path', async () => {
    await runNightly();

    expect(resolutionWorker).toHaveBeenCalledWith({ dryRun: false });
    expect(dedupWorker).toHaveBeenCalledWith({ dryRun: false });
    expect(autoconfirmWorker).toHaveBeenCalledWith({ dryRun: false });
    expect(profileWorker).toHaveBeenCalledWith({ dryRun: false });
  });
});

describe('scheduleNightly — health monitoring (lib/maintainer-health.ts wiring)', () => {
  beforeEach(() => {
    process.env.MOT_GRAPH_PATH = '/nonexistent/mot-nightly-health/graph.jsonl';
  });

  it('forwards each worker\'s own returned status to reportWorkerHealth', async () => {
    await runNightly();

    expect(reportWorkerHealth).toHaveBeenCalledWith(
      'resolution',
      expect.objectContaining({ ok: true }),
    );
    expect(reportWorkerHealth).toHaveBeenCalledWith('dedup', expect.objectContaining({ ok: true }));
    expect(reportWorkerHealth).toHaveBeenCalledWith(
      'autoconfirm',
      expect.objectContaining({ ok: true }),
    );
    expect(reportWorkerHealth).toHaveBeenCalledWith(
      'profile',
      expect.objectContaining({ ok: true }),
    );
  });

  it('a worker returning ok:false (its own per-batch catch, not a throw) is still forwarded', async () => {
    resolutionWorker.mockImplementationOnce(async () => ({
      last_run: new Date().toISOString(),
      ok: false,
      named_nodes_minted: 0,
      edges_linked: 0,
      batches_failed: 52,
      error: 'claude -p exited null: ',
    }));

    await runNightly();

    expect(reportWorkerHealth).toHaveBeenCalledWith(
      'resolution',
      expect.objectContaining({ ok: false, batches_failed: 52 }),
    );
  });
});

describe('scheduleNightly — Track 7 surfacing cron registration', () => {
  it('registers TWO schedule() calls: one at 0 2 * * * and one at the daytime hour', async () => {
    for (const key of Object.keys(scheduledCallbacks)) {
      delete scheduledCallbacks[key];
    }
    scheduleNightly();
    expect(Object.keys(scheduledCallbacks)).toHaveLength(2);
    expect(scheduledCallbacks['0 2 * * *']).toBeDefined();
    // The daytime cron key depends on SURFACING_SEND_HOUR (default 8).
    const sendHour = process.env.SURFACING_SEND_HOUR ?? '8';
    const dayKey = `0 ${Number.parseInt(sendHour, 10)} * * *`;
    expect(scheduledCallbacks[dayKey]).toBeDefined();
  });

  it('the daytime cron callback invokes runSurfacing({ dryRun: false })', async () => {
    for (const key of Object.keys(scheduledCallbacks)) {
      delete scheduledCallbacks[key];
    }
    scheduleNightly();
    const sendHour = process.env.SURFACING_SEND_HOUR ?? '8';
    const dayKey = `0 ${Number.parseInt(sendHour, 10)} * * *`;
    expect(scheduledCallbacks[dayKey]).toBeDefined();
    runSurfacing.mockClear();
    await scheduledCallbacks[dayKey]();
    expect(runSurfacing).toHaveBeenCalledWith({ dryRun: false });
  });

  it('a runSurfacing failure is caught and does NOT throw out of the daytime callback', async () => {
    for (const key of Object.keys(scheduledCallbacks)) {
      delete scheduledCallbacks[key];
    }
    scheduleNightly();
    const sendHour = process.env.SURFACING_SEND_HOUR ?? '8';
    const dayKey = `0 ${Number.parseInt(sendHour, 10)} * * *`;
    runSurfacing.mockRejectedValueOnce(new Error('surfacing boom'));
    await expect(scheduledCallbacks[dayKey]()).resolves.not.toThrow();
  });

  // ── REGRESSION GUARD — the load-bearing { timezone } third arg on the surfacing cron ─────────
  // Without { timezone }, the UTC prod box fires '0 8 * * *' at 08:00 UTC (≈ 00:00–01:00 Pacific,
  // inside the 21→08 quiet window) → runSurfacing defers every send forever, silently. This test
  // fails if a future change drops that arg. It also pins that the 02:00 maintenance call stays
  // optionless (it has no TZ requirement).
  it('passes { timezone } to the surfacing schedule() call, and NO options to the 02:00 maintenance call', async () => {
    for (const key of Object.keys(scheduledCallbacks)) {
      delete scheduledCallbacks[key];
    }
    for (const key of Object.keys(scheduledOptions)) {
      delete scheduledOptions[key];
    }
    scheduleNightly();

    const sendHour = process.env.SURFACING_SEND_HOUR ?? '8';
    const dayKey = `0 ${Number.parseInt(sendHour, 10)} * * *`;

    // The surfacing cron got an options object with a defined timezone.
    const surfacingOpts = scheduledOptions[dayKey] as { timezone?: unknown } | undefined;
    expect(surfacingOpts).toBeDefined();
    expect(surfacingOpts?.timezone).toBeDefined();

    // The 02:00 maintenance cron stays optionless (no TZ requirement — it runs at 02:00 UTC).
    expect(scheduledOptions['0 2 * * *']).toBeUndefined();
  });
});

// ── Deploy-drift alarm wiring (lib/deploy-drift.ts) ──────────────────────────────────────────
// Production sat five days behind main on 2026-09-18 with nothing watching. The check now rides
// this cron, and these tests pin the three things the wiring has to guarantee.
describe('scheduleNightly — deploy-drift alarm', () => {
  it('runs the drift check once in the nightly pass', async () => {
    await runNightly();
    expect(runDeployDriftCheck).toHaveBeenCalledTimes(1);
  });

  it('runs it BEFORE the backup, so a later hang cannot swallow the report', async () => {
    const order: string[] = [];
    runDeployDriftCheck.mockImplementation(async () => {
      order.push('drift');
      return { ok: true, drifted: false };
    });
    compactGraph.mockImplementation(async () => {
      order.push('compact');
    });
    resolutionWorker.mockImplementation(async () => {
      order.push('resolution');
      return {
        last_run: new Date().toISOString(),
        ok: true,
        named_nodes_minted: 0,
        edges_linked: 0,
        batches_failed: 0,
        error: null,
      };
    });

    await runNightly();
    expect(order[0]).toBe('drift');
    expect(order).toContain('resolution');
  });

  it('a throw from the drift check is caught and the rest of the nightly job still runs', async () => {
    runDeployDriftCheck.mockRejectedValueOnce(new Error('github exploded'));

    await expect(runNightly()).resolves.not.toThrow();
    // The workers downstream of it all still ran.
    expect(resolutionWorker).toHaveBeenCalledTimes(1);
    expect(dedupWorker).toHaveBeenCalledTimes(1);
    expect(autoconfirmWorker).toHaveBeenCalledTimes(1);
    expect(profileWorker).toHaveBeenCalledTimes(1);
    expect(
      errSpy.mock.calls.some((c) =>
        String(c[0]).includes('[MOT/nightly] deploy-drift check failed'),
      ),
    ).toBe(true);
  });
});
