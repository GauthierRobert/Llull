/**
 * Unit tests for the pure geometry helpers in src/ui/viewport/2d/drawHelpers.ts.
 *
 * These are pure functions with no React/three.js dependencies — fast and exhaustive.
 */

import { describe, it, expect } from 'vitest';
import { rectParamsFromCorners, circleRadiusFromPoints } from '../../src/ui/viewport/2d/drawHelpers';

// ---------------------------------------------------------------------------
// rectParamsFromCorners
// ---------------------------------------------------------------------------

describe('rectParamsFromCorners', () => {
  it('computes width, height and lower-left origin for bottom-left → top-right', () => {
    const result = rectParamsFromCorners([1, 2], [5, 6]);
    expect(result).not.toBeNull();
    expect(result!.width).toBeCloseTo(4);
    expect(result!.height).toBeCloseTo(4);
    expect(result!.position).toEqual([1, 2, 0]);
  });

  it('computes correct lower-left origin when corners are reversed (top-right → bottom-left)', () => {
    const result = rectParamsFromCorners([5, 6], [1, 2]);
    expect(result).not.toBeNull();
    expect(result!.width).toBeCloseTo(4);
    expect(result!.height).toBeCloseTo(4);
    expect(result!.position).toEqual([1, 2, 0]);
  });

  it('handles negative coordinate corners', () => {
    const result = rectParamsFromCorners([-3, -3], [3, 3]);
    expect(result).not.toBeNull();
    expect(result!.width).toBeCloseTo(6);
    expect(result!.height).toBeCloseTo(6);
    expect(result!.position).toEqual([-3, -3, 0]);
  });

  it('handles mixed quadrant corners (top-left to bottom-right)', () => {
    const result = rectParamsFromCorners([1, 5], [4, 2]);
    expect(result).not.toBeNull();
    expect(result!.width).toBeCloseTo(3);
    expect(result!.height).toBeCloseTo(3);
    expect(result!.position).toEqual([1, 2, 0]);
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

// ---------------------------------------------------------------------------
// circleRadiusFromPoints
// ---------------------------------------------------------------------------

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
