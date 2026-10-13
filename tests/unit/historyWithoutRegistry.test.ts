import { describe, it, expect, vi } from 'vitest';

vi.mock('@core/commands/commandTable', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@core/commands/commandTable')>()),
  listCommands: () => [],
  getCommand: () => undefined,
}));

describe('feature history check with an empty command table', () => {
  it('skips the unknown-command check instead of rejecting every step', async () => {
    const { validateDocumentValues } = await import('@core/commands/persistence/validation');
    const { createEmptyDocument } = await import('@core/model/types');
    const raw = { ...createEmptyDocument(), featureHistory: [{ id: 'step-1', name: 'add_box', params: {} }] } as unknown as Record<
      string,
      unknown
    >;
    expect(validateDocumentValues(raw)).toEqual([]);
  });
});
