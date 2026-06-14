import { describe, it, expect, afterAll } from 'vitest';
import Database from 'better-sqlite3';
import { setupTempDb, cleanupTempDb, createInput } from './_helpers';

// AC-EC1 — cross-channel / cross-concern dedup. Drives lib/tickets.createTicket against a real
// migrated SQLite DB. Three scenarios:
//   A  — same entity, same severity, byte-identical repeat → grouped, event_count=2 (one row).
//   A2 — same entity, strictly higher severity → updated, severity raised, event_count=3.
//   B  — same source_ref, different ticket_type → two rows, no merge.

const dbPath = setupTempDb('ec1');
const { createTicket } = await import('../../lib/tickets');

function conn(): Database.Database {
  return new Database(dbPath);
}

function rowCount(dedupKey: string): number {
  const c = conn();
  try {
    return (
      c.prepare('SELECT COUNT(*) AS n FROM ticket WHERE dedup_key = ?').get(dedupKey) as {
        n: number;
      }
    ).n;
  } finally {
    c.close();
  }
}

afterAll(() => cleanupTempDb(dbPath));

describe('AC-EC1 — dedup actions', () => {
  it('Scenario A: byte-identical same-severity repeat groups (event_count=2, one row)', () => {
    const payload = createInput({
      source_ref: 'stripe-ch-123',
      ticket_type: 'payment-alert',
      severity: 'high',
      ministry: 'commerce',
      body: 'Payment failed for charge stripe-ch-123.',
    });

    const first = createTicket(payload as never);
    expect(first.action).toBe('created');
    expect(first.ticket.event_count).toBe(1);

    // Byte-identical second POST (simulates a second-channel signal for the same event).
    const second = createTicket(payload as never);
    expect(second.action).toBe('grouped');
    expect(second.ticket.event_count).toBe(2);
    expect(second.id).toBe(first.id); // same ticket
    // No severity change, no body overwrite.
    expect(second.ticket.severity).toBe('high');
    expect(second.ticket.body).toBe('Payment failed for charge stripe-ch-123.');

    expect(rowCount('stripe-ch-123:payment-alert')).toBe(1);
  });

  it('Scenario A2: strictly higher severity updates (severity raised, event_count=3)', () => {
    // Continues from Scenario A: T1 exists with severity=high, event_count=2.
    const higher = createTicket(
      createInput({
        source_ref: 'stripe-ch-123',
        ticket_type: 'payment-alert',
        severity: 'critical', // strictly higher than stored 'high'
        ministry: 'commerce',
        body: 'Payment failed for charge stripe-ch-123.',
      }) as never,
    );

    expect(higher.action).toBe('updated');
    expect(higher.ticket.event_count).toBe(3);
    expect(higher.ticket.severity).toBe('critical'); // stored severity raised
    expect(rowCount('stripe-ch-123:payment-alert')).toBe(1); // still one row
  });

  it('Scenario A3: a LOWER severity re-fire groups, does not lower stored severity', () => {
    // Defends the "same-or-lower → grouped" half of the rule against a regression that would
    // overwrite severity downward.
    const lower = createTicket(
      createInput({
        source_ref: 'stripe-ch-123',
        ticket_type: 'payment-alert',
        severity: 'low',
        ministry: 'commerce',
        body: 'Payment failed for charge stripe-ch-123.',
      }) as never,
    );
    expect(lower.action).toBe('grouped');
    expect(lower.ticket.severity).toBe('critical'); // NOT lowered
    expect(lower.ticket.event_count).toBe(4);
  });

  it('Scenario B: same source_ref, different ticket_type stays two tickets', () => {
    const cert = createTicket(
      createInput({
        source_ref: 'example.net',
        ticket_type: 'cert-expiry',
        severity: 'normal',
        ministry: 'works',
      }) as never,
    );
    const renewal = createTicket(
      createInput({
        source_ref: 'example.net',
        ticket_type: 'renewal-notice',
        severity: 'normal',
        ministry: 'commerce',
      }) as never,
    );

    expect(cert.action).toBe('created');
    expect(renewal.action).toBe('created');
    expect(cert.id).not.toBe(renewal.id);
    expect(rowCount('example.net:cert-expiry')).toBe(1);
    expect(rowCount('example.net:renewal-notice')).toBe(1);
  });
});
