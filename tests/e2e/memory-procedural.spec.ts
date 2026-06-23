import { test, expect } from '@playwright/test';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { e2eDbPath } from './seed';

// AC-15 / AC-16 / AC-19: the /memory/procedural browser ships its real states (house rule 6) and
// is wired to the session-authed POST /api/memory/procedural/confirm contract from Prompt 6.
//
// Unlike the entities browser, this page has NO client read fetch to intercept — the page does an
// in-process server read (listNotes) of the live e2e DB at request time, and the ONLY client fetch
// is the Confirm POST. So this spec seeds a real pending procedural row directly into the same e2e
// DB the dev server reads (mirroring seedTickets' direct-insert idiom in seed.ts), then drives the
// real Confirm write end-to-end. Letting the POST hit the real route — rather than a route.fulfill
// mock — is the STRONGEST AC-19 proof: it confirms the note as an authenticated SESSION user (the
// storageState cookie, no API key in the browser) and exercises the real confirmNote write. The
// spec owns its own procedural state (it wipes the table first), so there is no shared-state hazard.

const dbPath = e2eDbPath();

// The e2e seed harness (tests/e2e/seed.ts:buildFreshDb) only hand-applies 0001_fts.sql — it
// predates the Recallatron tables and does NOT apply 0005_procedural_notes.sql, so the freshly
// built e2e DB has no procedural_notes table (the real app applies it via
// applyHandWrittenMigrations in db/client.ts; the seed harness was never extended). Rather than
// modify the shared harness from this prompt's scope, this spec idempotently applies the migration
// itself before seeding. (Out-of-scope: buildFreshDb should be extended to apply 0005/0006 — see
// handoff.)
function ensureProceduralTable(): void {
  const sql = fs.readFileSync(
    path.join(process.cwd(), 'db/migrations/0005_procedural_notes.sql'),
    'utf8',
  );
  const db = new Database(dbPath);
  db.exec(sql); // all statements are CREATE ... IF NOT EXISTS — safe to re-run.
  db.close();
}

function resetProcedural(): void {
  ensureProceduralTable();
  const db = new Database(dbPath);
  db.exec('DELETE FROM procedural_notes;');
  db.close();
}

// Insert one unconfirmed candidate the way insertCandidate would (confirmed = 0, mention_count = 1,
// superseded_by = NULL). Returns the inserted id.
function seedPendingNote(opts: {
  category: string;
  note: string;
  sourceSessionId: string;
}): number {
  const db = new Database(dbPath);
  // source_session_id has an FK to session_digest(session_id); the seed deliberately doesn't
  // create a digest row, so insert with FK enforcement off (mirrors how the real insertCandidate
  // path doesn't pre-seed a digest either — the page/confirm read paths don't join the digest).
  db.pragma('foreign_keys = OFF');
  const now = new Date().toISOString();
  const info = db
    .prepare(
      `INSERT INTO procedural_notes
         (category, note, note_norm, source_session_id, confirmed, confirmed_at,
          superseded_by, mention_count, chat_id, created_at, ts)
       VALUES (?, ?, ?, ?, 0, NULL, NULL, 1, NULL, ?, ?)`,
    )
    .run(opts.category, opts.note, opts.note.trim().toLowerCase(), opts.sourceSessionId, now, now);
  db.close();
  return Number(info.lastInsertRowid);
}

const PENDING_NOTE = 'Taylor prefers the school run handled before 8am';

test.describe('/memory/procedural — procedural-note browser', () => {
  test.beforeEach(() => {
    resetProcedural();
  });

  test('renders the Pending tab with a seeded row', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    seedPendingNote({ category: 'scheduling', note: PENDING_NOTE, sourceSessionId: 'sess-e2e-1' });

    await page.goto('/memory/procedural');

    await expect(
      page.getByRole('heading', { name: 'Procedural notes', exact: true }),
    ).toBeVisible();
    // Pending is the default tab and the seeded row is shown.
    await expect(page.getByTestId('tab-pending')).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByText(PENDING_NOTE)).toBeVisible();
    expect(errors).toEqual([]);
  });

  test('Pending empty state shows when there are no pending notes', async ({ page }) => {
    // No seed — the table was wiped in beforeEach.
    await page.goto('/memory/procedural');
    await expect(page.getByText('No pending notes')).toBeVisible();
  });

  test('AC-15 / AC-19: Confirm moves the row Pending→Confirmed without a full reload, as a session user', async ({
    page,
  }) => {
    seedPendingNote({ category: 'scheduling', note: PENDING_NOTE, sourceSessionId: 'sess-e2e-2' });
    await page.goto('/memory/procedural');

    // The seeded row is on the Pending tab.
    await expect(page.getByTestId('procedural-row')).toHaveCount(1);
    await expect(page.getByText(PENDING_NOTE)).toBeVisible();

    // Capture the confirm POST so we can assert it went out as a session request (no API key in
    // the browser — only the storageState cookie) and returned 200 (AC-19).
    const respPromise = page.waitForResponse(
      (r) =>
        r.url().includes('/api/memory/procedural/confirm') && r.request().method() === 'POST',
    );

    // Mark the page so we can prove there was NO full reload (AC-15): a hard navigation wipes this.
    await page.evaluate(() => {
      (window as unknown as { __noReload: boolean }).__noReload = true;
    });

    await page.getByTestId('confirm-button').click();

    const resp = await respPromise;
    expect(resp.status()).toBe(200); // AC-19: session cookie alone is accepted by the write route.
    // The request carried no Authorization header (no API key) — it authed via the session cookie.
    expect(resp.request().headers()['authorization']).toBeUndefined();

    // AC-15: the row left the Pending tab without a full reload (the sentinel survives).
    await expect(page.getByText(PENDING_NOTE)).toHaveCount(0);
    await expect(page.getByText('No pending notes')).toBeVisible();
    const survived = await page.evaluate(
      () => (window as unknown as { __noReload?: boolean }).__noReload === true,
    );
    expect(survived).toBe(true);

    // The confirmed note shows on the Confirmed tab (optimistic move, no reload).
    await page.getByTestId('tab-confirmed').click();
    await expect(page.getByText(PENDING_NOTE)).toBeVisible();
  });
});
