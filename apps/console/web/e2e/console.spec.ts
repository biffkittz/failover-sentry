import AxeBuilder from '@axe-core/playwright';
import { expect, mockSignedIn, test } from './fixtures';

test.describe('sign-in', () => {
  test('anonymous visitors land on an accessible sign-in page that remembers where they were going', async ({
    page,
  }) => {
    await page.route('**/api/me', (route) =>
      route.fulfill({ status: 401, json: { error: 'unauthenticated', authMode: 'github' } }),
    );
    await page.goto('/failovers');
    await expect(page).toHaveURL(/\/login\?returnTo=(%2F|\/)failovers/);
    const link = page.getByRole('link', { name: 'Sign in with GitHub' });
    await expect(link).toHaveAttribute('href', '/auth/github/login?returnTo=%2Ffailovers');
    const results = await new AxeBuilder({ page }).analyze();
    expect(results.violations).toEqual([]);
  });

  test('explains why a sign-in was refused', async ({ page }) => {
    await page.route('**/api/me', (route) =>
      route.fulfill({ status: 401, json: { error: 'unauthenticated', authMode: 'github' } }),
    );
    await page.goto('/login?error=not_allowed');
    await expect(page.getByRole('alert')).toContainText('not on the list of operators');
  });
});

test.describe('dashboard', () => {
  test('shows regions, traffic and alerts from the live stream, and passes an accessibility scan', async ({
    page,
  }) => {
    await mockSignedIn(page);
    await page.goto('/');
    await expect(page.getByRole('heading', { level: 1, name: 'Overview' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'East US 2' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Central US' })).toBeVisible();
    await expect(page.getByText('Normal operations')).toBeVisible();
    await expect(page.getByText('Split brain fenced: Central US')).toBeVisible();
    await expect(page.getByRole('switch', { name: /Automatic failover on/ })).toHaveAttribute(
      'aria-checked',
      'true',
    );
    const results = await new AxeBuilder({ page }).analyze();
    expect(results.violations).toEqual([]);
  });

  test('starts an emergency failover through the dialog and opens its page', async ({ page }) => {
    await mockSignedIn(page);
    let posted: unknown = null;
    await page.route('**/api/sentry/failover', async (route) => {
      posted = route.request().postDataJSON();
      expect(route.request().headers()['x-sentry-csrf']).toBe('1');
      await route.fulfill({
        status: 202,
        json: {
          failoverId: 'fo-9',
          epoch: 6,
          fromRegionId: 'eastus2',
          toRegionId: 'centralus',
          mode: 'planned',
        },
      });
    });
    await page.goto('/');
    const opener = page.getByRole('button', { name: 'Emergency failover…' });
    await opener.click();
    const dialog = page.getByRole('dialog', { name: 'Emergency failover' });
    await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: 'Start failover' }).click();
    await expect(dialog.getByText('Say briefly why')).toBeVisible();
    await dialog.getByLabel('Reason').fill('Quarterly DR drill');
    await dialog.getByRole('button', { name: 'Start failover' }).click();
    await expect(page).toHaveURL(/\/failovers\/fo-9$/);
    expect(posted).toEqual({ mode: 'planned', reason: 'Quarterly DR drill' });
  });

  test('closes the dialog with Escape and returns focus to the button that opened it', async ({ page }) => {
    await mockSignedIn(page);
    await page.goto('/');
    const opener = page.getByRole('button', { name: 'Emergency failover…' });
    await opener.click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).toBeHidden();
    await expect(opener).toBeFocused();
  });
});
