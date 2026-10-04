import { defineConfig } from '@playwright/test';
import base from './playwright.config';

/**
 * Display quality gate (tests/quality/*.gate.ts): opens every corpus document in the real app.
 * Run after `npm run quality:step`: npm run quality:display
 */
export default defineConfig({
  ...base,
  testDir: './tests/quality',
  testMatch: '*.gate.ts',
  timeout: 300_000,
});
