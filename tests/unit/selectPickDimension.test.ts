import { describe, it, expect } from 'vitest';
import { createEmptyDocument } from '@core/model/types';
import type { DimensionEntity } from '@core/model/types';
import { execute } from '@core/commands/registry';
import { dimensionLabelDistSq, nearestEntityId } from '@ui/viewport/2d/modifyHelpers';

describe('2D picking — dimensions', () => {
  const base = createEmptyDocument();
  const a = execute(base, 'draw_point', { position: [0, 0, 0] });
  const b = execute(a.document, 'draw_point', { position: [10, 0, 0] });
  const dim = execute(b.document, 'add_dimension', {
    dimensionKind: 'linear',
    entityIds: [a.affected[0], b.affected[0]],
  });
  const doc = dim.document;
  const dimensionId = dim.affected[0]!;
  const dimension = doc.entities[dimensionId] as DimensionEntity;

  it('is pickable at its label, not elsewhere', () => {
    // Linear dimension label sits at mid-span, offset from the measured points.
    expect(dimensionLabelDistSq(doc, dimension, [5, 5])).toBeCloseTo(0);
    expect(nearestEntityId(doc, [5, 5], 0.2)).toBe(dimensionId);
    expect(nearestEntityId(doc, [5, 50], 0.2)).toBeNull();
  });

  it('is not pickable when its references dangle', () => {
    const { [a.affected[0]!]: _removed, ...entities } = doc.entities;
    void _removed;
    expect(dimensionLabelDistSq({ ...doc, entities }, dimension, [5, 5])).toBe(Infinity);
  });
});
