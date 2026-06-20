import { describe, it, expect, afterAll } from 'vitest';
import Database from 'better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { createId } from '@paralleldrive/cuid2';
import { setupTempDb, cleanupTempDb, createInput } from './_helpers';
import { resolveDedup } from '../../lib/dedup';

// EXISTS reopen gate (FR-8/9/10/11/12, FR-14; OQ-2/OQ-2a/OQ-4; EC-NEW-1/EC-NEW-2).
//
// The `done` branch of resolveDedup must NOT reopen unconditionally. It runs an EXISTS
// membership read over classification_audit:
//   - new fingerprint (never filed against this ticket) → EXISTS FALSE → reopened
//   - retry fingerprint (already filed)                  → EXISTS TRUE  → grouped, stays done
//   - null fingerprint (no audit block)                  → reopened (legacy contract)
//
// resolveDedup is exercised directly (with a hand-seeded conn) for the membership-decision
// cases, and through the full createTicket tx for the timing-invariant + two-in-one-run cases.

const dbPath = setupTempDb('exists-reopen');
const { createTicket, patchTicket } = await import('../../lib/tickets');

function conn(): Database.Database {
  return new Database(dbPath);
}

// Insert a bare `done` ticket row directly and return its id. Bypasses createTicket so the
// test controls exactly which audit rows exist (the membership the EXISTS gate reads).
function seedDoneTicket(c: Database.Database, dedupKey: string): string {
  const id = createId();
  const now = '2026-06-19T00:00:00.000Z';
  c.prepare(
    `INSERT INTO ticket (
        id, title, ministry, status, severity, ticket_type, provenance,
        source_ref, dedup_key, body, private, needs_review, event_count,
        snoozed_until, blocked_note, linked_ticket_id, created_at, updated_at, closed_at
      ) VALUES (?, 'Seeded', 'works', 'done', 'normal', ?, 'gmail-parse',
        ?, ?, 'seed body', 0, 0, 1, NULL, NULL, NULL, ?, ?, ?)`,
  ).run(
    id,
    dedupKey.split(':')[1],
    dedupKey.split(':')[0],
    dedupKey,
    now,
    now,
    now,
  );
  return id;
}

// Insert a classification_audit row pairing a ticket id with a fingerprint (what EXISTS reads).
function seedAuditRow(
  c: Database.Database,
  ticketId: string,
  fingerprint: string,
): void {
  c.prepare(
    `INSERT INTO classification_audit (
        id, signal_fingerprint, ministry_out, ticket_type_out, severity_out,
        confidence, action, ticket_id, model_version, prompt_hash, created_at
      ) VALUES (?, ?, 'works', 'infra-alert', 'normal', 0.9, 'created', ?, 'v1', 'ph', ?)`,
  ).run(createId(), fingerprint, ticketId, '2026-06-19T00:00:00.000Z');
}

afterAll(() => cleanupTempDb(dbPath));

describe('EXISTS reopen gate — membership decision (resolveDedup direct)', () => {
  it('AC-6: EXISTS TRUE → grouped, ticket stays done', () => {
    const c = conn();
    try {
      const id = seedDoneTicket(c, 'ac6-fp-true:infra-alert');
      seedAuditRow(c, id, 'fp-already-filed'); // membership present

      const result = resolveDedup(
        {
          source_ref: 'ac6-fp-true',
          ticket_type: 'infra-alert',
          severity: 'normal',
          signal_fingerprint: 'fp-already-filed',
          bridge_source_refs: [],
        },
        c,
      );

      expect(result.action).toBe('grouped');
      expect(result.existingId).toBe(id);

      // Ticket is untouched by resolveDedup (it decides, never mutates) → still done.
      const row = c.prepare('SELECT status FROM ticket WHERE id = ?').get(id) as {
        status: string;
      };
      expect(row.status).toBe('done');
    } finally {
      c.close();
    }
  });

  it('AC-6 (null side): null fingerprint on a done ticket with no audit rows → reopened', () => {
    const c = conn();
    try {
      const id = seedDoneTicket(c, 'ac6-null:infra-alert');
      // No audit rows seeded at all.

      const result = resolveDedup(
        {
          source_ref: 'ac6-null',
          ticket_type: 'infra-alert',
          severity: 'normal',
          signal_fingerprint: null, // legacy / non-Gmail provenance
          bridge_source_refs: [],
        },
        c,
      );

      expect(result.action).toBe('reopened');
      expect(result.existingId).toBe(id);
    } finally {
      c.close();
    }
  });

  it('AC-7: EXISTS FALSE → reopened (audit rows exist, but not for this fingerprint)', () => {
    const c = conn();
    try {
      const id = seedDoneTicket(c, 'ac7-fp-false:infra-alert');
      seedAuditRow(c, id, 'some-other-fp'); // membership for a DIFFERENT fingerprint

      const result = resolveDedup(
        {
          source_ref: 'ac7-fp-false',
          ticket_type: 'infra-alert',
          severity: 'normal',
          signal_fingerprint: 'brand-new-fp',
          bridge_source_refs: [],
        },
        c,
      );

      expect(result.action).toBe('reopened');
      expect(result.existingId).toBe(id);
    } finally {
      c.close();
    }
  });

  it('AC-9 / EC-NEW-2: an OLDER retry after a NEWER event still groups (membership, not latest)', () => {
    const c = conn();
    try {
      // One done ticket with two prior audit rows: fingerprint A (older) then B (newer).
      const id = seedDoneTicket(c, 'ac9:infra-alert');
      seedAuditRow(c, id, 'fp-A-older');
      seedAuditRow(c, id, 'fp-B-newer');

      // Re-present the OLDER fingerprint A. A stored-latest comparison would reopen (A != latest
      // B); EXISTS membership groups (A was filed before).
      const result = resolveDedup(
        {
          source_ref: 'ac9',
          ticket_type: 'infra-alert',
          severity: 'normal',
          signal_fingerprint: 'fp-A-older',
          bridge_source_refs: [],
        },
        c,
      );

      expect(result.action).toBe('grouped');
      expect(result.action).not.toBe('reopened');
      expect(result.existingId).toBe(id);
    } finally {
      c.close();
    }
  });
});

