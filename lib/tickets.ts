import type BetterSqlite3 from 'better-sqlite3';
import { createId } from '@paralleldrive/cuid2';
import { getDb } from '../db/client';
import { nowIso } from './time';
import {
  computeDedupKey,
  resolveDedup,
  type DedupAction,
} from './dedup';
import {
  linkedTicketCascade,
  backfillCorrection,
} from './derived-effects';
import type {
  Ministry,
  Status,
  Severity,
  Provenance,
  Author,
} from './enums';
import type { CreateTicketInput, PatchTicketInput } from './validation';

// ── Data layer (FR-API-1/2/3/4, FR-LC-1, AC-EC1/EC3/EC4) ──────────────────────
// The contract Prompt 8's route handlers consume — handlers call NOTHING else in the data
// layer. Every write runs in a single better-sqlite3 transaction. The private gate is
// enforced IN the SQL (`AND private = 0` when includePrivate is false), never after fetch.

// ── Row + boundary types ──────────────────────────────────────────────────────

// A full ticket row, as stored. Booleans come back from SQLite as 0/1 integers (better-sqlite3
// does not apply Drizzle's {mode:'boolean'} when we use raw prepared statements), so we
// normalize to real booleans on the way out via rowToTicket().
export interface Ticket {
  id: string;
  title: string;
  ministry: Ministry;
  status: Status;
  severity: Severity;
  ticket_type: string;
  provenance: Provenance;
  source_ref: string | null;
  dedup_key: string | null;
  body: string;
  private: boolean;
  needs_review: boolean;
  event_count: number;
  snoozed_until: string | null;
  blocked_note: string | null;
  linked_ticket_id: string | null;
  created_at: string;
  updated_at: string;
  closed_at: string | null;
}

export interface Comment {
  id: string;
  ticket_id: string;
  author: Author;
  body: string;
  created_at: string;
}

// getTicket returns the ticket plus its full comment history (FR-API-4).
export interface TicketWithComments extends Ticket {
  comments: Comment[];
}

// POST result: the resolved action + the resulting (created or updated) ticket (FR-API-1).
export interface TicketWithAction {
  id: string;
  action: DedupAction;
  ticket: Ticket;
}

export interface ListOpts {
  status?: Status[];
  ministry?: Ministry[];
  severity?: Severity[];
  needs_review?: boolean;
  wake_pending?: boolean; // status=snoozed AND snoozed_until < now()
  q?: string; // FTS keyword search
  page?: number; // default 1
  per_page?: number; // default 50, max 200
  includePrivate: boolean; // derived from session presence by the route handler
}

export interface ListResult {
  tickets: Ticket[];
  total: number;
  page: number;
  per_page: number;
}

// A 422-shaped data-layer error. patchTicket throws this for illegal transitions / 404s;
// the route handler maps `.status` onto the HTTP response.
export class TicketError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = 'TicketError';
  }
}

// SQLite stores booleans as 0/1. Normalize a raw row to the typed Ticket shape.
function rowToTicket(row: Record<string, unknown>): Ticket {
  return {
    ...(row as unknown as Ticket),
    private: Boolean(row.private),
    needs_review: Boolean(row.needs_review),
  };
}

// Fetch one ticket row by id (no comments). Internal helper.
function fetchTicket(tx: BetterSqlite3.Database, id: string): Ticket | null {
  const row = tx.prepare('SELECT * FROM ticket WHERE id = ?').get(id) as
    | Record<string, unknown>
    | undefined;
  return row ? rowToTicket(row) : null;
}

// Append a system comment. better-sqlite3 fires the comment_fts triggers automatically,
// keeping FTS in sync inside the same transaction.
function addSystemComment(
  tx: BetterSqlite3.Database,
  ticketId: string,
  author: Author,
  body: string,
  at: string,
): void {
  tx.prepare(
    `INSERT INTO comment (id, ticket_id, author, body, created_at)
       VALUES (?, ?, ?, ?, ?)`,
  ).run(createId(), ticketId, author, body, at);
}

