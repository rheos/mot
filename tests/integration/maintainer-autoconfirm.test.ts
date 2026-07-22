import { describe, it, expect, afterAll, beforeEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Track 11 — auto-confirm worker (lib/maintainer). Pure code, NO `claude -p`: the promotion gate is
// deterministic, so every test runs the REAL worker against a temp graph resolved via MOT_GRAPH_PATH.
// `now` is injected for a deterministic age gate; env knobs are set per-case to prove tunability.

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mot-autoconfirm-'));
const graphFile = path.join(tmpDir, 'graph.jsonl');
const statusFile = path.join(tmpDir, 'maintainer-status.json');
process.env.MOT_GRAPH_PATH = graphFile;

const { appendEntity, loadGraph } = await import('../../lib/graph');
const { autoconfirmWorker, readStatus } = await import('../../lib/maintainer');

// A fixed "now" so the age gate is deterministic. Entities are seeded relative to this.
const NOW = new Date('2026-07-21T00:00:00.000Z');
const daysAgo = (n: number): string =>
  new Date(NOW.getTime() - n * 86_400_000).toISOString();

function seed(opts: {
  label: string;
  confidence?: number;
  confirmed?: boolean;
  validFrom?: string;
  validUntil?: string | null;
  properties?: Record<string, unknown>;
}) {
  return appendEntity({
    type: 'Fact',
    label: opts.label,
    properties: opts.properties ?? {},
    confidence: opts.confidence ?? 0.95,
    confirmed: opts.confirmed ?? false,
    source: 'session:test',
    valid_from: opts.validFrom ?? daysAgo(30),
    valid_until: opts.validUntil ?? null,
    superseded_by: null,
  });
}

const confirmedIds = (): Set<string> =>
  new Set(loadGraph().filter((e) => e.confirmed === true).map((e) => e.id));

beforeEach(() => {
  fs.writeFileSync(graphFile, '');
  fs.rmSync(statusFile, { force: true });
  delete process.env.MAINTAINER_AUTOCONFIRM_MIN_CONFIDENCE;
  delete process.env.MAINTAINER_AUTOCONFIRM_MIN_AGE_DAYS;
});

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  delete process.env.MOT_GRAPH_PATH;
  delete process.env.MAINTAINER_AUTOCONFIRM_MIN_CONFIDENCE;
  delete process.env.MAINTAINER_AUTOCONFIRM_MIN_AGE_DAYS;
});

describe('autoconfirmWorker — promotion gate', () => {
  it('confirms stable high-confidence candidates; skips low-confidence, too-young, dup, and expired', () => {
    const good = seed({ label: 'SampleApp is an active SaaS', confidence: 0.95, validFrom: daysAgo(30) });
    const lowConf = seed({ label: 'weak signal', confidence: 0.86, validFrom: daysAgo(30) });
    const tooYoung = seed({ label: 'fresh fact', confidence: 0.99, validFrom: daysAgo(2) });
    const dup = seed({
      label: 'probable duplicate',
      confidence: 0.99,
      validFrom: daysAgo(30),
      properties: { probable_duplicate_of: ['some-other-id'] },
    });
    const expired = seed({
      label: 'expired fact',
      confidence: 0.99,
      validFrom: daysAgo(30),
      validUntil: daysAgo(1),
    });

    const status = autoconfirmWorker({ dryRun: false, now: NOW });

    expect(status.ok).toBe(true);
    expect(status.candidates_scanned).toBe(1);
    expect(status.entities_confirmed).toBe(1);

    const confirmed = confirmedIds();
    expect(confirmed.has(good.id)).toBe(true);
    expect(confirmed.has(lowConf.id)).toBe(false);
    expect(confirmed.has(tooYoung.id)).toBe(false);
    expect(confirmed.has(dup.id)).toBe(false);
    expect(confirmed.has(expired.id)).toBe(false);
  });

  it('is idempotent — a second pass confirms nothing new', () => {
    seed({ label: 'stable fact', confidence: 0.95, validFrom: daysAgo(30) });

    const first = autoconfirmWorker({ dryRun: false, now: NOW });
    expect(first.entities_confirmed).toBe(1);

    const second = autoconfirmWorker({ dryRun: false, now: NOW });
    // Already confirmed → no longer a candidate on the re-scan.
    expect(second.candidates_scanned).toBe(0);
    expect(second.entities_confirmed).toBe(0);
    expect(confirmedIds().size).toBe(1);
  });

  it('dry_run scans + counts a would-confirm set but writes nothing (no graph mutation, no status)', () => {
    seed({ label: 'stable fact', confidence: 0.95, validFrom: daysAgo(30) });

    const status = autoconfirmWorker({ dryRun: true, now: NOW });
    expect(status.candidates_scanned).toBe(1);
    expect(status.entities_confirmed).toBe(1); // would-confirm count

    // Nothing was actually confirmed, and no status file was written.
    expect(confirmedIds().size).toBe(0);
    expect(readStatus().autoconfirm.last_run).toBeNull();
  });

  it('persists its sub-object to the status file on a live run', () => {
    seed({ label: 'stable fact', confidence: 0.95, validFrom: daysAgo(30) });
    autoconfirmWorker({ dryRun: false, now: NOW });

    const persisted = readStatus().autoconfirm;
    expect(persisted.last_run).not.toBeNull();
    expect(persisted.ok).toBe(true);
    expect(persisted.entities_confirmed).toBe(1);
  });

  it('env knobs are read at call time — lowering the age floor promotes a young fact', () => {
    const young = seed({ label: 'fresh but strong', confidence: 0.95, validFrom: daysAgo(1) });

    // Default 7-day floor would skip it.
    expect(autoconfirmWorker({ dryRun: true, now: NOW }).candidates_scanned).toBe(0);

    // Drop the floor to 0 days → it now qualifies.
    process.env.MAINTAINER_AUTOCONFIRM_MIN_AGE_DAYS = '0';
    const status = autoconfirmWorker({ dryRun: false, now: NOW });
    expect(status.entities_confirmed).toBe(1);
    expect(confirmedIds().has(young.id)).toBe(true);
  });

  it('env knob raises the confidence floor — a 0.9 fact is skipped at a 0.95 floor', () => {
    seed({ label: 'borderline', confidence: 0.9, validFrom: daysAgo(30) });
    process.env.MAINTAINER_AUTOCONFIRM_MIN_CONFIDENCE = '0.95';
    expect(autoconfirmWorker({ dryRun: false, now: NOW }).candidates_scanned).toBe(0);
  });
});
