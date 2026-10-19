import { expect, test, type Page } from '@playwright/test';
import { captureDownloads, downloadText } from './buildingHelpers';

/**
 * End-to-end: the everyday flow in the Lens shell, only through visible controls (offline/local mode):
 * draw a rectangle (2D) → extrude it → on-model dimensions → export → undo/redo → layers (create, hide, lock).
 * Set LLULL_SHOTS=<dir> to keep a screenshot after each step.
 */

const SHOTS = process.env['LLULL_SHOTS'];
const shot = async (page: Page, name: string): Promise<void> => {
  if (SHOTS !== undefined) await page.screenshot({ path: `${SHOTS}/${name}.png` });
};

const status = (page: Page): ReturnType<Page['getByRole']> => page.getByRole('contentinfo', { name: 'Document status' });
const button = (page: Page, name: string): ReturnType<Page['getByRole']> => page.getByRole('button', { name, exact: true });

async function runPaletteCommand(page: Page, search: string, option: string, fields: Record<string, string> = {}): Promise<void> {
  await page.getByRole('button', { name: /^Search or run a command/ }).click();
  await page.getByRole('combobox', { name: 'Search commands' }).fill(search);
  await page
    .getByRole('option', { name: new RegExp(option, 'i') })
    .first()
    .click();
  for (const [label, value] of Object.entries(fields)) await page.getByLabel(label, { exact: false }).first().fill(value);
  await page.getByRole('button', { name: /^Run/ }).click();
}

test('core flow: draw, extrude, dimension, export, undo/redo, layers', async ({ page }) => {
  test.setTimeout(120_000);
  const errors: string[] = [];
  page.on('console', (message) => {
    // Offline mode: the optional live-sync endpoint refuses connections by design.
    if (message.type() === 'error' && !message.text().includes('Failed to load resource')) errors.push(message.text());
  });
  page.on('pageerror', (error) => errors.push(error.message));
  await captureDownloads(page);
  await page.addInitScript(() => window.localStorage.clear());
  await page.goto('/');
  await shot(page, '00-start');

  // The dock always offers Undo and Redo (disabled while there is nothing to step through).
  await expect(button(page, 'Undo')).toBeDisabled();
  await expect(button(page, 'Redo')).toBeDisabled();

  // (a) Draw a rectangle in 2D.
  await button(page, 'Tools').click();
  await button(page, '2D').click();
  await button(page, 'Rectangle').click();
  const canvas = page.locator('.viewport-2d-wrapper canvas');
  await expect(canvas).toBeVisible();
  const box = (await canvas.boundingBox())!;
  await canvas.click({ position: { x: box.width * 0.4, y: box.height * 0.4 } });
  await canvas.click({ position: { x: box.width * 0.6, y: box.height * 0.6 } });
  await expect(status(page)).toContainText('Entities1');
  await shot(page, '01-rectangle');

  // (b) Extrude it into a solid: the palette pre-fills the rectangle once it is selected.
  await page.keyboard.press('Escape');
  await page.keyboard.press('v');
  await canvas.click({ position: { x: box.width * 0.4, y: box.height * 0.5 } });
  await expect(status(page)).toContainText('Selection1 entity');
  await runPaletteCommand(page, 'extrude', 'extrude_profile|extrude profile', { depth: '40' });
  await expect(status(page)).toContainText('Entities2');
  await page.keyboard.press('3');
  // The extrusion outgrows the 2D framing: the view options (eye) hold Fit all.
  await button(page, 'Show view options').click();
  await button(page, 'Fit all into view').click();
  await button(page, 'Hide view options').click();
  await shot(page, '02-extruded');

  // (c) On-model dimensions: the lens appears over the selected solid and edits its creating step.
  await expect(page.locator('.lens-anchor')).toBeVisible();
  await shot(page, '03-lens');

  // (d) Export a mesh from the More menu.
  await button(page, 'More').click();
  const { name } = await downloadText(page, () => button(page, 'Export the model in the selected format').click());
  expect(name).toBe('model.stl');
  await shot(page, '04-more-export');
  await page.keyboard.press('Escape');

  // (e) Undo / redo through the buttons and the keyboard.
  await expect(button(page, 'Undo')).toBeEnabled();
  await button(page, 'Undo').click();
  await expect(status(page)).toContainText('Entities1');
  await expect(button(page, 'Redo')).toBeEnabled();
  await button(page, 'Redo').click();
  await expect(status(page)).toContainText('Entities2');
  await page.locator('body').click({ position: { x: 5, y: 5 } });
  await page.keyboard.press('Control+z');
  await expect(status(page)).toContainText('Entities1');
  await page.keyboard.press('Control+Shift+z');
  await expect(status(page)).toContainText('Entities2');
  await page.keyboard.press('Control+z');
  await page.keyboard.press('Control+y');
  await expect(status(page)).toContainText('Entities2');

  // (f) Layers: open the browser panel (it opens on Objects) on its Layers tab, create a layer, hide and lock it.
  await button(page, 'Show browser panel').click();
  await page.getByRole('tab', { name: /^Layers/ }).click();
  const layers = page.getByRole('complementary', { name: 'Layers' });
  await expect(layers).toBeVisible();
  await layers.getByLabel('New layer name').fill('Frozen');
  await layers.getByRole('button', { name: 'Add layer' }).click();
  await expect(layers.getByRole('listitem', { name: 'Layer: Frozen' })).toBeVisible();
  await layers.getByRole('button', { name: 'Lock layer Frozen' }).click();
  await expect(layers.getByRole('button', { name: 'Unlock layer Frozen' })).toBeVisible();
  await layers.getByRole('button', { name: 'Hide layer Frozen in viewport' }).click();
  await expect(layers.getByRole('button', { name: 'Show layer Frozen in viewport' })).toBeVisible();
  await shot(page, '05-layers');

  // A locked layer cannot be picked in the viewport; unlocking it restores selection.
  await layers.getByRole('button', { name: 'Lock layer Layer 0' }).click();
  await page.keyboard.press('Escape');
  const solid = { x: box.width * 0.49, y: box.height * 0.5 };
  await page.mouse.click(solid.x, solid.y);
  await expect(status(page)).toContainText('SelectionNone');
  await layers.getByRole('button', { name: 'Unlock layer Layer 0' }).click();
  await page.mouse.click(solid.x, solid.y);
  await expect(status(page)).toContainText('Selection1 entity');

  // `?` opens the shortcut sheet and lists undo/redo.
  await page.locator('body').click({ position: { x: 5, y: 5 } });
  await page.keyboard.press('?');
  await expect(page.getByRole('dialog')).toContainText('Redo');
  await shot(page, '06-shortcuts');

  expect(errors).toEqual([]);
});
