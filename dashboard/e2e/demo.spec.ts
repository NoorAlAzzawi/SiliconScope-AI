import { test, expect } from '@playwright/test';

// All tests run against the demo Vite dev server (port 5180, VITE_DEMO_MODE=true).
// HashRouter serves routes under /#/path.
// The demoApiAdapter intercepts all axios requests in-process — no backend needed.

test('demo home shows run list with demo data and demo banner', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('note', { name: /demo mode/i })).toBeVisible();
  // Runs table should load without spinner stuck
  await expect(page.getByRole('cell', { name: /Demo Run/i }).first()).toBeVisible();
});

test('demo run detail page loads for baseline session', async ({ page }) => {
  await page.goto('/#/runs/demo-session-baseline');
  await expect(page.getByRole('note', { name: /demo mode/i })).toBeVisible();
  await expect(page.getByRole('heading', { name: /Demo Run/i })).toBeVisible();
});

test('demo run detail page loads for candidate session', async ({ page }) => {
  await page.goto('/#/runs/demo-session-candidate');
  await expect(page.getByRole('heading', { name: /Demo Run/i })).toBeVisible();
});

test('demo compare page loads', async ({ page }) => {
  await page.goto('/#/compare');
  await expect(page.getByRole('heading', { name: /Compare Runs/i })).toBeVisible();
  await expect(page.getByRole('note', { name: /demo mode/i })).toBeVisible();
});

test('demo comparison result page shows regression detected', async ({ page }) => {
  await page.goto('/#/comparisons/demo-comparison-01');
  await expect(page.getByRole('note', { name: /demo mode/i })).toBeVisible();
  await expect(page.getByRole('status', { name: /Regression detected/i })).toBeVisible();
  await expect(page.getByRole('cell', { name: 'BM_cpu_integer' })).toBeVisible();
});

test('demo comparison result page shows high_cv caveat for BM_cache_access', async ({ page }) => {
  await page.goto('/#/comparisons/demo-comparison-01');
  await expect(
    page.getByText('High variance detected (baseline CV=8.4%, candidate CV=9.1%). Detection sensitivity is reduced.'),
  ).toBeVisible();
});

test('no requests are made to /api/ or /dashboard/ backend endpoints', async ({ page }) => {
  const backendRequests: string[] = [];

  page.on('request', (req) => {
    const url = req.url();
    // Exclude Vite dev-server source file requests (e.g. /src/api/client.ts).
    // These are HMR module loads — not actual backend API calls.
    if (url.includes('/src/')) return;
    if (url.includes('/api/') || url.includes('/dashboard/')) {
      backendRequests.push(url);
    }
  });

  await page.goto('/');
  await page.waitForLoadState('networkidle');

  // The demoApiAdapter intercepts all axios requests at the JS level before they
  // reach the browser network layer, so no /api/v1/... or /dashboard/... calls
  // should appear in the browser's network log.
  expect(backendRequests).toHaveLength(0);
});

test('demo banner is visible on runs, compare, and comparison result pages', async ({ page }) => {
  const paths = [
    '/',
    '/#/compare',
    '/#/comparisons/demo-comparison-01',
  ];
  for (const p of paths) {
    await page.goto(p);
    await expect(page.getByRole('note', { name: /demo mode/i })).toBeVisible();
  }
});

test('"Compare Demo Runs" CTA is visible on home page and absent on other pages', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('link', { name: /Compare Demo Runs/i })).toBeVisible();

  // CTA should not appear on other pages
  await page.goto('/#/compare');
  await expect(page.getByRole('link', { name: /Compare Demo Runs/i })).not.toBeVisible();
});

test('"Compare Demo Runs" CTA navigates through the full comparison journey', async ({ page }) => {
  // Start on home page
  await page.goto('/');
  await expect(page.getByRole('cell', { name: /Demo Run/i }).first()).toBeVisible();

  // Click a run to view its detail
  await page.getByRole('link', { name: /demo-ses/i }).first().click();
  await expect(page.getByRole('heading', { name: /Demo Run/i })).toBeVisible();

  // Go back and click the CTA
  await page.goBack();
  const ctaLink = page.getByRole('link', { name: /Compare Demo Runs/i });
  await expect(ctaLink).toBeVisible();
  await ctaLink.click();

  // ComparePage auto-triggers and navigates to comparison result
  await expect(page.getByRole('status', { name: /Regression detected/i })).toBeVisible();
  await expect(page.getByRole('cell', { name: 'BM_cpu_integer' })).toBeVisible();
  await expect(page.getByRole('cell', { name: 'BM_memory_bandwidth' })).toBeVisible();
  await expect(page.getByRole('cell', { name: 'BM_cache_access' })).toBeVisible();

  // High-CV caveat visible
  await expect(
    page.getByText('High variance detected (baseline CV=8.4%, candidate CV=9.1%). Detection sensitivity is reduced.'),
  ).toBeVisible();

  // Demo banner still visible
  await expect(page.getByRole('note', { name: /demo mode/i })).toBeVisible();
});
