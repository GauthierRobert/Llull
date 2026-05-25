/**
 * Unit tests for the ellipse and spline pure geometry helpers added in VS1.
 * Pure functions — no React/three.js dependencies.
 */

import { describe, it, expect } from 'vitest';
import {
  ellipseParamsFromCenterCorner,
  validateSplinePoints,
} from '../../src/ui/viewport/2d/drawHelpers';

// ---------------------------------------------------------------------------
// ellipseParamsFromCenterCorner
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// validateSplinePoints
// ---------------------------------------------------------------------------

describe('validateSplinePoints', () => {
  it('returns the array when it has 2 points', () => {
    const pts: ReadonlyArray<[number, number]> = [
      [0, 0],
      [1, 1],
    ];
    const result = validateSplinePoints(pts);
    expect(result).toBe(pts);
  });

  it('returns the array when it has more than 2 points', () => {
    const pts: ReadonlyArray<[number, number]> = [
      [0, 0],
      [1, 2],
      [3, 1],
      [5, 4],
    ];
    expect(validateSplinePoints(pts)).toBe(pts);
  });

  it('returns null when the array has 1 point', () => {
    expect(validateSplinePoints([[0, 0]])).toBeNull();
  });

  it('returns null for an empty array', () => {
    expect(validateSplinePoints([])).toBeNull();
  });

  it('does not mutate the input array', () => {
    const pts: ReadonlyArray<[number, number]> = [
      [1, 2],
      [3, 4],
    ];
    const before = pts.length;
    validateSplinePoints(pts);
    expect(pts.length).toBe(before);
  });
});
