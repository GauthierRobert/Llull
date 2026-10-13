import { describe, expect, it } from 'vitest';
import { pointsDiagonal, pointsExtent } from '@lib/extent';
import { isIdentifier } from '@lib/identifier';
import { axisFrame } from '@core/commands/solids/shared';

describe('pointsExtent / pointsDiagonal', () => {
  it('bounds a point list and measures its diagonal', () => {
    expect(
      pointsExtent([
        [1, 5],
        [-2, 3],
        [4, -1],
      ]),
    ).toEqual({ minX: -2, minY: -1, maxX: 4, maxY: 5 });
    expect(
      pointsDiagonal([
        [0, 0],
        [3, 4],
        [1, 1],
      ]),
    ).toBe(5);
  });

  it('is all zeros for an empty list', () => {
    expect(pointsExtent([])).toEqual({ minX: 0, minY: 0, maxX: 0, maxY: 0 });
    expect(pointsDiagonal([])).toBe(0);
  });
});

describe('isIdentifier', () => {
  it('accepts letters/underscore then word characters', () => {
    expect(['a', '_x', 'width2', 'Bolt_Pitch'].every(isIdentifier)).toBe(true);
  });

  it('rejects empty, leading digits and punctuation', () => {
    expect(['', '2a', 'a-b', 'a b', '$a'].some(isIdentifier)).toBe(false);
  });
});

describe('axisFrame', () => {
  it('defaults to +Z and maps local points onto the axis at the position', () => {
    const frame = axisFrame(undefined, [1, 2, 3]);
    if (typeof frame === 'string') throw new Error(frame);
    expect(frame.unitAxis).toEqual([0, 0, 1]);
    expect(frame.worldAt([0, 0, 2])).toEqual([1, 2, 5]);
  });

  it('turns local +Z onto a given axis', () => {
    const frame = axisFrame([2, 0, 0], [0, 0, 0]);
    if (typeof frame === 'string') throw new Error(frame);
    const along = frame.directionAt([0, 0, 1]);
    expect(along[0]).toBeCloseTo(1);
    expect(Math.hypot(along[1], along[2])).toBeCloseTo(0);
  });

  it('reports a zero axis or a malformed position', () => {
    expect(axisFrame([0, 0, 0], [0, 0, 0])).toMatch(/axis must be/);
    expect(axisFrame(undefined, [0, Number.NaN, 0])).toMatch(/position must be/);
  });
});
