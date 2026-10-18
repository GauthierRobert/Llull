import { describe, it, expect } from 'vitest';
import { createEmptyDocument, type CadDocument, type DimensionEntity } from '@core/model/types';
import { execute } from '@core/commands/registry';
import { expectNoOp, expectPure } from '../helpers/expectNoOp';
import { xy } from '../helpers/xy';

const first = (result: { affected: readonly string[] }): string => result.affected[0]!;

function scene(): { doc: CadDocument; ids: Record<'bottom' | 'top' | 'left' | 'circle' | 'point' | 'right', string> } {
  let doc = createEmptyDocument();
  const run = (command: string, params: object): string => {
    const result = execute(doc, command, params);
    doc = result.document;
    return first(result);
  };
  const bottom = run('draw_polyline', { points: xy(0, 0, 120, 0) });
  const top = run('draw_polyline', { points: xy(0, 50, 120, 50) });
  const left = run('draw_polyline', { points: xy(0, 0, 0, 50) });
  const right = run('draw_polyline', { points: xy(120, 0, 120, 50) });
  const circle = run('draw_arc', { center: [60, 25], radius: 10 });
  const point = run('draw_point', { position: [0, 0, 0] });
  return { doc, ids: { bottom, top, left, circle, point, right } };
}

describe('add_dimension — measured value in the summary', () => {
  const { doc, ids } = scene();

  it('states the linear value with units', () => {
    const result = execute(doc, 'add_dimension', { dimensionKind: 'linear', entityIds: [ids.left, ids.right], precision: 0 });
    expect(result.summary).toContain('linear dimension 120 mm');
    expect(result.document.entities[first(result)]?.kind).toBe('dimension');
  });
  it('states vertical, radial, diameter and angular values', () => {
    const summary = (params: object): string => execute(doc, 'add_dimension', params).summary;
    expect(summary({ dimensionKind: 'linear', entityIds: [ids.bottom, ids.top], precision: 1 })).toContain('50.0 mm');
    expect(summary({ dimensionKind: 'radial', entityIds: [ids.circle], precision: 1 })).toContain('radius 10.0 mm');
    expect(summary({ dimensionKind: 'diameter', entityIds: [ids.circle], precision: 1 })).toContain('diameter dimension Ø20.0 mm');
    expect(summary({ dimensionKind: 'angular', entityIds: [ids.bottom, ids.left] })).toContain('angular dimension 90.0°');
  });
  it('a custom label does not hide the measured value', () => {
    const result = execute(doc, 'add_dimension', { dimensionKind: 'diameter', entityIds: [ids.circle], label: 'REF', precision: 0 });
    expect(result.summary).toContain('Ø20 mm');
    expect(result.summary).toContain("label 'REF'");
  });
  it('stores a trimmed tolerance and ignores a blank one', () => {
    const withTolerance = execute(doc, 'add_dimension', { dimensionKind: 'diameter', entityIds: [ids.circle], tolerance: ' H7 ' });
    expect((withTolerance.document.entities[first(withTolerance)] as DimensionEntity).tolerance).toBe('H7');
    expect(withTolerance.summary).toContain('tolerance H7');
    const blank = execute(doc, 'add_dimension', { dimensionKind: 'diameter', entityIds: [ids.circle], tolerance: '  ' });
    expect((blank.document.entities[first(blank)] as DimensionEntity).tolerance).toBeUndefined();
  });
  it('angular from 2 lines stores 2 ids; the dimension is appended to order', () => {
    const result = execute(doc, 'add_dimension', { dimensionKind: 'angular', entityIds: [ids.bottom, ids.left] });
    expect((result.document.entities[first(result)] as DimensionEntity).entityIds).toEqual([ids.bottom, ids.left]);
    expect(result.document.order.at(-1)).toBe(first(result));
  });
  it('is pure', () => {
    expectPure(doc, () => execute(doc, 'add_dimension', { dimensionKind: 'diameter', entityIds: [ids.circle] }));
  });

  it('rejects bad input without changing the document', () => {
    const rejected = (params: object, message: string): void => expectNoOp(execute(doc, 'add_dimension', params), doc, message);
    rejected({ dimensionKind: 'angular', entityIds: [ids.bottom, ids.top] }, 'parallel');
    rejected({ dimensionKind: 'angular', entityIds: [ids.bottom, ids.point] }, 'two line entities');
    rejected({ dimensionKind: 'angular', entityIds: [ids.bottom] }, '2 or 3');
    rejected({ dimensionKind: 'diameter', entityIds: [ids.bottom] }, 'diameter dimension requires a circle');
    rejected({ dimensionKind: 'diameter', entityIds: ['ghost'] }, 'does not exist');
    rejected({ dimensionKind: 'bogus', entityIds: [ids.circle] }, 'unknown dimensionKind');
  });
});
