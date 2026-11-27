import { defineConfig, devices } from '@playwright/test';

/**
 * End-to-end tests drive the real app (Vite dev server, offline/local mode — no llull server)
 * in Chromium. Run: npm run test:e2e
 */
/**
 * `LLULL_CHROMIUM` = path of a Chromium binary to drive instead of the build Playwright downloads (a container or an offline machine
 * that ships its own): the gates then run without `npx playwright install`.
 */
const chromiumPath = process.env['LLULL_CHROMIUM'];
const launchOptions =
  chromiumPath === undefined || chromiumPath === '' ? {} : { launchOptions: { executablePath: chromiumPath, args: ['--no-sandbox'] } };

export default defineConfig({
  testDir: './tests/e2e',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: { baseURL: 'http://localhost:5173', viewport: { width: 1600, height: 1000 }, acceptDownloads: true, trace: 'retain-on-failure' },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'], viewport: { width: 1600, height: 1000 }, ...launchOptions } }],
  webServer: {
    command: 'npm run dev -- --port 5173 --strictPort',
    url: 'http://localhost:5173',
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
