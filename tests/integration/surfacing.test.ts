import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Track 7 Prompt 2 — the surfacing scan (lib/surfacing.ts). Harness mirrors the maintainer tests:
//   - MOT_EMBED_DISABLE=1 (no vec extension needed).
//   - setupTempDb applies 0000+0001; we apply the remaining hand-written migrations through
//     0009_surfaced_ledger.sql so the ledger table exists (skip 0007_vec.sql — no extension).
//   - MOT_GRAPH_PATH points at a temp JSONL; each test resets it and writes seeded confirmed
//     Deadline EntityRecord lines.
//   - sendTelegramNotify is mocked (vi.mock) so no real Telegram call fires; the mock's call count
//     is the send assertion, and it can be made to throw (AC-11).
// runSurfacing is called DIRECTLY (not via cron/MCP dispatch), except AC-13 which also exercises
// callMcpTool('surfacing_preview').
process.env.MOT_EMBED_DISABLE = '1';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mot-surfacing-'));
const graphFile = path.join(tmpDir, 'graph.jsonl');
process.env.MOT_GRAPH_PATH = graphFile;

// Mock the send helper. Expose the mock so tests inspect call count / simulate throw. Both exports
// lib/surfacing imports (sendTelegramNotify + _truncateBriefing) are provided; the real
// _truncateBriefing is trivial enough to reimplement as identity for the test (no >4096 case here).
const sendMock = vi.fn(async (_text: string): Promise<void> => undefined);
vi.mock('../../lib/notify', () => ({
  sendTelegramNotify: (text: string) => sendMock(text),
  _truncateBriefing: (text: string) => text,
}));

const { setupTempDb, cleanupTempDb } = await import('./_helpers');

// setupTempDb sets DATABASE_URL + applies 0000/0001. Apply the rest up through 0009 on a temp
// connection, then close it so getDb() (lib/surfacing) opens the same file fresh.
const dbPath = setupTempDb('surfacing');
{
  const seed = new Database(dbPath);
  const migrationsFolder = path.join(process.cwd(), 'db/migrations');
  for (const name of [
    '0003_conversation_fts.sql',
    '0004_topic_threads.sql',
    '0005_procedural_notes.sql',
    '0006_memory_fts.sql',
    '0008_relation_draft.sql',
    '0009_surfaced_ledger.sql',
  ]) {
    seed.exec(fs.readFileSync(path.join(migrationsFolder, name), 'utf8'));
  }
  seed.close();
}

const surfacingModule = await import('../../lib/surfacing');
const { runSurfacing } = surfacingModule;
const { callMcpTool } = await import('../../lib/mcp-tools');
const { getDb } = await import('../../db/client');
type EntityRecord = import('../../lib/graph').EntityRecord;

afterAll(() => {
  cleanupTempDb(dbPath);
  fs.rmSync(tmpDir, { recursive: true, force: true });
  delete process.env.MOT_GRAPH_PATH;
});

// ── seeding helpers ───────────────────────────────────────────────────────────
function resetGraph(): void {
  fs.mkdirSync(path.dirname(graphFile), { recursive: true });
  fs.writeFileSync(graphFile, '');
}

function clearLedger(): void {
  getDb().prepare('DELETE FROM surfaced_ledger').run();
}

let idCounter = 0;
function nextId(): string {
  idCounter += 1;
  return `ent${idCounter}`;
}

// A confirmed Deadline entity (the shape that surfaces). Overridable per test.
function deadline(overrides: Partial<EntityRecord> = {}): EntityRecord {
  return {
    id: nextId(),
    type: 'Deadline',
    label: 'Test deadline',
    properties: {},
    valid_from: '2026-06-01T00:00:00.000Z',
    valid_until: null,
    confidence: 0.95,
    source: 'session:seed',
    superseded_by: null,
    confirmed: true,
    ...overrides,
  };
}

