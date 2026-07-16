// Track 7 — Proactive Surfacing (spec §Architecture D2–D5). The whole scan→filter→bucket→gate→
// send→ledger pipeline, in one leaf module beside lib/procedural.ts / lib/maintainer.ts.
//
// Called by two paths: the daytime cron in lib/backup.ts ({ dryRun:false }) and the
// surfacing_preview MCP tool ({ dryRun:true, horizonDays }). Nothing here imports lib/mcp-tools.ts
// or lib/backup.ts (no cycle). The surfaced_ledger table is hand-written — raw better-sqlite3
// statements via getDb(), no Drizzle ORM (the hand-written-table convention).
//
// Memory invariants (product): a ledger row is anti-nag bookkeeping only — it NEVER deletes,
// suppresses, or expires the underlying Deadline entity. Deadlines persist in the graph forever
// (FR-15). This module only reads the graph and writes the ledger.

import { getDb } from '../db/client';
import { loadGraph, type EntityRecord } from './graph';
import { sendTelegramNotify, _truncateBriefing } from './notify';
import { nowIso } from './time';
// Self-namespace import: runSurfacing calls nowInTz via `self.nowInTz` (below) so the exported
// binding is the one invoked. That is the seam the tests spy (vi.spyOn(module, 'nowInTz')) to make
// quiet-hours deterministic — a bare `nowInTz(tz)` call is inlined by the bundler and the spy can't
// reach it. Do NOT "simplify" this back to a direct call; it silently breaks AC-8/AC-19 test control.
import * as self from './surfacing';

export interface SurfacingItem {
  entity_id: string;
  label: string;
  days_out: number;
  horizon_days: 7 | 1;
  status: 'new' | 'already_surfaced' | 'rate_capped' | 'send_failed';
}

export interface SurfacingSummary {
  scanned: number;
  wouldSurface: SurfacingItem[];
  sent: number;
  skipped: number;
  disabled: boolean;
}

// ── parseDeadlineDate (D2) ────────────────────────────────────────────────────
// Read the single canonical key properties.date. Tolerant of a full ISO datetime but normalised
// to the YYYY-MM-DD date portion. A caller that gets null silently skips the entity (EC-3/AC-5).
export function parseDeadlineDate(props: Record<string, unknown>): string | null {
  const value = props.date;
  if (value === undefined || value === null || value === '' || typeof value !== 'string') {
    return null;
  }
  const slice = value.slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}/.test(slice)) return null;
  if (Number.isNaN(Date.parse(slice + 'T00:00:00Z'))) return null;
  return slice;
}

// ── nowInTz (D3) ──────────────────────────────────────────────────────────────
// The one TZ-aware time helper the codebase lacks (lib/time.ts is UTC-only). Node built-in Intl,
// no dependency. Returns the current calendar date (YYYY-MM-DD) and hour (0–23) in the given IANA
// zone. Exported so the tests can spy on it (quiet-hours determinism — AC-8/AC-19).
export function nowInTz(tz: string): { hour: number; ymd: string } {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
  }).formatToParts(new Date());

  const get = (type: string): string => parts.find((p) => p.type === type)?.value ?? '';
  const year = get('year');
  const month = get('month');
  const day = get('day');
  // Intl sometimes returns '24' for midnight in hour23 style; normalise to 0.
  let hour = Number.parseInt(get('hour'), 10);
  if (!Number.isFinite(hour) || hour === 24) hour = 0;

  return { hour, ymd: `${year}-${month}-${day}` };
}

// ── guarded env reads (call-time; MAINTAINER_BATCH_SIZE precedent) ────────────
function parseIntEnv(raw: string | undefined, fallback: number): number {
  const n = Number.parseInt(raw ?? '', 10);
  return Number.isNaN(n) ? fallback : n;
}

function parseFloatEnv(raw: string | undefined, fallback: number): number {
  const n = Number.parseFloat(raw ?? '');
  return Number.isNaN(n) ? fallback : n;
}

