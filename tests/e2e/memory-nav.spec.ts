import { test, expect } from '@playwright/test';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { e2eDbPath } from './seed';

// Recallatron nav integration (this prompt): the three /memory/* pages, previously reachable only
// by typing the URL, are now wired into the chrome — a Recallatron link in the TopNav and a section
// sub-nav (MemoryNav) at the top of each page. This spec proves both, end-to-end, through the seeded
// session (storageState — every /memory route is behind the middleware).
//
// The e2e seed harness (tests/e2e/seed.ts:buildFreshDb) only hand-applies 0001_fts.sql and predates
// the Recallatron tables, so the fresh e2e DB has no topic_thread table — landing on /memory/topics
// (the page does an in-process listThreads read) would 500 without it. Mirroring memory-topics.spec.ts,
// this spec idempotently applies 0004 first (every statement is CREATE ... IF NOT EXISTS, safe to
// re-run). The entities page reads the live ontology/graph.jsonl, which lib/graph.ts auto-creates on
// first read, so it needs no setup here.

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

test.describe('Recallatron nav integration', () => {
  test.beforeEach(() => {
    ensureTopicTables();
  });

  test('(a) the Recallatron TopNav link is visible from / and navigates to /memory/entities', async ({
    page,
  }) => {
    await page.goto('/');

    const recallatron = page.getByRole('link', { name: 'Recallatron' });
    await expect(recallatron).toBeVisible();

    await recallatron.click();
    await expect(page).toHaveURL(/\/memory\/entities$/);
    // The destination page rendered its own island heading — the route resolved, not 404.
    await expect(
      page.getByRole('heading', { name: 'Entities', exact: true }),
    ).toBeVisible();
  });

  test('(b) the section sub-nav shows all three tabs, marks the active one, and navigates', async ({
    page,
  }) => {
    await page.goto('/memory/entities');

    // All three tabs are present.
    const entitiesTab = page.getByTestId('memory-nav-entities');
    const topicsTab = page.getByTestId('memory-nav-topics');
    const proceduralTab = page.getByTestId('memory-nav-procedural');
    await expect(entitiesTab).toBeVisible();
    await expect(topicsTab).toBeVisible();
    await expect(proceduralTab).toBeVisible();

    // On /memory/entities, the Entities tab is the active one (and only it).
    await expect(entitiesTab).toHaveAttribute('aria-current', 'page');
    await expect(topicsTab).not.toHaveAttribute('aria-current', 'page');
    await expect(proceduralTab).not.toHaveAttribute('aria-current', 'page');

    // Clicking Topics lands on /memory/topics, where the Topics tab becomes active.
    await topicsTab.click();
    await expect(page).toHaveURL(/\/memory\/topics$/);
    await expect(page.getByTestId('memory-nav-topics')).toHaveAttribute('aria-current', 'page');
    await expect(page.getByTestId('memory-nav-entities')).not.toHaveAttribute(
      'aria-current',
      'page',
    );
    await expect(page.getByRole('heading', { name: 'Topics', exact: true })).toBeVisible();
  });
});
