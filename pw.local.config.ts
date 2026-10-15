import base from '/home/user/Llull/playwright.config';
import { defineConfig } from '@playwright/test';
export default defineConfig({ ...base, testDir: '/home/user/Llull/tests/e2e', projects: [{ name: 'chromium', use: { ...(base.projects?.[0]?.use ?? {}), launchOptions: { executablePath: '/opt/pw-browsers/chromium' } } }] });
