import { expect, test, type Page } from '@playwright/test';

/** W5G: under frameloop="demand" the 3D canvas must stop requesting frames when nothing moves — gizmo shown or not. */

declare global {
  interface Window {
    __animationFrames: number;
  }
}

const animationFrames = (page: Page): Promise<number> => page.evaluate(() => window.__animationFrames);

/** Frames requested until two consecutive 1 s windows request none. */
async function framesUntilIdle(page: Page): Promise<number> {
  const start = await animationFrames(page);
  let previous = start;
  for (let second = 0; second < 40; second++) {
    await page.waitForTimeout(1000);
    const now = await animationFrames(page);
    if (now === previous) return now - start;
    previous = now;
  }
  throw new Error('render loop never went idle');
}

test('selected entity idles, and an orbit coast settles in a bounded frame count even zoomed far out', async ({ page }) => {
  test.setTimeout(120_000);
  const errors: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error' && message.text().includes('TransformControls')) errors.push(message.text());
  });
  await page.addInitScript(() => {
    window.localStorage.clear();
    window.__animationFrames = 0;
    const requestFrame = window.requestAnimationFrame.bind(window);
    window.requestAnimationFrame = (callback) => {
      window.__animationFrames++;
      return requestFrame(callback);
    };
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'Solid tools' }).click();
  await page.getByRole('button', { name: 'Box', exact: true }).click();
  await expect(page.getByRole('contentinfo', { name: 'Document status' })).toContainText('Selection1 entity');
  await framesUntilIdle(page);
  const idleStart = await animationFrames(page);
  await page.waitForTimeout(2000);
  expect(await animationFrames(page)).toBe(idleStart);

  const canvas = (await page.locator('canvas').first().boundingBox())!;
  await page.mouse.move(canvas.x + canvas.width / 2, canvas.y + canvas.height / 2);
  for (let wheel = 0; wheel < 200; wheel++) await page.mouse.wheel(0, 100);
  await framesUntilIdle(page);

  await page.mouse.move(canvas.x + 60, canvas.y + canvas.height - 60);
  await page.mouse.down();
  await page.mouse.move(canvas.x + 200, canvas.y + canvas.height - 100, { steps: 10 });
  await page.mouse.up();
  // Stock OrbitControls coasts ~260 frames this far out; settled, ~95 at any distance.
  expect(await framesUntilIdle(page)).toBeLessThan(150);
  expect(errors).toEqual([]);
});
