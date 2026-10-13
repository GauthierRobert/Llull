/**
 * The service worker in a production build: it precaches the app shell into one per-build cache,
 * serves the app offline, and a newer build is offered through the update banner and activated
 * only when the user clicks Reload (src/ui/services/appUpdates.ts, serviceWorker/config.json).
 */
import { test, expect, type Page } from '@playwright/test';

async function controlledPage(page: Page): Promise<void> {
  await page.goto('/');
  await page.waitForFunction(async () => (await navigator.serviceWorker.getRegistration())?.active?.state === 'activated');
  await page.reload();
  await page.waitForFunction(() => navigator.serviceWorker.controller !== null);
}

const cacheNames = (page: Page): Promise<string[]> => page.evaluate(() => caches.keys());

test.describe('service worker', () => {
  test('precaches the shell in one cache and serves the app offline', async ({ page, context }) => {
    await controlledPage(page);
    const names = await cacheNames(page);
    expect(names).toHaveLength(1);
    const entries = await page.evaluate(async (name) => {
      const cache = await caches.open(name);
      return (await cache.keys()).map((request) => new URL(request.url).pathname);
    }, names[0] ?? '');
    expect(entries).toContain('/index.html');
    expect(entries.some((path) => /^\/assets\/index-.+\.js$/.test(path))).toBe(true);
    expect(entries.some((path) => /occt|opencascade/.test(path))).toBe(false);
    expect(entries.some((path) => /\.wasm$/.test(path))).toBe(true);
    await context.setOffline(true);
    await page.reload();
    await expect(page.getByRole('main', { name: 'Viewport' })).toBeVisible();
  });
  test('a newer build waits for Reload, then replaces the old cache', async ({ page }) => {
    await controlledPage(page);
    const [before] = await cacheNames(page);
    await expect(page.locator('.update-banner')).toHaveCount(0);
    // The next deploy: the server now hands out a re-versioned sw.js.
    await page.request.post('/__test/next-build');
    await page.evaluate(async () => {
      await (await navigator.serviceWorker.getRegistration())?.update();
    });
    await expect(page.locator('.update-banner')).toContainText('A new version of llull is ready');
    // Installed but waiting: its cache is filled, the old build's cache still serves the page.
    expect((await cacheNames(page)).sort()).toEqual([before, `${before ?? ''}-next`].sort());
    await Promise.all([page.waitForEvent('framenavigated'), page.getByRole('button', { name: 'Reload' }).click()]);
    await expect(page.getByRole('main', { name: 'Viewport' })).toBeVisible();
    await expect.poll(() => cacheNames(page)).toEqual([`${before ?? ''}-next`]);
    await expect(page.locator('.update-banner')).toHaveCount(0);
  });
});
