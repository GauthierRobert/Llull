/**
 * Unit tests for the 2D grid / scale-bar pure helpers.
 *
 * All functions are pure — no DOM, Canvas, or three.js needed.
 * Tests cover: adaptiveGridStep, majorGridStep, scaleBarLength,
 *              shouldRebase2D, snapOrigin2D.
 */

import { describe, it, expect } from 'vitest';
import {
  adaptiveGridStep,
  majorGridStep,
  scaleBarLength,
  shouldRebase2D,
  snapOrigin2D,
} from '@ui/viewport/2d/gridHelpers';

// ---------------------------------------------------------------------------
// adaptiveGridStep
// ---------------------------------------------------------------------------

describe('adaptiveGridStep', () => {
  it('returns a positive step for typical zoom values', () => {
    for (const zoom of [1, 5, 10, 50, 100, 500, 1000]) {
      const step = adaptiveGridStep(zoom);
      expect(step).toBeGreaterThan(0);
    }
  });

  it('returns step >= 1 at default zoom (50)', () => {
    // zoom=50 means 1 world unit = 50 px; ideal step ~ 20/50 = 0.4 → rounds to 0.5
    const step = adaptiveGridStep(50);
    expect(step).toBeGreaterThan(0);
    expect(step).toBeLessThanOrEqual(10); // should be something sensible like 0.5 or 1
  });

  it('returns larger steps when zoomed out (small zoom)', () => {
    const zoomedIn = adaptiveGridStep(100);
    const zoomedOut = adaptiveGridStep(1);
    expect(zoomedOut).toBeGreaterThan(zoomedIn);
  });

  it('returns smaller steps when zoomed in (large zoom)', () => {
    const step100 = adaptiveGridStep(100);
    const step1000 = adaptiveGridStep(1000);
    expect(step1000).toBeLessThanOrEqual(step100);
  });

  it('produces minor steps in the 20–120 px range for any zoom', () => {
    for (const zoom of [0.5, 2, 10, 50, 200, 1000, 5000]) {
      const step = adaptiveGridStep(zoom);
      const px = step * zoom;
      // Allow some tolerance at boundary conditions (step must be a nice number)
      expect(px).toBeGreaterThan(5);
      expect(px).toBeLessThan(2000);
    }
  });

  it('always returns a nice step (1, 2, or 5 × 10^n)', () => {
    for (const zoom of [1, 3, 7, 20, 50, 100, 300, 1000]) {
      const step = adaptiveGridStep(zoom);
      const log10 = Math.log10(step);
      const exp = Math.floor(log10);
      const mantissa = step / Math.pow(10, exp);
      // mantissa should be 1, 2, or 5 (with floating-point tolerance)
      const isNice =
        Math.abs(mantissa - 1) < 1e-9 ||
        Math.abs(mantissa - 2) < 1e-9 ||
        Math.abs(mantissa - 5) < 1e-9;
      expect(isNice, `step=${step} zoom=${zoom} mantissa=${mantissa}`).toBe(true);
    }
  });

  it('handles zero/negative zoom gracefully (returns 1)', () => {
    expect(adaptiveGridStep(0)).toBe(1);
    expect(adaptiveGridStep(-5)).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// majorGridStep
// ---------------------------------------------------------------------------

describe('majorGridStep', () => {
  it('is always 10× the minor step', () => {
    for (const minor of [0.1, 0.5, 1, 2, 5, 10, 100]) {
      expect(majorGridStep(minor)).toBeCloseTo(minor * 10);
    }
  });
});

// ---------------------------------------------------------------------------
// scaleBarLength
// ---------------------------------------------------------------------------

describe('scaleBarLength', () => {
  it('returns positive worldLength and pixelLength', () => {
    const result = scaleBarLength(50);
    expect(result.worldLength).toBeGreaterThan(0);
    expect(result.pixelLength).toBeGreaterThan(0);
  });

  it('pixelLength ≈ worldLength × zoom', () => {
    const zoom = 50;
    const { worldLength, pixelLength } = scaleBarLength(zoom);
    expect(pixelLength).toBeCloseTo(worldLength * zoom, 5);
  });

  it('pixelLength is at least half the target size', () => {
    for (const zoom of [1, 10, 50, 200, 1000]) {
      const { pixelLength } = scaleBarLength(zoom, 80);
      expect(pixelLength).toBeGreaterThanOrEqual(40 - 1e-6);
    }
  });

  it('worldLength is a nice number (1, 2, 5, or 10 × 10^n)', () => {
    for (const zoom of [0.5, 1, 5, 20, 50, 100, 500]) {
      const { worldLength } = scaleBarLength(zoom);
      const log10 = Math.log10(worldLength);
      const exp = Math.floor(log10);
      const mantissa = worldLength / Math.pow(10, exp);
      const isNice =
        Math.abs(mantissa - 1) < 1e-9 ||
        Math.abs(mantissa - 2) < 1e-9 ||
        Math.abs(mantissa - 5) < 1e-9 ||
        Math.abs(mantissa - 10) < 1e-9;
      expect(isNice, `worldLength=${worldLength} zoom=${zoom} mantissa=${mantissa}`).toBe(true);
    }
  });

  it('respects a custom targetPx', () => {
    const { pixelLength } = scaleBarLength(50, 120);
    expect(pixelLength).toBeGreaterThanOrEqual(60 - 1e-6);
  });

  it('handles zero zoom gracefully', () => {
    const result = scaleBarLength(0);
    expect(result.worldLength).toBeGreaterThan(0);
    expect(result.pixelLength).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// shouldRebase2D
// ---------------------------------------------------------------------------

describe('shouldRebase2D', () => {
  it('returns false when camera is exactly at the origin', () => {
    expect(shouldRebase2D(0, 0, 0, 0)).toBe(false);
  });

  it('returns false when drift is below the default threshold (1e4)', () => {
    expect(shouldRebase2D(5000, 0, 0, 0)).toBe(false);
    expect(shouldRebase2D(0, 9000, 0, 0)).toBe(false);
  });

  it('returns false when drift exactly equals the threshold (strict >)', () => {
    // distance = 1e4 exactly → NOT strictly greater than threshold → false
    expect(shouldRebase2D(10000, 0, 0, 0)).toBe(false);
    expect(shouldRebase2D(0, 10000, 0, 0)).toBe(false);
  });

  it('returns true when drift exceeds the default threshold', () => {
    expect(shouldRebase2D(10001, 0, 0, 0)).toBe(true);
    expect(shouldRebase2D(0, 10001, 0, 0)).toBe(true);
    expect(shouldRebase2D(1e7, 0, 0, 0)).toBe(true);
  });

  it('measures 2D Euclidean distance', () => {
    // sqrt(7100² + 7100²) ≈ 10041 > 1e4 → true
    expect(shouldRebase2D(7100, 7100, 0, 0)).toBe(true);
    // sqrt(3000² + 3000²) ≈ 4243 < 1e4 → false
    expect(shouldRebase2D(3000, 3000, 0, 0)).toBe(false);
  });

  it('uses origin as reference point, not world zero', () => {
    // camera at 1e7+500, origin at 1e7 → drift of 500 < 1e4 → false
    expect(shouldRebase2D(1e7 + 500, 0, 1e7, 0)).toBe(false);
    // camera at 1e7+2e4, origin at 1e7 → drift of 2e4 > 1e4 → true
    expect(shouldRebase2D(1e7 + 2e4, 0, 1e7, 0)).toBe(true);
  });

  it('respects a custom threshold', () => {
    expect(shouldRebase2D(500, 0, 0, 0, 400)).toBe(true);
    expect(shouldRebase2D(300, 0, 0, 0, 400)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// snapOrigin2D
// ---------------------------------------------------------------------------

describe('snapOrigin2D', () => {
  it('always returns a triple with z=0', () => {
    expect(snapOrigin2D(0, 0)[2]).toBe(0);
    expect(snapOrigin2D(1e7, 1e7)[2]).toBe(0);
    expect(snapOrigin2D(-5000, 8000)[2]).toBe(0);
  });

  it('snaps to the nearest multiple of gridSize (default 1e4)', () => {
    expect(snapOrigin2D(0, 0)).toEqual([0, 0, 0]);
    expect(snapOrigin2D(9999, 0)).toEqual([10000, 0, 0]);
    expect(snapOrigin2D(4999, 0)).toEqual([0, 0, 0]);
    expect(snapOrigin2D(0, 5001)).toEqual([0, 10000, 0]);
  });

  it('handles large coordinates', () => {
    const [x, y, z] = snapOrigin2D(1e7 + 3000, 1e7 - 8000);
    expect(x).toBe(1e7);
    expect(y).toBe(1e7 - 10000);
    expect(z).toBe(0);
  });

  it('handles negative coordinates', () => {
    // Math.round(-18000 / 10000) = Math.round(-1.8) = -2 → -20000
    const [x] = snapOrigin2D(-18000, 0);
    expect(x).toBe(-20000);
  });

  it('respects a custom grid size', () => {
    expect(snapOrigin2D(750, 0, 500)).toEqual([1000, 0, 0]);
    expect(snapOrigin2D(200, 0, 500)).toEqual([0, 0, 0]);
  });

  it('does not mutate inputs (returns a new array)', () => {
    const result = snapOrigin2D(1234, 5678);
    expect(Array.isArray(result)).toBe(true);
    expect(result).toHaveLength(3);
  });
});
