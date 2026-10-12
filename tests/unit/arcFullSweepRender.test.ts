/** A stored −2π arc sweep renders as the full circle it measures as (shared positiveSweep). */
import { describe, it, expect } from 'vitest';
import { createEmptyDocument } from '@core/model/types';
import { execute } from '@core/commands/registry';

/** Distinct vertices of the stroked arc polyline in a top render. */
function arcVertices(startAngle: number, endAngle: number): Set<string> {
  const drawn = execute(createEmptyDocument(), 'draw_arc', {
    center: [0, 0],
    radius: 5,
    startAngle,
    endAngle,
  });
  const { svg } = execute(drawn.document, 'render_view', { view: 'top', showGrid: false }).data as {
    svg: string;
  };
  const points = /<polyline points="([^"]*)"/.exec(svg)?.[1] ?? '';
  return new Set(points.split(' ').filter((point) => point.length > 0));
}

describe('2D arc rendering sweep', () => {
  it('draws an arc stored from 2π to 0 like the full 0 → 2π arc', () => {
    const wrapped = arcVertices(2 * Math.PI, 0);
    expect(wrapped.size).toBeGreaterThan(20);
    expect(wrapped.size).toBe(arcVertices(0, 2 * Math.PI).size);
  });

  it('measures that arc as a full circumference', () => {
    const drawn = execute(createEmptyDocument(), 'draw_arc', {
      center: [0, 0],
      radius: 5,
      startAngle: 2 * Math.PI,
      endAngle: 0,
    });
    const measured = execute(drawn.document, 'measure_perimeter', { entityId: drawn.affected[0]! });
    expect((measured.data as { perimeter: number }).perimeter).toBeCloseTo(10 * Math.PI);
  });
});
