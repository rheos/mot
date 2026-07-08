import { test, expect, type Route } from '@playwright/test';

// AC-13 / AC-16: the /memory/entities browser ships its real states (house rule 6) and is wired
// to the GET /api/memory/entities contract from Prompt 6. The e2e dev server reads the live
// ontology/graph.jsonl (no MOT_GRAPH_PATH override in playwright.config.ts), so rather than write
// to that real file these tests intercept the client search fetch and inject deterministic
// EntityRecord[] — the same route.fulfill idiom ui-states.spec.ts uses for /api/tickets. The
// page's own server-side initial read is left untouched; we drive the island via its client
// search/filter path, which is exactly what the route interception covers.

interface SeedEntity {
  id: string;
  type: string;
  label: string;
  properties: Record<string, unknown>;
  valid_from: string;
  valid_until: string | null;
  confidence: number;
  source: string;
  superseded_by: string | null;
  confirmed: boolean;
}

function entity(over: Partial<SeedEntity> & Pick<SeedEntity, 'id' | 'label'>): SeedEntity {
  return {
    type: 'Person',
    properties: {},
    valid_from: '2026-06-01T00:00:00.000Z',
    valid_until: null,
    confidence: 0.9,
    source: 'session:seed',
    superseded_by: null,
    confirmed: true,
    ...over,
  };
}

const CONFIRMED = entity({
  id: 'ent-alex',
  label: 'Alex',
  type: 'Person',
  confirmed: true,
  confidence: 0.95,
});

const UNCONFIRMED = entity({
  id: 'ent-school',
  label: 'School run',
  type: 'Fact',
  confirmed: false,
  confidence: 0.6,
});

// Fulfil the entities route based on the unconfirmed_only flag: the island sends it when the
// Unconfirmed filter is active, so this both seeds data AND lets us assert the filter applied.
async function fulfilEntities(route: Route): Promise<void> {
  const url = new URL(route.request().url());
  const unconfirmedOnly = url.searchParams.get('unconfirmed_only') === 'true';
  const body = unconfirmedOnly ? [UNCONFIRMED] : [CONFIRMED, UNCONFIRMED];
  await route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify(body),
  });
}

test.describe('/memory/entities — entity browser', () => {
  test('renders the page without error', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.route('**/api/memory/entities**', fulfilEntities);

    await page.goto('/memory/entities');
    await expect(
      page.getByRole('heading', { name: 'Entities', exact: true }),
    ).toBeVisible();
    expect(errors).toEqual([]);
  });

  test('unconfirmed filter applies (requests unconfirmed_only=true)', async ({ page }) => {
    await page.route('**/api/memory/entities**', fulfilEntities);
    await page.goto('/memory/entities');

    // Click the Unconfirmed tab and wait for the request it fires — proving the filter applied.
    const reqPromise = page.waitForRequest(
      (req) =>
        req.url().includes('/api/memory/entities') &&
        req.url().includes('unconfirmed_only=true'),
    );
    await page.getByTestId('filter-unconfirmed').click();
    await reqPromise;

    // The unconfirmed branch returns only the unconfirmed entity.
    await expect(page.getByText('School run')).toBeVisible();
    await expect(page.getByText('Alex')).toHaveCount(0);
  });

  test('clicking an entity opens the detail panel with relations + supersession state', async ({
    page,
  }) => {
    await page.route('**/api/memory/entities**', fulfilEntities);
    await page.goto('/memory/entities');

    // Drive a search so the island fetches the seeded (mocked) set.
    await page.getByTestId('entity-search').fill('a');
    await expect(page.getByTestId('entity-row').first()).toBeVisible();

    await page.getByText('Alex').click();
    const detail = page.getByTestId('entity-detail');
    await expect(detail.getByRole('heading', { name: 'Alex' })).toBeVisible();
    // GAP #4 — the relations sub-panel renders an explicit empty state, not a blank gap.
    await expect(detail.getByTestId('no-relations')).toBeVisible();
    // Supersession state is shown (this entity is active).
    await expect(detail.getByText('Active')).toBeVisible();
  });
});

// ── Track 6, Phase 4 — relations panel (label resolution + confirm/reject island) ──────────────
// FR15 (resolved labels) / FR16 (Confirm+Reject on candidate edges) / AC-12 / AC-13. Same
// route.fulfill idiom as above: relate patches live in ontology/graph.jsonl (JSONL, not SQLite),
// and the e2e dev server reads the live graph file with no MOT_GRAPH_PATH override, so these
// cases drive the island via mocked GET /api/memory/entities + a mocked POST /api/memory/relations
// — they prove the browser interaction (resolved label, Confirm button, Reject removal), not the
// real fold (that is covered at depth by Prompt 1's integration suite).

