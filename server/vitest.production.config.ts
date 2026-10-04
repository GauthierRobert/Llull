/**
 * Vitest config for the production-scenario gates (server/tests/production/*.gate.ts): engineering
 * office jobs driven through the real /mcp endpoint. Sessions start with the default toolsets (no
 * LLULL_TOOLSETS override), so drivers discover and enable tools like any MCP agent.
 *   npm run production:scripted      npm run production:agent (needs Anthropic credentials)
 */
import { defineConfig } from 'vitest/config';
import base from './vitest.config';

export default defineConfig({
  ...base,
  test: {
    ...base.test,
    include: ['tests/production/**/*.gate.ts'],
    // Default server settings (incl. the /mcp rate limit): a modelling job must fit within them.
    env: {},
    testTimeout: 3_600_000,
    hookTimeout: 120_000,
  },
});
