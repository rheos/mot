import { test, expect, type Route } from '@playwright/test';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { e2eDbPath } from './seed';

// AC-14 / AC-16: the /memory/topics browser ships its real states (house rule 6) and is wired to
// the session-authed GET /api/memory/topics/<slug>/summarize contract from Prompt 9.
//
// The thread list comes from the page's in-process server read (listThreads) of the live e2e DB at
// request time, so the threads must be REAL rows in the same DB the dev server reads — this spec
// seeds them directly (mirroring memory-procedural.spec.ts). The Synthesize result, by contrast, is
// fetched by the client island, so it is intercepted with route.fulfill (the memory-entities.spec.ts
// idiom) and injected as a deterministic structured SummarizeResult — that keeps the assertion off
// the live ontology DB and lets us assert the route, not /api/mcp, was called.
//
// The e2e seed harness (tests/e2e/seed.ts:buildFreshDb) only hand-applies 0001_fts.sql — it predates
// the Recallatron tables and does NOT apply 0004_topic_threads.sql, so the freshly built e2e DB has
// no topic_thread table. Rather than modify the shared harness from this prompt's scope, this spec
// idempotently applies 0004 itself before seeding (every statement is CREATE ... IF NOT EXISTS, safe
// to re-run). (Out-of-scope: buildFreshDb should be extended to apply 0004/0005/0006 — see handoff.)

const dbPath = e2eDbPath();

function ensureTopicTables(): void {
  const sql = fs.readFileSync(
    path.join(process.cwd(), 'db/migrations/0004_topic_threads.sql'),
    'utf8',
  );
  const db = new Database(dbPath);
  db.exec(sql); // all statements are CREATE ... IF NOT EXISTS — safe to re-run.
  db.close();
}

function resetTopics(): void {
  ensureTopicTables();
  const db = new Database(dbPath);
  // Wipe the join first (FK), then the threads, so each spec controls its own state.
  db.exec('DELETE FROM topic_thread_session; DELETE FROM topic_thread;');
  db.close();
}

// Insert a topic thread directly (no linked sessions — the detail's session list is supplied by the
// mocked summarize call, not the DB). last_active_at drives the list order (DESC).
function seedThread(opts: {
  slug: string;
  title: string;
  lastActiveAt: string;
}): void {
  const db = new Database(dbPath);
  db.prepare(
    `INSERT INTO topic_thread (slug, title, notes, created_at, last_active_at)
     VALUES (?, ?, NULL, ?, ?)`,
  ).run(opts.slug, opts.title, opts.lastActiveAt, opts.lastActiveAt);
  db.close();
}

const NEWER = { slug: 'school-logistics', title: 'School logistics', lastActiveAt: '2026-06-22T10:00:00.000Z' };
const OLDER = { slug: 'house-projects', title: 'House projects', lastActiveAt: '2026-06-01T09:00:00.000Z' };

// A deterministic structured SummarizeResult (OQ-1 = (b)) for the Synthesize fetch — a session list,
// not prose.
const SUMMARY = {
  slug: NEWER.slug,
  title: NEWER.title,
  session_count: 2,
  truncated: false,
  sessions: [
    {
      session_id: 'sess-newer',
      summary: 'Agreed the school run is handled before 8am on weekdays.',
      ts: '2026-06-22T10:00:00.000Z',
    },
    {
      session_id: 'sess-older',
      summary: 'Sorted out the after-school pickup rota for the term.',
      ts: '2026-06-20T16:00:00.000Z',
    },
  ],
};

async function fulfilSummarize(route: Route): Promise<void> {
  await route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify(SUMMARY),
  });
}

test.describe('/memory/topics — topic browser', () => {
  test.beforeEach(() => {
    resetTopics();
  });

  test('renders the thread list in last_active_at DESC order (AC-14)', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    // Seed OLDER first so insertion order != display order — proving the DESC sort, not insert order.
    seedThread(OLDER);
    seedThread(NEWER);

    await page.goto('/memory/topics');

    await expect(page.getByRole('heading', { name: 'Topics', exact: true })).toBeVisible();

    const rows = page.getByTestId('topic-row');
    await expect(rows).toHaveCount(2);
    // The newer thread (most recent last_active_at) is first.
    await expect(rows.nth(0)).toContainText(NEWER.title);
    await expect(rows.nth(1)).toContainText(OLDER.title);
    expect(errors).toEqual([]);
  });

  test('empty state shows when there are no threads', async ({ page }) => {
    // No seed — the table was wiped in beforeEach.
    await page.goto('/memory/topics');
    await expect(page.getByText('No topic threads yet')).toBeVisible();
  });

  test('clicking a thread opens the detail panel, and Synthesize renders the structured session list', async ({
    page,
  }) => {
    seedThread(NEWER);
    // Intercept the client Synthesize fetch with a deterministic structured result.
    await page.route('**/api/memory/topics/**/summarize**', fulfilSummarize);

    await page.goto('/memory/topics');

    // Open the thread — the detail panel shows thread info.
    await page.getByTestId('topic-row').first().click();
    const detail = page.getByTestId('topic-detail');
    await expect(detail.getByRole('heading', { name: NEWER.title })).toBeVisible();

    // Synthesize MUST hit the session-authed summarize route (NOT /api/mcp).
    const reqPromise = page.waitForRequest((req) =>
      req.url().includes(`/api/memory/topics/${NEWER.slug}/summarize`),
    );
    await page.getByTestId('synthesize-button').click();
    const req = await reqPromise;
    expect(req.url()).not.toContain('/api/mcp');

    // The structured session list renders (OQ-1 = (b)) — two sessions with their summaries.
    await expect(detail.getByTestId('synthesis-result')).toBeVisible();
    await expect(detail.getByTestId('synthesis-session')).toHaveCount(2);
    await expect(
      detail.getByText('Agreed the school run is handled before 8am on weekdays.'),
    ).toBeVisible();
    // The total session count is surfaced.
    await expect(detail.getByTestId('synthesis-count')).toContainText('2 sessions total');
  });
});
