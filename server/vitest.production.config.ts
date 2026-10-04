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
    // A modelling job is 100–300 tool calls in a few minutes; the default /mcp limit (60/min/IP)
    // throttles it, so the gate runs like an office would configure its local server.
    env: { MCP_RATE_LIMIT_MAX: '100000' },
    testTimeout: 3_600_000,
    hookTimeout: 120_000,
  },
});
