import { describe, it, expect } from 'vitest';
import { rectParamsFromCorners, circleRadiusFromPoints, ellipseParamsFromCenterCorner } from '../../src/ui/viewport/2d/drawHelpers';

// rectParamsFromCorners

describe('rectParamsFromCorners', () => {
  it.each([
    ['computes width, height and lower-left origin for bottom-left → top-right', [1, 2], [5, 6], 4, 4, [1, 2, 0]],
    ['computes correct lower-left origin when corners are reversed (top-right → bottom-left)', [5, 6], [1, 2], 4, 4, [1, 2, 0]],
    ['handles negative coordinate corners', [-3, -3], [3, 3], 6, 6, [-3, -3, 0]],
    ['handles mixed quadrant corners (top-left to bottom-right)', [1, 5], [4, 2], 3, 3, [1, 2, 0]],
  ] as const)('%s', (_label, first, second, width, height, position) => {
    const result = rectParamsFromCorners([...first], [...second]);
    expect(result).not.toBeNull();
    expect(result!.width).toBeCloseTo(width);
    expect(result!.height).toBeCloseTo(height);
    expect(result!.position).toEqual(position);
  });
  it('returns null when corners share the same x (zero width)', () => {
    expect(rectParamsFromCorners([2, 1], [2, 5])).toBeNull();
  });
  it('returns null when corners share the same y (zero height)', () => {
    expect(rectParamsFromCorners([1, 3], [5, 3])).toBeNull();
  });
  it('returns null for identical corners (zero area)', () => {
    expect(rectParamsFromCorners([2, 2], [2, 2])).toBeNull();
  });
  it('position z is always 0', () => {
    const result = rectParamsFromCorners([0, 0], [10, 5]);
    expect(result!.position[2]).toBe(0);
  });
});

// circleRadiusFromPoints

describe('circleRadiusFromPoints', () => {
  it('computes the Euclidean distance between center and rim', () => {
    const r = circleRadiusFromPoints([0, 0], [3, 4]);
    expect(r).toBeCloseTo(5);
  });
  it('works for a horizontal rim point', () => {
    const r = circleRadiusFromPoints([1, 1], [4, 1]);
    expect(r).toBeCloseTo(3);
  });
  it('works for a vertical rim point', () => {
    const r = circleRadiusFromPoints([0, 0], [0, 7]);
    expect(r).toBeCloseTo(7);
  });
  it('works with negative coordinates', () => {
    const r = circleRadiusFromPoints([-2, -2], [1, 2]);
    expect(r).toBeCloseTo(5);
  });
  it('returns null when center equals rim (radius = 0)', () => {
    expect(circleRadiusFromPoints([3, 3], [3, 3])).toBeNull();
  });
  it('returns a positive value regardless of rim direction', () => {
    const r = circleRadiusFromPoints([5, 5], [2, 1]);
    expect(r).toBeGreaterThan(0);
  });
});

// ellipseParamsFromCenterCorner

describe('ellipseParamsFromCenterCorner', () => {
  it('computes radiusX and radiusY from center and corner', () => {
    const result = ellipseParamsFromCenterCorner([0, 0], [3, 2]);
    expect(result).not.toBeNull();
    expect(result!.radiusX).toBeCloseTo(3);
    expect(result!.radiusY).toBeCloseTo(2);
    expect(result!.center).toEqual([0, 0]);
  });
  it('preserves the center coordinates unchanged', () => {
    const center: [number, number] = [5, -3];
    const result = ellipseParamsFromCenterCorner(center, [8, 0]);
    expect(result).not.toBeNull();
    expect(result!.center).toBe(center);
  });
  it('computes absolute radii regardless of corner direction', () => {
    // Corner to the left and below the center.
    const result = ellipseParamsFromCenterCorner([4, 4], [1, 1]);
    expect(result).not.toBeNull();
    expect(result!.radiusX).toBeCloseTo(3);
    expect(result!.radiusY).toBeCloseTo(3);
  });
  it('returns null when corner is on the same horizontal line (radiusY = 0)', () => {
    expect(ellipseParamsFromCenterCorner([0, 0], [5, 0])).toBeNull();
  });
  it('returns null when corner is on the same vertical line (radiusX = 0)', () => {
    expect(ellipseParamsFromCenterCorner([0, 0], [0, 5])).toBeNull();
  });
  it('returns null for identical center and corner', () => {
    expect(ellipseParamsFromCenterCorner([2, 2], [2, 2])).toBeNull();
  });
  it('works with negative coordinates', () => {
    const result = ellipseParamsFromCenterCorner([-5, -3], [-1, 0]);
    expect(result).not.toBeNull();
    expect(result!.radiusX).toBeCloseTo(4);
    expect(result!.radiusY).toBeCloseTo(3);
  });
  it('computes non-square ellipse correctly (radiusX != radiusY)', () => {
    const result = ellipseParamsFromCenterCorner([0, 0], [10, 4]);
    expect(result).not.toBeNull();
    expect(result!.radiusX).toBeCloseTo(10);
    expect(result!.radiusY).toBeCloseTo(4);
  });
});
