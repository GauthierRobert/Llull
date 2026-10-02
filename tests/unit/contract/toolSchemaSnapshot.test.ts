/**
 * MG2.4 agent-facing schema snapshot. `toToolSchemas()` is exactly what MCP agents read;
 * any change to a name, description, param shape or annotation must show up as a reviewed
 * snapshot diff (`npx vitest -u` to accept an intended change).
 */
import { describe, it, expect } from 'vitest';
import { toToolSchemas } from '@core/commands/registry';

/** Recursively sort object keys so the snapshot compares content, not literal key order. */
function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, sortKeys((value as Record<string, unknown>)[key])]),
  );
}

describe('toToolSchemas snapshot', () => {
  it('matches the reviewed agent-facing schema surface', async () => {
    const schemas = [...toToolSchemas()].sort((a, b) => a.name.localeCompare(b.name));
    await expect(JSON.stringify(sortKeys(schemas), null, 2) + '\n').toMatchFileSnapshot(
      './__snapshots__/toolSchemas.json',
    );
  });
});