function writeGraph(entities: EntityRecord[]): void {
  resetGraph();
  fs.writeFileSync(graphFile, entities.map((e) => JSON.stringify(e)).join('\n') + '\n');
}

// A YYYY-MM-DD string N days from today in the surfacing TZ (default America/Vancouver). We compute
// against the SAME nowInTz the scan uses so daysOut is exactly N regardless of the box clock.
function ymdDaysOut(n: number): string {
  // runSurfacing anchors "today" at nowInTz(tz).ymd → midnight UTC of that local date. Mirror it.
  const tz = process.env.SURFACING_TZ ?? 'America/Vancouver';
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date());
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  const todayMs = Date.parse(`${get('year')}-${get('month')}-${get('day')}T00:00:00Z`);
  return new Date(todayMs + n * 86_400_000).toISOString().slice(0, 10);
}

beforeEach(() => {
  resetGraph();
  clearLedger();
  sendMock.mockReset();
  sendMock.mockImplementation(async () => undefined);
  process.env.SURFACING_ENABLE = '1';
  // Neutralise quiet-hours for the default (non-quiet-specific) tests: nothing is quiet.
  process.env.SURFACING_QUIET_START = '0';
  process.env.SURFACING_QUIET_END = '0';
  delete process.env.SURFACING_RATE_CAP;
  delete process.env.SURFACING_MIN_CONFIDENCE;
  delete process.env.SURFACING_TZ;
});

afterEach(() => {
  delete process.env.SURFACING_ENABLE;
  delete process.env.SURFACING_QUIET_START;
  delete process.env.SURFACING_QUIET_END;
  delete process.env.SURFACING_RATE_CAP;
  delete process.env.SURFACING_MIN_CONFIDENCE;
  delete process.env.SURFACING_TZ;
});

function ledgerRow(entityId: string, horizon: number): unknown {
  return getDb()
    .prepare('SELECT id FROM surfaced_ledger WHERE entity_id = ? AND horizon_days = ?')
    .get(entityId, horizon);
}

