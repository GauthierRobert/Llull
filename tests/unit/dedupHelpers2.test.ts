import { describe, expect, it } from 'vitest';
import { tupleExtent } from '@lib/extent';
import { fixedNumber, roundTo } from '@lib/compactNumber';
import { orient2 } from '@lib/vec2';
import { polar } from '@lib/arc';
import { instanceToWorld } from '@core/geometry/instanceTransform';

describe('second-pass core helpers', () => {
  it('tupleExtent reads component tuples and ignores a trailing partial one', () => {
    expect(tupleExtent([1, 5, -2, 3, 9], 2)).toEqual({ min: [-2, 3], max: [1, 5] });
    expect(tupleExtent([], 3)).toEqual({
      min: [Infinity, Infinity, Infinity],
      max: [-Infinity, -Infinity, -Infinity],
    });
  });

  it('fixedNumber drops trailing zeros; roundTo rounds to decimals', () => {
    expect(fixedNumber(1.5, 3)).toBe('1.5');
    expect(fixedNumber(2.34567, 2)).toBe('2.35');
    expect(roundTo(1.23456789, 6)).toBe(1.234568);
    expect(roundTo(-0.5, 0)).toBe(-0);
  });

  it('orient2 is positive for a left turn, negative for a right turn, zero when collinear', () => {
    expect(orient2([0, 0], [1, 0], [0, 1])).toBeGreaterThan(0);
    expect(orient2([0, 0], [1, 0], [0, -1])).toBeLessThan(0);
    expect(orient2([0, 0], [1, 1], [2, 2])).toBe(0);
  });

  it('polar places a point at radius and angle about a centre', () => {
    const [x, y] = polar([1, 2], 2, Math.PI / 2);
    expect(x).toBeCloseTo(1);
    expect(y).toBeCloseTo(4);
  });

  it('instanceToWorld scales, rotates about the origin, then translates', () => {
    expect(instanceToWorld([2, 2, 2], [0, 0, 0], [10, 0, 0])([1, 1, 1])).toEqual([12, 2, 2]);
    const [x, y, z] = instanceToWorld([1, 1, 1], [0, 0, Math.PI / 2], [0, 0, 5])([1, 0, 0]);
    expect(x).toBeCloseTo(0);
    expect(y).toBeCloseTo(1);
    expect(z).toBeCloseTo(5);
  });
});
