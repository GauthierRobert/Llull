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
    // The gate runs several jobs back to back from one IP within a minute; each job alone must fit
    // the default /mcp limit (asserted in scripted.gate.ts), so the limit is lifted for the run only.
    env: { MCP_RATE_LIMIT_MAX: '100000' },
    testTimeout: 3_600_000,
    hookTimeout: 120_000,
  },
});