// ── AC-1 — surfaces once at the 7-day bucket, never twice ─────────────────────
describe('Track 7 surfacing', () => {
  it('AC-1: a 7-day-out confirmed Deadline surfaces once; a second run sends 0 (ledger blocks)', async () => {
    const d = deadline({ properties: { date: ymdDaysOut(7) } });
    writeGraph([d]);

    // AC-15 — the successful-send log line must fire exactly once for this surface, with the
    // matching entity_id + horizon. Spy console.log around the first (sending) run only.
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const first = await runSurfacing();
    const surfacedLines = logSpy.mock.calls
      .map((c) => String(c[0]))
      .filter((l) => l.includes('[MOT/surfacing] surfaced'));
    logSpy.mockRestore();

    expect(sendMock).toHaveBeenCalledTimes(1);
    expect(first.sent).toBe(1);
    expect(ledgerRow(d.id, 7)).toBeTruthy();
    // Exactly one surfaced log line, and it names this entity at horizon 7 (AC-15).
    expect(surfacedLines).toHaveLength(1);
    expect(surfacedLines[0]).toContain(`entity=${d.id}`);
    expect(surfacedLines[0]).toContain('horizon=7');

    sendMock.mockClear();
    const second = await runSurfacing();
    expect(sendMock).toHaveBeenCalledTimes(0);
    expect(second.sent).toBe(0);
  });

  // ── AC-2 — surfaces once at the 1-day bucket ────────────────────────────────
  it('AC-2: a 1-day-out Deadline surfaces once at the 1-day bucket; a second run sends 0', async () => {
    const d = deadline({ properties: { date: ymdDaysOut(1) } });
    writeGraph([d]);

    const first = await runSurfacing();
    expect(first.sent).toBe(1);
    expect(ledgerRow(d.id, 1)).toBeTruthy();

    sendMock.mockClear();
    const second = await runSurfacing();
    expect(sendMock).toHaveBeenCalledTimes(0);
    expect(second.sent).toBe(0);
  });

  // ── AC-3 — unconfirmed never surfaces ───────────────────────────────────────
  it('AC-3: confirmed:false → 0 sends regardless of confidence/date', async () => {
    writeGraph([deadline({ confirmed: false, properties: { date: ymdDaysOut(7) } })]);
    const r = await runSurfacing();
    expect(sendMock).toHaveBeenCalledTimes(0);
    expect(r.sent).toBe(0);
  });

  // ── AC-4 — below-confidence never surfaces ──────────────────────────────────
  it('AC-4: confidence 0.84 (below floor) → 0 sends', async () => {
    writeGraph([deadline({ confidence: 0.84, properties: { date: ymdDaysOut(7) } })]);
    const r = await runSurfacing();
    expect(sendMock).toHaveBeenCalledTimes(0);
    expect(r.sent).toBe(0);
  });

  // ── AC-5 — missing / null / unparseable date never surfaces, no throw ───────
  it('AC-5: missing, null, and non-date properties.date → 0 sends, no error', async () => {
    writeGraph([deadline({ properties: {} })]); // key omitted
    let r = await runSurfacing();
    expect(r.sent).toBe(0);

    writeGraph([deadline({ properties: { date: null } as Record<string, unknown> })]);
    r = await runSurfacing();
    expect(r.sent).toBe(0);

    writeGraph([deadline({ properties: { date: 'not-a-date' } })]);
    r = await runSurfacing();
    expect(r.sent).toBe(0);

    expect(sendMock).toHaveBeenCalledTimes(0);
  });

  // ── AC-6 — past date never surfaces ─────────────────────────────────────────
  it('AC-6: a past-dated Deadline (yesterday) → 0 sends', async () => {
    writeGraph([deadline({ properties: { date: ymdDaysOut(-1) } })]);
    const r = await runSurfacing();
    expect(sendMock).toHaveBeenCalledTimes(0);
    expect(r.sent).toBe(0);
  });

  // ── AC-7 — master enable gate ───────────────────────────────────────────────
  it('AC-7: SURFACING_ENABLE unset / "0" / "true" → 0 sends & disabled true; "1" proceeds', async () => {
    const seed = () => writeGraph([deadline({ properties: { date: ymdDaysOut(7) } })]);

    seed();
    delete process.env.SURFACING_ENABLE;
    let r = await runSurfacing();
    expect(r.disabled).toBe(true);
    expect(sendMock).toHaveBeenCalledTimes(0);

    seed();
    clearLedger();
    process.env.SURFACING_ENABLE = '0';
    r = await runSurfacing();
    expect(r.disabled).toBe(true);
    expect(sendMock).toHaveBeenCalledTimes(0);

    seed();
    clearLedger();
    process.env.SURFACING_ENABLE = 'true';
    r = await runSurfacing();
    expect(r.disabled).toBe(true);
    expect(sendMock).toHaveBeenCalledTimes(0);

    seed();
    clearLedger();
    process.env.SURFACING_ENABLE = '1';
    r = await runSurfacing();
    expect(r.disabled).toBe(false);
    expect(sendMock).toHaveBeenCalledTimes(1);
  });

  // ── AC-8 — quiet-hours defer ────────────────────────────────────────────────
  it('AC-8: inside the quiet window → 0 sends, sent === 0 (deterministic: window covers all hours)', async () => {
    // quietStart=0, quietEnd=24 ⇒ daytime branch hour>=0 && hour<24 ⇒ always quiet.
    process.env.SURFACING_QUIET_START = '0';
    process.env.SURFACING_QUIET_END = '24';
    writeGraph([deadline({ properties: { date: ymdDaysOut(7) } })]);
    const r = await runSurfacing();
    expect(sendMock).toHaveBeenCalledTimes(0);
    expect(r.sent).toBe(0);
  });

  // ── AC-9 — same-day batching = one send ─────────────────────────────────────
  it('AC-9: two Deadlines on the same due date → exactly one send', async () => {
    const date = ymdDaysOut(5);
    writeGraph([
      deadline({ label: 'A', properties: { date } }),
      deadline({ label: 'B', properties: { date } }),
    ]);
    const r = await runSurfacing();
    expect(sendMock).toHaveBeenCalledTimes(1);
    expect(r.sent).toBe(1);
  });

  // ── AC-10 — rate cap ────────────────────────────────────────────────────────
  it('AC-10: RATE_CAP=1 with 3 different-day Deadlines → 1 send; the other 2 rate_capped, no ledger', async () => {
    process.env.SURFACING_RATE_CAP = '1';
    const d1 = deadline({ label: 'D1', properties: { date: ymdDaysOut(3) } });
    const d2 = deadline({ label: 'D2', properties: { date: ymdDaysOut(4) } });
    const d3 = deadline({ label: 'D3', properties: { date: ymdDaysOut(5) } });
    writeGraph([d1, d2, d3]);

    const r = await runSurfacing();
    expect(sendMock).toHaveBeenCalledTimes(1);
    expect(r.sent).toBe(1);
    const capped = r.wouldSurface.filter((i) => i.status === 'rate_capped');
    expect(capped).toHaveLength(2);
    // Only the first (earliest date) is ledgered.
    expect(ledgerRow(d1.id, 7)).toBeTruthy();
    expect(ledgerRow(d2.id, 7)).toBeFalsy();
    expect(ledgerRow(d3.id, 7)).toBeFalsy();
  });

  // ── AC-11 — send failure leaves no ledger row ───────────────────────────────
  it('AC-11: sendTelegramNotify throws → runSurfacing does not throw, no ledger row, sent 0, status send_failed', async () => {
    sendMock.mockImplementation(async () => {
      throw new Error('telegram down');
    });
    const d = deadline({ properties: { date: ymdDaysOut(7) } });
    writeGraph([d]);

    const r = await runSurfacing();
    expect(r.sent).toBe(0);
    expect(ledgerRow(d.id, 7)).toBeFalsy();
    // The item is reported with the distinct send-failed status (NOT rate_capped, which is only for
    // items the rate cap skipped). Rate cap was never hit here — the send threw.
    const item = r.wouldSurface.find((i) => i.entity_id === d.id);
    expect(item?.status).toBe('send_failed');
    expect(r.wouldSurface.some((i) => i.status === 'rate_capped')).toBe(false);
  });

  // ── AC-12 — superseded excluded; new entity surfaces fresh ──────────────────
  it('AC-12: a superseded Deadline never surfaces; a non-superseded sibling does', async () => {
    const superseded = deadline({
      label: 'old',
      superseded_by: 'someNewId',
      properties: { date: ymdDaysOut(6) },
    });
    const fresh = deadline({ label: 'new', properties: { date: ymdDaysOut(3) } });
    writeGraph([superseded, fresh]);

    const r = await runSurfacing();
    expect(sendMock).toHaveBeenCalledTimes(1);
    expect(r.sent).toBe(1);
    expect(ledgerRow(superseded.id, 7)).toBeFalsy();
    expect(ledgerRow(fresh.id, 7)).toBeTruthy();
  });

  // ── AC-13 — dry-run / surfacing_preview: no send, no write ───────────────────
  it('AC-13: dryRun bypasses the enable gate, sends nothing, writes nothing, reports "new"', async () => {
    delete process.env.SURFACING_ENABLE; // even disabled, dryRun runs
    const d = deadline({ properties: { date: ymdDaysOut(7) } });
    writeGraph([d]);

    const r = await runSurfacing({ dryRun: true });
    expect(sendMock).toHaveBeenCalledTimes(0);
    expect(ledgerRow(d.id, 7)).toBeFalsy();
    expect(r.wouldSurface.some((i) => i.status === 'new' && i.entity_id === d.id)).toBe(true);

    // Same via the MCP tool (available regardless of SURFACING_ENABLE).
    const content = await callMcpTool('surfacing_preview', {});
    const parsed = JSON.parse(content[0].text);
    expect(sendMock).toHaveBeenCalledTimes(0);
    expect(ledgerRow(d.id, 7)).toBeFalsy();
    expect(parsed.wouldSurface.some((i: { entity_id: string }) => i.entity_id === d.id)).toBe(true);
  });

  // ── AC-14 — idempotency: pre-existing ledger row blocks the send ────────────
  it('AC-14: a pre-existing ledger row for (entity, 7) → 0 sends on the run', async () => {
    const d = deadline({ properties: { date: ymdDaysOut(7) } });
    writeGraph([d]);
    getDb()
      .prepare('INSERT INTO surfaced_ledger (entity_id, horizon_days, surfaced_at) VALUES (?,?,?)')
      .run(d.id, 7, new Date().toISOString());

    const r = await runSurfacing();
    expect(sendMock).toHaveBeenCalledTimes(0);
    expect(r.sent).toBe(0);
  });

  // ── AC-19 — half-open window: hour === quietEnd is NOT quiet ─────────────────
  it('AC-19: with quietStart=0/quietEnd=0 nothing is quiet → the send fires', async () => {
    // quietStart=0, quietEnd=0 ⇒ daytime branch hour>=0 && hour<0 ⇒ never quiet (half-open).
    process.env.SURFACING_QUIET_START = '0';
    process.env.SURFACING_QUIET_END = '0';
    writeGraph([deadline({ properties: { date: ymdDaysOut(7) } })]);
    const r = await runSurfacing();
    expect(sendMock).toHaveBeenCalledTimes(1);
    expect(r.sent).toBe(1);
  });

  // ── AC-8 + AC-19 against the PRODUCTION overnight window (21→8 wraparound) ────
  // Every other quiet-hours test uses a daytime-branch window (0,0)/(0,24). The real default is
  // SURFACING_QUIET_START=21 / SURFACING_QUIET_END=8 — the quietStart > quietEnd wraparound branch
  // (hour >= 21 || hour < 8). We spy the EXPORTED nowInTz to pin the hour deterministically (ymd
  // held at today's real date so the seeded 7-day Deadline stays in-bucket) and assert the half-open
  // boundary against that production branch: hour 23 is inside quiet → DEFER; hour 8 (=== quietEnd)
  // is OUTSIDE the half-open window → the send FIRES.
  it('AC-8/AC-19: production 21→8 window — hour 23 defers (0 sends), hour 8 (=quietEnd) sends', async () => {
    process.env.SURFACING_QUIET_START = '21';
    process.env.SURFACING_QUIET_END = '8';
    const today = surfacingModule.nowInTz('America/Vancouver').ymd;
    writeGraph([deadline({ properties: { date: ymdDaysOut(7) } })]);

    // hour 23 — inside the overnight quiet window → deferred, no send.
    const spy23 = vi
      .spyOn(surfacingModule, 'nowInTz')
      .mockReturnValue({ hour: 23, ymd: today });
    const deferred = await runSurfacing();
    spy23.mockRestore();
    expect(sendMock).toHaveBeenCalledTimes(0);
    expect(deferred.sent).toBe(0);
    expect(deferred.skipped).toBe(1); // deferred, not sent

    // hour 8 — hour === quietEnd is OUTSIDE the half-open [21,8) window → the send fires.
    clearLedger();
    sendMock.mockClear();
    const spy8 = vi
      .spyOn(surfacingModule, 'nowInTz')
      .mockReturnValue({ hour: 8, ymd: today });
    const fired = await runSurfacing();
    spy8.mockRestore();
    expect(sendMock).toHaveBeenCalledTimes(1);
    expect(fired.sent).toBe(1);
  });
});
