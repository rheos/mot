import { test, expect } from '@playwright/test';
import { e2eDbPath, resetTickets, seedTickets } from './seed';

// AC-EC8 (UI half): a snoozed ticket whose snoozed_until is now in the past surfaces in the
// wake-pending section, and is NOT in the open list (it is still status=snoozed). The data layer
// flags it via wake_pending=true (status=snoozed AND snoozed_until < now); the UI renders that
// set in the amber wake-pending section.

const DB = e2eDbPath();

test('past-due snoozed ticket appears in wake-pending, not the open list', async ({
  page,
}) => {
  resetTickets(DB);

  const thirtyMinAgo = new Date(Date.now() - 30 * 60 * 1000).toISOString();
  seedTickets(DB, [
    {
      id: 'ec8-snoozed',
      title: 'Snoozed and overdue',
      status: 'snoozed',
      severity: 'high',
      snoozed_until: thirtyMinAgo,
    },
    { id: 'ec8-open', title: 'A plain open ticket', status: 'open', severity: 'normal' },
  ]);

  await page.goto('/');

  // Wake-pending section is visible and contains the overdue ticket.
  const wakeSection = page.getByTestId('wake-pending');
  await expect(wakeSection).toBeVisible();
  await expect(wakeSection.getByText('Snoozed and overdue')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Wake all' })).toBeVisible();

  // The open list contains the plain open ticket but NOT the snoozed one.
  const openList = page.getByTestId('open-list');
  await expect(openList.getByText('A plain open ticket')).toBeVisible();
  await expect(openList.getByText('Snoozed and overdue')).toHaveCount(0);
});
