import { expect, test, type Download, type Page } from '@playwright/test';

/**
 * End-to-end: a construction workflow in the real app (offline/local mode), one test per step
 * of docs/CONSTRUCTION_PLAN.md.
 */

async function openBuilding(page: Page): Promise<void> {
  await captureDownloads(page);
  await page.goto('/');
  await page.evaluate(() => window.localStorage.clear());
  await page.reload();
  await page.getByRole('tab', { name: 'Building' }).click();
  await expect(page.getByTestId('building-panel')).toBeVisible();
}

async function applyTool(
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

function elementRows(page: Page, prefix: string): ReturnType<Page['locator']> {
  return page.locator(`[data-testid^="element-row-${prefix}-"]`);
}

/** Records the text of every blob download the app triggers (read back in-page; no Node APIs). */
async function captureDownloads(page: Page): Promise<void> {
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

async function downloadText(
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
async function openProjectFile(page: Page, text: string): Promise<void> {
  await page.locator('input[type="file"]').evaluate((input, content) => {
    const transfer = new DataTransfer();
    transfer.items.add(new File([content], 'project.json', { type: 'application/json' }));
    (input as HTMLInputElement).files = transfer.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }, text);
}

const status = (page: Page): ReturnType<Page['getByTestId']> =>
  page.getByTestId('building-last-summary');

/** Levels + grid + perimeter walls: the base most steps build on. */
async function shell(page: Page): Promise<void> {
  await page.getByLabel('New level name').fill('Ground floor');
  await page.getByRole('button', { name: 'Add level', exact: true }).click();
  await applyTool(page, 'grid', { xSpacings: '5000, 5000', ySpacings: '8000' });
  await applyTool(page, 'perimeter', { x2: '10000', y2: '8000', thickness: '300' });
  await expect(elementRows(page, 'wall')).toHaveCount(4);
}

test.describe('construction workflow', () => {
  test('S1 — levels and project information', async ({ page }) => {
    await openBuilding(page);
    await page.getByLabel('New level name').fill('Ground floor');
    await page.getByRole('button', { name: 'Add level', exact: true }).click();
    await page.getByLabel('New level name').fill('First floor');
    await page.getByLabel('New level height').fill('3200');
    await page.getByRole('button', { name: 'Add level', exact: true }).click();
    await expect(page.getByTestId('level-row-level-1')).toContainText('Ground floor');
    await expect(page.getByTestId('level-row-level-2')).toContainText('+3000');
    await expect(page.getByTestId('level-row-level-2')).toHaveAttribute('aria-current', 'true');

    await page.getByRole('button', { name: 'Activate level Ground floor' }).click();
    await expect(page.getByTestId('level-row-level-1')).toHaveAttribute('aria-current', 'true');

    await page.getByTestId('project-name').fill('Résidence Les Tilleuls');
    await page.getByTestId('project-client').fill('SCI Tilleuls');
    await page.getByRole('button', { name: 'Save project info' }).click();
    await expect(status(page)).toContainText('Résidence Les Tilleuls');
  });

  test('S2 — structural grid', async ({ page }) => {
    await openBuilding(page);
    await applyTool(page, 'grid', { xSpacings: '6000, 6000, 6000', ySpacings: '7500' });
    await expect(elementRows(page, 'grid')).toHaveCount(6);
    await expect(status(page)).toContainText('axes 1, 2, 3, 4, A, B');
  });

  test('S3 — walls from the panel and drawn with the 2D Wall tool', async ({ page }) => {
    await openBuilding(page);
    await shell(page);
    await expect(status(page)).toContainText('total length 36000.000 mm');

    await page.getByRole('button', { name: '2D', exact: true }).click();
    await page.getByRole('button', { name: 'Wall', exact: true }).click();
    const canvas = page.locator('.viewport-2d-wrapper canvas');
    const box = await canvas.boundingBox();
    if (!box) throw new Error('2D canvas not visible');
    await canvas.click({ position: { x: box.width * 0.3, y: box.height * 0.5 } });
    await canvas.click({ position: { x: box.width * 0.5, y: box.height * 0.5 } });
    await canvas.click({ position: { x: box.width * 0.5, y: box.height * 0.3 } });
    await page.keyboard.press('Enter');
    await expect(elementRows(page, 'wall')).toHaveCount(6);
  });

  test('S4 — doors and windows hosted in walls', async ({ page }) => {
    await openBuilding(page);
    await shell(page);
    await applyTool(page, 'door', { wallId: 'wall-1', offset: '2000' });
    await expect(page.getByTestId('element-row-door-1')).toBeVisible();
    await applyTool(page, 'window', { wallId: 'wall-3', offset: '5000', width: '1800' });
    await expect(page.getByTestId('element-row-window-1')).toContainText('1800×1200');

    await applyTool(page, 'window', { wallId: 'wall-1', offset: '2200' });
    await expect(status(page)).toContainText('overlaps D1');
    await expect(elementRows(page, 'window')).toHaveCount(1);
  });

  test('S5 — slab, columns, beam and stair', async ({ page }) => {
    await openBuilding(page);
    await shell(page);
    await applyTool(page, 'slab', { source: 'walls', thickness: '250' });
    await expect(page.getByTestId('element-row-slab-1')).toContainText('floor · 250');
    await applyTool(page, 'column', { atGrid: 'true', width: '400' });
    await expect(elementRows(page, 'column')).toHaveCount(6);
    await applyTool(page, 'beam', { x1: '0', y1: '4000', x2: '10000', y2: '4000' });
    await expect(page.getByTestId('element-row-beam-1')).toBeVisible();
    await applyTool(page, 'stair', { x: '1000', y: '6500' });
    await expect(status(page)).toContainText('2R+G');
  });

  test('S5 — stair well cut through the slab above', async ({ page }) => {
    await openBuilding(page);
    await shell(page);
    await page.getByLabel('New level name').fill('First floor');
    await page.getByRole('button', { name: 'Add level', exact: true }).click();
    await applyTool(page, 'slab', {
      source: 'rectangle',
      x1: '0',
      y1: '0',
      x2: '10000',
      y2: '8000',
    });
    await page.getByRole('button', { name: 'Activate level Ground floor' }).click();
    await applyTool(page, 'stair', { x: '1000', y: '6500' });
    await applyTool(page, 'slabOpening', { source: 'stair', stairId: 'stair-1' });
    await expect(status(page)).toContainText('Cut opening #1');
    await expect(status(page)).toContainText('in slab SL1');
  });

  test('S6 — rooms with area tags', async ({ page }) => {
    await openBuilding(page);
    await shell(page);
    await applyTool(page, 'room', { name: 'Living room', source: 'walls' });
    await expect(page.getByTestId('element-row-room-1')).toContainText('Living room');
    await expect(status(page)).toContainText('74.69 m²');
  });

  test('S7 — quantities, cost estimate and schedules', async ({ page }) => {
    await openBuilding(page);
    await shell(page);
    await applyTool(page, 'door', { wallId: 'wall-1' });
    await expect(page.getByTestId('takeoff-wall.masonry.m3')).toContainText('m³');
    await expect(page.getByTestId('estimate-total')).toContainText('0.00 EUR');

    await page.getByTestId('rate-key').selectOption('wall.masonry.m3');
    await page.getByTestId('rate-value').fill('250');
    await page.getByRole('button', { name: 'Set rate' }).click();
    await expect(page.getByTestId('estimate-total')).not.toContainText('0.00 EUR');

    const takeoff = await downloadText(page, () =>
      page.getByRole('button', { name: 'Takeoff CSV' }).click(),
    );
    expect(takeoff.name).toBe('quantity-takeoff.csv');
    expect(takeoff.text).toContain('wall.masonry.m3');
    await page.getByLabel('Schedule').selectOption('door');
    const schedule = await downloadText(page, () =>
      page.getByRole('button', { name: 'Schedule CSV' }).click(),
    );
    expect(schedule.text.split('\n')[1]).toMatch(/^D1,Ground floor,W1,900,2100,0,left,timber$/);
  });

  test('S8–S10 — DXF, plan sheet and IFC deliverables', async ({ page }) => {
    await openBuilding(page);
    await shell(page);
    await applyTool(page, 'door', { wallId: 'wall-1' });
    await applyTool(page, 'window', { wallId: 'wall-3' });

    const dxf = await downloadText(page, () =>
      page.getByRole('button', { name: 'DXF (AutoCAD)' }).click(),
    );
    expect(dxf.name).toMatch(/\.dxf$/);
    expect(dxf.text.startsWith('0\nSECTION\n2\nHEADER')).toBe(true);
    expect(dxf.text).toContain('A-WALL');

    await page.getByLabel('Paper size').selectOption('A2');
    await page.getByLabel('Drawing scale').selectOption('50');
    const sheet = await downloadText(page, () =>
      page.getByRole('button', { name: 'Plan sheet' }).click(),
    );
    expect(sheet.name).toMatch(/_A2_1-50\.svg$/);
    expect(sheet.text).toContain('id="title-block"');

    const ifc = await downloadText(page, () =>
      page.getByRole('button', { name: 'IFC (BIM)' }).click(),
    );
    expect(ifc.text).toContain("FILE_SCHEMA(('IFC4'));");
    expect(ifc.text).toContain('IFCDOOR(');
    await expect(page.getByTestId('building-export-status')).toContainText('IFC4');
  });

  test('templates, element selection, undo', async ({ page }) => {
    await openBuilding(page);
    await page.getByRole('button', { name: 'Starter office' }).click();
    await expect(page.locator('[data-testid^="level-row-"]')).toHaveCount(4);
    await expect(elementRows(page, 'column')).toHaveCount(12);

    await page.getByRole('button', { name: 'Select Wall W1' }).click();
    await expect(page.getByTestId('element-row-wall-1')).toHaveClass(/panel__row--selected/);

    await page.getByRole('button', { name: 'Delete Wall W1' }).click();
    await expect(page.getByTestId('element-row-wall-1')).toHaveCount(0);
    await page.keyboard.press('Control+z');
    await expect(page.getByTestId('element-row-wall-1')).toBeVisible();
  });

  test('a building survives Save and Open', async ({ page }) => {
    await openBuilding(page);
    await page.getByRole('button', { name: 'Starter house' }).click();
    const saved = await downloadText(page, () =>
      page.getByRole('button', { name: 'Save project to a JSON file' }).click(),
    );
    expect(saved.text).toContain('"building"');

    await openBuilding(page);
    await expect(page.locator('[data-testid^="level-row-"]')).toHaveCount(0);
    await openProjectFile(page, saved.text);
    await expect(page.locator('[data-testid^="level-row-"]')).toHaveCount(3);
    await expect(page.getByTestId('project-name')).toHaveValue('Two-storey house');
  });
});
