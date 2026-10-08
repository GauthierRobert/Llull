import { describe, it, expect } from 'vitest';
import { createEmptyDocument } from '@core/model/types';
import { execute } from '@core/commands/registry';

function arcLength(startAngle: number, endAngle: number): number {
  const arc = execute(createEmptyDocument(), 'draw_arc', {
    center: [0, 0],
    radius: 2,
    startAngle,
    endAngle,
  });
  const result = execute(arc.document, 'measure_perimeter', { entityId: arc.affected[0]! });
  return (result.data as { perimeter: number }).perimeter;
}

describe('measure_perimeter arc wrap-around', () => {
  it('start === end is a full circle (matches the renderer)', () => {
    expect(arcLength(1, 1)).toBeCloseTo(4 * Math.PI);
  });

  it('end before start sweeps CCW through 2π', () => {
    expect(arcLength(Math.PI, Math.PI / 2)).toBeCloseTo(2 * 1.5 * Math.PI);
  });

  it('a span below -2π wraps into (0, 2π]', () => {
    expect(arcLength(0, -2 * Math.PI - Math.PI / 2)).toBeCloseTo(2 * 1.5 * Math.PI);
  });

  it('a positive quarter sweep is unchanged', () => {
    expect(arcLength(0, Math.PI / 2)).toBeCloseTo(Math.PI);
  });
});
