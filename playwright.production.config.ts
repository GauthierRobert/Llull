import { defineConfig } from '@playwright/test';
import base from './playwright.config';

/**
 * Production-scenario UI gate (tests/production/ui.gate.ts): the engineering-office scenarios
 * driven through the real app like an engineer would. Run: npm run production:ui
 */
export default defineConfig({
  ...base,
  testDir: './tests/production',
  testMatch: 'ui.gate.ts',
  timeout: 900_000,
  expect: { timeout: 15_000 },
});
