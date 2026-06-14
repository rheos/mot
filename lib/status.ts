import { getDb } from '../db/client';
import { nowIso } from './time';
import { Ministry } from './enums';

// ── Health / status payload (FR-API-5, AC-STATUS-ENDPOINT) ────────────────────
// The one unauthenticated read. buildStatus() answers three questions the operator and the
// app shell ask: is the DB reachable and in WAL mode (db_ok), when did the classifier last
// write an audit row (last_successful_run, the FR-UI-9 heartbeat source), and what does the
// queue look like (ticket_counts + per-ministry breakdown). Counts are derived from the
// `ticket` table in three GROUP BY queries; the route handler returns 503 when db_ok is false.

// The lifecycle statuses we report counts for. `archived` is cron-only and intentionally
// excluded from the dashboard counts (it is not a live-queue state).
const COUNTED_STATUSES = ['open', 'watching', 'snoozed', 'done'] as const;
type CountedStatus = (typeof COUNTED_STATUSES)[number];

type StatusCounts = Record<CountedStatus, number> & { wake_pending: number };
type MinistryStatusCounts = Record<CountedStatus, number>;

export interface StatusPayload {
  db_ok: boolean;
  last_successful_run: string | null;
  ticket_counts: StatusCounts;
  ticket_counts_by_ministry: Record<string, MinistryStatusCounts>;
}

function zeroStatusCounts(): StatusCounts {
  return { open: 0, watching: 0, snoozed: 0, done: 0, wake_pending: 0 };
}

function zeroMinistryCounts(): MinistryStatusCounts {
  return { open: 0, watching: 0, snoozed: 0, done: 0 };
}

// Every ministry present in the payload from the start (zeroed), so the dashboard renders a
// stable shape even on a fresh DB — house rule 6 (the empty state is a real state).
function emptyMinistryMap(): Record<string, MinistryStatusCounts> {
  const map: Record<string, MinistryStatusCounts> = {};
  for (const m of Object.values(Ministry)) {
    map[m] = zeroMinistryCounts();
  }
  return map;
}

function isCountedStatus(s: string): s is CountedStatus {
  return (COUNTED_STATUSES as readonly string[]).includes(s);
}

// db_ok is the conjunction of "a trivial query runs" and "journal_mode is WAL" — the same WAL
// invariant boot.test.ts asserts (EC-ARCH-1). Any throw → db_ok=false and zeroed counts; the
// route handler turns that into a 503.
export function buildStatus(): StatusPayload {
  const db = getDb();

  try {
    db.prepare('SELECT 1').run();

    const journal = db.pragma('journal_mode') as { journal_mode: string }[];
    const dbOk = journal[0]?.journal_mode?.toLowerCase() === 'wal';

    const lastRun = db
      .prepare('SELECT MAX(created_at) AS ts FROM classification_audit')
      .get() as { ts: string | null };

    const statusRows = db
      .prepare('SELECT status, COUNT(*) AS cnt FROM ticket GROUP BY status')
      .all() as { status: string; cnt: number }[];

    const wakePending = db
      .prepare(
        `SELECT COUNT(*) AS cnt FROM ticket
           WHERE status = 'snoozed' AND snoozed_until < ?`,
      )
      .get(nowIso()) as { cnt: number };

    const ministryRows = db
      .prepare(
        'SELECT ministry, status, COUNT(*) AS cnt FROM ticket GROUP BY ministry, status',
      )
      .all() as { ministry: string; status: string; cnt: number }[];

    const ticketCounts = zeroStatusCounts();
    for (const row of statusRows) {
      if (isCountedStatus(row.status)) ticketCounts[row.status] = row.cnt;
    }
    ticketCounts.wake_pending = wakePending.cnt;

    const byMinistry = emptyMinistryMap();
    for (const row of ministryRows) {
      const bucket = byMinistry[row.ministry];
      if (bucket && isCountedStatus(row.status)) {
        bucket[row.status] = row.cnt;
      }
    }

    return {
      db_ok: dbOk,
      last_successful_run: lastRun.ts ?? null,
      ticket_counts: ticketCounts,
      ticket_counts_by_ministry: byMinistry,
    };
  } catch {
    // DB unreachable / corrupt — report db_ok=false with zeroed counts. The handler → 503.
    return {
      db_ok: false,
      last_successful_run: null,
      ticket_counts: zeroStatusCounts(),
      ticket_counts_by_ministry: emptyMinistryMap(),
    };
  }
}
