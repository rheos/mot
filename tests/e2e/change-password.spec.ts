import { test, expect } from '@playwright/test';

// Change-password screen (/account). Tests start authenticated via the storageState global-setup
// writes (a sealed mot_session cookie), so we navigate straight to the gated page. The seeded e2e
// DB carries the current UI password as MOT_UI_PASSWORD (= E2E_PASSWORD, 'e2e-password'), seeded
// into app_secret.ui_password_hash by bootstrapUiPassword() at server boot — so a valid current +
// new + confirm submit returns 200 and shows the success message. The negative case proves the
// client gate rejects a mismatched confirm BEFORE any request goes out (no POST to the endpoint).

const CURRENT_PASSWORD = 'e2e-password'; // == E2E_PASSWORD / MOT_UI_PASSWORD seeded into the DB

test.describe('Change password — /account', () => {
  test('positive: valid current + matching new password shows success', async ({
    page,
  }) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));

    await page.goto('/account');
    await expect(
      page.getByRole('heading', { name: 'Change password' }),
    ).toBeVisible();

    await page.getByLabel('Current password').fill(CURRENT_PASSWORD);
    await page.getByLabel('New password', { exact: true }).fill('a-new-password-99');
    await page.getByLabel('Confirm new password').fill('a-new-password-99');

    await page.getByRole('button', { name: 'Change password' }).click();

    // Success message appears and the user stays on /account (not forced to log out).
    await expect(page.getByText('Password changed')).toBeVisible();
    expect(new URL(page.url()).pathname).toMatch(/\/account$/);
    expect(errors).toEqual([]);

    // Fields are cleared on success.
    await expect(page.getByLabel('Current password')).toHaveValue('');
    await expect(page.getByLabel('New password', { exact: true })).toHaveValue('');
    await expect(page.getByLabel('Confirm new password')).toHaveValue('');
  });

  test('negative: mismatched confirm shows the inline error and makes no request', async ({
    page,
  }) => {
    // Watch for any POST to the endpoint — the client gate must short-circuit before this fires.
    let posted = false;
    page.on('request', (req) => {
      if (
        req.method() === 'POST' &&
        req.url().includes('/api/account/password')
      ) {
        posted = true;
      }
    });

    await page.goto('/account');

    await page.getByLabel('Current password').fill(CURRENT_PASSWORD);
    await page.getByLabel('New password', { exact: true }).fill('a-new-password-99');
    await page.getByLabel('Confirm new password').fill('different-password-99');

    await page.getByRole('button', { name: 'Change password' }).click();

    await expect(page.getByText("Passwords don't match")).toBeVisible();
    expect(posted).toBe(false);
  });
});