const ALICE = entity({
  id: 'ent-a',
  label: 'Alice',
  type: 'Person',
  confirmed: true,
  properties: {
    relations: [
      { rel: 'child_of', target_id: 'ent-b', confirmed: true },
      { rel: 'works_on', target_id: 'ent-b', confirmed: false },
    ],
  },
});

const BOB = entity({ id: 'ent-b', label: 'Bob', type: 'Person', confirmed: true });

// A confirmed RelatePatch shape (what confirmRelate returns on success) for the confirm-mock.
const CONFIRMED_PATCH = {
  op: 'relate',
  from: 'ent-a',
  rel: 'works_on',
  to: 'ent-b',
  confidence: 1,
  source: 'manual',
  valid_from: '2026-06-01T00:00:00.000Z',
  valid_until: null,
  confirmed: true,
  ts: '2026-07-08T00:00:00.000Z',
};

async function fulfilRelationEntities(route: Route): Promise<void> {
  await route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify([ALICE, BOB]),
  });
}

async function selectAlice(page: import('@playwright/test').Page): Promise<void> {
  await page.route('**/api/memory/entities**', fulfilRelationEntities);
  await page.goto('/memory/entities');
  // Drive a search so the island fetches the seeded (mocked) set.
  await page.getByTestId('entity-search').fill('a');
  await expect(page.getByTestId('entity-row').first()).toBeVisible();
  await page.getByText('Alice').click();
  await expect(
    page.getByTestId('entity-detail').getByRole('heading', { name: 'Alice' }),
  ).toBeVisible();
}

test.describe('/memory/entities — Track 6 relations panel', () => {
  test('AC-12: confirmed edge renders resolved label with no button; unconfirmed shows Confirm', async ({
    page,
  }) => {
    await selectAlice(page);
    const detail = page.getByTestId('entity-detail');

    // Both edges point at ent-b → resolved to "Bob" via the labelMap (FR15), not the raw id.
    await expect(detail.getByTestId('relation-target').first()).toHaveText('Bob');
    await expect(detail.getByText('ent-b')).toHaveCount(0);

    // child_of is confirmed → no Confirm button. works_on is unconfirmed → Confirm button visible.
    const childRow = detail.getByTestId('relation-row').filter({ hasText: 'child_of' });
    const worksRow = detail.getByTestId('relation-row').filter({ hasText: 'works_on' });
    await expect(childRow.getByTestId('relation-confirm')).toHaveCount(0);
    await expect(worksRow.getByTestId('relation-confirm')).toBeVisible();
  });

  test('AC-12: confirming an unconfirmed edge removes its Confirm button (stays visible)', async ({
    page,
  }) => {
    await page.route('**/api/memory/relations', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(CONFIRMED_PATCH),
      });
    });
    await selectAlice(page);
    const detail = page.getByTestId('entity-detail');
    const worksRow = detail.getByTestId('relation-row').filter({ hasText: 'works_on' });

    await worksRow.getByTestId('relation-confirm').click();

    // Button gone; the edge itself stays visible as a (now confirmed) relation.
    await expect(worksRow.getByTestId('relation-confirm')).toHaveCount(0);
    await expect(detail.getByTestId('relation-row').filter({ hasText: 'works_on' })).toBeVisible();
  });

  test('W4: rejecting an unconfirmed edge removes it from the panel', async ({ page }) => {
    let rejectBody: unknown = null;
    await page.route('**/api/memory/relations', async (route) => {
      rejectBody = route.request().postDataJSON();
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ ...CONFIRMED_PATCH, confirmed: false, valid_until: '2026-07-08T00:00:00.000Z' }),
      });
    });
    await selectAlice(page);
    const detail = page.getByTestId('entity-detail');
    const worksRow = detail.getByTestId('relation-row').filter({ hasText: 'works_on' });

    await worksRow.getByTestId('relation-reject').click();

    // The POST carried action:'reject', and the edge disappeared from the panel.
    expect(rejectBody).toMatchObject({ from: 'ent-a', rel: 'works_on', to: 'ent-b', action: 'reject' });
    await expect(detail.getByTestId('relation-row').filter({ hasText: 'works_on' })).toHaveCount(0);
    // The confirmed child_of edge is untouched.
    await expect(detail.getByTestId('relation-row').filter({ hasText: 'child_of' })).toBeVisible();
  });

  test('AC-13: "No relations" shows for an entity with an empty relations array', async ({
    page,
  }) => {
    const empty = entity({
      id: 'ent-empty',
      label: 'Lonely',
      type: 'Fact',
      confirmed: true,
      properties: { relations: [] },
    });
    await page.route('**/api/memory/entities**', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([empty]),
      });
    });
    await page.goto('/memory/entities');
    await page.getByTestId('entity-search').fill('l');
    await expect(page.getByTestId('entity-row').first()).toBeVisible();
    await page.getByText('Lonely').click();
    await expect(page.getByTestId('entity-detail').getByTestId('no-relations')).toBeVisible();
  });
});
