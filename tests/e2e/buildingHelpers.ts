import { expect, type Download, type Page } from '@playwright/test';

/** Shared Playwright helpers for the Building panel workflows (offline/local mode). */

export async function openBuilding(page: Page): Promise<void> {
  await captureDownloads(page);
  // Clear storage before the app boots: clearing a live page and reloading lets its pagehide
  // autosave flush re-write the previous document.
  await page.addInitScript(() => {
    if (location.search.includes('fresh=1')) window.localStorage.clear();
  });
  // The old page's pagehide autosave can run concurrently with the next navigation (Chromium
  // unloads the old document in parallel), so disarm its storage writes before leaving.
  await page
    .evaluate(() => {
      window.localStorage.clear();
      Storage.prototype.setItem = () => undefined;
    })
    .catch(() => undefined);
  await page.goto('about:blank');
  await page.goto('/?fresh=1');
  await page.getByRole('tab', { name: 'Building' }).click();
  await expect(page.getByTestId('building-panel')).toBeVisible();
}

export async function applyTool(
  page: Page,
  tool: string,
  fields: Record<string, string> = {},
): Promise<void> {
  await page.getByTestId('building-tool-select').selectOption(tool);
  for (const [key, value] of Object.entries(fields)) {
    const field = page.getByTestId(`tool-field-${key}`);
    const tag = await field.evaluate((element) => element.tagName);
    if (tag === 'SELECT') await field.selectOption(value);
    else if ((await field.getAttribute('type')) === 'checkbox')
      await field.setChecked(value === 'true');
    else await field.fill(value);
  }
  await page.getByTestId('tool-submit').click();
}

export function elementRows(page: Page, prefix: string): ReturnType<Page['locator']> {
  return page.locator(`[data-testid^="element-row-${prefix}-"]`);
}

/** Records the text of every blob download the app triggers (read back in-page; no Node APIs). */
export async function captureDownloads(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const captured: Array<Promise<string>> = [];
    Object.assign(window, { __downloads: captured });
    const originalClick = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function click(this: HTMLAnchorElement): void {
      if (this.href.startsWith('blob:'))
        captured.push(fetch(this.href).then((response) => response.text()));
      originalClick.call(this);
    };
  });
}

export async function downloadText(
  page: Page,
  trigger: () => Promise<void>,
): Promise<{ name: string; text: string }> {
  const [download]: [Download, void] = await Promise.all([
    page.waitForEvent('download'),
    trigger(),
  ]);
  const text = await page.evaluate(async () => {
    const downloads = (window as unknown as { __downloads: Array<Promise<string>> }).__downloads;
    return (await downloads[downloads.length - 1]) ?? '';
  });
  return { name: download.suggestedFilename(), text };
}

/** Loads `text` into the project file input as if the user picked a file. */
export async function openProjectFile(page: Page, text: string): Promise<void> {
  await page.locator('input[type="file"]').evaluate((input, content) => {
    const transfer = new DataTransfer();
    transfer.items.add(new File([content], 'project.json', { type: 'application/json' }));
    (input as HTMLInputElement).files = transfer.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }, text);
}

export const status = (page: Page): ReturnType<Page['getByTestId']> =>
  page.getByTestId('building-last-summary');