// ── runSurfacing — the single entry point (D5) ────────────────────────────────
export async function runSurfacing(opts?: {
  dryRun?: boolean;
  horizonDays?: number;
}): Promise<SurfacingSummary> {
  const dryRun = opts?.dryRun === true;
  const horizonDays = opts?.horizonDays ?? 7; // the cron never overrides this ⇒ prod is a hard 2..7

  // Env reads, all at call time, guarded with explicit fallbacks.
  const tz = process.env.SURFACING_TZ ?? 'America/Vancouver';
  const quietStart = parseIntEnv(process.env.SURFACING_QUIET_START, 21);
  const quietEnd = parseIntEnv(process.env.SURFACING_QUIET_END, 8);
  const rateCapRaw = parseIntEnv(process.env.SURFACING_RATE_CAP, 3);
  const rateCap = rateCapRaw > 0 ? rateCapRaw : 3; // reject ≤0 → 3
  const minConfidence = parseFloatEnv(process.env.SURFACING_MIN_CONFIDENCE, 0.85);

  // Step 1 — Gate layer 1 (master enable; AC-7, FR-8.1, D5 step 1). dryRun bypasses entirely.
  if (!dryRun && process.env.SURFACING_ENABLE !== '1') {
    // eslint-disable-next-line no-console
    console.log('[MOT/surfacing] disabled — skipping');
    return { disabled: true, scanned: 0, wouldSurface: [], sent: 0, skipped: 0 };
  }

  // Step 2 — Load + filter the graph (FR-2, FR-13; AC-3/4/5/6/12).
  const graph = loadGraph();
  const todayYmd = self.nowInTz(tz).ymd;
  const todayMs = Date.parse(todayYmd + 'T00:00:00Z');

  type Survivor = { entity: EntityRecord; deadlineYmd: string; daysOut: number; bucket: 7 | 1 };
  const survivors: Survivor[] = [];

  for (const entity of graph) {
    if (entity.type !== 'Deadline') continue;
    if (entity.confirmed !== true) continue;
    if (entity.superseded_by !== null) continue;
    if (entity.confidence < minConfidence) continue;

    const deadlineYmd = parseDeadlineDate(entity.properties);
    if (deadlineYmd === null) continue;

    const daysOut = Math.round(
      (Date.parse(deadlineYmd + 'T00:00:00Z') - todayMs) / 86_400_000,
    );

    // Bucket match: 1-day bucket (exactly tomorrow) OR the outer bucket (2..horizonDays inclusive).
    let bucket: 7 | 1 | null = null;
    if (daysOut === 1) bucket = 1;
    else if (daysOut >= 2 && daysOut <= horizonDays) bucket = 7;
    if (bucket === null) continue;

    survivors.push({ entity, deadlineYmd, daysOut, bucket });
  }

  const scanned = survivors.length;

  // Step 3 — Gate layer 2 (quiet-hours; AC-8, FR-8.2, D3). Half-open [quietStart, quietEnd):
  // hour === quietEnd is NOT quiet (AC-19 — the 08:00 send fires). dryRun bypasses.
  if (!dryRun) {
    const { hour } = self.nowInTz(tz);
    const inQuiet =
      quietStart > quietEnd
        ? hour >= quietStart || hour < quietEnd // overnight window (default 21:00–08:00)
        : hour >= quietStart && hour < quietEnd; // daytime window (edge case)
    if (inQuiet) {
      // eslint-disable-next-line no-console
      console.log('[MOT/surfacing] quiet hours — deferring');
      return { disabled: false, scanned, wouldSurface: [], sent: 0, skipped: survivors.length };
    }
  }

  // Step 4 — Same-day grouping (FR-7; AC-9). Each due-date is ONE Telegram message.
  const groups = new Map<string, Survivor[]>();
  for (const s of survivors) {
    const arr = groups.get(s.deadlineYmd);
    if (arr) arr.push(s);
    else groups.set(s.deadlineYmd, [s]);
  }
  const sortedDates = [...groups.keys()].sort(); // ascending by due date (YYYY-MM-DD is sortable)

  const db = getDb();
  const ledgerCheck = db.prepare(
    'SELECT id FROM surfaced_ledger WHERE entity_id = ? AND horizon_days = ?',
  );
  const ledgerInsert = db.prepare(
    'INSERT OR IGNORE INTO surfaced_ledger (entity_id, horizon_days, surfaced_at) VALUES (?, ?, ?)',
  );

  // Step 5/6 — rate cap (in-memory per-run counter) + send loop (FR-8.3/FR-9; AC-10/11/14/15).
  let sends = 0;
  let skipped = 0;
  const wouldSurface: SurfacingItem[] = [];

  let capLogged = false;
  for (const date of sortedDates) {
    const group = groups.get(date) ?? [];

    // Pre-send ledger check: an item already surfaced for this bucket is skipped (AC-1/14).
    const pending: Survivor[] = [];
    for (const s of group) {
      const existing = ledgerCheck.get(s.entity.id, s.bucket);
      if (existing) {
        wouldSurface.push(toItem(s, 'already_surfaced'));
        skipped++;
        continue;
      }
      pending.push(s);
    }
    if (pending.length === 0) continue;

    if (dryRun) {
      // Dry-run: classify as 'new', send nothing, write nothing (EC-9/FR-14/AC-13).
      for (const s of pending) wouldSurface.push(toItem(s, 'new'));
      continue;
    }

    // Live path — rate cap check BEFORE composing/sending this group. Once the cap is reached,
    // ALL remaining not-yet-surfaced items (this group AND every later group) are reported
    // rate_capped and NOT ledgered — they retry next night (FR-9/EC-7/AC-10). Log once.
    if (sends >= rateCap) {
      if (!capLogged) {
        // eslint-disable-next-line no-console
        console.log(`[MOT/surfacing] rate cap reached for this run (${sends} sends)`);
        capLogged = true;
      }
      for (const s of pending) {
        wouldSurface.push(toItem(s, 'rate_capped'));
        skipped++;
      }
      continue;
    }

    // Compose one message from the not-yet-surfaced items in this group.
    const lines = pending.map((s) => composeLine(s));
    let message = lines.join('\n');
    if (message.length > 4096) message = _truncateBriefing(message);

    try {
      await sendTelegramNotify(message);
    } catch (e: unknown) {
      // Send failed after retries — DO NOT write any ledger rows; the item retries next night
      // (AC-11, FR-6/EC-1). Log and move on to the next group.
      const reason = e instanceof Error ? e.message : 'unknown error';
      // eslint-disable-next-line no-console
      console.error(`[MOT/surfacing] send failed: ${reason}`);
      for (const s of pending) {
        wouldSurface.push(toItem(s, 'send_failed')); // not sent (send threw); reported as skipped
        skipped++;
      }
      continue;
    }

    // Success — ledger each surfaced (entity, bucket) and log per item (AC-15).
    const ts = nowIso();
    for (const s of pending) {
      ledgerInsert.run(s.entity.id, s.bucket, ts);
      wouldSurface.push(toItem(s, 'new'));
      // eslint-disable-next-line no-console
      console.log(`[MOT/surfacing] surfaced entity=${s.entity.id} horizon=${s.bucket} at ${ts}`);
    }
    sends++;
  }

  return { disabled: false, scanned, wouldSurface, sent: sends, skipped };
}

// The composed human-facing line states the ACTUAL days-out (D4), not the bucket label.
function composeLine(s: { entity: EntityRecord; deadlineYmd: string; daysOut: number }): string {
  const when = s.daysOut === 1 ? 'due tomorrow' : `due in ${s.daysOut} days`;
  return `${s.entity.label} — ${when} (${s.deadlineYmd})`;
}

function toItem(
  s: { entity: EntityRecord; daysOut: number; bucket: 7 | 1 },
  status: SurfacingItem['status'],
): SurfacingItem {
  return {
    entity_id: s.entity.id,
    label: s.entity.label,
    days_out: s.daysOut,
    horizon_days: s.bucket,
    status,
  };
}
