import { test, expect, type Page } from '@playwright/test';
import {
  SESSION_A,
  COMPARISON_ID,
  runListFixture,
  runDetailFixture,
  comparisonFixture,
} from './fixtures';

// All API calls are intercepted via page.route() — no real backend or database is used.

function setupAuthenticatedRoutes(page: Page) {
  return Promise.all([
    page.route(/\/api\/v1\/runs(\?.*)?$/, (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(runListFixture),
      }),
    ),
    page.route(new RegExp(`/api/v1/runs/${SESSION_A}`), (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(runDetailFixture),
      }),
    ),
    page.route(/\/api\/v1\/comparisons(\?.*)?$/, (route) =>
      route.fulfill({
        status: 201,
        contentType: 'application/json',
        body: JSON.stringify(comparisonFixture),
      }),
    ),
    page.route(new RegExp(`/api/v1/comparisons/${COMPARISON_ID}`), (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(comparisonFixture),
      }),
    ),
    page.route(/\/dashboard\/login/, (route) =>
      route.fulfill({ status: 200 }),
    ),
    page.route(/\/dashboard\/logout/, (route) =>
      route.fulfill({ status: 200 }),
    ),
  ]);
}

test.describe('SiliconScope Dashboard smoke suite', () => {
  test('1. Unauthenticated access to / redirects to /login', async ({ page }) => {
    await page.route(/\/api\/v1\/runs/, (route) =>
      route.fulfill({ status: 401 }),
    );
    await page.goto('/');
    await expect(page).toHaveURL(/\/login/, { timeout: 5_000 });
    await expect(page.getByRole('heading', { name: 'SiliconScope AI' })).toBeVisible();
  });

  test('2. Login form submission succeeds and shows Run History', async ({ page }) => {
    await setupAuthenticatedRoutes(page);
    await page.goto('/login');
    await page.fill('input[type="password"]', 'test-password');
    await page.click('button[type="submit"]');
    await expect(page.getByRole('heading', { name: 'Run History' })).toBeVisible({
      timeout: 5_000,
    });
  });

  test('3. Run History page renders run data', async ({ page }) => {
    await setupAuthenticatedRoutes(page);
    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'Run History' })).toBeVisible({
      timeout: 5_000,
    });
    await expect(page.getByText('Baseline Run')).toBeVisible();
    await expect(page.getByText('Candidate Run')).toBeVisible();
  });

  test('4. Clicking a run link opens Run Detail page', async ({ page }) => {
    await setupAuthenticatedRoutes(page);
    await page.goto('/');
    await page.getByRole('heading', { name: 'Run History' }).waitFor();
    // The run link shows the first 8 chars of the session_id
    await page.getByRole('link', { name: SESSION_A.slice(0, 8) }).click();
    await expect(page).toHaveURL(new RegExp(`/runs/${SESSION_A}`));
    await expect(page.getByRole('heading', { name: 'Baseline Run' })).toBeVisible({
      timeout: 5_000,
    });
  });

  test('5. Selecting two runs and comparing navigates to comparison result', async ({ page }) => {
    await setupAuthenticatedRoutes(page);
    await page.goto('/');
    await page.getByRole('heading', { name: 'Run History' }).waitFor();

    // Check both run checkboxes
    const checkboxes = page.getByRole('checkbox');
    await checkboxes.nth(0).check();
    await checkboxes.nth(1).check();

    await page.getByRole('button', { name: 'Compare selected' }).click();

    // ComparePage auto-triggers comparison when both params are present
    await expect(page).toHaveURL(new RegExp(`/comparisons/${COMPARISON_ID}`), {
      timeout: 10_000,
    });
  });

  test('6. Comparison result page shows overall summary and per-metric table', async ({
    page,
  }) => {
    await setupAuthenticatedRoutes(page);
    await page.goto(`/comparisons/${COMPARISON_ID}`);

    const summaryLabel = page.getByRole('status', { name: /Overall result/ });
    await expect(summaryLabel).toBeVisible({ timeout: 5_000 });
    await expect(summaryLabel).toContainText('Regression detected');
    await expect(page.getByRole('cell', { name: 'BM_cpu_integer' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Export comparison as JSON' })).toBeVisible();
  });

  test('7. Logout navigates to /login; protected route then requires re-login', async ({
    page,
  }) => {
    await setupAuthenticatedRoutes(page);
    await page.goto('/');
    await page.getByRole('heading', { name: 'Run History' }).waitFor();

    // Log out
    await page.getByRole('button', { name: 'Log out' }).click();
    await expect(page).toHaveURL(/\/login/, { timeout: 5_000 });

    // After logout, accessing / with a 401 auth check redirects to /login
    await page.route(/\/api\/v1\/runs/, (route) =>
      route.fulfill({ status: 401 }),
    );
    await page.goto('/');
    await expect(page).toHaveURL(/\/login/, { timeout: 5_000 });
  });
});
