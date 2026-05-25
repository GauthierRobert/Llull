/**
 * Unit tests for the floating-origin pure helpers.
 * These cover shouldRebase, snapOriginToTarget, and toRenderPosition.
 * All functions are pure — no canvas, DOM, or three.js needed.
 */

import { describe, it, expect } from 'vitest';
import { shouldRebase, snapOriginToTarget, toRenderPosition } from '@ui/viewport/3d/floatingOrigin';

describe('shouldRebase', () => {
  it('returns false when camera target equals render origin', () => {
    expect(shouldRebase([0, 0, 0], [0, 0, 0])).toBe(false);
  });

  it('returns false when drift is below the default threshold (1e4)', () => {
    expect(shouldRebase([5000, 0, 0], [0, 0, 0])).toBe(false);
    expect(shouldRebase([9999, 0, 0], [0, 0, 0])).toBe(false);
  });

  it('returns true when drift exactly equals the threshold', () => {
    // distance = 1e4 exactly → 1e4² = 1e8, not strictly greater → false
    expect(shouldRebase([10000, 0, 0], [0, 0, 0])).toBe(false);
  });

  it('returns true when drift exceeds the default threshold', () => {
    expect(shouldRebase([10001, 0, 0], [0, 0, 0])).toBe(true);
    expect(shouldRebase([1e7, 0, 0], [0, 0, 0])).toBe(true);
  });

  it('measures 3D Euclidean distance (diagonal drift)', () => {
    // sqrt(6000² + 6000² + 6000²) ≈ 10392 > 1e4 → true
    expect(shouldRebase([6000, 6000, 6000], [0, 0, 0])).toBe(true);
    // sqrt(3000² + 3000² + 3000²) ≈ 5196 < 1e4 → false
    expect(shouldRebase([3000, 3000, 3000], [0, 0, 0])).toBe(false);
  });

  it('respects a custom threshold', () => {
    expect(shouldRebase([500, 0, 0], [0, 0, 0], 400)).toBe(true);
    expect(shouldRebase([300, 0, 0], [0, 0, 0], 400)).toBe(false);
  });

  it('uses origin as the reference point, not world zero', () => {
    // camera at 1e7+500, origin at 1e7 → drift of 500 < 1e4 → false
    expect(shouldRebase([1e7 + 500, 0, 0], [1e7, 0, 0])).toBe(false);
    // camera at 1e7+2e4, origin at 1e7 → drift of 2e4 > 1e4 → true
    expect(shouldRebase([1e7 + 2e4, 0, 0], [1e7, 0, 0])).toBe(true);
  });
});

describe('snapOriginToTarget', () => {
  it('snaps to the nearest multiple of gridSize (default 1e4)', () => {
    expect(snapOriginToTarget([0, 0, 0])).toEqual([0, 0, 0]);
    expect(snapOriginToTarget([9999, 0, 0])).toEqual([10000, 0, 0]);
    expect(snapOriginToTarget([5001, 0, 0])).toEqual([10000, 0, 0]);
    expect(snapOriginToTarget([4999, 0, 0])).toEqual([0, 0, 0]);
  });

  it('handles large coordinates (the far-origin use-case)', () => {
    const origin = snapOriginToTarget([1e7 + 3000, 1e7 - 8000, 0]);
    expect(origin[0]).toBe(1e7); // 1e7+3000 rounds to 1e7
    expect(origin[1]).toBe(1e7 - 10000); // 1e7-8000 rounds to 1e7-1e4
    expect(origin[2]).toBe(0);
  });

  it('handles negative coordinates', () => {
    // Math.round(-15000 / 10000) = Math.round(-1.5) = -1 in JS (rounds toward +inf)
    const origin = snapOriginToTarget([-15000, 0, 0]);
    expect(origin[0]).toBe(-10000);
    // A value clearly closer to -2e4 rounds there
    expect(snapOriginToTarget([-18000, 0, 0])[0]).toBe(-20000);
  });

  it('respects a custom grid size', () => {
    expect(snapOriginToTarget([750, 0, 0], 500)).toEqual([1000, 0, 0]);
    // Math.round(250/500) = Math.round(0.5) = 1 in JS, so snaps to 500
    expect(snapOriginToTarget([200, 0, 0], 500)).toEqual([0, 0, 0]);
    expect(snapOriginToTarget([300, 0, 0], 500)).toEqual([500, 0, 0]);
  });
});

describe('toRenderPosition', () => {
  it('returns zero for entity at origin with zero render origin', () => {
    expect(toRenderPosition([0, 0, 0], [0, 0, 0])).toEqual([0, 0, 0]);
  });

  it('subtracts render origin from entity world position', () => {
    expect(toRenderPosition([10, 20, 30], [5, 10, 15])).toEqual([5, 10, 15]);
  });

  it('handles large far-origin coordinates; result is float32-safe (< 1e4)', () => {
    const worldPos: [number, number, number] = [1e7 + 42, 1e7 - 7, 1e7 + 1000];
    const origin: [number, number, number] = [1e7, 1e7, 1e7];
    const rp = toRenderPosition(worldPos, origin);
    // Magnitudes must be within 2×rebase-threshold to stay float32-stable
    expect(Math.abs(rp[0])).toBeLessThan(2e4);
    expect(Math.abs(rp[1])).toBeLessThan(2e4);
    expect(Math.abs(rp[2])).toBeLessThan(2e4);
    expect(rp[0]).toBeCloseTo(42);
    expect(rp[1]).toBeCloseTo(-7);
    expect(rp[2]).toBeCloseTo(1000);
  });

  it('does NOT mutate the document world position (render-only transform)', () => {
    const worldPos: [number, number, number] = [100, 200, 300];
    const origin: [number, number, number] = [10, 20, 30];
    const rp = toRenderPosition(worldPos, origin);
    // worldPos is unchanged
    expect(worldPos).toEqual([100, 200, 300]);
    // result is a new array
    expect(rp).not.toBe(worldPos);
  });
});
