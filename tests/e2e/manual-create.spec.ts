import { test, expect } from '@playwright/test';
import Database from 'better-sqlite3';
import { e2eDbPath, resetTickets } from './seed';

// AC-CREATE: the manual ticket creation form (FR-UI-10). The positive case proves a valid submit
// persists exactly the manual-ticket contract — provenance='manual', source_ref=null,
// dedup_key=null, and NO classification_audit row — then redirects to the new ticket's detail and
// shows it in triage. The negative case proves client-side validation rejects an empty title/body
// BEFORE any request goes out (no new row, no /api/tickets POST). Each test controls the DB
// directly (reset first); the dev server reads the same WAL file. Runs serially (workers: 1).

const DB = e2eDbPath();

// One read connection per assertion — the dev server owns the writes; we only read here.
function readDb<T>(fn: (db: Database.Database) => T): T {
  const db = new Database(DB);
  db.pragma('foreign_keys = ON');
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

test.describe('Manual ticket creation — AC-CREATE', () => {
  test('positive: valid submit persists a manual ticket and lands on its detail', async ({
    page,
  }) => {
    resetTickets(DB);
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));

    await page.goto('/tickets/new');

    await page.getByLabel('Title').fill('Flow block: deploy gate');
    await page.getByLabel('Ministry').selectOption('flow');
    await page.getByLabel('Severity').selectOption('high');
    await page.getByLabel('Ticket type').fill('flow-block');
    await page.getByLabel('Body').fill('Waiting on infra sign-off before merge.');

    await page.getByRole('button', { name: 'Create ticket' }).click();

    // Redirected to the new ticket's detail view, which shows the title.
    await page.waitForURL(/\/tickets\/[^/]+$/);
    await expect(
      page.getByRole('heading', { name: 'Flow block: deploy gate' }),
    ).toBeVisible();
    expect(errors).toEqual([]);

    // DB contract: exactly one ticket, manual provenance, null source_ref + dedup_key, no audit.
    const row = readDb((db) =>
      db
        .prepare(
          `SELECT id, provenance, source_ref, dedup_key
             FROM ticket WHERE title = ?`,
        )
        .get('Flow block: deploy gate') as
        | {
            id: string;
            provenance: string;
            source_ref: string | null;
            dedup_key: string | null;
          }
        | undefined,
    );
    expect(row).toBeTruthy();
    expect(row?.provenance).toBe('manual');
    expect(row?.source_ref).toBeNull();
    expect(row?.dedup_key).toBeNull();

    const auditCount = readDb(
      (db) =>
        (
          db
            .prepare(
              'SELECT COUNT(*) AS n FROM classification_audit WHERE ticket_id = ?',
            )
            .get(row!.id) as { n: number }
        ).n,
    );
    expect(auditCount).toBe(0);

    // It appears in triage (open list).
    await page.goto('/');
    await expect(
      page.getByTestId('open-list').getByText('Flow block: deploy gate'),
    ).toBeVisible();
  });

  test('negative: empty title + body are rejected inline, no POST is made', async ({
    page,
  }) => {
    resetTickets(DB);

    // Watch for any POST to /api/tickets — the client gate must short-circuit before this fires.
    let posted = false;
    page.on('request', (req) => {
      if (req.method() === 'POST' && req.url().includes('/api/tickets')) {
        posted = true;
      }
    });

    await page.goto('/tickets/new');

    // Submit with title and body empty (the two client-required-before-fetch fields).
    await page.getByRole('button', { name: 'Create ticket' }).click();

    await expect(page.getByText('Title is required')).toBeVisible();
    await expect(page.getByText('Body is required')).toBeVisible();

    // No request went out, and no row was written.
    expect(posted).toBe(false);
    const count = readDb(
      (db) => (db.prepare('SELECT COUNT(*) AS n FROM ticket').get() as { n: number }).n,
    );
    expect(count).toBe(0);
  });
});
