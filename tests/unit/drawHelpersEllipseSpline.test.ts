/**
 * Unit tests for the ellipse and spline pure geometry helpers.
 * Pure functions — no React/three.js dependencies.
 */

import { describe, it, expect } from 'vitest';
import { ellipseParamsFromCenterCorner } from '../../src/ui/viewport/2d/drawHelpers';

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
