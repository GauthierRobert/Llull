import { describe, it, expect } from 'vitest';
import { createEmptyDocument } from '@core/model/types';
import { execute } from '@core/commands/registry';

describe('fillet_2d / chamfer_2d vertexIndex', () => {
  const drawn = execute(createEmptyDocument(), 'draw_polyline', {
    points: [
      [0, 0],
      [10, 0],
      [10, 10],
      [0, 10],
      [0, 20],
    ],
  });
  const id = drawn.affected[0]!;

  it.each([
    ['fillet_2d', { radius: 1 }],
    ['chamfer_2d', { distance: 1 }],
  ])('%s rejects a fractional vertexIndex with a descriptive no-op', (name, extra) => {
    const result = execute(drawn.document, name, { id, vertexIndex: 1.5, ...extra });
    expect(result.affected).toEqual([]);
    expect(result.document).toBe(drawn.document);
    expect(result.summary).toContain('invalid params');
  });

  it('still fillets an integer vertex', () => {
    const result = execute(drawn.document, 'fillet_2d', { id, vertexIndex: 1, radius: 1 });
    expect(result.affected).toHaveLength(2);
  });
});
