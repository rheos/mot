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
