import { test, expect } from '@playwright/test';
import { e2eDbPath, resetTickets, seedTickets } from './seed';

// AC-UI-STATES: the triage view ships its real states, not just the happy path (house rule 6).
// Each test controls the DB directly (reset → seed) before navigating; the dev server reads the
// same WAL DB file, so writes are visible immediately. Tests run serially (workers: 1).

const DB = e2eDbPath();

test.describe('Triage view — UI states', () => {
  test('empty state: no open tickets → "No open tickets"', async ({ page }) => {
    resetTickets(DB);
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));

    await page.goto('/');
    await expect(page.getByText('No open tickets')).toBeVisible();
    expect(errors).toEqual([]);
  });

  test('populated state: a seeded open ticket renders its title', async ({ page }) => {
    resetTickets(DB);
    seedTickets(DB, [
      { id: 'ui-populated-1', title: 'Disk almost full on app-01', severity: 'high' },
    ]);
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));

    await page.goto('/');
    await expect(page.getByText('Disk almost full on app-01')).toBeVisible();
    await expect(page.getByText('No open tickets')).toHaveCount(0);
    expect(errors).toEqual([]);
  });

  test('error state: GET /api/tickets 500 → error message + retry affordance', async ({
    page,
  }) => {
    resetTickets(DB);
    seedTickets(DB, [{ id: 'ui-error-1', title: 'Will not load', severity: 'normal' }]);

    // Server render succeeds (in-process read); the client list revalidates against the API on
    // mount. Intercept that call to 500 → the list falls into ErrorState with a Retry control.
    await page.route('**/api/tickets**', (route) =>
      route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'internal_error' }),
      }),
    );

    await page.goto('/');
    await expect(
      page.getByText('Could not load tickets — try again'),
    ).toBeVisible();
    await expect(page.getByRole('button', { name: 'Retry' })).toBeVisible();
  });
});
