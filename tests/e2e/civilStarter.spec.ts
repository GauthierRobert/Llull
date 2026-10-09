import { expect, test } from '@playwright/test';

/** End-to-end: the empty-state "Civil site starter" builds the sample site (offline / local mode). */

test('Civil site starter builds survey, terrain, pad, road and storm network', async ({ page }) => {
  await page.addInitScript(() => window.localStorage.clear());
  await page.goto('/');
  await page.getByRole('button', { name: /civil site starter/i }).click();

  const panel = page.getByTestId('civil-panel');
  await expect(panel).toBeVisible();
  await expect(panel.getByRole('img', { name: '11 civil objects' })).toBeVisible({
    timeout: 30_000,
  });
  await expect(panel.getByLabel('1 point groups', { exact: true })).toBeVisible();
  await expect(panel.getByLabel('1 surfaces', { exact: true })).toBeVisible();
  await expect(panel.getByLabel('1 platforms', { exact: true })).toBeVisible();
  await expect(panel.getByLabel('1 alignments', { exact: true })).toBeVisible();
  await expect(panel.getByLabel('4 manholes, 3 pipes', { exact: true })).toBeVisible();
  await expect(page.getByTestId('civil-row-pointGroup-1')).toContainText('911 points');
  await expect(page.locator('.status-summary')).toContainText('Plan complete');
  await expect(page.getByRole('region', { name: 'Get started' })).toBeHidden();
});
