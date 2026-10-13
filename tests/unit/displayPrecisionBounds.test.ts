import { describe, it, expect } from 'vitest';
import { createEmptyDocument } from '@core/model/types';
import { execute } from '@core/commands/registry';
import { expectNoOp } from '../helpers/expectNoOp';
import { xy } from '../helpers/xy';

describe('display precision bounds', () => {
  const doc = createEmptyDocument();
  it('set_units rejects precision above 20 (toFixed would throw later in measure commands)', () => {
    const result = execute(doc, 'set_units', { displayPrecision: 101 });
    expect(result.document).toBe(doc);
    expect(result.summary).toContain('[0, 20]');
  });
  it('set_units accepts precision 20', () => {
    expect(execute(doc, 'set_units', { displayPrecision: 20 }).document.displayPrecision).toBe(20);
  });

  describe('add_dimension precision', () => {
    const a = execute(doc, 'draw_polyline', { points: xy(0, 0, 10, 0) });
    const b = execute(a.document, 'draw_polyline', { points: xy(0, 5, 10, 5) });
    const entityIds = [a.affected[0]!, b.affected[0]!];
    it.each([-1, 101])('rejects precision %s', (precision) => {
      expectNoOp(
        execute(b.document, 'add_dimension', { dimensionKind: 'linear', entityIds, precision }),
        b.document,
        'precision must be an integer',
      );
    });
    it('rejects fractional precision at the schema level', () => {
      const result = execute(b.document, 'add_dimension', { dimensionKind: 'linear', entityIds, precision: 1.5 });
      expect(result.affected).toEqual([]);
      expect(result.summary).toContain('invalid params');
    });
    it('accepts precision 3', () => {
      const result = execute(b.document, 'add_dimension', { dimensionKind: 'linear', entityIds, precision: 3 });
      expect(result.affected).toHaveLength(1);
    });
  });
});
