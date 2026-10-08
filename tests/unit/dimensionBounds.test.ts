import { describe, it, expect } from 'vitest';
import { createEmptyDocument } from '@core/model/types';
import type { CadDocument } from '@core/model/types';
import { execute } from '@core/commands/registry';

function farDimension(offset?: number): { doc: CadDocument; dimensionId: string } {
  const a = execute(createEmptyDocument(), 'draw_line', {
    start: [1_000_000, 0],
    end: [1_000_010, 0],
  });
  const b = execute(a.document, 'draw_line', { start: [1_000_000, 4], end: [1_000_010, 4] });
  const dimension = execute(b.document, 'add_dimension', {
    dimensionKind: 'linear',
    entityIds: [a.affected[0]!, b.affected[0]!],
    ...(offset === undefined ? {} : { offset }),
  });
  return { doc: dimension.document, dimensionId: dimension.affected[0]! };
}

const box = (doc: CadDocument, entityId?: string): { min: number[]; max: number[] } =>
  execute(doc, 'measure_bounding_box', entityId ? { entityId } : {}).data as {
    min: number[];
    max: number[];
  };

describe('dimension bounds follow the dimensioned geometry', () => {
  it('whole-document bounds stay near the geometry, not the origin', () => {
    const { doc } = farDimension();
    const { min, max } = box(doc);
    expect(min[0]).toBeGreaterThan(999_900);
    expect(max[0]).toBeLessThan(1_000_100);
  });

  it('the dimension alone spans its references grown by the offset', () => {
    const { doc, dimensionId } = farDimension(3);
    const { min, max } = box(doc, dimensionId);
    expect(min[0]).toBeCloseTo(1_000_000 - 3);
    expect(max[0]).toBeCloseTo(1_000_010 + 3);
    expect(min[1]).toBeCloseTo(-3);
    expect(max[1]).toBeCloseTo(4 + 3);
  });

  it('fit_view frames the geometry instead of the origin', () => {
    const { doc } = farDimension();
    const { camera } = execute(doc, 'fit_view', {}).document;
    expect(camera.target[0]).toBeGreaterThan(999_900);
    expect(camera.distance).toBeLessThan(1000);
  });

  it('a dimension whose references were deleted falls back to a box at its own position', () => {
    const { doc, dimensionId } = farDimension();
    const orphaned: CadDocument = {
      ...doc,
      entities: { [dimensionId]: doc.entities[dimensionId]! },
      order: [dimensionId],
    };
    const { min, max } = box(orphaned, dimensionId);
    expect(Number.isFinite(min[0]) && Number.isFinite(max[0])).toBe(true);
    expect(max[0]! - min[0]!).toBeLessThanOrEqual(10);
  });
});
