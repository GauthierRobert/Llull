import { describe, it, expect } from 'vitest';
import type { PlanPrimitive } from '@aec/index';
import { planAnchor } from '../../src/ui/viewport/2d/planAnchor';

const base = { layer: 'A-WALL', style: 'cut' } as const;

describe('planAnchor', () => {
  it('is the first point of the first primitive that has one', () => {
    const primitives: PlanPrimitive[] = [
      { ...base, type: 'polygon', points: [] },
      {
        ...base,
        type: 'polygon',
        points: [
          [1_000_000, 2_000_000],
          [1_000_010, 2_000_000],
        ],
      },
    ];
    expect(planAnchor(primitives)).toEqual([1_000_000, 2_000_000]);
  });

  it('handles lines, arcs and text, and falls back to the origin', () => {
    expect(planAnchor([{ ...base, type: 'line', a: [3, 4], b: [5, 6] }])).toEqual([3, 4]);
    expect(
      planAnchor([{ ...base, type: 'arc', center: [7, 8], radius: 1, startAngle: 0, endAngle: 1 }]),
    ).toEqual([7, 8]);
    expect(planAnchor([])).toEqual([0, 0]);
  });
});
