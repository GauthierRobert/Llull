import { expect, test } from '@playwright/test';
import { captureDownloads, downloadText } from './buildingHelpers';

/** End-to-end: a civil / site workflow in the real app (offline / local mode). */

function survey(): string {
  const lines = ['P,E,N,Z,D'];
  let number = 1;
  for (let i = 0; i <= 10; i++) {
    for (let j = 0; j <= 10; j++) {
      lines.push(
        `${number++},${i * 10},${j * 10},${(100 + i * 0.3 + Math.sin(j / 2)).toFixed(3)},TOPO`,
      );
    }
  }
  return lines.join('\n');
}

test('survey -> terrain -> LandXML in the Civil / Site panel', async ({ page }) => {
  await captureDownloads(page);
  await page.addInitScript(() => window.localStorage.clear());
  await page.goto('/');
  await page.getByRole('tab', { name: /site/i }).click();
  await page.getByLabel('Survey unit').selectOption('m');
  await page.getByLabel('Survey points text').fill(survey());
  await page.getByRole('button', { name: 'Import points' }).click();
  await expect(page.getByText('121 points')).toBeVisible();

  await page.getByRole('button', { name: 'Create surface' }).click();
  await expect(page.getByText(/121 points, 200 triangles, 10000 m²/)).toBeVisible();

  const landxml = await downloadText(page, () =>
    page.getByRole('button', { name: /LandXML/ }).click(),
  );
  expect(landxml.name).toMatch(/\.xml$/);
  expect(landxml.text).toContain('<Surface name="EG 1">');
  expect(landxml.text.match(/<P id=/g)).toHaveLength(121);
});
