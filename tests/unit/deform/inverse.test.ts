import { describe, expect, it } from 'vitest';
import { unmapLocal } from '@core/geometry/deform/inverse';
import { mapLocal } from '@core/geometry/deform/laws';
import type { DeformLaw } from '@core/model/deform';
import { region } from './nodes';

const span = region(0, 10);

describe('closed-form inverses of the axis laws', () => {
  it.each<[string, DeformLaw]>([
    ['twist', { kind: 'twist', angleRad: 1 }],
    ['taper', { kind: 'taper', scaleEnd: 0.5, flat: false }],
    ['stretch', { kind: 'stretch', factor: 2 }],
    ['bend', { kind: 'bend', radius: 30, symmetric: false }],
    ['symmetric bend', { kind: 'bend', radius: 30, symmetric: true }],
  ])('%s: the inverse of the map returns the source point, inside, before and past the region', (_name, law) => {
    for (const point of [
      [1, 2, 3],
      [1, -2, -4],
      [2, 1, 14],
    ] as const) {
      const back = unmapLocal(law, span, mapLocal(law, span, [...point]));
      expect(back).not.toBeNull();
      point.forEach((value, k) => expect((back as unknown as number[])[k]).toBeCloseTo(value, 8));
    }
  });

  it('answers null for the laws that have no closed form', () => {
    const laws: DeformLaw[] = [
      {
        kind: 'affine',
        matrix: [
          [1, 0, 0],
          [0, 1, 0],
          [0, 0, 1],
        ],
        translation: [0, 0, 0],
      },
      { kind: 'point', center: [0, 0, 0], direction: [0, 0, 1], distance: 1, radius: 2, falloff: 'smooth_c2' },
      { kind: 'rbf', centres: [0, 0, 0], weights: [0, 0, 0], affine: Array.from({ length: 12 }, () => 0) },
    ];
    for (const law of laws) expect(unmapLocal(law, span, [1, 2, 3])).toBeNull();
  });
});