describe('EXISTS reopen gate — timing invariant + multi-message run (createTicket tx)', () => {
  it('AC-8: first-time done-match reopens; the immediate retry groups', () => {
    // 1. Create a gmail-parse ticket carrying fingerprint FP1, then mark it done.
    const baseAudit = {
      signal_fingerprint: 'ac8-fp1',
      model_version: 'v1',
      prompt_hash: 'ph-ac8',
      confidence: 0.9,
    };
    const created = createTicket(
      createInput({
        source_ref: 'ac8-src',
        ticket_type: 'infra-alert',
        ministry: 'works',
        severity: 'normal',
        provenance: 'gmail-parse',
        classification_audit: baseAudit,
      }) as never,
    );
    expect(created.action).toBe('created');
    const id = created.id;

    patchTicket(id, { status: 'done' } as never);

    // 2. First-time done-match with a NEW fingerprint FP2 → at decision time no FP2 audit row
    //    exists yet (writeAuditRow runs AFTER resolveDedup) → EXISTS FALSE → reopened.
    const firstHit = createTicket(
      createInput({
        source_ref: 'ac8-src',
        ticket_type: 'infra-alert',
        ministry: 'works',
        severity: 'normal',
        provenance: 'gmail-parse',
        classification_audit: { ...baseAudit, signal_fingerprint: 'ac8-fp2' },
      }) as never,
    );
    expect(firstHit.action).toBe('reopened');
    expect(firstHit.id).toBe(id);
    expect(firstHit.ticket.status).toBe('open');

    // Put it back to done so we can prove the retry of FP2 now groups.
    patchTicket(id, { status: 'done' } as never);

    // 3. Retry the SAME fingerprint FP2 → its audit row now exists → EXISTS TRUE → grouped.
    const retry = createTicket(
      createInput({
        source_ref: 'ac8-src',
        ticket_type: 'infra-alert',
        ministry: 'works',
        severity: 'normal',
        provenance: 'gmail-parse',
        classification_audit: { ...baseAudit, signal_fingerprint: 'ac8-fp2' },
      }) as never,
    );
    expect(retry.action).toBe('grouped');
    expect(retry.id).toBe(id);
    expect(retry.ticket.status).toBe('done'); // grouped does NOT reopen
  });

  it('AC-10 / EC-NEW-1: two new messages in one run on a done ticket → one row, ends open, count +2, two comments', () => {
    const audit = {
      signal_fingerprint: 'ac10-fp-a',
      model_version: 'v1',
      prompt_hash: 'ph-ac10',
      confidence: 0.9,
    };

    // Seed: create + done. Baseline event_count is 1 after create.
    const created = createTicket(
      createInput({
        source_ref: 'ac10-src',
        ticket_type: 'infra-alert',
        ministry: 'works',
        severity: 'low',
        provenance: 'gmail-parse',
        classification_audit: audit,
      }) as never,
    );
    const id = created.id;
    const baseline = created.ticket.event_count; // 1
    patchTicket(id, { status: 'done' } as never);

    const c = conn();
    let baselineComments = 0;
    try {
      baselineComments = (
        c
          .prepare('SELECT COUNT(*) AS n FROM comment WHERE ticket_id = ?')
          .get(id) as { n: number }
      ).n;
    } finally {
      c.close();
    }

    // Message B: new fingerprint → EXISTS FALSE → reopened. Ticket is now open.
    const msgB = createTicket(
      createInput({
        source_ref: 'ac10-src',
        ticket_type: 'infra-alert',
        ministry: 'works',
        severity: 'low',
        provenance: 'gmail-parse',
        classification_audit: { ...audit, signal_fingerprint: 'ac10-fp-b' },
      }) as never,
    );
    expect(msgB.action).toBe('reopened');
    expect(msgB.ticket.status).toBe('open');

    // Message C: another new fingerprint, but the ticket is now OPEN, with strictly-higher
    // severity (critical > stored low) → updated.
    const msgC = createTicket(
      createInput({
        source_ref: 'ac10-src',
        ticket_type: 'infra-alert',
        ministry: 'works',
        severity: 'critical',
        provenance: 'gmail-parse',
        classification_audit: { ...audit, signal_fingerprint: 'ac10-fp-c' },
      }) as never,
    );
    expect(msgC.action).toBe('updated');
    expect(msgC.id).toBe(id);

    // Exactly one ticket row; status open; event_count +2 over baseline.
    const c2 = conn();
    try {
      const rowCount = (
        c2
          .prepare('SELECT COUNT(*) AS n FROM ticket WHERE dedup_key = ?')
          .get('ac10-src:infra-alert') as { n: number }
      ).n;
      expect(rowCount).toBe(1);

      const row = c2
        .prepare('SELECT status, event_count FROM ticket WHERE id = ?')
        .get(id) as { status: string; event_count: number };
      expect(row.status).toBe('open');
      expect(row.event_count).toBe(baseline + 2);

      // Two system comments added: one reopen (B), one action (C).
      const comments = (
        c2
          .prepare('SELECT COUNT(*) AS n FROM comment WHERE ticket_id = ?')
          .get(id) as { n: number }
      ).n;
      expect(comments).toBe(baselineComments + 2);
    } finally {
      c2.close();
    }
  });
});

