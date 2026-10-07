import { describe, it, expect } from 'vitest';
import { createEmptyDocument } from '@core/model/types';
import { execute } from '@core/commands/registry';
import { entityDistSq, nearestEntityId } from '@ui/viewport/2d/modifyHelpers';

describe('2D picking — arcs', () => {
  const drawn = execute(createEmptyDocument(), 'draw_arc', {
    center: [0, 0],
    radius: 2,
    startAngle: 0,
    endAngle: Math.PI / 2,
  });
  const doc = drawn.document;
  const id = drawn.affected[0]!;

  it('picks only along the swept range, not the rest of the full circle', () => {
    const arc = doc.entities[id]!;
    // On the swept quadrant.
    expect(entityDistSq(arc, [Math.SQRT2, Math.SQRT2])).toBeCloseTo(0);
    // On the circle but opposite the sweep: nearest arc point is an endpoint, 2*sqrt(2) away.
    expect(entityDistSq(arc, [-Math.SQRT2, -Math.SQRT2])).toBeGreaterThan(4);
    expect(nearestEntityId(doc, [-2, 0], 0.5)).toBeNull();
    expect(nearestEntityId(doc, [0, 2], 0.5)).toBe(id);
  });
});
