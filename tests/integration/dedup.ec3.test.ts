import { describe, it, expect, afterAll } from 'vitest';
import Database from 'better-sqlite3';
import { setupTempDb, cleanupTempDb, createInput } from './_helpers';

// AC-EC3 — ministry re-assign does not duplicate. ministry is NEVER in the dedup lookup and is
// NEVER reset by a dedup update: a re-assigned ticket still matches its original dedup_key, and
// a same-signal re-file groups onto it without resetting the corrected ministry.

const dbPath = setupTempDb('ec3');
const { createTicket, patchTicket } = await import('../../lib/tickets');

function conn(): Database.Database {
  return new Database(dbPath);
}

afterAll(() => cleanupTempDb(dbPath));

describe('AC-EC3 — ministry re-assign + same signal groups on the same ticket', () => {
  it('groups on the same ticket and keeps the corrected ministry', () => {
    // 1. POST → created, ministry=works.
    const created = createTicket(
      createInput({
        source_ref: 'ec2-alarm-42',
        ticket_type: 'infra-alert',
        ministry: 'works',
        severity: 'high',
      }) as never,
    );
    expect(created.action).toBe('created');
    const t1 = created.id;

    // 2. PATCH ministry=commerce (Taylor corrects the misclassification).
    const patched = patchTicket(t1, { ministry: 'commerce' } as never);
    expect(patched.ministry).toBe('commerce');
    // 3. dedup_key unchanged by the re-assign.
    expect(patched.dedup_key).toBe('ec2-alarm-42:infra-alert');

    // 4. Next pipeline signal re-files under the ORIGINAL ministry (works).
    const refile = createTicket(
      createInput({
        source_ref: 'ec2-alarm-42',
        ticket_type: 'infra-alert',
        ministry: 'works',
        severity: 'high',
      }) as never,
    );

    // 5. grouped on T1; event_count=2; ministry STILL commerce (not reset by dedup).
    expect(refile.action).toBe('grouped');
    expect(refile.id).toBe(t1);
    expect(refile.ticket.event_count).toBe(2);
    expect(refile.ticket.ministry).toBe('commerce');

    // 6. No second row with the same dedup_key.
    const c = conn();
    try {
      const n = (
        c
          .prepare('SELECT COUNT(*) AS n FROM ticket WHERE dedup_key = ?')
          .get('ec2-alarm-42:infra-alert') as { n: number }
      ).n;
      expect(n).toBe(1);
    } finally {
      c.close();
    }
  });
});
