import { describe, it, expect } from 'vitest';
import { createEmptyDocument } from '@core/model/types';
import { execute } from '@core/commands/registry';

describe('distribute_on_arc normal validation', () => {
  const base = createEmptyDocument();
  const created = execute(base, 'add_box', { size: [1, 1, 1] });
  const sourceId = created.affected[0]!;
  const arc = {
    sourceId,
    center: [0, 0, 0],
    radius: 5,
    startAngle: 0,
    endAngle: Math.PI,
    count: 3,
  };

  it('rejects a zero normal instead of silently using +Z', () => {
    const result = execute(created.document, 'distribute_on_arc', { ...arc, normal: [0, 0, 0] });
    expect(result.affected).toEqual([]);
    expect(result.document).toBe(created.document);
    expect(result.summary).toContain('non-zero');
  });

  it('accepts a non-unit normal and creates the copies', () => {
    const result = execute(created.document, 'distribute_on_arc', { ...arc, normal: [0, 0, 4] });
    expect(result.affected).toHaveLength(3);
  });
});