// ── createTicket (FR-API-1, dedup) ────────────────────────────────────────────
export function createTicket(input: CreateTicketInput): TicketWithAction {
  const db = getDb();
  const sourceRef = input.source_ref ?? null;

  const run = db.transaction((): TicketWithAction => {
    const decision = resolveDedup(
      {
        source_ref: sourceRef,
        ticket_type: input.ticket_type,
        severity: input.severity as Severity,
      },
      db,
    );
    const now = nowIso();

    if (decision.action === 'created') {
      const id = createId();
      const dedupKey =
        sourceRef !== null ? computeDedupKey(sourceRef, input.ticket_type) : null;

      db.prepare(
        `INSERT INTO ticket (
            id, title, ministry, status, severity, ticket_type, provenance,
            source_ref, dedup_key, body, private, needs_review, event_count,
            snoozed_until, blocked_note, linked_ticket_id, created_at, updated_at, closed_at
          ) VALUES (?, ?, ?, 'open', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
      ).run(
        id,
        input.title,
        input.ministry,
        input.severity,
        input.ticket_type,
        input.provenance,
        sourceRef,
        dedupKey,
        input.body,
        input.private ? 1 : 0,
        input.needs_review ? 1 : 0,
        input.event_count ?? 1,
        input.snoozed_until ?? null,
        input.blocked_note ?? null,
        input.linked_ticket_id ?? null,
        now,
        now,
      );

      writeAuditRow(db, input, 'created', id, now);
      const ticket = fetchTicket(db, id)!;
      return { id, action: 'created', ticket };
    }

    // Dedup hit — act on the existing row per the resolved action.
    const existingId = decision.existingId!;

    if (decision.action === 'reopened') {
      // done → open: clear closed_at, bump counter, re-open system comment.
      db.prepare(
        `UPDATE ticket
           SET status = 'open', closed_at = NULL,
               event_count = event_count + 1, updated_at = ?
         WHERE id = ?`,
      ).run(now, existingId);
      addSystemComment(
        db,
        existingId,
        'tuttle',
        'Ticket re-opened: repeat signal received.',
        now,
      );
    } else if (decision.action === 'updated') {
      // Strictly-higher severity: raise stored severity, bump counter + timestamp.
      db.prepare(
        `UPDATE ticket
           SET severity = ?, event_count = event_count + 1, updated_at = ?
         WHERE id = ?`,
      ).run(decision.severityToStore, now, existingId);
      addSystemComment(
        db,
        existingId,
        'tuttle',
        'Repeat signal received. [updated]',
        now,
      );
    } else {
      // grouped: counter + timestamp + system comment only. body/title NOT overwritten;
      // severity unchanged; ministry untouched (AC-EC3).
      db.prepare(
        `UPDATE ticket
           SET event_count = event_count + 1, updated_at = ?
         WHERE id = ?`,
      ).run(now, existingId);
      addSystemComment(
        db,
        existingId,
        'tuttle',
        'Repeat signal received. [grouped]',
        now,
      );
    }

    writeAuditRow(db, input, decision.action, existingId, now);
    const ticket = fetchTicket(db, existingId)!;
    return { id: existingId, action: decision.action, ticket };
  });

  return run();
}

// Write a classification_audit row when (and only when) the payload carried the optional
// classification_audit block (FR-API-1). Manual creates (no block) write NO audit row
// (AC-CREATE step 7, EC-ARCH-5).
function writeAuditRow(
  tx: BetterSqlite3.Database,
  input: CreateTicketInput,
  action: DedupAction,
  ticketId: string,
  now: string,
): void {
  const audit = input.classification_audit;
  if (!audit) return;
  tx.prepare(
    `INSERT INTO classification_audit (
        id, signal_fingerprint, ministry_out, ticket_type_out, severity_out,
        confidence, action, ticket_id, model_version, prompt_hash, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    createId(),
    audit.signal_fingerprint,
    input.ministry,
    input.ticket_type,
    input.severity,
    audit.confidence,
    action,
    ticketId,
    audit.model_version,
    audit.prompt_hash ?? null,
    now,
  );
}

// ── listTickets (FR-API-3) ────────────────────────────────────────────────────
// Severity rank for the default sort (critical first). SQLite has no enum ordering, so we
// project a rank via a CASE expression in the ORDER BY.
const SEVERITY_ORDER_SQL = `CASE ticket.severity
  WHEN 'critical' THEN 3 WHEN 'high' THEN 2 WHEN 'normal' THEN 1 ELSE 0 END DESC`;

// FTS5 phrase-quote user input. A bare hyphenated token ("root-cause") is otherwise parsed by
// the FTS5 query grammar as a column-filter / NOT expression and errors. Wrapping the whole
// term in double quotes (and escaping any embedded quotes) makes it a literal phrase — the
// P3 handoff requirement. Empty/whitespace input is handled by the caller (falls back to the
// non-FTS query).
function ftsPhrase(q: string): string {
  return `"${q.replace(/"/g, '""')}"`;
}

export function listTickets(opts: ListOpts): ListResult {
  const db = getDb();
  const page = Math.max(1, opts.page ?? 1);
  const per_page = Math.min(200, Math.max(1, opts.per_page ?? 50));
  const offset = (page - 1) * per_page;

  const where: string[] = [];
  const params: unknown[] = [];

  const trimmedQ = opts.q?.trim();
  const useFts = !!trimmedQ;

  // FTS join (FR-API-3 q). Both FTS and the private gate apply simultaneously — the gate is
  // just another AND clause below.
  const from = useFts
    ? 'ticket INNER JOIN ticket_fts f ON ticket.rowid = f.rowid'
    : 'ticket';
  if (useFts) {
    where.push('ticket_fts MATCH ?');
    params.push(ftsPhrase(trimmedQ!));
  }

  // Private gate — IN THE SQL (FR-API-3, AC-PRIVATE). API-key-only requests pass
  // includePrivate=false → private rows are never returned, never filtered post-fetch.
  if (!opts.includePrivate) {
    where.push('ticket.private = 0');
  }

  if (opts.wake_pending) {
    // wake_pending overrides the status filter: snoozed AND past-due (EC-8 safety net).
    where.push('ticket.status = ?');
    params.push('snoozed');
    where.push('ticket.snoozed_until < ?');
    params.push(nowIso());
  } else if (opts.status && opts.status.length > 0) {
    where.push(`ticket.status IN (${opts.status.map(() => '?').join(', ')})`);
    params.push(...opts.status);
  } else {
    // Default: open only (FR-API-3 default).
    where.push("ticket.status = 'open'");
  }

  if (opts.ministry && opts.ministry.length > 0) {
    where.push(`ticket.ministry IN (${opts.ministry.map(() => '?').join(', ')})`);
    params.push(...opts.ministry);
  }
  if (opts.severity && opts.severity.length > 0) {
    where.push(`ticket.severity IN (${opts.severity.map(() => '?').join(', ')})`);
    params.push(...opts.severity);
  }
  if (opts.needs_review !== undefined) {
    where.push('ticket.needs_review = ?');
    params.push(opts.needs_review ? 1 : 0);
  }

  const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';

  const total = (
    db
      .prepare(`SELECT COUNT(*) AS n FROM ${from} ${whereSql}`)
      .get(...params) as { n: number }
  ).n;

  // FTS results rank by relevance; otherwise the triage sort (severity desc, updated_at desc).
  const orderSql = useFts
    ? 'ORDER BY rank'
    : `ORDER BY ${SEVERITY_ORDER_SQL}, ticket.updated_at DESC`;

  const rows = db
    .prepare(
      `SELECT ticket.* FROM ${from} ${whereSql} ${orderSql} LIMIT ? OFFSET ?`,
    )
    .all(...params, per_page, offset) as Record<string, unknown>[];

  return {
    tickets: rows.map(rowToTicket),
    total,
    page,
    per_page,
  };
}

// ── getTicket (FR-API-4) ──────────────────────────────────────────────────────
// Returns the ticket + its full comment history. Private gate: a private ticket without a
// session returns null → the route handler responds 404 (NOT 403 — do not confirm existence).
export function getTicket(
  id: string,
  includePrivate: boolean,
): TicketWithComments | null {
  const db = getDb();
  const ticket = fetchTicket(db, id);
  if (!ticket) return null;
  if (ticket.private && !includePrivate) return null;

  const comments = db
    .prepare('SELECT * FROM comment WHERE ticket_id = ? ORDER BY created_at ASC')
    .all(id) as Comment[];

  return { ...ticket, comments };
}

// ── patchTicket (FR-API-2, FR-LC-1) ───────────────────────────────────────────
// Legal status transitions (FR-LC-1). `archived` is rejected by Zod upstream; it never
// appears as a target here.
const LEGAL_TRANSITIONS: Record<string, Status[]> = {
  open: ['watching', 'snoozed', 'done'],
  watching: ['snoozed', 'done'],
  snoozed: ['open', 'done'],
  done: ['open'], // re-open (dedup re-fire path can also be an explicit PATCH)
};

export function patchTicket(id: string, input: PatchTicketInput): Ticket {
  const db = getDb();

  const run = db.transaction((): Ticket => {
    const current = fetchTicket(db, id);
    if (!current) {
      throw new TicketError('Not found', 404);
    }

    const now = nowIso();
    const sets: string[] = [];
    const params: unknown[] = [];

    // Status transition legality (FR-LC-1). Only checked when status is changing.
    const newStatus = input.status as Status | undefined;
    const statusChanging = newStatus !== undefined && newStatus !== current.status;
    if (statusChanging) {
      const legal = LEGAL_TRANSITIONS[current.status] ?? [];
      if (!legal.includes(newStatus!)) {
        throw new TicketError(
          `Invalid status transition: ${current.status} → ${newStatus}`,
          422,
        );
      }
      sets.push('status = ?');
      params.push(newStatus);

      // closed_at: set on → done, clear on → open.
      if (newStatus === 'done') {
        sets.push('closed_at = ?');
        params.push(now);
      } else if (newStatus === 'open') {
        sets.push('closed_at = NULL');
      }

      // Leaving snoozed clears snoozed_until (unless the patch sets it explicitly below).
      if (current.status === 'snoozed' && newStatus !== 'snoozed') {
        sets.push('snoozed_until = NULL');
      }
    }

    // Scalar field updates. snoozed_until is applied here too (e.g. open → snoozed sets it);
    // an explicit value wins over the clear-on-leave above because it is appended after.
    if (input.severity !== undefined) {
      sets.push('severity = ?');
      params.push(input.severity);
    }
    if (input.ministry !== undefined) {
      sets.push('ministry = ?');
      params.push(input.ministry);
    }
    if (input.title !== undefined) {
      sets.push('title = ?');
      params.push(input.title);
    }
    if (input.body !== undefined) {
      sets.push('body = ?');
      params.push(input.body);
    }
    if (input.snoozed_until !== undefined) {
      sets.push('snoozed_until = ?');
      params.push(input.snoozed_until);
    }
    if (input.blocked_note !== undefined) {
      sets.push('blocked_note = ?');
      params.push(input.blocked_note);
    }
    if (input.linked_ticket_id !== undefined) {
      sets.push('linked_ticket_id = ?');
      params.push(input.linked_ticket_id);
    }
    if (input.needs_review !== undefined) {
      sets.push('needs_review = ?');
      params.push(input.needs_review ? 1 : 0);
    }

    // Always bump updated_at.
    sets.push('updated_at = ?');
    params.push(now);

    db.prepare(`UPDATE ticket SET ${sets.join(', ')} WHERE id = ?`).run(
      ...params,
      id,
    );

    // add_comment (FR-API-2). Author per the payload.
    if (input.add_comment) {
      addSystemComment(
        db,
        id,
        input.add_comment.author,
        input.add_comment.body,
        now,
      );
    }

    // ── Derived effects (FR-API-2a/2b), inside this transaction ────────────────
    // (a) linked-ticket auto-close cascade — only when transitioning TO done.
    if (statusChanging && newStatus === 'done') {
      linkedTicketCascade(id, db);
    }
    // (b) corrected_* back-fill — when ministry and/or severity actually changed.
    const corrections: { ministry?: string; severity?: string } = {};
    if (input.ministry !== undefined && input.ministry !== current.ministry) {
      corrections.ministry = input.ministry;
    }
    if (input.severity !== undefined && input.severity !== current.severity) {
      corrections.severity = input.severity;
    }
    backfillCorrection(id, corrections, db);

    return fetchTicket(db, id)!;
  });

  return run();
}
