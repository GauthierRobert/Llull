import { expect, test } from '@playwright/test';
import { captureDownloads, downloadText } from './buildingHelpers';

/** End-to-end: a box documented on a drawing sheet — Sheets tab → create sheet → viewer → SVG download → live update. */

test('drawing sheet: create, view, download, follows the model', async ({ page }) => {
  test.setTimeout(120_000);
  await captureDownloads(page);
  await page.addInitScript(() => window.localStorage.clear());
  await page.goto('/');

  await page.getByRole('button', { name: 'Tools', exact: true }).click();
  await page.getByRole('button', { name: 'Box', exact: true }).click();
  await expect(page.getByRole('contentinfo', { name: 'Document status' })).toContainText('Entities1');

  await page.getByRole('button', { name: 'Show browser panel', exact: true }).click();
  await page.getByRole('tab', { name: /^Drawing sheets/ }).click();
  const panel = page.getByRole('complementary', { name: 'Drawing sheets' });
  await panel.getByTestId('sheet-create').click();

  const viewer = page.getByTestId('sheet-viewer');
  await expect(viewer).toBeVisible();
  await expect(viewer.getByTestId('sheet-scale')).toContainText('A3');
  await expect(viewer.getByTestId('sheet-fits-warning')).toHaveCount(0);

  const first = await downloadText(page, () => viewer.getByRole('button', { name: 'Download SVG' }).click());
  expect(first.text).toContain('<svg');
  for (const label of ['FRONT', 'TOP', 'RIGHT']) expect(first.text).toContain(label);

  await viewer.getByLabel('Dimensions').check();
  const dimensioned = await downloadText(page, () => viewer.getByRole('button', { name: 'Download SVG' }).click());
  expect(dimensioned.text).not.toBe(first.text);

  await viewer.getByTestId('sheet-close').click();
  await expect(viewer).toHaveCount(0);
  await expect(panel.getByRole('button', { name: /^Open sheet/ })).toHaveCount(1);
});
