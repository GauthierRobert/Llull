import { describe, it, expect } from 'vitest';
import { toToolSchemas } from '@core/commands/registry';
import { compactJson } from '../../helpers/compactJson';

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
    await expect(compactJson(sortKeys(schemas), 1) + '\n').toMatchFileSnapshot('./__snapshots__/toolSchemas.json');
  });
});
