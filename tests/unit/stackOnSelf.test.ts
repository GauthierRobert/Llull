import { describe, it, expect } from 'vitest';
import { createEmptyDocument } from '@core/model/types';
import { execute } from '@core/commands/registry';

describe('stack_on', () => {
  const created = execute(createEmptyDocument(), 'add_box', { size: [2, 2, 2] });
  const id = created.affected[0]!;

  it('refuses to stack an entity on itself', () => {
    const result = execute(created.document, 'stack_on', { movingId: id, baseId: id });
    expect(result.affected).toEqual([]);
    expect(result.document).toBe(created.document);
    expect(result.summary).toContain('itself');
  });

  it('still stacks one box on another', () => {
    const base = execute(created.document, 'add_box', { size: [2, 2, 2], position: [10, 0, 0] });
    const result = execute(base.document, 'stack_on', { movingId: id, baseId: base.affected[0]! });
    expect(result.affected).toEqual([id]);
    expect(result.document.entities[id]!.position[2]).toBeCloseTo(2);
  });
});
