import { defineConfig } from '@playwright/test';
import base from './playwright.config';

/**
 * Service-worker gate (tests/pwa): the production build served by tests/pwa/staticServer.mjs —
 * the worker is registered in production builds only. Run: npm run test:pwa
 */
export default defineConfig({
  ...base,
  testDir: './tests/pwa',
  use: { ...base.use, baseURL: 'http://localhost:4173' },
  webServer: {
    command: 'npm run build && node tests/pwa/staticServer.mjs',
    url: 'http://localhost:4173',
    reuseExistingServer: false,
    timeout: 300_000,
  },
});