describe('EXISTS reopen gate — untouched branches (AC-18)', () => {
  it('AC-18: strictly-higher severity on an OPEN ticket → updated; same-severity repeat → grouped', () => {
    // Open/watching branches are not touched by this change. Confirm both still behave.
    const first = createTicket(
      createInput({
        source_ref: 'ac18-src',
        ticket_type: 'infra-alert',
        ministry: 'works',
        severity: 'normal',
      }) as never,
    );
    expect(first.action).toBe('created');
    const id = first.id;

    // Strictly higher → updated, severity raised.
    const higher = createTicket(
      createInput({
        source_ref: 'ac18-src',
        ticket_type: 'infra-alert',
        ministry: 'works',
        severity: 'high',
      }) as never,
    );
    expect(higher.action).toBe('updated');
    expect(higher.ticket.severity).toBe('high');

    // Same severity → grouped, no change.
    const same = createTicket(
      createInput({
        source_ref: 'ac18-src',
        ticket_type: 'infra-alert',
        ministry: 'works',
        severity: 'high',
      }) as never,
    );
    expect(same.action).toBe('grouped');
    expect(same.ticket.severity).toBe('high');
  });
});

describe('Schema shape — no banned columns (AC-11/22, AC-17)', () => {
  // Apply the generated base migration to a throwaway DB and inspect column shape directly.
  const migrationsFolder = path.join(process.cwd(), 'db/migrations');
  const tmpDir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'mot-shape-'));
  const shapePath = path.join(tmpDir, 'shape.db');
  const shapeDb = new Database(shapePath);
  shapeDb.pragma('foreign_keys = ON');
  migrate(drizzle(shapeDb), { migrationsFolder });

  afterAll(() => {
    shapeDb.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function cols(table: string): string[] {
    return (
      shapeDb.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]
    ).map((c) => c.name);
  }

  it('AC-11/22: ticket has no last_event_fingerprint and no frozen signal_fingerprint column', () => {
    const ticketCols = cols('ticket');
    expect(ticketCols).not.toContain('last_event_fingerprint');
    expect(ticketCols).not.toContain('signal_fingerprint');
    // The gate is membership over classification_audit, NOT a denormalized column on ticket.
    expect(ticketCols).toHaveLength(19);
  });

  it('AC-17: classification_audit shape unchanged — exactly its 14 columns, none added', () => {
    const auditCols = cols('classification_audit');
    const expected = [
      'id',
      'signal_fingerprint',
      'ministry_out',
      'ticket_type_out',
      'severity_out',
      'confidence',
      'action',
      'ticket_id',
      'model_version',
      'prompt_hash',
      'corrected_ministry',
      'corrected_severity',
      'corrected_at',
      'created_at',
    ];
    expect(auditCols.sort()).toEqual(expected.sort());
    // The EXISTS read is additive behavior over the existing ticket_id + signal_fingerprint cols.
    expect(auditCols).toContain('ticket_id');
    expect(auditCols).toContain('signal_fingerprint');
  });
});
